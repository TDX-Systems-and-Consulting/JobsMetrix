cd ~/Documents/JOBSpan

echo "=== STEP 1: Wiring dependency editing into Master Schedule (reuses the real modal) (skips safely if already applied) ==="
python3 - <<'PYEOF2'
with open('kytrac-app.js', 'r', encoding='utf-8') as f:
    js = f.read()

marker = "openMasterRoomScheduleModal"
already = js.count(marker)
print(f"Marker currently appears {already} time(s) before this step.")

if already >= 2:
    print("Already patched -- skipping.")
else:
    old1 = "window.updateMasterTaskDuration = updateMasterTaskDuration;"
    new1 = "window.updateMasterTaskDuration = updateMasterTaskDuration;\n\n// Reuses the EXISTING dependency modal (openRoomScheduleModal /\n// saveRoomSchedule) rather than building a parallel one -- that modal\n// reads/writes through the _ganttData/_ganttJobId globals the per-job\n// Schedule tab normally owns, so this temporarily populates those\n// with the ONE job being edited (fresh fetch + the same numbering\n// pass renderJobGantt itself runs), opens the real modal unchanged,\n// and saveRoomSchedule's own re-render call has been extended (see\n// below) to also refresh Master Schedule when it's the active page.\n// Genuinely the same dependency editor, not an approximation of it.\nasync function openMasterRoomScheduleModal(jobId, phaseId, roomId) {\n  try {\n    const tree = await loadEpicTree(jobId);\n    _ganttJobId = jobId;\n    _ganttData = tree.map(phase => ({\n      phase,\n      rooms: phase.features.map(room => ({ room, tasks: room.tasks || [] })),\n    }));\n    buildGanttNumbering();\n    openRoomScheduleModal(phaseId, roomId);\n  } catch(e) {\n    alert('Could not open dependency editor: ' + e.message);\n  }\n}\nwindow.openMasterRoomScheduleModal = openMasterRoomScheduleModal;"
    old2 = "    kClose('roomScheduleModal');\n    renderJobGantt(_ganttJobId);"
    new2 = "    kClose('roomScheduleModal');\n    renderJobGantt(_ganttJobId);\n    // Also refresh Master Schedule if that's where this modal was\n    // opened from -- #masterPageGantt exists in the DOM at all times\n    // (pages are hidden via the .active class, not removed), so this\n    // checks the page itself has .active rather than just existing.\n    const msPage = document.getElementById('ktPageMasterschedule');\n    if (msPage && msPage.classList.contains('active')) renderMasterSchedulePage();"
    old3 = "  function sixCols(nameHtml, daysHtml, startHtml, finishHtml, deps, pct, pctColorVal) {\n    return `<div class=\"gantt-name-cell\">${nameHtml}</div>\n      <div class=\"gantt-days-cell\" onclick=\"event.stopPropagation()\">${daysHtml ?? '—'}</div>\n      <div class=\"gantt-date-cell gantt-start-cell\" onclick=\"event.stopPropagation()\">${startHtml}</div>\n      <div class=\"gantt-date-cell gantt-end-cell\" onclick=\"event.stopPropagation()\">${finishHtml}</div>\n      <div class=\"gantt-deps-cell\">${deps || ''}</div>\n      <div class=\"gantt-pct-cell\" style=\"color:${pctColorVal || 'var(--muted)'};font-weight:700\">${pct}%</div>`;"
    new3 = "  function sixCols(nameHtml, daysHtml, startHtml, finishHtml, deps, pct, pctColorVal, depsOnClick, depsTitle) {\n    return `<div class=\"gantt-name-cell\">${nameHtml}</div>\n      <div class=\"gantt-days-cell\" onclick=\"event.stopPropagation()\">${daysHtml ?? '—'}</div>\n      <div class=\"gantt-date-cell gantt-start-cell\" onclick=\"event.stopPropagation()\">${startHtml}</div>\n      <div class=\"gantt-date-cell gantt-end-cell\" onclick=\"event.stopPropagation()\">${finishHtml}</div>\n      <div class=\"gantt-deps-cell\" onclick=\"event.stopPropagation();${depsOnClick||''}\" title=\"${depsTitle||''}\">${deps || ''}</div>\n      <div class=\"gantt-pct-cell\" style=\"color:${pctColorVal || 'var(--muted)'};font-weight:700\">${pct}%</div>`;"
    old4 = "                formatDependsOn(room.dependsOn), pct, pctColor(pct)"
    new4 = "                formatDependsOn(room.dependsOn), pct, pctColor(pct),\n                isOwner ? `openMasterRoomScheduleModal('${job.id}','${phase.id}','${room.id}')` : '',\n                isOwner ? 'Click to set dependencies' : ''"
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
git commit -m "Master Schedule: dependency editing on room rows, reuses the real per-job dependency modal"
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
