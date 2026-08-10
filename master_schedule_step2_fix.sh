cd ~/Documents/JOBSpan

echo "=== STEP 1: Wiring real date editing into Master Schedule (Phase + Room), Owner-only (skips safely if already applied) ==="
python3 - <<'PYEOF2'
with open('kytrac-app.js', 'r', encoding='utf-8') as f:
    js = f.read()

marker = "updateMasterPhaseDate"
already = js.count(marker)
print(f"Marker currently appears {already} time(s) before this step.")

if already >= 2:
    print("Already patched -- skipping.")
else:
    old1 = "function toggleMasterRow(type, id) {"
    new1 = "// Master Schedule's own date-update functions -- deliberately\n// separate from updatePhaseDate/updateRoomDate (the per-job Schedule\n// tab's versions), which rely on the implicit _ganttJobId global.\n// Master Schedule shows many jobs on screen at once, so every write\n// here takes jobId explicitly instead -- reusing the per-job\n// functions as-is would silently write to whatever job happened to\n// be open last on the Schedule tab, corrupting a different job's\n// dates. Full re-render after each save, matching how\n// renderMasterSchedulePage already refetches every job's tree on\n// every call -- not a new performance cost, just reusing the existing\n// pattern.\nasync function updateMasterPhaseDate(jobId, phaseId, field, value) {\n  if (!jobId || !conDb) return;\n  try {\n    await coll('jobs').doc(jobId)\n      .collection('estimateGroups').doc(phaseId)\n      .update({ [field]: value, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });\n    renderMasterSchedulePage();\n  } catch(e) {\n    alert('Could not save phase date: ' + e.message);\n  }\n}\nwindow.updateMasterPhaseDate = updateMasterPhaseDate;\n\nasync function updateMasterRoomDate(jobId, phaseId, roomId, field, value) {\n  if (!jobId || !conDb) return;\n  try {\n    await coll('jobs').doc(jobId)\n      .collection('estimateGroups').doc(phaseId)\n      .collection('subgroups').doc(roomId)\n      .update({ [field]: value, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });\n    renderMasterSchedulePage();\n  } catch(e) {\n    alert('Could not save room date: ' + e.message);\n  }\n}\nwindow.updateMasterRoomDate = updateMasterRoomDate;\n\nfunction toggleMasterRow(type, id) {"
    old2 = "  const todayOffset = Math.floor((today - minDate) / 86400000) * DAY_W;\n\n  if (!window._masterCollapsed) window._masterCollapsed = {};"
    new2 = "  const todayOffset = Math.floor((today - minDate) / 86400000) * DAY_W;\n\n  if (!window._masterCollapsed) window._masterCollapsed = {};\n  const isOwner = ['Owner', 'Full Access'].includes(currentUserRole);"
    old3 = "  function sixCols(nameHtml, days, start, finish, deps, pct, pctColorVal) {\n    return `<div class=\"gantt-name-cell\">${nameHtml}</div>\n      <div class=\"gantt-days-cell\">${days ?? '—'}</div>\n      <div class=\"gantt-date-cell gantt-start-cell\">${start || '—'}</div>\n      <div class=\"gantt-date-cell gantt-end-cell\">${finish || '—'}</div>\n      <div class=\"gantt-deps-cell\">${deps || ''}</div>\n      <div class=\"gantt-pct-cell\" style=\"color:${pctColorVal || 'var(--muted)'};font-weight:700\">${pct}%</div>`;\n  }"
    new3 = "  function sixCols(nameHtml, days, startHtml, finishHtml, deps, pct, pctColorVal) {\n    return `<div class=\"gantt-name-cell\">${nameHtml}</div>\n      <div class=\"gantt-days-cell\">${days ?? '—'}</div>\n      <div class=\"gantt-date-cell gantt-start-cell\" onclick=\"event.stopPropagation()\">${startHtml}</div>\n      <div class=\"gantt-date-cell gantt-end-cell\" onclick=\"event.stopPropagation()\">${finishHtml}</div>\n      <div class=\"gantt-deps-cell\">${deps || ''}</div>\n      <div class=\"gantt-pct-cell\" style=\"color:${pctColorVal || 'var(--muted)'};font-weight:700\">${pct}%</div>`;\n  }"
    old4 = "        `<span id=\"masterArrowJob_${job.id}\" style=\"flex-shrink:0\">${jobCollapsed?'▶':'▼'}</span><span style=\"color:var(--amber)\">🏠 ${esc(job.name)}</span>`,\n        jobDays !== null ? jobDays + 'd' : null,\n        job.startDate, job.endDate, '', _jobPct, _jobPctColor"
    new4 = "        `<span id=\"masterArrowJob_${job.id}\" style=\"flex-shrink:0\">${jobCollapsed?'▶':'▼'}</span><span style=\"color:var(--amber)\">🏠 ${esc(job.name)}</span>`,\n        jobDays !== null ? jobDays + 'd' : null,\n        esc(job.startDate || '—'), esc(job.endDate || '—'), '', _jobPct, _jobPctColor"
    old5 = "            `${roomCount?`<span id=\"masterArrowPhase_${phase.id}\" style=\"flex-shrink:0\">${phaseCollapsed?'▶':'▼'}</span>`:'<span style=\"width:10px;flex-shrink:0\"></span>'}<span style=\"padding-left:14px;color:#93c5fd\">${esc(phase.name)}</span>`,\n            phaseDays !== null ? phaseDays + 'd' : null,\n            phase.startDate, phase.endDate, '', phasePct, pctColor(phasePct)"
    new5 = "            `${roomCount?`<span id=\"masterArrowPhase_${phase.id}\" style=\"flex-shrink:0\">${phaseCollapsed?'▶':'▼'}</span>`:'<span style=\"width:10px;flex-shrink:0\"></span>'}<span style=\"padding-left:14px;color:#93c5fd\">${esc(phase.name)}</span>`,\n            phaseDays !== null ? phaseDays + 'd' : null,\n            isOwner ? `<input type=\"date\" value=\"${phase.startDate||''}\" onchange=\"updateMasterPhaseDate('${job.id}','${phase.id}','startDate',this.value)\">` : esc(phase.startDate || '—'),\n            isOwner ? `<input type=\"date\" value=\"${phase.endDate||''}\" onchange=\"updateMasterPhaseDate('${job.id}','${phase.id}','endDate',this.value)\">` : esc(phase.endDate || '—'),\n            '', phasePct, pctColor(phasePct)"
    old6 = "                `${displayTasks.length?`<span id=\"masterArrowRoom_${room.id}\" style=\"flex-shrink:0\">${roomCollapsed?'▶':'▼'}</span>`:'<span style=\"width:8px;flex-shrink:0\"></span>'}<span style=\"padding-left:24px;color:#94a3b8\">${esc(room.name)} <span style=\"color:var(--muted);font-size:.62rem\">(${doneTasks}/${displayTasks.length})</span></span>`,\n                roomDays !== null ? roomDays + 'd' : null,\n                roomStartD, roomEndD, formatDependsOn(room.dependsOn), pct, pctColor(pct)"
    new6 = "                `${displayTasks.length?`<span id=\"masterArrowRoom_${room.id}\" style=\"flex-shrink:0\">${roomCollapsed?'▶':'▼'}</span>`:'<span style=\"width:8px;flex-shrink:0\"></span>'}<span style=\"padding-left:24px;color:#94a3b8\">${esc(room.name)} <span style=\"color:var(--muted);font-size:.62rem\">(${doneTasks}/${displayTasks.length})</span></span>`,\n                roomDays !== null ? roomDays + 'd' : null,\n                isOwner ? `<input type=\"date\" value=\"${room.startDate||''}\" onchange=\"updateMasterRoomDate('${job.id}','${phase.id}','${room.id}','startDate',this.value)\" title=\"${room.startDate?'Custom date':'Auto-scheduled from phase -- set a date here to override'}\">` : esc(roomStartD || '—'),\n                isOwner ? `<input type=\"date\" value=\"${room.endDate||''}\" onchange=\"updateMasterRoomDate('${job.id}','${phase.id}','${room.id}','endDate',this.value)\" title=\"${room.endDate?'Custom date':'Auto-scheduled from phase -- set a date here to override'}\">` : esc(roomEndD || '—'),\n                formatDependsOn(room.dependsOn), pct, pctColor(pct)"
    old7 = "                    task.durationDays || null, task.startDate, task.endDate, '', tPct, isDone ? '#10b981' : (tPct>0 ? '#60a5fa' : 'var(--muted)')"
    new7 = "                    task.durationDays || null, esc(task.startDate || '—'), esc(task.endDate || '—'), '', tPct, isDone ? '#10b981' : (tPct>0 ? '#60a5fa' : 'var(--muted)')"
    old8 = "          ${sixCols('<span style=\"padding-left:24px;font-style:italic;color:var(--muted)\">No phases with dates set</span>', null, null, null, '', 0)}"
    new8 = "          ${sixCols('<span style=\"padding-left:24px;font-style:italic;color:var(--muted)\">No phases with dates set</span>', null, '—', '—', '', 0)}"
    c1,c2,c3,c4,c5,c6,c7,c8 = js.count(old1), js.count(old2), js.count(old3), js.count(old4), js.count(old5), js.count(old6), js.count(old7), js.count(old8)
    print(f"Matches: {c1},{c2},{c3},{c4},{c5},{c6},{c7},{c8} (all expect 1)")
    ok = all(c==1 for c in [c1,c2,c3,c4,c5,c6,c7,c8])
    if ok:
        js = js.replace(old1, new1)
        js = js.replace(old2, new2)
        js = js.replace(old3, new3)
        js = js.replace(old4, new4)
        js = js.replace(old5, new5)
        js = js.replace(old6, new6)
        js = js.replace(old7, new7)
        js = js.replace(old8, new8)
        with open('kytrac-app.js', 'w', encoding='utf-8') as f:
            f.write(js)
        print("Patched all 8 spots.")
    else:
        print("!! STOP -- one or more matches was not exactly 1. Tell Claude these numbers:", [c1,c2,c3,c4,c5,c6,c7,c8])
