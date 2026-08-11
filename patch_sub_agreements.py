#!/usr/bin/env python3
"""
Adds a Subcontractor Agreement e-signature system to JOBSMETRIX, mirroring
the existing Lien Waiver pattern exactly (same portal token, canvas
signature pad, and E-SIGN audit fields).

New pieces:
  - buildSubAgreementText() / sendSubAgreement() / showSubAgreementSendDialog()
    / emailSubAgreement()  -- the "send" side, inserted after the Lien
    Waiver system
  - renderPortalSubAgreement() / clearPortalSubAgreementSignature() /
    submitPortalSubAgreement()  -- the portal-facing "sign" side, inserted
    after the Lien Waiver portal functions
  - ?subagreement= URL param handling in loadPortalJob()
  - a "\u270d\ufe0f Agreement" button on each sub card in the Subs tab
  - after a bid is awarded, offers to send the agreement immediately
    instead of the old dead-end Purchase Order alert
  - on signature: sets that sub's status to 'Contracted', logs activity,
    and pushes a PlannerXD notification (reusing the existing bridge --
    no PlannerXD-side changes needed)

Run from inside the JOBSpan repo folder:
    python3 patch_sub_agreements.py

Reminder after this runs: you still need to add a Firestore security rule
allowing anonymous portal writes to the new subAgreements collection --
this script cannot deploy that for you.
"""

import shutil
import sys

FILE = "kytrac-app.js"
BACKUP = "kytrac-app.js.bak"

def load():
    with open(FILE, encoding="utf-8") as f:
        return f.read()

def save(text):
    with open(FILE, "w", encoding="utf-8") as f:
        f.write(text)

def apply_patch(text, name, old, new, required=True):
    count = text.count(old)
    if count == 0:
        print(f"  \u2717 SKIPPED: '{name}' \u2014 anchor not found. {'Insert manually.' if required else '(optional patch, safe to skip)'}")
        return text, False
    if count > 1:
        print(f"  \u2717 SKIPPED: '{name}' \u2014 anchor found {count} times (not unique). Insert manually.")
        return text, False
    text = text.replace(old, new, 1)
    print(f"  \u2713 Applied: {name}")
    return text, True

