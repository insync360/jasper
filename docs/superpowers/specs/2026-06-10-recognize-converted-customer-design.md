# Design: Recognize converted customers (don't re-greet off orphaned converted leads)

**Date:** 2026-06-10
**Component:** `river-mobility-wa-bot` (Heroku) + `WhatsApp_Conversation__c` schema
**Status:** Approved design — pending spec review

## Problem

A WhatsApp message from **9494548054** got "welcome back ganesh" and **no new Lead was
created**, even though the customer records were deleted from Salesforce.

### Root cause (verified against the live `rrdev` org)

- A Lead "Ganesh" / 9494548054 still exists: `Status = Test Ride`, **`IsConverted = true`**,
  created manually by Sandeep Singh, converted 2026-06-10.
- Its converted **Account, Contact, and Opportunity are all deleted** (0 records). Salesforce
  does **not** cascade-delete a converted Lead when you delete the resulting Account/Contact/
  Opportunity — the Lead survives as an **orphan** with dangling `ConvertedXxxId` pointers.
- The bot's `findLeadByPhone` matches **any** Lead with that phone — including this orphaned
  converted one — so it greeted by name and skipped onboarding.
- Of the 10 converted leads in the org, **8 still have surviving Contacts**; **2 are orphans**
  (both "Ganesh": 9494548054 and 8460548054).

Converted leads are also hidden from the standard Leads list views, which is why the record
looked "deleted" in the UI.

## Goals

1. Stop recognizing **converted** leads as open enquiries.
2. **Recognize returning customers** (whose Contact survives) and greet them as customers,
   attaching their activity to the **Account/Contact**, not a duplicate Lead.
3. Orphaned converted leads (no surviving Contact) → treat as new → onboard a fresh Lead.

## Design

### Identity resolution (webhook.js) — 3-way

| Order | Lookup | Path |
|---|---|---|
| 1 | Open Lead (`IsConverted = false`) by phone | **Lead path** — unchanged |
| 2 | else **Contact** by phone | **Customer path** — NEW |
| 3 | else | **Onboarding** — create new Lead |

Key principle: **never use a converted lead's dangling pointers.** The customer is matched by
**Contact phone** directly. The 2 orphaned Ganesh numbers match neither step 1 nor step 2 →
they onboard fresh.

### Party context abstraction

Replace the ad-hoc `lead` object passed through routing with a normalized `party`:

```js
// kind: 'lead'
{ kind:'lead', leadId, name, firstName, status, source, buyingSpan, raw }
// kind: 'customer'
{ kind:'customer', contactId, accountId, name, firstName, raw }
```

`ctx = { from, party, firstName, profileName }`. `flow.js` / `testride.js` read `ctx.party`.

### Customer-path behavior

- **Greeting:** "Welcome back, {firstName}!" + main menu.
- **Browse / pricing / free-text AI:** unchanged (no SF writes).
- **Tasks** (advisor / referral / escalation): already attach to the Contact via
  `findLinksByPhone` (Contact preferred over Lead) — **no change**.
- **Transcript** (`WhatsApp_Conversation__c`): add a **`Contact__c`** lookup field; for the
  customer path set `Contact__c` (and leave `Lead__c` null). Lead path unchanged (`Lead__c`).
- **Test drive:** `Test_Drive__c` links only to Lead/Opportunity. For a customer, **create a
  new Opportunity** under their Account (`AccountId`, `StageName` = an early stage,
  `CloseDate` = +30d, Name = "{customer} – {vehicle}") and link `Test_Drive__c.Opportunity__c`
  to it. No lead-status write.

### Service-layer changes (`salesforce.js`)

- `findLeadByPhone`: add `AND IsConverted = false`.
- New `findCustomerByPhone(phone)` → `{ contactId, accountId, name, firstName }` (most recent
  Contact matching last-10 on `Phone`/`MobilePhone`).
- `saveConversation`: accept `contactId`; set `Contact__c` when present.
- New `createCustomerTestDrive({ accountId, contactId, customerName, ...d })`: create
  Opportunity, then `Test_Drive__c` linked to it. Used by the customer path; existing
  `bookTestDrive`/`createTestDrive` (Lead path) unchanged.

### Schema change

Add `Contact__c` (Lookup → Contact) to `WhatsApp_Conversation__c`. Deploy to `rrdev`.

### Data cleanup

Delete the 2 orphaned converted leads: `00QC300000IYvW9MAL` (9494548054) and
`00QC300000IYtCbMAL` (8460548054).

## Considerations / risks

- **Opportunity creation may hit org validation rules / required fields.** Wrap best-effort;
  if Opportunity create fails, fall back to logging a "test drive requested" Task on the
  Contact so the request is never lost.
- **`OpportunityWhatsAppTrigger` fires on insert** → sends `jasper_opportunity_greeting`. A
  returning customer booking a test drive would receive that greeting. Acceptable (it's a real
  new deal); note for QA.
- **Two leads per phone** after an orphan onboards fresh: the old converted orphan + the new
  open lead. `findLeadByPhone` (now `IsConverted=false`) returns the new one. The 2 known
  orphans are deleted as cleanup; future orphans are harmless.

## Deployment

- Repo source of truth = GitHub `insync360/jasper` → `river-mobility-wa-bot/`, which matches
  deployed release **v39** (`f3c521a`).
- Deploy to Heroku app `river-mobility-wa-bot`; commit to GitHub.

## Out of scope

- Migrating historical converted-lead transcripts.
- A dedicated "customer" menu distinct from the lead menu (same menu, different greeting).
- Service/booking flows beyond test drive for the customer path (demo-simulated as today).
