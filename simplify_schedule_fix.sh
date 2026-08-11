cd ~/Documents/JOBSpan

echo "=== STEP 1: Applying Simplify Schedule + Punch-List-matching room labels + mobile fin-bar fix (skips safely if already applied) ==="
if grep -q "simplifySchedule" kytrac-app.js 2>/dev/null; then
  echo "Already patched -- skipping."
else
  cat > /tmp/simplify_js.diff << 'DIFFEOF1'
--- JobsMetrix-simplify-orig/kytrac-app.js	2026-08-11 19:30:24.049726866 +0000
+++ JobsMetrix/kytrac-app.js	2026-08-11 19:30:11.145726099 +0000
@@ -3525,7 +3525,7 @@
           <div class="gantt-name-cell" style="padding-left:24px;color:#e2e8f0">
             <span class="gantt-collapse-btn">${roomCollapsed ? '▶' : '▼'}</span>
             <span style="color:var(--muted);font-size:.68rem;margin-right:4px" title="Room #${room._ganttNum} — reference this number when setting dependencies elsewhere">#${room._ganttNum}</span>
-            <span class="gantt-task-name-text">${esc(room.name)}</span>
+            <span class="gantt-task-name-text" title="${esc(room.name)}">${esc(customerSafeLabel({name: room.name, items: room.tasks}))}</span>
             ${isOwner ? `<button onclick="event.stopPropagation();addGanttTask('${phase.id}','${room.id}')" title="Add a task to this room" style="background:none;border:1px dashed rgba(110,145,210,.3);border-radius:4px;color:var(--muted);cursor:pointer;font-size:.68rem;margin-left:6px;padding:0 5px;flex-shrink:0">+ task</button>` : ''}
             ${statusWarning ? `<span title="${esc(statusWarning)}" style="margin-left:6px;font-size:.72rem;color:#f59e0b;cursor:help">⚠</span>` : ''}
           </div>
@@ -4577,6 +4577,55 @@
 }
 window.clearAllJobDates = clearAllJobDates;
 
