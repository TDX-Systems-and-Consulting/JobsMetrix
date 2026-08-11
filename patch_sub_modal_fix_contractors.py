#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Follow-up fix to patch_sub_modal_upgrade.py -- the dropdown was wired to
allVendors (general vendor/supplier directory) instead of allContractors
(the real subcontractor directory, backed by coll('contractors'), with
trade/contact/phone/email/burdenedRate/crewMemberEmails).

Run from inside the JOBSpan repo folder, AFTER patch_sub_modal_upgrade.py:
    python3 patch_sub_modal_fix_contractors.py
"""

import shutil
import sys

FILE = "kytrac-app.js"
BACKUP = "kytrac-app.js.subvendor2.bak"
HTML_FILE = "index.html"
HTML_BACKUP = "index.html.subvendor2.bak"

DASH = chr(0x2014)      # em dash
ELLIPSIS = chr(0x2026)  # ellipsis

def apply_patch(text, name, old, new, filename):
    count = text.count(old)
    if count == 0:
        print("  X SKIPPED (%s): '%s' -- anchor not found. Did patch_sub_modal_upgrade.py run first?" % (filename, name))
        return text, False
    if count > 1:
        print("  X SKIPPED (%s): '%s' -- anchor found %d times (not unique)." % (filename, name, count))
        return text, False
    text = text.replace(old, new, 1)
    print("  OK Applied (%s): %s" % (filename, name))
    return text, True

def main():
    all_ok = True

    print("Backing up %s -> %s" % (FILE, BACKUP))
    shutil.copyfile(FILE, BACKUP)
    with open(FILE, encoding="utf-8") as f:
        js = f.read()

    old1 = (
        "function populateSubVendorSelect() {\n"
        "  const sel = document.getElementById('subNameSelect');\n"
        "  if (!sel) return;\n"
        "  const vendors = [...allVendors].sort((a,b) => (a.name||'').localeCompare(b.name||''));\n"
        "  sel.innerHTML = '<option value=\"\">Select from Vendor Directory" + ELLIPSIS + "</option>' +\n"
        "    '<option value=\"__new__\">+ Add new (not in directory)</option>' +\n"
        "    vendors.map(v => `<option value=\"${v.id}\">${esc(v.name)}${v.trade ? ' " + DASH + " ' + esc(v.trade) : ''}</option>`).join('');\n"
        "}"
    )
    new1 = (
        "function populateSubVendorSelect() {\n"
        "  const sel = document.getElementById('subNameSelect');\n"
        "  if (!sel) return;\n"
        "  // Contractors (coll('contractors')), NOT allVendors -- Contractors is\n"
        "  // the real subcontractor directory (trade, burdened rate, crew links);\n"
        "  // Vendors is a separate general supplier list.\n"
        "  const contractors = [...(allContractors || [])].sort((a,b) => (a.name||'').localeCompare(b.name||''));\n"
        "  sel.innerHTML = '<option value=\"\">Select from Contractors" + ELLIPSIS + "</option>' +\n"
        "    '<option value=\"__new__\">+ Add new (not in directory)</option>' +\n"
        "    contractors.map(c => `<option value=\"${c.id}\">${esc(c.name)}${c.trade ? ' " + DASH + " ' + esc(c.trade) : ''}</option>`).join('');\n"
        "}"
    )
    js, ok = apply_patch(js, "populateSubVendorSelect() -> allContractors", old1, new1, FILE)
    all_ok &= ok

    old2 = (
        "    const vendor = allVendors.find(v => v.id === val);\n"
        "    if (vendor) {\n"
        "      nameInput.value = vendor.name || '';\n"
        "      const tradeEl = document.getElementById('subTrade');\n"
        "      const contactEl = document.getElementById('subContact');\n"
        "      const phoneEl = document.getElementById('subPhone');\n"
        "      const emailEl = document.getElementById('subEmail');\n"
        "      if (tradeEl && vendor.trade) tradeEl.value = vendor.trade;\n"
        "      if (contactEl && vendor.contact) contactEl.value = vendor.contact;\n"
        "      if (phoneEl && vendor.phone) phoneEl.value = vendor.phone;\n"
        "      if (emailEl && vendor.email) emailEl.value = vendor.email;\n"
        "    }"
    )
    new2 = (
        "    const contractor = (allContractors || []).find(c => c.id === val);\n"
        "    if (contractor) {\n"
        "      nameInput.value = contractor.name || '';\n"
        "      const tradeEl = document.getElementById('subTrade');\n"
        "      const contactEl = document.getElementById('subContact');\n"
        "      const phoneEl = document.getElementById('subPhone');\n"
        "      const emailEl = document.getElementById('subEmail');\n"
        "      if (tradeEl && contractor.trade) tradeEl.value = contractor.trade;\n"
        "      if (contactEl && contractor.contact) contactEl.value = contractor.contact;\n"
        "      if (phoneEl && contractor.phone) phoneEl.value = contractor.phone;\n"
        "      if (emailEl && contractor.email) emailEl.value = contractor.email;\n"
        "    }"
    )
    js, ok = apply_patch(js, "handleSubNameSelectChange() -> allContractors", old2, new2, FILE)
    all_ok &= ok

    old3 = (
        "  const matchingVendor = allVendors.find(v => v.name === s.name);\n"
        "  if (sel && matchingVendor) {\n"
        "    sel.value = matchingVendor.id;"
    )
    new3 = (
        "  const matchingContractor = (allContractors || []).find(c => c.name === s.name);\n"
        "  if (sel && matchingContractor) {\n"
        "    sel.value = matchingContractor.id;"
    )
    js, ok = apply_patch(js, "openEditSub() matching lookup -> allContractors", old3, new3, FILE)
    all_ok &= ok

    with open(FILE, "w", encoding="utf-8") as f:
        f.write(js)

    print("Backing up %s -> %s" % (HTML_FILE, HTML_BACKUP))
    shutil.copyfile(HTML_FILE, HTML_BACKUP)
    with open(HTML_FILE, encoding="utf-8") as f:
        html = f.read()

    old_html = '<option value="">Select from Vendor Directory' + ELLIPSIS + '</option>'
    new_html = '<option value="">Select from Contractors' + ELLIPSIS + '</option>'
    html, ok = apply_patch(html, "Dropdown placeholder label text", old_html, new_html, HTML_FILE)
    all_ok &= ok

    with open(HTML_FILE, "w", encoding="utf-8") as f:
        f.write(html)

    print("")
    if all_ok:
        print("All patches applied. Backups saved with .subvendor2.bak suffix.")
        print("")
        print("Next: node --check kytrac-app.js, then reload localhost:8000, open")
        print("Add Sub / Vendor again, and confirm the dropdown now lists your")
        print("actual Contractors (with trade shown), not the Vendors list.")
    else:
        print("Some patches were SKIPPED. Review the .subvendor2.bak files before")
        print("committing anything.")
        sys.exit(1)

if __name__ == "__main__":
    main()
