cd ~/Documents/JOBSpan

echo "=== STEP 1: Adding phase drag-to-reorder to Master Schedule (skips safely if already applied) ==="
python3 - <<'PYEOF2'
with open('kytrac-app.js', 'r', encoding='utf-8') as f:
    js = f.read()

marker = "masterPhaseDrop"
already = js.count(marker)
print(f"Marker currently appears {already} time(s) before this step.")

if already >= 2:
    print("Already patched -- skipping.")
else:
    old1 = "window.clearMasterAllJobDates = clearMasterAllJobDates;"
    new1 = "window.clearMasterAllJobDates = clearMasterAllJobDates;\n\n// Phase drag-reorder for Master Schedule -- same visual behavior as\n// the per-job Schedule tab's ganttPhaseDragStart/Over/Leave/End, but\n// the drop handler is different by necessity: phases only make sense\n// reordered WITHIN their own job, so this checks the dragged and\n// target phases share a job before doing anything, silently ignoring\n// a drop across two different jobs' phase lists rather than doing\n// something nonsensical with it.\nlet _masterDraggedPhaseId = null;\nlet _masterDraggedJobId = null;\n\nfunction masterPhaseDragStart(e, jobId, phaseId) {\n  _masterDraggedPhaseId = phaseId;\n  _masterDraggedJobId = jobId;\n  e.dataTransfer.effectAllowed = 'move';\n  e.dataTransfer.setData('text/plain', phaseId);\n  e.currentTarget.classList.add('dragging');\n}\nwindow.masterPhaseDragStart = masterPhaseDragStart;\n\nfunction masterPhaseDragOver(e) {\n  e.preventDefault();\n  e.dataTransfer.dropEffect = 'move';\n  e.currentTarget.classList.add('drag-over');\n}\nwindow.masterPhaseDragOver = masterPhaseDragOver;\n\nfunction masterPhaseDragLeave(e) {\n  e.currentTarget.classList.remove('drag-over');\n}\nwindow.masterPhaseDragLeave = masterPhaseDragLeave;\n\nfunction masterPhaseDragEnd(e) {\n  e.currentTarget.classList.remove('dragging');\n  document.querySelectorAll('.gantt-left-row.phase-row.drag-over').forEach(el => el.classList.remove('drag-over'));\n}\nwindow.masterPhaseDragEnd = masterPhaseDragEnd;\n\nasync function masterPhaseDrop(e, targetJobId, targetPhaseId) {\n  e.preventDefault();\n  e.currentTarget.classList.remove('drag-over');\n  const draggedId = _masterDraggedPhaseId;\n  const draggedJobId = _masterDraggedJobId;\n  _masterDraggedPhaseId = null;\n  _masterDraggedJobId = null;\n  if (!draggedId || draggedId === targetPhaseId || !conDb) return;\n  if (draggedJobId !== targetJobId) return; // different jobs -- not a valid reorder, ignore silently\n\n  try {\n    const tree = await loadEpicTree(targetJobId);\n    const fromIdx = tree.findIndex(p => p.id === draggedId);\n    const toIdx = tree.findIndex(p => p.id === targetPhaseId);\n    if (fromIdx === -1 || toIdx === -1) return;\n\n    const [moved] = tree.splice(fromIdx, 1);\n    tree.splice(toIdx, 0, moved);\n\n    const writes = tree.map((phase, i) =>\n      coll('jobs').doc(targetJobId).collection('estimateGroups').doc(phase.id)\n        .update({ order: i, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })\n    );\n    await Promise.all(writes);\n    renderMasterSchedulePage();\n  } catch(e2) {\n    alert('Could not save the new phase order: ' + e2.message);\n  }\n}\nwindow.masterPhaseDrop = masterPhaseDrop;"
    old2 = "        rowsHtml += `<div data-master-row=\"phase\" data-phase-id=\"${phase.id}\" data-parent-job=\"${job.id}\" class=\"gantt-left-row phase-row\" style=\"min-height:${PHASE_H}px\" onclick=\"toggleMasterRow('phase','${phase.id}')\">\n          ${sixCols(\n            `${roomCount?`<span id=\"masterArrowPhase_${phase.id}\" style=\"flex-shrink:0\">${phaseCollapsed?'▶':'▼'}</span>`:'<span style=\"width:10px;flex-shrink:0\"></span>'}<span style=\"padding-left:14px;color:#93c5fd\">${esc(phase.name)}</span>`,"
    new2 = "        rowsHtml += `<div data-master-row=\"phase\" data-phase-id=\"${phase.id}\" data-parent-job=\"${job.id}\" class=\"gantt-left-row phase-row\" draggable=\"${isOwner}\" ondragstart=\"masterPhaseDragStart(event,'${job.id}','${phase.id}')\" ondragover=\"masterPhaseDragOver(event)\" ondragleave=\"masterPhaseDragLeave(event)\" ondrop=\"masterPhaseDrop(event,'${job.id}','${phase.id}')\" ondragend=\"masterPhaseDragEnd(event)\" style=\"min-height:${PHASE_H}px\" onclick=\"toggleMasterRow('phase','${phase.id}')\">\n          ${sixCols(\n            `${isOwner?`<span class=\"gantt-drag-handle\" title=\"Drag to reorder phases within this job\" onclick=\"event.stopPropagation()\">⠿</span>`:''}${roomCount?`<span id=\"masterArrowPhase_${phase.id}\" style=\"flex-shrink:0\">${phaseCollapsed?'▶':'▼'}</span>`:'<span style=\"width:10px;flex-shrink:0\"></span>'}<span style=\"padding-left:14px;color:#93c5fd\">${esc(phase.name)}</span>`,"
    c1,c2 = js.count(old1), js.count(old2)
    print(f"Matches: {c1},{c2} (both expect 1)")
    ok = all(c==1 for c in [c1,c2])
    if ok:
        js = js.replace(old1, new1)
        js = js.replace(old2, new2)
        with open('kytrac-app.js', 'w', encoding='utf-8') as f:
            f.write(js)
        print("Patched both spots.")
    else:
        print("!! STOP -- one or more matches was not exactly 1. Tell Claude these numbers:", [c1,c2])
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
git commit -m "Master Schedule: phase drag-to-reorder, constrained to same-job drops"
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