def main():
    print(f"Backing up {FILE} -> {BACKUP}")
    shutil.copyfile(FILE, BACKUP)

    text = load()
    all_ok = True

    # ── Patch 1: Send-side functions, inserted right after the Lien
    #     Waiver system's window export (clean ASCII anchor, no risk
    #     of the separator-character mismatch that bit us in PlannerXD) ──
    old = "window.sendLienWaiver = sendLienWaiver;"
    new = old + '''

// ════════════════════════════════════════════════════
// ── SUBCONTRACTOR AGREEMENT SYSTEM ──
// Mirrors the Lien Waiver system above: pre-filled document, sent via
// the same Customer Portal token link, signed on the same canvas pad,
// stored under jobs/{jobId}/subAgreements/{agreementId}. Auto-populated
// from the sub's existing record (name, trade, contract amount) the
// same way lien waivers auto-populate from invoice data.
// ════════════════════════════════════════════════════

function buildSubAgreementText(sub, job, co) {
  const companyName = co.companyName || co.legalName || 'TDX Holdings LLC dba JTXD Contracting';
  const jobName = job.name || 'Project';
  const jobAddress = job.address || 'Address on File';
  const subName = sub.name || 'Subcontractor';
  const trade = sub.trade || 'General Labor';
  // Defensive: bid-award flow currently writes the amount to `contract`,
  // while the sub card and this agreement read `amount` -- support both
  // so an existing data quirk doesn't produce a $0 agreement.
  const amount = sub.amount || sub.contract || 0;
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const amtStr = Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return [
    'SUBCONTRACTOR AGREEMENT',
    '',
    `Agreement Date: ${today}`,
    `Company: ${companyName}`,
    `Subcontractor: ${subName}`,
    `Trade: ${trade}`,
    `Project: ${jobName}`,
    `Project Address: ${jobAddress}`,
    `Contract Price: $${amtStr}`,
    '',
    `This Subcontractor Agreement ("Agreement") is entered into as of the Agreement Date above by and between ${companyName} ("Company") and ${subName} ("Subcontractor").`,
    '',
    `1. SCOPE OF WORK. Subcontractor agrees to furnish all labor, materials (unless otherwise agreed in writing), equipment, and supervision necessary to perform ${trade} work at ${jobAddress}, in accordance with the agreed scope for this project.`,
    '',
    `2. CONTRACT PRICE. The total contract price for the Work is $${amtStr}, payable per Company's standard payment schedule upon completion of agreed milestones and Company's acceptance of the Work.`,
    '',
    '3. INDEPENDENT CONTRACTOR STATUS. Subcontractor is retained as an independent contractor and not as an employee, agent, joint venturer, or partner of Company. Subcontractor shall determine the means and methods of performing the Work, shall furnish its own tools and equipment unless otherwise agreed, and is solely responsible for its own taxes and for the wages, taxes, and benefits of any individuals it employs or engages. Nothing in this Agreement creates an employer-employee relationship between Company and Subcontractor or Subcontractor\\'s employees, agents, or lower-tier subcontractors.',
    '',
    '4. LICENSES AND COMPLIANCE. Subcontractor represents that it holds, and shall maintain, all licenses, permits, and certifications required by law to perform the Work, and shall comply with all applicable building codes, safety regulations (including OSHA), and municipal ordinances.',
    '',
    '5. CHANGE ORDERS. No changes to the Scope of Work or Contract Price are effective unless agreed in writing by both parties before the additional work is performed.',
    '',
    '6. INSURANCE AND INDEMNIFICATION. Subcontractor shall maintain commercial general liability insurance and workers\\' compensation insurance as required by law, and shall provide Company with a certificate of insurance upon request. Subcontractor shall indemnify, defend, and hold harmless Company from claims, damages, or losses arising out of Subcontractor\\'s negligent acts, omissions, or breach of this Agreement, except to the extent caused by Company\\'s own negligence.',
    '',
    '7. WARRANTY. Subcontractor warrants that the Work shall be free from defects in materials and workmanship for one (1) year from substantial completion, and shall promptly correct, at its own expense, any Work found defective during that period, ordinary wear and tear excepted.',
    '',
    '8. TERMINATION. Company may terminate this Agreement for cause upon written notice if Subcontractor fails to cure a material breach within ten (10) days of notice. Company may terminate for convenience upon written notice, in which case Subcontractor shall be paid for Work satisfactorily performed prior to termination.',
    '',
    '9. GOVERNING LAW. This Agreement shall be governed by the laws of the State of Missouri.',
    '',
    '10. ENTIRE AGREEMENT. This Agreement constitutes the entire agreement between the parties regarding the Work and supersedes all prior negotiations or representations, whether written or oral. This Agreement may only be amended in writing signed by both parties.',
    '',
    'By signing below, Subcontractor acknowledges having read and agreed to the terms of this Agreement, and that Subcontractor\\'s electronic signature is legally binding under the federal Electronic Signatures in Global and National Commerce Act (E-SIGN).',
  ].join('\\n');
}

async function sendSubAgreement(jobId, subId) {
  if (!conDb || !jobId || !subId) return;

  const job = conJobs.find(j => j.id === jobId);
  if (!job) { alert('Job not found.'); return; }

  let sub = null;
  try {
    const subDocSnap = await coll('jobs').doc(jobId).collection('subs').doc(subId).get();
    if (subDocSnap.exists) sub = { id: subDocSnap.id, ...subDocSnap.data() };
  } catch(e) {}
  if (!sub) { alert('Subcontractor record not found.'); return; }

  const agreementText = buildSubAgreementText(sub, job, companyProfile);
  const hash = await sha256(agreementText);

  const agreementData = {
    jobId,
    jobName: job.name || '',
    subId,
    subName: sub.name || '',
    subEmail: sub.email || '',
    trade: sub.trade || '',
    amount: sub.amount || sub.contract || 0,
    documentText: agreementText,
    documentHash: hash,
    status: 'pending', // pending | signed | declined
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    createdBy: conCurrentUser?.email || '',
  };

  try {
    const ref = await coll('jobs').doc(jobId).collection('subAgreements').add({
      ...agreementData,
      companyId: currentCompanyId || null,
    });
    const agreementId = ref.id;

    // Reuse existing portal token for this job if one exists (same
    // pattern as sendLienWaiver / sendProposalViaEmail).
    let token;
    try {
      const snap = await conDb.collection('portalTokens')
        .where('jobId','==',jobId).limit(1).get();
      if (!snap.empty) {
        token = snap.docs[0].id;
      } else {
        token = jobId + '-hash-' + Math.random().toString(36).slice(2,10);
        await conDb.collection('portalTokens').doc(token).set({
          jobId, companyId: currentCompanyId || null,
          created: Date.now(), createdBy: conCurrentUser?.email || '',
          expires: null, shareInvoices: true
        });
      }
    } catch(tokenErr) {
      token = jobId + '-hash-' + Math.random().toString(36).slice(2,10);
      await conDb.collection('portalTokens').doc(token).set({
        jobId, companyId: currentCompanyId || null,
        created: Date.now(), createdBy: conCurrentUser?.email || '',
        expires: null, shareInvoices: true
      });
    }

    const portalUrl = `${location.origin}${location.pathname}?portal=${token}&subagreement=${agreementId}`;

    showSubAgreementSendDialog({
      agreementId, jobId, portalUrl,
      subName: sub.name || 'Subcontractor',
      subEmail: sub.email || '',
      trade: sub.trade || '',
      amount: sub.amount || sub.contract || 0,
    });
  } catch(e) {
    alert('Error creating subcontractor agreement: ' + e.message);
  }
}
window.sendSubAgreement = sendSubAgreement;

function showSubAgreementSendDialog({ agreementId, jobId, portalUrl, subName, subEmail, trade, amount }) {
  const existing = document.getElementById('subAgreementSendModal');
  if (existing) existing.remove();

  const amtStr = amount ? ' \\u2014 $' + Number(amount).toLocaleString(undefined, {minimumFractionDigits:2}) : '';
  const tradeStr = trade ? ` (${trade}${amtStr})` : amtStr;

  const modal = document.createElement('div');
  modal.id = 'subAgreementSendModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:#0d1f35;border:1px solid var(--line);border-radius:16px;padding:28px;max-width:480px;width:100%">
      <div style="font-size:1.1rem;font-weight:800;color:#eaf0fb;margin-bottom:4px">\\u270d\\ufe0f Send Subcontractor Agreement</div>
      <div style="font-size:.8rem;color:var(--muted);margin-bottom:20px">${esc(subName)}${tradeStr}</div>

      <div style="margin-bottom:14px">
        <label style="font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700;display:block;margin-bottom:6px">Subcontractor Email</label>
        <input id="subAgreementSendEmail" value="${esc(subEmail)}" placeholder="sub@email.com"
          style="width:100%;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:rgba(8,18,36,.6);color:#eaf0fb;font-size:.9rem;box-sizing:border-box">
      </div>

      <div style="margin-bottom:20px">
        <label style="font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700;display:block;margin-bottom:6px">Message (optional)</label>
        <textarea id="subAgreementSendNote" rows="3" placeholder="Hi ${esc(subName)}, please review and sign the attached subcontractor agreement..."
          style="width:100%;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:rgba(8,18,36,.6);color:#eaf0fb;font-size:.85rem;box-sizing:border-box;resize:vertical"></textarea>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button onclick="emailSubAgreement('${agreementId}','${jobId}','${portalUrl.replace(/'/g,"\\\\'")}','${esc(subName).replace(/'/g,"\\\\'")}','${tradeStr.replace(/'/g,"\\\\'")}'); document.getElementById('subAgreementSendModal').remove();"
          class="btn-amber" style="flex:1;padding:10px;font-weight:700">\\u2709\\ufe0f Send Email</button>
        <button onclick="navigator.clipboard.writeText('${portalUrl.replace(/'/g,"\\\\'")}').then(()=>{this.textContent='\\u2713 Copied!';setTimeout(()=>this.textContent='\\ud83d\\udccb Copy Link',2000)})"
          class="btn" style="padding:10px;font-weight:700">\\ud83d\\udccb Copy Link</button>
        <button onclick="document.getElementById('subAgreementSendModal').remove()" class="btn" style="padding:10px">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}
window.showSubAgreementSendDialog = showSubAgreementSendDialog;

async function emailSubAgreement(agreementId, jobId, portalUrl, subName, tradeStr) {
  const emailEl = document.getElementById('subAgreementSendEmail');
  const noteEl = document.getElementById('subAgreementSendNote');
  const to = emailEl ? emailEl.value.trim() : '';
  const note = noteEl ? noteEl.value.trim() : '';

  if (!to) { alert('Please enter the subcontractor email address.'); return; }

  const subject = 'Subcontractor Agreement \\u2014 Signature Required';
  const customNote = note || 'Please review and sign the subcontractor agreement for this job.';

  const bodyHtml = `
    <h2 style="color:#d97706;margin-top:0">Subcontractor Agreement</h2>
    <p>Hi ${subName},</p>
    <p>${customNote}${tradeStr ? '<br><strong>' + tradeStr.trim() + '</strong>' : ''}</p>
    <p>Please click the button below to review and e-sign your subcontractor agreement. Your signature is legally binding under the federal E-SIGN Act.</p>
    <div style="text-align:center;margin:28px 0">
      <a href="${portalUrl}" style="background:#d97706;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:1rem;display:inline-block">
        \\u270d\\ufe0f Review &amp; Sign Agreement
      </a>
    </div>
    <p style="font-size:.85rem;color:#666">Or copy this link into your browser:<br>
      <a href="${portalUrl}" style="color:#d97706;word-break:break-all">${portalUrl}</a>
    </p>`;

  const bodyText = `Hi ${subName},\\n\\n${customNote}\\n\\nPlease sign your subcontractor agreement here:\\n${portalUrl}`;

  try {
    if (!conFunctions) throw new Error('Functions not available');
    const sendEmail = conFunctions.httpsCallable('sendJobspanEmail');
    await sendEmail({ to, toName: subName, subject, bodyHtml, bodyText, docType: 'subAgreement', jobId });
    alert('Subcontractor agreement sent to ' + to + '.');
  } catch(e) {
    alert('Error sending email: ' + e.message + '\\n\\nYou can still copy the link and send it manually.');
  }
}
window.emailSubAgreement = emailSubAgreement;'''
    text, ok = apply_patch(text, "Send-side subcontractor agreement functions", old, new)
    all_ok &= ok

    # ── Patch 2: Portal-side (sign) functions, after Lien Waiver's
    #     portal export -- same safe clean-ASCII anchor approach ──
    old = "window.submitPortalLienSignature = submitPortalLienSignature;"
    new = old + '''

// ── Portal Subcontractor Agreement: view + e-signature capture ──
// Mirrors renderPortalLienWaiver / submitPortalLienSignature exactly.
function renderPortalSubAgreement(agreementId) {
  if (!_portalDb || !_portalCompanyId || !_portalJobId) return;

  const agreementColl = _portalDb
    .collection('companies').doc(_portalCompanyId)
    .collection('jobs').doc(_portalJobId)
    .collection('subAgreements');

  agreementColl.doc(agreementId).get().then(doc => {
    if (!doc.exists) return;
    const agreement = { id: doc.id, ...doc.data() };

    let section = document.getElementById('portalSubAgreementSection');
    if (!section) {
      section = document.createElement('div');
      section.id = 'portalSubAgreementSection';
      section.className = 'portal-section';
      const msgSection = document.getElementById('portalMessageSection');
      if (msgSection) msgSection.parentNode.insertBefore(section, msgSection);
      else document.getElementById('ktPortalView')?.appendChild(section);
    }
    section.style.display = 'block';

    if (agreement.status === 'signed') {
      section.innerHTML = `
        <div class="portal-section-head">\\u270d\\ufe0f Subcontractor Agreement</div>
        <div style="color:#1dbb87;font-weight:700;margin-bottom:8px">\\u2705 Signed</div>
        <div style="font-size:.82rem;color:var(--muted)">Signed by ${esc(agreement.signedByName||'subcontractor')}
          ${agreement.signedAt ? ' on ' + new Date(agreement.signedAt).toLocaleDateString() : ''}.
        </div>
        ${agreement.signatureDataUrl ? `<img src="${agreement.signatureDataUrl}" style="height:50px;margin-top:10px;background:#fff;border-radius:4px;padding:4px">` : ''}`;
      return;
    }

    if (agreement.status === 'declined') {
      section.innerHTML = `
        <div class="portal-section-head">\\u270d\\ufe0f Subcontractor Agreement</div>
        <div style="color:#ef5350;font-weight:700">Declined</div>
        <div style="font-size:.82rem;color:var(--muted);margin-top:4px">
          ${agreement.declineReason ? esc(agreement.declineReason) : 'No reason provided.'}
        </div>`;
      return;
    }

    agreementColl.doc(agreementId).update({
      viewedAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastPortalToken: _portalToken || ''
    }).catch(() => {});

    section.innerHTML = `
      <div class="portal-section-head">\\u270d\\ufe0f Subcontractor Agreement \\u2014 Signature Required</div>
      <div style="background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.2);border-radius:10px;padding:16px;margin-bottom:16px">
        <div style="font-size:.72rem;color:var(--amber);font-weight:800;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Document</div>
        <pre style="font-size:.75rem;color:var(--muted);white-space:pre-wrap;word-break:break-word;line-height:1.6;font-family:inherit">${esc(agreement.documentText||'')}</pre>
      </div>
      <div style="font-size:.78rem;color:var(--muted);margin-bottom:14px;line-height:1.55">
        By signing below, you acknowledge that you have read and agree to the terms of this
        Subcontractor Agreement and that your electronic signature is legally binding under the
        federal Electronic Signatures in Global and National Commerce Act (E-SIGN).
      </div>
      <div style="margin-bottom:10px">
        <input id="portalSubAgreementSigName" placeholder="Type your full legal name"
          style="width:100%;max-width:460px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:rgba(8,18,36,.6);color:#eaf0fb;font-size:.9rem" />
      </div>
      <canvas id="portalSubAgreementSigCanvas" class="portal-sig-canvas" style="width:100%;max-width:460px;height:120px;border:1px solid var(--line);border-radius:8px;background:#fff;display:block;margin-bottom:10px"></canvas>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" style="padding:6px 14px;font-size:.8rem" onclick="clearPortalSubAgreementSignature()">Clear</button>
        <button class="btn-amber" style="padding:9px 20px;font-size:.88rem" onclick="submitPortalSubAgreement('${agreementId}','approved')">\\u2713 Sign &amp; Submit</button>
        <button class="btn" style="padding:9px 20px;font-size:.88rem;color:#ef5350" onclick="submitPortalSubAgreement('${agreementId}','declined')">Decline</button>
      </div>`;

    const canvas = document.getElementById('portalSubAgreementSigCanvas');
    if (canvas) {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = (rect.width || 460) * ratio;
      canvas.height = (rect.height || 120) * ratio;
      const ctx = canvas.getContext('2d');
      ctx.scale(ratio, ratio);
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      window._subAgreementSigCtx = ctx;
      window._subAgreementSigDrawing = false;
      window._subAgreementSigHasStroke = false;

      function pos(e) {
        const r = canvas.getBoundingClientRect();
        const t = e.touches ? e.touches[0] : e;
        return { x: (t.clientX - r.left), y: (t.clientY - r.top) };
      }
      function start(e) { e.preventDefault(); window._subAgreementSigDrawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
      function move(e) { if (!window._subAgreementSigDrawing) return; e.preventDefault(); const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); window._subAgreementSigHasStroke = true; }
      function end() { window._subAgreementSigDrawing = false; }
      canvas.onmousedown = start; canvas.onmousemove = move; canvas.onmouseup = end; canvas.onmouseleave = end;
      canvas.ontouchstart = start; canvas.ontouchmove = move; canvas.ontouchend = end;
    }
  }).catch(() => {});
}
window.renderPortalSubAgreement = renderPortalSubAgreement;

function clearPortalSubAgreementSignature() {
  const canvas = document.getElementById('portalSubAgreementSigCanvas');
  if (canvas && window._subAgreementSigCtx) {
    window._subAgreementSigCtx.clearRect(0, 0, canvas.width, canvas.height);
    window._subAgreementSigHasStroke = false;
  }
}
window.clearPortalSubAgreementSignature = clearPortalSubAgreementSignature;

async function submitPortalSubAgreement(agreementId, action) {
  if (!_portalDb || !_portalCompanyId || !_portalJobId) return;

  const agreementRef = _portalDb
    .collection('companies').doc(_portalCompanyId)
    .collection('jobs').doc(_portalJobId)
    .collection('subAgreements').doc(agreementId);

  if (action === 'declined') {
    const reason = prompt('Optional: let us know why (or leave blank).') || '';
    try {
      await agreementRef.update({
        status: 'declined',
        declineReason: reason,
        signedAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastPortalToken: _portalToken || ''
      });
      renderPortalSubAgreement(agreementId);
    } catch(e) { alert('Error: ' + e.message); }
    return;
  }

  const nameEl = document.getElementById('portalSubAgreementSigName');
  const name = nameEl ? nameEl.value.trim() : '';
  if (!name) { alert('Please type your full legal name before signing.'); return; }
  if (!window._subAgreementSigHasStroke) { alert('Please sign in the box before submitting.'); return; }

  const canvas = document.getElementById('portalSubAgreementSigCanvas');
  const sigDataUrl = canvas ? canvas.toDataURL('image/png') : '';

  const signerIp = await fetch('https://api.ipify.org?format=json')
    .then(r => r.json()).then(d => d.ip).catch(() => 'unavailable');

  try {
    const agreementSnap = await agreementRef.get();
    const agreement = agreementSnap.exists ? agreementSnap.data() : {};

    await agreementRef.update({
      status: 'signed',
      signedByName: name,
      signatureDataUrl: sigDataUrl,
      signerIp,
      signedAt: firebase.firestore.FieldValue.serverTimestamp(),
      signedAtMs: Date.now(),
      lastPortalToken: _portalToken || ''
    });
    renderPortalSubAgreement(agreementId);

    const db = _portalDb;
    const companyId = _portalCompanyId;
    const jobId = _portalJobId;
    const jobRef = db.collection('companies').doc(companyId).collection('jobs').doc(jobId);
    const now = firebase.firestore.FieldValue.serverTimestamp();
    const nowMs = Date.now();
    const todayDateStr = new Date().toISOString().split('T')[0];

    // Confirmed decision: reuse the existing sub status field rather
    // than adding a new flag -- 'Contracted' already exists as one of
    // the defined statuses shown on the sub card.
    if (agreement.subId) {
      jobRef.collection('subs').doc(agreement.subId).update({ status: 'Contracted' }).catch(() => {});
    }

    jobRef.collection('logs').add({
      type: 'sub_agreement_signed',
      notes: 'Subcontractor agreement signed \\u2014 ' + name + (agreement.subName ? ' (' + agreement.subName + ')' : ''),
      jobId, companyId, createdAt: now, createdMs: nowMs, date: todayDateStr, createdBy: 'customer-portal'
    }).catch(() => {});

    // PlannerXD notification -- identical bridge to proposal signing,
    // no PlannerXD-side changes needed since it listens generically.
    try {
      db.collection('companies').doc(companyId).collection('settings').doc('company').get()
        .then(settDoc => {
          const ownerUid = settDoc.exists ? settDoc.data().ownerUid : null;
          if (!ownerUid) {
            jobRef.collection('logs').add({
              type: 'plannerxd_push_skipped',
              notes: 'PlannerXD notification skipped \\u2014 no ownerUid set on company settings.',
              jobId, companyId, createdAt: now, createdMs: nowMs, date: todayDateStr, createdBy: 'customer-portal'
            }).catch(()=>{});
            return;
          }
          db.collection('plannerxd_notifications').doc(ownerUid)
            .collection('items').add({
              type: 'sub_agreement_signed',
              title: 'Subcontractor Signed Agreement',
              body: (agreement.subName || 'Subcontractor') + ' signed the agreement for ' + (agreement.jobName || 'the job') + '. Ready to schedule.',
              jobId, companyId, actionLabel: 'Open Job',
              createdAt: now, createdMs: nowMs, read: false
            }).then(() => {
              jobRef.collection('logs').add({
                type: 'plannerxd_push_sent',
                notes: 'PlannerXD notified \\u2014 subcontractor confirmation pushed to Do First.',
                jobId, companyId, createdAt: now, createdMs: nowMs, date: todayDateStr, createdBy: 'customer-portal'
              }).catch(()=>{});
            }).catch(e => {
              jobRef.collection('logs').add({
                type: 'plannerxd_push_failed',
                notes: 'PlannerXD notification failed: ' + e.message,
                jobId, companyId, createdAt: now, createdMs: nowMs, date: todayDateStr, createdBy: 'customer-portal'
              }).catch(()=>{});
            });
        }).catch(() => {});
    } catch(e) {}
  } catch(e) { alert('Error submitting signature: ' + e.message); }
}
window.submitPortalSubAgreement = submitPortalSubAgreement;'''
    text, ok = apply_patch(text, "Portal-side (sign) subcontractor agreement functions", old, new)
    all_ok &= ok

    # ── Patch 3: URL dispatch -- add ?subagreement= handling alongside
    #     the existing ?waiver= handling in loadPortalJob() ──
    old = '''      // Load lien waiver if ?waiver= param is present in the URL
      const urlWaiverId = new URLSearchParams(location.search).get('waiver');
      if (urlWaiverId) {
        // Small delay so portal sections are in the DOM first
        setTimeout(() => renderPortalLienWaiver(urlWaiverId), 400);
      }'''
    new = old + '''

      // Load subcontractor agreement if ?subagreement= param is present
      const urlSubAgreementId = new URLSearchParams(location.search).get('subagreement');
      if (urlSubAgreementId) {
        setTimeout(() => renderPortalSubAgreement(urlSubAgreementId), 400);
      }'''
    text, ok = apply_patch(text, "?subagreement= URL param dispatch", old, new)
    all_ok &= ok

    # ── Patch 4: "Agreement" button on each sub card in the Subs tab ──
    old = '''<button class="btn" style="padding:4px 10px;font-size:.76rem" onclick="openEditSub('${s.id}')">Edit</button>'''
    new = old + '''
        <button class="btn-amber" style="padding:4px 10px;font-size:.76rem" onclick="sendSubAgreement('${conCurrentJobId}','${s.id}')">\\u270d\\ufe0f Agreement</button>'''
    text, ok = apply_patch(text, "'Send Agreement' button on sub cards", old, new)
    all_ok &= ok

    # ── Patch 5 (optional): after a bid is awarded, offer to send the
    #     agreement immediately instead of the old dead-end PO alert.
    #     Whitespace-sensitive block -- if this one gets skipped, it's
    #     a nice-to-have, not required for the core system to work; the
    #     manual "Agreement" button from Patch 4 covers the same need. ──
    old = '''          coll('jobs').doc(conCurrentJobId).collection('subs').add(subDoc(subData))
            .then(() => {
              renderSubList();
              alert(`\U0001f3c6 Bid awarded to ${vendor.name} for $${amount.toLocaleString()}!

They have been added to the job's subcontractors.

Would you like to create a Purchase Order?`);
            });'''
    new = '''          coll('jobs').doc(conCurrentJobId).collection('subs').add(subDoc(subData))
            .then(docRef => {
              renderSubList();
              if (confirm(`\U0001f3c6 Bid awarded to ${vendor.name} for $${amount.toLocaleString()}!\\n\\nThey have been added to the job's subcontractors.\\n\\nSend them the Subcontractor Agreement now for e-signature?`)) {
                sendSubAgreement(conCurrentJobId, docRef.id);
              }
            });'''
    text, ok = apply_patch(text, "Auto-offer agreement send after bid award (optional)", old, new, required=False)
    all_ok_soft = ok  # tracked separately, doesn't block the "all required patches OK" message

    save(text)

    print()
    print("Core patches (1-4) are required for the system to work.")
    print("Patch 5 is a convenience -- if skipped, use the new 'Agreement'")
    print("button on the sub card instead (Patch 4) after awarding a bid.")
    print()
    if all_ok:
        print("All required patches applied. Backup saved as kytrac-app.js.bak")
        print()
        print("STILL NEEDED (manual, can't be scripted from here):")
        print("  1. Add a Firestore security rule allowing anonymous portal")
        print("     writes to companies/{companyId}/jobs/{jobId}/subAgreements/{id}")
        print("     -- share your current lienWaivers rule and I'll mirror it exactly.")
        print("  2. Syntax-check with node --check, same as always.")
        print("  3. Click through: award a bid (or use the new Agreement button on")
        print("     an existing sub), send the agreement, open the portal link in an")
        print("     incognito window to sign it as the sub would, confirm the sub's")
        print("     status flips to Contracted and a PlannerXD notification appears.")
    else:
        print("Some REQUIRED patches were SKIPPED (see \\u2717 above marked without")
        print("'(optional patch)'). Do not commit until reviewed against")
        print("kytrac-app.js.bak and applied by hand.")
        sys.exit(1)

if __name__ == "__main__":
    main()
