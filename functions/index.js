// JOBSpan Cloud Functions
//
// sendMessageNotificationSms
// ──────────────────────────
// Triggers on every new doc in companies/{companyId}/jobs/{jobId}/messages.
// The client (kytrac-app.js: sendJobMessage / sendPortalMessage) already
// computed WHO should be notified (notifyTargets: [{name,email,phone}])
// and set notifyStatus:'pending' - this function's only job is to
// actually send the SMS via Twilio, since the Twilio auth token can never
// be shipped to the browser.
//
// Routing rule this implements (decided in JOBSpan chat, 7/21/2026):
//   - Customer portal messages -> default to the Owner, UNLESS a specific
//     team member is @mentioned by first name, in which case THEY get it.
//   - Internal team messages -> only notify if someone is @mentioned.
// (Both of those decisions already happened client-side; this function
// doesn't re-derive who to notify, it just sends to whoever's already in
// notifyTargets.)
//
// ── ONE-TIME SETUP REQUIRED (needs Travis's Mac - Firebase CLI + a real
//    Twilio account, neither of which work from the JOBSpan chat sandbox):
//
// 1. cd functions && npm install
// 2. Get a Twilio account (twilio.com) + a Twilio phone number capable of SMS
// 3. Set the Twilio credentials as Firebase Functions config:
//      firebase functions:config:set twilio.sid="ACxxxxxxxx" \
//        twilio.token="your_auth_token" \
//        twilio.from="+1XXXXXXXXXX"
//    (Or migrate to Secret Manager with defineSecret if using functions v2 -
//    either works, config: is simpler to start with.)
// 4. Deploy: firebase deploy --only functions
// 5. Make sure each team member who should get SMS has a phone number saved
//    in Settings > Team Management (the "Cell phone" field added alongside
//    this feature) - no phone number saved = no SMS, silently skipped.
//
// Until deployed, messages still save fine and notifyTargets still gets
// computed and shown in the UI ("📲 Texting so-and-so") - they just won't
// actually receive a text until this function is live.

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// ── Stripe (per-company, mirrors the QBO connection pattern) ────────
// Each company connects its OWN Stripe account -- critical for
// multi-tenant use. A single shared key would mean every company's
// customer payments land in whoever owns that one key's Stripe/bank
// account, not the company that actually did the job.
//
// Credentials live in stripeTokens/main, a dedicated collection with
// allow read,write: if false in firestore.rules (same treatment as
// quickbooksTokens/googleCalendarTokens) -- never client-readable
// regardless of role. The client only ever sees the non-sensitive
// status doc at settings/stripe (connected boolean, key mode, when).
async function getStripeConnection(companyId) {
  const db = admin.firestore();
  const ref = db.collection('companies').doc(companyId).collection('stripeTokens').doc('main');
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Stripe is not connected for this company yet - connect it in Settings first.');
  const data = doc.data();
  if (!data.secretKeyEncrypted) throw new Error('Stripe is not connected for this company yet - connect it in Settings first.');
  return {
    secretKey: decryptSecret(data.secretKeyEncrypted),
    webhookSecret: data.webhookSecretEncrypted ? decryptSecret(data.webhookSecretEncrypted) : null,
  };
}

async function getStripeClientForCompany(companyId) {
  const conn = await getStripeConnection(companyId);
  return require('stripe')(conn.secretKey);
}

// Callable - a company admin pastes their own Stripe secret key (and,
// once they've registered the webhook endpoint in their own Stripe
// dashboard, its signing secret) to connect their account. Same shape
// as the existing QBO connect flow, just without an OAuth round trip
// since Stripe secret keys work directly.
exports.connectStripeAccount = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const { companyId, secretKey, webhookSecret } = data;
  if (!companyId || !secretKey) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing companyId or secretKey.');
  }
  if (context.auth.token.companyId !== companyId) {
    throw new functions.https.HttpsError('permission-denied', 'Not a member of this company.');
  }
  if (!secretKey.startsWith('sk_')) {
    throw new functions.https.HttpsError('invalid-argument', "That doesn't look like a Stripe secret key (should start with sk_live_ or sk_test_).");
  }

  // Verify the key actually works before saving it.
  try {
    const testClient = require('stripe')(secretKey);
    await testClient.balance.retrieve();
  } catch (e) {
    throw new functions.https.HttpsError('invalid-argument', 'Stripe rejected that key: ' + e.message);
  }

  const keyMode = secretKey.startsWith('sk_live_') ? 'live' : 'test';
  const db = admin.firestore();
  const companyRef = db.collection('companies').doc(companyId);

  const tokenUpdate = { secretKeyEncrypted: encryptSecret(secretKey) };
  if (webhookSecret) tokenUpdate.webhookSecretEncrypted = encryptSecret(webhookSecret);
  await companyRef.collection('stripeTokens').doc('main').set(tokenUpdate, { merge: true });

  // Non-sensitive status doc the client is actually allowed to read.
  await companyRef.collection('settings').doc('stripe').set({
    connected: true,
    keyMode,
    hasWebhook: !!webhookSecret,
    connectedAt: admin.firestore.FieldValue.serverTimestamp(),
    connectedBy: context.auth.token.email || context.auth.uid,
  }, { merge: true });

  return { success: true, mode: keyMode };
});

exports.disconnectStripeAccount = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const { companyId } = data;
  if (context.auth.token.companyId !== companyId) {
    throw new functions.https.HttpsError('permission-denied', 'Not a member of this company.');
  }
  const companyRef = admin.firestore().collection('companies').doc(companyId);
  await companyRef.collection('stripeTokens').doc('main').delete();
  await companyRef.collection('settings').doc('stripe').set({ connected: false }, { merge: true });
  return { success: true };
});

function getTwilioClient() {
  // Prefer environment variables (recommended post-2027 approach)
  // Fall back to functions.config() for backward compatibility
  const sid   = process.env.TWILIO_SID   || (functions.config().twilio || {}).sid;
  const token = process.env.TWILIO_TOKEN || (functions.config().twilio || {}).token;
  const from  = process.env.TWILIO_FROM  || (functions.config().twilio || {}).from;
  if (!sid || !token) return null;
  const twilio = require('twilio');
  return { client: twilio(sid, token), from };
}

// Plivo -- replaces Twilio for SMS, migrated 2026-09-26. Deliberately a
// SEPARATE company from Twilio/SendGrid (which merged Feb 2026) -- the
// whole point is not having one account review able to take down email
// AND texting at once, same lesson as the Gmail migration earlier.
function getPlivoClient() {
  const authId = process.env.PLIVO_AUTH_ID;
  const authToken = process.env.PLIVO_AUTH_TOKEN;
  const from = process.env.PLIVO_FROM;
  if (!authId || !authToken || !from) return null;
  const plivo = require('plivo');
  return { client: new plivo.Client(authId, authToken), from };
}

// syncMyClaims
// ────────────
// Sets Firebase Auth Custom Claims (companyId, role, fullAccessOverride)
// on the calling user, which is the ONLY thing Firestore Security Rules
// can trust for role checks - the client-side role display in the app
// is a UX convenience, this is the actual security boundary. Mirrors the
// same company-resolution logic as resolveCompany()/loadUserRole() in
// kytrac-app.js (owner match, then memberEmails match, then team doc
// lookup by email), but running server-side where it can't be spoofed.
//
// Called by the client right after login, followed by a forced ID token
// refresh (getIdToken(true)) so the new claims take effect immediately
// without requiring a full sign-out/sign-in.
exports.syncMyClaims = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  }
  const email = (context.auth.token.email || '').toLowerCase();
  const uid = context.auth.uid;
  const db = admin.firestore();

  let companyId = null;
  let isOwner = false;

  const ownerSnap = await db.collection('companies').where('ownerEmail', '==', email).limit(1).get();
  if (!ownerSnap.empty) {
    companyId = ownerSnap.docs[0].id;
    isOwner = true;
  } else {
    const memberSnap = await db.collection('companies').where('memberEmails', 'array-contains', email).limit(1).get();
    if (!memberSnap.empty) companyId = memberSnap.docs[0].id;
  }

  if (!companyId) {
    // No company yet (brand new user) - clear any stale claims from a
    // previous company; client shows the onboarding flow in this case.
    await admin.auth().setCustomUserClaims(uid, null);
    return { companyId: null, role: null };
  }

  let role = 'Owner';
  let fullAccessOverride = false;

  if (!isOwner) {
    const teamDoc = await db.collection('companies').doc(companyId).collection('settings').doc('team').get();
    const key = email.replace(/\./g, '_');
    const member = teamDoc.exists ? (teamDoc.data().members || {})[key] : null;
    if (!member) {
      // memberEmails said they belong here, but there's no active team
      // entry (removed, or a stale/bad invite) - deny rather than
      // silently granting some default role.
      await admin.auth().setCustomUserClaims(uid, null);
      throw new functions.https.HttpsError('permission-denied', 'You are not an active member of this company. Contact your Owner.');
    }
    role = member.role || 'Field Technician';
    fullAccessOverride = !!member.fullAccessOverride;
  }

  await admin.auth().setCustomUserClaims(uid, { companyId, role, fullAccessOverride });
  return { companyId, role, fullAccessOverride };
});

// ════════════════════════════════════════════════════════════════════
// Google Calendar integration
// ════════════════════════════════════════════════════════════════════
// Direction: JOBSpan -> Google Calendar only (one-way push), decided in
// chat 7/23/2026. Each team member connects their OWN Google Calendar
// (not one shared company calendar). Syncs both:
//   1. Personal calendar events (companies/{cid}/calendarEvents) -> the
//      event's assignee's calendar
//   2. Job phases (companies/{cid}/jobs/{jid}/phases) -> every crew
//      member on that job who has connected their calendar
//
// ── ONE-TIME SETUP REQUIRED (Google Cloud Console, needs Travis - not
//    doable from the JOBSpan chat sandbox):
//
// 1. Go to console.cloud.google.com, create or select a project
// 2. Enable the "Google Calendar API" (APIs & Services > Library)
// 3. APIs & Services > OAuth consent screen:
//    - User Type: "Internal" if this Cloud project is associated with
//      the 7pillarsgroup.com Google Workspace (Internal apps skip
//      Google's verification review entirely - much simpler). If the
//      project isn't Workspace-associated, use "External" and add each
//      team member's email as a test user, or submit for verification.
//    - Scope needed: https://www.googleapis.com/auth/calendar.events
// 4. APIs & Services > Credentials > Create Credentials > OAuth client ID
//    - Application type: Web application
//    - Authorized redirect URI: the deployed URL of gcalOAuthCallback,
//      e.g. https://us-central1-kytrac-72d91.cloudfunctions.net/gcalOAuthCallback
//      (get the exact URL after first deploy, then add it here and
//      redeploy - chicken-and-egg, that's normal)
// 5. Set the client ID/secret as Firebase config:
//      firebase functions:config:set google.client_id="xxx.apps.googleusercontent.com" \
//        google.client_secret="xxx" \
//        google.redirect_uri="https://us-central1-kytrac-72d91.cloudfunctions.net/gcalOAuthCallback"
// 6. Deploy: firebase deploy --only functions
// 7. Each team member clicks "Connect Google Calendar" on the Calendar
//    page in JOBSpan and signs into their 7pillarsgroup.com account.
//
// Until connected, events/phases still save fine in JOBSpan - they just
// don't push anywhere until that person connects their calendar.

const { google } = require('googleapis');

function getGoogleOAuthConfig() {
  // Try process.env first (set via firebase functions:secrets or .env),
  // fall back to functions.config() for backward compatibility.
  const client_id = process.env.GOOGLE_CLIENT_ID || (functions.config().google || {}).client_id;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET || (functions.config().google || {}).client_secret;
  const redirect_uri = process.env.GOOGLE_REDIRECT_URI || (functions.config().google || {}).redirect_uri;
  if (!client_id || !client_secret || !redirect_uri) return null;
  return { client_id, client_secret, redirect_uri };
}

function newOAuth2Client() {
  const cfg = getGoogleOAuthConfig();
  if (!cfg) return null;
  return new google.auth.OAuth2(cfg.client_id, cfg.client_secret, cfg.redirect_uri);
}

// gcalOAuthStart
// ──────────────
// Client sends their Firebase ID token as ?token=... (verified here
// before redirecting to Google, so a stranger can't kick off an OAuth
// flow that gets tied to someone else's account). Redirects to Google's
// consent screen with state=base64(companyId:uid) so the callback knows
// whose tokens these are without trusting anything else from the client.
exports.gcalOAuthStart = functions.https.onRequest(async (req, res) => {
  const oauth2Client = newOAuth2Client();
  if (!oauth2Client) {
    res.status(500).send('Google Calendar OAuth is not configured yet (functions.config().google missing). See DEPLOY_GCAL.md.');
    return;
  }
  const idToken = req.query.token;
  if (!idToken) { res.status(400).send('Missing token'); return; }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    res.status(401).send('Invalid or expired session - please reload JOBSpan and try again.');
    return;
  }

  const companyId = req.query.companyId;
  if (!companyId) { res.status(400).send('Missing companyId'); return; }

  const state = Buffer.from(JSON.stringify({ companyId, uid: decoded.uid })).toString('base64');
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',      // needed to get a refresh_token
    prompt: 'consent',           // forces refresh_token on every connect, not just the first
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state
  });
  res.redirect(authUrl);
});

// gcalOAuthCallback
// ──────────────────
// Google redirects here after the user approves. Exchanges the code for
// tokens, stores the refresh_token in the locked-down googleCalendarTokens
// collection (never client-readable), and flips a plain boolean flag on
// the team member record so the UI can show "Connected".
exports.gcalOAuthCallback = functions.https.onRequest(async (req, res) => {
  console.log('gcalOAuthCallback invoked, error:', req.query.error || 'none', 'code:', !!req.query.code);
  try {
    const oauth2Client = newOAuth2Client();
    if (!oauth2Client) {
      res.status(500).send('Google Calendar OAuth is not configured yet.');
      return;
    }
    const { code, state, error } = req.query;
    if (error) { res.status(400).send('Google denied access: ' + error); return; }
    if (!code || !state) { res.status(400).send('Missing code/state from Google.'); return; }

    let parsed;
    try { parsed = JSON.parse(Buffer.from(state, 'base64').toString('utf8')); }
    catch (e) { res.status(400).send('Invalid state.'); return; }
    const { companyId, uid } = parsed;

    const cfg = getGoogleOAuthConfig();
    console.log('GCal callback - client_id prefix:', cfg?.client_id?.slice(0, 20), 'secret_len:', cfg?.client_secret?.length);

    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      res.status(400).send('Google did not return a refresh token. Please disconnect and reconnect.');
      return;
    }
    const db = admin.firestore();
    await db.collection('companies').doc(companyId).collection('googleCalendarTokens').doc(uid).set({
      refreshToken: tokens.refresh_token,
      connectedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    const email = (await admin.auth().getUser(uid)).email.toLowerCase();
    const key = email.replace(/\./g, '_');
    await db.collection('companies').doc(companyId).collection('settings').doc('team').set(
      { members: { [key]: { googleCalendarConnected: true } } },
      { merge: true }
    );
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>✅ Google Calendar connected</h2><p>You can close this tab and go back to JOBSpan.</p></body></html>');
  } catch (e) {
    console.error('gcalOAuthCallback top-level error:', e.message, e.stack);
    res.status(500).send('Error connecting Google Calendar: ' + e.message);
  }
});

// gcalDisconnect (callable)
// ─────────────────────────
// Lets a user disconnect their own calendar - deletes the stored token
// and clears the status flag. Does not revoke the Google-side grant
// (Google still shows JOBSpan under their connected apps until they
// remove it there too) but stops all future syncing immediately.
exports.gcalDisconnect = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const companyId = data.companyId;
  if (!companyId) throw new functions.https.HttpsError('invalid-argument', 'Missing companyId.');
  const uid = context.auth.uid;
  const db = admin.firestore();
  await db.collection('companies').doc(companyId).collection('googleCalendarTokens').doc(uid).delete();
  const email = (context.auth.token.email || '').toLowerCase();
  const key = email.replace(/\./g, '_');
  await db.collection('companies').doc(companyId).collection('settings').doc('team').set(
    { members: { [key]: { googleCalendarConnected: false } } },
    { merge: true }
  );
  return { disconnected: true };
});

