cd ~/Documents/JOBSpan

echo "=== STEP 1: Applying full task indent/outdent + tree rendering (skips safely if already applied) ==="
if grep -q "renderMasterTaskNode" kytrac-app.js 2>/dev/null; then
  echo "Already patched -- skipping."
else
  cat > /tmp/step8.diff << 'DIFFEOF'
--- JobsMetrix-step8-orig/kytrac-app.js	2026-08-10 21:15:22.357855818 +0000
+++ JobsMetrix/kytrac-app.js	2026-08-10 21:14:43.829856699 +0000
@@ -3407,6 +3407,7 @@
     const task = roomEntry.tasks.find(t => t.id === taskId);
     if (task) { task.parentTaskId = newParent.id; task.order = newOrder; }
     renderGanttFromCache();
+    refreshMasterIfActive();
   } catch (e) {
     alert('Could not indent: ' + e.message);
   }
@@ -3441,6 +3442,7 @@
     task.parentTaskId = newParentId;
     task.order = newOrder;
     renderGanttFromCache();
+    refreshMasterIfActive();
   } catch (e) {
     alert('Could not outdent: ' + e.message);
   }
@@ -4504,7 +4506,7 @@
 }
 window.clearPhaseDateOverride = clearPhaseDateOverride;
 
-// Whole-job reset -- clears startDate/endDate at every level (job,
+// Whole-job reset — clears startDate/endDate at every level (job,
 // every phase, every room, every task) in one batch. Needed because
 // clearing just the phase level leaves any room/task that has its own
 // explicit override (set independently via updateRoomDate/
@@ -4639,6 +4641,7 @@
       .collection('items').doc(taskId)
       .update({ excludeFromSchedule: true, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
     renderGanttFromCache();
+    refreshMasterIfActive();
   } catch(e) {
     alert('Could not remove from schedule: ' + e.message);
   }
@@ -4658,6 +4661,7 @@
       .collection('items').doc(taskId)
       .update({ excludeFromSchedule: false, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
     renderGanttFromCache();
+    refreshMasterIfActive();
   } catch(e) {
     alert('Could not restore: ' + e.message);
   }
@@ -4984,6 +4988,7 @@
     }
   }
   renderGanttFromCache();
+  refreshMasterIfActive();
 }
 window.updateTaskPct = updateTaskPct;
 
@@ -8952,6 +8957,51 @@
 }
 window.masterPhaseDrop = masterPhaseDrop;
 
