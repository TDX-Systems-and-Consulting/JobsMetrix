#!/usr/bin/env python3
"""
Follow-up patch to the Subcontractor Agreement system (patch_sub_agreements.py).

Updates buildSubAgreementText() so Section 2 (Contract Price) itemizes the
actual dollar amounts per payment stage, computed by reusing the job's
existing customer paymentSchedule against the SUB's bid amount instead of
the job's grand total -- via the already-shared getPaymentScheduleRows()
helper (same function the customer proposal and invoicing already use).

If the job has no paymentSchedule set, falls back to the original generic
wording -- nothing breaks for jobs that never set a schedule.

Run from inside the JOBSpan repo folder, AFTER patch_sub_agreements.py:
    python3 patch_sub_agreement_payment_schedule.py
"""

import shutil
import sys

FILE = "kytrac-app.js"
BACKUP = "kytrac-app.js.bak2"

def load():
    with open(FILE, encoding="utf-8") as f:
        return f.read()

def save(text):
    with open(FILE, "w", encoding="utf-8") as f:
        f.write(text)

def apply_patch(text, name, old, new):
    count = text.count(old)
    if count == 0:
        print(f"  \u2717 SKIPPED: '{name}' \u2014 anchor not found. Did patch_sub_agreements.py run successfully first?")
        return text, False
    if count > 1:
        print(f"  \u2717 SKIPPED: '{name}' \u2014 anchor found {count} times (not unique).")
        return text, False
    text = text.replace(old, new, 1)
    print(f"  \u2713 Applied: {name}")
    return text, True

def main():
    print(f"Backing up {FILE} -> {BACKUP}")
    shutil.copyfile(FILE, BACKUP)

    text = load()

    old = '''function buildSubAgreementText(sub, job, co) {
  const companyName = co.companyName || co.legalName || 'TDX Holdings LLC dba JTXD Contracting';
  const jobName = job.name || 'Project';
  const jobAddress = job.address || 'Address on File';
  const subName = sub.name || 'Subcontractor';
  const trade = sub.trade || 'General Labor';
  // Defensive: bid-award flow currently writes the amount to `contract`,
  // while the sub card and this agreement read `amount` -- support both
  // so an existing data quirk doesn't produce a $0 agreement.
  const amount = sub.amount || sub.contract || 0;
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const amtStr = Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return [
    'SUBCONTRACTOR AGREEMENT',
    '',
    `Agreement Date: ${today}`,
    `Company: ${companyName}`,
    `Subcontractor: ${subName}`,
    `Trade: ${trade}`,
    `Project: ${jobName}`,
    `Project Address: ${jobAddress}`,
    `Contract Price: $${amtStr}`,
    '',
    `This Subcontractor Agreement ("Agreement") is entered into as of the Agreement Date above by and between ${companyName} ("Company") and ${subName} ("Subcontractor").`,
    '',
    `1. SCOPE OF WORK. Subcontractor agrees to furnish all labor, materials (unless otherwise agreed in writing), equipment, and supervision necessary to perform ${trade} work at ${jobAddress}, in accordance with the agreed scope for this project.`,
    '',
    `2. CONTRACT PRICE. The total contract price for the Work is $${amtStr}, payable per Company's standard payment schedule upon completion of agreed milestones and Company's acceptance of the Work.`,
    '','''

    new = '''function buildSubAgreementText(sub, job, co) {
  const companyName = co.companyName || co.legalName || 'TDX Holdings LLC dba JTXD Contracting';
  const jobName = job.name || 'Project';
  const jobAddress = job.address || 'Address on File';
  const subName = sub.name || 'Subcontractor';
  const trade = sub.trade || 'General Labor';
  // Defensive: bid-award flow currently writes the amount to `contract`,
  // while the sub card and this agreement read `amount` -- support both
  // so an existing data quirk doesn't produce a $0 agreement.
  const amount = sub.amount || sub.contract || 0;
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const amtStr = Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Reuse the job's existing customer payment schedule (same stages/
  // percentages already set on the Estimate tab), applied to the SUB's
  // bid amount instead of the job's grand total -- via the same shared
  // helper the customer proposal and invoicing already use, so the
  // vocabulary/percentages can never drift out of sync with those.
  // Falls back to the generic line below if the job has no schedule set.
  const subPaymentRows = (typeof getPaymentScheduleRows === 'function')
    ? getPaymentScheduleRows(job.paymentSchedule, amount)
    : [];
  const paymentScheduleLines = subPaymentRows.length
    ? subPaymentRows.map(r => `   \\u2022 ${r.label} (${r.pct}%): $${Number(r.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`).join('\\n')
    : null;
  const contractPriceClause = paymentScheduleLines
    ? `2. CONTRACT PRICE. The total contract price for the Work is $${amtStr}, payable according to the following schedule:\\n\\n${paymentScheduleLines}\\n\\nEach payment is due upon Company's acceptance of the Work completed for that stage.`
    : `2. CONTRACT PRICE. The total contract price for the Work is $${amtStr}, payable per Company's standard payment schedule upon completion of agreed milestones and Company's acceptance of the Work.`;

  return [
    'SUBCONTRACTOR AGREEMENT',
    '',
    `Agreement Date: ${today}`,
    `Company: ${companyName}`,
    `Subcontractor: ${subName}`,
    `Trade: ${trade}`,
    `Project: ${jobName}`,
    `Project Address: ${jobAddress}`,
    `Contract Price: $${amtStr}`,
    '',
    `This Subcontractor Agreement ("Agreement") is entered into as of the Agreement Date above by and between ${companyName} ("Company") and ${subName} ("Subcontractor").`,
    '',
    `1. SCOPE OF WORK. Subcontractor agrees to furnish all labor, materials (unless otherwise agreed in writing), equipment, and supervision necessary to perform ${trade} work at ${jobAddress}, in accordance with the agreed scope for this project.`,
    '',
    contractPriceClause,
    '','''

    text, ok = apply_patch(text, "Payment schedule breakdown in Contract Price clause", old, new)

    save(text)

    print()
    if ok:
        print("Applied. Backup saved as kytrac-app.js.bak2")
        print()
        print("Next: node --check kytrac-app.js, then send a fresh agreement to test")
        print("(any agreement already sent before this patch keeps its original frozen")
        print("text -- only NEW agreements sent after this will show the schedule).")
    else:
        print("Patch was SKIPPED. Do not proceed until reviewed against")
        print("kytrac-app.js.bak2 -- most likely cause: patch_sub_agreements.py")
        print("wasn't run first, or the function was hand-edited since.")
        sys.exit(1)

if __name__ == "__main__":
    main()