// Loads a ready-to-use Calendar API client for a given user, or null if
// they haven't connected (not an error - just means "don't sync for them").
async function getCalendarClientForUser(companyId, uid) {
  const db = admin.firestore();
  const tokenDoc = await db.collection('companies').doc(companyId).collection('googleCalendarTokens').doc(uid).get();
  if (!tokenDoc.exists) return null;
  const oauth2Client = newOAuth2Client();
  if (!oauth2Client) return null;
  oauth2Client.setCredentials({ refresh_token: tokenDoc.data().refreshToken });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// Looks up the Firebase uid for a team member by email, needed since
// JOBSpan's own data model keys people by email but the Calendar tokens
// are keyed by uid.
async function getUidForEmail(email) {
  try {
    const user = await admin.auth().getUserByEmail(email);
    return user.uid;
  } catch (e) {
    return null; // they've never signed into JOBSpan/Firebase Auth yet
  }
}

// pushPersonalEventToGCal
// ───────────────────────
// Personal calendar events (companies/{cid}/calendarEvents) either
// belong to one specific assignee, or to "Everyone (All Team)" -- the
// client saves that second case as assignee: '' (see calEventAssignee
// dropdown, value="" for the "Everyone" option). The empty string is
// falsy, so this used to hit the early `if (!assigneeEmail) return`
// and get silently skipped entirely -- confirmed live: a real "Team
// Meeting" event assigned to Everyone showed correctly inside JOBSpan
// itself (that's just reading local Firestore data) but never reached
// Google Calendar, and therefore never reached PlannerXD either, since
// PlannerXD only ever pulls from Google, never talks to JOBSpan
// directly. Single-assignee events were never affected by this --
// only "Everyone" ones silently vanished at the sync step.
function buildPersonalEventBody(after) {
  // Was reading after.endTime directly -- but the client-side save
  // function (saveCalendarEvent) never actually saves a field with
  // that name. It computes and saves `duration` (minutes) instead --
  // e.g. 8am to 4pm becomes { time: '08:00', duration: 480 }, never
  // an endTime field. after.endTime was therefore ALWAYS undefined,
  // silently falling back to after.time on every single timed event
  // ever pushed here -- not just this one. Every past sync of a
  // timed personal event has shown up on Google Calendar as a zero-
  // duration start=end event regardless of what duration the user
  // actually picked. Computing the real end time from start +
  // duration instead, matching what the client actually saves.
  let endDateTime = after.date;
  if (after.time && after.duration) {
    const [sh, sm] = after.time.split(':').map(Number);
    let totalMin = sh * 60 + sm + Number(after.duration);
    let endDate = after.date;
    if (totalMin >= 1440) {
      // Rolled past midnight -- advance the calendar date, same as
      // the client's own wrap-around handling for an overnight event.
      totalMin -= 1440;
      const d = new Date(after.date + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      endDate = d.toISOString().split('T')[0];
    }
    const eh = String(Math.floor(totalMin / 60)).padStart(2, '0');
    const em = String(totalMin % 60).padStart(2, '0');
    endDateTime = `${endDate}T${eh}:${em}:00`;
  }

  return {
    summary: after.title || 'JOBSpan Event',
    description: after.meetLink ? `Meet link: ${after.meetLink}` : (after.notes || undefined),
    location: after.location || undefined,
    start: after.time
      ? { dateTime: `${after.date}T${after.time}:00`, timeZone: 'America/Chicago' }
      : { date: after.date },
    end: after.time
      ? { dateTime: endDateTime, timeZone: 'America/Chicago' }
      : { date: after.date }
  };
}

exports.pushPersonalEventToGCal = functions.firestore
  .document('companies/{companyId}/calendarEvents/{eventId}')
  .onWrite(async (change, context) => {
    const { companyId, eventId } = context.params;
    const before = change.before.exists ? change.before.data() : null;
    const after = change.after.exists ? change.after.data() : null;
    const assigneeEmail = (after || before)?.assignee;
    console.log('pushPersonalEventToGCal fired', eventId, 'assignee:', assigneeEmail || '(Everyone)');

    if (assigneeEmail) {
      // ── Single assignee ──
      const uid = await getUidForEmail(assigneeEmail);
      console.log('pushPersonalEventToGCal uid for', assigneeEmail, ':', uid);
      if (!uid) { console.log('No uid found - user never logged in'); return null; }
      const cal = await getCalendarClientForUser(companyId, uid);
      console.log('pushPersonalEventToGCal cal client:', cal ? 'obtained' : 'null - not connected');

      // Real bug found and fixed here: if this event was previously
      // "Everyone" (tracked via the plural gcalEventIds map below)
      // and just got reassigned to one specific person, this branch
      // used to only ever look at the singular gcalEventId field --
      // which doesn't exist yet on a from-Everyone event -- so it
      // created a brand-new Google event and left every original
      // Everyone-era event (including the reassigned person's own
      // copy of it) permanently orphaned on Google Calendar, with no
      // code path that ever cleaned them up. Clean those up here,
      // on the same team-member loop pushPhaseToGCal/the Everyone
      // branch below already use.
      if (before?.gcalEventIds && Object.keys(before.gcalEventIds).length) {
        const db2 = admin.firestore();
        const teamDoc2 = await db2.collection('companies').doc(companyId).collection('settings').doc('team').get();
        const teamData2 = teamDoc2.exists ? teamDoc2.data() : null;
        const members2 = teamData2
          ? (teamData2.members && typeof teamData2.members === 'object'
              ? Object.values(teamData2.members)
              : Object.values(teamData2).filter(v => v && typeof v === 'object' && (v.email || v.role)))
          : [];
        for (const m of members2) {
          if (!m.email) continue;
          const mUid = await getUidForEmail(m.email);
          if (!mUid || !before.gcalEventIds[mUid]) continue;
          const mCal = await getCalendarClientForUser(companyId, mUid);
          if (!mCal) continue;
          try { await mCal.events.delete({ calendarId: 'primary', eventId: before.gcalEventIds[mUid] }); }
          catch (e) { console.warn('cleanup of old Everyone-event failed for', m.email, ':', e.message); }
        }
      }

      if (!after) {
        if (before?.gcalEventId) {
          try { await cal.events.delete({ calendarId: 'primary', eventId: before.gcalEventId }); }
          catch (e) { console.warn('gcal delete failed (may already be gone):', e.message); }
        }
        return null;
      }

      const eventBody = buildPersonalEventBody(after);
      try {
        if (after.gcalEventId) {
          await cal.events.update({ calendarId: 'primary', eventId: after.gcalEventId, requestBody: eventBody });
        } else {
          const created = await cal.events.insert({ calendarId: 'primary', requestBody: eventBody });
          await change.after.ref.update({ gcalEventId: created.data.id, gcalEventIds: admin.firestore.FieldValue.delete() });
        }
      } catch (e) {
        console.error('pushPersonalEventToGCal failed:', e.message);
      }
      return null;
    }

    // ── "Everyone (All Team)" -- new path, mirrors pushPhaseToGCal's
    // multi-calendar pattern below: one Google event per connected
    // team member, IDs tracked in a gcalEventIds map instead of a
    // single gcalEventId, since one JOBSpan event now corresponds to
    // several different Google Calendar events.
    const db = admin.firestore();
    const teamDoc = await db.collection('companies').doc(companyId).collection('settings').doc('team').get();
    const teamData = teamDoc.exists ? teamDoc.data() : null;
    const members = teamData
      ? (teamData.members && typeof teamData.members === 'object'
          ? Object.values(teamData.members)
          : Object.values(teamData).filter(v => v && typeof v === 'object' && (v.email || v.role)))
      : [];
    if (!members.length) { console.log('No team members found - skipping Everyone push'); return null; }

    // Same real bug, other direction: if this event was previously a
    // single-assignee event (singular gcalEventId) and just got
    // reassigned to Everyone, clean up that one old event too, before
    // the loop below creates the new per-member ones.
    if (before?.gcalEventId && before?.assignee) {
      const oldUid = await getUidForEmail(before.assignee);
      if (oldUid) {
        const oldCal = await getCalendarClientForUser(companyId, oldUid);
        if (oldCal) {
          try { await oldCal.events.delete({ calendarId: 'primary', eventId: before.gcalEventId }); }
          catch (e) { console.warn('cleanup of old single-assignee event failed:', e.message); }
        }
      }
    }

    const gcalEventIds = { ...((after || before)?.gcalEventIds || {}) };
    let idsChanged = false;

    for (const member of members) {
      if (!member.email) continue;
      const uid = await getUidForEmail(member.email);
      if (!uid) continue;
      const cal = await getCalendarClientForUser(companyId, uid);
      if (!cal) continue;

      if (!after) {
        if (gcalEventIds[uid]) {
          try { await cal.events.delete({ calendarId: 'primary', eventId: gcalEventIds[uid] }); }
          catch (e) { console.warn('gcal Everyone-event delete failed for', member.email, ':', e.message); }
        }
        continue;
      }

      const eventBody = buildPersonalEventBody(after);
      try {
        if (gcalEventIds[uid]) {
          await cal.events.update({ calendarId: 'primary', eventId: gcalEventIds[uid], requestBody: eventBody });
        } else {
          const created = await cal.events.insert({ calendarId: 'primary', requestBody: eventBody });
          gcalEventIds[uid] = created.data.id;
          idsChanged = true;
        }
      } catch (e) {
        console.error('pushPersonalEventToGCal (Everyone) failed for', member.email, ':', e.message);
      }
    }

    if (after && idsChanged) {
      await change.after.ref.update({ gcalEventIds, gcalEventId: admin.firestore.FieldValue.delete() });
    }
    return null;
  });

// pushPhaseToGCal
// ───────────────
// Simplified 2026-09-28 per Travis: now JOB-level, not per-room. Every
// scheduled job pushes ONE event PER WORK DAY (Mon-Fri) in its
// startDate..endDate range, 8:00 AM - 4:30 PM Central, to every crew
// member's calendar who's connected -- not one giant multi-day banner,
// and not one event per room. Fires on the job document itself now,
// watching crew/startDate/endDate specifically (not every unrelated job
// edit -- notes, phone number, etc. shouldn't touch anyone's calendar).
//
// gcalEventIds is now nested: {uid: {'YYYY-MM-DD': eventId}}, so each
// person's each individual work day is tracked separately -- needed to
// correctly add newly-covered days, update ones whose time didn't
// change, and delete days that fall out of range (job shortened, a crew
// member removed) without touching days that are still valid.
function listWorkDaysISO(startISO, endISO) {
  const days = [];
  const d = new Date(startISO + 'T00:00:00');
  const end = new Date(endISO + 'T00:00:00');
  while (d <= end) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) days.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return days;
}

exports.pushPhaseToGCal = functions.firestore
  .document('companies/{companyId}/jobs/{jobId}')
  .onWrite(async (change, context) => {
    const { companyId, jobId } = context.params;
    const before = change.before.exists ? change.before.data() : null;
    const after = change.after.exists ? change.after.data() : null;
    if (!after) return null; // job deleted -- leaving stray calendar events rather than guessing is safer than a delete-everything path here

    const crewChanged = JSON.stringify(before?.crew||[]) !== JSON.stringify(after?.crew||[]);
    const datesChanged = before?.startDate !== after?.startDate || before?.endDate !== after?.endDate;
    if (!crewChanged && !datesChanged) return null;

    const newWorkDays = (after.startDate && after.endDate) ? listWorkDaysISO(after.startDate, after.endDate) : [];
    const newWorkDaySet = new Set(newWorkDays);

    // Union of before+after crew, so someone just REMOVED from crew
    // still gets their stale events cleaned up, not just skipped.
    const allMembers = [...(before?.crew||[]), ...(after?.crew||[])];
    const seenEmails = new Set();
    const gcalEventIds = { ...(after.gcalEventIds || {}) };
    let idsChanged = false;

    for (const member of allMembers) {
      if (!member.email || seenEmails.has(member.email)) continue;
      seenEmails.add(member.email);
      const uid = await getUidForEmail(member.email);
      if (!uid) continue;
      const cal = await getCalendarClientForUser(companyId, uid);
      if (!cal) continue;

      const stillOnCrew = (after.crew||[]).some(c => c.email === member.email);
      const existingDays = { ...(gcalEventIds[uid] || {}) };

      // Delete any previously-created day that's no longer valid: job
      // shortened, dates cleared, or this person removed from crew.
      for (const isoDate of Object.keys(existingDays)) {
        if (stillOnCrew && newWorkDaySet.has(isoDate)) continue;
        try { await cal.events.delete({ calendarId: 'primary', eventId: existingDays[isoDate] }); }
        catch (e) { console.warn('gcal day delete failed:', e.message); }
        delete existingDays[isoDate];
        idsChanged = true;
      }

      if (stillOnCrew) {
        for (const isoDate of newWorkDays) {
          const eventBody = {
            summary: `${after.jobNumber || after.name || 'Job'} — ${after.name || ''}`.trim(),
            description: `JOBSpan job schedule${after.jobNumber ? ' (' + after.jobNumber + ')' : ''}`,
            start: { dateTime: `${isoDate}T08:00:00`, timeZone: 'America/Chicago' },
            end: { dateTime: `${isoDate}T16:30:00`, timeZone: 'America/Chicago' },
          };
          try {
            if (existingDays[isoDate]) {
              await cal.events.update({ calendarId: 'primary', eventId: existingDays[isoDate], requestBody: eventBody });
            } else {
              const created = await cal.events.insert({ calendarId: 'primary', requestBody: eventBody });
              existingDays[isoDate] = created.data.id;
              idsChanged = true;
            }
          } catch (e) {
            console.error('pushPhaseToGCal failed for', member.email, isoDate, ':', e.message);
          }
        }
      }

      gcalEventIds[uid] = existingDays;
    }

    if (idsChanged) {
      await change.after.ref.update({ gcalEventIds });
    }
    return null;
  });

// ════════════════════════════════════════════════════════════════════
// QuickBooks Online integration
// ════════════════════════════════════════════════════════════════════
// ONE company-wide QuickBooks connection per JOBSpan company (unlike
// Google Calendar above, which is per-team-member) - whoever with full
// access connects it, the whole company's invoices push through that
// one QBO company file. Decided in chat 7/24/2026: v1 is a MANUAL,
// cascading push triggered by clicking "Push to QuickBooks" on an
// invoice - not an automatic sync on every write, so nothing pushes
// until Travis (or another full-access user) chooses to send it.
//
// Clicking that button runs, in order, skipping any step already done:
//   1. Customer - find-or-create a QBO Customer matching this job's
//      linked customer record (companies/{cid}/customers/{custId}),
//      store the returned Id back on that doc (qbCustomerId) so future
//      jobs for the same customer reuse it instead of duplicating.
//   2. Estimate - if the job has a latest proposal that hasn't been
//      pushed yet, create a QBO Estimate for it (qbEstimateId). Not
//      fatal if there's no proposal on file (e.g. a handshake job) -
//      Invoice push still proceeds either way.
//   3. Invoice - create (or update, if already pushed once) the QBO
//      Invoice for this specific invoice doc (qbInvoiceId).
//   4. Payment - if amtPaid has increased since the last push
//      (qbLastSyncedAmtPaid), record a QBO Payment for just the
//      difference, linked to the Invoice - so re-pushing the same
//      invoice after a partial payment never double-counts.
//
// v1 SIMPLIFICATION (flagged, not silently skipped): QBO requires every
// Estimate/Invoice line to reference an Item from their own
// products/services catalog. JOBSpan doesn't maintain a matching
// catalog inside QBO, so each push sends ONE lump-sum line against a
// single catch-all Service item (auto-detected and cached on first
// use - see getDefaultQboItemId). True line-by-line catalog mapping is
// a real v2 upgrade.
//
// ── ONE-TIME SETUP REQUIRED (Intuit Developer + Firebase CLI, needs
//    Travis - not doable from the JOBSpan chat sandbox): see
//    functions/DEPLOY_QBO.md for the full walkthrough.

const QBO_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const QBO_FULL_ACCESS_ROLES = ['Owner', 'Project Manager', 'Accounting'];

// ── Refresh token encryption (AES-256-GCM) ──────────────────────────
// The QBO refresh token is a standing credential to TDX Holdings' real
// financial data - Firestore security rules already block ALL client
// reads of it (see quickbooksTokens rule in firestore.rules), but
// Intuit's own security requirements additionally call for encrypting
// it at the application level with a symmetric key kept in a separate
// config value (functions.config().qbo.token_encryption_key), not
// alongside the data itself. Generate that key once with:
//   openssl rand -hex 32
// and set it via firebase functions:config:set (see DEPLOY_QBO.md) -
// never hardcode it here.
const crypto = require('crypto');

function getQboEncryptionKey() {
  const hex = process.env.QBO_TOKEN_ENCRYPTION_KEY || (functions.config().qbo || {}).token_encryption_key;
  if (!hex || hex.length !== 64) {
    throw new Error('QuickBooks token encryption key is missing or invalid (set QBO_TOKEN_ENCRYPTION_KEY, a 32-byte hex string). See DEPLOY_QBO.md.');
  }
  return Buffer.from(hex, 'hex');
}

// Generic secret-at-rest encryption -- same AES-256-GCM approach QBO tokens
// already use, reusing the same encryption key. Not QBO-specific despite the
// function name below (kept for backward compatibility with existing call
// sites) -- this is the right primitive for any per-company secret,
// including each company's own Stripe key.
function encryptSecret(plaintext) {
  const key = getQboEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV, standard for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

function decryptSecret(encrypted) {
  const key = getQboEncryptionKey();
  const [ivHex, authTagHex, ciphertextHex] = String(encrypted).split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) throw new Error('Stored secret is malformed or was saved before encryption was enabled.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
  return plaintext.toString('utf8');
}

// Returns a single string "iv:authTag:ciphertext" (all hex) so it drops
// into one Firestore field with no schema change elsewhere.
function encryptQboToken(plaintext) { return encryptSecret(plaintext); }
function decryptQboToken(encrypted) {
  try {
    return decryptSecret(encrypted);
  } catch (e) {
    throw new Error('Stored QuickBooks token is malformed or was saved before encryption was enabled - please reconnect QuickBooks in Settings.');
  }
}

function isQboFullAccess(token) {
  return QBO_FULL_ACCESS_ROLES.includes(token.role) || token.fullAccessOverride === true;
}

function getQboOAuthConfig() {
  // Prefers Secret Manager (process.env), same pattern already used for
  // QBO_TOKEN_ENCRYPTION_KEY below and for Gmail/Chat/Plivo tonight --
  // falls back to the legacy functions.config() mechanism (which needs a
  // local `firebase` CLI session to set, not doable from a browser-only
  // session) only if the env vars aren't set.
  const legacy = functions.config().qbo || {};
  const clientId = process.env.QBO_CLIENT_ID || legacy.client_id;
  const clientSecret = process.env.QBO_CLIENT_SECRET || legacy.client_secret;
  const redirectUri = process.env.QBO_REDIRECT_URI || legacy.redirect_uri;
  const environment = process.env.QBO_ENVIRONMENT || legacy.environment;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return {
    clientId,
    clientSecret,
    redirectUri,
    environment: environment === 'production' ? 'production' : 'sandbox'
  };
}

function qboApiBase(environment) {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function qboBasicAuthHeader(cfg) {
  return 'Basic ' + Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64');
}

// qbOAuthStart
// ────────────
// Requires a valid Firebase ID token (?token=...) AND a full-access
// role, same protection shape as gcalOAuthStart above but with a
// stricter role check - this connects ONE shared company-wide
// financial account, so it needs to be locked down harder than an
// individual's calendar.
exports.qbOAuthStart = functions.runWith({ secrets: ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_REDIRECT_URI', 'QBO_ENVIRONMENT', 'QBO_TOKEN_ENCRYPTION_KEY'] }).https.onRequest(async (req, res) => {
  const cfg = getQboOAuthConfig();
  if (!cfg) {
    res.status(500).send('QuickBooks OAuth is not configured yet (functions.config().qbo missing). See functions/DEPLOY_QBO.md.');
    return;
  }
  const idToken = req.query.token;
  const companyId = req.query.companyId;
  if (!idToken) { res.status(400).send('Missing token'); return; }
  if (!companyId) { res.status(400).send('Missing companyId'); return; }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    res.status(401).send('Invalid or expired session - please reload JOBSpan and try again.');
    return;
  }
  if (decoded.companyId !== companyId) {
    res.status(403).send('You are not a member of this company.');
    return;
  }
  if (!isQboFullAccess(decoded)) {
    res.status(403).send('Only Owner, Project Manager, or Accounting roles can connect QuickBooks.');
    return;
  }

  const state = Buffer.from(JSON.stringify({ companyId, uid: decoded.uid })).toString('base64');
  const authUrl = QBO_AUTH_URL + '?' + new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    state
  }).toString();
  res.redirect(authUrl);
});

// qbOAuthCallback
// ────────────────
// Intuit redirects here after approval, WITH a realmId query param
// identifying which QuickBooks company file was authorized (Intuit
// shows a company picker on its consent screen if the person has
// access to more than one - whichever they pick becomes this realmId).
// Exchanges the code for tokens and stores the refresh token in the
// locked-down quickbooksTokens collection (never client-readable),
// mirroring the googleCalendarTokens pattern above.
exports.qbOAuthCallback = functions.runWith({ secrets: ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_REDIRECT_URI', 'QBO_ENVIRONMENT', 'QBO_TOKEN_ENCRYPTION_KEY'] }).https.onRequest(async (req, res) => {
  const cfg = getQboOAuthConfig();
  if (!cfg) { res.status(500).send('QuickBooks OAuth is not configured yet.'); return; }
  const { code, state, realmId, error } = req.query;
  if (error) { res.status(400).send('Intuit denied access: ' + error + '. You can close this tab and try again.'); return; }
  if (!code || !state || !realmId) { res.status(400).send('Missing code/state/realmId from Intuit.'); return; }

  let parsed;
  try { parsed = JSON.parse(Buffer.from(state, 'base64').toString('utf8')); }
  catch (e) { res.status(400).send('Invalid state.'); return; }
  const { companyId, uid } = parsed;

  try {
    const tokenResp = await fetch(QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': qboBasicAuthHeader(cfg),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: cfg.redirectUri
      }).toString()
    });
    const tokens = await tokenResp.json();
    if (!tokenResp.ok || !tokens.refresh_token) {
      console.error('qbOAuthCallback token exchange failed:', tokens);
      res.status(500).send('QuickBooks did not return valid tokens. Please close this tab and try connecting again.');
      return;
    }

    const db = admin.firestore();
    await db.collection('companies').doc(companyId).collection('quickbooksTokens').doc('connection').set({
      accessToken: tokens.access_token, // short-lived (~1hr) - not encrypted, low value if leaked
      refreshTokenEncrypted: encryptQboToken(tokens.refresh_token), // long-lived credential - AES-256-GCM encrypted at rest
      expiresAt: Date.now() + (tokens.expires_in * 1000),
      realmId: String(realmId),
      environment: cfg.environment,
      connectedByUid: uid,
      connectedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Non-sensitive status flag/fields the client reads directly to
    // show connection state - no tokens ever live here.
    await db.collection('companies').doc(companyId).collection('settings').doc('quickbooks').set({
      connected: true,
      realmId: String(realmId),
      environment: cfg.environment,
      connectedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>✅ QuickBooks connected</h2><p>You can close this tab and go back to JOBSpan.</p></body></html>');
  } catch (e) {
    console.error('qbOAuthCallback error:', e.message);
    res.status(500).send('Error connecting QuickBooks: ' + e.message);
  }
});

// qbDisconnect (callable)
// ────────────────────────
// Best-effort revokes the token on Intuit's side too (so it also drops
// out of "My Apps" in their account), then always clears the local
// connection regardless of whether the revoke call succeeded.
exports.qbDisconnect = functions.runWith({ secrets: ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_REDIRECT_URI', 'QBO_ENVIRONMENT', 'QBO_TOKEN_ENCRYPTION_KEY'] }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const companyId = data.companyId;
  if (!companyId || context.auth.token.companyId !== companyId) {
    throw new functions.https.HttpsError('permission-denied', 'Not a member of this company.');
  }
  if (!isQboFullAccess(context.auth.token)) {
    throw new functions.https.HttpsError('permission-denied', 'Only Owner, Project Manager, or Accounting can disconnect QuickBooks.');
  }

  const db = admin.firestore();
  const cfg = getQboOAuthConfig();
  const tokenRef = db.collection('companies').doc(companyId).collection('quickbooksTokens').doc('connection');
  const tokenDoc = await tokenRef.get();
  if (cfg && tokenDoc.exists && tokenDoc.data().refreshTokenEncrypted) {
    try {
      const refreshToken = decryptQboToken(tokenDoc.data().refreshTokenEncrypted);
      await fetch(QBO_REVOKE_URL, {
        method: 'POST',
        headers: { 'Authorization': qboBasicAuthHeader(cfg), 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ token: refreshToken })
      });
    } catch (e) {
      console.warn('QBO revoke call failed (continuing with local disconnect):', e.message);
    }
  }

  await tokenRef.delete();
  await db.collection('companies').doc(companyId).collection('settings').doc('quickbooks').set({ connected: false }, { merge: true });
  return { disconnected: true };
});

// ensureQboAccessToken
// ─────────────────────
// Returns a ready-to-use {accessToken, realmId, environment} for a
// company, refreshing against Intuit first if the current access token
// is expired or about to be (within 2 minutes). Intuit refresh tokens
// ROTATE on every use - the new one returned here is always re-saved,
// or the old one stops working on the next call.
async function ensureQboAccessToken(companyId) {
  const cfg = getQboOAuthConfig();
  if (!cfg) throw new Error('QuickBooks is not configured (functions.config().qbo missing).');
  const db = admin.firestore();
  const ref = db.collection('companies').doc(companyId).collection('quickbooksTokens').doc('connection');
  const doc = await ref.get();
  if (!doc.exists) throw new Error('QuickBooks is not connected for this company yet - connect it in Settings first.');
  const data = doc.data();

  if (data.expiresAt && data.expiresAt - Date.now() > 2 * 60 * 1000) {
    return { accessToken: data.accessToken, realmId: data.realmId, environment: data.environment };
  }

  const resp = await fetch(QBO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': qboBasicAuthHeader(cfg),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decryptQboToken(data.refreshTokenEncrypted) }).toString()
  });
  const tokens = await resp.json();
  if (!resp.ok || !tokens.access_token) {
    console.error('QBO token refresh failed:', tokens);
    throw new Error('The QuickBooks connection has expired or was revoked - please reconnect it in Settings.');
  }
  await ref.update({
    accessToken: tokens.access_token,
    // Intuit rotates the refresh token on every use - re-encrypt and
    // save the new one, or the old one stops working next time.
    refreshTokenEncrypted: tokens.refresh_token ? encryptQboToken(tokens.refresh_token) : data.refreshTokenEncrypted,
    expiresAt: Date.now() + (tokens.expires_in * 1000)
  });
  return { accessToken: tokens.access_token, realmId: data.realmId, environment: data.environment };
}

// Thin wrapper for calling Intuit's Accounting API v3. Captures the
// intuit_tid response header on every call - Intuit's own support
// recommends logging this, since it's the fastest way for their team
// to look up exactly what happened on their end for a given request.
async function qboFetch(companyId, method, path, body) {
  const { accessToken, realmId, environment } = await ensureQboAccessToken(companyId);
  const url = `${qboApiBase(environment)}/v3/company/${realmId}/${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const intuitTid = resp.headers.get('intuit_tid');
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = json?.Fault?.Error?.[0]?.Message || json?.Fault?.Error?.[0]?.Detail || resp.statusText;
    console.error('QuickBooks API error', { companyId, path, status: resp.status, intuitTid, msg });
    throw new Error(`QuickBooks API error: ${msg}${intuitTid ? ` (intuit_tid: ${intuitTid})` : ''}`);
  }
  return json;
}

// Escapes single quotes for QBO's SQL-like query language (their docs
// call it "Data Service query language" - backslash-escape, not '').
function qboEsc(str) { return String(str || '').replace(/'/g, "\\'"); }

// getDefaultQboItemId
// ────────────────────
// See the v1 simplification note at the top of this section - caches
// the chosen Item's Id on settings/quickbooks after the first lookup
// so every subsequent push skips the query.
async function getDefaultQboItemId(companyId) {
  const db = admin.firestore();
  const cfgRef = db.collection('companies').doc(companyId).collection('settings').doc('quickbooks');
  const cfgDoc = await cfgRef.get();
  if (cfgDoc.exists && cfgDoc.data().defaultItemId) return cfgDoc.data().defaultItemId;

  const result = await qboFetch(companyId, 'GET',
    `query?query=${encodeURIComponent("SELECT * FROM Item WHERE Type IN ('Service','NonInventory') MAXRESULTS 1")}`);
  const item = result?.QueryResponse?.Item?.[0];
  if (!item) throw new Error('No usable Item found in QuickBooks to bill against - create at least one Service item in QuickBooks first, then try again.');
  await cfgRef.set({ defaultItemId: item.Id, defaultItemName: item.Name }, { merge: true });
  return item.Id;
}

// ensureQboCustomer
// ──────────────────
// Find-or-create the QBO Customer for a JOBSpan customer record.
// Matches by DisplayName first (covers a customer already created
// manually in QBO, or by an earlier push), otherwise creates a new
// one. Stores the QBO Id back on the JOBSpan customer doc so every
// future job for that same customer reuses it instead of duplicating.
async function ensureQboCustomer(companyId, customerId) {
  const db = admin.firestore();
  const custRef = db.collection('companies').doc(companyId).collection('customers').doc(customerId);
  const custDoc = await custRef.get();
  if (!custDoc.exists) throw new Error('Customer record not found for this job - open the job and confirm it has a linked Customer.');
  const cust = custDoc.data();
  if (cust.qbCustomerId) return cust.qbCustomerId;

  const name = cust.name || 'Unknown Customer';
  const existing = await qboFetch(companyId, 'GET',
    `query?query=${encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${qboEsc(name)}'`)}`);
  const found = existing?.QueryResponse?.Customer?.[0];
  if (found) {
    await custRef.update({ qbCustomerId: found.Id });
    return found.Id;
  }

  const payload = { DisplayName: name };
  if (cust.email) payload.PrimaryEmailAddr = { Address: cust.email };
  if (cust.phone) payload.PrimaryPhone = { FreeFormNumber: cust.phone };
  if (cust.address) payload.BillAddr = { Line1: cust.address };
  const created = await qboFetch(companyId, 'POST', 'customer', payload);
  const qbId = created?.Customer?.Id;
  if (!qbId) throw new Error('QuickBooks did not return a Customer Id.');
  await custRef.update({ qbCustomerId: qbId });
  return qbId;
}

// ensureQboEstimate
// ──────────────────
// Pushes the job's latest proposal (if any, and if not already pushed)
// as a QBO Estimate. A missing proposal isn't fatal - Invoice push
// still proceeds without one (e.g. a handshake deal with no formal
// estimate on file).
async function ensureQboEstimate(companyId, jobId, qbCustomerId) {
  const db = admin.firestore();
  const propSnap = await db.collection('companies').doc(companyId).collection('jobs').doc(jobId)
    .collection('proposals').orderBy('version', 'desc').limit(1).get();
  if (propSnap.empty) return null;
  const propDoc = propSnap.docs[0];
  const prop = propDoc.data();
  if (prop.qbEstimateId) return prop.qbEstimateId;

  const itemId = await getDefaultQboItemId(companyId);

  // Build one QBO Line per subgroup (catBlock), matching exactly how the
  // proposal PDF itself is organized (Room -> Subgroup -> price) --
  // e.g. "Living room: Ceiling Fan Install", "Exterior: Doors & Windows" --
  // rather than one lump total. This is real proposal data
  // (prop.snapshot.rooms), not a re-derivation -- same shape
  // computeProposalData() builds client-side for the PDF/email.
  const snapshot = prop.snapshot || { rooms: [], grandTotal: 0 };
  const lines = [];
  (snapshot.rooms || []).forEach(room => {
    (room.catBlocks || []).forEach(block => {
      if (!block.price || block.price <= 0) return;
      lines.push({
        Amount: block.price,
        DetailType: 'SalesItemLineDetail',
        Description: `${room.name} — ${block.label}`,
        SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: block.price },
      });
    });
    (room.directBlocks || []).forEach(block => {
      if (!block.price || block.price <= 0) return;
      lines.push({
        Amount: block.price,
        DetailType: 'SalesItemLineDetail',
        Description: `${room.name} — ${block.label}`,
        SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: block.price },
      });
    });
  });

  // Fallback for a proposal with no itemized rooms recorded (shouldn't
  // normally happen, but never send QBO a zero-line Estimate) -- same
  // single lump-sum line this function used before.
  if (!lines.length) {
    const total = snapshot.grandTotal || 0;
    lines.push({
      Amount: total,
      DetailType: 'SalesItemLineDetail',
      Description: 'JOBSpan Estimate',
      SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: total },
    });
  }

  const payload = { CustomerRef: { value: qbCustomerId }, Line: lines };
  const created = await qboFetch(companyId, 'POST', 'estimate', payload);
  const qbId = created?.Estimate?.Id;
  if (qbId) await propDoc.ref.update({ qbEstimateId: qbId });
  return qbId;
}

// qbPushEstimate (callable)
// ─────────────────────────
// Standalone "Send to QuickBooks" button for a proposal -- pushes the
// itemized Estimate immediately, independent of ever creating an
// invoice. Previously ensureQboEstimate only ran as a side effect of
// qbCreateInvoice, so there was no way to get a proposal into QBO
// until the first draw was invoiced. Same auth pattern as qbCreateInvoice.
exports.qbPushEstimate = functions.runWith({ secrets: ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_REDIRECT_URI', 'QBO_ENVIRONMENT', 'QBO_TOKEN_ENCRYPTION_KEY'] }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const { companyId, jobId } = data;
  if (!companyId || !jobId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing companyId/jobId.');
  }
  if (context.auth.token.companyId !== companyId) {
    throw new functions.https.HttpsError('permission-denied', 'Not a member of this company.');
  }
  if (!isQboFullAccess(context.auth.token)) {
    throw new functions.https.HttpsError('permission-denied', 'Only Owner, Project Manager, or Accounting can push to QuickBooks.');
  }

  const db = admin.firestore();
  const jobDoc = await db.collection('companies').doc(companyId).collection('jobs').doc(jobId).get();
  if (!jobDoc.exists) throw new functions.https.HttpsError('not-found', 'Job not found.');
  const job = jobDoc.data();
  if (!job.customerId) {
    throw new functions.https.HttpsError('failed-precondition',
      'This job has no linked Customer record — open the job and set a Customer before pushing to QuickBooks.');
  }

  try {
    const qbCustomerId = await ensureQboCustomer(companyId, job.customerId);
    const qbEstimateId = await ensureQboEstimate(companyId, jobId, qbCustomerId);
    if (!qbEstimateId) {
      throw new Error('No proposal found for this job to push.');
    }
    return { success: true, qbEstimateId };
  } catch (e) {
    console.error('qbPushEstimate failed:', e.message);
    throw new functions.https.HttpsError('internal', e.message);
  }
});

