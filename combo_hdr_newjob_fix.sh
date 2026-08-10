cd ~/Documents/JOBSpan

echo "=== STEP 1: Fixing the broken header-collapse toggle (skips safely if already fixed) ==="
python3 - <<'PYEOF2'
with open('kytrac-app.js', 'r', encoding='utf-8') as f:
    js = f.read()
with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

fixed_marker = "classList.toggle('jd-collapsed-hide'"
already_fixed = js.count(fixed_marker)
print(f"Fixed-version marker currently appears {already_fixed} time(s) before this step.")

if already_fixed >= 1:
    print("kytrac-app.js already has the corrected version -- skipping JS.")
else:
    old_js = "// Collapses the job-detail header down to a single thin strip (job #,\n// status, name) so whatever tab is active -- Schedule most of all,\n// with its 100-task Gantt, but really any tab -- gets the vertical\n// room the fixed header (contact info, action buttons, financial bar)\n// was eating by default. Toggles three existing blocks via a shared\n// class rather than restructuring the DOM, so nothing about their own\n// layout changes -- they just hide/show as a unit.\nlet _jobDetailHeaderCollapsed = false;\nfunction toggleJobDetailHeaderCollapse() {\n  _jobDetailHeaderCollapsed = !_jobDetailHeaderCollapsed;\n  document.querySelectorAll('#jobDetailModal .jd-collapsible').forEach(el => {\n    el.style.display = _jobDetailHeaderCollapsed ? 'none' : '';\n  });\n  const btn = document.getElementById('jobDetailHeaderToggleBtn');\n  if (btn) btn.textContent = _jobDetailHeaderCollapsed ? '▼ Expand' : '▲ Collapse';\n}\nwindow.toggleJobDetailHeaderCollapse = toggleJobDetailHeaderCollapse;"
    new_js = "// Collapses the job-detail header down to a single thin strip (job #,\n// status, name) so whatever tab is active -- Schedule most of all,\n// with its 100-task Gantt, but really any tab -- gets the vertical\n// room the fixed header (contact info, action buttons, financial bar)\n// was eating by default. Uses a CSS class rather than directly\n// setting el.style.display: jobFinBar's own inline style is\n// display:grid, and clearing a directly-set style.display property\n// doesn't restore that -- it falls through to the browser default\n// (block), collapsing the whole 7-column grid into one stacked\n// column. A class only adds/removes display:none !important on top,\n// leaving the original inline display value completely untouched.\nlet _jobDetailHeaderCollapsed = false;\nfunction toggleJobDetailHeaderCollapse() {\n  _jobDetailHeaderCollapsed = !_jobDetailHeaderCollapsed;\n  document.querySelectorAll('#jobDetailModal .jd-collapsible').forEach(el => {\n    el.classList.toggle('jd-collapsed-hide', _jobDetailHeaderCollapsed);\n  });\n  const btn = document.getElementById('jobDetailHeaderToggleBtn');\n  if (btn) btn.textContent = _jobDetailHeaderCollapsed ? '▼ Expand' : '▲ Collapse';\n}\nwindow.toggleJobDetailHeaderCollapse = toggleJobDetailHeaderCollapse;"
    c = js.count(old_js)
    print(f"JS Match (broken version): {c} (expect 1)")
    if c == 1:
        js = js.replace(old_js, new_js)
        with open('kytrac-app.js', 'w', encoding='utf-8') as f:
            f.write(js)
        print("JS patched with corrected version.")
    else:
        print("!! STOP -- JS match was not exactly 1. Tell Claude this number:", c)

css_marker = "jd-collapsed-hide { display: none"
css_already = html.count(css_marker)
print(f"CSS class currently appears {css_already} time(s) before this step.")
if css_already >= 1:
    print("index.html already has the CSS class -- skipping HTML.")
