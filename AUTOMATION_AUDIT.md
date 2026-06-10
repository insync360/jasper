# Salesforce Lifecycle Automation Audit (rrdev sandbox)

> Read-only review of how the Lead → Test Drive → Order(Booking) → Delivery lifecycle is
> programmed across Apex triggers and Flows, with concrete bugs and recommended corrections.
> Reviewed 2026-06-09. **Nothing has been changed** except where noted as "FIXED".

The org has **heavy, overlapping automation**: multiple triggers per object + many record-triggered
flows writing the same fields. The recurring themes are: (1) **duplicate/conflicting automation**
fighting over the same fields, (2) **hardcoded values**, (3) **silent `try/catch`** that hides
failures, (4) **broken string literals** (typos) that make whole branches dead, and (5) **missing
automation after key milestones** (especially Test Drive *Completed*).

---

## 🔴 Confirmed bugs (fix first — concrete, low-risk)

### 1. Test-drive cancellation never works — `'Canceled'` vs `'Cancelled'`
`TestDriveTriggerHandler.ifTestRideCancelled` checks `Test_Drive_Status__c == 'Canceled'` (one L),
but the picklist value is **`Cancelled`** (two L's). The branch is **dead** → the cancellation
WhatsApp message never sends. **Fix:** correct the literal to `'Cancelled'`.

### 2. WhatsApp delivery greeting double-fires *(OURS — FIXED)*
`OrderWhatsAppTrigger` fired on `Status.containsIgnoreCase('Deliver')`, which matches BOTH
`'Vehicle Delivered'` (retail) and `'Delivered'` (OTC) → a customer could get two greetings.
**FIXED:** now fires only on exact `Status = 'Vehicle Delivered'`.

### 3. Booking receipts dropped in bulk — early `return`
`OrderTriggerHandler.sendWhatsAppAfterOrderCreation` loops orders and does `else { return; }` on the
first non-matching order → all later orders in the batch are skipped. Also the product/color lookup
is `LIMIT 1` (not per-order) so every order gets the same colour. **Fix:** `continue` instead of
`return`; query OrderItems/Products into a map keyed by OrderId.

### 4. Order cancellation guard is dead — wrong literal
`Order - Before Create/Update` compares prior status to `'Ready To Delivery'`, but the real value is
**`'Ready For Delivery'`** → the flow-level "can't cancel after ready for delivery" guard never
matches (only the Apex guard protects it). **Fix:** correct the literal.

### 5. Hardcoded fake data written to every Lead
`TestDriver` trigger (after insert) writes `DLcopy__c = 'KA2345678765678'` (a fake DL) to the Lead on
every Test Drive insert, and sets `Test_Ride_Given__c = true` at *creation* (before the ride happens).
**Fix:** remove the hardcoded DL; don't mark the ride "given" on creation; ideally retire this trigger
(see #9).

---

## 🟠 Functional gaps (missing automation)

### 6. Nothing happens when a Test Drive is *Completed*
The only Completed-stage automation alive is a flow that stamps the completion date. The customer
"ride done" message and the lead-conversion logic are **all commented out** in
`TestDriveTriggerHandler`. So after a completed test drive there is **no** next-step: no booking
prompt, no Lead/Opportunity advance. *(This is exactly the lifecycle point your demo needs.)*
**Fix:** add Completed-stage automation — e.g. advance the Lead and/or send a WhatsApp "ready to
book?" message (this pairs with the bot change to not prompt booking until the ride completes).

### 7. `In Progress` test-drive status is orphaned
No automation moves a ride New/Scheduled → In Progress → Completed; statuses are manual. Decide
whether to auto-advance or drop the value.

---

## 🟡 Conflicting / duplicated automation (recursion + governor risk)

### 8. Lead routing done twice
Apex `LeadTriggerHandler.checkLeadStatus` AND Flow `Lead assignment to Dealers` both set
`OwnerId/Dealer_Code__c/Stores_Name__c/City`. On insert both can fire and overwrite each other;
`checkLeadStatus` also issues **3 separate DML updates** on the same leads → re-fires after-update
automation. **Fix:** pick ONE routing mechanism; set fields in-memory (before-save) with a single DML.

### 9. Two Test Drive triggers, both update the Lead
`TestDriver` and `TestDriveTrigger` are both active on `Test_Drive__c`; both set `Lead.Status='Test
Ride'`. **Fix:** consolidate to one trigger + handler with a recursion guard.

### 10. Three Order triggers + many Status writers
`OrderTrigger`, `UpdateVehicleInsuranceAndFinance`, and `OrderWhatsAppTrigger` all run on Order;
`OrderTrigger` and the insurance trigger both call `updateVehicle`. Order.Status is written by the
Before flow, the Shipment flow, the Submitted-to-Finance flow, AND Apex — **no single owner**.
**Fix:** consolidate triggers; define one status orchestrator; add a recursion guard.

### 11. `Lead company update` flow runs on every save
No entry criteria → updates `Company` on every Lead create AND update (overwriting real values,
amplifying recursion). **Fix:** add criteria (e.g. `Company` blank or `Lead_Name__c` changed).

### 12. `Lead test ride events` resets completed rides
On any Lead edit it bulk-updates ALL related Test Drives to `'Reschedule'` — including ones already
`Completed`/`Cancelled`. **Fix:** filter out terminal statuses before updating.

---

## 🟡 Conversion correctness

### 13. `LeadConvertController.convertLead` updates the account before checking success
It calls `Database.convertLead`, then queries/updates the Account to Type='Customer', and only
afterward checks `isSuccess()`. **Fix:** check success first.

### 14. `convertLeadUponStageChange` uses the wrong account
For the Opportunity-owner contact lookup it uses the **dealer's** account id (from pincode), not the
newly converted account. It also **cancels ALL the lead's Test Drives** on conversion. **Fix:** use
the converted account id; reconsider blanket cancellation.

### 15. Two divergent conversion paths
`LeadConvertController.convertLead` and `LeadTriggerHandler.convertLeadUponStageChange` convert with
different behavior (Opp stage/owner). **Fix:** consolidate to one conversion service.

---

## ⚪ Hygiene / production-safety

- **Hardcoded values:** queue names `Head_Quarter`/`Out_of_Business_Hours`/`Closed_Lost`, dealer code
  `'123456'`, business hours 8–20, Company `"Company Placeholder"` (from the Calendly managed flow),
  a **sandbox URL** baked into an Order email template, and `+91`/kookoo-id/`PHPSESSID` cookie in
  `QueueableOnOrderCreationAfterBooking`. Move to Custom Metadata / the `WhatsappIntegration__c`
  setting; the sandbox URL and stale cookie will break in production.
- **Stringly-typed feature flag:** the whole Lead `after insert` path (routing + dedupe) is gated by a
  text Custom Label `ApexClass == 'true'`. One edit silently disables routing AND dedupe.
- **Destructive dedupe:** `LeadDuplicationLogic` **deletes** a freshly created lead when a 90-day phone
  match exists (this is why recreating a lead on the same number vanished). Prefer flag-and-review.
- **Silent `try/catch`** that only `System.debug`s across most handlers — failures are invisible.
- **Dead code:** large commented blocks and `mytest()` (~600 lines of `i++`) padding coverage.
- **Calendly managed flow** injects leads with `Company="Company Placeholder"`, `LeadSource="Calendly"`
  (not in routing allow-lists), owner = an admin — these bypass dealer routing. Can't be edited
  (managed); handle via config.

---

## Suggested correction order
1. The 5 confirmed bugs (§1–5) — small, safe, high impact.
2. Completed-test-drive automation (§6) — the key lifecycle gap.
3. De-duplicate the conflicting automation (§8–12) — biggest stability win, but higher risk; do with
   testing.
4. Conversion fixes (§13–15) and hygiene (hardcoded values, dedupe, error handling).

*Bugs #1, #3, #4, #5 and §13–15 are in pre-existing org code (not built in this project) — correcting
them changes live business behaviour, so each should be confirmed and tested before deploy.*