// qbCreateInvoice (callable)
// ───────────────────────────
// The button Travis clicks: "Push to QuickBooks" on an invoice.
// Cascades Customer -> Estimate -> Invoice -> Payment in order, each
// step skipped if already done, and returns the QBO Invoice Id so the
// button can confirm success.
// Core QBO sync logic, extracted out of qbCreateInvoice so it can be
// reused by both the manual "Push to QuickBooks" button (qbCreateInvoice,
// which wraps this with auth checks) and the Stripe payment webhook
// (which has no user context to check auth against - Stripe calls it
// directly, not the client). Never had any context.auth dependency to
// begin with, so this extraction is behavior-preserving.
async function syncInvoiceToQbo(companyId, jobId, invoiceId) {
  const db = admin.firestore();
  const jobRef = db.collection('companies').doc(companyId).collection('jobs').doc(jobId);
  const invRef = jobRef.collection('invoices').doc(invoiceId);
  const [jobDoc, invDoc] = await Promise.all([jobRef.get(), invRef.get()]);
  if (!jobDoc.exists) throw new Error('Job not found.');
  if (!invDoc.exists) throw new Error('Invoice not found.');
  const job = jobDoc.data();
  const inv = invDoc.data();

  if (!job.customerId) {
    throw new Error('This job has no linked Customer record - open the job and set a Customer before pushing to QuickBooks.');
  }

  // 1. Customer
  const qbCustomerId = await ensureQboCustomer(companyId, job.customerId);

  // 2. Estimate (best-effort - a missing proposal doesn't block the invoice)
  try { await ensureQboEstimate(companyId, jobId, qbCustomerId); }
  catch (e) { console.warn('QBO Estimate push skipped:', e.message); }

  // 3. Invoice
  const itemId = await getDefaultQboItemId(companyId);
  const total = inv.total || 0;
  let qbInvoiceId = inv.qbInvoiceId;
  if (qbInvoiceId) {
    // Updating requires the current SyncToken - QBO rejects updates
    // without the exact token it last handed out (optimistic locking).
    const current = await qboFetch(companyId, 'GET', `invoice/${qbInvoiceId}`);
    const syncToken = current?.Invoice?.SyncToken;
    const updated = await qboFetch(companyId, 'POST', 'invoice', {
      Id: qbInvoiceId,
      SyncToken: syncToken,
      sparse: true,
      CustomerRef: { value: qbCustomerId },
      Line: [{
        Amount: total,
        DetailType: 'SalesItemLineDetail',
        Description: job.name || 'JOBSpan Invoice',
        SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: total }
      }]
    });
    // Backfills qbPaymentLink for invoices pushed before this field
    // existed, or if QuickBooks Payments was only just enabled.
    const linkNow = updated?.Invoice?.InvoiceLink || current?.Invoice?.InvoiceLink;
    if (linkNow) await invRef.update({ qbPaymentLink: linkNow });
  } else {
    const created = await qboFetch(companyId, 'POST', 'invoice', {
      CustomerRef: { value: qbCustomerId },
      DueDate: inv.dueDate || undefined,
      Line: [{
        Amount: total,
        DetailType: 'SalesItemLineDetail',
        Description: job.name || 'JOBSpan Invoice',
        SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: total }
      }]
    });
    qbInvoiceId = created?.Invoice?.Id;
    if (!qbInvoiceId) throw new Error('QuickBooks did not return an Invoice Id.');
    // InvoiceLink is QuickBooks' own hosted, secure payment page for
    // this invoice - only present when QuickBooks Payments is active
    // on the connected company. Stored separately from the manual
    // paymentLink field (never overwritten) - the client falls back
    // to this automatically only when paymentLink is blank.
    const update = { qbInvoiceId };
    if (created?.Invoice?.InvoiceLink) update.qbPaymentLink = created.Invoice.InvoiceLink;
    await invRef.update(update);
  }

  // 4. Payment - only the un-recorded delta, so re-pushing the same
  // invoice after a partial payment never double-counts. Re-reads the
  // invoice doc here since amtPaid may have just been updated by the
  // caller (e.g. the Stripe webhook) moments before calling this.
  const freshInv = (await invRef.get()).data();
  const amtPaid = freshInv.amtPaid || 0;
  const lastSynced = freshInv.qbLastSyncedAmtPaid || 0;
  // QBO_PAYMENT_PULL_V1: never record more than QuickBooks says is still
  // owed -- if the customer already paid through the QuickBooks pay link,
  // the money is in QuickBooks and must not be entered a second time.
  let qbBalance = null;
  if (amtPaid > lastSynced) {
    try { const q = await qboFetch(companyId, 'GET', `invoice/${qbInvoiceId}`); qbBalance = Number(q?.Invoice?.Balance); } catch (e) { qbBalance = null; }
  }
  if (amtPaid > lastSynced && qbBalance !== null && !isNaN(qbBalance) && qbBalance <= 0.009) {
    await invRef.update({ qbLastSyncedAmtPaid: amtPaid });
  } else if (amtPaid > lastSynced) {
    const deltaAmt = (qbBalance !== null && !isNaN(qbBalance)) ? Math.min(amtPaid - lastSynced, qbBalance) : amtPaid - lastSynced;
    const createdPayment = await qboFetch(companyId, 'POST', 'payment', {
      CustomerRef: { value: qbCustomerId },
      TotalAmt: deltaAmt,
      Line: [{ Amount: deltaAmt, LinkedTxn: [{ TxnId: qbInvoiceId, TxnType: 'Invoice' }] }]
    });
    const qbPaymentId = createdPayment?.Payment?.Id;
    await invRef.update({
      qbLastSyncedAmtPaid: amtPaid,
      qbPaymentIds: admin.firestore.FieldValue.arrayUnion(qbPaymentId)
    });
  }

  return { success: true, qbInvoiceId };
}

// ════════════════════════════════════════════════════
// ── QuickBooks -> JOBSMETRIX payment sync (QBO_PAYMENT_PULL_V1, 2026-10-11)
// ════════════════════════════════════════════════════
// Invoices go out with QuickBooks Payments' own pay link (qbPaymentLink).
// When a customer pays there, QuickBooks knows -- JOBSMETRIX didn't, so
// the invoice stayed unpaid, the deposit gate stayed shut, and the P/L
// missed the cash. This reads every pushed, not-fully-paid invoice back
// from QuickBooks (Balance vs TotalAmt) and records whatever was paid
// there. Runs when an owner opens JOBSMETRIX (every 15 min while it's
// open), on the Pipeline tab refresh, on a job's Invoices tab, and on
// the "Check QuickBooks for payments" button. No Intuit webhook setup
// needed. Payments recorded here set qbLastSyncedAmtPaid too, so the
// push in syncInvoiceToQbo never sends them back to QuickBooks twice.
const QBO_PULL_EARLY_STATUSES = ['New Lead', 'Appointment Set', 'Building Estimate', 'Submitted', 'Awaiting Deposit'];

