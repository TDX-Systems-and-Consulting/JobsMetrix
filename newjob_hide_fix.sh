cd ~/Documents/JOBSpan

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
git commit -m "Hide plus New Job button on the Time Tracking page -- was showing globally on every page"
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
