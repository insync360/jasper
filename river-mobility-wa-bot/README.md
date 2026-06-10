# river-mobility-wa-bot

WhatsApp + AI backend for River Mobility's customer-lifecycle automation
(Enquiry → Booking → Delivery). Bridges **Salesforce (rrdev)**, the **Meta WhatsApp
Cloud API**, and **Claude (Anthropic)**.

## Architecture

```
Salesforce (Flows/Apex on Lead & Order)
        │  HTTPS callout
        ▼
river-mobility-wa-bot (Heroku, Node/Express)
   • GET  /webhook        Meta verification handshake
   • POST /webhook        inbound messages -> Claude reply (24h window)
   • POST /send/template  business-initiated outreach (approved templates)
   • POST /send/text      free-form reply (inside 24h window)
        │
        ▼
Meta WhatsApp Cloud API  (number +91 76187 18924)
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Health check |
| GET | `/webhook` | Meta webhook verification (`hub.challenge`) |
| POST | `/webhook` | Inbound messages/status from Meta (signature-verified) |
| POST | `/send/template` | Send an approved template `{ to, template, language?, components? }` |
| POST | `/send/text` | Send free-form text `{ to, body }` (24h window only) |

## Local development

```bash
npm install
cp .env.example .env   # fill in secrets
npm run dev
```

## Deploy (Heroku)

App: **river-mobility-wa-bot** — https://river-mobility-wa-bot-5fd60f48abad.herokuapp.com/

```bash
git push heroku main
```

Config vars are set via `heroku config:set` (see `.env.example` for the list). Secrets
are never committed.

## WhatsApp messaging rule

- **Business-initiated** (first touch / outside 24h) → must be an **approved template** (`/send/template`).
- **Inside the 24h window** (customer messaged last) → free-form text/LLM replies OK (`/send/text`, `/webhook`).
