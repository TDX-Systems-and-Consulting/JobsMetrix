cd ~/Documents/JOBSpan

echo "=== STEP 1: Adding job-detail header collapse toggle (skips safely if already applied) ==="
python3 - <<'PYEOF2'
with open('kytrac-app.js', 'r', encoding='utf-8') as f:
    js = f.read()
with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

marker = "toggleJobDetailHeaderCollapse"
already_js = js.count(marker)
print(f"JS marker currently appears {already_js} time(s) before this step.")
if already_js >= 2:
    print("kytrac-app.js already patched -- skipping.")
else:
    old_js = "  setTimeout(() => renderGanttFromCache(), 50);\n}"
    new_js = "  setTimeout(() => renderGanttFromCache(), 50);\n}\n\n// Collapses the job-detail header down to a single thin strip (job #,\n// status, name) so whatever tab is active -- Schedule most of all,\n// with its 100-task Gantt, but really any tab -- gets the vertical\n// room the fixed header (contact info, action buttons, financial bar)\n// was eating by default. Toggles three existing blocks via a shared\n// class rather than restructuring the DOM, so nothing about their own\n// layout changes -- they just hide/show as a unit.\nlet _jobDetailHeaderCollapsed = false;\nfunction toggleJobDetailHeaderCollapse() {\n  _jobDetailHeaderCollapsed = !_jobDetailHeaderCollapsed;\n  document.querySelectorAll('#jobDetailModal .jd-collapsible').forEach(el => {\n    el.style.display = _jobDetailHeaderCollapsed ? 'none' : '';\n  });\n  const btn = document.getElementById('jobDetailHeaderToggleBtn');\n  if (btn) btn.textContent = _jobDetailHeaderCollapsed ? '▼ Expand' : '▲ Collapse';\n}\nwindow.toggleJobDetailHeaderCollapse = toggleJobDetailHeaderCollapse;"
    c = js.count(old_js)
    print(f"JS Match: {c} (expect 1)")
    if c == 1:
        js = js.replace(old_js, new_js)
        with open('kytrac-app.js', 'w', encoding='utf-8') as f:
            f.write(js)
        print(f"JS patched. Marker now appears {js.count(marker)} time(s).")
    else:
        print("!! STOP -- JS match was not exactly 1. Tell Claude this number:", c)

html_already = html.count(marker)
print(f"HTML marker currently appears {html_already} time(s) before this step.")
if html_already >= 1:
    print("index.html already patched -- skipping.")
else:
    old1 = "            <option>Permitting</option><option>Scheduled</option><option>In Progress</option>\n            <option>Inspection Pending</option><option>Complete</option>\n            <option>Closed Completed</option><option>Closed Lost</option>\n          </select>"
    new1 = "            <option>Permitting</option><option>Scheduled</option><option>In Progress</option>\n            <option>Inspection Pending</option><option>Complete</option>\n            <option>Closed Completed</option><option>Closed Lost</option>\n          </select>\n          <button id=\"jobDetailHeaderToggleBtn\" onclick=\"toggleJobDetailHeaderCollapse()\" title=\"Collapse contact info, action buttons, and the financial bar to give more room to whatever tab you're viewing (Schedule, Financials, etc). Click again to expand.\" style=\"margin-left:auto;font-size:.72rem;font-weight:700;padding:4px 10px;border-radius:6px;background:rgba(110,145,210,.12);border:1px solid rgba(110,145,210,.25);color:var(--muted);cursor:pointer\">▲ Collapse</button>"
    old2 = "        <h3 id=\"detailJobName\" style=\"margin:5px 0 3px;font-size:1.15rem\"></h3>\n        <div style=\"display:flex;align-items:center;gap:8px;flex-wrap:wrap\">\n          <div id=\"detailJobClient\" class=\"muted small\"></div>\n          <div id=\"detailCallBtns\" style=\"display:flex;gap:5px;flex-wrap:wrap\"></div>\n        </div>\n      </div>\n      <div style=\"display:flex;gap:6px;flex-wrap:wrap;width:100%\">"
    new2 = "        <h3 id=\"detailJobName\" style=\"margin:5px 0 3px;font-size:1.15rem\"></h3>\n        <div class=\"jd-collapsible\" style=\"display:flex;align-items:center;gap:8px;flex-wrap:wrap\">\n          <div id=\"detailJobClient\" class=\"muted small\"></div>\n          <div id=\"detailCallBtns\" style=\"display:flex;gap:5px;flex-wrap:wrap\"></div>\n        </div>\n      </div>\n      <div class=\"jd-collapsible\" style=\"display:flex;gap:6px;flex-wrap:wrap;width:100%\">"
    old3 = "    <div id=\"jobFinBar\" style=\"flex-shrink:0;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:0;background:var(--surface);border-top:1px solid rgba(110,145,210,.12);border-bottom:1px solid rgba(110,145,210,.12)\">"
    new3 = "    <div id=\"jobFinBar\" class=\"jd-collapsible\" style=\"flex-shrink:0;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:0;background:var(--surface);border-top:1px solid rgba(110,145,210,.12);border-bottom:1px solid rgba(110,145,210,.12)\">"
    c1, c2, c3 = html.count(old1), html.count(old2), html.count(old3)
    print(f"HTML Match 1: {c1} (expect 1), Match 2: {c2} (expect 1), Match 3: {c3} (expect 1)")
    ok = True
    if c1 == 1: html = html.replace(old1, new1)
    else: ok = False; print("!! STOP -- HTML match 1 was not exactly 1. Tell Claude this number:", c1)
    if c2 == 1: html = html.replace(old2, new2)
    else: ok = False; print("!! STOP -- HTML match 2 was not exactly 1. Tell Claude this number:", c2)
    if c3 == 1: html = html.replace(old3, new3)
    else: ok = False; print("!! STOP -- HTML match 3 was not exactly 1. Tell Claude this number:", c3)
    if ok:
        with open('index.html', 'w', encoding='utf-8') as f:
            f.write(html)
        print("HTML patched.")
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
git commit -m "Add job-detail header collapse toggle -- reclaims vertical space for whatever tab is active"
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
