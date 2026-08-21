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
// Job phases are shared across whoever's on the crew, not one person -
// push to every crew member's calendar who's connected. Tracks each
// person's Google event ID separately (gcalEventIds: {uid: eventId}),
// since one JOBSpan phase can correspond to several different Google
// Calendar events (one per crew member).
exports.pushPhaseToGCal = functions.firestore
  .document('companies/{companyId}/jobs/{jobId}/phases/{phaseId}')
  .onWrite(async (change, context) => {
    const { companyId, jobId } = context.params;
    const before = change.before.exists ? change.before.data() : null;
    const after = change.after.exists ? change.after.data() : null;

    const db = admin.firestore();
    const jobDoc = await db.collection('companies').doc(companyId).collection('jobs').doc(jobId).get();
    const job = jobDoc.exists ? jobDoc.data() : null;
    const crew = job?.crew || [];
    if (!crew.length) return null;

    const gcalEventIds = { ...(after?.gcalEventIds || before?.gcalEventIds || {}) };
    let idsChanged = false;

    for (const member of crew) {
      if (!member.email) continue;
      const uid = await getUidForEmail(member.email);
      if (!uid) continue;
      const cal = await getCalendarClientForUser(companyId, uid);
      if (!cal) continue;

      if (!after) {
        // Phase deleted - remove from this person's calendar if we'd pushed one.
        if (gcalEventIds[uid]) {
          try { await cal.events.delete({ calendarId: 'primary', eventId: gcalEventIds[uid] }); }
          catch (e) { console.warn('gcal phase delete failed:', e.message); }
        }
        continue;
      }

      const eventBody = {
        summary: `${after.name || 'Phase'} — ${job.name || 'Job'}`,
        description: `JOBSpan job phase${job.jobNumber ? ' (' + job.jobNumber + ')' : ''}`,
        start: { date: after.startDate },
        end: { date: after.endDate || after.startDate }
      };

      try {
        if (gcalEventIds[uid]) {
          await cal.events.update({ calendarId: 'primary', eventId: gcalEventIds[uid], requestBody: eventBody });
        } else {
          const created = await cal.events.insert({ calendarId: 'primary', requestBody: eventBody });
          gcalEventIds[uid] = created.data.id;
          idsChanged = true;
        }
      } catch (e) {
        console.error('pushPhaseToGCal failed for', member.email, ':', e.message);
      }
    }

    if (after && idsChanged) {
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
  const hex = (functions.config().qbo || {}).token_encryption_key;
  if (!hex || hex.length !== 64) {
    throw new Error('QuickBooks token encryption key is missing or invalid (functions.config().qbo.token_encryption_key must be a 32-byte hex string). See DEPLOY_QBO.md.');
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
  const cfg = functions.config().qbo || {};
  if (!cfg.client_id || !cfg.client_secret || !cfg.redirect_uri) return null;
  return {
    clientId: cfg.client_id,
    clientSecret: cfg.client_secret,
    redirectUri: cfg.redirect_uri,
    environment: cfg.environment === 'production' ? 'production' : 'sandbox'
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
exports.qbOAuthStart = functions.https.onRequest(async (req, res) => {
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
exports.qbOAuthCallback = functions.https.onRequest(async (req, res) => {
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
exports.qbDisconnect = functions.https.onCall(async (data, context) => {
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

  const total = prop.snapshot?.grandTotal || 0;
  const itemId = await getDefaultQboItemId(companyId);
  const payload = {
    CustomerRef: { value: qbCustomerId },
    Line: [{
      Amount: total,
      DetailType: 'SalesItemLineDetail',
      Description: 'JOBSpan Estimate',
      SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: total }
    }]
  };
  const created = await qboFetch(companyId, 'POST', 'estimate', payload);
  const qbId = created?.Estimate?.Id;
  if (qbId) await propDoc.ref.update({ qbEstimateId: qbId });
  return qbId;
}

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
  if (amtPaid > lastSynced) {
    const deltaAmt = amtPaid - lastSynced;
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

exports.qbCreateInvoice = functions.https.onCall(async (data, context) => {
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
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
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
    personalizations: [{ to: [{ email: customerEmail, name: customerName }] }],
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

    const twilioSetup = getTwilioClient();
    if (!twilioSetup) {
      console.warn('Twilio not configured (functions.config().twilio missing) - skipping SMS, marking as skipped.');
      return snap.ref.update({ notifyStatus: 'skipped_no_twilio_config' });
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
        await twilioSetup.client.messages.create({
          body: smsBody,
          from: twilioSetup.from,
          to: target.phone
        });
        results.push({ ...target, status: 'sent' });
      } catch (err) {
        console.error('Twilio send failed for', target.phone, err.message);
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
exports.sendJobspanEmail = functions.https.onCall(async (data, context) => {
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
      to: [{ email: to, name: toName || to }]
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

// ════════════════════════════════════════════════════
// ── dailyKpiRefresh ──────────────────────────────────
// Runs every day at 6am CT, pulls MTD financials from QBO,
// writes to companies/{companyId}/kpiCache/mtd so the dashboard
// can read instantly without live API calls on page load.
// ════════════════════════════════════════════════════
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
          'high', owners, `${jobId}_estimate_cold`);
      } else if (days >= 3) {
        await createTodo(jobId, jobName,
          `Follow up on ${jobName} estimate — sent ${days} days ago`,
          'med', owners, `${jobId}_estimate_followup`);
      }
    }

    // Scheduling SLA
    if (['To Be Scheduled', 'Permitting'].includes(status)) {
      const days = daysSince(job.statusDate || job.approvedAt);
      if (days === null) continue;
      if (days >= 10) {
        await createTodo(jobId, jobName,
          `URGENT: ${jobName} still unscheduled after ${days} days`,
          'high', owners, `${jobId}_schedule_escalation`);
      } else if (days >= 5) {
        await createTodo(jobId, jobName,
          `Schedule crew for ${jobName} — ${days} days since approval`,
          'med', owners, `${jobId}_schedule_crew`);
      }
    }

    // Inspection SLA
    if (status === 'Inspection Pending') {
      const days = daysSince(job.statusDate || job.inspectionDate);
      if (days === null) continue;
      if (days >= 5) {
        await createTodo(jobId, jobName,
          `URGENT: Inspection pending ${days} days on ${jobName}`,
          'high', owners, `${jobId}_inspection_escalation`);
      } else if (days >= 2) {
        await createTodo(jobId, jobName,
          `Follow up on inspection for ${jobName} — ${days} days pending`,
          'med', owners, `${jobId}_inspection_followup`);
      }
    }

    // Invoice SLA
    if (status === 'Complete') {
      const days = daysSince(job.completedAt || job.statusDate);
      if (days === null) continue;
      if (days >= 45) {
        await createTodo(jobId, jobName,
          `Invoice 15 days past due — ${jobName} (${days} days since completion)`,
          'high', owners, `${jobId}_invoice_pastdue15`);
      } else if (days >= 30) {
        await createTodo(jobId, jobName,
          `Invoice overdue — ${jobName} (${days} days since completion)`,
          'high', owners, `${jobId}_invoice_overdue`);
      } else if (days >= 25) {
        await createTodo(jobId, jobName,
          `Invoice due in 5 days — ${jobName}`,
          'med', owners, `${jobId}_invoice_due5`);
      }
    }

    // No daily log 2+ days on an active job — mirrors the 🟡 flag
    // already shown on the JOBSMETRIX home dashboard's Active Jobs
    // table, just surfaced proactively instead of only-if-you-look.
    if (!['Closed Completed', 'Closed Lost', 'Submitted', 'To Be Scheduled', 'Permitting'].includes(status)) {
      const logDays = daysSince(job.lastLogDate);
      if (logDays !== null && logDays >= 3) {
        await createTodo(jobId, jobName,
          `No daily log on ${jobName} in ${logDays} days`,
          'high', owners, `${jobId}_no_log_${todayStr}`);
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
        'high', owners, `${companyId}_unprocessed_cos_${todayStr}`);
    }
  } catch(e) {}

  // Outstanding invoices total, company-wide — reuses the same
  // "$10k+ is red" threshold the dashboard tile already uses.
  if (outstandingInvoiceTotal >= 10000) {
    await createTodo(companyId, 'Company-wide',
      `Outstanding invoices total $${Math.round(outstandingInvoiceTotal).toLocaleString()} — above your $10k threshold`,
      'high', owners, `${companyId}_outstanding_threshold_${todayStr}`);
  }

  console.log(`SLA triggers complete for ${companyId}`);
}
