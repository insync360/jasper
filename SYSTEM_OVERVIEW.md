# Jasper Industries — WhatsApp + AI Bot: System Overview & Demo Guide

> **What this is:** An AI-powered WhatsApp assistant for **Jasper Industries** (an authorized Tata
> vehicle dealer since 1955) that automates the customer lifecycle — Enquiry → Booking → Delivery —
> on top of a Salesforce **Automotive Cloud** org. This document explains the architecture, the exact
> message flow, the live vehicle catalog, the lifecycle messaging, the data model, the
> cost-optimization design, and a step-by-step demo script.
>
> *Note: the demo runs on the `rrdev` Salesforce sandbox for the CRM backend. The bot's catalog is
> read live from the org's `Vehicle` records (currently Tata Harrier, Curvv, Nexon, Tiago) and is
> fully editable in Salesforce — Heroku is middleware only.*

**Status:** Live (WhatsApp ⇄ Claude ⇄ Salesforce). All buildable requirements across **Enquiries
(12/14), Bookings (11/13), Delivery (5/7)** are built & deployed; the rest are skipped by choice or
not feasible on the WhatsApp Cloud API. A few newly-edited templates may be pending Meta re-approval
(they go live automatically on approval). Remaining for go-live: production WhatsApp number + permanent
token.

---

## 1. The big picture

```
                         ┌───────────────────────────────────────────────┐
   Customer's WhatsApp   │              META WHATSAPP CLOUD API           │
   (+91 76187 18924)  ◄──┤   business number "util jewels"  (GREEN tier)  │
                         └───────────────┬───────────────▲───────────────┘
                          inbound msg     │               │  outbound msg
                          (webhook POST)  ▼               │  (send API)
                         ┌───────────────────────────────────────────────┐
                         │        HEROKU BACKEND  (Node.js + Express)      │
                         │            river-mobility-wa-bot                │
                         │                                                 │
                         │   /webhook   inbound router  ───────┐          │
                         │   /send/*    outbound endpoints     │          │
                         │                                     ▼          │
                         │   ┌─────────┐  ┌──────────┐  ┌────────────┐    │
                         │   │ intent  │  │   menu   │  │   ai.js    │    │
                         │   │ (rules) │  │ (canned) │  │  (Claude)  │    │
                         │   └─────────┘  └──────────┘  └─────┬──────┘    │
                         │                                    │           │
                         │   ┌────────────────────────────────────────┐  │
                         │   │  salesforce.js  (jsforce, refresh-token)│  │
                         │   └───────────────────┬────────────────────┘  │
                         └───────────────────────┼───────────────────────┘
                                                 │ read/write
                                                 ▼
                         ┌───────────────────────────────────────────────┐
                         │        SALESFORCE  (rrdev sandbox CRM)          │
                         │   Lead · Test_Drive__c · Task (activity log)    │
                         │   Order (booking) · Feedback__c · Assignment    │
                         └───────────────────────────────────────────────┘
                                                 ▲
                                                 │ generates replies
                         ┌───────────────────────────────────────────────┐
                         │     ANTHROPIC CLAUDE  (claude-sonnet-4-6)       │
                         │  used ONLY for open-ended questions (cost saver) │
                         └───────────────────────────────────────────────┘
```

**Three external services, one backend:**
1. **Meta WhatsApp Cloud API** — sends/receives WhatsApp messages.
2. **Heroku backend** — the brain: routes messages, talks to Salesforce + Claude.
3. **Salesforce** — the system of record (leads, test drives, bookings, activity).
4. **Claude (Anthropic)** — AI for free-form replies, only when needed.

---

## 2. Key facts / credentials (demo environment)

| Item | Value |
|---|---|
| **WhatsApp number** | +91 76187 18924 (display name "util jewels") |
| **Phone Number ID** | `1108168065719952` |
| **WABA ID** | `1239087798139137` |
| **Meta App ID** | `2180934496034409` |
| **Heroku app** | `river-mobility-wa-bot` |
| **Live URL** | https://river-mobility-wa-bot-5fd60f48abad.herokuapp.com/ |
| **Webhook callback** | `https://river-mobility-wa-bot-5fd60f48abad.herokuapp.com/webhook` |
| **Salesforce org** | `rivermobilityprivatelimited2--rrdev` (sandbox, CLI alias `mysandbox`) |
| **LLM model** | `claude-sonnet-4-6` |

