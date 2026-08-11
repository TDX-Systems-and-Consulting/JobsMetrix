cd ~/Documents/JOBSpan

echo "=== STEP 1: Refining Simplify Schedule -- hide materials, keep labor visible (skips safely if already applied) ==="
if grep -q "isLaborItem(task)" kytrac-app.js 2>/dev/null; then
  echo "Already patched -- skipping."
else
  cat > /tmp/labor_js.diff << 'DIFFEOF1'
--- JobsMetrix-labor-orig/kytrac-app.js	2026-08-11 20:06:11.290606859 +0000
+++ JobsMetrix/kytrac-app.js	2026-08-11 20:05:54.998607231 +0000
@@ -4577,27 +4577,31 @@
 }
 window.clearAllJobDates = clearAllJobDates;
 
-// Bulk-excludes every task under every room in a job from the
-// schedule view, leaving only room-level rows -- the same unit the
-// printed Punch List already tracks (customerSafeLabel operates on
-// the room/subgroup, not individual tasks). Nothing is deleted:
-// excludeFromSchedule just hides a task from Gantt/Master Schedule
-// while it stays fully intact in the Estimate, fully reversible via
-// "Show excluded" -> Restore, same as removing one task by hand --
-// this just does it for every task in the job at once instead of
-// one at a time.
+// Bulk-excludes MATERIAL/PRODUCT tasks from the schedule (leaving
+// LABOR tasks visible and trackable) -- not a blanket "hide
+// everything under a room" like the first version of this. Travis's
+// exact framing: painter's tape doesn't change a room's completion
+// percent, so it shouldn't be a checkbox on the Gantt at all; the
+// labor line for painting the room does represent real progress and
+// stays. Reuses isLaborItem() unchanged -- the same rule financial
+// reporting already uses to split Materials vs Labor -- rather than
+// inventing a second, possibly-inconsistent definition of "labor"
+// just for scheduling. Nothing is deleted: excludeFromSchedule just
+// hides a task from Gantt/Master Schedule while it stays fully intact
+// in the Estimate, fully reversible via "Show excluded" -> Restore.
 async function simplifySchedule(jobId) {
   if (!jobId || !conDb) return;
   try {
     const tree = await loadEpicTree(jobId);
-    let taskCount = 0, roomCount = 0;
+    let materialCount = 0, laborCount = 0, roomCount = 0;
     const writes = [];
     tree.forEach(phase => {
       (phase.features || []).forEach(room => {
         roomCount++;
         (room.tasks || []).forEach(task => {
+          if (isLaborItem(task)) { laborCount++; return; } // real trackable work -- stays visible
           if (task.excludeFromSchedule) return; // already excluded, skip
-          taskCount++;
+          materialCount++;
           writes.push(
             coll('jobs').doc(jobId)
               .collection('estimateGroups').doc(phase.id)
@@ -4609,17 +4613,17 @@
       });
     });
 
-    if (!taskCount) {
-      alert(`Checked ${roomCount} room(s) -- every task is already excluded. Schedule is already simplified to room-level tracking.`);
+    if (!materialCount) {
+      alert(`Checked ${roomCount} room(s), ${laborCount} labor task(s) -- every material/product line is already hidden. Only labor stays on the schedule.`);
       return;
     }
 
-    if (!confirm(`Simplify this job's schedule?\n\nHides ${taskCount} individual material/labor task(s) across ${roomCount} room(s), leaving only room-level rows to track -- matching the printed Punch List. Nothing is deleted; every hidden task stays fully intact in the Estimate and can be brought back anytime with "Show excluded".`)) return;
+    if (!confirm(`Simplify this job's schedule?\n\nHides ${materialCount} material/product task(s) (tape, screws, fixtures, etc. -- things that don't represent progress) across ${roomCount} room(s). Keeps ${laborCount} labor task(s) visible and trackable, since those DO represent real work. Nothing is deleted; every hidden task stays fully intact in the Estimate and can be brought back anytime with "Show excluded".`)) return;
 
     await Promise.all(writes);
     if (_ganttJobId === jobId) renderGanttFromCache();
     refreshMasterIfActive();
-    alert(`Simplified -- hid ${taskCount} task(s) across ${roomCount} room(s). Room-level rows are now the trackable schedule.`);
+    alert(`Simplified -- hid ${materialCount} material/product task(s) across ${roomCount} room(s). ${laborCount} labor task(s) stayed visible and trackable.`);
   } catch(e) {
     alert('Could not simplify schedule: ' + e.message);
   }
@@ -9317,7 +9321,7 @@
 
     rowsHtml += `<div data-master-row="job" data-job-id="${job.id}" class="gantt-left-row phase-row" style="min-height:${ROW_H}px;background:rgba(245,158,11,.06)" onclick="toggleMasterRow('job','${job.id}')">
       ${sixCols(
-        `<span id="masterArrowJob_${job.id}" style="flex-shrink:0">${jobCollapsed?'▶':'▼'}</span><span class="gantt-task-name-text" style="color:var(--amber)" title="${esc(job.name)}">🏠 ${esc(job.name)}</span>${isOwner?`<button onclick="event.stopPropagation();clearMasterAllJobDates('${job.id}')" title="Clear ALL dates on this job -- job, every phase, room, and task" style="background:none;border:1px dashed rgba(248,113,113,.4);border-radius:4px;color:#f87171;cursor:pointer;font-size:.62rem;margin-left:8px;padding:0 5px;flex-shrink:0">🗑 Clear All</button><button onclick="event.stopPropagation();simplifySchedule('${job.id}')" title="Hides individual material/labor tasks, leaving only room-level rows to track -- matching the printed Punch List" style="background:none;border:1px dashed rgba(110,145,210,.4);border-radius:4px;color:var(--muted);cursor:pointer;font-size:.62rem;margin-left:4px;padding:0 5px;flex-shrink:0">📋 Simplify</button>`:''}`,
+        `<span id="masterArrowJob_${job.id}" style="flex-shrink:0">${jobCollapsed?'▶':'▼'}</span><span class="gantt-task-name-text" style="color:var(--amber)" title="${esc(job.name)}">🏠 ${esc(job.name)}</span>${isOwner?`<button onclick="event.stopPropagation();clearMasterAllJobDates('${job.id}')" title="Clear ALL dates on this job -- job, every phase, room, and task" style="background:none;border:1px dashed rgba(248,113,113,.4);border-radius:4px;color:#f87171;cursor:pointer;font-size:.62rem;margin-left:8px;padding:0 5px;flex-shrink:0">🗑 Clear All</button><button onclick="event.stopPropagation();simplifySchedule('${job.id}')" title="Hides material/product tasks (tape, screws, fixtures) that don't represent progress. Keeps labor tasks visible and trackable, since those DO drive completion percent." style="background:none;border:1px dashed rgba(110,145,210,.4);border-radius:4px;color:var(--muted);cursor:pointer;font-size:.62rem;margin-left:4px;padding:0 5px;flex-shrink:0">📋 Simplify</button>`:''}`,
         jobDays !== null ? jobDays + 'd' : null,
         isOwner ? `<input type="date" value="${job.startDate||''}" onchange="updateMasterJobDate('${job.id}','startDate',this.value)">` : esc(job.startDate || '—'),
         isOwner ? `<input type="date" value="${job.endDate||''}" onchange="updateMasterJobDate('${job.id}','endDate',this.value)">` : esc(job.endDate || '—'),

DIFFEOF1
  cat > /tmp/labor_html.diff << 'DIFFEOF2'
--- JobsMetrix-labor-orig/index.html	2026-08-11 20:06:11.266686522 +0000
+++ JobsMetrix/index.html	2026-08-11 20:05:45.673219783 +0000
@@ -4523,7 +4523,7 @@
             <button class="btn" onclick="toggleGanttShowExcluded()" id="ganttShowExcludedBtn" title="Materials/labor lines removed from the schedule stay in the Estimate — this shows them here again, dimmed, with a Restore button" style="font-size:.75rem;padding:4px 10px">👁 Show excluded</button>
             <button class="btn" onclick="toggleGanttFullscreen()" id="ganttFullscreenBtn" style="font-size:.75rem;padding:4px 10px">⛶ Full Screen</button>
             <button class="btn" onclick="clearAllJobDates()" title="Clears startDate/endDate on the job, every phase, every room, and every task. Durations and dependencies are left alone." style="font-size:.75rem;padding:4px 10px;color:#f87171;border-color:rgba(248,113,113,.35)">🗑 Clear All Dates</button>
-            <button class="btn" onclick="simplifySchedule(_ganttJobId)" title="Hides individual material/labor tasks, leaving only room-level rows to track -- matching the printed Punch List. Reversible via Show Excluded." style="font-size:.75rem;padding:4px 10px">📋 Simplify Schedule</button>
+            <button class="btn" onclick="simplifySchedule(_ganttJobId)" title="Hides material/product tasks (tape, screws, fixtures) that don't represent progress. Keeps labor tasks visible and trackable, since those DO drive completion percent. Reversible via Show Excluded." style="font-size:.75rem;padding:4px 10px">📋 Simplify Schedule</button>
             <button class="btn-amber" onclick="openAddPhaseModal()" style="padding:7px 16px;font-size:.82rem">+ Add Phase</button>
           </div>
         </div>
@@ -4800,7 +4800,7 @@
 
 <div class="photo-queue-badge" style="display:none;position:fixed;bottom:18px;right:18px;z-index:9999;background:#d97706;color:#fff;border-radius:999px;padding:8px 16px;font-size:.8rem;font-weight:700;box-shadow:var(--shadow);align-items:center;gap:6px"></div>
 
-<script src="kytrac-app.js?v=202608111956"></script>
+<script src="kytrac-app.js?v=202608111954"></script>
 <script>
   // Register PWA service worker for installability + offline app-shell
   // loading. Registered after the main app script so a slow/failed SW

DIFFEOF2
  echo "--- Dry run check (JS) ---"
  if patch -p1 --dry-run < /tmp/labor_js.diff; then
    echo "--- Dry run OK, applying JS ---"
    patch -p1 < /tmp/labor_js.diff
  else
    echo "!! STOP -- JS patch dry run failed. Tell Claude this exact output above."
    exit 1
  fi
  echo "--- Dry run check (HTML) ---"
  if patch -p1 --dry-run < /tmp/labor_html.diff; then
    echo "--- Dry run OK, applying HTML ---"
    patch -p1 < /tmp/labor_html.diff
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
git commit -m "Simplify Schedule: hide materials/products only, keep labor tasks visible since those actually drive completion percent"
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