+// Bulk-excludes every task under every room in a job from the
+// schedule view, leaving only room-level rows -- the same unit the
+// printed Punch List already tracks (customerSafeLabel operates on
+// the room/subgroup, not individual tasks). Nothing is deleted:
+// excludeFromSchedule just hides a task from Gantt/Master Schedule
+// while it stays fully intact in the Estimate, fully reversible via
+// "Show excluded" -> Restore, same as removing one task by hand --
+// this just does it for every task in the job at once instead of
+// one at a time.
+async function simplifySchedule(jobId) {
+  if (!jobId || !conDb) return;
+  try {
+    const tree = await loadEpicTree(jobId);
+    let taskCount = 0, roomCount = 0;
+    const writes = [];
+    tree.forEach(phase => {
+      (phase.features || []).forEach(room => {
+        roomCount++;
+        (room.tasks || []).forEach(task => {
+          if (task.excludeFromSchedule) return; // already excluded, skip
+          taskCount++;
+          writes.push(
+            coll('jobs').doc(jobId)
+              .collection('estimateGroups').doc(phase.id)
+              .collection('subgroups').doc(room.id)
+              .collection('items').doc(task.id)
+              .update({ excludeFromSchedule: true, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
+          );
+        });
+      });
+    });
+
+    if (!taskCount) {
+      alert(`Checked ${roomCount} room(s) -- every task is already excluded. Schedule is already simplified to room-level tracking.`);
+      return;
+    }
+
+    if (!confirm(`Simplify this job's schedule?\n\nHides ${taskCount} individual material/labor task(s) across ${roomCount} room(s), leaving only room-level rows to track -- matching the printed Punch List. Nothing is deleted; every hidden task stays fully intact in the Estimate and can be brought back anytime with "Show excluded".`)) return;
+
+    await Promise.all(writes);
+    if (_ganttJobId === jobId) renderGanttFromCache();
+    refreshMasterIfActive();
+    alert(`Simplified -- hid ${taskCount} task(s) across ${roomCount} room(s). Room-level rows are now the trackable schedule.`);
+  } catch(e) {
+    alert('Could not simplify schedule: ' + e.message);
+  }
+}
+window.simplifySchedule = simplifySchedule;
+
 // Same pattern as updateRoomDate/clearRoomDateOverride above, one
 // level down. getTaskDates() already checks task.startDate/endDate
 // FIRST, ahead of dependency- and duration-based scheduling — that
@@ -9267,7 +9316,7 @@
 
     rowsHtml += `<div data-master-row="job" data-job-id="${job.id}" class="gantt-left-row phase-row" style="min-height:${ROW_H}px;background:rgba(245,158,11,.06)" onclick="toggleMasterRow('job','${job.id}')">
       ${sixCols(
-        `<span id="masterArrowJob_${job.id}" style="flex-shrink:0">${jobCollapsed?'▶':'▼'}</span><span class="gantt-task-name-text" style="color:var(--amber)" title="${esc(job.name)}">🏠 ${esc(job.name)}</span>${isOwner?`<button onclick="event.stopPropagation();clearMasterAllJobDates('${job.id}')" title="Clear ALL dates on this job -- job, every phase, room, and task" style="background:none;border:1px dashed rgba(248,113,113,.4);border-radius:4px;color:#f87171;cursor:pointer;font-size:.62rem;margin-left:8px;padding:0 5px;flex-shrink:0">🗑 Clear All</button>`:''}`,
+        `<span id="masterArrowJob_${job.id}" style="flex-shrink:0">${jobCollapsed?'▶':'▼'}</span><span class="gantt-task-name-text" style="color:var(--amber)" title="${esc(job.name)}">🏠 ${esc(job.name)}</span>${isOwner?`<button onclick="event.stopPropagation();clearMasterAllJobDates('${job.id}')" title="Clear ALL dates on this job -- job, every phase, room, and task" style="background:none;border:1px dashed rgba(248,113,113,.4);border-radius:4px;color:#f87171;cursor:pointer;font-size:.62rem;margin-left:8px;padding:0 5px;flex-shrink:0">🗑 Clear All</button><button onclick="event.stopPropagation();simplifySchedule('${job.id}')" title="Hides individual material/labor tasks, leaving only room-level rows to track -- matching the printed Punch List" style="background:none;border:1px dashed rgba(110,145,210,.4);border-radius:4px;color:var(--muted);cursor:pointer;font-size:.62rem;margin-left:4px;padding:0 5px;flex-shrink:0">📋 Simplify</button>`:''}`,
         jobDays !== null ? jobDays + 'd' : null,
         isOwner ? `<input type="date" value="${job.startDate||''}" onchange="updateMasterJobDate('${job.id}','startDate',this.value)">` : esc(job.startDate || '—'),
         isOwner ? `<input type="date" value="${job.endDate||''}" onchange="updateMasterJobDate('${job.id}','endDate',this.value)">` : esc(job.endDate || '—'),
@@ -9335,7 +9384,7 @@
 
             rowsHtml += `<div data-master-row="room" data-room-id="${room.id}" data-parent-phase="${phase.id}" data-parent-job="${job.id}" class="gantt-left-row room-row" style="min-height:${PHASE_H}px;cursor:${displayTasks.length?'pointer':'default'}" ${displayTasks.length?`onclick="toggleMasterRow('room','${room.id}')"`:''}>
               ${sixCols(
-                `${displayTasks.length?`<span id="masterArrowRoom_${room.id}" style="flex-shrink:0">${roomCollapsed?'▶':'▼'}</span>`:'<span style="width:8px;flex-shrink:0"></span>'}<span class="gantt-task-name-text" style="padding-left:24px;color:#94a3b8" title="${esc(room.name)}">${esc(room.name)}</span><span style="color:var(--muted);font-size:.62rem;flex-shrink:0">(${doneTasks}/${displayTasks.length})</span>`,
+                `${displayTasks.length?`<span id="masterArrowRoom_${room.id}" style="flex-shrink:0">${roomCollapsed?'▶':'▼'}</span>`:'<span style="width:8px;flex-shrink:0"></span>'}<span class="gantt-task-name-text" style="padding-left:24px;color:#94a3b8" title="${esc(room.name)}">${esc(customerSafeLabel({name: room.name, items: room.tasks}))}</span><span style="color:var(--muted);font-size:.62rem;flex-shrink:0">(${doneTasks}/${displayTasks.length})</span>`,
                 isOwner ? `<input type="number" min="1" value="${room.durationDays || (roomDays!==null?roomDays:'')}" placeholder="—" onchange="updateMasterRoomDuration('${job.id}','${phase.id}','${room.id}',this.value)" title="Set duration directly -- clears any manual Start/Finish override and drives the schedule from here">` : (roomDays !== null ? roomDays + 'd' : '—'),
                 isOwner ? `<input type="date" value="${room.startDate||''}" onchange="updateMasterRoomDate('${job.id}','${phase.id}','${room.id}','startDate',this.value)" title="${room.startDate?'Custom date':'Auto-scheduled from phase -- set a date here to override'}">` : esc(roomStartD || '—'),
                 isOwner ? `<input type="date" value="${room.endDate||''}" onchange="updateMasterRoomDate('${job.id}','${phase.id}','${room.id}','endDate',this.value)" title="${room.endDate?'Custom date':'Auto-scheduled from phase -- set a date here to override'}">${(room.startDate||room.endDate)?`<button onclick="event.stopPropagation();clearMasterRoomDate('${job.id}','${phase.id}','${room.id}')" title="Clear override, go back to duration/dependency-based or auto-scheduling" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:.7rem;flex-shrink:0;padding:0">✕</button>`:''}` : esc(roomEndD || '—'),

DIFFEOF1
  cat > /tmp/simplify_html.diff << 'DIFFEOF2'
--- JobsMetrix-simplify-orig/index.html	2026-08-11 19:30:24.039952292 +0000
+++ JobsMetrix/index.html	2026-08-11 19:29:17.757722925 +0000
@@ -708,6 +708,20 @@
       .fin-bar-cell { padding: 8px 6px; }
       .fin-bar-label { font-size: .6rem; }
       .fin-bar-val { font-size: .88rem; overflow-wrap: break-word; }
+      /* Job detail modal on mobile: the fixed header (job info + fin
+         bar + tab row) doesn't scroll away -- it was eating most of
+         the viewport because the fin bar wrapped to 3 rows and the
+         19-button tab row wrapped to several more. Converting both to
+         single-row horizontal-scroll strips reclaims that height for
+         the actual scrollable tab content below, without hiding or
+         removing anything -- every stat and every tab is still there,
+         just swipeable instead of stacked. */
+      #jobFinBar { grid-template-columns: none !important; display: flex !important; overflow-x: auto !important; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
+      #jobFinBar::-webkit-scrollbar { display: none; }
+      #jobFinBar .fin-bar-cell { flex: 0 0 auto !important; min-width: 112px; white-space: nowrap; }
+      #jobDetailTabRow .con-subtabs { flex-wrap: nowrap !important; overflow-x: auto !important; -webkit-overflow-scrolling: touch; scrollbar-width: none; padding-bottom: 2px; }
+      #jobDetailTabRow .con-subtabs::-webkit-scrollbar { display: none; }
+      #jobDetailTabRow .con-subtab { flex: 0 0 auto !important; white-space: nowrap; }
       .est-summary-bar { grid-template-columns: repeat(2,minmax(0,1fr)) !important; }
       .est-kpi { overflow: hidden; padding: 5px 8px; }
       .est-kpi-val { font-size: .88rem; overflow-wrap: break-word; word-break: break-word; }
@@ -1689,7 +1703,7 @@
       </div>
     </div>
 
-    <!-- —— Edit Time Entry Modal (Owner / Full Access only) —— -->
+    <!-- ── Edit Time Entry Modal (Owner / Full Access only) ── -->
     <div id="editTimeEntryModal" class="modal-overlay">
       <div class="modal-box" style="max-width:440px">
         <div class="modal-head">
@@ -4509,6 +4523,7 @@
             <button class="btn" onclick="toggleGanttShowExcluded()" id="ganttShowExcludedBtn" title="Materials/labor lines removed from the schedule stay in the Estimate — this shows them here again, dimmed, with a Restore button" style="font-size:.75rem;padding:4px 10px">👁 Show excluded</button>
             <button class="btn" onclick="toggleGanttFullscreen()" id="ganttFullscreenBtn" style="font-size:.75rem;padding:4px 10px">⛶ Full Screen</button>
             <button class="btn" onclick="clearAllJobDates()" title="Clears startDate/endDate on the job, every phase, every room, and every task. Durations and dependencies are left alone." style="font-size:.75rem;padding:4px 10px;color:#f87171;border-color:rgba(248,113,113,.35)">🗑 Clear All Dates</button>
+            <button class="btn" onclick="simplifySchedule(_ganttJobId)" title="Hides individual material/labor tasks, leaving only room-level rows to track -- matching the printed Punch List. Reversible via Show Excluded." style="font-size:.75rem;padding:4px 10px">📋 Simplify Schedule</button>
             <button class="btn-amber" onclick="openAddPhaseModal()" style="padding:7px 16px;font-size:.82rem">+ Add Phase</button>
           </div>
         </div>
@@ -4785,7 +4800,7 @@
 
 <div class="photo-queue-badge" style="display:none;position:fixed;bottom:18px;right:18px;z-index:9999;background:#d97706;color:#fff;border-radius:999px;padding:8px 16px;font-size:.8rem;font-weight:700;box-shadow:var(--shadow);align-items:center;gap:6px"></div>
 
-<script src="kytrac-app.js?v=202608102129"></script>
+<script src="kytrac-app.js?v=202608101644"></script>
 <script>
   // Register PWA service worker for installability + offline app-shell
   // loading. Registered after the main app script so a slow/failed SW

DIFFEOF2
  echo "--- Dry run check (JS) ---"
  if patch -p1 --dry-run < /tmp/simplify_js.diff; then
    echo "--- Dry run OK, applying JS ---"
    patch -p1 < /tmp/simplify_js.diff
  else
    echo "!! STOP -- JS patch dry run failed. Tell Claude this exact output above."
    exit 1
  fi
  echo "--- Dry run check (HTML) ---"
  if patch -p1 --dry-run < /tmp/simplify_html.diff; then
    echo "--- Dry run OK, applying HTML ---"
    patch -p1 < /tmp/simplify_html.diff
  else
    echo "!! STOP -- HTML patch dry run failed. Tell Claude this exact output above."
    exit 1
  fi
fi

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
git commit -m "Simplify Schedule button (bulk-hide material/labor tasks) + room labels match printed Punch List wording + restore mobile fin-bar fix that never actually deployed"
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
