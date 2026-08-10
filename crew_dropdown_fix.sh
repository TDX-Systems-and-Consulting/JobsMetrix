cd ~/Documents/JOBSpan

echo "=== STEP 1: Converting Crew Member to a dropdown (skips safely if already applied) ==="
python3 - <<'PYEOF2'
with open('kytrac-app.js', 'r', encoding='utf-8') as f:
    js = f.read()
with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

marker = "manualCrewSel"
already_js = js.count(marker)
print(f"JS marker currently appears {already_js} time(s) before this step.")

if already_js >= 1:
    print("kytrac-app.js already patched -- skipping.")
else:
    old_js = "  // Manual entry job selector\n  const manualJobSel = document.getElementById('manualJobSelect');\n  if (manualJobSel) {\n    const cur = manualJobSel.value;\n    manualJobSel.innerHTML = '<option value=\"\">Select job...</option>' +\n      conJobs.map(j => `<option value=\"${j.id}\" ${j.id===cur?'selected':''}>${esc(j.jobNumber?'#'+j.jobNumber+' ':'')}${esc(j.name)}</option>`).join('');\n  }\n"
    new_js = "  // Manual entry job selector\n  const manualJobSel = document.getElementById('manualJobSelect');\n  if (manualJobSel) {\n    const cur = manualJobSel.value;\n    manualJobSel.innerHTML = '<option value=\"\">Select job...</option>' +\n      conJobs.map(j => `<option value=\"${j.id}\" ${j.id===cur?'selected':''}>${esc(j.jobNumber?'#'+j.jobNumber+' ':'')}${esc(j.name)}</option>`).join('');\n  }\n\n  // Manual entry crew selector -- real team roster instead of free\n  // text, so names are consistent and match who's actually on the\n  // team (no typos, no \"Jon\" vs \"Jason\" fragmenting the same person\n  // across entries).\n  const manualCrewSel = document.getElementById('manualCrew');\n  if (manualCrewSel) {\n    const cur3 = manualCrewSel.value;\n    manualCrewSel.innerHTML = '<option value=\"\">Myself</option>' +\n      (_lastTeamMemberList || []).map(m => `<option value=\"${esc(m.name||m.email||'')}\" ${(m.name||m.email)===cur3?'selected':''}>${esc(m.name||m.email||'')}</option>`).join('');\n  }\n"
    c = js.count(old_js)
    print(f"JS Match: {c} (expect 1)")
    if c == 1:
        js = js.replace(old_js, new_js)
        with open('kytrac-app.js', 'w', encoding='utf-8') as f:
            f.write(js)
        print("JS patched.")
    else:
        print("!! STOP -- JS match was not exactly 1. Tell Claude this number:", c)

html_already = html.count("id=\"manualCrew\" style=")
print(f"HTML marker currently appears {html_already} time(s) before this step.")
if html_already >= 1:
    print("index.html already patched -- skipping.")
else:
    old_html = "                <label class=\"small muted\" style=\"display:block;margin-bottom:4px\">Crew Member</label>\n                <input id=\"manualCrew\" placeholder=\"Leave blank for yourself\" style=\"font-size:.85rem\" />"
    new_html = "                <label class=\"small muted\" style=\"display:block;margin-bottom:4px\">Crew Member</label>\n                <select id=\"manualCrew\" style=\"font-size:.85rem;padding:9px;background:var(--input-bg);border:1px solid var(--amber-border);color:var(--text);border-radius:8px;width:100%\">\n                  <option value=\"\">Myself</option>\n                </select>"
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
git commit -m "Manual time entry: Crew Member is now a dropdown of real team members instead of free text"
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