> ⚠️ This is a **demo setup**: the WhatsApp number is under a util-labs business portfolio (not
> Jasper's own), and the access token is non-permanent. For production, the client would use
> their own verified number + a permanent token.

---

## 3. The WhatsApp messaging rule (critical to understand)

WhatsApp Cloud API has **two modes**, decided by *who messaged last*:

| Situation | What you can send |
|---|---|
| **Customer messaged within last 24h** (service window OPEN) | Anything — free text, buttons, lists, AI replies. **No template needed.** |
| **Business messages first / 24h passed** (window CLOSED) | **Only pre-approved templates** (Marketing/Utility/Authentication). |

- **Inbound conversations** (customer says "hi") → we reply freely (menus, Claude, etc.).
- **Outbound campaigns** (the 7,000 leads, price alerts, greetings) → must be **approved templates**.
- A template the customer replies to **re-opens** the 24h free-form window.

---

## 4. The conversation flow (step by step)

When a customer sends a WhatsApp message, here's exactly what happens inside `/webhook`:

```
1. Meta POSTs the message to /webhook
2. Verify X-Hub-Signature-256 (HMAC with app secret)  → reject if invalid
3. Respond 200 immediately (so Meta doesn't retry), then process async
4. Parse the message:
      • plain text                → { kind: 'text', text }
      • tapped a list/button      → { kind: 'reply', id, text }
5. Capture the WhatsApp PROFILE NAME (contacts[0].profile.name)
6. Mark the message as read (blue ticks)
7. Salesforce lookup: findLeadByPhone(last 10 digits)
      • found      → personalize using the Lead, continue to routing
      • not found  → ONBOARDING (see below): ask for pincode, then create the Lead
8. Record the inbound turn in conversation memory
9. ROUTE the message (see decision tree below); outbound messages are auto-recorded to memory
10. Flush the full transcript (every turn, verbatim) to the Lead's timeline as Tasks
```

### Onboarding new numbers (pincode → name → DOB)

The org enforces a **valid pincode on Lead insert**, so a brand-new WhatsApp number is onboarded
conversationally before a Lead is created. The intake is a short **stateful** flow (held in memory
under `{flow:'onboard', step}`) — "no Lead yet = still onboarding":

```
Unknown number messages
   │
   ▼
1) Ask 6-digit PINCODE  ──(mandatory; re-ask until valid)──►
2) Ask NAME             ──[Skip]──► falls back to WhatsApp profile name
3) Ask BIRTHDAY (DOB)   ──[Skip]──► DD/MM/YYYY parsed → Lead.Birth_Date__c
   │
   ▼
Create Lead (name, PostalCode = pincode, Birth_Date__c = DOB if given) → show main menu
→ from now on the number is a known Lead
```

The captured **DOB drives automated birthday greetings** (see *Important-day greetings* below).
Name and DOB each have a **Skip** button, so the customer can breeze through with just the pincode.

### The routing decision tree (this is the cost-optimization core)

The design deliberately avoids keyword/text-similarity guessing (it misfires and ruins UX).
**Structured navigation is 100% tap-driven; the LLM handles only free-typed text.**

```
                  ┌─────────────────────────────┐
                  │   Inbound WhatsApp message   │
                  └──────────────┬──────────────┘
                                 ▼
                  Did they TAP a button / list option?
                       │yes                       │no
                       ▼                          ▼
              Flow node (predefined)      Is it a greeting? (hi/hello/menu)
                  (NO LLM)                     │yes              │no
                                               ▼                 ▼
                                        Main menu          FREE-TYPED TEXT
                                        (NO LLM)                 ▼
                                                           CLAUDE  (LLM ✅)
                                                           + "🏠 Main Menu" button
                                                             to resume the flow
```

**Result:** the entire guided journey (greeting + every tap) costs **zero LLM tokens**. Claude is
invoked **only** when the customer types something free-form. Logs print `free text -> LLM` for the
LLM path and `node:<name>` summaries for the tap-driven path, so you can watch the split live.

---

## 5. The complete guided journey (tap-driven, walk-in → delivery, NO LLM)

On "hi", the bot sends a **canned welcome** (named if a Lead exists, else generic) + a tap-to-open
**list menu**. From there, the customer can complete the *entire* lifecycle by tapping — enquiry,
test ride, booking, payment, allocation, delivery slot, and feedback — without a single LLM call.
Every node has a **🏠 Main Menu** button so no one gets stuck.

```
"hi" ─► MAIN MENU (list)
         │
         ├─ 🚛 Browse Vehicles ──► CATALOG list (read LIVE from the SF Vehicle object;
         │        │                 e.g. Tata Harrier, Curvv, Nexon, Tiago)
         │        └─ tap a vehicle ──► 📷 IMAGE + name + description + price + brochure
         │                            + [🛠️ Test Drive][🛒 Book Now][🚛 Browse]
         │
         ├─ 💰 Pricing & Offers ──► price range + EMI + [🚛 Browse][🛠️ Test Drive][🧑‍💼 Advisor]
         │
         ├─ 🛠️ Book a Test Drive ──► multi-step booking (collects real details):
         │        1) choose vehicle (list)
         │        2) At My Site → WhatsApp *location share*  |  At Showroom
         │        3) pick date [Today][Tomorrow][This Weekend]
         │        4) enter Driving Licence no. (or Skip)
         │        5) Confirm → creates detailed Test_Drive__c, Lead: New → Test Ride
         │           (vehicle, ride type, date, DL, location + map link)
         │
         ├─ 🛒 Book Now ──► booking amount ₹25,000 + [✅ Pay & Reserve][🧑‍💼 Advisor][🏠 Menu]
         │        └─ ✅ Pay & Reserve ──► 🎉 Booking confirmed, Lead: → Ready For booking, EDD 2–3 wks
         │                                + [📦 Track Status][🏠 Menu]
         │
         ├─ 📦 Booking / Delivery ──► journey progress (Booked ✅ → Allocation 🔄 → …)
         │        └─ 🚚 Delivery Slot ──► [🌅 Morning][🌇 Evening]
         │                └─► 🚚 Delivery scheduled + [⭐ Give Feedback][🏠 Menu]
         │                        └─ ⭐ Feedback ──► [😀 Great][😐 Okay][☹️ Not good]
         │                                ├ 😀 → thank you + referral ask
         │                                ├ 😐 → offer advisor
         │                                └ ☹️ → escalate to customer care
         │
         └─ 🧑‍💼 Talk to an Advisor ──► "an advisor will reach out"
```

### The vehicle catalog — read LIVE from Salesforce

Tapping **🚛 Browse Vehicles** opens an interactive list of vehicles read **live from the Salesforce
`Vehicle` object** (Automotive Cloud). The dealership edits vehicles **in Salesforce** — the bot
(Heroku) is just middleware that queries them (cached 5 min). Tapping a vehicle sends its
**image + description + price + "📄 View Brochure" button**, then action buttons.

**Editable in SF (`Vehicle` object fields):**
- `Show_In_Bot__c` (checkbox) — controls whether it appears in the bot
- `Image_URL__c` — catalog image · `MarketPrice` — price (₹, auto-formatted)
- `Bot_Description__c` — marketing blurb · `Brochure_URL__c` — brochure PDF link
- `Bot_Sort_Order__c` — display order

`src/services/catalog.js` queries:
`SELECT Id, Name, Image_URL__c, Brochure_URL__c, Bot_Description__c, MarketPrice FROM Vehicle WHERE Show_In_Bot__c = true ORDER BY Bot_Sort_Order__c`.
Current vehicles (the org's real data): **Tata Harrier, Curvv, Nexon, Tiago** — seeded with prices,
images, and official Tata brochure PDFs. Add/edit a vehicle in SF → it appears in the bot within
~5 min (the catalog cache TTL). *(The jsforce connection uses API v62 — Automotive Cloud's `Vehicle`
needs a recent version.)* The backend `POST /catalog/refresh` endpoint still exists for an
immediate cache clear if needed.

> **Why not a native Meta product catalog?** Meta Commerce policy generally **prohibits listing
> motor vehicles** as catalog products, and the token lacks `catalog_management` scope. The
> SF-driven, image+button catalog delivers the same rich UX, is policy-safe, and keeps the data
> editable by the dealership in Salesforce.

### Salesforce effects along the journey

| Tap | Bot response | Salesforce effect |
|---|---|---|
| 🛠️ Test Drive (multi-step) | Collects vehicle, location (WhatsApp share), date, DL | **Creates detailed `Test_Drive__c`** (Vehicle_Model, Ride_Type, Test_Drive_Date, DL, Address + geo + map URL) + Lead **New → Test Ride** |
| 🛒 ✅ Pay & Reserve | "🎉 Booking confirmed" + EDD | Lead **→ Ready For booking** *(demo: payment & Order simulated)* |
| 🚚 Morning/Evening slot | "Delivery scheduled" | Logs slot to Lead activity |
| ⭐ ☹️ Not good | "Connecting to customer care" | (future: Case/escalation) |
| every step | — | inbound + outbound logged as **Tasks** on the Lead |

> Demo note: payment, Order creation, and live allocation/delivery status are **simulated**
> conversationally for now (the org's Order pipeline has many required fields/validations). The
> tap flow models the real journey; wiring the actual Order + payment gateway is a later step.

---

## 6. Salesforce integration (data model + writes)

### Objects used (all pre-existing in the org — nothing new was built)

| Object | Role in the bot |
|---|---|
| **Lead** | The enquiry. Matched by phone (last 10 digits). Holds name, status, source, birthday/anniversary. |
| **Test_Drive__c** | Created when a customer books a ride via the bot (`Lead__c`, `Ride_Type__c` HTR/STR, status). |
| **Task** | Every inbound + outbound message logged on the Lead's activity timeline. |
| **Order** (standard) | The **booking** entity (185 fields: allocation, payment, delivery, cancellation). *Delivery is a stage of Order.* |
| **Feedback__c / Questionnaire__c** | Survey suite (for delivery/payment feedback — future stage). |
| **Assignment_Group__c** | Lead routing to ASMs (future stage). |
| **WhatsApp_Conversation__c** *(new, custom)* | Consolidated transcript of each chat session — fields: Lead, Contact_Number, Transcript (long text), Message_Count, Last_Activity. Upserted live as the conversation progresses. |

### Lead funnel status (respected by the bot)

```
New  →  RNR  →  Test Ride  →  Follow Up  →  Ready For booking  →  Converted / Close lost / Junk
 ▲                  ▲
 │                  └── bot sets this automatically when a test ride is booked
 └── new WhatsApp leads start here
```

The bot **never** skips a lead ahead artificially — status reflects real events only.

### How the bot authenticates to Salesforce
- Uses **jsforce** with an **OAuth refresh token** (from the Salesforce CLI session), so the access
  token auto-refreshes — no password stored, durable.
- Phone matching: Lead.Phone stores 10-digit numbers; WhatsApp sends E.164 (`919182444249`) → we
  match on the **last 10 digits** (`9182444249`).

### Lead capture constraint (handled)
- The org has a Flow/trigger requiring a **valid pincode** on new Leads. The bot handles this via
  **onboarding**: unknown numbers are asked for their 6-digit pincode, then a Lead is created with
  the WhatsApp profile name + pincode. PostalCode alone satisfies the validation (City not required).

---

## 7. Codebase map

```
river-mobility-wa-bot/
├── Procfile                 web: node src/index.js
├── package.json             deps: express, axios, @anthropic-ai/sdk, jsforce, dotenv
├── .env.example             all config var names (no secrets)
└── src/
    ├── index.js             Express app, route mounting, health check
    ├── config.js            reads env vars (WhatsApp, Anthropic, Salesforce)
    ├── templates/            outbound WhatsApp template definitions (submitted to Meta)
    ├── routes/
    │   ├── webhook.js        ★ inbound: verify, parse, route (tap→flow / text→LLM), log
    │   ├── send.js           outbound: /send/template, /send/text  (Salesforce calls these)
    │   └── templates.js      template admin: create (incl. image) + list status (x-api-key)
    └── services/
        ├── whatsapp.js       Cloud API: sendText, sendTemplate, sendImage, sendButtons, sendList
        ├── ai.js             Claude: generateReply, classifyFeedback
        ├── salesforce.js     jsforce: findLeadByPhone, createLead, createTestDrive,
        │                              updateLeadStatus, logInteraction
        ├── flow.js           ★ the complete tap-driven journey (state machine, NO LLM)
        ├── testride.js       multi-step test-drive booking (vehicle/location/date/DL)
        ├── catalog.js        reads vehicles LIVE from the Salesforce Vehicle object (cached)
        ├── memory.js         per-conversation history + flow state (LLM memory + transcript)
        ├── templates.js      Meta template create + image resumable upload + list
        └── menu.js           canned welcome text + greeting detection
```

### Conversation memory & full transcript

- **Memory** (`memory.js`): an in-memory store keyed by phone holds the recent turns. Every inbound
  message and every outbound message (text/buttons/list/image/template) is recorded.
- **LLM memory**: free-text replies pass the recent turns to Claude, so it remembers the
  conversation (e.g. "what model did I just ask about?"). History is sanitized for the Anthropic
  API (merge consecutive same-role turns, start with user, end with user).
- **Full transcript**: after each message is handled, the conversation is saved to Salesforce two ways:
  1. each turn is logged **verbatim** to the Lead's activity timeline as Tasks, and
  2. the whole session is upserted into a **`WhatsApp_Conversation__c`** record (one record per chat,
     with the complete transcript, message count, and last-activity) — for easy future reference.
- *Durability:* memory is in-process (resets if the Eco dyno sleeps after ~30 min idle); the
  permanent record lives in Salesforce.

### Outbound message templates (Meta-approved)

Business-initiated messages (first touch / outside the 24h window) must use **approved templates**.
Definitions live in `templates/*.json` and are submitted to Meta via the Graph API. Current templates:

| Template | Category | Purpose | Status |
|---|---|---|---|
| `jasper_promo_offer` | MARKETING | Promotional offer blast (name var + Know More / Test Drive buttons) | submitted for approval |
| `jasper_lead_welcome` | MARKETING | Welcome a new lead (name var + Browse / Advisor buttons) | submitted for approval |

When a customer replies to / taps a template button, the 24h window opens and the bot's guided flow
takes over. These power the outbound side (e.g. the 7,000 leads/month, price alerts, campaigns).

### Automated lifecycle messages (Salesforce trigger)

Two events fire WhatsApp templates **automatically**, with no staff action:

| Event | Trigger condition | Template sent |
|---|---|---|
| **Booking created** (lead → booking) | `Order` inserted with a phone | `jasper_booking_confirmed` |
| **Booking → Delivery** | `Order.Status` changes to a *Delivery* stage | `jasper_delivery_ready` |

`OrderWhatsAppTrigger` (after insert/update) detects the event and calls `WALifecycleMessenger`,
which enqueues a **Queueable callout** (async, so it's allowed from a trigger) to the backend
`POST /send/template`. Messages are **personalized with order details** — `{{1}}` name, `{{2}}`
vehicle (from the Order's product), `{{3}}` order number, `{{4}}` amount — via the `WAVars`
template→field mapping. The two template names are configurable in the `WA_Bot_Setting__c` custom
setting (`Booking_Welcome_Template__c`, `Delivery_Greeting_Template__c`).

### Outbound campaign apps (Salesforce, 3 lifecycle stages)

Three Salesforce tabs let staff **send approved templates to recipients**, one per lifecycle stage:

| App (tab) | Recipients (source) |
|---|---|
| **Enquiry Campaign** | Leads (with a phone) |
| **Booking Campaign** | Orders with a phone (booking customers) |
| **Delivery Campaign** | Orders with a delivery date |

Each app: pick an **approved template** (shows a WhatsApp preview), see the recipient list, **tick who
to send to**, then **Send**. Apex `WACampaignController` loops the selected recipients and calls the
backend `POST /send/template` (auto-fills the `{{1}}` name variable, normalizes 10-digit numbers to
E.164). Returns a sent/failed summary. Components: shared LWC `waCampaign` (+ stage wrappers
`waCampaignEnquiry/Booking/Delivery`), tabs **Enquiry/Booking/Delivery Campaign**, Apex
`WACampaignController`. Selection is capped at 90/send to stay within callout limits.
For **image-header templates**, the preview renders the image and it is sent as a header parameter
(Meta requires the image at send time, not just at approval). The recipient table shows
**Vehicle / Order # / Amount** columns for Booking & Delivery so messages are relatable; body
variables are filled per-template via the `WAVars` mapping (name, vehicle, order #, amount).

### Booking-flow lifecycle messages (Opportunity + Order, configurable)

The booking flow runs on **Opportunity** (the deal) and **Order** (the booking). Sales advances
stages **manually**; the bot sends the mapped WhatsApp template at each milestone. Mapping is
editable in SF.

| Object / Stage | Template | Message |
|---|---|---|
| **Opportunity created** | `jasper_opportunity_greeting` | thanks for showing booking interest + next steps |
| **Opportunity → Closed Lost** | `jasper_lead_lost` | acknowledges the loss, invites another chance |
| **Order created** (booking confirmed / payment done) | `jasper_booking_confirmed` | booking confirmed: **model, variant, colour, order #, amount, EDD** |
| **Vehicle allocated** (`Assigned_Vehicle__c` set) | `jasper_allocation_alert` | vehicle allocated + EDD (Bookings #5) |
| **Order → Order Cancelled** | `jasper_cancellation_survey` | AI cancellation survey: reason buttons + AI-classified free text → `Reason_for_Cancellation__c` (Bookings #10) |
| **Order → Ready For Delivery** | `jasper_delivery_ready` | ready for delivery + a **"Confirm Delivery"** button (customer taps after receiving → records on Order; Bookings #7) |
| **Order → Vehicle Delivered** | `jasper_delivered_congrats` | 🎉 congratulations + a **"Share Feedback" survey-link button** |

- Config lives in **`WA_Stage_Message__c`** (Object, Status Value, Template, Active) — `Status_Value`
  is the stage, or `Created` for insert events. Add/edit a row per milestone. Use the **"All Stage
  Rules"** list view (inline-editable columns) or open a rule — the record page exposes all four
  config fields, so admins can change templates / toggle rules without code.
- `OpportunityWhatsAppTrigger` (insert → greeting, update→Closed Lost → lost) and
  `OrderWhatsAppTrigger` (insert → booking confirmed, status → ready/delivered) call
  **`WAStageMessenger`**, which resolves the recipient phone per object (Opportunity → primary
  Contact; Order → `Phone__c`) and sends via the backend (queued callout), filling variables
  (name, vehicle, order #, amount, lost reason) via `WAVars`. Verified end-to-end.
- **Post-delivery survey link:** the delivered message carries a dynamic **URL button** to the org's
  feedback form (`FeedbackForm` site → `PrePurchaseExperience?id={{1}}`). `WAStageMessenger` resolves
  the customer's Lead by phone and passes its id as the button parameter (via `WAVars.urlButtonComponent` /
  `BUTTON_URL_VARS`), so each customer gets a feedback link tied to their record.
- *(Conversion stays manual — no auto-convert. Lead-status messaging was removed in favour of this.)*

**Messaging integrity (no duplicates, no data copy):**
- All sends **query the live SF objects** (Lead/Opportunity/Order/Account/Vehicle) at send time — nothing
  is copied into a parallel store; AI results are written back onto the **same** record.
- **Lifecycle/important messages don't duplicate:** each milestone is a single `Object|Status` config →
  one template; the milestones are distinct (greeting ≠ booking ≠ ready ≠ delivered).
- **Promo de-dup:** the **Enquiry** recipient list excludes **converted leads** (`IsConverted=false`),
  so a customer who became an Order no longer also appears as a Lead; and campaign/Vehicle-Promo sends
  **de-dupe by phone** within a run. The greeting scheduler also de-dupes by phone (Lead vs Contact).
- All these are normal **editable templates** in the Template Builder (edit + re-submit for approval),
  and the **Template Builder table is the approved-template history** (shows every template + status).
- Everything is bundled in the **"Jasper WhatsApp"** Lightning app (App Launcher): Template Builder,
  Stage Messages, the 3 Campaign tabs, and Lost-Case Analysis.

### Important-day greetings (scheduled — birthdays & anniversaries)

Captured customer dates (DOB from onboarding, plus `Birth_Date__c` / `Anniversary_Date__c` on Leads
and `Birthdate` on Contacts) drive **automatic greetings on the day**.

- **`WAGreetingScheduler`** (Apex `Schedulable`) runs **daily at 9 AM** (`System.schedule('WA Daily
  Greetings', '0 0 9 * * ?', …)`). It finds everyone whose birthday/anniversary is **today**
  (`CALENDAR_MONTH` + `DAY_IN_MONTH` match), then enqueues a callout `Queueable` that sends the
  approved template via the backend `/send/template` — same pipeline as the lifecycle messages.
- Templates: **`jasper_birthday_greeting`** (approved) and `jasper_anniversary_greeting`, with `{{1}}`
  = first name filled via `WAVars`. The template name is **editable** in the Stage Messages app
  (`WA_Stage_Message__c` rows `Lead | Birthday` and `Lead | Anniversary`); defaults are used if unset.
- *WhatsApp constraint:* proactive greetings must be **approved templates** — AI personalises the
  variable (name), but the body is the approved copy. (True free-form AI text only works inside the
  24-hour service window.) This satisfies Enquiries requirements **#13 (capture dates)** and
  **#14 (greetings on important days)**.

### AI lost-case analysis (Salesforce app, per-case)

Analyses each lost lead **individually**. In the **Jasper WhatsApp** app → **Lost-Case Analysis** tab,
every lost lead (`Status = 'Close lost'`) is listed as a card with an **Analyse Now** button. Clicking
it analyses that one case in place; the result is **kept** (saved on the lead) so it persists.

- **`WALostCaseController.getLostCases()`** lists the lost leads with any previously-saved analysis.
- **`WALostCaseController.analyzeCase(leadId)`** gathers that lead's data (reason, free-text note,
  source, buying-span, city, age), POSTs to the backend `POST /analyze/lost-case` (x-api-key), then
  **saves** the result to `Lead.AI_Lost_Analysis__c` (+ `AI_Lost_Analysis_Date__c`).
- The backend (`ai.analyzeLostCase`) runs the **Haiku** model only and returns per-case JSON:
  **verdict, recoverability (High/Med/Low), key factors, win-back action, and a suggested WhatsApp
  re-engagement message**. The **`waLostCaseAnalysis`** LWC renders it inline (recoverability badge,
  factors, win-back, suggested message, "Analysed <date>").
- Re-running a case overwrites the saved analysis (button shows **Re-analyse**).
- Serves Enquiries requirement **#11 (AI lost-case analysis)** and feeds **#12 (reduce/arrest lost
  cases)** via the per-case win-back action + ready-to-send message.

### AI lead segregation (Salesforce app, on-demand)

In the **Jasper WhatsApp** app → **Lead Segregation** tab. **Select** the enquiry customers you want
(searchable checkbox list with select-all; up to 50/run) → **Segregate** → AI buckets each into
**Hot / Warm / Cold** from their **responses** (conversation transcript) and signals (status,
buying-span, source). Results show counts + a per-customer table, and the segment is **saved on the
lead** (also shown as a badge next to already-segregated customers in the list).

- **`WALeadSegmentController.getCandidates()`** lists active leads (excludes Converted / Junk /
  Close lost); **`segregateSelected(leadIdsJson)`** processes the chosen leads — pulls each lead's
  `WhatsApp_Conversation__c.Transcript__c`, POSTs to the backend `POST /analyze/segregate`, then saves
  **`Lead.Lead_Segment__c`** (Hot/Warm/Cold) + **`Lead_Segment_Detail__c`** (interest/why).
- The backend (`ai.segregateLeads`) runs **Haiku** and classifies the whole batch in one call
  (bounded output, fits Heroku's 30s limit).
- **`waLeadSegregation`** LWC: count picker, Segregate button, Hot/Warm/Cold tiles + results table.
- Serves Enquiries requirement **#3 (segregate leads by responses)**. Because the segment lands on the
  lead, you can then filter/report/target by it (e.g., feed Hot into Vehicle Promos).

### Payment reminders (Salesforce app, manual button)

In the **Jasper WhatsApp** app → **Payment Reminders** tab. Lists orders awaiting payment
(`Payment_Status__c = Pending` or a remaining balance) with customer, order #, vehicle, **remaining ₹**
and status. Each row has a **Send Reminder** button → sends `jasper_payment_alert` to that customer
on click (never automatic). Built deliberately as a button per your request.

- **`WAPaymentController.getPendingPaymentOrders()`** lists the orders;
  **`sendPaymentReminder(orderId)`** sends the reminder (remaining amount + vehicle + order #).
- **`waPaymentReminders`** LWC: searchable table with a per-row Send button (shows "Sent ✓" after).
- Serves Bookings requirement **#8** (manual, not automatic).

### Vehicle Promos — price alerts & platinum spotlight (Salesforce app)

In the **Jasper WhatsApp** app → **Vehicle Promos** tab. Choose an **approved template** (dropdown of
all approved templates; defaults to `jasper_price_alert`), optionally tick **"Platinum stock only"**,
choose a **vehicle** (its live price from the catalog fills the template automatically), then
filter/search/select recipient leads and **Send**.

- **`WACampaignController.getCatalogVehicles(platinumOnly)`** lists vehicles (name, price, image,
  platinum flag); "Platinum stock only" filters to vehicles flagged **`Vehicle.Platinum__c`**.
- Templates are loaded via `getApprovedTemplates`; the chosen template should use the
  `{{1}}=name, {{2}}=vehicle, {{3}}=price` variables (mapped in `WAVars`) for the price to fill in.
- **"🔥 Hot prospects only"** toggle filters recipients to **hot leads** — `getRecipients` flags a lead
  hot when it is *active* (not Close lost / Converted / Junk) **and** (status ∈ Ready For booking /
  Test Ride / Follow Up, **or** Buying_Span ∈ Within 7/15 Days, **or** it has a `Test_Drive__c`).
  Hot rows show a 🔥; this lets you push platinum stock specifically to hot prospects (req #8).
- **`WACampaignController.sendVehiclePromo(template, lang, vehicleId, recipients)`** sends
  `jasper_price_alert` / `jasper_platinum_spotlight` (body vars name + vehicle + price via `WAVars`)
  to each selected recipient through the backend `/send/template`.
- **`waVehiclePromo`** LWC: mode toggle, vehicle picker, searchable recipient list with select-all.
- Serves Enquiries requirements **#9 (regular price alerts)** and **#8 (platinum stock to prospects)**.

### Self-service template builder (Salesforce app)

Internal staff can create & submit new templates **without leaving Salesforce**, including an
**image header**:

```
Salesforce LWC "WA Template Builder"  (App Launcher → WA Template Builder)
      │  fill form: name, category, language, header (None/Text/Image + upload),
      │             body + {{1}} example, footer, quick-reply buttons
      ▼
Apex WATemplateController.submitTemplate()   (config from WA_Bot_Setting__c, secret not in source)
      ▼  callout (x-api-key)
Heroku POST /templates  →  (image → Meta resumable upload)  →  Meta message_templates
      ▼
WA_Template__c tracking record (Status, Meta id) + a "Refresh" button pulls live approval status
```

The builder also lists **all templates already in the WhatsApp account** (not just SF-created ones)
and renders a **WhatsApp-style preview** of each in its row — header (text/image), body (with the
{{1}} example filled in), footer, and quick-reply buttons as chips — alongside its approval status.

Salesforce components: object **`WA_Template__c`** (tracking), custom setting **`WA_Bot_Setting__c`**
(backend URL + API key, set at runtime), Apex **`WATemplateController`** (`submitTemplate`,
`listMetaTemplates`, `refreshStatuses`), LWC **`waTemplateBuilder`** (form + preview list), tab
**WA Template Builder**, permission set **WA Template Builder Access**, remote site setting for the
backend. Verified end-to-end (a template submitted from Apex reached Meta and was approved).

> Note: an earlier keyword-matching module (`intent.js`) was removed — text-similarity guessing
> was fragile. Structured navigation is now purely tap-driven; free text goes straight to the LLM.

### HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Health check |
| GET | `/webhook` | Meta verification handshake (returns `hub.challenge`) |
| POST | `/webhook` | Inbound messages (signature-verified) → routed |
| POST | `/send/template` | Outbound approved template (for Salesforce-triggered campaigns) |
| POST | `/send/text` | Outbound free-form text (inside 24h window) |
| POST | `/templates` | Create & submit a template (incl. image header upload) — x-api-key protected |
| GET | `/templates` | List templates + approval status — x-api-key protected |
| POST | `/catalog/refresh` | Clear catalog cache & reload vehicles from Salesforce now — x-api-key protected |

---

## 8. Cost optimization summary

| Message type | Example | LLM call? |
|---|---|---|
| Greeting | "hi", "hello", "menu" | ❌ No (canned welcome + menu) |
| Any tap | tapped "Pricing", "Book Now", "Pay & Reserve" | ❌ No (flow node) |
| Whole guided journey | enquiry → test ride → booking → delivery → feedback | ❌ No (all taps) |
| Free-typed question | "is it good for highway trips with 2 people?" | ✅ Yes (Claude) |

The complete structured journey is **tap-only → zero LLM tokens**. There is **no keyword
matching** on free text (it was removed as fragile) — anything typed goes straight to Claude. Each
LLM reply offers a **"🧑‍💼 Talk to our team"** button (a real human handoff, stored as a Task — the LLM
never promises phone calls or invents commands); typing **"menu"** returns to the no-LLM guided flow.

---

## 9. DEMO SCRIPT (run this live)

> Send all messages to **+91 76187 18924** from your phone.

**Demo 1 — Greeting + menu (no LLM)**
1. Send **"hi"**.
2. → Bot replies with a personalized welcome + the category list menu.
3. *Show the Heroku log:* `node:main` — no LLM used.

**Demo 2 — Browse the vehicle catalog (no LLM, live from Salesforce)**
1. Tap **🚛 Browse Vehicles** → the vehicle list opens (read live from the SF `Vehicle` object).
2. Tap e.g. **Tata Harrier** → bot sends the **image + description + price + 📄 View Brochure button**.
3. *Point out:* edit a vehicle in SF → it changes in the bot within ~5 min (catalog cache TTL).

**Demo 3 — Full tap-driven journey to delivery (no LLM)**
1. Tap **🛠️ Book a Test Drive** → choose a vehicle → **📍 At My Site** → *share your location* →
   pick a date → enter DL → **Confirm**
   → creates a detailed `Test_Drive__c` (vehicle, date, DL, location + map link), Lead → **Test Ride**.
2. Tap **🛒 Book Now → ✅ Pay & Reserve**
   → "🎉 Booking confirmed", Lead moves to **Ready For booking**, EDD shown.
3. Tap **📦 Track Status → 🚚 Delivery Slot → 🌅 Morning**
   → "🚚 Delivery scheduled".
4. Tap **⭐ Give Feedback → 😀 Great** → referral ask.
5. *Show the log:* a chain of `node:*` entries — **the entire journey, zero LLM tokens**.
6. *Open Salesforce:* the Lead has a Test_Drive__c, advanced status, and Task activity logged.

**Demo 4 — AI with conversation memory (LLM)**
1. Type **"is the Tata Harrier good for long highway trips?"** → Claude answers.
2. Then type **"what model did I just ask about?"** → Claude recalls *"the Tata Harrier"*.
3. *Show the log:* `free text -> LLM (with memory)`.
4. *Open Salesforce:* the Lead's timeline shows the **full transcript** (every message, verbatim).

**Demo 5 — Salesforce-grounded personalization**
1. (Ensure your number exists as a Lead with a name.)
2. Send **"hi"** → bot greets you by name; replies are aware of your funnel stage.
3. *Show the Lead's Activity timeline:* inbound + outbound Tasks logged.

**Demo 6 — Outbound campaigns (Salesforce app)**
1. App Launcher → **Enquiry Campaign**. Filter by status, pick an approved template (preview shows),
   tick recipients (or Select All) → **Send**.
2. → Recipients get the template; result shows "✅ Sent / ❌ Failed".
3. *Explain:* same for **Booking Campaign** and **Delivery Campaign** (filtered to those segments).

**Demo 7 — Booking-flow lifecycle messages (Opportunity + Order) — VERIFIED**
1. Set an **Opportunity → Closed Lost** → customer gets the `jasper_lead_lost` message.
2. Create an **Order** for the customer → `jasper_booking_confirmed` (booking confirmed).
3. Move the Order **→ Ready For Delivery** → `jasper_delivery_ready`.
4. Move it **→ Vehicle Delivered** → `jasper_delivered_congrats` 🎉.
   *(All four confirmed delivered live to a real number. Conversion stays manual — sales advances
   the stage; the bot sends the message.)*
   ⚠️ Orders use `Phone__c` = **formula on `Account.Phone`** — the Account must have a phone for the
   message to reach the customer.
5. The delivered message includes a **"Share Feedback" button** → opens the survey form (req #2).

**Demo 8 — AI Lost-Case Analysis (per-case)**
1. App Launcher → **Jasper WhatsApp** → **Lost-Case Analysis**.
2. Each lost lead is a card → tap **Analyse Now** → AI returns verdict, recoverability, win-back
   action + a suggested WhatsApp message (saved on the lead, so it persists).

**Demo 9 — Vehicle Promos (price alerts / platinum → hot prospects)**
1. **Jasper WhatsApp** → **Vehicle Promos**.
2. Choose a **Template** (e.g. Price Alert), tick **Platinum stock only**, pick a **vehicle** (live
   price auto-fills), tick **🔥 Hot prospects only**, select recipients → **Send**.
3. *Point out:* platinum stock pushed to hot prospects, with the vehicle's live price (req #8 & #9).

**Demo 10 — AI Lead Segregation (on-demand)**
1. **Jasper WhatsApp** → **Lead Segregation**.
2. **Select** the customers (search / select-all) → **Segregate selected** → Hot/Warm/Cold tiles + a per-customer table.
3. *Point out:* each lead now has a **Lead Segment** saved (filter/report on it; feed Hot into Vehicle Promos) (req #3).

---

## 10. Roadmap (what's next, by lifecycle stage)

### Enquiries — the 14 requirements (12 done · 2 skipped)

| # | Requirement | Status |
|---|---|---|
| 1 | Customized WhatsApp bot messages to leads | ✅ |
| 2 | Short survey link for feedback | ✅ delivered as a button on the post-delivery message |
| 3 | Segregate leads by customer responses | ✅ on-demand Lead Segregation app (Hot/Warm/Cold) |
| 4 | Reassign hot leads to ASM automatically | ⏭️ skipped |
| 5 | Test-drive appointments on auto mode | ✅ |
| 6 | Brochure & pricing via bot | ✅ |
| 7 | Automated periodic calling | ⏭️ skipped (needs a voice provider) |
| 8 | Highlight platinum stock to hot prospects | ✅ Vehicle Promos (Platinum filter + 🔥 Hot prospects) |
| 9 | Regular price alerts to prospects | ✅ Vehicle Promos (Price Alert) |
| 10 | Promotional campaigns with custom creatives | ✅ 3 Campaign apps + image templates |
| 11 | AI lost-case analysis | ✅ per-case Lost-Case Analysis app |
| 12 | Mechanism to reduce & arrest lost cases | ✅ Closed-Lost message + per-case win-back |
| 13 | Capture birthdays/anniversaries/dates | ✅ onboarding DOB capture |
| 14 | AI greetings on important days | ✅ daily `WAGreetingScheduler` |

### Enquiry (in progress)
- [x] WhatsApp ⇄ Claude ⇄ Salesforce foundation
- [x] Vehicle catalog read LIVE from Salesforce (Vehicle object) — editable in SF, Heroku is middleware
- [x] Booking-flow messages on Opportunity + Order (greeting / lost / booking confirmed / ready for delivery / delivered)
- [x] "Jasper WhatsApp" Lightning app bundling all WhatsApp admin tabs
- [x] Complete tap-driven guided flow (browse → test drive → booking → delivery → feedback), no LLM
- [x] LLM (Claude) for free-typed text only, with a "Talk to our team" human-handoff button (stored as Task)
- [x] Onboarding intake: pincode → name → DOB (name & DOB skippable) → Lead creation
- [x] Capture customer dates (DOB → Birth_Date__c) + auto birthday/anniversary greetings (daily scheduler) — req #13 & #14
- [x] Full transcript logging (verbatim) + LLM conversation memory
- [x] Consolidated transcript saved per conversation (WhatsApp_Conversation__c)
- [x] Outbound templates created + submitted for approval (promo + lead welcome)
- [x] Self-service template builder in Salesforce (LWC, image header, status tracking)
- [x] Template list shows all account templates + a WhatsApp-style preview per row
- [x] Real test-drive booking (vehicle, WhatsApp location share, date, DL) → detailed Test_Drive__c
- [x] 3 outbound campaign apps (Enquiry/Booking/Delivery) — pick template, select recipients, send
- [x] Automated lifecycle messages: booking-created → welcome, booking→delivery → greeting (Order trigger)
- [x] Personalized messages with order details (vehicle, order #, amount) via WAVars mapping — campaigns + lifecycle
- [ ] Outbound: new Lead in SF → WhatsApp welcome template (the 7,000/mo)
- [~] Hot-lead → ASM auto-routing (Assignment_Group__c) — *skipped per request*
- [x] AI lost-case analysis (per-case) — Analyse Now per lost lead: verdict, recoverability, win-back action + suggested message; saved on the lead (req #11)
- [x] Birthday/anniversary AI greetings (daily `WAGreetingScheduler`) — req #14
- [x] Price alerts + Platinum-stock spotlight — **Vehicle Promos** app (template dropdown → vehicle → live price → 🔥 Hot-prospects filter → send) — req #9 & #8
- [x] Post-delivery survey link (Share Feedback button on the delivered message) — req #2
- [x] Segregate leads by customer responses — **Lead Segregation** app (on-demand, select customers → Hot/Warm/Cold, saved on lead) — req #3

### Bookings — the 13 requirements (~600/mo)

| # | Requirement | Status |
|---|---|---|
| 1 | Customized welcome message for all bookings | ✅ Order-created booking-confirmed message |
| 2 | Capture birthdays/anniversaries/dates | ✅ shared (onboarding DOB) |
| 3 | Automatic WhatsApp group with stakeholders | ⛔ not supported by WhatsApp Cloud API |
| 4 | Model/variant/colour confirmation + EDD | ✅ on WhatsApp (model, variant, colour, order#, amount, EDD); EDD **email** skipped per request |
| 5 | Allocation alerts | ✅ fires on `Assigned_Vehicle__c` set → `jasper_allocation_alert` |
| 6 | AI urgency — retail within 5 days of allocation | ✅ daily `WARetailUrgencyScheduler` — day-3 & day-5 customer nudges + day-5 manager escalation |
| 7 | Delivery confirmation taken automatically | ✅ diplomatic "Confirm Delivery" button on the ready message → customer tap recorded on the Order (`Delivery_Confirmed__c`) |
| 8 | Payment alerts before delivery | ✅ **manual** Send-Reminder button (Payment Reminders tab) → `jasper_payment_alert` (shows remaining ₹) |
| 9 | Survey link for payment feedback | ⏭️ skipped per request |
| 10 | AI booking-cancellation survey | ✅ auto on cancel → reason buttons + AI-classified free text, stored on order |
| 11 | Auto manager callback on cancellation | ✅ on cancel → high-priority callback Task (owner-assigned, linked to order) |
| 12 | Manager alerts: nearest matching cars (VNA) | ✅ on VOR/back-order → manager Task with nearest available models |
| 13 | AI greetings on important days | ✅ shared (`WAGreetingScheduler`) |

*Status: 11 done · 1 skipped (#9) · 1 not feasible (#3 — Cloud API can't manage groups). All buildable Bookings items complete.*

**#6 / #11 / #12 (Apex):** `OrderWhatsAppTrigger` (before update) stamps `Allocation_Date__c` when a
vehicle is assigned; `WARetailUrgencyScheduler` (daily 10 AM) nudges customers at day-3 & day-5 after
allocation (`jasper_retail_urgency`) and raises a manager Task at day-5. On **Order Cancelled** →
`WAOrderAlerts.cancellationCallbacks` (manager callback Task); on **VOR/back-order** →
`WAOrderAlerts.vnaAlerts` (manager Task listing nearest available catalog models). All Tasks are
linked to the Order + assigned to the order owner.

**Transcript cleanup:** the bot no longer writes a Task per message — the full transcript lives in one
`WhatsApp_Conversation__c` record per customer, keeping the Tasks list reserved for real actions
(callbacks, escalations, referrals, VNA).

**AI cancellation survey (#10):** when an Order → **Order Cancelled**, `jasper_cancellation_survey`
auto-sends with reason quick-replies (**Price/Budget**, **Chose another**, **Other reason**). A button
tap stores the reason on `Order.Reason_for_Cancellation__c`; **"Other reason"** asks for free text,
which **Claude (Haiku) classifies** (category + summary) before storing. Webhook matches the order by
phone. (Pairs with #11 manager callback, next.)

**Delivery confirmation (#7) — diplomatic flow:** the **ready-for-delivery** message carries a
*Confirm Delivery* quick-reply button framed around completing formalities / activating warranty (not
"did you really receive it?"). When the customer taps it, the webhook records it on their order
(`Order.Delivery_Confirmed__c` + `Delivery_Confirmed_On__c`, matched by phone) and replies warmly.

### Delivery — the 7 requirements

| # | Requirement | Status |
|---|---|---|
| 1 | Tag delivery photos to customers' social media | ⛔ skipped — no access to social accounts |
| 2 | Customized greeting messages | ✅ `jasper_delivered_congrats` on Vehicle Delivered |
| 3 | Customized WhatsApp bot messages | ✅ via Delivery Campaign |
| 4 | Survey link for delivery feedback | ✅ Share-Feedback button on the delivered message |
| 5 | AI classify feedback → escalate to dept | ✅ post-delivery rating → Claude classifies → escalates |
| 6 | Referral via bot calling | ⏭️ skipped (calling); WhatsApp referral capture added instead |
| 7 | Dissatisfied → customer care | ✅ dissatisfied → high-priority Task for Customer Care |

*Status: 4 done (#2,#3,#4 + #5/#7) · 2 skipped (#1, #6) · WhatsApp referral capture as a bonus.*

**Human handoff & where requests are stored:** every "connect with our team" action creates a
**Salesforce Task** — taps on **🧑‍💼 Talk to our team** (LLM reply) or **Advisor** (menu) →
`createAdvisorRequest`; dissatisfied delivery feedback → `escalateDeliveryFeedback`; referrals →
`logReferral`. All are visible in one place via the **Tasks tab → "Team Callback Requests"** list view
(now in the Jasper WhatsApp app), filtered to these handoff/escalation/referral subjects. The LLM no
longer promises phone calls or invents commands — it points to the real Talk-to-our-team button.

**Delivery feedback (#5 + #7):** after the customer taps **Confirm Delivery**, the bot asks
"How was your delivery experience?" with **Great / It was okay / Not satisfied** (interactive, in the
open window — no template). *Not satisfied/Okay* → asks what went wrong → **Claude (`classifyFeedback`)**
classifies sentiment/category → **`salesforce.escalateDeliveryFeedback`** creates a **High-priority
Task for Customer Care** (linked to the Account). *Great* → invites a referral → reply logged as a
sales Task (`logReferral`). All matched by phone; nothing duplicated.

### Cross-cutting
- [ ] Voice/bot calling provider (periodic + referral calls)
- [ ] WhatsApp template library (Marketing/Utility) approved in Meta
- [ ] Production WhatsApp number + permanent token (client-owned)

---

*Last updated: 2026-06-10. Backend release: v39.*

**Requirements status:** Enquiries **12/14** (#4 hot→ASM, #7 calling skipped) · Bookings **11/13** (all
buildable done; #9 payment-survey skipped, #3 WhatsApp groups not feasible) · Delivery **5/7** (#1 social
tagging, #6 referral-calling skipped).

**"Jasper WhatsApp" app tabs:** Template Builder · WA Stage Messages · Enquiry/Booking/Delivery
Campaign · Lost-Case Analysis · Vehicle Promos · Lead Segregation · Payment Reminders · Tasks
(*Team Callback Requests* view). Catalog Sync removed.

**Automation summary:** Catalog live from `Vehicle`. Lifecycle messages via `WA_Stage_Message__c` config
+ triggers: Opportunity (greeting / lost) and Order (booking-confirmed w/ model·variant·colour·EDD ·
allocation alert · ready-for-delivery + Confirm-Delivery button · delivered congrats + survey-link
button · cancellation survey). Manual Payment-Reminder button. Daily schedulers: birthday/anniversary
greetings (#13/#14) and 5-day retail-urgency nudges (#6). Cancellation → manager callback Task (#11);
VOR/back-order → VNA manager alert (#12); delivery feedback → Claude classify → Customer-Care Task
(#5/#7) + WhatsApp referral capture; "Talk to our team" / escalations stored as Tasks. Per-message
transcript Tasks removed — full transcript kept in one `WhatsApp_Conversation__c` per customer. All
sends query live SF objects, link to the source record, and de-dupe by phone; no data copied.*
