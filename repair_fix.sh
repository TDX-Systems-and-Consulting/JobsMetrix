cd ~/Documents/JOBSpan

echo "=== STEP 1: Adding Repair Team Access button + function (skips safely if already applied) ==="
python3 - <<'PYEOF2'
with open('kytrac-app.js', 'r', encoding='utf-8') as f:
    js = f.read()
with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

marker = "repairTeamMemberAccess"
already_js = js.count(marker)
print(f"JS marker currently appears {already_js} time(s) before this step.")
if already_js >= 2:
    print("kytrac-app.js already patched -- skipping.")
else:
    old_js = "  ]).then(() => {\n    document.getElementById('newMemberEmail').value = '';\n    document.getElementById('newMemberName').value = '';\n    loadTeamMembers();\n    alert(`${name} added as ${role}. They can now sign in with ${email}.`);\n  }).catch(e => alert('Error: ' + e.message));\n}"
    new_js = "  ]).then(() => {\n    document.getElementById('newMemberEmail').value = '';\n    document.getElementById('newMemberName').value = '';\n    loadTeamMembers();\n    alert(`${name} added as ${role}. They can now sign in with ${email}.`);\n  }).catch(e => alert('Error: ' + e.message));\n}\n\n// Backfills company.memberEmails for anyone who has a real\n// settings/team.members profile but is missing from memberEmails --\n// the exact gap addTeamMember's arrayUnion fix (see comment above)\n// closed for everyone added AFTER that fix, but never touched anyone\n// added before it. Those people look completely normal in this\n// Settings page (same profile, same role) but syncMyClaims can't find\n// them in memberEmails, silently clears their claims, and every\n// claims-gated read after that (starting with the jobs listener)\n// fails with permission-denied -- with nothing in the UI pointing\n// back to memberEmails specifically as the cause. Safe to run\n// anytime: arrayUnion is idempotent, so re-running with nobody\n// actually missing just does nothing.\nasync function repairTeamMemberAccess() {\n  if (currentUserRole !== 'Owner') { alert('Only Owners can run this.'); return; }\n  try {\n    const teamDoc = await coll('settings').doc('team').get();\n    const members = teamDoc.exists ? (teamDoc.data().members || {}) : {};\n    const allEmails = Object.values(members).map(m => (m.email || '').toLowerCase()).filter(Boolean);\n    if (!allEmails.length) { alert('No team members found in Settings to check.'); return; }\n\n    const companyDoc = await conDb.collection('companies').doc(currentCompanyId).get();\n    const existing = new Set((companyDoc.data()?.memberEmails || []).map(e => (e || '').toLowerCase()));\n    const missing = allEmails.filter(e => !existing.has(e));\n\n    if (!missing.length) {\n      alert(`Checked ${allEmails.length} team member(s) -- everyone is already correctly set up. Nothing to repair.`);\n      return;\n    }\n\n    if (!confirm(`Found ${missing.length} team member(s) with a Settings profile but missing from memberEmails (the actual permission gate):\\n\\n${missing.join('\\n')}\\n\\nThis is very likely why they can't fully log in / see jobs. Fix now?`)) return;\n\n    await conDb.collection('companies').doc(currentCompanyId).update({\n      memberEmails: firebase.firestore.FieldValue.arrayUnion(...missing)\n    });\n\n    alert(`Repaired ${missing.length} team member(s):\\n\\n${missing.join('\\n')}\\n\\nHave them sign all the way out and back in -- their claims will sync correctly now.`);\n  } catch(e) {\n    alert('Repair failed: ' + e.message);\n  }\n}\nwindow.repairTeamMemberAccess = repairTeamMemberAccess;\n"
    c = js.count(old_js)
    print(f"JS Match: {c} (expect 1)")
    if c == 1:
        js = js.replace(old_js, new_js)
        with open('kytrac-app.js', 'w', encoding='utf-8') as f:
            f.write(js)
        print(f"JS patched. Marker now appears {js.count(marker)} time(s).")
    else:
        print("!! STOP -- JS match was not exactly 1. Tell Claude this number:", c)

already_html = html.count(marker)
print(f"HTML marker currently appears {already_html} time(s) before this step.")
if already_html >= 1:
    print("index.html already patched -- skipping.")
else:
    old_html = "        <div class=\"settings-head\">\n          <h3>👥 Team Members</h3>\n          <p>Add team members and assign their roles. They sign in with their Google account to access JOBSMETRIX.</p>\n        </div>"
    new_html = "        <div class=\"settings-head\">\n          <h3>👥 Team Members</h3>\n          <p>Add team members and assign their roles. They sign in with their Google account to access JOBSMETRIX.</p>\n          <button class=\"btn\" onclick=\"repairTeamMemberAccess()\" title=\"For anyone added before memberEmails syncing was fixed: their team profile exists but they were never added to the company's memberEmails list, so login silently fails on permission checks even though everything looks correct in Settings. This scans every current team member and backfills anyone missing, safely and idempotently -- running it again with nobody missing is a harmless no-op.\" style=\"font-size:.78rem;padding:6px 12px;margin-top:8px\">🔧 Repair Team Access</button>\n        </div>"
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
git commit -m "Add Repair Team Access tool: backfills memberEmails for team members added before that sync was fixed"
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
