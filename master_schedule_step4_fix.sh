cd ~/Documents/JOBSpan

echo "=== STEP 1: Wiring Room and Task duration editing into Master Schedule (skips safely if already applied) ==="
python3 - <<'PYEOF2'
with open('kytrac-app.js', 'r', encoding='utf-8') as f:
    js = f.read()

marker = "updateMasterRoomDuration"
already = js.count(marker)
print(f"Marker currently appears {already} time(s) before this step.")

if already >= 2:
    print("Already patched -- skipping.")
else:
    old1 = "window.updateMasterTaskDate = updateMasterTaskDate;"
    new1 = "window.updateMasterTaskDate = updateMasterTaskDate;\n\n// Duration and explicit dates are mutually exclusive, same rule as\n// the per-job Schedule tab: setting a duration switches the row back\n// to computed scheduling and clears any manual Start/Finish override\n// -- keeping both active at once would let the Days column lie about\n// what's actually driving the row.\nasync function updateMasterRoomDuration(jobId, phaseId, roomId, days) {\n  if (!jobId || !conDb) return;\n  const d = Math.max(1, Math.round(Number(days) || 1));\n  try {\n    await coll('jobs').doc(jobId)\n      .collection('estimateGroups').doc(phaseId)\n      .collection('subgroups').doc(roomId)\n      .update({\n        durationDays: d,\n        startDate: firebase.firestore.FieldValue.delete(),\n        endDate: firebase.firestore.FieldValue.delete(),\n        updatedAt: firebase.firestore.FieldValue.serverTimestamp()\n      });\n    renderMasterSchedulePage();\n  } catch(e) {\n    alert('Could not save duration: ' + e.message);\n  }\n}\nwindow.updateMasterRoomDuration = updateMasterRoomDuration;\n\nasync function updateMasterTaskDuration(jobId, phaseId, roomId, taskId, days) {\n  if (!jobId || !conDb) return;\n  const d = Math.max(1, Math.round(Number(days) || 1));\n  try {\n    await coll('jobs').doc(jobId)\n      .collection('estimateGroups').doc(phaseId)\n      .collection('subgroups').doc(roomId)\n      .collection('items').doc(taskId)\n      .update({\n        durationDays: d,\n        startDate: firebase.firestore.FieldValue.delete(),\n        endDate: firebase.firestore.FieldValue.delete(),\n        updatedAt: firebase.firestore.FieldValue.serverTimestamp()\n      });\n    renderMasterSchedulePage();\n  } catch(e) {\n    alert('Could not save duration: ' + e.message);\n  }\n}\nwindow.updateMasterTaskDuration = updateMasterTaskDuration;"
    old2 = "  function sixCols(nameHtml, days, startHtml, finishHtml, deps, pct, pctColorVal) {\n    return `<div class=\"gantt-name-cell\">${nameHtml}</div>\n      <div class=\"gantt-days-cell\">${days ?? '—'}</div>\n      <div class=\"gantt-date-cell gantt-start-cell\" onclick=\"event.stopPropagation()\">${startHtml}</div>\n      <div class=\"gantt-date-cell gantt-end-cell\" onclick=\"event.stopPropagation()\">${finishHtml}</div>\n      <div class=\"gantt-deps-cell\">${deps || ''}</div>\n      <div class=\"gantt-pct-cell\" style=\"color:${pctColorVal || 'var(--muted)'};font-weight:700\">${pct}%</div>`;"
    new2 = "  function sixCols(nameHtml, daysHtml, startHtml, finishHtml, deps, pct, pctColorVal) {\n    return `<div class=\"gantt-name-cell\">${nameHtml}</div>\n      <div class=\"gantt-days-cell\" onclick=\"event.stopPropagation()\">${daysHtml ?? '—'}</div>\n      <div class=\"gantt-date-cell gantt-start-cell\" onclick=\"event.stopPropagation()\">${startHtml}</div>\n      <div class=\"gantt-date-cell gantt-end-cell\" onclick=\"event.stopPropagation()\">${finishHtml}</div>\n      <div class=\"gantt-deps-cell\">${deps || ''}</div>\n      <div class=\"gantt-pct-cell\" style=\"color:${pctColorVal || 'var(--muted)'};font-weight:700\">${pct}%</div>`;"
    old3 = "                roomDays !== null ? roomDays + 'd' : null,"
    new3 = "                isOwner ? `<input type=\"number\" min=\"1\" value=\"${room.durationDays || (roomDays!==null?roomDays:'')}\" placeholder=\"—\" onchange=\"updateMasterRoomDuration('${job.id}','${phase.id}','${room.id}',this.value)\" title=\"Set duration directly -- clears any manual Start/Finish override and drives the schedule from here\">` : (roomDays !== null ? roomDays + 'd' : '—'),"
    old4 = "                    task.durationDays || null,"
    new4 = "                    taskCanEdit ? `<input type=\"number\" min=\"1\" value=\"${task.durationDays || ''}\" placeholder=\"—\" onchange=\"updateMasterTaskDuration('${job.id}','${phase.id}','${room.id}','${task.id}',this.value)\">` : (task.durationDays ? task.durationDays + 'd' : '—'),"
    c1,c2,c3,c4 = js.count(old1), js.count(old2), js.count(old3), js.count(old4)
    print(f"Matches: {c1},{c2},{c3},{c4} (all expect 1)")
    ok = all(c==1 for c in [c1,c2,c3,c4])
    if ok:
        js = js.replace(old1, new1)
        js = js.replace(old2, new2)
        js = js.replace(old3, new3)
        js = js.replace(old4, new4)
        with open('kytrac-app.js', 'w', encoding='utf-8') as f:
            f.write(js)
        print("Patched all 4 spots.")
    else:
        print("!! STOP -- one or more matches was not exactly 1. Tell Claude these numbers:", [c1,c2,c3,c4])
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
git commit -m "Master Schedule: real Room and Task duration editing (Owner-only), clears date override same as per-job tab"
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