else:
    old_css = "    .fin-bar-cell { padding: 10px 16px; text-align: center; }\n    .fin-bar-label { font-size: .68rem; text-transform: uppercase; letter-spacing: .07em; color: rgba(148,163,184,.6); font-weight: 700; margin-bottom: 3px; }\n    .fin-bar-val { font-size: 1.05rem; font-weight: 900; }"
    new_css = "    .fin-bar-cell { padding: 10px 16px; text-align: center; }\n    .fin-bar-label { font-size: .68rem; text-transform: uppercase; letter-spacing: .07em; color: rgba(148,163,184,.6); font-weight: 700; margin-bottom: 3px; }\n    .fin-bar-val { font-size: 1.05rem; font-weight: 900; }\n    .jd-collapsed-hide { display: none !important; }"
    c2 = html.count(old_css)
    print(f"CSS Match: {c2} (expect 1)")
    if c2 == 1:
        html = html.replace(old_css, new_css)
        with open('index.html', 'w', encoding='utf-8') as f:
            f.write(html)
        print("CSS class added.")
    else:
        print("!! STOP -- CSS match was not exactly 1. Tell Claude this number:", c2)
PYEOF2

node --check kytrac-app.js && echo "Syntax OK" || { echo "!! SYNTAX ERROR -- STOP, tell Claude"; exit 1; }


echo "=== STEP 1: Hiding + New Job on the Time page (skips safely if already applied) ==="
python3 - <<'PYEOF2'
with open('kytrac-app.js', 'r', encoding='utf-8') as f:
    js = f.read()
with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

marker = "ktNewJobBtn"
already_js = js.count(marker)
print(f"JS marker currently appears {already_js} time(s) before this step.")

if already_js >= 1:
    print("kytrac-app.js already patched -- skipping.")
else:
    old_js = "  // Close mobile sidebar\n  document.getElementById('ktSidebar')?.classList.remove('open');\n  // Trigger renders\n"
    new_js = "  // Close mobile sidebar\n  document.getElementById('ktSidebar')?.classList.remove('open');\n  // \"+ New Job\" was showing on every single page, including Time\n  // Tracking (clock in/out) where creating a job makes no sense --\n  // it was baked into the shared topbar shell rather than being\n  // page-aware. Hiding it on pages with no real connection to\n  // creating a job.\n  const newJobBtn = document.getElementById('ktNewJobBtn');\n  if (newJobBtn) newJobBtn.style.display = (key === 'time') ? 'none' : '';\n  // Trigger renders\n"
    c = js.count(old_js)
    print(f"JS Match: {c} (expect 1)")
    if c == 1:
        js = js.replace(old_js, new_js)
        with open('kytrac-app.js', 'w', encoding='utf-8') as f:
            f.write(js)
        print("JS patched.")
    else:
        print("!! STOP -- JS match was not exactly 1. Tell Claude this number:", c)

html_already = html.count(marker)
print(f"HTML marker currently appears {html_already} time(s) before this step.")
if html_already >= 1:
    print("index.html already patched -- skipping.")
else:
    old_html = "        <button class=\"btn-amber\" onclick=\"openNewJobModal()\">+ New Job</button>"
    new_html = "        <button class=\"btn-amber\" id=\"ktNewJobBtn\" onclick=\"openNewJobModal()\">+ New Job</button>"
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

echo ""
echo "=== STEP 3: Bumping the cache-buster version stamp ==="
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
echo "=== STEP 4: Commit + push ==="
git add -A
git commit -m "Fix header-collapse toggle + hide New Job button on Time page"
git push origin main

echo ""
echo "=== STEP 5: Regenerate version.json with the real deployed commit hash ==="
echo "{\"commit\":\"$(git rev-parse --short HEAD)\",\"date\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > version.json
cat version.json

echo ""
echo "=== STEP 6: Deploy ==="
firebase deploy --only hosting --project kytrac-72d91

echo ""
echo "=== DONE -- Build badge should now read: $(git rev-parse --short HEAD) ==="
