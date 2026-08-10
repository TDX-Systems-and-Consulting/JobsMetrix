cd ~/Documents/JOBSpan

echo "=== STEP 1: Fixing name-column overflow hiding the delete/indent/outdent buttons (skips safely if already applied) ==="
if grep -q "gantt-task-name-text.*style=\"color:var(--amber)\"" kytrac-app.js 2>/dev/null; then
  echo "Already patched -- skipping."
else
  cat > /tmp/step9.diff << 'DIFFEOF'
--- JobsMetrix-step9-orig/kytrac-app.js	2026-08-10 21:28:52.786914688 +0000
+++ JobsMetrix/kytrac-app.js	2026-08-10 21:28:37.294914485 +0000
@@ -9186,7 +9186,7 @@
     const canIndent = isReal && isOwner && siblingIdx > 0;
     const canOutdent = isReal && isOwner && depth > 0;
 
-    const nameHtml = `${hasKids ? `<span class="gantt-collapse-btn" onclick="event.stopPropagation();window._masterCollapsed['${node.id}']=!window._masterCollapsed['${node.id}'];renderMasterSchedulePage()" style="cursor:pointer">${collapsed?'▶':'▼'}</span>` : ''}<span style="padding-left:${indentPx}px;${isDone?'text-decoration:line-through;opacity:.5':''}">${esc(node.name)}</span>${isReal && isOwner ? `<span style="display:inline-flex;gap:2px;margin-left:6px;flex-shrink:0">${canOutdent?`<button onclick="event.stopPropagation();outdentMasterTask('${job.id}','${phase.id}','${room.id}','${node.id}')" title="Outdent" style="background:none;border:1px solid rgba(110,145,210,.25);border-radius:4px;color:var(--muted);cursor:pointer;font-size:.65rem;padding:0 4px">◀</button>`:''}${canIndent?`<button onclick="event.stopPropagation();indentMasterTask('${job.id}','${phase.id}','${room.id}','${node.id}')" title="Indent" style="background:none;border:1px solid rgba(110,145,210,.25);border-radius:4px;color:var(--muted);cursor:pointer;font-size:.65rem;padding:0 4px">▶</button>`:''}</span>${node.excludeFromSchedule?`<button onclick="event.stopPropagation();restoreMasterTaskToSchedule('${job.id}','${phase.id}','${room.id}','${node.id}')" title="Restore to schedule" style="background:none;border:1px solid rgba(110,145,210,.25);border-radius:6px;color:var(--amber);cursor:pointer;font-size:.65rem;margin-left:4px;padding:0 5px;flex-shrink:0">↺</button>`:`<button onclick="event.stopPropagation();removeMasterTaskFromSchedule('${job.id}','${phase.id}','${room.id}','${node.id}','${jsAttrEsc(node.name)}')" title="Remove from schedule" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:.72rem;margin-left:4px;padding:0;flex-shrink:0">✕</button>`}` : ''}`;
+    const nameHtml = `${hasKids ? `<span class="gantt-collapse-btn" onclick="event.stopPropagation();window._masterCollapsed['${node.id}']=!window._masterCollapsed['${node.id}'];renderMasterSchedulePage()" style="cursor:pointer">${collapsed?'▶':'▼'}</span>` : ''}<span class="gantt-task-name-text" style="padding-left:${indentPx}px;${isDone?'text-decoration:line-through;opacity:.5':''}" title="${esc(node.name)}">${esc(node.name)}</span>${isReal && isOwner ? `<span style="display:inline-flex;gap:2px;margin-left:6px;flex-shrink:0">${canOutdent?`<button onclick="event.stopPropagation();outdentMasterTask('${job.id}','${phase.id}','${room.id}','${node.id}')" title="Outdent" style="background:none;border:1px solid rgba(110,145,210,.25);border-radius:4px;color:var(--muted);cursor:pointer;font-size:.65rem;padding:0 4px">◀</button>`:''}${canIndent?`<button onclick="event.stopPropagation();indentMasterTask('${job.id}','${phase.id}','${room.id}','${node.id}')" title="Indent" style="background:none;border:1px solid rgba(110,145,210,.25);border-radius:4px;color:var(--muted);cursor:pointer;font-size:.65rem;padding:0 4px">▶</button>`:''}</span>${node.excludeFromSchedule?`<button onclick="event.stopPropagation();restoreMasterTaskToSchedule('${job.id}','${phase.id}','${room.id}','${node.id}')" title="Restore to schedule" style="background:none;border:1px solid rgba(110,145,210,.25);border-radius:6px;color:var(--amber);cursor:pointer;font-size:.65rem;margin-left:4px;padding:0 5px;flex-shrink:0">↺</button>`:`<button onclick="event.stopPropagation();removeMasterTaskFromSchedule('${job.id}','${phase.id}','${room.id}','${node.id}','${jsAttrEsc(node.name)}')" title="Remove from schedule" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:.72rem;margin-left:4px;padding:0;flex-shrink:0">✕</button>`}` : ''}`;
 
     const daysHtml = taskCircular ? '⚠' : (hasKids
       ? (taskDays !== null ? `${taskDays}d` : '—')
@@ -9267,7 +9267,7 @@
 
     rowsHtml += `<div data-master-row="job" data-job-id="${job.id}" class="gantt-left-row phase-row" style="min-height:${ROW_H}px;background:rgba(245,158,11,.06)" onclick="toggleMasterRow('job','${job.id}')">
       ${sixCols(
-        `<span id="masterArrowJob_${job.id}" style="flex-shrink:0">${jobCollapsed?'▶':'▼'}</span><span style="color:var(--amber)">🏠 ${esc(job.name)}</span>${isOwner?`<button onclick="event.stopPropagation();clearMasterAllJobDates('${job.id}')" title="Clear ALL dates on this job -- job, every phase, room, and task" style="background:none;border:1px dashed rgba(248,113,113,.4);border-radius:4px;color:#f87171;cursor:pointer;font-size:.62rem;margin-left:8px;padding:0 5px;flex-shrink:0">🗑 Clear All</button>`:''}`,
+        `<span id="masterArrowJob_${job.id}" style="flex-shrink:0">${jobCollapsed?'▶':'▼'}</span><span class="gantt-task-name-text" style="color:var(--amber)" title="${esc(job.name)}">🏠 ${esc(job.name)}</span>${isOwner?`<button onclick="event.stopPropagation();clearMasterAllJobDates('${job.id}')" title="Clear ALL dates on this job -- job, every phase, room, and task" style="background:none;border:1px dashed rgba(248,113,113,.4);border-radius:4px;color:#f87171;cursor:pointer;font-size:.62rem;margin-left:8px;padding:0 5px;flex-shrink:0">🗑 Clear All</button>`:''}`,
         jobDays !== null ? jobDays + 'd' : null,
         isOwner ? `<input type="date" value="${job.startDate||''}" onchange="updateMasterJobDate('${job.id}','startDate',this.value)">` : esc(job.startDate || '—'),
         isOwner ? `<input type="date" value="${job.endDate||''}" onchange="updateMasterJobDate('${job.id}','endDate',this.value)">` : esc(job.endDate || '—'),
@@ -9305,7 +9305,7 @@
 
         rowsHtml += `<div data-master-row="phase" data-phase-id="${phase.id}" data-parent-job="${job.id}" class="gantt-left-row phase-row" draggable="${isOwner}" ondragstart="masterPhaseDragStart(event,'${job.id}','${phase.id}')" ondragover="masterPhaseDragOver(event)" ondragleave="masterPhaseDragLeave(event)" ondrop="masterPhaseDrop(event,'${job.id}','${phase.id}')" ondragend="masterPhaseDragEnd(event)" style="min-height:${PHASE_H}px" onclick="toggleMasterRow('phase','${phase.id}')">
           ${sixCols(
-            `${isOwner?`<span class="gantt-drag-handle" title="Drag to reorder phases within this job" onclick="event.stopPropagation()">⠿</span>`:''}${roomCount?`<span id="masterArrowPhase_${phase.id}" style="flex-shrink:0">${phaseCollapsed?'▶':'▼'}</span>`:'<span style="width:10px;flex-shrink:0"></span>'}<span style="padding-left:14px;color:#93c5fd">${esc(phase.name)}</span>`,
+            `${isOwner?`<span class="gantt-drag-handle" title="Drag to reorder phases within this job" onclick="event.stopPropagation()">⠿</span>`:''}${roomCount?`<span id="masterArrowPhase_${phase.id}" style="flex-shrink:0">${phaseCollapsed?'▶':'▼'}</span>`:'<span style="width:10px;flex-shrink:0"></span>'}<span class="gantt-task-name-text" style="padding-left:14px;color:#93c5fd" title="${esc(phase.name)}">${esc(phase.name)}</span>`,
             phaseDays !== null ? phaseDays + 'd' : null,
             isOwner ? `<input type="date" value="${phase.startDate||''}" onchange="updateMasterPhaseDate('${job.id}','${phase.id}','startDate',this.value)">` : esc(phase.startDate || '—'),
             isOwner ? `<input type="date" value="${phase.endDate||''}" onchange="updateMasterPhaseDate('${job.id}','${phase.id}','endDate',this.value)">${(phase.startDate||phase.endDate)?`<button onclick="event.stopPropagation();clearMasterPhaseDate('${job.id}','${phase.id}')" title="Clear this phase's dates" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:.7rem;flex-shrink:0;padding:0">✕</button>`:''}` : esc(phase.endDate || '—'),
@@ -9335,7 +9335,7 @@
 
             rowsHtml += `<div data-master-row="room" data-room-id="${room.id}" data-parent-phase="${phase.id}" data-parent-job="${job.id}" class="gantt-left-row room-row" style="min-height:${PHASE_H}px;cursor:${displayTasks.length?'pointer':'default'}" ${displayTasks.length?`onclick="toggleMasterRow('room','${room.id}')"`:''}>
               ${sixCols(
-                `${displayTasks.length?`<span id="masterArrowRoom_${room.id}" style="flex-shrink:0">${roomCollapsed?'▶':'▼'}</span>`:'<span style="width:8px;flex-shrink:0"></span>'}<span style="padding-left:24px;color:#94a3b8">${esc(room.name)} <span style="color:var(--muted);font-size:.62rem">(${doneTasks}/${displayTasks.length})</span></span>`,
+                `${displayTasks.length?`<span id="masterArrowRoom_${room.id}" style="flex-shrink:0">${roomCollapsed?'▶':'▼'}</span>`:'<span style="width:8px;flex-shrink:0"></span>'}<span class="gantt-task-name-text" style="padding-left:24px;color:#94a3b8" title="${esc(room.name)}">${esc(room.name)}</span><span style="color:var(--muted);font-size:.62rem;flex-shrink:0">(${doneTasks}/${displayTasks.length})</span>`,
                 isOwner ? `<input type="number" min="1" value="${room.durationDays || (roomDays!==null?roomDays:'')}" placeholder="—" onchange="updateMasterRoomDuration('${job.id}','${phase.id}','${room.id}',this.value)" title="Set duration directly -- clears any manual Start/Finish override and drives the schedule from here">` : (roomDays !== null ? roomDays + 'd' : '—'),
                 isOwner ? `<input type="date" value="${room.startDate||''}" onchange="updateMasterRoomDate('${job.id}','${phase.id}','${room.id}','startDate',this.value)" title="${room.startDate?'Custom date':'Auto-scheduled from phase -- set a date here to override'}">` : esc(roomStartD || '—'),
                 isOwner ? `<input type="date" value="${room.endDate||''}" onchange="updateMasterRoomDate('${job.id}','${phase.id}','${room.id}','endDate',this.value)" title="${room.endDate?'Custom date':'Auto-scheduled from phase -- set a date here to override'}">${(room.startDate||room.endDate)?`<button onclick="event.stopPropagation();clearMasterRoomDate('${job.id}','${phase.id}','${room.id}')" title="Clear override, go back to duration/dependency-based or auto-scheduling" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:.7rem;flex-shrink:0;padding:0">✕</button>`:''}` : esc(roomEndD || '—'),

DIFFEOF
  echo "--- Dry run check ---"
  if patch -p1 --dry-run < /tmp/step9.diff; then
    echo "--- Dry run OK, applying for real ---"
    patch -p1 < /tmp/step9.diff
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
git commit -m "Master Schedule: fix name-text overflow clipping the delete/indent/outdent buttons on long task/material names -- add ellipsis truncation + hover tooltip"
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
