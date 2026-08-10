cd ~/Documents/JOBSpan

echo "=== STEP 1: Wiring Job and Task date editing into Master Schedule (skips safely if already applied) ==="
python3 - <<'PYEOF2'
with open('kytrac-app.js', 'r', encoding='utf-8') as f:
    js = f.read()

marker = "updateMasterJobDate"
already = js.count(marker)
print(f"Marker currently appears {already} time(s) before this step.")

if already >= 2:
    print("Already patched -- skipping.")
else:
    old1 = "window.updateMasterRoomDate = updateMasterRoomDate;"
    new1 = "window.updateMasterRoomDate = updateMasterRoomDate;\n\nasync function updateMasterJobDate(jobId, field, value) {\n  if (!jobId || !conDb) return;\n  try {\n    const job = conJobs.find(j => j.id === jobId);\n    if (job) job[field] = value;\n    await coll('jobs').doc(jobId).update({ [field]: value, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });\n    renderMasterSchedulePage();\n  } catch(e) {\n    alert('Could not save job date: ' + e.message);\n  }\n}\nwindow.updateMasterJobDate = updateMasterJobDate;\n\n// Task-level dates -- only for REAL tasks (actual items in Firestore).\n// Rooms with no real tasks yet fall back to parsing room.scopeNotes\n// into synthetic display-only rows (id 'scope_<roomId>_<n>') so\n// something still renders -- those aren't Firestore documents and\n// can't be written to, so the row stays read-only for those\n// specifically (checked at the call site via task.id.startsWith\n// ('scope_'), the same synthetic-row marker used when they're built).\nasync function updateMasterTaskDate(jobId, phaseId, roomId, taskId, field, value) {\n  if (!jobId || !conDb) return;\n  try {\n    await coll('jobs').doc(jobId)\n      .collection('estimateGroups').doc(phaseId)\n      .collection('subgroups').doc(roomId)\n      .collection('items').doc(taskId)\n      .update({ [field]: value, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });\n    renderMasterSchedulePage();\n  } catch(e) {\n    alert('Could not save task date: ' + e.message);\n  }\n}\nwindow.updateMasterTaskDate = updateMasterTaskDate;"
    old2 = "        `<span id=\"masterArrowJob_${job.id}\" style=\"flex-shrink:0\">${jobCollapsed?'▶':'▼'}</span><span style=\"color:var(--amber)\">🏠 ${esc(job.name)}</span>`,\n        jobDays !== null ? jobDays + 'd' : null,\n        esc(job.startDate || '—'), esc(job.endDate || '—'), '', _jobPct, _jobPctColor"
    new2 = "        `<span id=\"masterArrowJob_${job.id}\" style=\"flex-shrink:0\">${jobCollapsed?'▶':'▼'}</span><span style=\"color:var(--amber)\">🏠 ${esc(job.name)}</span>`,\n        jobDays !== null ? jobDays + 'd' : null,\n        isOwner ? `<input type=\"date\" value=\"${job.startDate||''}\" onchange=\"updateMasterJobDate('${job.id}','startDate',this.value)\">` : esc(job.startDate || '—'),\n        isOwner ? `<input type=\"date\" value=\"${job.endDate||''}\" onchange=\"updateMasterJobDate('${job.id}','endDate',this.value)\">` : esc(job.endDate || '—'),\n        '', _jobPct, _jobPctColor"
    old3 = "                const isDone = tPct === 100;\n                const glyph = isDone ? '☑' : (tPct > 0 ? tPct + '%' : '☐');\n                rowsHtml += `<div data-master-row=\"task\" data-task-idx=\"${ti}\" data-parent-room=\"${room.id}\" data-parent-phase=\"${phase.id}\" data-parent-job=\"${job.id}\" class=\"gantt-left-row task-row\" style=\"min-height:${TASK_H}px\">\n                  ${sixCols(\n                    `<span style=\"padding-left:36px;font-weight:${isDone?'400':'700'};color:${isDone?'#10b981':tPct>0?'#60a5fa':'var(--muted)'}\">${glyph}</span><span style=\"color:${isDone?'#10b981':'#64748b'};text-decoration:${isDone?'line-through':'none'}\">${esc(task.name)}</span>`,\n                    task.durationDays || null, esc(task.startDate || '—'), esc(task.endDate || '—'), '', tPct, isDone ? '#10b981' : (tPct>0 ? '#60a5fa' : 'var(--muted)')\n                  )}\n                  <div style=\"flex:1;min-width:${totalWidth}px\"></div>"
    new3 = "                const isDone = tPct === 100;\n                const glyph = isDone ? '☑' : (tPct > 0 ? tPct + '%' : '☐');\n                const isRealTask = !String(task.id).startsWith('scope_');\n                const taskCanEdit = isOwner && isRealTask;\n                rowsHtml += `<div data-master-row=\"task\" data-task-idx=\"${ti}\" data-parent-room=\"${room.id}\" data-parent-phase=\"${phase.id}\" data-parent-job=\"${job.id}\" class=\"gantt-left-row task-row\" style=\"min-height:${TASK_H}px\">\n                  ${sixCols(\n                    `<span style=\"padding-left:36px;font-weight:${isDone?'400':'700'};color:${isDone?'#10b981':tPct>0?'#60a5fa':'var(--muted)'}\">${glyph}</span><span style=\"color:${isDone?'#10b981':'#64748b'};text-decoration:${isDone?'line-through':'none'}\">${esc(task.name)}</span>`,\n                    task.durationDays || null,\n                    taskCanEdit ? `<input type=\"date\" value=\"${task.startDate||''}\" onchange=\"updateMasterTaskDate('${job.id}','${phase.id}','${room.id}','${task.id}','startDate',this.value)\">` : esc(task.startDate || '—'),\n                    taskCanEdit ? `<input type=\"date\" value=\"${task.endDate||''}\" onchange=\"updateMasterTaskDate('${job.id}','${phase.id}','${room.id}','${task.id}','endDate',this.value)\">` : esc(task.endDate || '—'),\n                    '', tPct, isDone ? '#10b981' : (tPct>0 ? '#60a5fa' : 'var(--muted)')\n                  )}\n                  <div style=\"flex:1;min-width:${totalWidth}px\"></div>"
    c1,c2,c3 = js.count(old1), js.count(old2), js.count(old3)
    print(f"Matches: {c1},{c2},{c3} (all expect 1)")
    ok = all(c==1 for c in [c1,c2,c3])
    if ok:
        js = js.replace(old1, new1)
        js = js.replace(old2, new2)
        js = js.replace(old3, new3)
        with open('kytrac-app.js', 'w', encoding='utf-8') as f:
            f.write(js)
        print("Patched all 3 spots.")
    else:
        print("!! STOP -- one or more matches was not exactly 1. Tell Claude these numbers:", [c1,c2,c3])
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
git commit -m "Master Schedule: real Job-level and Task-level date editing (Owner-only)"
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
