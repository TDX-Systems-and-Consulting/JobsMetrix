cd ~/Documents/JOBSpan

echo "=== STEP 1: Adding time-entry Edit capability + Owner clock-out override (skips safely if already applied) ==="
python3 - <<'PYEOF2'
with open('kytrac-app.js', 'r', encoding='utf-8') as f:
    js = f.read()
with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

marker = "openEditTimeEntry"
already_js = js.count(marker)
print(f"JS marker currently appears {already_js} time(s) before this step.")

if already_js >= 2:
    print("kytrac-app.js already patched -- skipping.")
else:
    old_js = "      <td>\n        ${!e.clockOut && e.userId===conCurrentUser?.uid\n          ? `<button class=\"btn btn-danger\" onclick=\"forceClockOut('${e.id}')\" style=\"padding:3px 8px;font-size:.74rem\">Clock Out</button>`\n          : `<button class=\"btn\" onclick=\"deleteTimeEntry('${e.id}')\" style=\"padding:3px 8px;font-size:.74rem\">✕</button>`}\n      </td>\n    </tr>`;\n  }).join('');\n\n  if (tfoot) tfoot.innerHTML = `<tr style=\"background:rgba(217,119,6,.06);font-weight:800\">\n    <td colspan=\"6\" style=\"padding:10px 12px;color:var(--amber)\">TOTAL (${entries.filter(e=>e.hours).length} entries)</td>\n    <td style=\"text-align:right;color:#a3f2d2\">${totalHours.toFixed(2)}h</td>\n    <td colspan=\"2\"></td>\n  </tr>`;\n  renderWeeklyOvertime();\n}"
    new_js = "      <td>\n        ${(() => {\n          const canManage = currentUserRole === 'Owner' || currentUserTeamData?.fullAccessOverride;\n          const isOwnLiveEntry = !e.clockOut && e.userId === conCurrentUser?.uid;\n          const buttons = [];\n          if (!e.clockOut && (isOwnLiveEntry || canManage)) {\n            buttons.push(`<button class=\"btn btn-danger\" onclick=\"forceClockOut('${e.id}')\" style=\"padding:3px 8px;font-size:.74rem\">Clock Out</button>`);\n          }\n          if (canManage) {\n            buttons.push(`<button class=\"btn\" onclick=\"openEditTimeEntry('${e.id}')\" style=\"padding:3px 8px;font-size:.74rem\">✏️ Edit</button>`);\n          }\n          buttons.push(`<button class=\"btn\" onclick=\"deleteTimeEntry('${e.id}')\" style=\"padding:3px 8px;font-size:.74rem\">✕</button>`);\n          return buttons.join(' ');\n        })()}\n      </td>\n    </tr>`;\n  }).join('');\n\n  if (tfoot) tfoot.innerHTML = `<tr style=\"background:rgba(217,119,6,.06);font-weight:800\">\n    <td colspan=\"6\" style=\"padding:10px 12px;color:var(--amber)\">TOTAL (${entries.filter(e=>e.hours).length} entries)</td>\n    <td style=\"text-align:right;color:#a3f2d2\">${totalHours.toFixed(2)}h</td>\n    <td colspan=\"2\"></td>\n  </tr>`;\n  renderWeeklyOvertime();\n}\n\n// Owner/Full-Access editing for an existing time entry -- corrects a\n// wrong clock-in time, adjusts hours after the fact, or fixes a typo\n// in notes. Previously the only options on any entry were \"force\n// clock out your own live entry\" or \"delete\" -- no way to actually\n// correct a mistake without losing the record and re-entering it from\n// scratch, and no way to touch anyone else's entry but your own live\n// one at all.\nfunction openEditTimeEntry(entryId) {\n  const entry = allTimeEntries.find(e => e.id === entryId);\n  if (!entry) return;\n  const canManage = currentUserRole === 'Owner' || currentUserTeamData?.fullAccessOverride;\n  if (!canManage) { alert('Only Owners (or team members with Full Access Override) can edit time entries.'); return; }\n\n  document.getElementById('editTimeEntryWho').textContent = `${entry.userName || 'Unknown'} · ${entry.jobName || 'No job'}${entry.phaseName ? ' · ' + entry.phaseName : ''}`;\n  document.getElementById('editTimeDate').value = entry.date || '';\n  document.getElementById('editTimeClockIn').value = entry.clockInISO ? isoToLocalDatetimeInput(entry.clockInISO) : '';\n  document.getElementById('editTimeClockOut').value = entry.clockOutISO ? isoToLocalDatetimeInput(entry.clockOutISO) : '';\n  document.getElementById('editTimeHours').value = entry.hours != null ? entry.hours : '';\n  document.getElementById('editTimeNotes').value = entry.notes || '';\n  document.getElementById('editTimeEntryModal').dataset.entryId = entryId;\n  kOpen('editTimeEntryModal');\n}\nwindow.openEditTimeEntry = openEditTimeEntry;\n\n// datetime-local inputs need \"YYYY-MM-DDTHH:mm\" in the browser's own\n// local time, not UTC -- toISOString() would silently shift the\n// displayed time by the browser's UTC offset every time this modal\n// opens, showing the wrong clock-in time even though the stored value\n// is correct.\nfunction isoToLocalDatetimeInput(iso) {\n  const d = new Date(iso);\n  const pad = n => String(n).padStart(2, '0');\n  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;\n}\n\nfunction saveEditTimeEntry() {\n  const entryId = document.getElementById('editTimeEntryModal').dataset.entryId;\n  if (!entryId) return;\n  const canManage = currentUserRole === 'Owner' || currentUserTeamData?.fullAccessOverride;\n  if (!canManage) { alert('Only Owners (or team members with Full Access Override) can edit time entries.'); return; }\n\n  const date = document.getElementById('editTimeDate').value;\n  const clockInVal = document.getElementById('editTimeClockIn').value;\n  const clockOutVal = document.getElementById('editTimeClockOut').value;\n  const hoursVal = document.getElementById('editTimeHours').value;\n  const notes = document.getElementById('editTimeNotes').value.trim();\n\n  if (!date) { alert('Date is required.'); return; }\n\n  const updates = { date, notes, editedAt: firebase.firestore.FieldValue.serverTimestamp(), editedBy: conCurrentUser?.email || '' };\n  const del = firebase.firestore.FieldValue.delete();\n\n  if (clockInVal) {\n    const clockInDate = new Date(clockInVal);\n    updates.clockInISO = clockInDate.toISOString();\n    updates.clockIn = firebase.firestore.Timestamp.fromDate(clockInDate);\n    if (clockOutVal) {\n      const clockOutDate = new Date(clockOutVal);\n      if (clockOutDate <= clockInDate) { alert('Clock Out must be after Clock In.'); return; }\n      updates.clockOutISO = clockOutDate.toISOString();\n      updates.clockOut = firebase.firestore.Timestamp.fromDate(clockOutDate);\n      updates.hours = Math.round((clockOutDate - clockInDate) / 3600000 * 100) / 100;\n    } else {\n      // Clock In given, Clock Out left blank -- back to live/in-progress.\n      updates.clockOutISO = del;\n      updates.clockOut = del;\n      updates.hours = del;\n    }\n  } else {\n    // No clock times at all -- treat as a manual hours entry.\n    updates.clockInISO = del;\n    updates.clockIn = del;\n    updates.clockOutISO = del;\n    updates.clockOut = del;\n    const hours = parseFloat(hoursVal);\n    if (isNaN(hours) || hours <= 0) { alert('Enter hours, or set a Clock In time instead.'); return; }\n    updates.hours = hours;\n  }\n\n  coll('timeentries').doc(entryId).update(updates).then(() => {\n    kClose('editTimeEntryModal');\n  }).catch(e => alert('Error saving: ' + e.message));\n}\nwindow.saveEditTimeEntry = saveEditTimeEntry;"
    c = js.count(old_js)
    print(f"JS Match: {c} (expect 1)")
    if c == 1:
        js = js.replace(old_js, new_js)
        with open('kytrac-app.js', 'w', encoding='utf-8') as f:
            f.write(js)
        print(f"JS patched. Marker now appears {js.count(marker)} time(s).")
    else:
        print("!! STOP -- JS match was not exactly 1. Tell Claude this number:", c)

