'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const whatsapp = require('../services/whatsapp');
const ai = require('../services/ai');
const salesforce = require('../services/salesforce');
const menu = require('../services/menu');
const flow = require('../services/flow');
const memory = require('../services/memory');
const testride = require('../services/testride');

const router = express.Router();

/**
 * GET /webhook — Meta verification handshake.
 */
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    console.log('[webhook] verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/** Verify X-Hub-Signature-256 so we only process genuine Meta calls. */
function verifySignature(req) {
  const signature = req.get('x-hub-signature-256');
  if (!config.whatsapp.appSecret) return true; // skip if not configured (dev)
  if (!signature) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', config.whatsapp.appSecret).update(req.body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * POST /webhook — inbound messages from Meta.
 *
 * Routing:
 *  • Tapped a button/list  -> deterministic flow node      (NO LLM)
 *  • Greeting (hi/menu)    -> main menu                     (NO LLM)
 *  • Free-typed text       -> Claude, then a Menu button    (LLM)
 *
 * No keyword/intent guessing on free text — taps drive the journey; the LLM
 * handles anything typed in between.
 */
router.post('/', async (req, res) => {
  if (!verifySignature(req)) {
    console.warn('[webhook] invalid signature');
    return res.sendStatus(401);
  }
  res.sendStatus(200); // ack fast; process async

  let body;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return;
  }

  try {
    const value = body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return; // status update or non-message event

    const from = message.from;
    const profileName = value?.contacts?.[0]?.profile?.name || null;
    const inbound = parseInbound(message); // { kind:'reply'|'text', id?, text }
    console.log(
      `[webhook] from ${from} (${profileName || '?'}): ${inbound.kind}="${inbound.id || inbound.text}"`
    );

    // Record the inbound turn (readable text — button title for taps) into memory.
    memory.record(from, 'user', inbound.text);

    await whatsapp.markRead(message.id).catch(() => {});

    // Delivery confirmation tap (the "Confirm Delivery" button on the ready-for-delivery
    // template). Keyed by phone -> the order, independent of lead/onboarding.
    if (inbound.kind === 'reply' && /confirm\s*delivery/i.test(inbound.id || inbound.text || '')) {
      await handleDeliveryConfirmation(from);
      return;
    }

    // Booking-cancellation survey: free-text follow-up (after "Other reason"), or a reason button.
    const cancelState = memory.getState(from);
    if (cancelState && cancelState.flow === 'cancelfb' && inbound.kind === 'text' && inbound.text) {
      await handleCancelDetail(from, inbound.text);
      return;
    }
    if (inbound.kind === 'reply' && isCancelButton(inbound.id || inbound.text)) {
      await handleCancelReason(from, inbound.id || inbound.text);
      return;
    }

    // Delivery-experience feedback: rating tap, or free-text follow-up (dissatisfied / referral).
    if (inbound.kind === 'reply' && /^df_(great|okay|bad)$/.test(inbound.id || '')) {
      await handleDeliveryRating(from, inbound.id);
      return;
    }
    const fbState = memory.getState(from);
    if (fbState && fbState.flow === 'delivfb' && inbound.kind === 'text' && inbound.text) {
      await handleDeliveryFeedbackText(from, inbound.text);
      return;
    }
    if (fbState && fbState.flow === 'referral' && inbound.kind === 'text' && inbound.text) {
      await handleReferralText(from, inbound.text);
      return;
    }

    // Salesforce identity resolution (3-way):
    //   1. open Lead (IsConverted=false)  -> lead path (existing enquiry)
    //   2. else Contact by phone          -> customer path (returning, converted customer)
    //   3. else                           -> onboarding (create a new Lead)
    // Converted leads are deliberately ignored (see findLeadByPhone) so orphaned converted
    // leads don't get re-greeted; a returning customer is matched on their Contact directly.
    let party = null;
    try {
      const openLead = await salesforce.findLeadByPhone(from);
      if (openLead) {
        party = {
          kind: 'lead',
          leadId: openLead.Id,
          name: openLead.Name,
          firstName: openLead.FirstName || openLead.Name?.split(' ')[0] || null,
          status: openLead.Status,
          source: openLead.Source__c,
          buyingSpan: openLead.Buying_Span__c,
          raw: openLead,
        };
      } else {
        const cust = await salesforce.findCustomerByPhone(from);
        if (cust) {
          party = {
            kind: 'customer',
            contactId: cust.contactId,
            accountId: cust.accountId,
            name: cust.name,
            firstName: cust.firstName,
            raw: cust,
          };
        }
      }
    } catch (e) {
      console.warn('[webhook] SF lookup skipped:', e.message);
    }

    // ONBOARDING (stateful): an unknown number (no open lead, no customer) is walked through
    // pincode -> name -> DOB (name & DOB skippable) before the Lead is created. While no party
    // exists we stay in onboarding; each reply advances a step, then we create the Lead + menu.
    if (!party) {
      await onboardNewNumber(from, profileName, inbound);
      return;
    }

    // Back-compat: flow.js reads ctx.lead (null for customers, which it already guards for).
    const lead = party.kind === 'lead' ? party.raw : null;
    const firstName = party.firstName || profileName?.split(' ')[0] || null;
    const ctx = { from, lead, party, firstName, profileName };

    // If a test-drive booking is in progress, route to it — unless the user
    // explicitly escapes via the main menu or a greeting.
    const escaping = inbound.id === 'main' || (inbound.kind === 'text' && menu.isGreeting(inbound.text));
    if (testride.isActive(from) && !escaping) {
      await testride.handle(inbound, ctx);
      flushTranscript(party, from);
      await saveConversationRecord(party, from);
      return;
    }
    if (testride.isActive(from) && escaping) {
      memory.clearState(from);
    }

    if (inbound.kind === 'reply') {
      // Button/list tap -> guided flow, deterministic, no LLM.
      await flow.handleNode(inbound.id, ctx);
    } else if (menu.isGreeting(inbound.text)) {
      // Greeting -> main menu, no LLM.
      await flow.handleNode('main', ctx);
    } else {
      // Free-typed text -> Claude WITH conversation memory. Then a Menu button to resume.
      console.log('[webhook] free text -> LLM (with memory)');
      const contextNote =
        party.kind === 'customer'
          ? `Returning CUSTOMER (already purchased / converted). Name: ${party.name}. ` +
            `Greet them warmly as an existing customer by first name (${firstName}); ` +
            `they may want service, accessories, or another vehicle.`
          : `Existing Lead. Name: ${party.name}. Status: ${party.status || 'n/a'}. ` +
            `Source: ${party.source || 'n/a'}. Buying span: ${party.buyingSpan || 'n/a'}. ` +
            `Address them by first name (${firstName}) and be context-aware.`;
      const reply = await ai.generateReply(memory.getHistory(from), { contextNote });
      // Offer a real action (human handoff) rather than a generic menu. Users can type "menu" to return.
      await whatsapp.sendButtons(from, reply, [{ id: 'advisor', title: '🧑‍💼 Talk to our team' }]);
    }

    // Persist the transcript: consolidated record linked to the lead or the customer's contact.
    flushTranscript(party, from);
    await saveConversationRecord(party, from);
  } catch (err) {
    console.error('[webhook] processing error:', err.response?.data || err.message);
  }
});

/**
 * Mark conversation turns as synced. The full transcript is persisted in ONE consolidated
 * WhatsApp_Conversation__c record (see saveConversationRecord) — we intentionally no longer
 * create a Task per message, so the Tasks list stays reserved for real actions (callbacks,
 * escalations, referrals) instead of being flooded with message logs.
 */
function flushTranscript(party, phone) {
  if (!party) return;
  memory.takeUnsynced(phone); // drain the unsynced buffer; no per-message Tasks created
}

/**
 * Upsert the consolidated conversation transcript into WhatsApp_Conversation__c, linked to the
 * Lead (open enquiry) or the Contact (returning customer), so the full chat is saved in one record.
 * @param {{kind:'lead'|'customer', leadId?:string, contactId?:string}} party
 */
async function saveConversationRecord(party, phone) {
  if (!party) return;
  const { text, count } = memory.getTranscript(phone);
  if (!text) return;
  try {
    const convoId = memory.getConvoId(phone);
    const id = await salesforce.saveConversation({
      convoId,
      leadId: party.kind === 'lead' ? party.leadId : null,
      contactId: party.kind === 'customer' ? party.contactId : null,
      phone,
      transcript: text,
      count,
    });
    if (id && !convoId) memory.setConvoId(phone, id);
  } catch (e) {
    console.warn('[webhook] saveConversation failed:', e.message);
  }
}

/**
 * Customer tapped "Confirm Delivery" on the ready-for-delivery message. Record it on their
 * order (best-effort) and reply warmly — framed as completing formalities / activating benefits,
 * never as "did you really receive it?".
 */
async function handleDeliveryConfirmation(from) {
  let info = null;
  try {
    info = await salesforce.confirmDelivery(from);
  } catch (e) {
    console.warn('[webhook] confirmDelivery failed:', e.message);
  }
  const veh = info && info.vehicle ? `your ${info.vehicle}` : 'your new vehicle';
  await whatsapp.sendText(
    from,
    `🎉 Thank you for confirming the delivery of ${veh}! We're activating your warranty and roadside ` +
      `assistance now, and our team will share the final documents shortly. 🚗`
  );
  // Delivery-experience feedback (in the open window -> interactive buttons, no template needed).
  await whatsapp.sendButtons(
    from,
    'And how was your overall delivery experience? Your honest feedback helps us improve.',
    [
      { id: 'df_great', title: '😀 Great' },
      { id: 'df_okay', title: 'It was okay' },
      { id: 'df_bad', title: 'Not satisfied' },
    ]
  );
}

/** Delivery-experience rating tap. Happy -> referral invite; otherwise -> ask what went wrong. */
async function handleDeliveryRating(from, id) {
  if (id === 'df_great') {
    memory.setState(from, { flow: 'referral' });
    await whatsapp.sendText(
      from,
      "Wonderful — that means a lot to us! 🎉 If you'd recommend us to family or friends, just reply " +
        "with their name & number and we'll take great care of them. 🙏"
    );
    return;
  }
  memory.setState(from, { flow: 'delivfb' });
  await whatsapp.sendText(
    from,
    "We're sorry it wasn't perfect. 🙏 Could you tell us what went wrong? Our customer care team will " +
      'personally look into it and make it right.'
  );
}

/** Dissatisfied free-text feedback -> AI-classify -> escalate to customer care. */
async function handleDeliveryFeedbackText(from, text) {
  memory.clearState(from);
  let cls = null;
  try {
    cls = await ai.classifyFeedback(text);
  } catch (e) {
    console.warn('[webhook] classifyFeedback failed:', e.message);
  }
  try {
    await salesforce.escalateDeliveryFeedback(from, text, cls);
  } catch (e) {
    console.warn('[webhook] escalateDeliveryFeedback failed:', e.message);
  }
  await whatsapp.sendText(
    from,
    "Thank you for sharing this — we've escalated it to our customer care team, who will reach out to " +
      'make things right. We truly appreciate your patience. 🙏'
  );
}

/** Happy customer shares a referral -> log it for the sales team. */
async function handleReferralText(from, text) {
  memory.clearState(from);
  try {
    await salesforce.logReferral(from, text);
  } catch (e) {
    console.warn('[webhook] logReferral failed:', e.message);
  }
  await whatsapp.sendText(
    from,
    'Thank you so much for the referral! 🙏 Our team will reach out to them with great care. ' +
      'Wishing you many happy miles! 🚗'
  );
}

/** True if a tapped button is one of the cancellation-survey reason buttons. */
function isCancelButton(s) {
  return /^(price\s*\/?\s*budget|chose another|other reason)$/i.test(String(s || '').trim());
}

/**
 * Customer tapped a cancellation-survey reason. Price/Chose-another are stored directly;
 * "Other reason" asks for free text (captured next via handleCancelDetail + AI classify).
 */
async function handleCancelReason(from, label) {
  if (/other\s*reason/i.test(label)) {
    memory.setState(from, { flow: 'cancelfb' });
    await whatsapp.sendText(
      from,
      "We'd really value your input — could you tell us what led to the cancellation? Just reply here."
    );
    return;
  }
  const reason = /price|budget/i.test(label) ? 'Price / Budget' : 'Chose another option';
  try {
    await salesforce.saveCancellationReason(from, reason);
  } catch (e) {
    console.warn('[webhook] saveCancellationReason failed:', e.message);
  }
  await whatsapp.sendText(
    from,
    'Thank you for sharing — we truly appreciate your feedback and will use it to serve you better. ' +
      "If there's anything we can do, just reply here. 🙏"
  );
}

/** Free-text cancellation reason -> AI-classify -> store on the order. */
async function handleCancelDetail(from, text) {
  memory.clearState(from);
  let cls = null;
  try {
    cls = await ai.classifyCancellation(text);
  } catch (e) {
    console.warn('[webhook] classifyCancellation failed:', e.message);
  }
  const stored = cls ? `${cls.category}: ${cls.summary}` : text;
  try {
    await salesforce.saveCancellationReason(from, stored);
  } catch (e) {
    console.warn('[webhook] saveCancellationReason failed:', e.message);
  }
  await whatsapp.sendText(
    from,
    'Thank you for the details — this genuinely helps us improve, and our team may reach out to make ' +
      'things right. 🙏'
  );
}

/** Extract an Indian 6-digit pincode (first digit 1-9) from free text. */
function extractPincode(text) {
  const m = String(text || '').match(/\b([1-9]\d{5})\b/);
  return m ? m[1] : null;
}

/**
 * Parse a date of birth from free text into an ISO date (YYYY-MM-DD) for Birth_Date__c.
 * Accepts DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, 2-digit years, and DD/MM (year defaults
 * to 2000 — only month+day matter for birthday matching). Returns null if unparseable.
 */
function parseDob(text) {
  const m = String(text || '').match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  let y = m[3] ? parseInt(m[3], 10) : 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (m[3] && m[3].length === 2) y = y > 30 ? 1900 + y : 2000 + y; // 2-digit year
  if (y < 1900 || y > 2025) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/**
 * Onboard an unknown WhatsApp number with a short, tap-friendly intake:
 *   pincode  ->  name (skippable)  ->  birthday/DOB (skippable)  ->  create Lead + menu
 * The org requires a valid pincode on Lead insert, so that step is mandatory; name and
 * DOB are optional (a "Skip" button). Captured DOB powers automated birthday greetings.
 * State is held in memory under { flow:'onboard', step }, so each reply advances a step.
 * @returns {Promise<object|null>} the created Lead, or null while still onboarding.
 */
async function onboardNewNumber(from, profileName, inbound) {
  let st = memory.getState(from);

  // First contact -> start onboarding by asking for the pincode.
  if (!st || st.flow !== 'onboard') {
    memory.setState(from, { flow: 'onboard', step: 'pincode' });
    const hiName = profileName ? profileName.split(' ')[0] : null;
    const hi = hiName ? `Hi ${hiName}! 👋` : 'Hi! 👋';
    await whatsapp.sendText(
      from,
      `${hi} Welcome to *Jasper Industries* 🚛\n\nTo get started, please reply with your *6-digit pincode* 📍 (e.g. 500032) so we can serve you better.`
    );
    return null;
  }

  // Step 1 — pincode (mandatory).
  if (st.step === 'pincode') {
    const pincode = extractPincode(inbound.text);
    if (!pincode) {
      await whatsapp.sendText(from, 'Please send a valid *6-digit pincode* 📍 (e.g. 500032).');
      return null;
    }
    st.pincode = pincode;
    st.step = 'name';
    memory.setState(from, st);
    await whatsapp.sendButtons(from, '📍 Got it! And may I have your *name*?', [
      { id: 'ob_skipname', title: 'Skip' },
    ]);
    return null;
  }

  // Step 2 — name (skippable; falls back to the WhatsApp profile name).
  if (st.step === 'name') {
    if (inbound.id === 'ob_skipname') {
      st.name = null;
    } else if (inbound.kind === 'text' && inbound.text.trim()) {
      st.name = inbound.text.trim();
    } else {
      await whatsapp.sendButtons(from, 'Please type your name, or tap Skip.', [
        { id: 'ob_skipname', title: 'Skip' },
      ]);
      return null;
    }
    st.step = 'dob';
    memory.setState(from, st);
    await whatsapp.sendButtons(
      from,
      '🎂 When is your *birthday*? Send it as *DD/MM/YYYY* (e.g. 15/08/1990) and we\'ll wish you on your special day.',
      [{ id: 'ob_skipdob', title: 'Skip' }]
    );
    return null;
  }

  // Step 3 — date of birth (skippable). On completion, create the Lead.
  if (st.step === 'dob') {
    let dob;
    if (inbound.id === 'ob_skipdob') {
      dob = null;
    } else if (inbound.kind === 'text') {
      dob = parseDob(inbound.text);
      if (!dob) {
        await whatsapp.sendButtons(
          from,
          'Please send your birthday as *DD/MM/YYYY* (e.g. 15/08/1990), or tap Skip.',
          [{ id: 'ob_skipdob', title: 'Skip' }]
        );
        return null;
      }
    } else {
      await whatsapp.sendButtons(from, 'Please send your birthday as *DD/MM/YYYY*, or tap Skip.', [
        { id: 'ob_skipdob', title: 'Skip' },
      ]);
      return null;
    }

    const nameForLead = st.name || profileName;
    const extra = { PostalCode: st.pincode };
    if (dob) extra.Birth_Date__c = dob;

    let lead;
    try {
      lead = await salesforce.createLeadFromWhatsApp(from, nameForLead, extra);
      console.log(
        `[webhook] onboarded Lead ${lead.id} ("${nameForLead}") pincode=${st.pincode} dob=${dob || 'skipped'}`
      );
    } catch (e) {
      console.warn('[webhook] Lead create failed:', e.message);
      await whatsapp.sendText(from, 'Sorry, something went wrong creating your profile. Please try again in a moment.');
      memory.clearState(from);
      return null;
    }
    memory.clearState(from);

    const fn = lead.FirstName || (nameForLead ? nameForLead.split(' ')[0] : null);
    await whatsapp.sendList(
      from,
      `✅ Thanks${fn ? ' ' + fn : ''}! You're all set.\n\n${menu.welcomeText(fn)}`,
      'Choose an option',
      flow.MAIN_SECTIONS
    );
    // Now that the Lead exists, persist the whole onboarding conversation verbatim.
    const party = { kind: 'lead', leadId: lead.id };
    flushTranscript(party, from);
    await saveConversationRecord(party, from);
    return lead;
  }

  return null;
}

/**
 * Normalize an inbound message into { kind:'reply'|'text', id?, text }.
 */
function parseInbound(message) {
  if (message.type === 'interactive') {
    const i = message.interactive;
    if (i?.type === 'button_reply') {
      return { kind: 'reply', id: i.button_reply.id, text: i.button_reply.title };
    }
    if (i?.type === 'list_reply') {
      return { kind: 'reply', id: i.list_reply.id, text: i.list_reply.title };
    }
  }
  if (message.type === 'button') {
    return { kind: 'reply', id: message.button.payload || message.button.text, text: message.button.text };
  }
  if (message.type === 'location') {
    const loc = message.location || {};
    const label = loc.name || loc.address || `${loc.latitude}, ${loc.longitude}`;
    return {
      kind: 'location',
      location: { lat: loc.latitude, lng: loc.longitude, name: loc.name, address: loc.address },
      text: `📍 Shared location: ${label}`,
    };
  }
  return { kind: 'text', text: message.text?.body || '' };
}

module.exports = router;
