cd ~/Documents/JOBSpan

echo "=== STEP 1: Fixing missing Grade suffix on room labels (skips safely if already applied) ==="
python3 - <<'PYEOF2'
with open('kytrac-app.js', 'r', encoding='utf-8') as f:
    js = f.read()

marker = "bundleTier: t.bundleTier || null"
already = js.count(marker)
print(f"Marker currently appears {already} time(s) before this step.")

if already >= 1:
    print("Already patched -- skipping.")
else:
    old = "              parentTaskId: t.parentTaskId || null,\n              order: (t.order != null) ? t.order : idx,\n            });"
    new = "              parentTaskId: t.parentTaskId || null,\n              order: (t.order != null) ? t.order : idx,\n              // Needed for customerSafeLabel/subgroupGradeLabel to\n              // show the \"-- Low/Medium/High Grade\" suffix on room\n              // names (matching the printed Punch List) -- without\n              // this, every room's grade suffix silently comes back\n              // blank since loadEpicTree was never including it.\n              bundleTier: t.bundleTier || null,\n            });"
    c = js.count(old)
    print(f"Match: {c} (expect 1)")
    if c == 1:
        js = js.replace(old, new)
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
git commit -m "Fix loadEpicTree dropping bundleTier -- room labels now correctly show the Grade suffix matching the printed Punch List"
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