// QBO_INVOICE_IMPORT_V1 (2026-10-14). Travis makes most invoices directly
// in QuickBooks, not in JOBSMETRIX, so the payment pull below (which only
// follows invoices JOBSMETRIX created) never saw them. This pulls every
// QuickBooks invoice changed in the last 180 days (or since the last run),
// and for any JOBSMETRIX doesn't already have, finds the job by CUSTOMER
// NAME (how Travis identifies jobs in QuickBooks). Exactly one open job for
// that customer -> the invoice is added to that job. None, or several ->
// it waits in qbUnmatchedInvoices for the owner to pick the job.
function qboNormName(s) {
  return String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(llc|inc|co|corp|company|the)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function qboInvoiceToDoc(q, jobId) {
  const today = new Date().toISOString().split('T')[0];
  const total = Number(q.TotalAmt) || 0;
  const bal = Number(q.Balance) || 0;
  const paid = Math.round((total - bal) * 100) / 100;
  let status = 'Sent';
  if (total > 0 && bal <= 0.009) status = 'Paid';
  else if (paid > 0.009) status = 'Partial';
  else if (q.DueDate && q.DueDate < today) status = 'Overdue';
  const lineItems = (q.Line || [])
    .filter(l => l.DetailType === 'SalesItemLineDetail' || l.DetailType === 'DescriptionOnly')
    .map(l => {
      const d = l.SalesItemLineDetail || {};
      const qty = Number(d.Qty) || 1;
      const rate = d.UnitPrice != null ? Number(d.UnitPrice) : (Number(l.Amount) || 0) / qty;
      return { desc: l.Description || (d.ItemRef && d.ItemRef.name) || '', qty, rate: Math.round(rate * 100) / 100 };
    })
    .filter(li => li.desc || li.rate);
  const subtotal = lineItems.reduce((s, li) => s + li.qty * li.rate, 0);
  const tax = Number(q.TxnTaxDetail && q.TxnTaxDetail.TotalTax) || 0;
  const doc = {
    number: q.DocNumber || '',
    type: 'Progress',
    date: q.TxnDate || today,
    dueDate: q.DueDate || '',
    status,
    lineItems,
    subtotal: Math.round(subtotal * 100) / 100,
    taxRate: subtotal > 0 ? Math.round(tax / subtotal * 10000) / 100 : 0,
    taxAmt: tax,
    total,
    amtPaid: paid,
    qbLastSyncedAmtPaid: paid,
    paymentMethod: paid > 0 ? 'QuickBooks' : '',
    notes: q.CustomerMemo && q.CustomerMemo.value ? q.CustomerMemo.value : '',
    qbInvoiceId: q.Id,
    qbCustomerName: (q.CustomerRef && q.CustomerRef.name) || '',
    qbPaymentLink: q.InvoiceLink || '',
    source: 'quickbooks',
    jobId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: 'QuickBooks (import)',
  };
  if (status === 'Paid') doc.paidDate = q.MetaData && q.MetaData.LastUpdatedTime ? q.MetaData.LastUpdatedTime.slice(0, 10) : today;
  return doc;
}

async function importQboInvoices(companyId) {
  const db = admin.firestore();
  const coRef = db.collection('companies').doc(companyId);
  const settingsRef = coRef.collection('settings').doc('quickbooks');
  const settings = (await settingsRef.get()).data() || {};
  const sinceMs = settings.lastInvoiceImportAt ? settings.lastInvoiceImportAt - 24 * 3600 * 1000 : Date.now() - 180 * 24 * 3600 * 1000;
  const since = new Date(sinceMs).toISOString().slice(0, 19) + 'Z';
  const startedAt = Date.now();

  // Every invoice JOBSMETRIX already knows about, by QuickBooks Id.
  const jobsSnap = await coRef.collection('jobs').get();
  const known = new Set();
  const jobs = [];
  await Promise.all(jobsSnap.docs.map(async jd => {
    const j = jd.data();
    if (!j.archived) jobs.push({ id: jd.id, ref: jd.ref, ...j });
    const inv = await jd.ref.collection('invoices').get();
    inv.forEach(d => { const x = d.data(); if (x.qbInvoiceId) known.add(String(x.qbInvoiceId)); });
  }));
  const unmatchedSnap = await coRef.collection('qbUnmatchedInvoices').get();
  const unmatchedIds = new Set(unmatchedSnap.docs.map(d => d.id));

  // Jobs by customer name; closed-lost jobs never take an invoice.
  const byName = {};
  jobs.forEach(j => {
    if (j.status === 'Closed Lost') return;
    const k = qboNormName(j.client);
    if (!k) return;
    (byName[k] = byName[k] || []).push(j);
  });

  const qInvoices = [];
  for (let start = 1; start < 5000; start += 500) {
    const q = `SELECT * FROM Invoice WHERE MetaData.LastUpdatedTime >= '${since}' ORDERBY MetaData.LastUpdatedTime STARTPOSITION ${start} MAXRESULTS 500`;
    const r = await qboFetch(companyId, 'GET', `query?query=${encodeURIComponent(q)}`);
    const page = (r && r.QueryResponse && r.QueryResponse.Invoice) || [];
    qInvoices.push(...page);
    if (page.length < 500) break;
  }

  const imported = [], unmatched = [];
  for (const q of qInvoices) {
    const id = String(q.Id);
    if (known.has(id)) continue;
    const custName = (q.CustomerRef && q.CustomerRef.name) || '';
    const key = qboNormName(custName);
    let cands = byName[key] || [];
    // More than one job for the customer: prefer the ones still open.
    if (cands.length > 1) {
      const open = cands.filter(j => j.status !== 'Closed Completed');
      if (open.length) cands = open;
    }
    if (cands.length === 1) {
      const job = cands[0];
      await job.ref.collection('invoices').add(qboInvoiceToDoc(q, job.id));
      if (unmatchedIds.has(id)) await coRef.collection('qbUnmatchedInvoices').doc(id).delete().catch(() => {});
      const today = new Date().toISOString().split('T')[0];
      await job.ref.collection('logs').add({
        date: today, type: 'invoice_imported', userName: 'QuickBooks (auto)', companyId,
        notes: `QuickBooks invoice ${q.DocNumber || ''} for $${(Number(q.TotalAmt) || 0).toFixed(2)} added from QuickBooks`.replace('  ', ' '),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
      imported.push({ jobId: job.id, jobName: job.address || job.name || '', number: q.DocNumber || '', total: Number(q.TotalAmt) || 0 });
    } else {
      await coRef.collection('qbUnmatchedInvoices').doc(id).set({
        qbInvoiceId: id, number: q.DocNumber || '', customerName: custName,
        date: q.TxnDate || '', total: Number(q.TotalAmt) || 0, balance: Number(q.Balance) || 0,
        candidateJobIds: cands.map(j => j.id),
        reason: cands.length ? 'More than one open job for this customer' : 'No job with this customer name',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      unmatched.push({ number: q.DocNumber || '', customerName: custName });
    }
  }
  await settingsRef.set({ lastInvoiceImportAt: startedAt, lastInvoiceImportCount: imported.length }, { merge: true }).catch(() => {});
  return { imported, unmatched: unmatched.length };
}

async function pullQboPayments(companyId) {
  const db = admin.firestore();
  // QBO_INVOICE_IMPORT_V1: bring in invoices made directly in QuickBooks
  // first, so their payments are picked up by the pull below too.
  let importResult = { imported: [], unmatched: 0 };
  try { importResult = await importQboInvoices(companyId); }
  catch (e) { console.error('QuickBooks invoice import failed:', e.message); importResult.error = e.message; }
  const jobsSnap = await db.collection('companies').doc(companyId).collection('jobs').get();
  const targets = [];
  await Promise.all(jobsSnap.docs.map(async jd => {
    const job = jd.data();
    if (job.status === 'Closed Lost') return;
    const invSnap = await jd.ref.collection('invoices').get();
    invSnap.forEach(d => {
      const inv = d.data();
      if (!inv.qbInvoiceId || inv.status === 'Paid' || inv.status === 'Void') return;
      if ((Number(inv.total) || 0) - (Number(inv.amtPaid) || 0) <= 0.009) return;
      targets.push({ jobRef: jd.ref, jobId: jd.id, job, invRef: d.ref, invId: d.id, inv });
    });
  }));
  const updated = [];
  for (let i = 0; i < targets.length; i += 30) {
    const chunk = targets.slice(i, i + 30);
    const ids = chunk.map(t => `'${qboEsc(t.inv.qbInvoiceId)}'`).join(',');
    const result = await qboFetch(companyId, 'GET',
      `query?query=${encodeURIComponent(`SELECT * FROM Invoice WHERE Id IN (${ids}) MAXRESULTS 30`)}`);
    const byId = {};
    (result?.QueryResponse?.Invoice || []).forEach(q => { byId[q.Id] = q; });
    for (const t of chunk) {
      const q = byId[t.inv.qbInvoiceId];
      if (!q) continue;
      const qTotal = Number(q.TotalAmt) || 0, qBal = Number(q.Balance) || 0;
      const paidInQbo = Math.round((qTotal - qBal) * 100) / 100;
      const total = Number(t.inv.total) || 0;
      const had = Number(t.inv.amtPaid) || 0;
      if (paidInQbo <= had + 0.009) continue;
      const newPaid = Math.min(total || paidInQbo, paidInQbo);
      const amountNow = Math.round((newPaid - had) * 100) / 100;
      const full = newPaid >= total - 0.009;
      const today = new Date().toISOString().split('T')[0];
      const upd = {
        amtPaid: newPaid,
        qbLastSyncedAmtPaid: Math.max(Number(t.inv.qbLastSyncedAmtPaid) || 0, paidInQbo),
        status: full ? 'Paid' : 'Partial',
        paymentMethod: 'QuickBooks Payments',
        qbPaymentPulledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (full) upd.paidDate = today;
      await t.invRef.update(upd);
      const amtStr = amountNow.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      await t.jobRef.collection('logs').add({
        date: today,
        notes: `Invoice ${t.inv.number || ''} ${full ? 'paid' : 'partly paid'} in QuickBooks — $${amtStr}`.replace('  ', ' '),
        type: 'invoice_paid', userName: 'QuickBooks (auto)', companyId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
      // Same forward-only advance the manual Mark Paid does.
      if (QBO_PULL_EARLY_STATUSES.includes(t.job.status)) {
        await t.jobRef.update({ status: 'To Be Scheduled', statusDate: today, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: 'QuickBooks (auto)' }).catch(() => {});
      }
      updated.push({ jobId: t.jobId, invoiceId: t.invId, number: t.inv.number || '', jobName: t.job.address || t.job.name || '', amount: amountNow, full });
    }
  }
  await db.collection('companies').doc(companyId).collection('settings').doc('quickbooks')
    .set({ lastPaymentPullAt: Date.now(), lastPaymentPullChecked: targets.length }, { merge: true }).catch(() => {});
  return { checked: targets.length, updated, imported: importResult.imported, unmatched: importResult.unmatched, importError: importResult.error || null };
}

exports.qbSyncPayments = functions.runWith({ secrets: ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_REDIRECT_URI', 'QBO_ENVIRONMENT', 'QBO_TOKEN_ENCRYPTION_KEY'], timeoutSeconds: 120 }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const { companyId } = data || {};
  if (!companyId || context.auth.token.companyId !== companyId) {
    throw new functions.https.HttpsError('permission-denied', 'Not a member of this company.');
  }
  try {
    return await pullQboPayments(companyId);
  } catch (e) {
    console.error('qbSyncPayments failed:', e.message);
    throw new functions.https.HttpsError('internal', e.message);
  }
});

// QBO_INVOICE_IMPORT_V1: owner picks the job for a QuickBooks invoice the
// import couldn't place on its own.
exports.qbAssignInvoice = functions.runWith({ secrets: ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_REDIRECT_URI', 'QBO_ENVIRONMENT', 'QBO_TOKEN_ENCRYPTION_KEY'], timeoutSeconds: 60 }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const { companyId, qbInvoiceId, jobId, ignore } = data || {};
  if (!companyId || !qbInvoiceId || context.auth.token.companyId !== companyId) {
    throw new functions.https.HttpsError('permission-denied', 'Not a member of this company.');
  }
  if (!isQboFullAccess(context.auth.token)) {
    throw new functions.https.HttpsError('permission-denied', 'Only Owner, Project Manager, or Accounting can do this.');
  }
  const coRef = admin.firestore().collection('companies').doc(companyId);
  const umRef = coRef.collection('qbUnmatchedInvoices').doc(String(qbInvoiceId));
  if (ignore) { await umRef.set({ ignored: true }, { merge: true }); return { ok: true, ignored: true }; }
  if (!jobId) throw new functions.https.HttpsError('invalid-argument', 'Pick a job.');
  try {
    const r = await qboFetch(companyId, 'GET', `invoice/${encodeURIComponent(qbInvoiceId)}`);
    const q = r && r.Invoice;
    if (!q) throw new Error('QuickBooks invoice not found');
    const jobRef = coRef.collection('jobs').doc(jobId);
    const dup = await jobRef.collection('invoices').where('qbInvoiceId', '==', String(q.Id)).limit(1).get();
    if (dup.empty) await jobRef.collection('invoices').add(qboInvoiceToDoc(q, jobId));
    await umRef.delete().catch(() => {});
    return { ok: true };
  } catch (e) {
    console.error('qbAssignInvoice failed:', e.message);
    throw new functions.https.HttpsError('internal', e.message);
  }
});

exports.qbCreateInvoice = functions.runWith({ secrets: ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_REDIRECT_URI', 'QBO_ENVIRONMENT', 'QBO_TOKEN_ENCRYPTION_KEY'] }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const { companyId, jobId, invoiceId } = data;
  if (!companyId || !jobId || !invoiceId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing companyId/jobId/invoiceId.');
  }
  if (context.auth.token.companyId !== companyId) {
    throw new functions.https.HttpsError('permission-denied', 'Not a member of this company.');
  }
  if (!isQboFullAccess(context.auth.token)) {
    throw new functions.https.HttpsError('permission-denied', 'Only Owner, Project Manager, or Accounting can push to QuickBooks.');
  }

  try {
    return await syncInvoiceToQbo(companyId, jobId, invoiceId);
  } catch (e) {
    console.error('qbCreateInvoice failed:', e.message);
    throw new functions.https.HttpsError('internal', e.message);
  }
});

// ════════════════════════════════════════════════════
// ── Xero (XERO_V1, 2026-10-22) ───────────────────────
// ════════════════════════════════════════════════════
// Xero replaces QuickBooks as the books. Same shape as the QuickBooks
// connection above: one company-wide connection, tokens encrypted at rest
// (same AES-256-GCM key) in companies/{id}/xeroTokens/connection which the
// security rules never let a client read, and a plain status doc at
// settings/xero the client reads to show "Connected".
//
// What it does:
//  - Set up (one click): makes the income/cost accounts JOBSMETRIX books to,
//    a "Stripe" bank account for card payments, and a "Job" tracking
//    category so every Xero line carries the job number.
//  - Invoices: each JOBSMETRIX invoice goes to Xero with the SAME number,
//    the job number as Reference, each line split into labor and materials
//    by the job's labor share, tagged to the job.
//  - Payments both ways: a payment JOBSMETRIX records (Stripe link, check,
//    cash) is applied to the Xero invoice; a payment made on Xero's own pay
//    page is read back into JOBSMETRIX (every 30 min, and on demand), which
//    also moves a deposit-waiting job to To Be Scheduled.
const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_REVOKE_URL = 'https://identity.xero.com/connect/revocation';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
const XERO_API = 'https://api.xero.com/api.xro/2.0';
const XERO_REDIRECT_URI = 'https://us-central1-kytrac-72d91.cloudfunctions.net/xeroOAuthCallback';
const XERO_SECRETS = ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'QBO_TOKEN_ENCRYPTION_KEY'];
// Apps created after 2 March 2026 must ask for Xero's granular scopes.
const XERO_SCOPES = 'offline_access openid profile email accounting.invoices accounting.payments accounting.banktransactions accounting.contacts accounting.settings accounting.attachments';
const XERO_SCOPES_LEGACY = 'offline_access openid profile email accounting.transactions accounting.contacts accounting.settings accounting.attachments';
// The accounts JOBSMETRIX books to. Found by name first; created with the
// first free code at or after `code` if missing.
const XERO_ACCOUNTS = [
  { key: 'jobIncome', name: 'Job Income', type: 'REVENUE', code: '4000' },
  { key: 'laborIncome', name: 'Labor Income', type: 'REVENUE', code: '4010' },
  { key: 'materialsIncome', name: 'Materials Income', type: 'REVENUE', code: '4020' },
  { key: 'materialsCost', name: 'Materials Cost', type: 'DIRECTCOSTS', code: '5010' },
  { key: 'subLabor', name: 'Subcontractor Labor', type: 'DIRECTCOSTS', code: '5020' },
  { key: 'permits', name: 'Permits & Dumpsters', type: 'DIRECTCOSTS', code: '5030' },
  { key: 'cardFees', name: 'Card Processing Fees', type: 'EXPENSE', code: '6010' },
];

function getXeroConfig() {
  // Trim stray spaces/newlines/quotes picked up when pasting into Secret Manager.
  const clean = v => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
  const clientId = clean(process.env.XERO_CLIENT_ID);
  const clientSecret = clean(process.env.XERO_CLIENT_SECRET);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: XERO_REDIRECT_URI };
}
function xeroBasicAuth(cfg) {
  return 'Basic ' + Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64');
}
function xeroRef(companyId) {
  return admin.firestore().collection('companies').doc(companyId).collection('xeroTokens').doc('connection');
}
function xeroStatusRef(companyId) {
  return admin.firestore().collection('companies').doc(companyId).collection('settings').doc('xero');
}
function xeroPage(title, msg, ok) {
  return `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;text-align:center;padding:60px 20px"><h2>${ok ? '✅' : '⚠️'} ${title}</h2><p>${msg}</p><p style="color:#666">You can close this tab and go back to JOBSMETRIX.</p></body></html>`;
}

exports.xeroOAuthStart = functions.runWith({ secrets: XERO_SECRETS }).https.onRequest(async (req, res) => {
  const cfg = getXeroConfig();
  if (!cfg) { res.status(500).send(xeroPage('Xero is not set up yet', 'XERO_CLIENT_ID / XERO_CLIENT_SECRET are missing from Secret Manager.', false)); return; }
  const idToken = req.query.token;
  const companyId = req.query.companyId;
  if (!idToken || !companyId) { res.status(400).send('Missing token or companyId'); return; }
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(String(idToken)); }
  catch (e) { res.status(401).send(xeroPage('Session expired', 'Reload JOBSMETRIX and try again.', false)); return; }
  if (decoded.companyId !== companyId) { res.status(403).send('You are not a member of this company.'); return; }
  if (!isQboFullAccess(decoded)) { res.status(403).send(xeroPage('Not allowed', 'Only Owner, Project Manager, or Accounting can connect Xero.', false)); return; }
  const legacy = req.query.legacy === '1';
  const nonce = crypto.randomBytes(12).toString('hex');
  await xeroStatusRef(companyId).set({ pendingNonce: nonce, pendingAt: Date.now() }, { merge: true });
  const state = Buffer.from(JSON.stringify({ companyId, uid: decoded.uid, nonce, legacy })).toString('base64url');
  res.redirect(XERO_AUTH_URL + '?' + new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: legacy ? XERO_SCOPES_LEGACY : XERO_SCOPES,
    state,
  }).toString());
});

exports.xeroOAuthCallback = functions.runWith({ secrets: XERO_SECRETS }).https.onRequest(async (req, res) => {
  const cfg = getXeroConfig();
  if (!cfg) { res.status(500).send('Xero is not configured.'); return; }
  const { code, state, error, error_description } = req.query;
  if (error) {
    // Older Xero apps reject the granular scopes -- retry once with the old ones.
    let st = {};
    try { st = JSON.parse(Buffer.from(String(state || ''), 'base64url').toString('utf8')); } catch (e) {}
    if (String(error) === 'invalid_scope' && !st.legacy) {
      res.send(xeroPage('One more step', 'Xero asked for the older permission names. Close this tab and click Connect Xero again — it will use them automatically.', false));
      await xeroStatusRef(st.companyId || '_').set({ useLegacyScopes: true }, { merge: true }).catch(() => {});
      return;
    }
    res.status(400).send(xeroPage('Xero did not connect', esc0(String(error_description || error)), false));
    return;
  }
  if (!code || !state) { res.status(400).send('Missing code/state from Xero.'); return; }
  let parsed;
  try { parsed = JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8')); }
  catch (e) { res.status(400).send('Invalid state.'); return; }
  const { companyId, uid, nonce } = parsed;
  try {
    const st = await xeroStatusRef(companyId).get();
    if (!st.exists || st.data().pendingNonce !== nonce) { res.status(400).send(xeroPage('Link expired', 'Start again from Settings → Xero.', false)); return; }
    const tokenResp = await fetch(XERO_TOKEN_URL, {
      method: 'POST',
      headers: { 'Authorization': xeroBasicAuth(cfg), 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: String(code), redirect_uri: cfg.redirectUri }).toString(),
    });
    const tokens = await tokenResp.json();
    if (!tokenResp.ok || !tokens.refresh_token) {
      console.error('xeroOAuthCallback token exchange failed:', tokens);
      res.status(500).send(xeroPage('Xero did not return a connection', 'Close this tab and try again.', false));
      return;
    }
    const connResp = await fetch(XERO_CONNECTIONS_URL, { headers: { 'Authorization': 'Bearer ' + tokens.access_token, 'Accept': 'application/json' } });
    const conns = await connResp.json();
    const orgs = (Array.isArray(conns) ? conns : []).filter(c => c.tenantType === 'ORGANISATION');
    if (!orgs.length) { res.status(400).send(xeroPage('No Xero organisation', 'Pick your organisation on the Xero screen when connecting.', false)); return; }
    // Most recently authorised organisation wins (the one just picked).
    orgs.sort((a, b) => String(b.updatedDateUtc || '').localeCompare(String(a.updatedDateUtc || '')));
    const org = orgs[0];
    await xeroRef(companyId).set({
      accessToken: tokens.access_token,
      refreshTokenEncrypted: encryptSecret(tokens.refresh_token),
      expiresAt: Date.now() + (tokens.expires_in * 1000),
      tenantId: org.tenantId,
      tenantName: org.tenantName || '',
      connectedByUid: uid,
      connectedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await xeroStatusRef(companyId).set({
      connected: true,
      tenantName: org.tenantName || '',
      connectedAt: admin.firestore.FieldValue.serverTimestamp(),
      pendingNonce: admin.firestore.FieldValue.delete(),
      lastError: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    res.send(xeroPage('Xero connected', 'Connected to <b>' + esc0(org.tenantName || 'your organisation') + '</b>. Back in JOBSMETRIX, click <b>Set up accounts</b> once.', true));
  } catch (e) {
    console.error('xeroOAuthCallback error:', e.message);
    res.status(500).send(xeroPage('Error connecting Xero', esc0(e.message), false));
  }
});
function esc0(s) { return String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

function xeroCallableGuard(data, context, needFull) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const companyId = data && data.companyId;
  if (!companyId || context.auth.token.companyId !== companyId) throw new functions.https.HttpsError('permission-denied', 'Not a member of this company.');
  if (needFull && !isQboFullAccess(context.auth.token)) throw new functions.https.HttpsError('permission-denied', 'Only Owner, Project Manager, or Accounting can do this.');
  return companyId;
}

exports.xeroDisconnect = functions.runWith({ secrets: XERO_SECRETS }).https.onCall(async (data, context) => {
  const companyId = xeroCallableGuard(data, context, true);
  const cfg = getXeroConfig();
  const doc = await xeroRef(companyId).get();
  if (cfg && doc.exists && doc.data().refreshTokenEncrypted) {
    try {
      await fetch(XERO_REVOKE_URL, {
        method: 'POST',
        headers: { 'Authorization': xeroBasicAuth(cfg), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: decryptSecret(doc.data().refreshTokenEncrypted) }).toString(),
      });
    } catch (e) { console.warn('Xero revoke failed (continuing):', e.message); }
  }
  await xeroRef(companyId).delete();
  await xeroStatusRef(companyId).set({ connected: false }, { merge: true });
  return { disconnected: true };
});

// Access tokens last 30 minutes; refresh tokens rotate on every use, so the
// new one is always saved (a transaction keeps two refreshes from racing).
async function ensureXeroAccessToken(companyId) {
  const cfg = getXeroConfig();
  if (!cfg) throw new Error('Xero is not configured (XERO_CLIENT_ID / XERO_CLIENT_SECRET missing).');
  const ref = xeroRef(companyId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Xero is not connected yet — connect it in Settings first.');
  const d = doc.data();
  if (d.expiresAt && d.expiresAt - Date.now() > 2 * 60 * 1000) return { accessToken: d.accessToken, tenantId: d.tenantId };
  const resp = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Authorization': xeroBasicAuth(cfg), 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decryptSecret(d.refreshTokenEncrypted) }).toString(),
  });
  const tokens = await resp.json().catch(() => ({}));
  if (!resp.ok || !tokens.access_token) {
    // Another call may have just refreshed it -- re-read once before failing.
    const again = (await ref.get()).data() || {};
    if (again.expiresAt && again.expiresAt - Date.now() > 2 * 60 * 1000) return { accessToken: again.accessToken, tenantId: again.tenantId };
    console.error('Xero token refresh failed:', tokens);
    await xeroStatusRef(companyId).set({ lastError: 'Connection expired — reconnect Xero in Settings.' }, { merge: true }).catch(() => {});
    throw new Error('The Xero connection has expired or was removed — reconnect it in Settings.');
  }
  await ref.update({
    accessToken: tokens.access_token,
    refreshTokenEncrypted: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : d.refreshTokenEncrypted,
    expiresAt: Date.now() + (tokens.expires_in * 1000),
  });
  return { accessToken: tokens.access_token, tenantId: d.tenantId };
}

async function xeroFetch(companyId, method, path, body) {
  const { accessToken, tenantId } = await ensureXeroAccessToken(companyId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(XERO_API + '/' + path, {
      method,
      headers: { 'Authorization': 'Bearer ' + accessToken, 'xero-tenant-id': tenantId, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (resp.status === 429 && attempt < 2) {
      const wait = Math.min(10, Number(resp.headers.get('retry-after')) || 2);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const ve = (json.Elements || []).flatMap(e => (e.ValidationErrors || []).map(v => v.Message));
      const msg = ve.length ? ve.join('; ') : (json.Message || json.Detail || json.title || resp.statusText);
      console.error('Xero API error', { companyId, path, status: resp.status, msg });
      throw new Error('Xero: ' + msg);
    }
    return json;
  }
}
function xeroWhereStr(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function xeroDate(d) { return (d && /^\d{4}-\d{2}-\d{2}/.test(d)) ? String(d).slice(0, 10) : new Date().toISOString().slice(0, 10); }

async function xeroGetSettings(companyId) {
  const s = await xeroStatusRef(companyId).get();
  return s.exists ? s.data() : {};
}

// One-click setup: accounts, Stripe bank account, Job tracking category.
async function xeroRunSetup(companyId) {
  const existing = (await xeroFetch(companyId, 'GET', 'Accounts')).Accounts || [];
  const usedCodes = new Set(existing.map(a => String(a.Code || '')).filter(Boolean));
  const accounts = {};
  const created = [];
  for (const spec of XERO_ACCOUNTS) {
    let a = existing.find(x => String(x.Name || '').trim().toLowerCase() === spec.name.toLowerCase() && x.Status !== 'ARCHIVED');
    if (!a) {
      let code = Number(spec.code);
      while (usedCodes.has(String(code))) code++;
      const r = await xeroFetch(companyId, 'PUT', 'Accounts', { Code: String(code), Name: spec.name, Type: spec.type });
      a = (r.Accounts || [])[0];
      usedCodes.add(String(code));
      created.push(spec.name + ' (' + code + ')');
    }
    accounts[spec.key] = { id: a.AccountID, code: a.Code, name: a.Name };
  }
  // Card payments land in a "Stripe" bank account; Stripe's payouts to the
  // real bank are then a transfer, and its fees an expense -- the standard
  // way to keep card money matching to the cent.
  let stripeBank = existing.find(x => x.Type === 'BANK' && /stripe/i.test(x.Name || '') && x.Status !== 'ARCHIVED');
  if (!stripeBank) {
    try {
      const r = await xeroFetch(companyId, 'PUT', 'Accounts', { Name: 'Stripe', Type: 'BANK', BankAccountNumber: 'STRIPE', CurrencyCode: 'USD' });
      stripeBank = (r.Accounts || [])[0];
      created.push('Stripe (bank account)');
    } catch (e) {
      const r = await xeroFetch(companyId, 'PUT', 'Accounts', { Name: 'Stripe', Type: 'BANK', BankAccountNumber: 'STRIPE' });
      stripeBank = (r.Accounts || [])[0];
      created.push('Stripe (bank account)');
    }
  }
  accounts.stripeBank = { id: stripeBank.AccountID, code: stripeBank.Code || '', name: stripeBank.Name };
  const banks = existing.filter(x => x.Type === 'BANK' && x.Status !== 'ARCHIVED' && x.AccountID !== stripeBank.AccountID)
    .map(x => ({ id: x.AccountID, name: x.Name, code: x.Code || '' }));
  const cur = await xeroGetSettings(companyId);
  const depositBank = (cur.depositBank && banks.find(b => b.id === cur.depositBank.id)) || banks[0] || null;

  const tcs = (await xeroFetch(companyId, 'GET', 'TrackingCategories')).TrackingCategories || [];
  let tc = tcs.find(t => String(t.Name).toLowerCase() === 'job');
  if (!tc) {
    if (tcs.length >= 2) throw new Error('Xero allows 2 tracking categories and both are used — rename one to "Job" in Xero, then run Set up again.');
    const r = await xeroFetch(companyId, 'PUT', 'TrackingCategories', { Name: 'Job' });
    tc = (r.TrackingCategories || [])[0];
    created.push('Job tracking category');
  }
  await xeroStatusRef(companyId).set({
    setupDone: true, setupAt: Date.now(), accounts, banks, depositBank,
    tracking: { id: tc.TrackingCategoryID, name: tc.Name },
  }, { merge: true });
  return { created, accounts, banks, depositBank };
}

exports.xeroSetup = functions.runWith({ secrets: XERO_SECRETS, timeoutSeconds: 120 }).https.onCall(async (data, context) => {
  const companyId = xeroCallableGuard(data, context, true);
  try {
    if (data.depositBankId) {
      const s = await xeroGetSettings(companyId);
      const b = (s.banks || []).find(x => x.id === data.depositBankId);
      if (!b) throw new Error('That bank account is not in Xero.');
      await xeroStatusRef(companyId).set({ depositBank: b }, { merge: true });
      return { depositBank: b };
    }
    return await xeroRunSetup(companyId);
  } catch (e) {
    console.error('xeroSetup failed:', e.message);
    throw new functions.https.HttpsError('internal', e.message);
  }
});

function xeroJobLabel(job, jobId) {
  const num = String(job.jobNumber || '').trim();
  const street = String(job.address || '').split(',')[0].trim();
  let label = num || street || String(job.name || jobId);
  if (num && street && !num.toLowerCase().includes(street.toLowerCase())) label = num + ' ' + street;
  return label.slice(0, 100);
}

// Makes sure the job has an active option under the "Job" tracking
// category; returns the tracking array for invoice/expense lines.
async function xeroJobTracking(companyId, settings, jobRef, job) {
  if (!settings.tracking || !settings.tracking.id) return [];
  if (job.xeroTrackingOption && job.xeroTrackingCategoryId === settings.tracking.id) {
    return [{ Name: settings.tracking.name, Option: job.xeroTrackingOption }];
  }
  const label = xeroJobLabel(job, jobRef.id);
  const r = await xeroFetch(companyId, 'GET', 'TrackingCategories/' + settings.tracking.id + '?includeArchived=true');
  const tc = (r.TrackingCategories || [])[0] || {};
  let opt = (tc.Options || []).find(o => String(o.Name).toLowerCase() === label.toLowerCase());
  if (!opt) {
    const c = await xeroFetch(companyId, 'PUT', 'TrackingCategories/' + settings.tracking.id + '/Options', { Name: label });
    opt = (c.Options || [])[0];
  } else if (opt.Status === 'ARCHIVED') {
    await xeroFetch(companyId, 'POST', 'TrackingCategories/' + settings.tracking.id + '/Options/' + opt.TrackingOptionID, { Name: opt.Name, Status: 'ACTIVE' }).catch(() => {});
  }
  await jobRef.update({ xeroTrackingOption: opt.Name, xeroTrackingCategoryId: settings.tracking.id }).catch(() => {});
  return [{ Name: settings.tracking.name, Option: opt.Name }];
}

async function xeroEnsureContact(companyId, jobRef, job) {
  if (job.xeroContactId) return job.xeroContactId;
  const name = String(job.client || job.name || 'Customer').trim();
  const email = String(job.email || job.clientEmail || '').trim();
  const found = await xeroFetch(companyId, 'GET', 'Contacts?where=' + encodeURIComponent(`Name=="${xeroWhereStr(name)}"`));
  let c = (found.Contacts || []).find(x => x.ContactStatus !== 'ARCHIVED');
  if (!c) {
    const body = { Name: name };
    if (email) body.EmailAddress = email;
    if (job.phone) body.Phones = [{ PhoneType: 'MOBILE', PhoneNumber: String(job.phone) }];
    if (job.address) body.Addresses = [{ AddressType: 'STREET', AddressLine1: String(job.address).slice(0, 500) }];
    const r = await xeroFetch(companyId, 'PUT', 'Contacts', body);
    c = (r.Contacts || [])[0];
  }
  await jobRef.update({ xeroContactId: c.ContactID }).catch(() => {});
  return c.ContactID;
}

// Splits each invoice line into labor and materials by the job's labor
// share (saved on the job by the app from the same margin formula the
// header bar uses). Lines always add up to the invoice total exactly.
function xeroInvoiceLines(inv, job, settings, tracking) {
  const acc = settings.accounts || {};
  // Default: the customer sees the invoice exactly as written in JOBSMETRIX,
  // one Xero line per invoice line, all to Job Income. The labor/materials
  // split stays in JOBSMETRIX (Job Margin Sheet). Splitting in Xero is an
  // opt-in setting (settings/xero.splitLines).
  if (!settings.splitLines) {
    const total0 = round2(inv.total);
    let src0 = Array.isArray(inv.lineItems) ? inv.lineItems.filter(l => l && (Number(l.qty) || 0) * (Number(l.rate) || 0) !== 0) : [];
    const sum0 = round2(src0.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0));
    if (!src0.length || Math.abs(sum0 - total0) > 0.01) src0 = [{ desc: inv.type ? (inv.type + ' — ' + (job.address || job.name || '')) : (job.address || job.name || 'Invoice'), qty: 1, rate: total0 }];
    const code = (acc.jobIncome || acc.laborIncome || {}).code;
    return src0.map(l => ({ Description: String(l.desc || l.description || 'Work').slice(0, 3900), Quantity: Number(l.qty) || 1, UnitAmount: round2(Number(l.rate) || 0), AccountCode: code, Tracking: tracking }));
  }
  const share = Math.max(0, Math.min(1, Number(job.xeroLaborShare)));
  const hasShare = isFinite(Number(job.xeroLaborShare)) && job.xeroLaborShare !== null && job.xeroLaborShare !== undefined && job.xeroLaborShare !== '';
  const total = round2(inv.total);
  let src = Array.isArray(inv.lineItems) ? inv.lineItems.filter(l => l && (Number(l.qty) || 0) * (Number(l.rate) || 0) !== 0) : [];
  const srcSum = round2(src.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0));
  if (!src.length || Math.abs(srcSum - total) > 0.01) src = [{ desc: inv.type ? (inv.type + ' — ' + (job.address || job.name || '')) : (job.address || job.name || 'Invoice'), qty: 1, rate: total }];
  const lines = [];
  src.forEach(l => {
    const amt = round2((Number(l.qty) || 0) * (Number(l.rate) || 0));
    const desc = String(l.desc || l.description || 'Work').slice(0, 3900);
    // Lines that say what they are (change order lines carry costType) go
    // straight to the matching income account -- no split needed.
    if (l.costType) {
      const isLabor = /labor|labour|sub/i.test(String(l.costType));
      const a = isLabor ? acc.laborIncome : acc.materialsIncome;
      lines.push({ Description: desc, Quantity: 1, UnitAmount: amt, AccountCode: a && a.code, Tracking: tracking });
      return;
    }
    if (!hasShare) {
      lines.push({ Description: desc, Quantity: 1, UnitAmount: amt, AccountCode: acc.laborIncome && acc.laborIncome.code, Tracking: tracking });
      return;
    }
    const labor = round2(amt * share);
    const mat = round2(amt - labor);
    if (labor) lines.push({ Description: desc + ' — labor', Quantity: 1, UnitAmount: labor, AccountCode: acc.laborIncome && acc.laborIncome.code, Tracking: tracking });
    if (mat) lines.push({ Description: desc + ' — materials', Quantity: 1, UnitAmount: mat, AccountCode: acc.materialsIncome && acc.materialsIncome.code, Tracking: tracking });
  });
  return lines;
}

// Creates or updates the Xero invoice for one JOBSMETRIX invoice, then
// applies any payment JOBSMETRIX has recorded that Xero doesn't have yet,
// plus the Stripe fee for it. Safe to call again and again.
async function syncInvoiceToXero(companyId, jobId, invoiceId) {
  const settings = await xeroGetSettings(companyId);
  if (!settings.connected) throw new Error('Xero is not connected.');
  if (!settings.setupDone) throw new Error('Run Set up accounts in Settings → Xero first.');
  const db = admin.firestore();
  const jobRef = db.collection('companies').doc(companyId).collection('jobs').doc(jobId);
  const invRef = jobRef.collection('invoices').doc(invoiceId);
  const [jobDoc, invDoc] = await Promise.all([jobRef.get(), invRef.get()]);
  if (!jobDoc.exists || !invDoc.exists) throw new Error('Job or invoice not found.');
  const job = jobDoc.data();
  let inv = invDoc.data();
  if (inv.status === 'Void') return { skipped: 'void' };
  if (!(Number(inv.total) > 0)) throw new Error('Invoice total is $0.');

  // Job Income account (added after first setup) -- make it on first use.
  if (!settings.splitLines && !(settings.accounts && settings.accounts.jobIncome)) {
    const existing = (await xeroFetch(companyId, 'GET', 'Accounts')).Accounts || [];
    let a = existing.find(x => String(x.Name || '').trim().toLowerCase() === 'job income' && x.Status !== 'ARCHIVED');
    if (!a) {
      const used = new Set(existing.map(x => String(x.Code || '')));
      let code = 4000; while (used.has(String(code))) code++;
      a = ((await xeroFetch(companyId, 'PUT', 'Accounts', { Code: String(code), Name: 'Job Income', Type: 'REVENUE' })).Accounts || [])[0];
    }
    settings.accounts = { ...(settings.accounts || {}), jobIncome: { id: a.AccountID, code: a.Code, name: a.Name } };
    await xeroStatusRef(companyId).set({ accounts: settings.accounts }, { merge: true });
  }
  const contactId = await xeroEnsureContact(companyId, jobRef, job);
  const tracking = await xeroJobTracking(companyId, settings, jobRef, job);
  const lines = xeroInvoiceLines(inv, job, settings, tracking);
  const base = {
    Type: 'ACCREC',
    Contact: { ContactID: contactId },
    Date: xeroDate(inv.date),
    DueDate: xeroDate(inv.dueDate || inv.date),
    LineAmountTypes: 'NoTax',
    Reference: String(job.jobNumber || job.address || '').slice(0, 255),
    LineItems: lines,
    Status: 'AUTHORISED',
  };
  if (inv.number) base.InvoiceNumber = String(inv.number).slice(0, 255);

  let x = null;
  if (inv.xeroInvoiceId) {
    const cur = ((await xeroFetch(companyId, 'GET', 'Invoices/' + inv.xeroInvoiceId)).Invoices || [])[0];
    if (cur && (cur.Status === 'VOIDED' || cur.Status === 'DELETED')) {
      x = null; // voided in Xero -- make a fresh one below
    } else if (cur && !(Number(cur.AmountPaid) > 0) && !(Number(cur.AmountCredited) > 0) && Math.abs(round2(cur.Total) - round2(inv.total)) > 0.009) {
      x = ((await xeroFetch(companyId, 'POST', 'Invoices/' + inv.xeroInvoiceId, { InvoiceID: inv.xeroInvoiceId, ...base })).Invoices || [])[0];
    } else {
      x = cur;
    }
  }
  if (!x) {
    // Same number already in Xero (made by hand)? Link to it instead of a duplicate.
    if (inv.number) {
      const f = await xeroFetch(companyId, 'GET', 'Invoices?InvoiceNumbers=' + encodeURIComponent(String(inv.number)));
      x = (f.Invoices || []).find(i => i.Type === 'ACCREC' && i.Status !== 'VOIDED' && i.Status !== 'DELETED') || null;
    }
    if (!x) x = ((await xeroFetch(companyId, 'PUT', 'Invoices', base)).Invoices || [])[0];
  }
  if (!x || !x.InvoiceID) throw new Error('Xero did not return an invoice.');

  let onlineUrl = inv.xeroOnlineUrl || '';
  if (!onlineUrl) {
    try {
      const o = await xeroFetch(companyId, 'GET', 'Invoices/' + x.InvoiceID + '/OnlineInvoice');
      onlineUrl = ((o.OnlineInvoices || [])[0] || {}).OnlineInvoiceUrl || '';
    } catch (e) { console.warn('Xero online invoice link:', e.message); }
  }
  const upd = { xeroInvoiceId: x.InvoiceID, xeroInvoiceNumber: x.InvoiceNumber || '', xeroSyncedAt: Date.now() };
  if (onlineUrl) upd.xeroOnlineUrl = onlineUrl;
  await invRef.update(upd);

  // Payments JOBSMETRIX knows about that Xero doesn't.
  inv = (await invRef.get()).data();
  const amtPaid = round2(inv.amtPaid);
  const synced = round2(inv.xeroLastSyncedAmtPaid);
  let paymentPushed = 0;
  if (amtPaid > synced + 0.009) {
    const fresh = ((await xeroFetch(companyId, 'GET', 'Invoices/' + x.InvoiceID)).Invoices || [])[0] || x;
    const due = round2(fresh.AmountDue);
    const xPaid = round2(fresh.AmountPaid);
    // Xero already shows at least this much paid (paid on Xero's page) -- just catch up the marker.
    const delta = Math.min(round2(amtPaid - Math.max(synced, xPaid)), due);
    if (delta > 0.009) {
      const isCard = /stripe|card/i.test(String(inv.paymentMethod || inv.payMethod || ''));
      const acct = isCard ? (settings.accounts && settings.accounts.stripeBank) : settings.depositBank;
      if (!acct || !acct.id) throw new Error('Pick the bank account checks and cash go to (Settings → Xero).');
      await xeroFetch(companyId, 'PUT', 'Payments', {
        Invoice: { InvoiceID: x.InvoiceID },
        Account: { AccountID: acct.id },
        Date: xeroDate(inv.paidDate),
        Amount: delta,
        Reference: ('JOBSMETRIX ' + (inv.paymentMethod || inv.payMethod || '')).trim().slice(0, 255),
      });
      paymentPushed = delta;
    }
    await invRef.update({ xeroLastSyncedAmtPaid: Math.max(amtPaid, synced) });
  }

  // Stripe fees taken on this invoice -> Card Processing Fees, out of the Stripe bank account.
  const fee = round2(inv.stripeFeeTotal);
  const feeSynced = round2(inv.xeroLastSyncedFee);
  if (fee > feeSynced + 0.009 && settings.accounts && settings.accounts.stripeBank && settings.accounts.cardFees) {
    const feeDelta = round2(fee - feeSynced);
    await xeroFetch(companyId, 'PUT', 'BankTransactions', {
      Type: 'SPEND',
      Contact: { Name: 'Stripe' },
      BankAccount: { AccountID: settings.accounts.stripeBank.id },
      Date: xeroDate(inv.paidDate),
      Reference: ('Card fee ' + (inv.number || '')).trim(),
      LineAmountTypes: 'NoTax',
      LineItems: [{ Description: 'Stripe fee — ' + (inv.number || '') + ' ' + (job.address || ''), Quantity: 1, UnitAmount: feeDelta, AccountCode: settings.accounts.cardFees.code, Tracking: tracking }],
    });
    await invRef.update({ xeroLastSyncedFee: fee });
  }
  return { success: true, xeroInvoiceId: x.InvoiceID, number: x.InvoiceNumber || '', onlineUrl, paymentPushed };
}

exports.xeroPushInvoice = functions.runWith({ secrets: XERO_SECRETS, timeoutSeconds: 120 }).https.onCall(async (data, context) => {
  const companyId = xeroCallableGuard(data, context, true);
  const { jobId, invoiceId, laborShare } = data || {};
  if (!jobId || !invoiceId) throw new functions.https.HttpsError('invalid-argument', 'Missing jobId/invoiceId.');
  try {
    if (laborShare !== undefined && laborShare !== null && isFinite(Number(laborShare)) && Number(laborShare) >= 0 && Number(laborShare) <= 1) {
      await admin.firestore().collection('companies').doc(companyId).collection('jobs').doc(jobId)
        .update({ xeroLaborShare: Math.round(Number(laborShare) * 10000) / 10000 });
    }
    return await syncInvoiceToXero(companyId, jobId, invoiceId);
  } catch (e) {
    console.error('xeroPushInvoice failed:', e.message);
    throw new functions.https.HttpsError('internal', e.message);
  }
});

// Payments made on Xero's own pay page (or entered in Xero by hand) come
// back into JOBSMETRIX.
async function pullXeroPayments(companyId) {
  const db = admin.firestore();
  const jobsSnap = await db.collection('companies').doc(companyId).collection('jobs').get();
  const targets = [];
  await Promise.all(jobsSnap.docs.map(async jd => {
    const job = jd.data();
    if (job.status === 'Closed Lost') return;
    const invSnap = await jd.ref.collection('invoices').where('xeroInvoiceId', '>', '').get().catch(() => null);
    if (!invSnap) return;
    invSnap.forEach(d => {
      const inv = d.data();
      if (!inv.xeroInvoiceId || inv.status === 'Paid' || inv.status === 'Void') return;
      if (round2(inv.total) - round2(inv.amtPaid) <= 0.009) return;
      targets.push({ jobRef: jd.ref, jobId: jd.id, job, invRef: d.ref, invId: d.id, inv });
    });
  }));
  const updated = [];
  for (let i = 0; i < targets.length; i += 40) {
    const chunk = targets.slice(i, i + 40);
    const r = await xeroFetch(companyId, 'GET', 'Invoices?IDs=' + chunk.map(t => t.inv.xeroInvoiceId).join(','));
    const byId = {};
    (r.Invoices || []).forEach(x => { byId[x.InvoiceID] = x; });
    for (const t of chunk) {
      const x = byId[t.inv.xeroInvoiceId];
      if (!x) continue;
      const paidInXero = round2(x.AmountPaid) + round2(x.AmountCredited);
      const had = round2(t.inv.amtPaid);
      if (paidInXero <= had + 0.009) continue;
      const total = round2(t.inv.total);
      const newPaid = Math.min(total || paidInXero, paidInXero);
      const amountNow = round2(newPaid - had);
      const full = newPaid >= total - 0.009;
      const today = new Date().toISOString().split('T')[0];
      const lastPay = (x.Payments || []).map(p => String(p.Date || '')).sort().pop() || '';
      const m = /\/Date\((\d+)/.exec(lastPay);
      const paidDate = m ? new Date(Number(m[1])).toISOString().split('T')[0] : today;
      const upd = {
        amtPaid: newPaid,
        xeroLastSyncedAmtPaid: Math.max(round2(t.inv.xeroLastSyncedAmtPaid), newPaid),
        status: full ? 'Paid' : 'Partial',
        paymentMethod: 'Xero',
        xeroPaymentPulledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (full) upd.paidDate = paidDate;
      await t.invRef.update(upd);
      const amtStr = amountNow.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      await t.jobRef.collection('logs').add({
        date: today,
        notes: `Invoice ${t.inv.number || ''} ${full ? 'paid' : 'partly paid'} (Xero) — $${amtStr}`.replace('  ', ' '),
        type: 'invoice_paid', userName: 'Xero (auto)', companyId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
      if (QBO_PULL_EARLY_STATUSES.includes(t.job.status)) {
        await t.jobRef.update({ status: 'To Be Scheduled', statusDate: today, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: 'Xero (auto)' }).catch(() => {});
        await t.jobRef.collection('logs').add({
          date: today, notes: 'Deposit received — moved to To Be Scheduled', type: 'status_change',
          userName: 'Xero (auto)', companyId, createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
        t.job.status = 'To Be Scheduled';
      }
      updated.push({ jobId: t.jobId, invoiceId: t.invId, number: t.inv.number || '', jobName: t.job.address || t.job.name || '', amount: amountNow, full });
    }
  }
  await xeroStatusRef(companyId).set({ lastPaymentPullAt: Date.now(), lastPaymentPullChecked: targets.length }, { merge: true }).catch(() => {});
  return { checked: targets.length, updated };
}

exports.xeroSyncPayments = functions.runWith({ secrets: XERO_SECRETS, timeoutSeconds: 120 }).https.onCall(async (data, context) => {
  const companyId = xeroCallableGuard(data, context, false);
  const s = await xeroGetSettings(companyId);
  if (!s.connected) return { checked: 0, updated: [], notConnected: true };
  try { return await pullXeroPayments(companyId); }
  catch (e) { console.error('xeroSyncPayments failed:', e.message); throw new functions.https.HttpsError('internal', e.message); }
});

exports.xeroPaymentPullScheduled = functions.runWith({ secrets: XERO_SECRETS, timeoutSeconds: 300 }).pubsub
  .schedule('every 30 minutes').onRun(async () => {
    const companies = await admin.firestore().collection('companies').get();
    for (const c of companies.docs) {
      try {
        const s = await xeroGetSettings(c.id);
        if (!s.connected) continue;
        const r = await pullXeroPayments(c.id);
        if (r.updated.length) console.log('Xero payments pulled', c.id, r.updated.length);
      } catch (e) { console.error('Xero scheduled pull failed for', c.id, e.message); }
    }
    return null;
  });

// XERO_V1: a change order the customer approves (in the app, from the
// Change Orders page, or by signing in the portal) gets its own invoice right
// away -- same lines, its own number -- and that invoice goes to Xero.
// Credits (negative change orders) are left for the owner to handle.
const CO_APPROVED = ['Customer Approved', 'Approved'];
exports.changeOrderAutoInvoice = functions.runWith({ secrets: ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET'], timeoutSeconds: 120 }).firestore
  .document('companies/{companyId}/jobs/{jobId}/changeorders/{coId}')
  .onWrite(async (change, context) => {
    const { companyId, jobId, coId } = context.params;
    if (!change.after.exists) return null;
    const before = change.before.exists ? change.before.data() : {};
    const after = change.after.data();
    if (!CO_APPROVED.includes(after.status) || CO_APPROVED.includes(before.status)) return null;
    if (after.invoiceId || after.appliedToEstimate || after.autoInvoiceStartedAt) return null;
    const amount = round2(after.amount);
    if (!(amount > 0)) return null;
    const db = admin.firestore();
    const jobRef = db.collection('companies').doc(companyId).collection('jobs').doc(jobId);
    const coRef = change.after.ref;
    // Claim it once, so a retry or a second write can't make two invoices.
    const claimed = await db.runTransaction(async tx => {
      const s = await tx.get(coRef);
      const d = s.data() || {};
      if (d.invoiceId || d.autoInvoiceStartedAt) return false;
      tx.update(coRef, { autoInvoiceStartedAt: Date.now() });
      return true;
    });
    if (!claimed) return null;
    const jobDoc = await jobRef.get();
    const job = jobDoc.exists ? jobDoc.data() : {};
    const invSnap = await jobRef.collection('invoices').get();
    const used = new Set(invSnap.docs.map(d => String(d.data().number || '')));
    const base = String(job.jobNumber || 'INV');
    let n = invSnap.docs.length + 1, number;
    do { number = base + '-' + String(n).padStart(3, '0'); n++; } while (used.has(number));
    const items = (Array.isArray(after.lineItems) && after.lineItems.length)
      ? after.lineItems.map(li => ({ desc: li.desc || after.title || 'Change order', qty: Number(li.qty) || 1, rate: Number(li.unitPrice) || 0, costType: li.costType || '' }))
      : [{ desc: 'Change Order: ' + (after.title || ''), qty: 1, rate: amount }];
    const sum = round2(items.reduce((s, l) => s + l.qty * l.rate, 0));
    const lineItems = Math.abs(sum - amount) <= 0.01 ? items : [{ desc: 'Change Order: ' + (after.title || ''), qty: 1, rate: amount }];
    const today = new Date().toISOString().split('T')[0];
    const due = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
    const invRef = await jobRef.collection('invoices').add({
      number, type: 'Change Order', date: today, dueDate: due, status: 'Draft',
      lineItems, subtotal: amount, taxRate: 0, taxAmt: 0, total: amount, amtPaid: 0,
      paidDate: '', payMethod: '', paymentLink: '',
      notes: 'Change Order: ' + (after.title || '') + (after.reason ? ' — ' + after.reason : ''),
      changeOrderId: coId, companyId, autoCreated: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: 'Change order approval (auto)',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await coRef.update({ status: 'Invoiced', invoiceId: invRef.id, approvedStatus: after.status, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    const amtStr = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let xeroNote = '';
    try {
      const s = await xeroGetSettings(companyId);
      if (s.connected && s.setupDone) { const r = await syncInvoiceToXero(companyId, jobId, invRef.id); xeroNote = ' and sent to Xero' + (r && r.number ? ' (' + r.number + ')' : ''); }
    } catch (e) { xeroNote = ' — could not send to Xero: ' + e.message; console.error('CO auto-invoice Xero push failed:', e.message); }
    await jobRef.collection('logs').add({
      date: today, type: 'invoice_created', userName: 'Change order (auto)', companyId,
      notes: `Change order approved — invoice ${number} created for $${amtStr}${xeroNote}. Email it from the Invoices tab.`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    return null;
  });

// Called by the Stripe webhook after a card payment is recorded.
async function xeroAfterPayment(companyId, jobId, invoiceId) {
  try {
    const s = await xeroGetSettings(companyId);
    if (!s.connected || !s.setupDone) return;
    await syncInvoiceToXero(companyId, jobId, invoiceId);
  } catch (e) {
    console.error('Xero sync after payment failed (payment still recorded in JOBSMETRIX):', e.message);
  }
}

// ════════════════════════════════════════════════════
// ── Stripe payment link + webhook ────────────────────
// Replaces QuickBooks Payments as the customer-facing payment
// processor. Money goes Stripe -> Bluevine directly (payout bank
// account is a Stripe Dashboard setting, not something this code
// controls) instead of routing through QuickBooks Checking/Green Dot.
// QBO connection is untouched - still used for bookkeeping via
// syncInvoiceToQbo() above, now triggered by the Stripe webhook
// instead of only the manual "Push to QuickBooks" button.
// ════════════════════════════════════════════════════

// Callable - creates a Stripe Checkout Session for whatever balance is
// still owed on this invoice (total - amtPaid), stores the resulting
// URL in the existing `paymentLink` field (already the field the
// client prioritizes over qbPaymentLink everywhere - see
// kytrac-app.js's "Pay Now" button logic), so no client/email changes
// are needed at all to start using it.
exports.createStripePaymentLink = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const { companyId, jobId, invoiceId } = data;
  if (!companyId || !jobId || !invoiceId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing companyId/jobId/invoiceId.');
  }
  if (context.auth.token.companyId !== companyId) {
    throw new functions.https.HttpsError('permission-denied', 'Not a member of this company.');
  }

  const db = admin.firestore();
  const jobRef = db.collection('companies').doc(companyId).collection('jobs').doc(jobId);
  const invRef = jobRef.collection('invoices').doc(invoiceId);
  const [jobDoc, invDoc] = await Promise.all([jobRef.get(), invRef.get()]);
  if (!jobDoc.exists) throw new functions.https.HttpsError('not-found', 'Job not found.');
  if (!invDoc.exists) throw new functions.https.HttpsError('not-found', 'Invoice not found.');
  const job = jobDoc.data();
  const inv = invDoc.data();

  const total = inv.total || 0;
  const amtPaid = inv.amtPaid || 0;
  const balance = Math.round((total - amtPaid) * 100) / 100;
  if (balance <= 0) {
    throw new functions.https.HttpsError('failed-precondition', 'This invoice has no remaining balance.');
  }

  try {
    const stripe = await getStripeClientForCompany(companyId);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'us_bank_account'],
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(balance * 100), // Stripe uses cents
          product_data: {
            name: (job.name || 'Invoice') + ' - Invoice',
            description: 'Invoice #' + invoiceId.slice(-6).toUpperCase()
          }
        },
        quantity: 1
      }],
      // Metadata is how the webhook finds its way back to the right
      // invoice doc - Stripe echoes this back untouched on every event.
      metadata: { companyId, jobId, invoiceId },
      // Also stamp the same metadata onto the PaymentIntent Stripe
      // creates automatically for this session -- payment_intent.
      // succeeded/payment_intent.payment_failed events carry the
      // PaymentIntent as their payload, not the Checkout Session, so
      // without this those events would have no way back to this
      // invoice. Needed specifically for delayed-settlement methods
      // like ACH (us_bank_account above): checkout.session.completed
      // fires the moment the customer submits their bank details, but
      // the money doesn't actually land for several business days --
      // these two events are what tell us it genuinely cleared or
      // bounced, days later.
      payment_intent_data: { metadata: { companyId, jobId, invoiceId } },
      success_url: 'https://jobsmetrix.com/?paid=1&invoice=' + invoiceId,
      cancel_url: 'https://jobsmetrix.com/?paid=0&invoice=' + invoiceId,
    });

    await invRef.update({
      paymentLink: session.url,
      stripeCheckoutSessionId: session.id,
      stripeCheckoutSessionCreatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, url: session.url };
  } catch (e) {
    console.error('createStripePaymentLink failed:', e.message);
    throw new functions.https.HttpsError('internal', e.message);
  }
});

// Deploy trigger: this comment forces a functions/** change so the new
// firebase-functions-deploy.yml workflow's path filter fires and
// actually ships createStripePaymentLinkForCO + the CO webhook routing.
exports.createStripePaymentLinkForCO = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  const { companyId, jobId, coId } = data;
  if (!companyId || !jobId || !coId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing companyId/jobId/coId.');
  }
  if (context.auth.token.companyId !== companyId) {
    throw new functions.https.HttpsError('permission-denied', 'Not a member of this company.');
  }

  const db = admin.firestore();
  const jobRef = db.collection('companies').doc(companyId).collection('jobs').doc(jobId);
  // NOTE: the change order subcollection is 'changeorders' (all lowercase)
  // -- this is the name actually used when change orders are created and
  // read everywhere else in the client. A handful of older client call
  // sites use the camelCase 'changeOrders' instead, which silently reads
  // an empty collection; that's a pre-existing mismatch worth fixing
  // separately, not introduced here.
  const coRef = jobRef.collection('changeorders').doc(coId);
  const [jobDoc, coDoc] = await Promise.all([jobRef.get(), coRef.get()]);
  if (!jobDoc.exists) throw new functions.https.HttpsError('not-found', 'Job not found.');
  if (!coDoc.exists) throw new functions.https.HttpsError('not-found', 'Change order not found.');
  const job = jobDoc.data();
  const co = coDoc.data();

  const total = co.amount || 0;
  const amtPaid = co.amtPaid || 0;
  const balance = Math.round((total - amtPaid) * 100) / 100;
  if (balance <= 0) {
    throw new functions.https.HttpsError('failed-precondition', 'This change order has no remaining balance.');
  }

  try {
    const stripe = await getStripeClientForCompany(companyId);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'us_bank_account'],
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(balance * 100), // Stripe uses cents
          product_data: {
            name: (job.name || 'Change Order') + ' - Change Order',
            description: (co.coNumber || 'CO') + (co.title ? ': ' + co.title : '')
          }
        },
        quantity: 1
      }],
      // Same metadata pattern as invoices, but coId instead of invoiceId
      // -- the webhook uses whichever key is present to route the event.
      metadata: { companyId, jobId, coId },
      payment_intent_data: { metadata: { companyId, jobId, coId } },
      success_url: 'https://jobsmetrix.com/?paid=1&co=' + coId,
      cancel_url: 'https://jobsmetrix.com/?paid=0&co=' + coId,
    });

    await coRef.update({
      paymentLink: session.url,
      stripeCheckoutSessionId: session.id,
      stripeCheckoutSessionCreatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, url: session.url };
  } catch (e) {
    console.error('createStripePaymentLinkForCO failed:', e.message);
    throw new functions.https.HttpsError('internal', e.message);
  }
});

// Raw HTTP endpoint - Stripe calls this directly (no Firebase Auth
// context at all), so this must verify the request really came from
// Stripe using the webhook signing secret, not rely on any auth check.
exports.stripeWebhook = functions.runWith({ secrets: ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET'] }).https.onRequest(async (req, res) => { // XERO_V1: secrets for the Xero sync after a card payment
  // Which company this event belongs to determines which webhook
  // secret verifies it -- so peek at the unverified payload first just
  // to find companyId, then verify properly with that company's own
  // secret before trusting anything else in the payload.
  let peek;
  try {
    peek = JSON.parse(req.rawBody.toString('utf8'));
  } catch (e) {
    console.error('stripeWebhook: could not parse payload:', e.message);
    return res.status(400).send('Malformed payload.');
  }
  const companyId = peek?.data?.object?.metadata?.companyId;
  if (!companyId) {
    console.error('stripeWebhook: no companyId in event metadata, cannot route it.', peek?.id);
    return res.status(200).send('No companyId in metadata, ignored.');
  }

  let stripe, webhookSecret;
  try {
    const conn = await getStripeConnection(companyId);
    if (!conn.webhookSecret) {
      console.error('stripeWebhook: company has no webhook secret configured yet:', companyId);
      return res.status(500).send('Webhook not configured for this company.');
    }
    stripe = require('stripe')(conn.secretKey);
    webhookSecret = conn.webhookSecret;
  } catch (e) {
    console.error('stripeWebhook: could not load Stripe connection for company', companyId, e.message);
    return res.status(500).send('Stripe not configured for this company.');
  }

  let event;
  try {
    // req.rawBody is provided automatically by Firebase Functions v1
    // (functions.https.onRequest) - signature verification needs the
    // exact raw bytes Stripe sent, not a re-serialized JSON body.
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], webhookSecret);
  } catch (e) {
    console.error('stripeWebhook: signature verification failed:', e.message);
    return res.status(400).send('Webhook signature verification failed.');
  }

  const handledTypes = ['checkout.session.completed', 'payment_intent.succeeded', 'payment_intent.payment_failed'];
  if (!handledTypes.includes(event.type)) {
    // Ack anything else so Stripe doesn't keep retrying events we
    // don't care about.
    return res.status(200).send('Ignored event type: ' + event.type);
  }

  if (event.type === 'checkout.session.completed') {
    return handleCheckoutSessionCompleted(event, companyId, res);
  } else if (event.type === 'payment_intent.succeeded') {
    return handlePaymentIntentSucceeded(event, companyId, res, stripe);
  } else {
    return handlePaymentIntentFailed(event, companyId, res);
  }
});

// checkout.session.completed fires the moment the customer submits
// payment -- for card payments that's effectively "it happened," but
// for delayed-settlement methods like ACH (us_bank_account) the money
// hasn't actually moved yet and won't for several business days. This
// handler deliberately does NOT touch amtPaid or mark the invoice
// Paid -- it only records that a payment attempt is in flight, so
// nothing gets counted as collected revenue (feeding the 7-bucket
// waterfall, sub-account transfers, etc.) before it's genuinely real
// money in the bank. The actual financial recording happens in
// handlePaymentIntentSucceeded below, once Stripe confirms it cleared.
async function handleCheckoutSessionCompleted(event, companyId, res) {
  const session = event.data.object;
  const { jobId, invoiceId, coId } = session.metadata || {};
  if (coId) return handleCOCheckoutSessionCompleted(session, companyId, jobId, coId, res);
  if (!jobId || !invoiceId) {
    console.error('stripeWebhook: checkout.session.completed missing metadata.', session.id);
    return res.status(200).send('Missing metadata, ignored.');
  }
  try {
    const db = admin.firestore();
    const invRef = db.collection('companies').doc(companyId)
      .collection('jobs').doc(jobId).collection('invoices').doc(invoiceId);
    const invDoc = await invRef.get();
    if (!invDoc.exists) {
      console.error('stripeWebhook: invoice not found', companyId, jobId, invoiceId);
      return res.status(200).send('Invoice not found, ignored.');
    }
    await invRef.update({
      status: 'Processing',
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: session.payment_intent || null,
      stripeCheckoutCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.status(200).send('OK - marked Processing, awaiting settlement.');
  } catch (e) {
    console.error('stripeWebhook: checkout.session.completed processing failed:', e.message);
    return res.status(500).send('Internal error.');
  }
}

// The REAL "money actually landed" event. This is where amtPaid,
// status='Paid', the real Stripe fee, the QBO sync, and the customer
// confirmation email all happen -- moved here from
// checkout.session.completed specifically so nothing downstream
// (Financials, the COO Budget waterfall, sub-account transfer
// prompts) ever treats a pending ACH transfer as collected before it
// genuinely is.
async function handlePaymentIntentSucceeded(event, companyId, res, stripe) {
  const pi = event.data.object;
  const { jobId, invoiceId, coId } = pi.metadata || {};
  if (coId) return handleCOPaymentIntentSucceeded(pi, companyId, jobId, coId, res, stripe);
  if (!jobId || !invoiceId) {
    console.error('stripeWebhook: payment_intent.succeeded missing metadata.', pi.id);
    return res.status(200).send('Missing metadata, ignored.');
  }

  try {
    const db = admin.firestore();
    const jobRef = db.collection('companies').doc(companyId).collection('jobs').doc(jobId);
    const invRef = jobRef.collection('invoices').doc(invoiceId);
    const [jobDoc, invDoc] = await Promise.all([jobRef.get(), invRef.get()]);
    if (!invDoc.exists) {
      console.error('stripeWebhook: invoice not found', companyId, jobId, invoiceId);
      return res.status(200).send('Invoice not found, ignored.');
    }
    const job = jobDoc.exists ? jobDoc.data() : {};
    const inv = invDoc.data();

    const amountPaidNow = (pi.amount_received || pi.amount || 0) / 100; // cents -> dollars
    const newAmtPaid = Math.round(((inv.amtPaid || 0) + amountPaidNow) * 100) / 100;
    const total = inv.total || 0;

    // Real Stripe processing fee for THIS specific payment, not an
    // estimated 2.9%+$0.30.
    let stripeFee = null, stripeNetAmount = null;
    try {
      const piFull = await stripe.paymentIntents.retrieve(pi.id, {
        expand: ['latest_charge.balance_transaction'],
      });
      const bt = piFull.latest_charge?.balance_transaction;
      if (bt) {
        stripeFee = Math.round(bt.fee) / 100;
        stripeNetAmount = Math.round(bt.net) / 100;
      }
    } catch (feeErr) {
      console.error('stripeWebhook: could not retrieve real fee (payment still recorded):', feeErr.message);
    }

    const update = {
      amtPaid: newAmtPaid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      stripePaymentIntentId: pi.id,
      stripeLastPaidAt: admin.firestore.FieldValue.serverTimestamp(),
      paymentMethod: 'Card / Online (Stripe)'
    };
    if (stripeFee !== null) {
      update.stripeFeeTotal = Math.round(((inv.stripeFeeTotal || 0) + stripeFee) * 100) / 100;
      update.stripeNetTotal = Math.round(((inv.stripeNetTotal || 0) + stripeNetAmount) * 100) / 100;
    }
    if (newAmtPaid >= total) {
      update.status = 'Paid';
      update.paidDate = new Date().toISOString().split('T')[0];
    }
    await invRef.update(update);

    // DEPOSIT_COL_V1 (10/22/26): a signed job waiting on its deposit moves
    // to To Be Scheduled once a payment comes in -- same forward-only
    // advance the manual Mark Paid does. Never moves a job backwards.
    if (QBO_PULL_EARLY_STATUSES.includes(job.status || '') && amountPaidNow > 0) {
      try {
        await jobRef.update({ status: 'To Be Scheduled', statusDate: new Date().toISOString().split('T')[0],
          updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: 'Stripe (auto)' });
        await jobRef.collection('logs').add({
          date: new Date().toISOString().split('T')[0], type: 'status_change', userName: 'Stripe (auto)', companyId,
          notes: `Deposit received — moved from ${job.status} to To Be Scheduled`,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (stErr) { console.error('stripeWebhook: status advance failed (non-fatal):', stErr.message); }
    }

    try {
      const amtStr = amountPaidNow.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
      const feeNote = stripeFee !== null ? ` (Stripe fee: $${stripeFee.toFixed(2)}, net $${stripeNetAmount.toFixed(2)})` : '';
      await db.collection('companies').doc(companyId)
        .collection('jobs').doc(jobId).collection('logs').add({
          date: new Date().toISOString().split('T')[0],
          notes: `Invoice ${inv.number || ''} paid — $${amtStr} (Stripe)${feeNote}`.replace('  ', ' ').trim(),
          type: 'invoice_paid',
          userName: 'Stripe (auto)',
          companyId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (logErr) {
      console.error('stripeWebhook: activity log write failed (non-fatal):', logErr.message);
    }

    // Best-effort payment confirmation email -- separate from
    // whatever Stripe's own receipt settings do (Settings > Emails >
    // Successful payments controls the actual card-network-compliant
    // receipt). A failure here should never fail the webhook itself;
    // the payment is already correctly recorded either way.
    try {
      const customerEmail = job.email || job.clientEmail || '';
      if (customerEmail) {
        await sendPaymentConfirmationEmail(companyId, job, inv, amountPaidNow, jobId, invoiceId);
      }
    } catch (emailErr) {
      console.error('stripeWebhook: confirmation email failed (non-fatal):', emailErr.message);
    }

    // Sync to QBO for bookkeeping - best-effort.
    try {
      await syncInvoiceToQbo(companyId, jobId, invoiceId);
    } catch (e) {
      console.error('stripeWebhook: QBO sync failed (payment still recorded in JOBSMETRIX):', e.message);
    }
    // XERO_V1: apply the payment and its Stripe fee in Xero - best-effort.
    await xeroAfterPayment(companyId, jobId, invoiceId);

    return res.status(200).send('OK');
  } catch (e) {
    console.error('stripeWebhook: payment_intent.succeeded processing failed:', e.message);
    return res.status(500).send('Internal error.');
  }
}

// The bounce/decline case -- most relevant for ACH, which can fail
// days after checkout.session.completed already fired (insufficient
// funds, wrong account/routing number, account closed, etc). Since
// handleCheckoutSessionCompleted never touched amtPaid, there's
// nothing to reverse here -- just flip the status to a distinct
// "Payment Failed" (not silently back to unpaid) so it's obvious in
// the UI that a payment was actually attempted and didn't go through,
// not just that the invoice was never sent a link.
async function handlePaymentIntentFailed(event, companyId, res) {
  const pi = event.data.object;
  const { jobId, invoiceId, coId } = pi.metadata || {};
  if (coId) return handleCOPaymentIntentFailed(pi, companyId, jobId, coId, res);
  if (!jobId || !invoiceId) {
    console.error('stripeWebhook: payment_intent.payment_failed missing metadata.', pi.id);
    return res.status(200).send('Missing metadata, ignored.');
  }
  try {
    const db = admin.firestore();
    const invRef = db.collection('companies').doc(companyId)
      .collection('jobs').doc(jobId).collection('invoices').doc(invoiceId);
    const invDoc = await invRef.get();
    if (!invDoc.exists) {
      console.error('stripeWebhook: invoice not found', companyId, jobId, invoiceId);
      return res.status(200).send('Invoice not found, ignored.');
    }
    const failureReason = pi.last_payment_error?.message || 'Unknown reason';
    await invRef.update({
      status: 'Payment Failed',
      stripePaymentFailureReason: failureReason,
      stripePaymentFailedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    try {
      await db.collection('companies').doc(companyId)
        .collection('jobs').doc(jobId).collection('logs').add({
          date: new Date().toISOString().split('T')[0],
          notes: `Payment attempt FAILED on invoice — ${failureReason}`,
          type: 'invoice_payment_failed',
          userName: 'Stripe (auto)',
          companyId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (logErr) {
      console.error('stripeWebhook: activity log write failed (non-fatal):', logErr.message);
    }
    return res.status(200).send('OK - marked Payment Failed.');
  } catch (e) {
    console.error('stripeWebhook: payment_intent.payment_failed processing failed:', e.message);
    return res.status(500).send('Internal error.');
  }
}

// ---- Change Order payment handlers, mirroring the invoice ones above ----
// Same three-stage lifecycle (Processing -> Paid, or -> Payment Failed),
// same real-fee tracking. Deliberately skips syncInvoiceToQbo -- that's
// invoice-specific bookkeeping sync, not something change orders push to
// QBO today.

async function handleCOCheckoutSessionCompleted(session, companyId, jobId, coId, res) {
  if (!jobId || !coId) {
    console.error('stripeWebhook: CO checkout.session.completed missing metadata.', session.id);
    return res.status(200).send('Missing metadata, ignored.');
  }
  try {
    const db = admin.firestore();
    const coRef = db.collection('companies').doc(companyId)
      .collection('jobs').doc(jobId).collection('changeorders').doc(coId);
    const coDoc = await coRef.get();
    if (!coDoc.exists) {
      console.error('stripeWebhook: change order not found', companyId, jobId, coId);
      return res.status(200).send('Change order not found, ignored.');
    }
    await coRef.update({
      status: 'Processing',
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: session.payment_intent || null,
      stripeCheckoutCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.status(200).send('OK - CO marked Processing, awaiting settlement.');
  } catch (e) {
    console.error('stripeWebhook: CO checkout.session.completed processing failed:', e.message);
    return res.status(500).send('Internal error.');
  }
}

async function handleCOPaymentIntentSucceeded(pi, companyId, jobId, coId, res, stripe) {
  if (!jobId || !coId) {
    console.error('stripeWebhook: CO payment_intent.succeeded missing metadata.', pi.id);
    return res.status(200).send('Missing metadata, ignored.');
  }
  try {
    const db = admin.firestore();
    const jobRef = db.collection('companies').doc(companyId).collection('jobs').doc(jobId);
    const coRef = jobRef.collection('changeorders').doc(coId);
    const [jobDoc, coDoc] = await Promise.all([jobRef.get(), coRef.get()]);
    if (!coDoc.exists) {
      console.error('stripeWebhook: change order not found', companyId, jobId, coId);
      return res.status(200).send('Change order not found, ignored.');
    }
    const job = jobDoc.exists ? jobDoc.data() : {};
    const co = coDoc.data();

    const amountPaidNow = (pi.amount_received || pi.amount || 0) / 100;
    const newAmtPaid = Math.round(((co.amtPaid || 0) + amountPaidNow) * 100) / 100;
    const total = co.amount || 0;

    let stripeFee = null, stripeNetAmount = null;
    try {
      const piFull = await stripe.paymentIntents.retrieve(pi.id, {
        expand: ['latest_charge.balance_transaction'],
      });
      const bt = piFull.latest_charge?.balance_transaction;
      if (bt) {
        stripeFee = Math.round(bt.fee) / 100;
        stripeNetAmount = Math.round(bt.net) / 100;
      }
    } catch (feeErr) {
      console.error('stripeWebhook: CO could not retrieve real fee (payment still recorded):', feeErr.message);
    }

    const update = {
      amtPaid: newAmtPaid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      stripePaymentIntentId: pi.id,
      stripeLastPaidAt: admin.firestore.FieldValue.serverTimestamp(),
      paymentMethod: 'Card / Online (Stripe)'
    };
    if (stripeFee !== null) {
      update.stripeFeeTotal = Math.round(((co.stripeFeeTotal || 0) + stripeFee) * 100) / 100;
      update.stripeNetTotal = Math.round(((co.stripeNetTotal || 0) + stripeNetAmount) * 100) / 100;
    }
    if (newAmtPaid >= total) {
      update.status = 'Paid';
      update.paidDate = new Date().toISOString().split('T')[0];
    }
    await coRef.update(update);

    try {
      const amtStr = amountPaidNow.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
      const feeNote = stripeFee !== null ? ` (Stripe fee: $${stripeFee.toFixed(2)}, net $${stripeNetAmount.toFixed(2)})` : '';
      await db.collection('companies').doc(companyId)
        .collection('jobs').doc(jobId).collection('logs').add({
          date: new Date().toISOString().split('T')[0],
          notes: `Change Order ${co.coNumber || ''} paid — $${amtStr} (Stripe)${feeNote}`.replace('  ', ' ').trim(),
          type: 'co_paid',
          userName: 'Stripe (auto)',
          companyId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (logErr) {
      console.error('stripeWebhook: CO activity log write failed (non-fatal):', logErr.message);
    }

    try {
      const customerEmail = job.email || job.clientEmail || '';
      if (customerEmail) {
        await sendPaymentConfirmationEmail(companyId, job, co, amountPaidNow, jobId, coId, co.coNumber || 'Change Order');
      }
    } catch (emailErr) {
      console.error('stripeWebhook: CO confirmation email failed (non-fatal):', emailErr.message);
    }

    return res.status(200).send('OK');
  } catch (e) {
    console.error('stripeWebhook: CO payment_intent.succeeded processing failed:', e.message);
    return res.status(500).send('Internal error.');
  }
}

async function handleCOPaymentIntentFailed(pi, companyId, jobId, coId, res) {
  if (!jobId || !coId) {
    console.error('stripeWebhook: CO payment_intent.payment_failed missing metadata.', pi.id);
    return res.status(200).send('Missing metadata, ignored.');
  }
  try {
    const db = admin.firestore();
    const coRef = db.collection('companies').doc(companyId)
      .collection('jobs').doc(jobId).collection('changeorders').doc(coId);
    const coDoc = await coRef.get();
    if (!coDoc.exists) {
      console.error('stripeWebhook: change order not found', companyId, jobId, coId);
      return res.status(200).send('Change order not found, ignored.');
    }
    const failureReason = pi.last_payment_error?.message || 'Unknown reason';
    await coRef.update({
      status: 'Payment Failed',
      stripePaymentFailureReason: failureReason,
      stripePaymentFailedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    try {
      await db.collection('companies').doc(companyId)
        .collection('jobs').doc(jobId).collection('logs').add({
          date: new Date().toISOString().split('T')[0],
          notes: `Payment attempt FAILED on change order — ${failureReason}`,
          type: 'co_payment_failed',
          userName: 'Stripe (auto)',
          companyId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (logErr) {
      console.error('stripeWebhook: CO activity log write failed (non-fatal):', logErr.message);
    }
    return res.status(200).send('OK - CO marked Payment Failed.');
  } catch (e) {
    console.error('stripeWebhook: CO payment_intent.payment_failed processing failed:', e.message);
    return res.status(500).send('Internal error.');
  }
}

// Sends a "Payment Received" confirmation using the exact same
// branded-HTML-wrapper + SendGrid REST pattern sendJobspanEmail uses
// (that function is a callable, meant to be invoked from the client
// with an authenticated user -- this webhook has neither, so this
// reimplements the same send logic directly rather than trying to
// invoke that function cross-function).
async function sendPaymentConfirmationEmail(companyId, job, inv, amountPaidNow, jobId, invoiceId, docLabelOverride) {
  const sgKey = process.env.SENDGRID_KEY || (functions.config().sendgrid && functions.config().sendgrid.key);
  if (!sgKey) return; // Not configured -- skip silently, this is best-effort

  const db = admin.firestore();
  let companyName = 'JTXD Contracting';
  try {
    const settDoc = await db.collection('companies').doc(companyId).collection('settings').doc('company').get();
    if (settDoc.exists) companyName = settDoc.data().companyName || companyName;
  } catch(e) {}

  const customerEmail = job.email || job.clientEmail || '';
  const customerName = job.client || 'Customer';
  const invNum = docLabelOverride || inv.number || 'Invoice';
  const amtStr = amountPaidNow.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});

  const bodyHtml = `<p>Hi ${customerName},</p>
    <p>This confirms we've received your payment of <strong>$${amtStr}</strong> toward ${invNum}${job.name ? ' for ' + job.name : ''}.</p>
    <p>Thank you!</p>`;

  const brandedHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:600px;width:100%">
        <tr><td style="background:#04121f;padding:24px 32px;text-align:center">
          <span style="color:#d97706;font-size:1.3rem;font-weight:800;letter-spacing:.02em">${companyName}</span>
        </td></tr>
        <tr><td style="padding:32px;color:#1a1a1a;font-size:15px;line-height:1.6">${bodyHtml}</td></tr>
        <tr><td style="background:#f9f9f9;padding:20px 32px;text-align:center;font-size:12px;color:#888;border-top:1px solid #eee">
          This email was sent by ${companyName} via JOBSpan.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const payload = {
    personalizations: [{ to: [{ email: customerEmail, name: customerName }], bcc: [{ email: 'travis@jtxdgroup.com' }] }],
    from: { email: 'travis@jtxdgroup.com', name: companyName },
    reply_to: { email: 'travis@jtxdgroup.com', name: companyName },
    subject: `Payment Received — ${invNum}`,
    content: [
      { type: 'text/plain', value: `We've received your payment of $${amtStr} toward ${invNum}. Thank you!` },
      { type: 'text/html', value: brandedHtml }
    ]
  };

  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${sgKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

exports.sendMessageNotificationSms = functions.firestore
  .document('companies/{companyId}/jobs/{jobId}/messages/{messageId}')
  .onCreate(async (snap, context) => {
    const msg = snap.data();
    if (!msg || msg.notifyStatus !== 'pending' || !Array.isArray(msg.notifyTargets) || !msg.notifyTargets.length) {
      return null;
    }

    const plivoSetup = getPlivoClient();
    if (!plivoSetup) {
      console.warn('Plivo not configured (PLIVO_AUTH_ID/PLIVO_AUTH_TOKEN/PLIVO_FROM missing) - skipping SMS, marking as skipped.');
      return snap.ref.update({ notifyStatus: 'skipped_no_plivo_config' });
    }

    const { companyId, jobId } = context.params;

    // Pull job + company name for a useful message body
    const [jobDoc, companyDoc] = await Promise.all([
      admin.firestore().collection('companies').doc(companyId).collection('jobs').doc(jobId).get(),
      admin.firestore().collection('companies').doc(companyId).collection('settings').doc('company').get()
    ]);
    const jobName = jobDoc.exists ? (jobDoc.data().name || 'a job') : 'a job';
    const companyName = companyDoc.exists ? (companyDoc.data().name || 'JOBSpan') : 'JOBSpan';

    const senderLabel = msg.fromCustomer ? 'Customer' : (msg.authorName || 'Team');
    const smsBody = `[${companyName}] ${senderLabel} on ${jobName}: ${(msg.text || '').slice(0, 300)}`;

    const results = [];
    for (const target of msg.notifyTargets) {
      if (!target.phone) { results.push({ ...target, status: 'skipped_no_phone' }); continue; }
      try {
        await plivoSetup.client.messages.create(plivoSetup.from, target.phone, smsBody);
        results.push({ ...target, status: 'sent' });
      } catch (err) {
        console.error('Plivo send failed for', target.phone, err.message);
        results.push({ ...target, status: 'failed', error: err.message });
      }
    }

    const anySent = results.some(r => r.status === 'sent');
    return snap.ref.update({
      notifyStatus: anySent ? 'sent' : 'failed',
      notifyResults: results,
      notifiedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

// plivoInboundSms -- NEW, 2026-09-26. The genuinely new half: a customer's
// real text-message reply to your business number. Plivo POSTs
// form-encoded From/To/Text (confirmed against Plivo's current docs, not
// assumed from Twilio's shape) to whatever URL this function deploys to
// -- that URL gets configured as the "Message URL" on the Plivo
// Application tied to your number.
//
// Matches the inbound number against job.phone. If more than one job
// shares that phone number (a repeat customer), picks the most recently
// updated one rather than guessing wrong or breaking -- flagged here so
// it's a known, deliberate choice, not silently arbitrary.
exports.plivoInboundSms = functions.https.onRequest(async (req, res) => {
  const from = req.body.From || req.query.From;
  const text = req.body.Text || req.query.Text;
  if (!from || !text) { res.status(200).send('ignored'); return; }

  const db = admin.firestore();
  const companiesSnap = await db.collection('companies').get();

  let matchedJob = null, matchedCompanyId = null;
  for (const companyDoc of companiesSnap.docs) {
    const jobsSnap = await companyDoc.ref.collection('jobs')
      .where('phone', '==', from)
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .get();
    if (!jobsSnap.empty) {
      matchedJob = jobsSnap.docs[0];
      matchedCompanyId = companyDoc.id;
      break;
    }
  }

  if (!matchedJob) {
    console.warn('plivoInboundSms: no job found with phone', from);
    res.status(200).send('no match');
    return;
  }

  await matchedJob.ref.collection('messages').add({
    text,
    authorEmail: '',
    authorName: matchedJob.data().client || 'Customer',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdMs: Date.now(),
    companyId: matchedCompanyId,
    fromCustomer: true,
    visibleToCustomer: true,
    notifyTargets: [], // this message IS the notification -- don't re-text
    notifyStatus: 'none',
  });

  res.status(200).send('received');
});

// ════════════════════════════════════════════════════
// ── sendJobspanEmail ─────────────────────────────────
// Sends transactional email via SendGrid from travis@jtxdgroup.com.
// Called by the client for: lien waivers, invoices, proposals.
//
// ONE-TIME SETUP (on Mac with Firebase CLI):
//   firebase functions:config:set sendgrid.key="SG.your_key_here"
//   firebase deploy --only functions:sendJobspanEmail
//
// Config key: sendgrid.key
// ════════════════════════════════════════════════════
exports.sendJobspanEmailSendGridBackup = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  }

  const { to, toName, subject, bodyHtml, bodyText, replyTo, docType, jobId } = data;

  if (!to || !subject || (!bodyHtml && !bodyText)) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required email fields.');
  }

  // Verify caller is a member of the company the job belongs to
  const companyId = context.auth.token.companyId;
  if (!companyId) {
    throw new functions.https.HttpsError('permission-denied', 'No company association found.');
  }

  const sgKey = process.env.SENDGRID_KEY || (functions.config().sendgrid && functions.config().sendgrid.key);
  if (!sgKey) {
    throw new functions.https.HttpsError('internal', 'SendGrid not configured. Set sendgrid.key in Firebase config.');
  }

  // Branded HTML wrapper
  const db = admin.firestore();
  let companyName = 'JTXD Contracting';
  let companyLogo = '';
  try {
    const settDoc = await db.collection('companies').doc(companyId)
      .collection('settings').doc('company').get();
    if (settDoc.exists) {
      companyName = settDoc.data().companyName || companyName;
      companyLogo = settDoc.data().logoUrl || '';
    }
  } catch(e) {}

  const brandedHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:600px;width:100%">
        <!-- Header -->
        <tr><td style="background:#04121f;padding:24px 32px;text-align:center">
          ${companyLogo ? `<img src="${companyLogo}" style="height:48px;margin-bottom:8px"><br>` : ''}
          <span style="color:#d97706;font-size:1.3rem;font-weight:800;letter-spacing:.02em">${companyName}</span>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px;color:#1a1a1a;font-size:15px;line-height:1.6">
          ${bodyHtml || `<p>${bodyText}</p>`}
        </td></tr>
        <!-- Footer -->
        <tr><td style="background:#f9f9f9;padding:20px 32px;text-align:center;font-size:12px;color:#888;border-top:1px solid #eee">
          This email was sent by ${companyName} via JOBSpan.<br>
          Questions? Reply to this email or contact us directly.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // Send via SendGrid REST API
  // native fetch available in Node 20
  const payload = {
    personalizations: [{
      to: [{ email: to, name: toName || to }],
      // BCC yourself a copy of every email sent through this function --
      // proposals, invoices, change orders, all of it -- so there's a
      // real, independent record that a send actually happened and what
      // it contained, rather than relying on the customer to say
      // whether or not they got it. BCC means the customer never sees
      // this address on the email at all.
      bcc: [{ email: 'travis@jtxdgroup.com' }]
    }],
    from: { email: 'travis@jtxdgroup.com', name: companyName },
    reply_to: { email: replyTo || 'travis@jtxdgroup.com', name: companyName },
    subject,
    content: [
      { type: 'text/plain', value: bodyText || subject },
      { type: 'text/html', value: brandedHtml }
    ]
  };

  let sgRes;
  try {
    sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sgKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    // The request itself failed (network blip, timeout, DNS) rather than
    // coming back with a bad status — without this catch, that's an
    // uncaught exception and Firebase masks it as a bare "internal"
    // error with zero detail on the client. Surface it instead.
    console.error('SendGrid request failed:', e.message);
    throw new functions.https.HttpsError('internal', `Email send failed: request error — ${e.message}`);
  }

  if (!sgRes.ok) {
    const errText = await sgRes.text();
    console.error('SendGrid error:', sgRes.status, errText);
    throw new functions.https.HttpsError('internal', `Email send failed: SendGrid ${sgRes.status} — ${errText.slice(0, 200)}`);
  }

  // Log the send to Firestore for audit trail
  if (jobId && docType) {
    try {
      await db.collection('companies').doc(companyId)
        .collection('emailLog').add({
          jobId, docType, to, subject,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          sentBy: context.auth.token.email || '',
          status: 'sent'
        });
    } catch(e) {}
  }

  return { success: true, message: `Email sent to ${to}` };
});

// ============================================================================
// sendJobspanEmailGmail — deployed as a NEW, separate function first
//
// Deliberately named differently from sendJobspanEmail so it can be tested
// for real (send yourself a test email, check formatting/BCC/log) before
// doing the actual cutover. Once confirmed working: rename this export to
// sendJobspanEmail and delete/comment out the old SendGrid version. Don't
// swap blind -- verify first, same reasoning as everything else tonight.
//
// This matches the REAL sendJobspanEmail's full behavior, not a partial
// reconstruction:
//   - same params (to, toName, subject, bodyHtml, bodyText, replyTo, docType, jobId)
//   - same auth check (context.auth + companyId from the token)
//   - same company branding lookup + HTML wrapper (identical template)
//   - same BCC-to-self audit copy (now travis@7pillarsgroup.org, matching
//     the address switch -- confirm that's actually what you want the audit
//     copies going to, since the real function BCC'd jtxdgroup.com)
//   - same reply-to default
//   - same emailLog Firestore write at the end
//
// SETUP REQUIRED (Cloud Console + Workspace Admin, one-time):
//   1. console.cloud.google.com, project kytrac-72d91: APIs & Services >
//      Library > enable "Gmail API"
//   2. IAM & Admin > Service Accounts > Create Service Account (name it
//      something like "gmail-sender"). After creating it, open it > Keys >
//      Add Key > Create new key > JSON -- downloads a key file.
//   3. Copy that service account's "Client ID" (a long number, on its
//      Details page -- NOT the email address).
//   4. admin.google.com (Workspace Admin -- different site, needs your
//      Workspace admin login): Security > Access and data control > API
//      controls > Domain-wide Delegation > Add new:
//        Client ID: <paste the number from step 3>
//        OAuth Scopes: https://www.googleapis.com/auth/gmail.send
//      Authorize.
//   5. Store the downloaded JSON key as a secret:
//        firebase functions:secrets:set GMAIL_SERVICE_ACCOUNT_KEY
//      (paste the full JSON contents when prompted), or via Cloud Console >
//      Secret Manager if you prefer the UI.
//   6. npm install googleapis (in functions/, if not already there --
//      it already is, per package.json: googleapis ^140.0.0).
//   7. Deploy just this function: firebase deploy --only functions:sendJobspanEmailGmail
// ============================================================================

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send'];
const EMAIL_SEND_AS = 'travis@7pillarsgroup.org';

let _gmailClient = null;
async function getGmailClient() {
  if (_gmailClient) return _gmailClient;
  const key = JSON.parse(process.env.GMAIL_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: GMAIL_SCOPES,
    subject: EMAIL_SEND_AS, // domain-wide delegation: send AS this Workspace user
  });
  await auth.authorize();
  _gmailClient = google.gmail({ version: 'v1', auth });
  return _gmailClient;
}

function encodeSubject(subject) {
  return `=?utf-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
}

// Builds a raw RFC 2822 message with To/Bcc/Reply-To headers -- Gmail's API
// takes a full base64url-encoded MIME message, not a convenience object
// like SendGrid's {to, subject, html}.
function buildRawMessage({ to, toName, bccEmail, replyTo, fromName, subject, bodyHtml, bodyText }) {
  const toHeader = toName ? `"${toName}" <${to}>` : to;
  const boundary = `bnd_${Date.now()}`;

  const headers = [
    `From: "${fromName}" <${EMAIL_SEND_AS}>`,
    `To: ${toHeader}`,
    bccEmail ? `Bcc: ${bccEmail}` : null,
    `Reply-To: "${fromName}" <${replyTo || EMAIL_SEND_AS}>`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);

  const body = [
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    bodyText || subject,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    bodyHtml || `<p>${bodyText || ''}</p>`,
    `--${boundary}--`,
  ];

  const message = headers.join('\r\n') + '\r\n' + body.join('\r\n');

  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

exports.sendJobspanEmail = functions.runWith({ secrets: ['GMAIL_SERVICE_ACCOUNT_KEY'] }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  }

  const { to, toName, subject, bodyHtml, bodyText, replyTo, docType, jobId } = data;
  if (!to || !subject || (!bodyHtml && !bodyText)) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required email fields.');
  }

  const companyId = context.auth.token.companyId;
  if (!companyId) {
    throw new functions.https.HttpsError('permission-denied', 'No company association found.');
  }

  // Same branded HTML wrapper as the real sendJobspanEmail -- identical
  // template, same company name/logo lookup.
  const db = admin.firestore();
  let companyName = 'JTXD Contracting';
  let companyLogo = '';
  try {
    const settDoc = await db.collection('companies').doc(companyId)
      .collection('settings').doc('company').get();
    if (settDoc.exists) {
      companyName = settDoc.data().companyName || companyName;
      companyLogo = settDoc.data().logoUrl || '';
    }
  } catch (e) {}

  const brandedHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:600px;width:100%">
        <tr><td style="background:#04121f;padding:24px 32px;text-align:center">
          ${companyLogo ? `<img src="${companyLogo}" style="height:48px;margin-bottom:8px"><br>` : ''}
          <span style="color:#d97706;font-size:1.3rem;font-weight:800;letter-spacing:.02em">${companyName}</span>
        </td></tr>
        <tr><td style="padding:32px;color:#1a1a1a;font-size:15px;line-height:1.6">
          ${bodyHtml || `<p>${bodyText}</p>`}
        </td></tr>
        <tr><td style="background:#f9f9f9;padding:20px 32px;text-align:center;font-size:12px;color:#888;border-top:1px solid #eee">
          This email was sent by ${companyName} via JOBSpan.<br>
          Questions? Reply to this email or contact us directly.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  let gmail;
  try {
    gmail = await getGmailClient();
  } catch (e) {
    console.error('sendJobspanEmailGmail: Gmail client setup failed', e.message);
    throw new functions.https.HttpsError('internal', `Gmail auth failed: ${e.message}`);
  }

  const raw = buildRawMessage({
    to, toName, replyTo,
    bccEmail: EMAIL_SEND_AS, // audit copy of every send, same purpose as the
                              // real function's BCC -- now going to the new
                              // sending address itself rather than jtxdgroup.com;
                              // confirm that's actually what you want.
    fromName: companyName,
    subject, bodyHtml: brandedHtml, bodyText,
  });

  try {
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  } catch (err) {
    console.error('sendJobspanEmailGmail: send failed', err);
    throw new functions.https.HttpsError('internal', `Email send failed: ${err.message}`);
  }

  if (jobId && docType) {
    try {
      await db.collection('companies').doc(companyId)
        .collection('emailLog').add({
          jobId, docType, to, subject,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          sentBy: context.auth.token.email || '',
          status: 'sent',
          via: 'gmail', // distinguishes these from historical SendGrid-sent log entries
        });
    } catch (e) {}
  }

  return { success: true, message: `Email sent to ${to}` };
});

// ════════════════════════════════════════════════════
// ── dailyKpiRefresh ──────────────────────────────────
// Runs every day at 6am CT, pulls MTD financials from QBO,
// writes to companies/{companyId}/kpiCache/mtd so the dashboard
// can read instantly without live API calls on page load.
// ════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════
// SCOPEWALK PHASE 2 — transcribe the walk-through audio, then have Claude
// read the transcript and draft a scope of work matched against the real
// catalog. Never invents prices: only attaches unitCost/unitPrice that
// already exist in CATALOG_DATA for a matched item. Anything the model
// can't confidently match is left unmatched for manual review, not guessed.
// ═══════════════════════════════════════════════════════════════════════
exports.processScopeWalk = functions
  .runWith({ secrets: ['ANTHROPIC_API_KEY'], timeoutSeconds: 540, memory: '1GB' })
  .firestore.document('companies/{companyId}/walkCaptures/{walkId}')
  .onCreate(async (snap, context) => {
    const { companyId, walkId } = context.params;
    const db = admin.firestore();
    const docRef = snap.ref;
    const data = snap.data();

    try {
      // ── Step 1: Transcribe the audio with Google Cloud Speech-to-Text ──
      const speech = require('@google-cloud/speech');
      const speechClient = new speech.SpeechClient();
      const bucket = admin.storage().bucket();
      const [audioBuffer] = await bucket.file(data.audioPath).download();

      const [operation] = await speechClient.longRunningRecognize({
        audio: { content: audioBuffer.toString('base64') },
        config: {
          encoding: 'WEBM_OPUS',
          sampleRateHertz: 48000,
          languageCode: 'en-US',
          enableAutomaticPunctuation: true,
          model: 'default',
        },
      });
      const [response] = await operation.promise();
      const transcript = (response.results || [])
        .map(r => r.alternatives[0].transcript)
        .join(' ')
        .trim();

      if (!transcript) {
        await docRef.update({
          status: 'transcribe_failed',
          transcript: '',
          transcribeError: 'No speech detected in audio.',
        });
        return;
      }

      await docRef.update({ transcript, status: 'transcribed' });

      // ── Step 2: Build a condensed catalog reference (names + trades only, ──
      // ── no prices sent to the model — prices get attached below from the ──
      // ── real catalog after matching, never from what Claude returns).    ──
      const jobSnap = await db.collection('companies').doc(companyId)
        .collection('jobs').doc(data.jobId).get();
      const job = jobSnap.exists ? jobSnap.data() : {};

      // CATALOG_DATA lives in the front-end bundle, not in Firestore, so a
      // condensed copy is kept here for matching. This mirrors kytrac-app.js
      // and must be regenerated (see scripts/sync-catalog-names.js) whenever
      // the catalog changes trade codes or item names.
      const catalogNamesByTrade = require('./scopewalk-catalog-names.json');

      const catalogRefText = Object.entries(catalogNamesByTrade)
        .map(([trade, names]) => `${trade}:\n` + names.map(n => `  - ${n}`).join('\n'))
        .join('\n\n');

      const prompt = `You are helping a residential contractor turn a spoken property walk-through into a draft scope of work.

Below is a transcript of what the contractor said out loud while walking the property, noting what work is needed room by room.

TRANSCRIPT:
"""
${transcript}
"""

Extract each distinct scope item mentioned (e.g. "replace the kitchen faucet", "patch drywall in the hallway ceiling", "paint the master bedroom two coats"). For each item, try to match it to the closest item name in the catalog reference below. Only match when you are genuinely confident it's the same item — if nothing in the catalog is a good fit, set matchedCatalogName to null rather than guessing at a loose match.

CATALOG REFERENCE (trade code, then item names under it):
${catalogRefText}

Respond with ONLY a JSON array, no other text, no markdown fences. Each element:
{
  "spokenItem": "<what the contractor said, in your own words>",
  "room": "<room mentioned, or null>",
  "matchedCatalogName": "<exact catalog item name, or null>",
  "trade": "<trade code the match belongs to, or null>",
  "estimatedQty": <number, or null if not mentioned>,
  "unit": "<unit, or null>",
  "confidence": "high" | "medium" | "low"
}`;

      const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 4000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const anthropicJson = await anthropicResp.json();
      if (!anthropicResp.ok) {
        throw new Error('Anthropic API error: ' + JSON.stringify(anthropicJson));
      }
      const rawText = anthropicJson.content.map(b => b.text || '').join('');
      let scopeItems;
      try {
        scopeItems = JSON.parse(rawText.trim());
      } catch (parseErr) {
        const match = rawText.match(/\[[\s\S]*\]/);
        if (!match) throw new Error('Could not parse model response as JSON: ' + rawText.slice(0, 500));
        scopeItems = JSON.parse(match[0]);
      }

      // ── Step 3: Attach REAL current prices from the live catalog for ──
      // ── every matched item. Never trust a price from the model.      ──
      const catalogFull = require('./scopewalk-catalog-full.json'); // trade -> [{name, materials:{unitCost,unitPrice,unit}, labor:{...}}]
      const draftEstimate = scopeItems.map(item => {
        if (!item.matchedCatalogName || !item.trade) {
          return { ...item, matched: false, unitCost: null, unitPrice: null };
        }
        const tradeItems = catalogFull[item.trade] || [];
        const found = tradeItems.find(ci => ci.name === item.matchedCatalogName);
        if (!found) {
          return { ...item, matched: false, unitCost: null, unitPrice: null };
        }
        return {
          ...item,
          matched: true,
          unitCost: (found.materials && found.materials.unitCost) || null,
          unitPrice: (found.materials && found.materials.unitPrice) || null,
          unit: (found.materials && found.materials.unit) || item.unit || null,
        };
      });

      await docRef.update({
        draftEstimate,
        status: 'estimated',
        estimatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    } catch (err) {
      console.error('processScopeWalk failed for', walkId, err);
      await docRef.update({
        status: 'processing_failed',
        processingError: String(err.message || err),
      }).catch(() => {});
    }
  });

exports.dailyKpiRefresh = functions.pubsub
  .schedule('0 11 * * *') // 11am UTC = 6am CT
  .timeZone('America/Chicago')
  .onRun(async () => {
    const db = admin.firestore();

    // Get all companies that have QBO connected
    const companiesSnap = await db.collection('companies').get();

    for (const companyDoc of companiesSnap.docs) {
      const companyId = companyDoc.id;

      // ── QBO-dependent MTD KPI cache — only runs if QBO is connected ──
      try {
        // Load QBO tokens
        const tokenDoc = await db.collection('companies').doc(companyId)
          .collection('quickbooksTokens').doc('main').get();
        if (!tokenDoc.exists) throw new Error('__no_qbo__');

        const tokens = tokenDoc.data();
        const realmId = tokens.realmId;
        if (!realmId || !tokens.accessToken) throw new Error('__no_qbo__');

        const now = new Date();
        const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
          .toISOString().split('T')[0];
        const today = now.toISOString().split('T')[0];

        // Helper to call QBO API
        const qboGet = async (path) => {
          const res = await fetch(
            `https://quickbooks.api.intuit.com/v3/company/${realmId}/${path}`,
            { headers: {
              'Authorization': `Bearer ${tokens.accessToken}`,
              'Accept': 'application/json'
            }}
          );
          if (!res.ok) throw new Error('QBO API error: ' + res.status);
          return res.json();
        };

        // Collected MTD — sum of payments received
        let collectedMTD = 0;
        try {
          const paymentsQuery = `SELECT * FROM Payment WHERE TxnDate >= '${firstOfMonth}' AND TxnDate <= '${today}' MAXRESULTS 1000`;
          const paymentsRes = await qboGet(`query?query=${encodeURIComponent(paymentsQuery)}`);
          const payments = paymentsRes?.QueryResponse?.Payment || [];
          collectedMTD = payments.reduce((s, p) => s + (p.TotalAmt || 0), 0);
        } catch(e) { console.warn('QBO payments query failed:', e.message); }

        // Spent MTD — sum of bills paid + expenses
        let spentMTD = 0;
        try {
          const billsQuery = `SELECT * FROM Bill WHERE TxnDate >= '${firstOfMonth}' AND TxnDate <= '${today}' MAXRESULTS 1000`;
          const billsRes = await qboGet(`query?query=${encodeURIComponent(billsQuery)}`);
          const bills = billsRes?.QueryResponse?.Bill || [];
          spentMTD += bills.reduce((s, b) => s + (b.TotalAmt || 0), 0);
        } catch(e) { console.warn('QBO bills query failed:', e.message); }

        try {
          const expQuery = `SELECT * FROM Purchase WHERE TxnDate >= '${firstOfMonth}' AND TxnDate <= '${today}' MAXRESULTS 1000`;
          const expRes = await qboGet(`query?query=${encodeURIComponent(expQuery)}`);
          const expenses = expRes?.QueryResponse?.Purchase || [];
          spentMTD += expenses.reduce((s, e) => s + (e.TotalAmt || 0), 0);
        } catch(e) { console.warn('QBO expenses query failed:', e.message); }

        // Write to Firestore cache
        await db.collection('companies').doc(companyId)
          .collection('kpiCache').doc('mtd').set({
            collectedMTD: Math.round(collectedMTD * 100) / 100,
            spentMTD: Math.round(spentMTD * 100) / 100,
            netMTD: Math.round((collectedMTD - spentMTD) * 100) / 100,
            refreshedAt: admin.firestore.FieldValue.serverTimestamp(),
            periodStart: firstOfMonth,
            periodEnd: today,
          });

        console.log(`KPI refresh complete for ${companyId}: collected=$${collectedMTD} spent=$${spentMTD}`);

      } catch(e) {
        if (e.message !== '__no_qbo__') console.error(`KPI refresh failed for ${companyId}:`, e.message);
      }

      // ── SLA Trigger System — runs for every company regardless of
      // QBO connection status (SLAs are based on job/invoice/CO data
      // already in Firestore, not QBO). ──────────────────────────────
      try {
        await runSLATriggers(db, companyId);
      } catch(e) {
        console.error(`SLA triggers failed for ${companyId}:`, e.message);
      }

      // ── Weekly Pulse trend — diff today's snapshot (written
      // client-side into pulseHistory whenever PlannerXD syncs) against
      // 7 days ago, merge the delta into plannerxd_pulse_sync so
      // PlannerXD can show trend arrows instead of just raw counts. ──
      try {
        await computePulseTrend(db, companyId);
      } catch(e) {
        console.error(`Pulse trend failed for ${companyId}:`, e.message);
      }
    }
    return null;
  });

// ── Weekly Pulse trend helper ────────────────────────────────────────────
async function computePulseTrend(db, companyId) {
  const todayStr = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const [todayDoc, weekAgoDoc, settDoc] = await Promise.all([
    db.collection('companies').doc(companyId).collection('pulseHistory').doc(todayStr).get(),
    db.collection('companies').doc(companyId).collection('pulseHistory').doc(weekAgo).get(),
    db.collection('companies').doc(companyId).collection('settings').doc('company').get()
  ]);

  if (!todayDoc.exists || !weekAgoDoc.exists) return; // not enough history yet
  const ownerUid = settDoc.exists ? settDoc.data().ownerUid : null;
  if (!ownerUid) return;

  const t = todayDoc.data();
  const w = weekAgoDoc.data();
  const delta = (key) => (typeof t[key] === 'number' && typeof w[key] === 'number') ? t[key] - w[key] : null;

  await db.collection('plannerxd_pulse_sync').doc(ownerUid).set({
    trend: {
      activeJobs: delta('activeJobs'),
      outstandingInvoices: delta('outstandingInvoices'),
      unprocessedCOs: delta('unprocessedCOs'),
      comparedTo: weekAgo
    }
  }, { merge: true });
}

// ── SLA Trigger Helper ──────────────────────────────────────────────────
async function runSLATriggers(db, companyId) {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const jobsSnap = await db.collection('companies').doc(companyId)
    .collection('jobs').get();

  const teamSnap = await db.collection('companies').doc(companyId)
    .collection('team').get();
  const owners = teamSnap.docs
    .filter(d => ['Owner', 'Full Access'].includes(d.data().role))
    .map(d => ({ email: d.data().email, name: d.data().name || d.data().email }));

  // NOTIFY_ROUTING_V1: both partners stay Owner, but SLA to-dos route by
  // seat (settings/notifyRouting = { sales, ops } emails, set in
  // Settings > Who Gets Alerts). Sales = estimate follow-ups; everything
  // else = ops. Unset or unknown email = old behavior (every Owner).
  let salesOwners = owners, opsOwners = owners;
  try {
    const rd = await db.collection('companies').doc(companyId)
      .collection('settings').doc('notifyRouting').get();
    if (rd.exists) {
      const r = rd.data() || {};
      const pick = em => {
        if (!em) return null;
        const m = teamSnap.docs.map(d => d.data()).find(x => (x.email || '').toLowerCase() === String(em).toLowerCase());
        return [{ email: em, name: (m && m.name) || em }];
      };
      salesOwners = pick(r.sales) || owners;
      opsOwners = pick(r.ops) || owners;
    }
  } catch (e) { console.warn('notifyRouting read failed:', e.message); }

  // PlannerXD ownerUid — same lookup the client-side pulse/notification
  // bridges use. If it's not set, we just skip the PlannerXD push and
  // still create the JOBSMETRIX todo as before — this is additive,
  // never a dependency for the existing SLA todo system.
  let plannerxdOwnerUid = null;
  try {
    const settDoc = await db.collection('companies').doc(companyId)
      .collection('settings').doc('company').get();
    plannerxdOwnerUid = settDoc.exists ? (settDoc.data().ownerUid || null) : null;
  } catch(e) {}

  const todosRef = db.collection('companies').doc(companyId).collection('todos');

  const daysSince = (val) => {
    if (!val) return null;
    let d;
    if (typeof val === 'string') d = new Date(val);
    else if (val && val.toDate) d = val.toDate();
    else return null;
    if (isNaN(d)) return null;
    return Math.floor((today - d) / (1000 * 60 * 60 * 24));
  };

  const slaExists = async (slaKey) => {
    const existing = await todosRef
      .where('slaKey', '==', slaKey)
      .where('slaDate', '==', todayStr)
      .limit(1).get();
    return !existing.empty;
  };

  // Pushes a warning into PlannerXD (via the same plannerxd_notifications
  // bridge the proposal-signed event already uses). Note: the PlannerXD
  // side currently turns every item in this collection into a "Do First"
  // task, not a separate blockers list — which is actually the right
  // landing spot for these, since Do First is already the "needs your
  // hand today" quadrant. Only called for priority:'high' items so that
  // quadrant stays short and trustworthy instead of a mirror of every
  // SLA nudge JOBSMETRIX tracks internally.
  const pushToPlannerXD = async (title, jobId) => {
    if (!plannerxdOwnerUid) return;
    try {
      await db.collection('plannerxd_notifications').doc(plannerxdOwnerUid)
        .collection('items').add({
          type: 'sla_alert',
          title,
          body: '',
          jobId: jobId || null,
          companyId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdMs: Date.now(),
          read: false
        });
    } catch(e) { console.warn('PlannerXD push failed:', e.message); }
  };

  const createTodo = async (jobId, jobName, text, priority, assignees, slaKey) => {
    if (await slaExists(slaKey)) return;
    await todosRef.add({
      text,
      jobId,
      jobName,
      priority,
      assignees,
      slaKey,
      slaDate: todayStr,
      source: 'sla',
      done: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`SLA todo: [${priority}] ${text}`);
    if (priority === 'high') await pushToPlannerXD(text, jobId);
  };

  let unprocessedCOCount = 0;
  let outstandingInvoiceTotal = 0;

  for (const jobDoc of jobsSnap.docs) {
    const job = jobDoc.data();
    const jobId = jobDoc.id;
    const jobName = job.name || jobId;
    const status = job.status || '';

    if (job.archived) continue;
    if (['Closed Completed', 'Closed Lost'].includes(status)) continue;

    // Estimate SLA
    if (status === 'Submitted') {
      const days = daysSince(job.statusDate || job.submittedAt);
      if (days === null) continue;
      if (days >= 7) {
        await createTodo(jobId, jobName,
          `Estimate at risk of going cold — ${jobName} (${days} days)`,
          'high', salesOwners, `${jobId}_estimate_cold`);
      } else if (days >= 3) {
        await createTodo(jobId, jobName,
          `Follow up on ${jobName} estimate — sent ${days} days ago`,
          'med', salesOwners, `${jobId}_estimate_followup`);
      }
    }

    // Scheduling SLA
    if (['To Be Scheduled', 'Permitting'].includes(status)) {
      const days = daysSince(job.statusDate || job.approvedAt);
      if (days === null) continue;
      if (days >= 10) {
        await createTodo(jobId, jobName,
          `URGENT: ${jobName} still unscheduled after ${days} days`,
          'high', opsOwners, `${jobId}_schedule_escalation`);
      } else if (days >= 5) {
        await createTodo(jobId, jobName,
          `Schedule crew for ${jobName} — ${days} days since approval`,
          'med', opsOwners, `${jobId}_schedule_crew`);
      }
    }

    // Inspection SLA
    if (status === 'Inspection Pending') {
      const days = daysSince(job.statusDate || job.inspectionDate);
      if (days === null) continue;
      if (days >= 5) {
        await createTodo(jobId, jobName,
          `URGENT: Inspection pending ${days} days on ${jobName}`,
          'high', opsOwners, `${jobId}_inspection_escalation`);
      } else if (days >= 2) {
        await createTodo(jobId, jobName,
          `Follow up on inspection for ${jobName} — ${days} days pending`,
          'med', opsOwners, `${jobId}_inspection_followup`);
      }
    }

    // Invoice SLA
    if (status === 'Complete') {
      const days = daysSince(job.completedAt || job.statusDate);
      if (days === null) continue;
      if (days >= 45) {
        await createTodo(jobId, jobName,
          `Invoice 15 days past due — ${jobName} (${days} days since completion)`,
          'high', opsOwners, `${jobId}_invoice_pastdue15`);
      } else if (days >= 30) {
        await createTodo(jobId, jobName,
          `Invoice overdue — ${jobName} (${days} days since completion)`,
          'high', opsOwners, `${jobId}_invoice_overdue`);
      } else if (days >= 25) {
        await createTodo(jobId, jobName,
          `Invoice due in 5 days — ${jobName}`,
          'med', opsOwners, `${jobId}_invoice_due5`);
      }
    }

    // No daily log 2+ days on an active job — mirrors the 🟡 flag
    // already shown on the JOBSMETRIX home dashboard's Active Jobs
    // table, just surfaced proactively instead of only-if-you-look.
    if (!['Closed Completed', 'Closed Lost', 'Submitted', 'Awaiting Deposit', 'To Be Scheduled', 'Permitting'].includes(status)) {
      const logDays = daysSince(job.lastLogDate);
      if (logDays !== null && logDays >= 3) {
        await createTodo(jobId, jobName,
          `No daily log on ${jobName} in ${logDays} days`,
          'high', opsOwners, `${jobId}_no_log_${todayStr}`);
      }
    }

    // Tally for company-wide checks below
    (job.invoices || []).forEach(inv => {
      if (inv.status !== 'Paid') outstandingInvoiceTotal += (inv.total || 0) - (inv.amtPaid || 0);
    });
  }

  // Unprocessed change orders, company-wide — reuses the same
  // "3+ is red" threshold the dashboard tile already uses.
  try {
    const coPromises = jobsSnap.docs.map(jobDoc =>
      db.collection('companies').doc(companyId).collection('jobs').doc(jobDoc.id)
        .collection('changeorders').get()
        .then(s => s.forEach(d => {
          const st = (d.data().status || '').toLowerCase();
          if (!['approved','declined','rejected','paid','invoiced'].includes(st)) unprocessedCOCount++;
        })).catch(() => {})
    );
    await Promise.all(coPromises);
    if (unprocessedCOCount >= 3) {
      await createTodo(companyId, 'Company-wide',
        `${unprocessedCOCount} change orders awaiting your review`,
        'high', opsOwners, `${companyId}_unprocessed_cos_${todayStr}`);
    }
  } catch(e) {}

  // Outstanding invoices total, company-wide — reuses the same
  // "$10k+ is red" threshold the dashboard tile already uses.
  if (outstandingInvoiceTotal >= 10000) {
    await createTodo(companyId, 'Company-wide',
      `Outstanding invoices total $${Math.round(outstandingInvoiceTotal).toLocaleString()} — above your $10k threshold`,
      'high', opsOwners, `${companyId}_outstanding_threshold_${todayStr}`);
  }

  console.log(`SLA triggers complete for ${companyId}`);
}
// deploy trigger: testing Secret Manager permission fix 2026-09-17T16:37:25Z

// ═══════════════════════════════════════════════════════════
// Added 2026-09-23: KYTLEAD conversion, Stripe entitlements (dormant
// until Stripe Products/Prices are configured and PRICE_TO_MODULE /
// SUITE_PRICE_ID below are filled in with real IDs)
// ═══════════════════════════════════════════════════════════
// ============================================================================
// KYTLEAD -> JOBSMETRIX — lead conversion Cloud Function
//
// INTEGRATION NOTES:
//   1. Paste into functions/index.js alongside sendDailyDigest and your
//      existing functions. Assumes admin.initializeApp() already ran once.
//   2. This is a Firestore-triggered function (onUpdate), not a scheduled
//      one -- it fires the instant a lead's `stage` field flips to 'signed',
//      wherever that write comes from (PlannerXD's pipeline UI, a Zapier
//      hook, manual Firestore edit, doesn't matter).
//   3. Idempotent by design: if convertedJobId is already set, it bails
//      immediately, so a duplicate trigger or a retried write can't create
//      two jobs from the same lead.
//   4. Confirm the jobs/{jobId} field names below (client, email, phone,
//      address, status, source) match your actual JOBSMETRIX job schema --
//      I'm inferring these from the fields kytrac-app.js reads elsewhere
//      (job.email, job.client, job.name), but I don't have the job-creation
//      code itself in this session to verify field-for-field.
// ============================================================================


exports.convertLeadToJob = functions.firestore
  .document('companies/{companyId}/leads/{leadId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    const { companyId, leadId } = context.params;

    // Only act on the exact moment a lead flips into 'signed'.
    if (before.stage === 'signed' || after.stage !== 'signed') return null;

    // Idempotency guard -- never create a second job for the same lead.
    if (after.convertedJobId) {
      console.warn('convertLeadToJob: lead already converted, skipping', leadId);
      return null;
    }

    const db = admin.firestore();
    const jobRef = db.collection('companies').doc(companyId)
      .collection('jobs').doc();

    const jobData = {
      client: after.name || '',
      email: after.email || '',
      phone: after.phone || '',
      address: after.address || '',
      companyId,
      status: 'active',
      source: after.source || 'unknown',
      convertedFromLeadId: leadId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdMs: Date.now(),
    };

    // Write the new job and stamp the lead with convertedJobId in one
    // atomic batch -- either both happen or neither does.
    const batch = db.batch();
    batch.set(jobRef, jobData);
    batch.update(change.after.ref, {
      convertedJobId: jobRef.id,
      convertedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();
    console.log(`convertLeadToJob: lead ${leadId} -> job ${jobRef.id}`);
    return null;
  });

// ============================================================================
// ENTITLEMENTS — Stripe webhook
//
// INTEGRATION NOTES:
//   1. npm install stripe (in functions/)
//   2. Fill in PRICE_TO_MODULE and SUITE_PRICE_ID below with your real Stripe
//      Price IDs once each Product/Price is created in the Stripe Dashboard
//      (one Price per module: jobsmetrix, kytlead, kytalyst, kytfolio,
//      kytvault, kytcrew -- plus one Price for the Suite bundle).
//   3. Assumes companies/{companyId} has a `stripeCustomerId` field already
//      set (from whatever checkout flow creates the Stripe customer) --
//      I don't have that checkout code in this session, so if customerId
//      isn't already being stored there, that's the other half of this
//      that needs building alongside the webhook.
//   4. Register this endpoint's URL in the Stripe Dashboard (Webhooks) for:
//      checkout.session.completed, customer.subscription.updated,
//      customer.subscription.deleted -- and set STRIPE_WEBHOOK_SECRET.
//   5. Deploy: firebase deploy --only functions:stripeWebhook
//
// DATA MODEL THIS WRITES:
//   companies/{companyId}/entitlements/modules  (single doc)
//     suiteActive        : boolean -- true if the bundle subscription is active
//     suiteSubscriptionId: string
//     jobsmetrix: { active: bool, subscriptionId: string, plan: string }
//     kytlead:    { active: bool, subscriptionId: string, plan: string }
//     kytalyst:   { active: bool, subscriptionId: string, plan: string }
//     ... one key per module
//
//   Read-side check anywhere in the app (not a Cloud Function, just a
//   Firestore read + this one line of logic):
//     const hasAccess = doc.suiteActive || doc[module]?.active === true;
// ============================================================================

const Stripe = require('stripe');

// Lazy singleton, NOT instantiated at module load -- the Stripe SDK's
// constructor throws synchronously if the API key isn't a valid string.
// Doing `Stripe(process.env.STRIPE_SECRET_KEY)` at the top level crashed
// the ENTIRE functions deploy (not just this function) the moment
// STRIPE_SECRET_KEY was unset, since Firebase has to load this whole file
// to discover its exports before anything runs. Lazy init means an unset
// key only breaks this one function, on an actual invocation, not
// every function in the file at deploy time.
let _stripeClient = null;
function getStripe() {
  if (!_stripeClient) _stripeClient = Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripeClient;
}
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// TODO: fill in with real Stripe Price IDs from the Dashboard.
const PRICE_TO_MODULE = {
  'price_TODO_jobsmetrix': 'jobsmetrix',
  'price_TODO_kytlead': 'kytlead',
  'price_TODO_kytalyst': 'kytalyst',
  'price_TODO_kytfolio': 'kytfolio',
  'price_TODO_kytvault': 'kytvault',
  'price_TODO_kytcrew': 'kytcrew',
};
const SUITE_PRICE_ID = 'price_TODO_suite';

exports.kytverseEntitlementsWebhook = functions.https.onRequest(async (req, res) => {
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], WEBHOOK_SECRET);
  } catch (err) {
    console.error('stripeWebhook: signature verification failed', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const subscription = await getStripe().subscriptions.retrieve(session.subscription);
        await applySubscriptionState(subscription, true);
        break;
      }
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const active = ['active', 'trialing'].includes(subscription.status);
        await applySubscriptionState(subscription, active);
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await applySubscriptionState(subscription, false);
        break;
      }
      default:
        // Ignore anything else -- invoices, payment intents, etc. aren't
        // this function's concern.
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('stripeWebhook: handler error', err);
    // 500 tells Stripe to retry -- correct behavior for a transient failure
    // (Firestore write hiccup, etc.) rather than silently dropping the event.
    res.status(500).send('Internal error');
  }
});

async function applySubscriptionState(subscription, active) {
  const companyId = subscription.metadata?.companyId;
  if (!companyId) {
    console.warn('applySubscriptionState: subscription has no companyId metadata', subscription.id);
    return;
  }

  const priceId = subscription.items.data[0]?.price?.id;
  const db = admin.firestore();
  const ref = db.collection('companies').doc(companyId)
    .collection('entitlements').doc('modules');

  if (priceId === SUITE_PRICE_ID) {
    await ref.set({
      suiteActive: active,
      suiteSubscriptionId: active ? subscription.id : admin.firestore.FieldValue.delete(),
    }, { merge: true });
    console.log(`entitlements: company ${companyId} suite -> ${active}`);
    return;
  }

  const module = PRICE_TO_MODULE[priceId];
  if (!module) {
    console.warn('applySubscriptionState: unrecognized price ID', priceId);
    return;
  }

  await ref.set({
    [module]: {
      active,
      subscriptionId: active ? subscription.id : admin.firestore.FieldValue.delete(),
      plan: subscription.items.data[0]?.price?.nickname || 'standard',
    },
  }, { merge: true });
  console.log(`entitlements: company ${companyId} ${module} -> ${active}`);
}
// Retest trigger: IAM roles (Artifact Registry Administrator, Service Account User) granted 2026-09-23 7:23pm
// GMAIL_SERVICE_ACCOUNT_KEY secret added 2026-09-23 -- retest trigger
// Fixed .env quoting for JSON secret 2026-09-23
// Retest: GMAIL_SERVICE_ACCOUNT_KEY created in Secret Manager 2026-09-23
// Retest: appspot runtime SA granted Secret Accessor on GMAIL_SERVICE_ACCOUNT_KEY 2026-09-23
// Retest: firebase-adminsdk-fbsvc granted Secret Manager Admin 2026-09-23
// Retest: added --force to deploy args 2026-09-23

// ============================================================================
// JOBSMETRIX <-> GOOGLE CHAT — two-way message sync
// (corrected to the real path: companies/{companyId}/jobs/{jobId}/messages,
// matching sendMessageNotificationSms above -- earlier draft had this wrong)
//
// DATA MODEL ADDITIONS:
//   companies/{companyId}/jobs/{jobId}
//     chatSpaceId  : string -- set once, first message that needs to sync
//   companies/{companyId}/chatSpaceMap/{spaceId}
//     jobId        : string -- reverse lookup for inbound Chat events
//   .../messages/{msgId} gets: syncedToChat (bool), fromChat (bool)
// ============================================================================

const CHAT_SCOPES = [
  'https://www.googleapis.com/auth/chat.bot',
  'https://www.googleapis.com/auth/chat.app.spaces', // needed to auto-create spaces; app-auth only, no domain-wide delegation
];

async function getChatClient() {
  const key = JSON.parse(process.env.CHAT_SERVICE_ACCOUNT_KEY);
  // App authentication (the app acting as itself), NOT domain-wide
  // delegation -- chat.app.spaces explicitly doesn't support user
  // impersonation. The earlier "unauthorized_client" error came from
  // wrongly adding a subject/impersonation target; removed.
  const auth = new google.auth.GoogleAuth({ credentials: key, scopes: CHAT_SCOPES });
  const client = await auth.getClient();
  return google.chat({ version: 'v1', auth: client });
}

async function getOrCreateSpaceForJob(chat, db, companyId, jobId, job) {
  if (job.chatSpaceId) return job.chatSpaceId;

  const teamDoc = await db.collection('companies').doc(companyId)
    .collection('settings').doc('team').get();
  const members = extractChatTeamMembers(teamDoc.exists ? teamDoc.data() : {});
  const memberEmails = Object.values(members).map(m => m.email).filter(Boolean);

  const space = await chat.spaces.setup({
    requestBody: {
      space: {
        displayName: `Job — ${job.name || job.jobNumber || jobId}`,
        spaceType: 'SPACE',
      },
      memberships: memberEmails.map(email => ({
        member: { name: `users/${email}`, type: 'HUMAN' },
      })),
    },
  });

  const spaceId = space.data.name;
  await db.collection('companies').doc(companyId).collection('jobs').doc(jobId)
    .update({ chatSpaceId: spaceId });
  await db.collection('companies').doc(companyId)
    .collection('chatSpaceMap').doc(spaceId.replace('spaces/', ''))
    .set({ jobId });

  return spaceId;
}

// --- OUTBOUND: JOBSMETRIX message -> Google Chat ---
exports.syncMessageToChat = functions.runWith({ secrets: ['CHAT_SERVICE_ACCOUNT_KEY'] }).firestore
  .document('companies/{companyId}/jobs/{jobId}/messages/{msgId}')
  .onCreate(async (snap, context) => {
    const msg = snap.data();
    if (msg.fromChat || msg.syncedToChat) return null;

    const { companyId, jobId } = context.params;
    const db = admin.firestore();
    const jobRef = db.collection('companies').doc(companyId).collection('jobs').doc(jobId);
    const jobDoc = await jobRef.get();
    if (!jobDoc.exists) return null;
    const job = jobDoc.data();

    const chat = await getChatClient();
    const spaceId = await getOrCreateSpaceForJob(chat, db, companyId, jobId, job);

    const visibility = msg.fromCustomer
      ? '👤 Customer'
      : msg.visibleToCustomer
        ? '💬 Team (customer-visible)'
        : '🔒 Team only';

    await chat.spaces.messages.create({
      parent: spaceId,
      requestBody: { text: `*${msg.authorName || 'Someone'}* (${visibility}):\n${msg.text}` },
    });

    await snap.ref.update({ syncedToChat: true });
    return null;
  });

// --- INBOUND: Google Chat message -> JOBSMETRIX ---
exports.syncChatToJob = functions.https.onRequest(async (req, res) => {
  const event = req.body;
  if (event.type !== 'MESSAGE') { res.json({}); return; }

  const spaceId = event.space?.name?.replace('spaces/', '');
  const senderEmail = event.message?.sender?.email || event.user?.email || '';
  const rawText = (event.message?.text || '').trim();
  if (!spaceId || !rawText) { res.json({}); return; }

  const db = admin.firestore();
  const companiesSnap = await db.collection('companies').get();
  let jobId = null, companyId = null;
  for (const companyDoc of companiesSnap.docs) {
    const mapDoc = await companyDoc.ref.collection('chatSpaceMap').doc(spaceId).get();
    if (mapDoc.exists) { jobId = mapDoc.data().jobId; companyId = companyDoc.id; break; }
  }
  if (!jobId) { res.json({ text: "I don't recognize this space as linked to a job." }); return; }

  const customerVisible = rawText.startsWith('>customer');
  const text = customerVisible ? rawText.replace(/^>customer\s*/, '') : rawText;

  await db.collection('companies').doc(companyId).collection('jobs').doc(jobId)
    .collection('messages').add({
      text,
      authorEmail: senderEmail,
      authorName: event.message?.sender?.displayName || senderEmail || 'Team (via Chat)',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdMs: Date.now(),
      companyId,
      fromCustomer: false,
      visibleToCustomer: customerVisible,
      fromChat: true,
      notifyTargets: [],
      notifyStatus: 'none',
    });

  res.json({});
});

function extractChatTeamMembers(data) {
  if (!data) return {};
  if (data.members && typeof data.members === 'object') return data.members;
  const out = {};
  Object.keys(data).forEach(k => {
    const v = data[k];
    if (v && typeof v === 'object' && (v.email || v.role)) out[k] = v;
  });
  return out;
}
// Retest: CHAT_SERVICE_ACCOUNT_KEY created + appspot SA granted Secret Accessor 2026-09-23



// ============================================================================
// GoHighLevel (GHL) webhook receiver -- single client integration for JTXD
// Contracting. Maps GHL Contact/Opportunity events into the same
// companies/{companyId}/leads collection KYTLEAD already uses (rules and
// convertLeadToJob already deployed tonight -- this just feeds it a new
// source, no new lead system built).
//
// SETUP REQUIRED on the client's GHL side (they do this, not you):
//   1. In their GHL location: Settings > Integrations > Private Integrations
//      -- create one, scopes: contacts.readonly, opportunities.readonly
//      (this integration doesn't need write access back to GHL yet)
//   2. Automation > Workflows > new workflow, trigger on Contact Created /
//      Contact Updated / Opportunity Stage Changed, action: Webhook, URL:
//      the deployed URL for ghlWebhookReceiver below
//   3. Give you their location ID (find it in GHL under Settings > Business
//      Info) -- set GHL_LOCATION_TO_COMPANY below to map it to your
//      companyId, since this receiver could in principle serve multiple
//      GHL locations later without being rebuilt
//
// Public keys are GHL's own, straight from their webhook docs (Sept 2026) --
// these are not secrets, safe to hardcode, GHL publishes them openly.
// ============================================================================

const GHL_LEGACY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAokvo/r9tVgcfZ5DysOSC
Frm602qYV0MaAiNnX9O8KxMbiyRKWeL9JpCpVpt4XHIcBOK4u3cLSqJGOLaPuXw6
dO0t6Q/ZVdAV5Phz+ZtzPL16iCGeK9po6D6JHBpbi989mmzMryUnQJezlYJ3DVfB
csedpinheNnyYeFXolrJvcsjDtfAeRx5ByHQmTnSdFUzuAnC9/GepgLT9SM4nCpv
uxmZMxrJt5Rw+VUaQ9B8JSvbMPpez4peKaJPZHBbU3OdeCVx5klVXXZQGNHOs8gF
3kvoV5rTnXV0IknLBXlcKKAQLZcY/Q9rG6Ifi9c+5vqlvHPCUJFT5XUGG5RKgOKU
J062fRtN+rLYZUV+BjafxQauvC8wSWeYja63VSUruvmNj8xkx2zE/Juc+yjLjTXp
IocmaiFeAO6fUtNjDeFVkhf5LNb59vECyrHD2SQIrhgXpO4Q3dVNA5rw576PwTzN
h/AMfHKIjE4xQA1SZuYJmNnmVZLIZBlQAF9Ntd03rfadZ+yDiOXCCs9FkHibELhC
HULgCsnuDJHcrGNd5/Ddm5hxGQ0ASitgHeMZ0kcIOwKDOzOU53lDza6/Y09T7sYJ
PQe7z0cvj7aE4B+Ax1ZoZGPzpJlZtGXCsu9aTEGEnKzmsFqwcSsnw3JB31IGKAyk
T1hhTiaCeIY/OwwwNUY2yvcCAwEAAQ==
-----END PUBLIC KEY-----`;

const GHL_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

// Map GHL location ID -> your companyId. Fill in once the client gives you
// their location ID (Settings > Business Info in their GHL account).
const GHL_LOCATION_TO_COMPANY = {
  // 'PASTE_THEIR_LOCATION_ID_HERE': 'mtOiSAzppjVbxKdHRJBH',
};

// Best-effort mapping from GHL's custom pipeline stage names to KYTLEAD's
// stage enum. GHL stage names are whatever the client typed into their own
// pipeline builder, not a fixed set -- fill this in once you see their real
// stage names (Opportunities API / their pipeline settings). Unmapped
// stages fall through to 'follow-up' rather than guessing wrong.
const GHL_STAGE_MAP = {
  // 'New Lead': 'new',
  // 'Contacted': 'contacted',
  // 'Appointment Scheduled': 'walkthrough-scheduled',
  // 'Proposal Sent': 'proposal-sent',
  // 'Won': 'signed',
  // 'Lost': 'lost',
};

function verifyGhlLegacy(payload, signature) {
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(payload);
    return verifier.verify(GHL_LEGACY_PUBLIC_KEY, signature, 'base64');
  } catch (e) { return false; }
}

function verifyGhlSignature(payload, signature) {
  try {
    const payloadBuffer = Buffer.from(payload, 'utf8');
    const signatureBuffer = Buffer.from(signature, 'base64');
    return crypto.verify(null, payloadBuffer, GHL_ED25519_PUBLIC_KEY, signatureBuffer);
  } catch (e) { return false; }
}

exports.ghlWebhookReceiver = functions.https.onRequest(async (req, res) => {
  const rawBody = JSON.stringify(req.body);
  const ghlSig = req.headers['x-ghl-signature'];
  const legacySig = req.headers['x-wh-signature'];

  const verified = ghlSig
    ? verifyGhlSignature(rawBody, ghlSig)
    : (legacySig ? verifyGhlLegacy(rawBody, legacySig) : false);

  if (!verified) {
    console.error('ghlWebhookReceiver: signature verification failed');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // Always ack fast -- GHL retries up to 12x on non-2xx, and we don't want
  // a slow Firestore write to look like a failed delivery.
  res.status(200).json({ success: true });

  try {
    const { type, data, locationId, webhookId } = req.body;
    const companyId = GHL_LOCATION_TO_COMPANY[locationId];
    if (!companyId) {
      console.warn('ghlWebhookReceiver: unmapped GHL location', locationId);
      return;
    }

    const db = admin.firestore();

    // Idempotency: skip if we've already processed this exact webhook.
    const dedupeRef = db.collection('companies').doc(companyId)
      .collection('ghlProcessedWebhooks').doc(webhookId || `${type}-${Date.now()}`);
    const dedupeDoc = await dedupeRef.get();
    if (dedupeDoc.exists) return;
    await dedupeRef.set({ processedAt: admin.firestore.FieldValue.serverTimestamp() });

    if (type === 'ContactCreate' || type === 'ContactUpdate') {
      const ghlContactId = data.id || data.contactId;
      const leadsRef = db.collection('companies').doc(companyId).collection('leads');
      const existing = await leadsRef.where('ghlContactId', '==', ghlContactId).limit(1).get();

      const leadData = {
        name: `${data.firstName || ''} ${data.lastName || ''}`.trim() || data.name || '',
        email: data.email || '',
        phone: data.phone || '',
        address: data.address1 || data.address || '',
        source: 'ghl',
        ghlContactId,
        companyId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (existing.empty) {
        leadData.stage = 'new';
        leadData.createdAt = admin.firestore.FieldValue.serverTimestamp();
        await leadsRef.add(leadData);
      } else {
        await existing.docs[0].ref.set(leadData, { merge: true });
      }
    } else if (type === 'OpportunityCreate' || type === 'OpportunityStatusUpdate' || type === 'OpportunityStageUpdate') {
      const ghlContactId = data.contactId;
      const rawStage = data.pipelineStageName || data.stageName || '';
      const mappedStage = GHL_STAGE_MAP[rawStage] || 'follow-up';

      const leadsRef = db.collection('companies').doc(companyId).collection('leads');
      const existing = await leadsRef.where('ghlContactId', '==', ghlContactId).limit(1).get();
      if (!existing.empty) {
        await existing.docs[0].ref.set({
          stage: mappedStage,
          ghlRawStage: rawStage, // keep the real GHL stage name visible too, since the mapping above is a best guess until confirmed
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    } else {
      console.log('ghlWebhookReceiver: unhandled event type', type);
    }
  } catch (err) {
    console.error('ghlWebhookReceiver: processing error', err);
    // No re-throw -- response already sent, this is just for Cloud Logging.
  }
});

// Retest: transient 'Failed to list functions' error, retrying 2026-09-28


// ============================================================================
// KYTLEAD_V1 (Travis 10/21/26) — web lead capture + morning follow-up email
// ============================================================================

// Public form endpoint used by jobsmetrix.com/lead-form.html?c=<companyId>
// (shareable link or iframe on the company website). Creates a New Lead,
// assigned to whoever gets Sales alerts (settings/notifyRouting.sales).
exports.kytleadCapture = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).send('POST only');
  const b = req.body || {};
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  // Honeypot: real people never fill the hidden "website" field.
  if (s(b.website, 200)) return res.status(200).json({ ok: true });
  const companyId = s(b.c, 60);
  const name = s(b.name, 120), phone = s(b.phone, 40);
  if (!companyId || !name || !phone) return res.status(400).json({ error: 'Name and phone are required.' });
  const db = admin.firestore();
  try {
    const co = await db.collection('companies').doc(companyId).get();
    if (!co.exists) return res.status(404).json({ error: 'Unknown company.' });
    // Light abuse guard: max 30 web leads per company per hour.
    const hourAgo = Date.now() - 3600e3;
    const recent = await db.collection('companies').doc(companyId).collection('leads')
      .where('createdMs', '>=', hourAgo).get();
    const webCount = recent.docs.filter(d => d.data().source === 'Website').length;
    if (webCount >= 30) return res.status(429).json({ error: 'Too many requests. Please call us.' });
    let owner = '';
    try {
      const r = await db.collection('companies').doc(companyId).collection('settings').doc('notifyRouting').get();
      owner = r.exists ? (r.data().sales || '') : '';
    } catch (e) {}
    // Next business day (skip Sat/Sun), Central time.
    const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const due = new Date(ct); due.setDate(due.getDate() + 1);
    while (due.getDay() === 0 || due.getDay() === 6) due.setDate(due.getDate() + 1);
    const dueStr = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
    const heard = s(b.heard, 40);
    const message = s(b.message, 2000);
    await db.collection('companies').doc(companyId).collection('leads').add({
      companyId, name, phone, email: s(b.email, 160), address: s(b.address, 240),
      type: s(b.type, 40), source: 'Website', heardFrom: heard,
      notes: [message, heard && heard !== 'Website' ? 'Heard about us: ' + heard : ''].filter(Boolean).join('\n'),
      stage: 'new', stageChangedAt: Date.now(), owner,
      nextStep: 'Call within 1 business day', nextDue: dueStr, value: 0,
      createdMs: Date.now(), createdBy: 'web-form', formPage: s(b.page, 300),
      activity: [{ type: 'note', note: 'Web form submitted' + (message ? ': ' + message.slice(0, 200) : ''), at: Date.now(), by: 'web-form' }],
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('kytleadCapture failed:', e.message);
    return res.status(500).json({ error: 'Could not save. Please call us.' });
  }
});

// Morning follow-up email, Mon–Sat 6:45am Central: each lead owner gets the
// open leads whose next step is due today or overdue, plus open leads with
// no next step. Sent through the same Gmail account as estimates and
// proposals (GMAIL_SERVICE_ACCOUNT_KEY / EMAIL_SEND_AS).
exports.kytleadMorningDigest = functions.runWith({ secrets: ['GMAIL_SERVICE_ACCOUNT_KEY'] }).pubsub
  .schedule('45 6 * * 1-6')
  .timeZone('America/Chicago')
  .onRun(async () => {
    let gmail;
    try { gmail = await getGmailClient(); }
    catch (e) { console.error('kytleadMorningDigest: Gmail setup failed', e.message); return null; }
    const db = admin.firestore();
    const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const today = `${ct.getFullYear()}-${String(ct.getMonth() + 1).padStart(2, '0')}-${String(ct.getDate()).padStart(2, '0')}`;
    const OPEN = ['new', 'contacted', 'appt', 'estimating', 'sent', 'followup'];
    const label = { new: 'New Lead', contacted: 'Contacted', appt: 'Appointment Set', estimating: 'Estimating', sent: 'Estimate Sent', followup: 'Follow-up' };
    const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
    const companies = await db.collection('companies').get();
    for (const co of companies.docs) {
      const leadsSnap = await co.ref.collection('leads').get();
      if (leadsSnap.empty) continue;
      const byOwner = {};
      leadsSnap.forEach(d => {
        const l = d.data();
        if (l.isActivityLog || !OPEN.includes(l.stage)) return;
        if (!l.nextDue && l.jobId) return; // converted: the job carries the next step
        const bucket = !l.nextDue ? 'none' : l.nextDue < today ? 'overdue' : l.nextDue === today ? 'today' : null;
        if (!bucket) return;
        const owner = (l.owner || (co.data().ownerEmail || '')).toLowerCase();
        if (!owner) return;
        (byOwner[owner] = byOwner[owner] || { overdue: [], today: [], none: [] })[bucket].push(l);
      });
      const companyName = co.data().name || 'JTXD Contracting';
      for (const [email, g] of Object.entries(byOwner)) {
        const total = g.overdue.length + g.today.length + g.none.length;
        if (!total) continue;
        const list = (title, color, arr) => arr.length ? `<h3 style="color:${color};margin:18px 0 6px">${title} (${arr.length})</h3>` + arr.map(l =>
          `<div style="padding:8px 0;border-bottom:1px solid #eee"><strong>${esc(l.name)}</strong> <span style="color:#888">· ${esc(label[l.stage] || l.stage)}</span><br>
           ${l.nextStep ? '→ ' + esc(l.nextStep) : '<em>No next step set</em>'}${l.nextDue && l.nextDue < today ? ' <span style="color:#b91c1c">(due ' + esc(l.nextDue) + ')</span>' : ''}<br>
           <span style="color:#555">${esc(l.phone || '')}${l.email ? ' · ' + esc(l.email) : ''}</span></div>`).join('') : '';
        const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#1a1a1a">
          <h2 style="color:#d97706;margin-bottom:4px">Today's follow-ups</h2>
          <div style="color:#666">${total} lead${total === 1 ? '' : 's'} need you today.</div>
          ${list('🔴 Overdue', '#b91c1c', g.overdue)}${list('🟠 Due today', '#d97706', g.today)}${list('⚠ No next step', '#b91c1c', g.none)}
          <p style="margin-top:20px"><a href="https://jobsmetrix.com/" style="background:#d97706;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open Leads in JobsMetrix</a></p>
          <p style="font-size:12px;color:#999">${esc(companyName)} · KYTLEAD morning follow-ups</p></div>`;
        try {
          const raw = buildRawMessage({
            to: email, fromName: companyName + ' Leads',
            subject: `Today's follow-ups: ${g.overdue.length} overdue, ${g.today.length} due today`,
            bodyHtml: html, bodyText: `${total} leads need follow-up today. Open JobsMetrix → Leads → Today.`,
          });
          await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
        } catch (e) { console.warn('kytleadMorningDigest send failed for', email, e.message); }
      }
    }
    return null;
  });
