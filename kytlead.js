// ═══════════════════════════════════════════════════════════════════════
// KYTLEAD v1 — sales pipeline / CRM inside JOBSMETRIX (Travis 10/21/26)
//
// Data: companies/{companyId}/leads/{leadId} (rules already deployed).
// Activities live in an array on the lead doc (lead.activity) so the
// pipeline, Today list and Scorecard all come from one live listener.
// Standalone sales activity (hipshots, lunches not tied to a lead) goes on
// one hidden per-person "log" lead (isActivityLog: true).
//
// A lead becomes a JOBSMETRIX job with "Convert to Job" (stored as
// lead.jobId -- NOT convertedJobId, which belongs to the old server-side
// convertLeadToJob trigger; stage keys never use 'signed' so that trigger
// never fires). After conversion the lead's stage follows the job's status.
// ═══════════════════════════════════════════════════════════════════════

// KYTLEAD_V2 (10/27/26): Jason's pipeline. Keys of the original stages are
// kept (followup = Negotiation / Revisions) so existing leads don't move.
const KL_STAGES = [
  { key: 'new',         label: 'New Lead',              color: '#60a5fa' },
  { key: 'attempted',   label: 'Contact Attempted',     color: '#818cf8' },
  { key: 'contacted',   label: 'Contacted',             color: '#a78bfa' },
  { key: 'appt',        label: 'Appointment Set',       color: '#f59e0b' },
  { key: 'walkthrough', label: 'Walkthrough Done',      color: '#fbbf24' },
  { key: 'estimating',  label: 'Estimating',            color: '#fb923c' },
  { key: 'sent',        label: 'Proposal Sent',         color: '#eab308' },
  { key: 'followup',    label: 'Negotiation / Revisions', color: '#f472b6' },
  { key: 'won',         label: 'Contract Signed',       color: '#1dbb87' },
  { key: 'complete',    label: 'Project Complete',      color: '#14b8a6' },
  { key: 'nurture',     label: 'Long-term Nurture',     color: '#64748b' },
  { key: 'postponed',   label: 'Postponed',             color: '#94a3b8' },
  { key: 'lost',        label: 'Lost',                  color: '#6b7280' },
];
const KL_OPEN = ['new', 'attempted', 'contacted', 'appt', 'walkthrough', 'estimating', 'sent', 'followup'];
const KL_PARKED = ['won', 'complete', 'nurture', 'postponed', 'lost']; // board shows the last 90 days
const KL_SOURCES = ['Referral', 'Investor', 'Repeat customer', 'Website', 'Facebook', 'Google', 'Nextdoor', 'Yard sign', 'Truck', 'Hipshot', 'Networking event', 'Other'];
const KL_TYPES = ['Investor flip', 'Rental / landlord', 'Retail homeowner', 'Realtor', 'Property manager', 'Commercial', 'Other'];
const KL_ACTS = [
  { key: 'call',    icon: '📞', label: 'Call' },
  { key: 'text',    icon: '💬', label: 'Text' },
  { key: 'email',   icon: '✉️', label: 'Email' },
  { key: 'appt',    icon: '🤝', label: 'Appointment' },
  { key: 'lunch',   icon: '🍽', label: 'Lunch' },
  { key: 'hipshot', icon: '🎯', label: 'Hipshot' },
  { key: 'note',    icon: '📝', label: 'Note' },
];
// Weekly goals from the 7 Pillars Scorecard (10/17/26 session)
const KL_GOALS = { apptsLunches: 4, closed: 2, hipshots: 10 };

let _klLeads = [];
let _klUnsub = null;
let _klTab = 'pipeline';
let _klOwnerFilter = 'all';
let _klEditingId = null;
let _klDragId = null;

function klStage(key) { return KL_STAGES.find(s => s.key === key) || KL_STAGES[0]; }
function klToday() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function klMoney(v) { return '$' + Math.round(Number(v) || 0).toLocaleString(); }
function klWeekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function klTeam() { return (typeof _lastTeamMemberList !== 'undefined' && _lastTeamMemberList.length) ? _lastTeamMemberList.filter(m => m.email) : []; }
function klName(email) {
  if (!email) return 'Unassigned';
  const m = klTeam().find(t => (t.email || '').toLowerCase() === String(email).toLowerCase());
  return (m && m.name) || email.split('@')[0];
}
function klInitials(email) { return klName(email).split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase(); }
function klMe() { return (conCurrentUser && conCurrentUser.email || '').toLowerCase(); }
function canSeeLeads() {
  if (typeof isFieldTechRestricted === 'function' && isFieldTechRestricted()) return false;
  if (currentUserRole === 'Owner' || (currentUserTeamData && currentUserTeamData.fullAccessOverride)) return true;
  return ['leads', 'jobs_sales', 'estimates', 'jobs'].some(p => hasPermission(p));
}
window.canSeeLeads = canSeeLeads;

// ── Live data ──
function klStartListener() {
  if (_klUnsub || !conDb || !currentCompanyId) return;
  _klUnsub = coll('leads').onSnapshot(snap => {
    _klLeads = [];
    snap.forEach(d => _klLeads.push({ id: d.id, ...d.data() }));
    klSyncFromJobs();
    klRender();
    klUpdateBadge();
  }, err => {
    const el = document.getElementById('klBody');
    if (el) el.innerHTML = `<div class="small muted" style="padding:20px">Could not load leads: ${esc(err.message)}</div>`;
  });
}

// After conversion the job is the source of truth for where the deal is.
function klStageFromJob(status) {
  if (!status) return null;
  if (status === 'Closed Lost') return 'lost';
  if (['New Lead', 'Appointment Set', 'Building Estimate'].includes(status)) return 'estimating';
  if (status === 'Submitted') return 'sent';
  if (['Complete', 'Closed Completed'].includes(status)) return 'complete';
  return 'won';
}
function klSyncFromJobs() {
  if (!Array.isArray(conJobs)) return;
  _klLeads.forEach(l => {
    if (!l.jobId || l.isActivityLog) return;
    const job = conJobs.find(j => j.id === l.jobId);
    if (!job) return;
    const st = klStageFromJob(job.status);
    // Once the project is complete the lead's relationship stage (nurture etc.)
    // belongs to the post-project follow-up, not the job.
    if (l.stage === 'nurture' && st === 'complete') return;
    if (st && st !== l.stage) {
      const patch = { stage: st, stageChangedAt: Date.now(), companyId: currentCompanyId };
      if (st === 'won' && !l.wonAt) { patch.wonAt = Date.now(); patch.wonBy = l.owner || ''; }
      const v = Number(getJobValue(job)) || 0;
      if (v > 0) patch.value = v;
      coll('leads').doc(l.id).update(patch).catch(() => {});
    }
  });
}

function klUpdateBadge() {
  const b = document.getElementById('navLeadsBadge');
  if (!b) return;
  const t = klToday(), me = klMe();
  const due = _klLeads.filter(l => !l.isActivityLog && KL_OPEN.includes(l.stage) && l.nextDue && l.nextDue <= t && (!l.owner || l.owner.toLowerCase() === me)).length;
  b.textContent = due;
  b.style.display = due ? 'inline-flex' : 'none';
}

// ── Page ──
function openLeadsPage() {
  if (!canSeeLeads()) { ktNav('dashboard', document.querySelector('.kt-nav-item')); return; }
  klStartListener();
  klRender();
}
window.openLeadsPage = openLeadsPage;

function klSetTab(tab) { _klTab = tab; klRender(); }
function klSetOwner(v) { _klOwnerFilter = v; klRender(); }
window.klSetTab = klSetTab; window.klSetOwner = klSetOwner;

function klVisible() {
  return _klLeads.filter(l => !l.isActivityLog && (_klOwnerFilter === 'all'
    || (_klOwnerFilter === 'me' ? (l.owner || '').toLowerCase() === klMe() : (l.owner || '').toLowerCase() === _klOwnerFilter)));
}