+// Task-level wrappers -- same borrow-the-per-job-globals pattern used
+// throughout. Every one of these calls the REAL per-job function
+// unchanged (all five have been extended above to call
+// refreshMasterIfActive themselves).
+function indentMasterTask(jobId, phaseId, roomId, taskId) {
+  withMasterJobContext(jobId, () => indentGanttTask(phaseId, roomId, taskId));
+}
+window.indentMasterTask = indentMasterTask;
+
+function outdentMasterTask(jobId, phaseId, roomId, taskId) {
+  withMasterJobContext(jobId, () => outdentGanttTask(phaseId, roomId, taskId));
+}
+window.outdentMasterTask = outdentMasterTask;
+
+function removeMasterTaskFromSchedule(jobId, phaseId, roomId, taskId, taskName) {
+  withMasterJobContext(jobId, () => removeTaskFromSchedule(phaseId, roomId, taskId, taskName));
+}
+window.removeMasterTaskFromSchedule = removeMasterTaskFromSchedule;
+
+function restoreMasterTaskToSchedule(jobId, phaseId, roomId, taskId) {
+  withMasterJobContext(jobId, () => restoreTaskToSchedule(phaseId, roomId, taskId));
+}
+window.restoreMasterTaskToSchedule = restoreMasterTaskToSchedule;
+
+function updateMasterTaskPct(jobId, phaseId, roomId, taskId, pct) {
+  withMasterJobContext(jobId, () => updateTaskPct(phaseId, roomId, taskId, pct));
+}
+window.updateMasterTaskPct = updateMasterTaskPct;
+
+async function openMasterTaskScheduleModal(jobId, phaseId, roomId, taskId) {
+  try {
+    const tree = await loadEpicTree(jobId);
+    _ganttJobId = jobId;
+    _ganttData = tree.map(phase => ({
+      phase,
+      rooms: phase.features.map(room => ({ room, tasks: room.tasks || [] })),
+    }));
+    buildGanttNumbering();
+    openTaskScheduleModal(phaseId, roomId, taskId);
+  } catch(e) {
+    alert('Could not open dependency editor: ' + e.message);
+  }
+}
+window.openMasterTaskScheduleModal = openMasterTaskScheduleModal;
+
 function toggleMasterRow(type, id) {
   if (!window._masterCollapsed) window._masterCollapsed = {};
   const nowCollapsed = !window._masterCollapsed[id];
@@ -9091,15 +9141,98 @@
   // Schedule tab, not an approximation of it. Read-only for now
   // (plain text/spans, no <input> elements) -- editing comes in the
   // next pass, once this display layer is confirmed correct.
-  function sixCols(nameHtml, daysHtml, startHtml, finishHtml, deps, pct, pctColorVal, depsOnClick, depsTitle) {
+  function sixCols(nameHtml, daysHtml, startHtml, finishHtml, deps, pct, pctColorVal, depsOnClick, depsTitle, pctHtml) {
     return `<div class="gantt-name-cell">${nameHtml}</div>
       <div class="gantt-days-cell" onclick="event.stopPropagation()">${daysHtml ?? '—'}</div>
       <div class="gantt-date-cell gantt-start-cell" onclick="event.stopPropagation()">${startHtml}</div>
       <div class="gantt-date-cell gantt-end-cell" onclick="event.stopPropagation()">${finishHtml}</div>
       <div class="gantt-deps-cell" onclick="event.stopPropagation();${depsOnClick||''}" title="${depsTitle||''}">${deps || ''}</div>
-      <div class="gantt-pct-cell" style="color:${pctColorVal || 'var(--muted)'};font-weight:700">${pct}%</div>`;
+      <div class="gantt-pct-cell" onclick="event.stopPropagation()" style="color:${pctColorVal || 'var(--muted)'};font-weight:700">${pctHtml ?? (pct+'%')}</div>`;
+  }
+
+  // Recursive task-tree renderer -- mirrors renderTaskNodeRow's
+  // structure exactly (rollup %/dates for summary tasks, indent/
+  // outdent, dependency editing, remove/restore, %-done editing) but
+  // built on Master's own sixCols column layout and with jobId
+  // threaded through every handler, since renderTaskNodeRow's own
+  // handlers all assume the single implicit _ganttJobId. Nested here
+  // (not top-level) specifically so it closes over sixCols -- defined
+  // one line up, and only ever existing as a local inside this
+  // function. Previously Master Schedule's task rows were a flat list
+  // with no tree structure at all, which is why indent/outdent
+  // wouldn't have been visible even once wired up -- this is the
+  // companion change that makes the result of indenting/outdenting
+  // actually show.
+  function renderMasterTaskNode(node, depth, phase, room, job, isOwner, siblings, siblingIdx) {
+    const isReal = !node.fromScopeNotes;
+    const hasKids = node.children && node.children.length > 0;
+    const collapsed = window._masterCollapsed[node.id];
+    const indentPx = 36 + depth * 24;
+
+    let tPct, taskStart, taskEnd, taskCircular, taskDays;
+    if (hasKids) {
+      tPct = getTaskNodePct(node);
+      const d = getTaskNodeDates(node, room, phase);
+      taskStart = d.start; taskEnd = d.end; taskCircular = d.circular;
+      taskDays = workDaysBetween(taskStart, taskEnd);
+    } else {
+      tPct = isReal ? getTaskPct(node) : (node.taskStatus === 'done' ? 100 : 0);
+      const d = isReal ? getTaskDates(node, room, phase) : { start: null, end: null, circular: false };
+      taskStart = d.start; taskEnd = d.end; taskCircular = d.circular;
+      taskDays = isReal ? workDaysBetween(taskStart, taskEnd) : 1;
+    }
+    const isDone = tPct === 100;
+    const glyphColor = isDone ? '#10b981' : (tPct > 0 ? '#60a5fa' : 'var(--muted)');
+    const canIndent = isReal && isOwner && siblingIdx > 0;
+    const canOutdent = isReal && isOwner && depth > 0;
+
+    const nameHtml = `${hasKids ? `<span class="gantt-collapse-btn" onclick="event.stopPropagation();window._masterCollapsed['${node.id}']=!window._masterCollapsed['${node.id}'];renderMasterSchedulePage()" style="cursor:pointer">${collapsed?'▶':'▼'}</span>` : ''}<span style="padding-left:${indentPx}px;${isDone?'text-decoration:line-through;opacity:.5':''}">${esc(node.name)}</span>${isReal && isOwner ? `<span style="display:inline-flex;gap:2px;margin-left:6px;flex-shrink:0">${canOutdent?`<button onclick="event.stopPropagation();outdentMasterTask('${job.id}','${phase.id}','${room.id}','${node.id}')" title="Outdent" style="background:none;border:1px solid rgba(110,145,210,.25);border-radius:4px;color:var(--muted);cursor:pointer;font-size:.65rem;padding:0 4px">◀</button>`:''}${canIndent?`<button onclick="event.stopPropagation();indentMasterTask('${job.id}','${phase.id}','${room.id}','${node.id}')" title="Indent" style="background:none;border:1px solid rgba(110,145,210,.25);border-radius:4px;color:var(--muted);cursor:pointer;font-size:.65rem;padding:0 4px">▶</button>`:''}</span>${node.excludeFromSchedule?`<button onclick="event.stopPropagation();restoreMasterTaskToSchedule('${job.id}','${phase.id}','${room.id}','${node.id}')" title="Restore to schedule" style="background:none;border:1px solid rgba(110,145,210,.25);border-radius:6px;color:var(--amber);cursor:pointer;font-size:.65rem;margin-left:4px;padding:0 5px;flex-shrink:0">↺</button>`:`<button onclick="event.stopPropagation();removeMasterTaskFromSchedule('${job.id}','${phase.id}','${room.id}','${node.id}','${jsAttrEsc(node.name)}')" title="Remove from schedule" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:.72rem;margin-left:4px;padding:0;flex-shrink:0">✕</button>`}` : ''}`;
+
+    const daysHtml = taskCircular ? '⚠' : (hasKids
+      ? (taskDays !== null ? `${taskDays}d` : '—')
+      : (isReal && isOwner
+        ? `<input type="number" min="1" value="${node.durationDays || (taskDays!==null?taskDays:'')}" placeholder="—" onchange="updateMasterTaskDuration('${job.id}','${phase.id}','${room.id}','${node.id}',this.value)">`
+        : (taskDays !== null ? taskDays+'d' : '—')));
+
+    const startHtml = taskCircular ? `<span style="color:#f87171">⚠</span>` : (hasKids
+      ? esc(taskStart || '—')
+      : (isReal && isOwner
+        ? `<input type="date" value="${node.startDate||''}" onchange="updateMasterTaskDate('${job.id}','${phase.id}','${room.id}','${node.id}','startDate',this.value)">`
+        : esc(taskStart || '—')));
+
+    const finishHtml = taskCircular ? '' : (hasKids
+      ? esc(taskEnd || '—')
+      : (isReal && isOwner
+        ? `<input type="date" value="${node.endDate||''}" onchange="updateMasterTaskDate('${job.id}','${phase.id}','${room.id}','${node.id}','endDate',this.value)">${(node.startDate||node.endDate)?`<button onclick="event.stopPropagation();clearMasterTaskDate('${job.id}','${phase.id}','${room.id}','${node.id}')" title="Clear this task's custom dates" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:.7rem;flex-shrink:0;padding:0">✕</button>`:''}`
+        : esc(taskEnd || '—')));
+
+    const pctHtml = hasKids
+      ? `<span style="color:${glyphColor}">${tPct}%</span>`
+      : (isReal && isOwner
+        ? `<input type="number" min="0" max="100" step="5" value="${tPct}" onchange="updateMasterTaskPct('${job.id}','${phase.id}','${room.id}','${node.id}',this.value)" style="width:50px;background:rgba(110,145,210,.08);border:1px solid rgba(110,145,210,.25);border-radius:5px;color:${glyphColor};font-weight:700;font-size:.72rem;padding:3px 2px;text-align:center">`
+        : `<span style="color:${glyphColor}">${tPct}%</span>`);
+
+    let html = `<div data-master-row="task" data-task-idx="${node.id}" data-parent-room="${room.id}" data-parent-phase="${phase.id}" data-parent-job="${job.id}" class="gantt-left-row task-row" style="min-height:26px;${node.excludeFromSchedule?'opacity:.45':''}">
+      ${sixCols(
+        nameHtml, daysHtml, startHtml, finishHtml,
+        isReal ? formatDependsOn(node.dependsOn) : '',
+        tPct, glyphColor,
+        isReal && isOwner ? `openMasterTaskScheduleModal('${job.id}','${phase.id}','${room.id}','${node.id}')` : '',
+        isReal && isOwner ? 'Click to set dependencies' : '',
+        pctHtml
+      )}
+      <div style="flex:1"></div>
+    </div>`;
+
+    if (hasKids && !collapsed) {
+      node.children.forEach((child, i) => {
+        html += renderMasterTaskNode(child, depth + 1, phase, room, job, isOwner, node.children, i);
+      });
+    }
+    return html;
   }
 
+
   let rowsHtml = '';
 
   activeJobs.forEach(job => {
@@ -9214,22 +9347,9 @@
             </div>`;
 
             if (!roomCollapsed) {
-              displayTasks.forEach((task, ti) => {
-                const tPct = getTaskPct(task);
-                const isDone = tPct === 100;
-                const glyph = isDone ? '☑' : (tPct > 0 ? tPct + '%' : '☐');
-                const isRealTask = !String(task.id).startsWith('scope_');
-                const taskCanEdit = isOwner && isRealTask;
-                rowsHtml += `<div data-master-row="task" data-task-idx="${ti}" data-parent-room="${room.id}" data-parent-phase="${phase.id}" data-parent-job="${job.id}" class="gantt-left-row task-row" style="min-height:${TASK_H}px">
-                  ${sixCols(
-                    `<span style="padding-left:36px;font-weight:${isDone?'400':'700'};color:${isDone?'#10b981':tPct>0?'#60a5fa':'var(--muted)'}">${glyph}</span><span style="color:${isDone?'#10b981':'#64748b'};text-decoration:${isDone?'line-through':'none'}">${esc(task.name)}</span>`,
-                    taskCanEdit ? `<input type="number" min="1" value="${task.durationDays || ''}" placeholder="—" onchange="updateMasterTaskDuration('${job.id}','${phase.id}','${room.id}','${task.id}',this.value)">` : (task.durationDays ? task.durationDays + 'd' : '—'),
-                    taskCanEdit ? `<input type="date" value="${task.startDate||''}" onchange="updateMasterTaskDate('${job.id}','${phase.id}','${room.id}','${task.id}','startDate',this.value)">` : esc(task.startDate || '—'),
-                    taskCanEdit ? `<input type="date" value="${task.endDate||''}" onchange="updateMasterTaskDate('${job.id}','${phase.id}','${room.id}','${task.id}','endDate',this.value)">${(task.startDate||task.endDate)?`<button onclick="event.stopPropagation();clearMasterTaskDate('${job.id}','${phase.id}','${room.id}','${task.id}')" title="Clear this task's custom dates" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:.7rem;flex-shrink:0;padding:0">✕</button>`:''}` : esc(task.endDate || '—'),
-                    '', tPct, isDone ? '#10b981' : (tPct>0 ? '#60a5fa' : 'var(--muted)')
-                  )}
-                  <div style="flex:1;min-width:${totalWidth}px"></div>
-                </div>`;
+              const taskTree = buildTaskTree(displayTasks, true); // already filtered above; true = don't re-filter/prune here
+              taskTree.forEach((rootNode, i) => {
+                rowsHtml += renderMasterTaskNode(rootNode, 0, phase, room, job, isOwner, taskTree, i);
               });
             }
           });
@@ -13219,7 +13339,6 @@
 }
 window.repairTeamMemberAccess = repairTeamMemberAccess;
 
-
 // Stores the QuickBooks Employee ID mapping for a team member — needed
 // before the daily payroll clock-out sync can push anything for that
 // person. Doesn't sync anything itself, just records the mapping.

DIFFEOF
  echo "--- Dry run check ---"
  if patch -p1 --dry-run < /tmp/step8.diff; then
    echo "--- Dry run OK, applying for real ---"
    patch -p1 < /tmp/step8.diff
  else
    echo "!! STOP -- patch dry run failed. Tell Claude this exact output above."
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
git commit -m "Master Schedule: task indent/outdent with real tree rendering, dependency editing, remove/restore, and pct-done editing -- full parity with the per-job Schedule tab"
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
