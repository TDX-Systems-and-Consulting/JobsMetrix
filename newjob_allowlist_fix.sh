cd ~/Documents/JOBSpan

echo "=== STEP 1: Switching + New Job to an allowlist (Home + Jobs only) (skips safely if already applied) ==="
python3 - <<'PYEOF2'
with open('kytrac-app.js', 'r', encoding='utf-8') as f:
    js = f.read()

marker = "NEW_JOB_VISIBLE_ON"
already = js.count(marker)
print(f"Marker currently appears {already} time(s) before this step.")

if already >= 1:
    print("Already patched -- skipping.")
else:
    old_js = "  if (newJobBtn) newJobBtn.style.display = (key === 'time') ? 'none' : '';"
    new_js = "  // \"+ New Job\" was showing on every single page -- it was baked\n  // into the shared topbar shell rather than being page-aware.\n  // Allowlist instead of a growing blacklist: show it only where\n  // creating a job is actually a natural action (Home overview, the\n  // Jobs list/board itself), hide it everywhere else by default.\n  const NEW_JOB_VISIBLE_ON = ['dashboard', 'jobs'];\n  if (newJobBtn) newJobBtn.style.display = NEW_JOB_VISIBLE_ON.includes(key) ? '' : 'none';"
    c = js.count(old_js)
    print(f"Match: {c} (expect 1)")
    if c == 1:
        js = js.replace(old_js, new_js)
        with open('kytrac-app.js', 'w', encoding='utf-8') as f:
            f.write(js)
        print("Patched.")
    else:
        print("!! STOP -- match was not exactly 1. Tell Claude this number:", c)
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
git commit -m "New Job button: allowlist (Home + Jobs only) instead of hiding one page at a time"
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