function klRender() {
  const page = document.getElementById('ktPageLeads');
  if (!page || !page.classList.contains('active')) return;
  const tabs = [['pipeline', '📋 Pipeline'], ['today', '⏰ Today'], ['scorecard', '📈 Scorecard'], ['sequences', '🤖 Sequences'], ['capture', '🌐 Web Form']];
  const owners = klTeam();
  page.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <div style="display:flex;gap:6px;flex-wrap:wrap">${tabs.map(([k, l]) => `<button class="${_klTab === k ? 'btn-amber' : 'btn'}" style="padding:7px 14px;font-size:.84rem" onclick="klSetTab('${k}')">${l}</button>`).join('')}</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select onchange="klSetOwner(this.value)" style="font-size:.82rem;padding:7px 10px">
          <option value="all" ${_klOwnerFilter === 'all' ? 'selected' : ''}>Everyone</option>
          <option value="me" ${_klOwnerFilter === 'me' ? 'selected' : ''}>My leads</option>
          ${owners.map(m => `<option value="${esc((m.email || '').toLowerCase())}" ${_klOwnerFilter === (m.email || '').toLowerCase() ? 'selected' : ''}>${esc(m.name || m.email)}</option>`).join('')}
        </select>
        <button class="btn-amber" onclick="klOpenLead(null)">+ Lead</button>
      </div>
    </div>
    <div id="klBody"></div>`;
  const body = document.getElementById('klBody');
  if (_klTab === 'pipeline') body.innerHTML = klPipelineHtml();
  else if (_klTab === 'today') body.innerHTML = klTodayHtml();
  else if (_klTab === 'scorecard') body.innerHTML = klScorecardHtml();
  else if (_klTab === 'sequences') body.innerHTML = kl2SequencesHtml();
  else body.innerHTML = klCaptureHtml();
}
window.klRender = klRender;

// ── Pipeline board ──
function klDueChip(l) {
  if (!l.nextDue) return KL_OPEN.includes(l.stage) && !l.jobId ? '<span style="font-size:.7rem;color:#ef5350;font-weight:700">⚠ No next step</span>' : '';
  const t = klToday();
  const c = l.nextDue < t ? '#ef5350' : l.nextDue === t ? '#f59e0b' : 'var(--muted)';
  const d = new Date(l.nextDue + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<span style="font-size:.72rem;color:${c};font-weight:700">${l.nextDue < t ? 'Overdue · ' : l.nextDue === t ? 'Today · ' : ''}${d}</span>`;
}
function klCard(l) {
  return `<div draggable="true" ondragstart="klDragStart(event,'${l.id}')" onclick="klOpenLead('${l.id}')"
    style="background:var(--card-bg, rgba(8,18,36,.8));border:1px solid rgba(110,145,210,.18);border-radius:10px;padding:10px;margin-bottom:8px;cursor:pointer">
    <div style="display:flex;justify-content:space-between;gap:6px">
      <div style="font-weight:700;font-size:.86rem;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(l.name || '(no name)')}</div>
      <span title="${esc(klName(l.owner))}" style="flex-shrink:0;font-size:.66rem;font-weight:800;background:rgba(217,119,6,.18);color:var(--amber);border-radius:999px;padding:2px 6px">${esc(klInitials(l.owner))}</span>
    </div>
    ${l.value ? `<div style="font-size:.8rem;color:#a3f2d2;font-weight:700">${klMoney(l.value)}</div>` : ''}
    ${l.nextStep ? `<div style="font-size:.74rem;color:var(--text);margin-top:3px">${kl2ActionIcon(l)} ${esc(l.nextStep)}</div>` : ''}
    ${l.duplicateOf ? `<div style="font-size:.7rem;color:#f59e0b;margin-top:3px">⚠ Possible duplicate of ${esc(l.duplicateOf.name || 'another lead')}</div>` : ''}
    ${l.cadence && l.cadence.status === 'active' ? `<div style="font-size:.68rem;color:#93c5fd;margin-top:3px">🤖 ${esc(l.cadence.name || 'Sequence')}</div>` : ''}
    <div style="display:flex;justify-content:space-between;gap:6px;margin-top:4px;align-items:center">
      ${klDueChip(l)}
      <span style="font-size:.68rem;color:var(--muted)">${esc(l.source || '')}${l.jobId ? ' · 🔧 job' : ''}</span>
    </div>
  </div>`;
}
function klPipelineHtml() {
  const leads = klVisible();
  const openVal = leads.filter(l => KL_OPEN.includes(l.stage)).reduce((s, l) => s + (Number(l.value) || 0), 0);
  const cols = KL_STAGES.map(s => {
    let ls = leads.filter(l => (l.stage || 'new') === s.key);
    if (KL_PARKED.includes(s.key)) { // keep the board fast: last 90 days of closed deals
      const cut = Date.now() - 90 * 864e5;
      ls = ls.filter(l => (l.stageChangedAt || 0) >= cut);
    }
    ls.sort((a, b) => (a.nextDue || '9999').localeCompare(b.nextDue || '9999'));
    const tot = ls.reduce((t, l) => t + (Number(l.value) || 0), 0);
    return `<div ondragover="event.preventDefault()" ondrop="klDrop(event,'${s.key}')"
      style="flex:0 0 230px;background:rgba(110,145,210,.05);border-radius:12px;padding:10px;border-top:3px solid ${s.color};min-height:200px">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <div style="font-weight:800;font-size:.82rem;color:${s.color}">${s.label} <span style="color:var(--muted);font-weight:600">${ls.length}</span></div>
        <div style="font-size:.76rem;font-weight:700;color:var(--muted)">${tot ? klMoney(tot) : ''}</div>
      </div>
      ${ls.map(klCard).join('') || '<div style="font-size:.74rem;color:var(--muted);font-style:italic;padding:6px">Drop a lead here</div>'}
    </div>`;
  }).join('');
  return `<div style="font-size:.8rem;color:var(--muted);margin-bottom:8px">Open pipeline: <strong style="color:#a3f2d2">${klMoney(openVal)}</strong> · ${leads.filter(l => KL_OPEN.includes(l.stage)).length} open leads · drag a card to change its stage (Won/Lost show the last 90 days)</div>
    <div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:10px">${cols}</div>`;
}
function klDragStart(e, id) { _klDragId = id; try { e.dataTransfer.setData('text/plain', id); } catch (x) {} }
async function klDrop(e, stage) {
  e.preventDefault();
  const id = _klDragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
  _klDragId = null;
  if (!id) return;
  await klSetStage(id, stage);
}
window.klDragStart = klDragStart; window.klDrop = klDrop;

async function klSetStage(id, stage) {
  const l = _klLeads.find(x => x.id === id);
  if (!l || l.stage === stage) return;
  const patch = { stage, stageChangedAt: Date.now(), companyId: currentCompanyId };
  if (stage === 'lost') {
    const why = prompt('Why was this lead lost? (price, timing, went with someone else, no response…)', l.lostReason || '');
    if (why === null) return;
    patch.lostReason = why.trim();
  }
  if (stage === 'won' && !l.wonAt) { patch.wonAt = Date.now(); patch.wonBy = l.owner || klMe(); }
  patch.activity = firebase.firestore.FieldValue.arrayUnion({ type: 'stage', note: `${klStage(l.stage).label} → ${klStage(stage).label}`, at: Date.now(), by: klMe() });
  await coll('leads').doc(id).update(patch).catch(err => alert('Could not move lead: ' + err.message));
  if (stage === 'won' && !l.jobId && confirm(`${l.name} is Won. Create the job in JobsMetrix now?`)) klConvert(id);
}
window.klSetStage = klSetStage;

// ── Today: who do I call ──
function klTodayHtml() {
  const t = klToday();
  const open = klVisible().filter(l => KL_OPEN.includes(l.stage));
  const overdue = open.filter(l => l.nextDue && l.nextDue < t).sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  const today = open.filter(l => l.nextDue === t);
  const none = open.filter(l => !l.nextDue && !l.jobId); // converted leads: next steps live on the job
  const soon = open.filter(l => l.nextDue && l.nextDue > t && l.nextDue <= new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10));
  const row = l => `<div onclick="klOpenLead('${l.id}')" style="display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid rgba(110,145,210,.08);cursor:pointer">
      <div style="min-width:0"><div style="font-weight:700">${esc(l.name || '(no name)')} <span style="font-size:.72rem;color:${klStage(l.stage).color}">${klStage(l.stage).label}</span></div>
      <div style="font-size:.78rem;color:var(--muted)">${l.nextStep ? kl2ActionIcon(l) + ' ' + esc(l.nextStep) : 'No next step set'}${l.phone ? ' · ' + esc(l.phone) : ''}</div></div>
      <div style="text-align:right;flex-shrink:0">${klDueChip(l)}<div style="font-size:.7rem;color:var(--muted)">${esc(klName(l.owner))}</div></div>
    </div>`;
  const sec = (title, color, list) => list.length ? `<div class="kt-card" style="padding:0;margin-bottom:12px"><div style="padding:10px 12px;font-weight:800;color:${color}">${title} (${list.length})</div>${list.map(row).join('')}</div>` : '';
  const html = sec('🔴 Overdue', '#ef5350', overdue) + sec('🟠 Due today', '#f59e0b', today) + sec('⚠ No next step', '#ef5350', none) + sec('📅 Next 3 days', 'var(--muted)', soon);
  return kl2TodayTiles() + (html || '<div class="kt-card" style="padding:20px">✅ Nothing due. Every open lead has a next step that isn\'t due yet.</div>');
}

