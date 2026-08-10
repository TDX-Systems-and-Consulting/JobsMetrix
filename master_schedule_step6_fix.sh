cd ~/Documents/JOBSpan

echo "=== STEP 1: Adding clear-dates buttons to Master Schedule (Job/Phase/Room/Task) (skips safely if already applied) ==="
python3 - <<'PYEOF2'
with open('kytrac-app.js', 'r', encoding='utf-8') as f:
    js = f.read()

marker = "clearMasterAllJobDates"
already = js.count(marker)
print(f"Marker currently appears {already} time(s) before this step.")

if already >= 2:
    print("Already patched -- skipping.")
else:
    old1 = "window.openMasterRoomScheduleModal = openMasterRoomScheduleModal;"
    new1 = "window.openMasterRoomScheduleModal = openMasterRoomScheduleModal;\n\n// Shared by every Master-Schedule action that reuses a per-job\n// function (dependency modal, clear-date buttons): those functions\n// only know how to refresh the per-job Schedule tab (renderJobGantt),\n// which safely no-ops on Master Schedule since #ganttLeftRows doesn't\n// exist there. This is the other half -- refresh Master Schedule too,\n// but only when it's actually the visible page (it stays in the DOM\n// at all times, just hidden via the .active class, so existence alone\n// isn't the right check).\nfunction refreshMasterIfActive() {\n  const msPage = document.getElementById('ktPageMasterschedule');\n  if (msPage && msPage.classList.contains('active')) renderMasterSchedulePage();\n}\nwindow.refreshMasterIfActive = refreshMasterIfActive;\n\n// Same borrow-the-per-job-globals pattern as openMasterRoomScheduleModal\n// above -- these four clear-date buttons call the REAL\n// clearRoomDateOverride/clearPhaseDateOverride/clearTaskDateOverride/\n// clearAllJobDates functions unchanged (all four already extended to\n// call refreshMasterIfActive themselves), just with _ganttData/\n// _ganttJobId pointed at the right job first.\nasync function withMasterJobContext(jobId, fn) {\n  const tree = await loadEpicTree(jobId);\n  _ganttJobId = jobId;\n  _ganttData = tree.map(phase => ({\n    phase,\n    rooms: phase.features.map(room => ({ room, tasks: room.tasks || [] })),\n  }));\n  buildGanttNumbering();\n  return fn();\n}\nwindow.withMasterJobContext = withMasterJobContext;\n\nfunction clearMasterPhaseDate(jobId, phaseId) {\n  withMasterJobContext(jobId, () => clearPhaseDateOverride(phaseId));\n}\nwindow.clearMasterPhaseDate = clearMasterPhaseDate;\n\nfunction clearMasterRoomDate(jobId, phaseId, roomId) {\n  withMasterJobContext(jobId, () => clearRoomDateOverride(phaseId, roomId));\n}\nwindow.clearMasterRoomDate = clearMasterRoomDate;\n\nfunction clearMasterTaskDate(jobId, phaseId, roomId, taskId) {\n  withMasterJobContext(jobId, () => clearTaskDateOverride(phaseId, roomId, taskId));\n}\nwindow.clearMasterTaskDate = clearMasterTaskDate;\n\nfunction clearMasterAllJobDates(jobId) {\n  withMasterJobContext(jobId, () => clearAllJobDates());\n}\nwindow.clearMasterAllJobDates = clearMasterAllJobDates;"
    old2 = "      .collection('subgroups').doc(roomId)\n      .update({ startDate: firebase.firestore.FieldValue.delete(), endDate: firebase.firestore.FieldValue.delete() });\n    renderJobGantt(_ganttJobId);\n  } catch(e) {\n    alert('Could not clear dates: ' + e.message);\n  }\n}\nwindow.clearRoomDateOverride = clearRoomDateOverride;"
    new2 = "      .collection('subgroups').doc(roomId)\n      .update({ startDate: firebase.firestore.FieldValue.delete(), endDate: firebase.firestore.FieldValue.delete() });\n    renderJobGantt(_ganttJobId);\n    refreshMasterIfActive();\n  } catch(e) {\n    alert('Could not clear dates: ' + e.message);\n  }\n}\nwindow.clearRoomDateOverride = clearRoomDateOverride;"
    old3 = "      .collection('estimateGroups').doc(phaseId)\n      .update({ startDate: firebase.firestore.FieldValue.delete(), endDate: firebase.firestore.FieldValue.delete() });\n    renderJobGantt(_ganttJobId);\n  } catch(e) {\n    alert('Could not clear dates: ' + e.message);\n  }\n}\nwindow.clearPhaseDateOverride = clearPhaseDateOverride;"
    new3 = "      .collection('estimateGroups').doc(phaseId)\n      .update({ startDate: firebase.firestore.FieldValue.delete(), endDate: firebase.firestore.FieldValue.delete() });\n    renderJobGantt(_ganttJobId);\n    refreshMasterIfActive();\n  } catch(e) {\n    alert('Could not clear dates: ' + e.message);\n  }\n}\nwindow.clearPhaseDateOverride = clearPhaseDateOverride;"
    old4 = "      .collection('items').doc(taskId)\n      .update({ startDate: firebase.firestore.FieldValue.delete(), endDate: firebase.firestore.FieldValue.delete() });\n    renderJobGantt(_ganttJobId);\n  } catch(e) {\n    alert('Could not clear dates: ' + e.message);\n  }\n}\nwindow.clearTaskDateOverride = clearTaskDateOverride;"
    new4 = "      .collection('items').doc(taskId)\n      .update({ startDate: firebase.firestore.FieldValue.delete(), endDate: firebase.firestore.FieldValue.delete() });\n    renderJobGantt(_ganttJobId);\n    refreshMasterIfActive();\n  } catch(e) {\n    alert('Could not clear dates: ' + e.message);\n  }\n}\nwindow.clearTaskDateOverride = clearTaskDateOverride;"
    old5 = "    await batch.commit();\n    renderJobGantt(_ganttJobId);\n    alert(`Cleared dates on the job, ${totalPhases} phase(s), ${totalRooms} room(s), and ${totalTasks} task(s).`);"
    new5 = "    await batch.commit();\n    renderJobGantt(_ganttJobId);\n    refreshMasterIfActive();\n    alert(`Cleared dates on the job, ${totalPhases} phase(s), ${totalRooms} room(s), and ${totalTasks} task(s).`);"
    old6 = "        `<span id=\"masterArrowJob_${job.id}\" style=\"flex-shrink:0\">${jobCollapsed?'▶':'▼'}</span><span style=\"color:var(--amber)\">🏠 ${esc(job.name)}</span>`,"
    new6 = "        `<span id=\"masterArrowJob_${job.id}\" style=\"flex-shrink:0\">${jobCollapsed?'▶':'▼'}</span><span style=\"color:var(--amber)\">🏠 ${esc(job.name)}</span>${isOwner?`<button onclick=\"event.stopPropagation();clearMasterAllJobDates('${job.id}')\" title=\"Clear ALL dates on this job -- job, every phase, room, and task\" style=\"background:none;border:1px dashed rgba(248,113,113,.4);border-radius:4px;color:#f87171;cursor:pointer;font-size:.62rem;margin-left:8px;padding:0 5px;flex-shrink:0\">🗑 Clear All</button>`:''}`,"
    old7 = "            isOwner ? `<input type=\"date\" value=\"${phase.endDate||''}\" onchange=\"updateMasterPhaseDate('${job.id}','${phase.id}','endDate',this.value)\">` : esc(phase.endDate || '—'),"
    new7 = "            isOwner ? `<input type=\"date\" value=\"${phase.endDate||''}\" onchange=\"updateMasterPhaseDate('${job.id}','${phase.id}','endDate',this.value)\">${(phase.startDate||phase.endDate)?`<button onclick=\"event.stopPropagation();clearMasterPhaseDate('${job.id}','${phase.id}')\" title=\"Clear this phase's dates\" style=\"background:none;border:none;color:var(--muted);cursor:pointer;font-size:.7rem;flex-shrink:0;padding:0\">✕</button>`:''}` : esc(phase.endDate || '—'),"
    old8 = "                isOwner ? `<input type=\"date\" value=\"${room.endDate||''}\" onchange=\"updateMasterRoomDate('${job.id}','${phase.id}','${room.id}','endDate',this.value)\" title=\"${room.endDate?'Custom date':'Auto-scheduled from phase -- set a date here to override'}\">` : esc(roomEndD || '—'),"
    new8 = "                isOwner ? `<input type=\"date\" value=\"${room.endDate||''}\" onchange=\"updateMasterRoomDate('${job.id}','${phase.id}','${room.id}','endDate',this.value)\" title=\"${room.endDate?'Custom date':'Auto-scheduled from phase -- set a date here to override'}\">${(room.startDate||room.endDate)?`<button onclick=\"event.stopPropagation();clearMasterRoomDate('${job.id}','${phase.id}','${room.id}')\" title=\"Clear override, go back to duration/dependency-based or auto-scheduling\" style=\"background:none;border:none;color:var(--muted);cursor:pointer;font-size:.7rem;flex-shrink:0;padding:0\">✕</button>`:''}` : esc(roomEndD || '—'),"
    old9 = "                    taskCanEdit ? `<input type=\"date\" value=\"${task.endDate||''}\" onchange=\"updateMasterTaskDate('${job.id}','${phase.id}','${room.id}','${task.id}','endDate',this.value)\">` : esc(task.endDate || '—'),"
    new9 = "                    taskCanEdit ? `<input type=\"date\" value=\"${task.endDate||''}\" onchange=\"updateMasterTaskDate('${job.id}','${phase.id}','${room.id}','${task.id}','endDate',this.value)\">${(task.startDate||task.endDate)?`<button onclick=\"event.stopPropagation();clearMasterTaskDate('${job.id}','${phase.id}','${room.id}','${task.id}')\" title=\"Clear this task's custom dates\" style=\"background:none;border:none;color:var(--muted);cursor:pointer;font-size:.7rem;flex-shrink:0;padding:0\">✕</button>`:''}` : esc(task.endDate || '—'),"
    c1,c2,c3,c4,c5,c6,c7,c8,c9 = js.count(old1), js.count(old2), js.count(old3), js.count(old4), js.count(old5), js.count(old6), js.count(old7), js.count(old8), js.count(old9)
    print(f"Matches: {c1},{c2},{c3},{c4},{c5},{c6},{c7},{c8},{c9} (all expect 1)")
    ok = all(c==1 for c in [c1,c2,c3,c4,c5,c6,c7,c8,c9])
    if ok:
        js = js.replace(old1, new1)
        js = js.replace(old2, new2)
        js = js.replace(old3, new3)
        js = js.replace(old4, new4)
        js = js.replace(old5, new5)
        js = js.replace(old6, new6)
        js = js.replace(old7, new7)
        js = js.replace(old8, new8)
        js = js.replace(old9, new9)
        with open('kytrac-app.js', 'w', encoding='utf-8') as f:
            f.write(js)
        print("Patched all 9 spots.")
    else:
        print("!! STOP -- one or more matches was not exactly 1. Tell Claude these numbers:", [c1,c2,c3,c4,c5,c6,c7,c8,c9])
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
git commit -m "Master Schedule: clear-dates buttons at every level (Job/Phase/Room/Task), reuses the real per-job clear functions"
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