html_already = html.count("editTimeEntryModal")
print(f"HTML marker currently appears {html_already} time(s) before this step.")
if html_already >= 1:
    print("index.html already patched -- skipping.")
else:
    old_html = "            <tbody id=\"timeLogBody\"></tbody>\n            <tfoot id=\"timeLogFoot\"></tfoot>\n          </table>\n        </div>\n      </div>\n    </div>"
    new_html = "            <tbody id=\"timeLogBody\"></tbody>\n            <tfoot id=\"timeLogFoot\"></tfoot>\n          </table>\n        </div>\n      </div>\n    </div>\n\n    <!-- —— Edit Time Entry Modal (Owner / Full Access only) —— -->\n    <div id=\"editTimeEntryModal\" class=\"modal-overlay\">\n      <div class=\"modal-box\" style=\"max-width:440px\">\n        <div class=\"modal-head\">\n          <h3>✏️ Edit Time Entry</h3>\n          <button class=\"modal-close\" onclick=\"kClose('editTimeEntryModal')\">✕</button>\n        </div>\n        <div class=\"modal-body\">\n          <div style=\"font-size:.78rem;color:var(--muted);margin-bottom:14px\" id=\"editTimeEntryWho\"></div>\n          <label class=\"small muted\">Date</label>\n          <input id=\"editTimeDate\" type=\"date\" style=\"width:100%;margin-bottom:12px\" />\n          <label class=\"small muted\">Clock In (leave blank if this was a manual hours entry)</label>\n          <input id=\"editTimeClockIn\" type=\"datetime-local\" style=\"width:100%;margin-bottom:12px\" />\n          <label class=\"small muted\">Clock Out (leave blank to keep this entry live / still clocked in)</label>\n          <input id=\"editTimeClockOut\" type=\"datetime-local\" style=\"width:100%;margin-bottom:12px\" />\n          <label class=\"small muted\">Hours (used directly if Clock In/Out above are blank; otherwise recalculated automatically from them on save)</label>\n          <input id=\"editTimeHours\" type=\"number\" step=\"0.01\" min=\"0\" style=\"width:100%;margin-bottom:12px\" />\n          <label class=\"small muted\">Notes</label>\n          <input id=\"editTimeNotes\" type=\"text\" style=\"width:100%;margin-bottom:16px\" />\n          <button class=\"btn-amber\" onclick=\"saveEditTimeEntry()\" style=\"width:100%\">Save Changes</button>\n        </div>\n      </div>\n    </div>"
    c2 = html.count(old_html)
    print(f"HTML Match: {c2} (expect 1)")
    if c2 == 1:
        html = html.replace(old_html, new_html)
        with open('index.html', 'w', encoding='utf-8') as f:
            f.write(html)
        print("HTML patched.")
    else:
        print("!! STOP -- HTML match was not exactly 1. Tell Claude this number:", c2)
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
git commit -m "Time Tracking: Owners can now Clock Out anyone and Edit any time entry (date/times/hours/notes), not just their own live entry"
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
