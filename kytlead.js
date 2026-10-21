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

const KL_STAGES = [
  { key: 'new',        label: 'New Lead',        color: '#60a5fa' },
  { key: 'contacted',  label: 'Contacted',       color: '#a78bfa' },
  { key: 'appt',       label: 'Appointment Set', color: '#f59e0b' },
  { key: 'estimating', label: 'Estimating',      color: '#fb923c' },
  { key: 'sent',       label: 'Estimate Sent',   color: '#eab308' },
  { key: 'followup',   label: 'Follow-up',       color: '#f472b6' },
  { key: 'won',        label: 'Won',             color: '#1dbb87' },
  { key: 'lost',       label: 'Lost',            color: '#6b7280' },
];
const KL_OPEN = ['new', 'contacted', 'appt', 'estimating', 'sent', 'followup'];
const KL_SOURCES = ['Referral', 'Investor', 'Repeat customer', 'Website', 'Facebook', 'Google', 'Nextdoor', 'Yard sign', 'Truck', 'Hipshot', 'Networking event', 'Other'];
const KL_TYPES = ['Investor flip', 'Retail homeowner', 'Rental / landlord', 'Commercial', 'Other'];
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
  return 'won';
}
function klSyncFromJobs() {
  if (!Array.isArray(conJobs)) return;
  _klLeads.forEach(l => {
    if (!l.jobId || l.isActivityLog) return;
    const job = conJobs.find(j => j.id === l.jobId);
    if (!job) return;
    const st = klStageFromJob(job.status);
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
  const tabs = [['pipeline', '📋 Pipeline'], ['today', '⏰ Today'], ['scorecard', '📈 Scorecard'], ['capture', '🌐 Web Form']];
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
    ${l.nextStep ? `<div style="font-size:.74rem;color:var(--text);margin-top:3px">→ ${esc(l.nextStep)}</div>` : ''}
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
    if (['won', 'lost'].includes(s.key)) { // keep the board fast: last 90 days of closed deals
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
      <div style="font-size:.78rem;color:var(--muted)">${l.nextStep ? '→ ' + esc(l.nextStep) : 'No next step set'}${l.phone ? ' · ' + esc(l.phone) : ''}</div></div>
      <div style="text-align:right;flex-shrink:0">${klDueChip(l)}<div style="font-size:.7rem;color:var(--muted)">${esc(klName(l.owner))}</div></div>
    </div>`;
  const sec = (title, color, list) => list.length ? `<div class="kt-card" style="padding:0;margin-bottom:12px"><div style="padding:10px 12px;font-weight:800;color:${color}">${title} (${list.length})</div>${list.map(row).join('')}</div>` : '';
  const html = sec('🔴 Overdue', '#ef5350', overdue) + sec('🟠 Due today', '#f59e0b', today) + sec('⚠ No next step', '#ef5350', none) + sec('📅 Next 3 days', 'var(--muted)', soon);
  return html || '<div class="kt-card" style="padding:20px">✅ Nothing due. Every open lead has a next step that isn\'t due yet.</div>';
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
      ${f('Type', `<select id="klType" style="width:100%"><option value="">—</option>${opt(KL_TYPES, l.type)}</select>`)}
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
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${KL_ACTS.map(a => `<button class="btn" style="padding:5px 10px;font-size:.78rem" onclick="klLogActivity('${id}','${a.key}')">${a.icon} ${a.label}</button>`).join('')}</div>
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
          <span>${meta ? meta.icon : '↪'}</span><div style="flex:1;min-width:0">${esc(meta ? meta.label : 'Stage')}${a.note ? ' — ' + esc(a.note) : ''}</div>
          <span style="color:var(--muted);white-space:nowrap">${new Date(a.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${esc(klInitials(a.by))}</span></div>`;
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