PYEOF2

node --check kytrac-app.js && echo "Syntax OK" || { echo "!! SYNTAX ERROR -- STOP, tell Claude"; exit 1; }

echo ""
echo "=== STEP 2: Bumping the cache-buster version stamp ==="
python3 - <<'PYEOF3'
import re, datetime
with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()
newv = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M')
html2 = re.sub(r'kytrac-app\.js\?v=\d+', f'kytrac-app.js?v={newv}', html)
changed = html != html2
with open('index.html', 'w', encoding='utf-8') as f:
    f.write(html2)
print(f"Cache-buster bumped to {newv}: {'yes' if changed else 'NO CHANGE FOUND -- tell Claude'}")
PYEOF3

echo ""
echo "=== STEP 3: Commit + push ==="
git add -A
git commit -m "Master Schedule: real Phase and Room date editing (Owner-only), writes to the correct job explicitly"
git push origin main

echo ""
echo "=== STEP 4: Regenerate version.json with the real deployed commit hash ==="
echo "{\"commit\":\"$(git rev-parse --short HEAD)\",\"date\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > version.json
cat version.json

echo ""
echo "=== STEP 5: Deploy ==="
firebase deploy --only hosting --project kytrac-72d91

echo ""
echo "=== DONE -- Build badge should now read: $(git rev-parse --short HEAD) ==="