// ── Scorecard ──
function klAllActivity() {
  const out = [];
  _klLeads.forEach(l => (l.activity || []).forEach(a => out.push({ ...a, leadId: l.id })));
  return out;
}
function klScorecardHtml() {
  const who = _klOwnerFilter === 'all' ? null : (_klOwnerFilter === 'me' ? klMe() : _klOwnerFilter);
  const acts = klAllActivity().filter(a => !who || (a.by || '').toLowerCase() === who);
  const leads = _klLeads.filter(l => !l.isActivityLog);
  const weeks = [0, 1, 2, 3].map(i => { const s = klWeekStart(Date.now()); s.setDate(s.getDate() - 7 * i); return s; });
  const cnt = (start, test) => { const end = start.getTime() + 7 * 864e5; return acts.filter(a => a.at >= start.getTime() && a.at < end && test(a)).length; };
  const closed = start => { const end = start.getTime() + 7 * 864e5; return leads.filter(l => l.wonAt >= start.getTime() && l.wonAt < end && (!who || (l.wonBy || l.owner || '').toLowerCase() === who)).length; };
  const newLeads = start => { const end = start.getTime() + 7 * 864e5; return leads.filter(l => (l.createdMs || 0) >= start.getTime() && (l.createdMs || 0) < end && (!who || (l.owner || '').toLowerCase() === who)).length; };
  const rows = [
    ['Sales appointments / lunches', s => cnt(s, a => a.type === 'appt' || a.type === 'lunch'), KL_GOALS.apptsLunches],
    ['Sales closed', closed, KL_GOALS.closed],
    ['Hipshots', s => cnt(s, a => a.type === 'hipshot'), KL_GOALS.hipshots],
    ['New leads', newLeads, null],
    ['Calls / texts / emails', s => cnt(s, a => ['call', 'text', 'email'].includes(a.type)), null],
  ];
  const cut = Date.now() - 90 * 864e5;
  const mine = l => !who || (l.owner || '').toLowerCase() === who;
  const won90 = leads.filter(l => l.stage === 'won' && (l.stageChangedAt || 0) >= cut && mine(l));
  const lost90 = leads.filter(l => l.stage === 'lost' && (l.stageChangedAt || 0) >= cut && mine(l));
  const closeRate = (won90.length + lost90.length) ? won90.length / (won90.length + lost90.length) : null;
  const openVal = leads.filter(l => KL_OPEN.includes(l.stage) && mine(l)).reduce((s, l) => s + (Number(l.value) || 0), 0);
  const wk = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const cell = (v, goal) => { const c = goal == null ? 'var(--text)' : v >= goal ? '#1dbb87' : '#ef5350'; return `<td style="text-align:right;padding:8px;font-weight:800;color:${c}">${v}</td>`; };
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:12px">
      <div class="kt-card" style="padding:14px"><div style="font-size:1.4rem;font-weight:900;color:#a3f2d2">${klMoney(openVal)}</div><div class="small muted">Open pipeline</div></div>
      <div class="kt-card" style="padding:14px"><div style="font-size:1.4rem;font-weight:900;color:var(--amber)">${closeRate == null ? '—' : Math.round(closeRate * 100) + '%'}</div><div class="small muted">Close rate, last 90 days (${won90.length} won / ${lost90.length} lost)</div></div>
      <div class="kt-card" style="padding:14px"><div style="font-size:1.4rem;font-weight:900;color:#a3f2d2">${klMoney(won90.reduce((s, l) => s + (Number(l.value) || 0), 0))}</div><div class="small muted">Won, last 90 days</div></div>
    </div>
    <div class="kt-card" style="padding:14px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <div style="font-weight:800">📈 Weekly sales scorecard ${who ? '— ' + esc(klName(who)) : '— everyone'}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn" style="padding:5px 10px;font-size:.78rem" onclick="klQuickLog('hipshot')">+ 🎯 Hipshot</button>
          <button class="btn" style="padding:5px 10px;font-size:.78rem" onclick="klQuickLog('lunch')">+ 🍽 Lunch</button>
          <button class="btn" style="padding:5px 10px;font-size:.78rem" onclick="klQuickLog('appt')">+ 🤝 Appointment</button>
        </div>
      </div>
      <div style="overflow-x:auto"><table class="kt-table" style="width:100%;font-size:.84rem">
        <thead><tr><th style="text-align:left">Measure</th><th style="text-align:right">Goal</th>${weeks.map((w, i) => `<th style="text-align:right">${i === 0 ? 'This week' : 'Wk of ' + wk(w)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(([label, fn, goal]) => `<tr><td style="padding:8px">${label}</td><td style="text-align:right;padding:8px;color:var(--muted)">${goal == null ? '—' : goal}</td>${weeks.map(w => cell(fn(w), goal)).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <div class="small muted" style="margin-top:8px">Goals from the 7 Pillars Scorecard. Green = hit, red = missed. Weeks run Monday–Sunday. Log activity from a lead's card, or use the quick buttons for ones not tied to a lead.</div>
    </div>`;
}
async function klQuickLog(type) {
  const label = (KL_ACTS.find(a => a.key === type) || {}).label || type;
  const note = prompt(`${label} — who / where? (optional)`, '');
  if (note === null) return;
  const me = klMe();
  let log = _klLeads.find(l => l.isActivityLog && (l.owner || '').toLowerCase() === me);
  const entry = { type, note: note.trim(), at: Date.now(), by: me };
  try {
    if (log) await coll('leads').doc(log.id).update({ activity: firebase.firestore.FieldValue.arrayUnion(entry), companyId: currentCompanyId });
    else await coll('leads').add({ isActivityLog: true, name: 'Activity log — ' + klName(me), owner: me, stage: 'log', activity: [entry], companyId: currentCompanyId, createdMs: Date.now() });
  } catch (e) { alert('Could not log it: ' + e.message); }
}
window.klQuickLog = klQuickLog;

// ── Web form (lead capture) ──
function klCaptureHtml() {
  const url = `${location.origin}/lead-form.html?c=${encodeURIComponent(currentCompanyId)}`;
  const iframe = `<iframe src="${url}" style="width:100%;max-width:520px;height:720px;border:0" title="Request an estimate"></iframe>`;
  return `<div class="kt-card" style="padding:16px">
    <div style="font-weight:800;margin-bottom:6px">🌐 Web lead form</div>
    <div class="small muted" style="margin-bottom:12px">Anyone who fills this out lands on the board as a <strong>New Lead</strong> (source: Website), assigned to whoever gets Sales alerts in Settings → Who Gets Alerts, with a next step of "Call within 1 business day".</div>
    <div style="margin-bottom:10px"><div class="small muted">Shareable link (text it, put it on a QR code or a yard sign):</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px"><input readonly value="${esc(url)}" style="flex:1;min-width:220px;font-size:.8rem" onclick="this.select()"/><button class="btn" onclick="navigator.clipboard.writeText('${esc(url)}').then(()=>this.textContent='Copied ✓').catch(()=>{})">Copy</button><a class="btn" href="${esc(url)}" target="_blank">Open</a></div></div>
    <div><div class="small muted">To put it on the jtxd website, paste this where the form should appear:</div>
      <textarea readonly style="width:100%;min-height:64px;font-size:.76rem;margin-top:4px" onclick="this.select()">${esc(iframe)}</textarea></div>
  </div>`;
}

// ── Lead detail modal ──
function klEnsureModal() {
  if (document.getElementById('klLeadModal')) return;
  const d = document.createElement('div');
  d.id = 'klLeadModal';
  d.className = 'modal-overlay';
  d.innerHTML = `<div class="modal-box" style="max-width:720px"><div class="modal-head"><div><h3 id="klModalTitle" style="margin:0">Lead</h3></div><button class="btn" onclick="kClose('klLeadModal')">Close</button></div><div class="modal-body" id="klModalBody"></div></div>`;
  document.body.appendChild(d);
}
function klOpenLead(id) {
  klEnsureModal();
  _klEditingId = id;
  const l = id ? (_klLeads.find(x => x.id === id) || {}) : { stage: 'new', owner: klMe(), source: 'Referral' };
  document.getElementById('klModalTitle').textContent = id ? (l.name || 'Lead') : 'New Lead';
  const opt = (arr, cur) => arr.map(v => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const team = klTeam();
  const f = (lbl, html) => `<div><label class="small muted" style="display:block;margin-bottom:4px">${lbl}</label>${html}</div>`;
  const acts = (l.activity || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  const job = l.jobId && Array.isArray(conJobs) ? conJobs.find(j => j.id === l.jobId) : null;
  document.getElementById('klModalBody').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
      ${f('Name *', `<input id="klName" value="${esc(l.name || '')}" style="width:100%"/>`)}
      ${f('Phone', `<input id="klPhone" type="tel" value="${esc(l.phone || '')}" style="width:100%"/>`)}
      ${f('Email', `<input id="klEmail" type="email" value="${esc(l.email || '')}" style="width:100%"/>`)}
      ${f('Property address', `<input id="klAddress" value="${esc(l.address || '')}" style="width:100%"/>`)}
      ${f('Source', `<select id="klSource" style="width:100%">${opt(KL_SOURCES, l.source)}</select>`)}
      ${f('Customer type', `<select id="klType" style="width:100%"><option value="">—</option>${opt(KL_TYPES, l.type)}</select>`)}
      ${f('Company', `<input id="klCompany" value="${esc(l.company || '')}" style="width:100%"/>`)}
      ${f('Type of work', `<input id="klWork" value="${esc(l.workType || '')}" placeholder="Kitchen, full rehab, roof…" style="width:100%"/>`)}
      ${f('Budget ($)', `<input id="klBudget" type="number" min="0" step="500" value="${l.budget || ''}" style="width:100%"/>`)}
      ${f('Desired start', `<input id="klStart" type="date" value="${esc(l.desiredStart || '')}" style="width:100%"/>`)}
      ${f('Est. value ($)', `<input id="klValue" type="number" min="0" step="100" value="${l.value || ''}" style="width:100%"/>`)}
      ${f('Owner', `<select id="klOwner" style="width:100%"><option value="">Unassigned</option>${team.map(m => `<option value="${esc(m.email)}" ${(m.email || '').toLowerCase() === (l.owner || '').toLowerCase() ? 'selected' : ''}>${esc(m.name || m.email)}</option>`).join('')}</select>`)}
      ${f('Stage', `<select id="klStageSel" style="width:100%" ${l.jobId ? 'disabled title="Follows the job status now"' : ''}>${KL_STAGES.map(s => `<option value="${s.key}" ${s.key === (l.stage || 'new') ? 'selected' : ''}>${s.label}</option>`).join('')}</select>`)}
    </div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;margin-top:10px">
      ${f('Next step *', `<input id="klNextStep" value="${esc(l.nextStep || '')}" placeholder="e.g. Call to set walkthrough" style="width:100%"/>`)}
      ${f('Due', `<input id="klNextDue" type="date" value="${esc(l.nextDue || '')}" style="width:100%"/>`)}
    </div>
    <div style="margin-top:10px">${f('Notes', `<textarea id="klNotes" style="width:100%;min-height:60px">${esc(l.notes || '')}</textarea>`)}</div>
    ${l.lostReason ? `<div class="small" style="margin-top:6px;color:#ef5350">Lost reason: ${esc(l.lostReason)}</div>` : ''}
    ${l.duplicateOf ? `<div class="small" style="margin-top:6px;color:#f59e0b">⚠ Possible duplicate of <a href="#" onclick="event.preventDefault();klOpenLead('${l.duplicateOf.id}')">${esc(l.duplicateOf.name || 'another lead')}</a>. Merge them by hand and delete one, or <a href="#" onclick="event.preventDefault();kl2ClearDup('${id}')">it's a different person</a>.</div>` : ''}
    ${id ? kl2ActionPanel(l) + kl2SequencePanel(l) : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      <button class="btn-amber" onclick="klSaveLead()">Save</button>
      ${id && !l.jobId ? `<button class="btn" onclick="klConvert('${id}')">🔧 Convert to Job</button>` : ''}
      ${job ? `<button class="btn" onclick="kClose('klLeadModal');openJobDetail('${job.id}')">🔧 Open ${esc(jobNumSt(job))}</button>` : ''}
      ${id && !l.jobId && l.stage !== 'won' ? `<button class="btn" style="color:#1dbb87" onclick="klSetStage('${id}','won');kClose('klLeadModal')">✓ Won</button>` : ''}
      ${id && l.stage !== 'lost' ? `<button class="btn" style="color:#ef5350" onclick="klSetStage('${id}','lost');kClose('klLeadModal')">✕ Lost</button>` : ''}
      ${id && (currentUserRole === 'Owner' || (currentUserTeamData && currentUserTeamData.fullAccessOverride) || window._hasFullAccess) ? `<button class="btn" style="margin-left:auto;color:var(--muted)" onclick="klDelete('${id}')">Delete</button>` : ''}
    </div>
    ${id ? `<div style="margin-top:16px;border-top:1px solid rgba(110,145,210,.15);padding-top:12px">
      <div style="font-weight:800;margin-bottom:8px">Log activity</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${KL_ACTS.map(a => `<button class="btn" style="padding:5px 10px;font-size:.78rem" onclick="${a.key === 'call' ? `kl2ShowOutcomes('${id}')` : `klLogActivity('${id}','${a.key}')`}">${a.icon} ${a.label}</button>`).join('')}</div>
      <input id="klActNote" placeholder="What happened? (optional — type before tapping a button)" style="width:100%;font-size:.84rem;margin-bottom:10px"/>
      ${l.email ? `<details style="margin-bottom:10px"><summary style="cursor:pointer;font-weight:700;font-size:.84rem">✉️ Email ${esc(l.name || 'this lead')} from JobsMetrix (Gmail)</summary>
        <input id="klMailSubj" value="${esc('Your project with ' + ((typeof companyProfile !== 'undefined' && companyProfile && companyProfile.companyName) || 'JTXD Contracting'))}" style="width:100%;margin-top:8px;font-size:.84rem"/>
        <textarea id="klMailBody" style="width:100%;min-height:110px;margin-top:6px;font-size:.84rem">Hi ${esc((l.name || '').split(' ')[0])},

</textarea>
        <button class="btn-amber" id="klMailBtn" style="margin-top:6px" onclick="klSendEmail('${id}')">Send email</button>
      </details>` : '<div class="small muted" style="margin-bottom:10px">Add an email address to send email from here.</div>'}
      <div style="max-height:240px;overflow:auto">${acts.map(a => {
        const meta = KL_ACTS.find(x => x.key === a.type);
        return `<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid rgba(110,145,210,.08);font-size:.8rem">
          <span>${a.by === 'auto' ? '🤖' : a.by === 'customer' ? '📥' : meta ? meta.icon : '↪'}</span><div style="flex:1;min-width:0">${esc(meta ? meta.label : 'Stage')}${a.note ? ' — ' + esc(a.note) : ''}</div>
          <span style="color:var(--muted);white-space:nowrap">${new Date(a.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${a.by === 'auto' ? 'Auto' : a.by === 'customer' ? 'Customer' : esc(klInitials(a.by))}</span></div>`;
      }).join('') || '<div class="small muted">No activity yet.</div>'}</div>
    </div>` : ''}`;
  kOpen('klLeadModal');
}
window.klOpenLead = klOpenLead;

async function klSaveLead() {
  const v = id => (document.getElementById(id) || {}).value || '';
  const name = v('klName').trim();
  if (!name) { alert('Name is required.'); return; }
  const stageSel = document.getElementById('klStageSel');
  const data = {
    name, phone: v('klPhone').trim(), email: v('klEmail').trim(), address: v('klAddress').trim(),
    source: v('klSource'), type: v('klType'), value: Number(v('klValue')) || 0,
    company: v('klCompany').trim(), workType: v('klWork').trim(), budget: Number(v('klBudget')) || 0, desiredStart: v('klStart'),
    owner: v('klOwner'), nextStep: v('klNextStep').trim(), nextDue: v('klNextDue'),
    notes: v('klNotes').trim(), companyId: currentCompanyId, updatedMs: Date.now(), updatedBy: klMe(),
  };
  if (KL_OPEN.includes(stageSel && !stageSel.disabled ? stageSel.value : 'new') && (!data.nextStep || !data.nextDue)) {
    if (!confirm('Every open lead should have a next step and a due date, or it falls through the cracks. Save anyway?')) return;
  }
  try {
    if (_klEditingId) {
      const cur = _klLeads.find(x => x.id === _klEditingId) || {};
      await coll('leads').doc(_klEditingId).update(data);
      if (stageSel && !stageSel.disabled && stageSel.value !== cur.stage) await klSetStage(_klEditingId, stageSel.value);
    } else {
      data.stage = stageSel ? stageSel.value : 'new';
      data.stageChangedAt = Date.now();
      data.createdMs = Date.now();
      data.createdBy = klMe();
      data.activity = [{ type: 'note', note: 'Lead created', at: Date.now(), by: klMe() }];
      const dup = kl2FindDup(data);
      if (dup && !confirm(`Possible duplicate: ${dup.label} has the same ${dup.why}.\n\nSave a new lead anyway?`)) return;
      await coll('leads').add(data);
    }
    kClose('klLeadModal');
  } catch (e) { alert('Could not save: ' + e.message); }
}
window.klSaveLead = klSaveLead;

async function klLogActivity(id, type) {
  const noteEl = document.getElementById('klActNote');
  const note = noteEl ? noteEl.value.trim() : '';
  const patch = { activity: firebase.firestore.FieldValue.arrayUnion({ type, note, at: Date.now(), by: klMe() }), companyId: currentCompanyId, lastTouchMs: Date.now() };
  const l = _klLeads.find(x => x.id === id);
  if (type === 'appt' && l && ['new', 'contacted'].includes(l.stage)) { patch.stage = 'appt'; patch.stageChangedAt = Date.now(); }
  if (['call', 'text', 'email'].includes(type) && l && l.stage === 'new') { patch.stage = 'contacted'; patch.stageChangedAt = Date.now(); }
  try {
    await coll('leads').doc(id).update(patch);
    if (noteEl) noteEl.value = '';
    setTimeout(() => klOpenLead(id), 250);
  } catch (e) { alert('Could not log: ' + e.message); }
}
window.klLogActivity = klLogActivity;

// Same Gmail send path as estimates and proposals (sendJobspanEmail callable),
// logged on the lead as an Email activity.
async function klSendEmail(id) {
  const l = _klLeads.find(x => x.id === id);
  if (!l || !l.email) return;
  const subject = (document.getElementById('klMailSubj') || {}).value || '';
  const body = ((document.getElementById('klMailBody') || {}).value || '').trim();
  if (!subject.trim() || !body) { alert('Add a subject and a message.'); return; }
  if (typeof conFunctions === 'undefined' || !conFunctions) { alert('Email is still loading — try again in a moment.'); return; }
  const btn = document.getElementById('klMailBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  const bodyHtml = body.split(/\n\n+/).map(p => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
  try {
    await conFunctions.httpsCallable('sendJobspanEmail')({ to: l.email, toName: l.name || '', subject: subject.trim(), bodyHtml, bodyText: body, replyTo: conCurrentUser && conCurrentUser.email || '', docType: 'lead' });
    await coll('leads').doc(id).update({ companyId: currentCompanyId, lastTouchMs: Date.now(),
      activity: firebase.firestore.FieldValue.arrayUnion({ type: 'email', note: 'Sent: ' + subject.trim(), at: Date.now(), by: klMe() }),
      ...(l.stage === 'new' ? { stage: 'contacted', stageChangedAt: Date.now() } : {}) });
    alert('Email sent to ' + l.email);
    setTimeout(() => klOpenLead(id), 250);
  } catch (e) {
    alert('Could not send: ' + (e.message || e));
    if (btn) { btn.disabled = false; btn.textContent = 'Send email'; }
  }
}
window.klSendEmail = klSendEmail;

async function klConvert(id) {
  const l = _klLeads.find(x => x.id === id);
  if (!l || l.jobId) return;
  if (!confirm(`Create a JobsMetrix job for ${l.name}? It starts at "Building Estimate" with their contact info filled in.`)) return;
  const jobNumber = conGenJobNumber();
  const data = {
    name: jobNumber, jobNumber, client: l.name || '', phone: l.phone || '', email: l.email || '', address: l.address || '',
    status: 'Building Estimate', statusDate: new Date().toISOString().split('T')[0], type: 'Residential Remodel',
    contractValue: 0, estCost: 0, actualCost: 0, notes: [l.notes, l.source ? 'Lead source: ' + l.source : ''].filter(Boolean).join('\n'),
    leadSource: l.source || '', convertedFromLeadId: id, salesOwner: l.owner || '',
    createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: klMe(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: klMe(),
  };
  try {
    const ref = await coll('jobs').add(subDoc(data));
    await coll('leads').doc(id).update({ jobId: ref.id, jobNumber, stage: 'estimating', stageChangedAt: Date.now(), companyId: currentCompanyId,
      activity: firebase.firestore.FieldValue.arrayUnion({ type: 'stage', note: 'Converted to job ' + jobNumber, at: Date.now(), by: klMe() }) });
    kClose('klLeadModal');
    setTimeout(() => openJobDetail(ref.id), 400);
  } catch (e) { alert('Could not create the job: ' + e.message); }
}
window.klConvert = klConvert;

async function klDelete(id) {
  if (!confirm('Delete this lead permanently? Use Lost instead if the deal just didn\'t happen — that keeps your close rate honest.')) return;
  try { await coll('leads').doc(id).delete(); kClose('klLeadModal'); } catch (e) { alert('Could not delete: ' + e.message); }
}
window.klDelete = klDelete;

// ═══════════════════════════════════════════════════════════════════════
// KYTLEAD_V2 (Travis 10/27/26) — Jason's CRM requirements, Phase 1 core:
// required call outcomes that set the next step, sequences (cadences) that
// run on their own, a sequence editor, duplicate warnings, Today metrics.
// The sequences themselves run server-side (functions: kytleadOnWrite,
// kytleadCadenceRunner). Config: settings/cadences { list, ...options }.
// ═══════════════════════════════════════════════════════════════════════
const KL2_DEFAULT_CADENCES = [
  {
    id: 'sales-investor', name: 'New lead — Investor', trigger: 'lead_created', audience: 'investor', active: true,
    steps: [
      { value: 0, unit: 'days', action: 'sms', body: 'Hi {first_name}, this is {owner_first} with {company}. Got your request{at_address}. I\'ll call you shortly to talk numbers and timeline. Reply here anytime.' },
      { value: 1, unit: 'days', action: 'call', body: 'Call {first_name}: scope, budget, timeline, set a walkthrough' },
      { value: 2, unit: 'days', action: 'email', subject: 'Your rehab with {company}', body: 'Hi {first_name},\n\nThanks for reaching out about {address_or_project}. We work with investors every week, and we know the numbers have to work: a clear scope, a firm price, and a schedule that respects your holding costs.\n\nThe next step is a quick walkthrough so we can give you a real number, not a guess. What day works for you?\n\n{owner_name}\n{company}' },
      { value: 4, unit: 'days', action: 'sms', body: 'Hi {first_name}, {owner_first} with {company} checking in. Still want a number on the rehab? Happy to walk it this week.' },
      { value: 7, unit: 'days', action: 'call', body: 'Day 7 call to {first_name}: log the outcome' },
      { value: 14, unit: 'days', action: 'email', subject: 'Budgeting your next rehab', body: 'Hi {first_name},\n\nOne thing we see on every flip: the budget is won or lost before demo day. Line-item scopes, materials locked early, and a contractor who tells you about overages before they happen.\n\nWhenever you have a property under contract, or are deciding whether to buy one, send it over. We\'ll give you a rehab number you can underwrite with.\n\n{owner_name}\n{company}' },
      { value: 30, unit: 'days', action: 'stage', stage: 'nurture', body: 'No response after 30 days: move to long-term nurture' },
    ],
  },
  {
    id: 'sales-homeowner', name: 'New lead — Homeowner', trigger: 'lead_created', audience: 'homeowner', active: true,
    steps: [
      { value: 0, unit: 'days', action: 'sms', body: 'Hi {first_name}, this is {owner_first} with {company}. Thanks for reaching out about your project{at_address}! I\'ll give you a call shortly. Reply here anytime.' },
      { value: 1, unit: 'days', action: 'call', body: 'Call {first_name}: what they want, budget, timeline, set a walkthrough' },
      { value: 2, unit: 'days', action: 'email', subject: 'Your project with {company}', body: 'Hi {first_name},\n\nThanks for thinking of us for your project. Here\'s how we work: we come out, walk the space with you, listen to what you want, and give you a clear written estimate. No pressure and no surprises.\n\nWhat day works for a quick walkthrough?\n\n{owner_name}\n{company}' },
      { value: 4, unit: 'days', action: 'sms', body: 'Hi {first_name}, {owner_first} with {company} checking in. Would you still like us to come take a look at your project?' },
      { value: 7, unit: 'days', action: 'call', body: 'Day 7 call to {first_name}: log the outcome' },
      { value: 14, unit: 'days', action: 'email', subject: 'Planning your remodel', body: 'Hi {first_name},\n\nA few things that make every remodel go smoother: decide your must-haves early, pick finishes before work starts, and plan for a small cushion in the budget.\n\nWhenever you\'re ready to talk about your project, just reply to this email. We\'d love to help.\n\n{owner_name}\n{company}' },
      { value: 30, unit: 'days', action: 'stage', stage: 'nurture', body: 'No response after 30 days: move to long-term nurture' },
    ],
  },
  {
    id: 'post-investor', name: 'Project complete — Investor', trigger: 'stage:complete', audience: 'investor', active: true,
    steps: [
      { value: 0, unit: 'days', action: 'email', subject: 'Thank you from {company}', body: 'Hi {first_name},\n\nThank you for trusting us with {address_or_project}. It was a pleasure working with you.\n\nIf anything needs attention, reply to this email and we\'ll take care of it.\n\n{owner_name}\n{company}' },
      { value: 3, unit: 'days', action: 'sms', body: 'Hi {first_name}, {owner_first} with {company}. How does everything look at {address_or_project}? Anything we need to touch up?' },
      { value: 7, unit: 'days', action: 'email', subject: 'Quick favor?', body: 'Hi {first_name},\n\nIf we earned it, a short review helps other investors find a contractor they can trust:\n{review_link}\n\nThank you!\n{owner_name}' },
      { value: 30, unit: 'days', action: 'call', body: 'Personal call to {first_name}: how did the property perform? What\'s next in the pipeline?' },
      { value: 90, unit: 'days', action: 'email', subject: 'What\'s next on your list?', body: 'Hi {first_name},\n\nChecking in: do you have your next acquisition lined up? Send us the address before you close and we\'ll give you a rehab number you can underwrite with.\n\n{owner_name}\n{company}' },
      { value: 6, unit: 'months', action: 'call', body: 'Six-month relationship call to {first_name}: upcoming acquisitions, rehabs, budgets' },
      { value: 12, unit: 'months', action: 'email', subject: 'A year since we worked together', body: 'Hi {first_name},\n\nIt\'s been a year since we finished {address_or_project}. Thank you again for the work. If you have projects planned for the coming year, we\'d love to help you budget them.\n\n{owner_name}\n{company}' },
    ],
  },
  {
    id: 'post-homeowner', name: 'Project complete — Homeowner', trigger: 'stage:complete', audience: 'homeowner', active: true,
    steps: [
      { value: 0, unit: 'days', action: 'email', subject: 'Thank you from {company}', body: 'Hi {first_name},\n\nThank you for letting us into your home. We hope you love the finished project!\n\nIf anything needs attention, just reply to this email and we\'ll take care of it.\n\n{owner_name}\n{company}' },
      { value: 3, unit: 'days', action: 'sms', body: 'Hi {first_name}, {owner_first} with {company}. How is everything with the project? Anything we can help with?' },
      { value: 7, unit: 'days', action: 'email', subject: 'Quick favor?', body: 'Hi {first_name},\n\nIf you\'re happy with your project, would you leave us a short review? It means a lot to a local business:\n{review_link}\n\nThank you!\n{owner_name}' },
      { value: 30, unit: 'days', action: 'call', body: 'Personal follow-up call to {first_name}: still happy? any friends or neighbors planning projects?' },
      { value: 90, unit: 'days', action: 'email', subject: 'Anything else on your list?', body: 'Hi {first_name},\n\nHope you\'re enjoying the finished work. Is there another project on your list, or a friend or neighbor planning one? We\'d be grateful for the chance to help.\n\n{owner_name}\n{company}' },
      { value: 6, unit: 'months', action: 'call', body: 'Six-month check-in call to {first_name}' },
      { value: 12, unit: 'months', action: 'email', subject: 'Your home, one year later', body: 'Hi {first_name},\n\nIt\'s been a year since we finished your project. If you\'re thinking about maintenance or your next renovation, we\'re here to help.\n\n{owner_name}\n{company}' },
    ],
  },
  {
    id: 'nurture', name: 'Long-term nurture', trigger: 'stage:nurture', audience: 'any', active: true,
    steps: [
      { value: 30, unit: 'days', action: 'email', subject: 'Still thinking about that project?', body: 'Hi {first_name},\n\nJust checking in. If the timing is better now, reply to this email and we\'ll get you on the schedule for a walkthrough.\n\n{owner_name}\n{company}' },
      { value: 90, unit: 'days', action: 'call', body: 'Nurture call to {first_name}: has anything changed?' },
      { value: 6, unit: 'months', action: 'email', subject: 'Checking in from {company}', body: 'Hi {first_name},\n\nWe\'re booking projects for the coming season. If you\'re still planning yours, reply here and we\'ll set up a time.\n\n{owner_name}\n{company}' },
    ],
  },
];

const KL2_UNIT_MS = { minutes: 6e4, hours: 36e5, days: 864e5, weeks: 7 * 864e5, months: 30 * 864e5 };
const KL2_SEL = 'width:auto;flex:0 1 auto;max-width:100%;padding:6px 8px';
const KL2_ACTIONS = { sms: '💬 Text', email: '✉️ Email', call: '📞 Call', task: '✅ Task', stage: '➡️ Move stage' };
const KL2_OUTCOMES = [
  { key: 'interested', label: 'Talked: interested', icon: '✅' },
  { key: 'callback',   label: 'Talked: call back later', icon: '📅' },
  { key: 'answered',   label: 'Talked: other', icon: '🗣' },
  { key: 'voicemail',  label: 'Left voicemail', icon: '📭' },
  { key: 'noanswer',   label: 'No answer', icon: '🔕' },
  { key: 'notinterested', label: 'Not interested', icon: '👎' },
  { key: 'wrong',      label: 'Wrong number', icon: '❌' },
];
let _kl2Cfg = null, _kl2CfgUnsub = null, _kl2Edit = null;

function kl2Cfg() {
  if (!_kl2CfgUnsub && typeof coll === 'function' && typeof currentCompanyId !== 'undefined' && currentCompanyId) {
    _kl2CfgUnsub = coll('settings').doc('cadences').onSnapshot(s => {
      _kl2Cfg = s.exists ? s.data() : {};
      if (_klTab === 'sequences') klRender();
    }, () => { _kl2Cfg = {}; });
  }
  const c = _kl2Cfg || {};
  return { ...c, list: Array.isArray(c.list) && c.list.length ? c.list : KL2_DEFAULT_CADENCES, isDefault: !(Array.isArray(c.list) && c.list.length) };
}
function kl2CanEdit() { return currentUserRole === 'Owner' || !!(currentUserTeamData && currentUserTeamData.fullAccessOverride) || !!window._hasFullAccess; }
function kl2Offset(s) { return (Number(s.value) || 0) * (KL2_UNIT_MS[s.unit] || KL2_UNIT_MS.days); }
function kl2When(s) {
  const v = Number(s.value) || 0;
  if (!v) return 'Immediately';
  const u = { minutes: 'min', hours: 'hr', days: 'Day', weeks: 'Week', months: 'Month' }[s.unit] || 'Day';
  return ['Day', 'Week', 'Month'].includes(u) ? `${u} ${v}` : `${v} ${u}`;
}
function kl2TriggerLabel(t) {
  if (t === 'lead_created') return 'When a new lead comes in';
  if (String(t || '').startsWith('stage:')) return 'When a lead moves to ' + klStage(t.slice(6)).label;
  return t || '—';
}
function kl2AudLabel(a) { return a === 'investor' ? 'Investors' : a === 'homeowner' ? 'Homeowners' : 'Everyone'; }
function kl2ActionIcon(l) {
  const t = l.nextAction && l.nextAction.pending ? l.nextAction.type : '';
  return t === 'call' ? '📞' : t === 'sms' ? '💬' : t === 'task' ? '✅' : '→';
}
function kl2Biz(days) { // date string N days out, skipping Sundays
  const d = new Date(); d.setDate(d.getDate() + days);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function kl2FindDup(data) {
  const dig = v => { const d = String(v || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; };
  const p = dig(data.phone), e = String(data.email || '').trim().toLowerCase();
  if (p.length < 10 && !e) return null;
  const hit = (x, phone, email) => (p.length >= 10 && dig(phone) === p) ? 'phone number' : (e && String(email || '').trim().toLowerCase() === e) ? 'email' : '';
  for (const l of _klLeads) { if (l.isActivityLog) continue; const w = hit(l, l.phone, l.email); if (w) return { label: 'Lead "' + (l.name || '?') + '"', why: w }; }
  for (const j of (Array.isArray(conJobs) ? conJobs : [])) { const w = hit(j, j.phone, j.email); if (w) return { label: 'Job ' + (j.jobNumber || '') + ' (' + (j.client || '') + ')', why: w }; }
  return null;
}
async function kl2ClearDup(id) {
  await coll('leads').doc(id).update({ duplicateOf: firebase.firestore.FieldValue.delete(), companyId: currentCompanyId }).catch(e => alert(e.message));
  setTimeout(() => klOpenLead(id), 250);
}

// ── Next action panel (in the lead modal) ──
function kl2ActionPanel(l) {
  const na = l.nextAction && l.nextAction.pending ? l.nextAction : null;
  const first = String(l.name || '').split(' ')[0] || 'them';
  let btns = '';
  if (na && na.type === 'sms') {
    const href = l.phone ? `sms:${String(l.phone).replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(na.body || '')}` : '';
    btns = `<div style="background:rgba(99,179,237,.08);border:1px solid rgba(99,179,237,.25);border-radius:8px;padding:8px 10px;font-size:.84rem;white-space:pre-wrap;margin:6px 0">${esc(na.body || '')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${href ? `<a class="btn-amber" style="padding:7px 14px;text-decoration:none" href="${esc(href)}" onclick="setTimeout(()=>kl2DoneAction('${l.id}','text'),400)">💬 Send text to ${esc(first)}</a>` : '<span class="small muted">No phone number on this lead.</span>'}
        <button class="btn" onclick="navigator.clipboard.writeText(${esc(JSON.stringify(na.body || ''))}).then(()=>this.textContent='Copied ✓').catch(()=>{})">Copy text</button>
        <button class="btn" onclick="kl2DoneAction('${l.id}','text')">✓ I sent it</button>
        <button class="btn" style="color:var(--muted)" onclick="kl2DoneAction('${l.id}','skip')">Skip</button>
      </div>`;
  } else if (na && na.type === 'call') {
    btns = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
        ${l.phone ? `<a class="btn-amber" style="padding:7px 14px;text-decoration:none" href="tel:${esc(String(l.phone).replace(/[^\d+]/g, ''))}">📞 Call ${esc(l.phone)}</a>` : ''}
        <button class="btn" onclick="kl2ShowOutcomes('${l.id}')">Log the call outcome</button>
      </div>`;
  } else if (na && na.type === 'task') {
    btns = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><button class="btn-amber" onclick="kl2DoneAction('${l.id}','task')">✓ Done</button></div>`;
  }
  if (!na) return `<div id="kl2Outcomes"></div>`;
  return `<div style="margin-top:12px;border:1px solid rgba(217,119,6,.35);background:rgba(217,119,6,.06);border-radius:10px;padding:10px 12px">
    <div style="font-weight:800;font-size:.86rem">${kl2ActionIcon(l)} Next action${na.cadenceId ? ' <span class="small muted" style="font-weight:600">· from the sequence</span>' : ''}</div>
    <div style="font-size:.86rem;margin-top:2px">${esc(l.nextStep || '')}</div>${btns}
    <div id="kl2Outcomes"></div></div>`;
}
function kl2ShowOutcomes(id) {
  const box = document.getElementById('kl2Outcomes');
  if (!box) return;
  box.innerHTML = `<div style="margin-top:10px;padding:10px;border-radius:8px;background:rgba(110,145,210,.08)">
    <div style="font-weight:800;font-size:.84rem;margin-bottom:6px">How did the call go? <span class="small muted" style="font-weight:600">(required: it sets the next step)</span></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">${KL2_OUTCOMES.map(o => `<button class="btn" style="padding:6px 10px;font-size:.8rem" onclick="kl2Outcome('${id}','${o.key}')">${o.icon} ${o.label}</button>`).join('')}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">
      <input id="kl2CallNote" placeholder="Notes from the call (optional)" style="flex:1;min-width:200px;font-size:.84rem"/>
      <label class="small muted">Call back on <input id="kl2CallBack" type="date" value="${kl2Biz(3)}" style="font-size:.84rem"/></label>
    </div></div>`;
  box.scrollIntoView({ block: 'nearest' });
}
async function kl2Outcome(id, key) {
  const l = _klLeads.find(x => x.id === id);
  if (!l) return;
  const o = KL2_OUTCOMES.find(x => x.key === key);
  const note = ((document.getElementById('kl2CallNote') || {}).value || '').trim();
  const first = String(l.name || '').split(' ')[0] || 'them';
  const FV = firebase.firestore.FieldValue;
  const now = Date.now();
  const patch = { companyId: currentCompanyId, lastTouchMs: now, nextAction: FV.delete(), updatedMs: now, updatedBy: klMe(),
    activity: FV.arrayUnion({ type: 'call', outcome: key, note: o.label + (note ? ': ' + note : ''), at: now, by: klMe() }) };
  const active = l.cadence && l.cadence.status === 'active';
  const stopSeq = reason => { if (active) { patch['cadence.status'] = 'stopped'; patch['cadence.nextAt'] = FV.delete(); patch['cadence.stopReason'] = reason; } };
  const early = ['new', 'attempted'].includes(l.stage);
  if (key === 'interested') {
    if (early) { patch.stage = 'contacted'; patch.stageChangedAt = now; }
    stopSeq('Talked: interested');
    patch.nextStep = 'Book the walkthrough with ' + first; patch.nextDue = kl2Biz(1);
  } else if (key === 'callback') {
    const d = (document.getElementById('kl2CallBack') || {}).value;
    if (!d) { alert('Pick the call-back date.'); return; }
    if (early) { patch.stage = 'contacted'; patch.stageChangedAt = now; }
    if (active) { patch['cadence.status'] = 'paused'; patch['cadence.nextAt'] = FV.delete(); patch['cadence.pausedAt'] = now; }
    patch.nextStep = 'Call ' + first + ' back (they asked)'; patch.nextDue = d;
    patch.nextAction = { type: 'call', pending: true, at: now };
  } else if (key === 'answered') {
    if (early) { patch.stage = 'contacted'; patch.stageChangedAt = now; }
    const ns = prompt('What\'s the next step with ' + first + '?', l.nextStep && !/^Call/.test(l.nextStep) ? l.nextStep : 'Follow up');
    if (ns === null) return;
    patch.nextStep = ns.trim() || 'Follow up'; patch.nextDue = (document.getElementById('kl2CallBack') || {}).value || kl2Biz(2);
  } else if (key === 'voicemail' || key === 'noanswer') {
    if (l.stage === 'new') { patch.stage = 'attempted'; patch.stageChangedAt = now; }
    patch.nextStep = 'Try ' + first + ' again'; patch.nextDue = kl2Biz(2);
    patch.nextAction = { type: 'call', pending: true, at: now };
  } else if (key === 'notinterested') {
    stopSeq('Not interested');
    patch.stage = 'lost'; patch.stageChangedAt = now; patch.lostReason = 'Not interested' + (note ? ' — ' + note : '');
    patch.nextStep = ''; patch.nextDue = '';
  } else if (key === 'wrong') {
    patch.wrongNumber = true;
    patch.nextStep = 'Find the right phone number for ' + first; patch.nextDue = kl2Biz(0);
    patch.nextAction = { type: 'task', pending: true, at: now };
  }
  try { await coll('leads').doc(id).update(patch); setTimeout(() => klOpenLead(id), 250); }
  catch (e) { alert('Could not save: ' + e.message); }
}
// Text sent / task done: record it, and the next step becomes the sequence's
// next step (so the lead never sits without one).
async function kl2DoneAction(id, kind) {
  const l = _klLeads.find(x => x.id === id);
  if (!l) return;
  const FV = firebase.firestore.FieldValue;
  const now = Date.now();
  const na = l.nextAction || {};
  const act = kind === 'text' ? { type: 'text', note: 'Sent: ' + String(na.body || '').slice(0, 160) } : kind === 'skip' ? { type: 'note', note: 'Skipped: ' + (l.nextStep || '') } : { type: 'note', note: 'Done: ' + (l.nextStep || '') };
  const patch = { companyId: currentCompanyId, nextAction: FV.delete(), activity: FV.arrayUnion({ ...act, at: now, by: klMe() }) };
  if (kind === 'text') { patch.lastTouchMs = now; if (l.stage === 'new') { patch.stage = 'attempted'; patch.stageChangedAt = now; } }
  const nxt = kl2NextSeqStep(l);
  if (nxt) { patch.nextStep = 'Sequence: ' + nxt.label; patch.nextDue = nxt.date; }
  else { patch.nextStep = ''; patch.nextDue = ''; }
  try {
    await coll('leads').doc(id).update(patch);
    setTimeout(() => { klOpenLead(id); if (!nxt && KL_OPEN.includes(l.stage)) { const el = document.getElementById('klNextStep'); if (el) { el.focus(); el.style.outline = '2px solid #ef5350'; } } }, 250);
  } catch (e) { alert('Could not save: ' + e.message); }
}
function kl2NextSeqStep(l) {
  const c = l.cadence;
  if (!c || c.status !== 'active') return null;
  const cad = kl2Cfg().list.find(x => x.id === c.id);
  const s = cad && cad.steps[c.step];
  if (!s) return null;
  const at = c.nextAt || (c.startedAt + kl2Offset(s));
  const d = new Date(at);
  const first = String(l.name || '').split(' ')[0] || 'them';
  const fill = t => String(t || '').replace(/\{first_name\}/g, first).replace(/\{name\}/g, l.name || '');
  const what = s.action === 'email' ? 'Auto email "' + fill(s.subject) + '"' : s.action === 'sms' ? 'Text ' + first : s.action === 'stage' ? 'Move to ' + klStage(s.stage).label : fill(s.body) || (KL2_ACTIONS[s.action] || s.action);
  return { label: what, date: new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10), at };
}

// ── Sequence panel (in the lead modal) ──
function kl2SequencePanel(l) {
  const cfg = kl2Cfg();
  const c = l.cadence;
  const cad = c && cfg.list.find(x => x.id === c.id);
  let status = '<span class="small muted">Not in a sequence.</span>';
  if (c) {
    const total = cad ? cad.steps.length : '?';
    const nxt = c.status === 'active' ? kl2NextSeqStep(l) : null;
    const col = c.status === 'active' ? '#1dbb87' : c.status === 'paused' ? '#f59e0b' : 'var(--muted)';
    status = `<div style="font-size:.86rem"><strong>${esc(c.name || 'Sequence')}</strong> · <span style="color:${col};font-weight:700">${esc(c.status)}</span>
      ${c.status === 'active' ? ` · step ${c.step + 1} of ${total}` : c.stopReason ? ` · ${esc(c.stopReason)}` : ''}</div>
      ${nxt ? `<div class="small muted">Next: ${esc(nxt.label)} · ${new Date(nxt.at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>` : ''}`;
  }
  const opts = cfg.list.filter(x => x.active !== false).map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  return `<div style="margin-top:12px;border:1px solid rgba(110,145,210,.2);border-radius:10px;padding:10px 12px">
    <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:flex-start">
      <div style="min-width:0"><div style="font-weight:800;font-size:.84rem;margin-bottom:2px">🤖 Automatic follow-up</div>${status}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${c && c.status === 'active' ? `<button class="btn" style="padding:5px 10px;font-size:.78rem" onclick="kl2SeqCmd('${l.id}','pause')">⏸ Pause</button><button class="btn" style="padding:5px 10px;font-size:.78rem" onclick="kl2SeqCmd('${l.id}','stop')">⏹ Stop</button>` : ''}
        ${c && c.status === 'paused' ? `<button class="btn" style="padding:5px 10px;font-size:.78rem" onclick="kl2SeqCmd('${l.id}','resume')">▶ Resume</button><button class="btn" style="padding:5px 10px;font-size:.78rem" onclick="kl2SeqCmd('${l.id}','stop')">⏹ Stop</button>` : ''}
      </div>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center">
      <select id="kl2SeqPick" style="font-size:.8rem;padding:5px 8px;max-width:100%">${opts}</select>
      <button class="btn" style="padding:5px 10px;font-size:.78rem" onclick="kl2SeqCmd('${l.id}','start')">${c && c.status === 'active' ? 'Switch to this' : 'Start'}</button>
      ${l.unsubscribed ? '<span class="small" style="color:#ef5350">Unsubscribed from email</span>' : ''}${l.smsOptOut ? '<span class="small" style="color:#ef5350">Texted STOP</span>' : ''}
    </div></div>`;
}
async function kl2SeqCmd(id, cmd) {
  const l = _klLeads.find(x => x.id === id);
  if (!l) return;
  const FV = firebase.firestore.FieldValue;
  const now = Date.now();
  const patch = { companyId: currentCompanyId };
  const log = note => { patch.activity = FV.arrayUnion({ type: 'note', note, at: now, by: klMe() }); };
  if (cmd === 'pause') { patch['cadence.status'] = 'paused'; patch['cadence.nextAt'] = FV.delete(); patch['cadence.pausedAt'] = now; log('Paused sequence'); }
  else if (cmd === 'stop') { patch['cadence.status'] = 'stopped'; patch['cadence.nextAt'] = FV.delete(); patch['cadence.stopReason'] = 'Stopped by ' + klName(klMe()); log('Stopped sequence'); }
  else if (cmd === 'resume') {
    // Shift the schedule by the time it was paused, so steps keep their spacing.
    const shift = now - (l.cadence.pausedAt || now);
    const cad = kl2Cfg().list.find(x => x.id === l.cadence.id);
    const s = cad && cad.steps[l.cadence.step];
    const start = (l.cadence.startedAt || now) + shift;
    patch['cadence.status'] = 'active'; patch['cadence.startedAt'] = start;
    patch['cadence.nextAt'] = Math.max(now + 6e4, start + (s ? kl2Offset(s) : 0)); patch['cadence.pausedAt'] = FV.delete();
    log('Resumed sequence');
  } else if (cmd === 'start') {
    const pick = (document.getElementById('kl2SeqPick') || {}).value;
    const cad = kl2Cfg().list.find(x => x.id === pick);
    if (!cad || !cad.steps.length) return;
    if (l.cadence && l.cadence.status === 'active' && !confirm(`Stop "${l.cadence.name}" and start "${cad.name}"?`)) return;
    patch.cadence = { id: cad.id, name: cad.name, trigger: cad.trigger, step: 0, startedAt: now, nextAt: now + kl2Offset(cad.steps[0]), status: 'active' };
    log('Started sequence: ' + cad.name);
  }
  try { await coll('leads').doc(id).update(patch); setTimeout(() => klOpenLead(id), 300); }
  catch (e) { alert('Could not update: ' + e.message); }
}

// ── Today: the numbers Jason asked for ──
function kl2TodayTiles() {
  const t = klToday();
  const leads = klVisible();
  const open = leads.filter(l => KL_OPEN.includes(l.stage));
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const month = new Date(start.getFullYear(), start.getMonth(), 1).getTime();
  const tiles = [
    ['New leads today', leads.filter(l => (l.createdMs || 0) >= start.getTime()).length, '#60a5fa'],
    ['Calls due', open.filter(l => l.nextDue && l.nextDue <= t && (!l.nextAction || l.nextAction.type === 'call')).length, '#f59e0b'],
    ['Overdue', open.filter(l => l.nextDue && l.nextDue < t).length, '#ef5350'],
    ['Proposals awaiting reply', leads.filter(l => l.stage === 'sent' || l.stage === 'followup').length, '#eab308'],
    ['Open pipeline', klMoney(open.reduce((s, l) => s + (Number(l.value) || 0), 0)), '#a3f2d2'],
    ['Closed this month', klMoney(leads.filter(l => (l.wonAt || 0) >= month).reduce((s, l) => s + (Number(l.value) || 0), 0)), '#1dbb87'],
  ];
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px">${tiles.map(([lbl, v, c]) =>
    `<div class="kt-card" style="padding:12px 14px"><div style="font-size:1.3rem;font-weight:900;color:${c};font-variant-numeric:tabular-nums">${v}</div><div class="small muted">${lbl}</div></div>`).join('')}</div>`;
}

// ── Sequences tab: view + edit ──
function kl2SequencesHtml() {
  const cfg = kl2Cfg();
  const edit = kl2CanEdit();
  const plivo = cfg.smsReady;
  const cards = cfg.list.map((c, i) => `<div class="kt-card" style="padding:14px;margin-bottom:10px">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">
      <div style="min-width:0"><div style="font-weight:800">${esc(c.name)} ${c.active === false ? '<span class="small" style="color:var(--muted)">(off)</span>' : ''}</div>
        <div class="small muted">${esc(kl2TriggerLabel(c.trigger))} · ${kl2AudLabel(c.audience)} · ${c.steps.length} steps</div></div>
      ${edit ? `<div style="display:flex;gap:6px"><button class="btn" style="padding:5px 10px;font-size:.78rem" onclick="kl2EditSeq(${i})">✏️ Edit</button><button class="btn" style="padding:5px 10px;font-size:.78rem" onclick="kl2ToggleSeq(${i})">${c.active === false ? 'Turn on' : 'Turn off'}</button></div>` : ''}
    </div>
    <div style="overflow-x:auto;margin-top:8px"><table class="kt-table" style="width:100%;font-size:.8rem">
      <tbody>${c.steps.map(s => `<tr><td style="padding:5px 8px;white-space:nowrap;color:var(--amber);font-weight:700">${kl2When(s)}</td><td style="padding:5px 8px;white-space:nowrap">${KL2_ACTIONS[s.action] || s.action}${s.action === 'email' || s.action === 'sms' ? ' <span class="small muted">(auto)</span>' : ''}</td><td style="padding:5px 8px">${esc(s.action === 'email' ? (s.subject || '') : s.action === 'stage' ? '→ ' + klStage(s.stage).label : String(s.body || '').slice(0, 110))}</td></tr>`).join('')}</tbody>
    </table></div></div>`).join('');
  return `<div class="kt-card" style="padding:14px;margin-bottom:12px">
      <div style="font-weight:800;margin-bottom:4px">How sequences work</div>
      <div class="small muted" style="line-height:1.6">Every new lead starts the sequence for its customer type automatically. Emails send on their own from Gmail, with replies going to the lead's owner. ${plivo ? 'Texts send on their own.' : 'Texts show up as a one-tap <b>Send text</b> next step for the salesperson (automatic texting turns on once a business texting number is connected).'} Calls and tasks become the lead's next step on that day.
      Follow-ups stop when the customer texts back, when the lead moves to Appointment Set or later, or when a call is logged as interested / not interested. Moving a lead to a stage can start that stage's sequence: <b>Project Complete</b> starts post-project follow-up, and <b>Long-term Nurture</b> starts nurture. Automatic messages only go out Monday–Saturday during sending hours, never on Sunday.</div>
      ${cfg.isDefault ? '<div class="small" style="margin-top:6px;color:#f59e0b">Using the starter sequences from Jason\'s requirements. Edit any of them to make them yours.</div>' : ''}
    </div>
    ${edit ? kl2SettingsHtml(cfg) : ''}
    ${edit ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"><button class="btn-amber" onclick="kl2EditSeq(-1)">+ New sequence</button>${!cfg.isDefault ? '<button class="btn" onclick="kl2ResetSeqs()">Reset to starter sequences</button>' : ''}</div>` : ''}
    ${cards}`;
}
function kl2SettingsHtml(cfg) {
  return `<details class="kt-card" style="padding:12px 14px;margin-bottom:12px"><summary style="cursor:pointer;font-weight:800">⚙ Follow-up settings</summary>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:10px">
      <label class="small muted">Escalate a new lead nobody has contacted after (hours)<input id="kl2EscH" type="number" min="1" step="1" value="${Number(cfg.escalateHours) || 2}" style="width:100%"/></label>
      <label class="small muted">Escalation also goes to (email)<input id="kl2EscTo" type="email" value="${esc(cfg.escalateTo || '')}" placeholder="the company owner" style="width:100%"/></label>
      <label class="small muted">Sending hours start (0–23, Central)<input id="kl2QS" type="number" min="0" max="23" value="${cfg.quietStart != null ? cfg.quietStart : 8}" style="width:100%"/></label>
      <label class="small muted">Sending hours end<input id="kl2QE" type="number" min="1" max="24" value="${cfg.quietEnd != null ? cfg.quietEnd : 19}" style="width:100%"/></label>
      <label class="small muted">Review link (Google / Facebook) used as {review_link}<input id="kl2Rev" value="${esc(cfg.reviewUrl || '')}" placeholder="https://g.page/r/…" style="width:100%"/></label>
      <label class="small muted" style="display:flex;gap:8px;align-items:center"><input id="kl2Auto" type="checkbox" ${cfg.autoEnroll === false ? '' : 'checked'} style="width:auto"/> Start new leads on a sequence automatically</label>
    </div>
    <button class="btn-amber" style="margin-top:10px" onclick="kl2SaveSettings()">Save settings</button></details>`;
}
async function kl2SaveCfg(patch) {
  try { await coll('settings').doc('cadences').set({ ...patch, updatedMs: Date.now(), updatedBy: klMe() }, { merge: true }); }
  catch (e) { alert('Could not save: ' + e.message); throw e; }
}
async function kl2SaveSettings() {
  const v = id => (document.getElementById(id) || {}).value;
  await kl2SaveCfg({ escalateHours: Number(v('kl2EscH')) || 2, escalateTo: String(v('kl2EscTo') || '').trim().toLowerCase(), quietStart: Number(v('kl2QS')), quietEnd: Number(v('kl2QE')), reviewUrl: String(v('kl2Rev') || '').trim(), autoEnroll: !!(document.getElementById('kl2Auto') || {}).checked });
  alert('Saved.');
}
async function kl2ToggleSeq(i) {
  const list = JSON.parse(JSON.stringify(kl2Cfg().list));
  list[i].active = list[i].active === false;
  await kl2SaveCfg({ list });
}
async function kl2ResetSeqs() {
  if (!confirm('Replace all sequences with the starter set? Leads already in a sequence keep going if the sequence name still exists.')) return;
  await kl2SaveCfg({ list: KL2_DEFAULT_CADENCES });
}
function kl2EditSeq(i) {
  const list = kl2Cfg().list;
  _kl2Edit = { i, c: i >= 0 ? JSON.parse(JSON.stringify(list[i])) : { id: 'seq-' + Date.now().toString(36), name: 'New sequence', trigger: 'lead_created', audience: 'any', active: true, steps: [{ value: 0, unit: 'days', action: 'sms', body: 'Hi {first_name}, this is {owner_first} with {company}.' }] } };
  if (!document.getElementById('kl2SeqModal')) {
    const d = document.createElement('div');
    d.id = 'kl2SeqModal'; d.className = 'modal-overlay';
    d.innerHTML = `<div class="modal-box" style="max-width:900px"><div class="modal-head"><h3 style="margin:0">Edit sequence</h3><button class="btn" onclick="kClose('kl2SeqModal')">Close</button></div><div class="modal-body" id="kl2SeqBody"></div></div>`;
    document.body.appendChild(d);
  }
  kl2RenderEditor();
  kOpen('kl2SeqModal');
}
function kl2RenderEditor() {
  const c = _kl2Edit.c;
  const team = klTeam();
  const trig = [['lead_created', 'When a new lead comes in']].concat(KL_STAGES.map(s => ['stage:' + s.key, 'When a lead moves to ' + s.label]));
  const sel = (arr, cur) => arr.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
  document.getElementById('kl2SeqBody').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
      <label class="small muted">Name<input value="${esc(c.name)}" oninput="_kl2Edit.c.name=this.value" style="width:100%"/></label>
      <label class="small muted">Starts<select onchange="_kl2Edit.c.trigger=this.value" style="width:100%">${sel(trig, c.trigger)}</select></label>
      <label class="small muted">For<select onchange="_kl2Edit.c.audience=this.value" style="width:100%">${sel([['investor', 'Investors (flip, rental, property manager)'], ['homeowner', 'Homeowners and everyone else'], ['any', 'Everyone (fallback)']], c.audience || 'any')}</select></label>
    </div>
    <div class="small muted" style="margin:10px 0 6px">Fill-ins you can use: {first_name} {name} {company} {owner_name} {owner_first} {address} {at_address} {address_or_project} {review_link}. Timing counts from when the sequence starts ("Day 4" = four days after the lead came in).</div>
    ${c.steps.map((s, j) => `<div style="border:1px solid rgba(110,145,210,.2);border-radius:10px;padding:10px;margin-bottom:8px">
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <input type="number" min="0" step="1" value="${Number(s.value) || 0}" oninput="_kl2Edit.c.steps[${j}].value=Number(this.value)" style="width:70px;flex:0 0 auto"/>
        <select style="${KL2_SEL}" onchange="_kl2Edit.c.steps[${j}].unit=this.value">${sel([['minutes', 'minutes'], ['hours', 'hours'], ['days', 'days'], ['weeks', 'weeks'], ['months', 'months']], s.unit || 'days')}</select>
        <span class="small muted">after start →</span>
        <select style="${KL2_SEL}" onchange="_kl2Edit.c.steps[${j}].action=this.value;kl2RenderEditor()">${sel(Object.entries(KL2_ACTIONS), s.action)}</select>
        ${['call', 'task', 'sms'].includes(s.action) ? `<select style="${KL2_SEL}" onchange="_kl2Edit.c.steps[${j}].assign=this.value" title="Who does it"><option value="owner">Lead's owner</option>${team.map(m => `<option value="${esc((m.email || '').toLowerCase())}" ${(s.assign || '') === (m.email || '').toLowerCase() ? 'selected' : ''}>${esc(m.name || m.email)}</option>`).join('')}</select>` : ''}
        ${s.action === 'stage' ? `<select style="${KL2_SEL}" onchange="_kl2Edit.c.steps[${j}].stage=this.value">${sel(KL_STAGES.map(x => [x.key, x.label]), s.stage)}</select>` : ''}
        <span style="margin-left:auto;display:flex;gap:4px">
          <button class="btn" style="padding:3px 8px" ${j === 0 ? 'disabled' : ''} onclick="kl2MoveStep(${j},-1)">↑</button>
          <button class="btn" style="padding:3px 8px" ${j === c.steps.length - 1 ? 'disabled' : ''} onclick="kl2MoveStep(${j},1)">↓</button>
          <button class="btn" style="padding:3px 8px;color:#ef5350" onclick="_kl2Edit.c.steps.splice(${j},1);kl2RenderEditor()">✕</button>
        </span>
      </div>
      ${s.action === 'email' ? `<input placeholder="Email subject" value="${esc(s.subject || '')}" oninput="_kl2Edit.c.steps[${j}].subject=this.value" style="width:100%;margin-top:6px"/>` : ''}
      <textarea placeholder="${s.action === 'call' || s.action === 'task' ? 'What the salesperson should do' : s.action === 'stage' ? 'Note (optional)' : 'Message'}" oninput="_kl2Edit.c.steps[${j}].body=this.value" style="width:100%;margin-top:6px;min-height:${s.action === 'email' ? 110 : 52}px;font-size:.84rem">${esc(s.body || '')}</textarea>
    </div>`).join('')}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <button class="btn" onclick="_kl2Edit.c.steps.push({value:(_kl2Edit.c.steps.slice(-1)[0]||{}).value||0,unit:'days',action:'call',body:''});kl2RenderEditor()">+ Add step</button>
      <button class="btn-amber" onclick="kl2SaveSeq()">Save sequence</button>
      ${_kl2Edit.i >= 0 ? `<button class="btn" style="margin-left:auto;color:#ef5350" onclick="kl2DeleteSeq()">Delete sequence</button>` : ''}
    </div>`;
}
function kl2MoveStep(j, d) { const st = _kl2Edit.c.steps; [st[j], st[j + d]] = [st[j + d], st[j]]; kl2RenderEditor(); }
async function kl2SaveSeq() {
  const c = _kl2Edit.c;
  if (!c.name.trim() || !c.steps.length) { alert('Give it a name and at least one step.'); return; }
  const bad = c.steps.find(s => (s.action === 'email' && (!s.subject || !s.body)) || (s.action === 'sms' && !s.body) || (s.action === 'stage' && !s.stage));
  if (bad) { alert('Every email needs a subject and message, every text needs a message, and every "Move stage" step needs a stage.'); return; }
  c.steps.sort((a, b) => kl2Offset(a) - kl2Offset(b));
  const list = JSON.parse(JSON.stringify(kl2Cfg().list));
  if (_kl2Edit.i >= 0) list[_kl2Edit.i] = c; else list.push(c);
  await kl2SaveCfg({ list });
  kClose('kl2SeqModal');
}
async function kl2DeleteSeq() {
  if (!confirm('Delete this sequence? Leads currently in it stop getting its steps.')) return;
  const list = JSON.parse(JSON.stringify(kl2Cfg().list));
  list.splice(_kl2Edit.i, 1);
  await kl2SaveCfg({ list });
  kClose('kl2SeqModal');
}
Object.assign(window, { kl2ShowOutcomes, kl2Outcome, kl2DoneAction, kl2SeqCmd, kl2EditSeq, kl2RenderEditor, kl2MoveStep, kl2SaveSeq, kl2DeleteSeq, kl2ToggleSeq, kl2ResetSeqs, kl2SaveSettings, kl2ClearDup });

// Start the listener once the app has a company, so the sidebar badge works
// on every page, not only after Leads is opened.
(function klBoot() {
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (typeof conDb !== 'undefined' && conDb && typeof currentCompanyId !== 'undefined' && currentCompanyId && typeof currentUserRole !== 'undefined' && currentUserRole) {
      clearInterval(t);
      const nav = document.querySelector('.kt-nav-item[onclick*="\'leads\'"]');
      if (!canSeeLeads()) { if (nav) nav.style.display = 'none'; return; }
      if (nav) nav.style.display = '';
      klStartListener();
    } else if (tries > 240) clearInterval(t);
  }, 500);
})();
