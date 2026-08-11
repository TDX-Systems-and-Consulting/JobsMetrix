#!/usr/bin/env python3
"""
Upgrades the "Add Sub / Vendor" modal:
  1. Shows the current job's name and address at the top (read-only),
     so you can confirm you're in the right job before saving.
  2. Replaces the free-text Company/Name field with a dropdown of your
     existing Vendor Directory, auto-filling trade/contact/phone/email
     when you pick one -- with a "+ Add new" option that reveals the
     old free-text input for a genuine one-off vendor not yet in your
     directory.

Touches two files: index.html (markup) and kytrac-app.js (logic).
Run from inside the JOBSpan repo folder:
    python3 patch_sub_modal_upgrade.py
"""

import shutil
import sys

def apply_patch(text, name, old, new, filename):
    count = text.count(old)
    if count == 0:
        print(f"  \u2717 SKIPPED ({filename}): '{name}' \u2014 anchor not found. Insert manually.")
        return text, False
    if count > 1:
        print(f"  \u2717 SKIPPED ({filename}): '{name}' \u2014 anchor found {count} times (not unique).")
        return text, False
    text = text.replace(old, new, 1)
    print(f"  \u2713 Applied ({filename}): {name}")
    return text, True

def main():
    all_ok = True

    # ═══════════════════════════════════════════════════════════════
    # index.html — markup changes
    # ═══════════════════════════════════════════════════════════════
    html_file = "index.html"
    html_backup = "index.html.subvendor.bak"
    print(f"Backing up {html_file} -> {html_backup}")
    shutil.copyfile(html_file, html_backup)
    with open(html_file, encoding="utf-8") as f:
        html = f.read()

    old_html = '''          <input type="hidden" id="subId" />
          <div class="full"><label class="small muted">Company / Name *</label><input id="subName" placeholder="e.g. ABC Electrical LLC" /></div>'''
    new_html = '''          <input type="hidden" id="subId" />
          <div class="full" style="background:rgba(217,119,6,.06);border:1px solid rgba(217,119,6,.15);border-radius:8px;padding:10px 12px;margin-bottom:4px">
            <div style="font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">Job</div>
            <div id="subModalJobName" style="font-size:.88rem;font-weight:800"></div>
            <div id="subModalJobAddress" style="font-size:.78rem;color:var(--muted)"></div>
          </div>
          <div class="full"><label class="small muted">Company / Name *</label>
            <select id="subNameSelect" onchange="handleSubNameSelectChange()" style="margin-bottom:6px">
              <option value="">Select from Vendor Directory\u2026</option>
              <option value="__new__">+ Add new (not in directory)</option>
            </select>
            <input id="subName" placeholder="e.g. ABC Electrical LLC" style="display:none" />
          </div>'''
    html, ok = apply_patch(html, "Job info + vendor dropdown markup", old_html, new_html, html_file)
    all_ok &= ok

    with open(html_file, "w", encoding="utf-8") as f:
        f.write(html)

    # ═══════════════════════════════════════════════════════════════
    # kytrac-app.js — logic changes
    # ═══════════════════════════════════════════════════════════════
    js_file = "kytrac-app.js"
    js_backup = "kytrac-app.js.subvendor.bak"
    print(f"Backing up {js_file} -> {js_backup}")
    shutil.copyfile(js_file, js_backup)
    with open(js_file, encoding="utf-8") as f:
        js = f.read()

    old_add = '''function openAddSubModal() {
  conEditingSubId = null;
  document.getElementById('subModalTitle').textContent = 'Add Sub / Vendor';
  document.getElementById('subId').value = '';
  ['subName','subContact','subPhone','subEmail','subNotes'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  document.getElementById('subTrade').value = 'General Labor';
  document.getElementById('subStatus').value = 'Bidding';
  document.getElementById('subAmount').value = '';
  document.getElementById('subInsExp').value = '';
  document.getElementById('deleteSubBtn').style.display = 'none';
  kOpen('addSubModal');
}'''
    new_add = '''function openAddSubModal() {
  conEditingSubId = null;
  document.getElementById('subModalTitle').textContent = 'Add Sub / Vendor';
  document.getElementById('subId').value = '';
  ['subName','subContact','subPhone','subEmail','subNotes'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  document.getElementById('subTrade').value = 'General Labor';
  document.getElementById('subStatus').value = 'Bidding';
  document.getElementById('subAmount').value = '';
  document.getElementById('subInsExp').value = '';
  document.getElementById('deleteSubBtn').style.display = 'none';
  populateSubModalJobInfo();
  populateSubVendorSelect();
  const sel = document.getElementById('subNameSelect');
  if (sel) sel.value = '';
  const nameInput = document.getElementById('subName');
  if (nameInput) nameInput.style.display = 'none';
  kOpen('addSubModal');
}

// ── Job info + Vendor Directory dropdown for the Add/Edit Sub modal ──
function populateSubModalJobInfo() {
  const job = conJobs.find(j => j.id === conCurrentJobId);
  const nameEl = document.getElementById('subModalJobName');
  const addrEl = document.getElementById('subModalJobAddress');
  if (nameEl) nameEl.textContent = job?.name || 'Job not found';
  if (addrEl) addrEl.textContent = job?.address || '';
}

function populateSubVendorSelect() {
  const sel = document.getElementById('subNameSelect');
  if (!sel) return;
  const vendors = [...allVendors].sort((a,b) => (a.name||'').localeCompare(b.name||''));
  sel.innerHTML = '<option value="">Select from Vendor Directory\\u2026</option>' +
    '<option value="__new__">+ Add new (not in directory)</option>' +
    vendors.map(v => `<option value="${v.id}">${esc(v.name)}${v.trade ? ' \\u2014 ' + esc(v.trade) : ''}</option>`).join('');
}

function handleSubNameSelectChange() {
  const sel = document.getElementById('subNameSelect');
  const nameInput = document.getElementById('subName');
  if (!sel || !nameInput) return;
  const val = sel.value;
  if (val === '__new__') {
    nameInput.style.display = '';
    nameInput.value = '';
    nameInput.focus();
  } else if (val === '') {
    nameInput.style.display = 'none';
    nameInput.value = '';
  } else {
    // An existing vendor was chosen -- auto-fill name, trade, contact,
    // phone, email from the directory record so nothing has to be
    // retyped for data that already exists.
    nameInput.style.display = 'none';
    const vendor = allVendors.find(v => v.id === val);
    if (vendor) {
      nameInput.value = vendor.name || '';
      const tradeEl = document.getElementById('subTrade');
      const contactEl = document.getElementById('subContact');
      const phoneEl = document.getElementById('subPhone');
      const emailEl = document.getElementById('subEmail');
      if (tradeEl && vendor.trade) tradeEl.value = vendor.trade;
      if (contactEl && vendor.contact) contactEl.value = vendor.contact;
      if (phoneEl && vendor.phone) phoneEl.value = vendor.phone;
      if (emailEl && vendor.email) emailEl.value = vendor.email;
    }
  }
}
window.handleSubNameSelectChange = handleSubNameSelectChange;
window.populateSubVendorSelect = populateSubVendorSelect;
window.populateSubModalJobInfo = populateSubModalJobInfo;'''
    js, ok = apply_patch(js, "openAddSubModal() + new helper functions", old_add, new_add, js_file)
    all_ok &= ok

    old_edit = '''function openEditSub(id) {
  const s = conSubs.find(x => x.id === id);
  if (!s) return;
  conEditingSubId = id;
  document.getElementById('subModalTitle').textContent = 'Edit Sub / Vendor';
  document.getElementById('subId').value = id;
  document.getElementById('subName').value = s.name || '';
  document.getElementById('subTrade').value = s.trade || 'General Labor';
  document.getElementById('subStatus').value = s.status || 'Bidding';
  document.getElementById('subContact').value = s.contact || '';
  document.getElementById('subPhone').value = s.phone || '';
  document.getElementById('subEmail').value = s.email || '';
  document.getElementById('subAmount').value = s.amount || '';
  document.getElementById('subInsExp').value = s.insExp || '';
  document.getElementById('subNotes').value = s.notes || '';
  document.getElementById('deleteSubBtn').style.display = 'inline-flex';
  kOpen('addSubModal');
}'''
    new_edit = '''function openEditSub(id) {
  const s = conSubs.find(x => x.id === id);
  if (!s) return;
  conEditingSubId = id;
  document.getElementById('subModalTitle').textContent = 'Edit Sub / Vendor';
  document.getElementById('subId').value = id;
  document.getElementById('subName').value = s.name || '';
  document.getElementById('subTrade').value = s.trade || 'General Labor';
  document.getElementById('subStatus').value = s.status || 'Bidding';
  document.getElementById('subContact').value = s.contact || '';
  document.getElementById('subPhone').value = s.phone || '';
  document.getElementById('subEmail').value = s.email || '';
  document.getElementById('subAmount').value = s.amount || '';
  document.getElementById('subInsExp').value = s.insExp || '';
  document.getElementById('subNotes').value = s.notes || '';
  document.getElementById('deleteSubBtn').style.display = 'inline-flex';
  populateSubModalJobInfo();
  populateSubVendorSelect();
  // If this sub's name matches a vendor in the directory exactly, show
  // that as the selected dropdown option; otherwise fall back to the
  // free-text "+ Add new" input pre-filled with the existing name, so
  // editing a sub that predates the vendor directory (or was a genuine
  // one-off) doesn't lose or mismatch its name.
  const sel = document.getElementById('subNameSelect');
  const nameInput = document.getElementById('subName');
  const matchingVendor = allVendors.find(v => v.name === s.name);
  if (sel && matchingVendor) {
    sel.value = matchingVendor.id;
    if (nameInput) nameInput.style.display = 'none';
  } else if (sel) {
    sel.value = '__new__';
    if (nameInput) nameInput.style.display = '';
  }
  kOpen('addSubModal');
}'''
    js, ok = apply_patch(js, "openEditSub() vendor-match logic", old_edit, new_edit, js_file)
    all_ok &= ok

    with open(js_file, "w", encoding="utf-8") as f:
        f.write(js)

    print()
    if all_ok:
        print("All patches applied.")
        print(f"Backups: {html_backup}, {js_backup}")
        print()
        print("Next: node --check kytrac-app.js, then open the Add Sub modal and")
        print("confirm: job name/address show at the top, the dropdown lists your")
        print("vendors, picking one auto-fills trade/contact/phone/email, and")
        print("'+ Add new' still lets you type a one-off name.")
    else:
        print("Some patches were SKIPPED. Review the .subvendor.bak files before")
        print("committing anything.")
        sys.exit(1)

if __name__ == "__main__":
    main()
