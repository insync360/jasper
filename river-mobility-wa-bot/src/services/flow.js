'use strict';

const whatsapp = require('./whatsapp');
const salesforce = require('./salesforce');
const menu = require('./menu');
const catalog = require('./catalog');
const testride = require('./testride');

/**
 * Deterministic, button/list-driven conversation flow for JASPER INDUSTRIES
 * (authorized Tata commercial-vehicle dealer). NO LLM. The full journey
 * (browse → test drive → booking → payment → allocation → delivery → feedback)
 * can be completed entirely by tapping. Free-typed text is handled by the LLM
 * in routes/webhook.js.
 */

const COMPANY = 'Jasper Industries';
const BOOKING_AMT = '₹25,000';
const EDD = '2–3 weeks';

// WhatsApp processes media (images) slower than text, so a buttons message sent
// immediately after an image can arrive first. A short pause preserves order.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Reusable button definitions (title <= 20 chars) ----
const BTN = {
  catalog: { id: 'catalog', title: '🚛 Browse Vehicles' },
  pricing: { id: 'pricing', title: '💰 Pricing' },
  testdrive: { id: 'testdrive', title: '🛠️ Test Drive' },
  booknow: { id: 'booknow', title: '🛒 Book Now' },
  status: { id: 'status', title: '📦 Track Status' },
  advisor: { id: 'advisor', title: '🧑‍💼 Advisor' },
  main: { id: 'main', title: '🏠 Main Menu' },
};

// ---- Main menu (list) ----
const MAIN_SECTIONS = [
  {
    title: 'How can we help?',
    rows: [
      { id: 'catalog', title: '🚛 Browse Vehicles', description: 'Trucks, buses, pickups & vans' },
      { id: 'pricing', title: '💰 Pricing & Offers', description: 'Prices, EMI & current offers' },
      { id: 'testdrive', title: '🛠️ Book a Test Drive', description: 'Try a vehicle near you' },
      { id: 'booknow', title: '🛒 Book Now', description: 'Reserve your vehicle' },
      { id: 'status', title: '📦 Booking / Delivery', description: 'Track your order & delivery' },
      { id: 'advisor', title: '🧑‍💼 Talk to an Advisor', description: 'Connect with our team' },
    ],
  },
];

async function sendMain(ctx) {
  await whatsapp.sendList(ctx.from, menu.welcomeText(ctx.firstName), 'Choose an option', MAIN_SECTIONS);
  return 'node:main';
}

/**
 * Render a node by id. Returns a short summary string for activity logging.
 * @param {string} id   the tapped option id
 * @param {{from:string, lead:object|null, firstName:string|null}} ctx
 */
async function handleNode(id, ctx) {
  const { from, lead, firstName } = ctx;

  // ---------- Start a test-drive booking for a specific vehicle ----------
  if (id.startsWith('tdstart_')) {
    await testride.start(ctx, id.slice('tdstart_'.length));
    return `node:testride_start(${id})`;
  }

  // ---------- Product detail (catalog item) ----------
  if (id.startsWith('p_')) {
    const cat = await catalog.getCatalog();
    const p = cat.byId[id];
    if (!p) {
      await whatsapp.sendButtons(from, "That vehicle isn't available right now.", [BTN.catalog, BTN.main]);
      return `node:unknown_product(${id})`;
    }
    const caption =
      `*${p.name}*\n${p.blurb}\n\n` +
      `🔧 ${p.specs}\n💰 Starting at *${p.price}*`;
    if (p.image) {
      await whatsapp.sendImage(from, p.image, caption);
      await sleep(1500); // let the image land first
    } else {
      await whatsapp.sendText(from, caption);
    }
    // Brochure as a tap-to-open URL button (opens the hosted PDF in the browser).
    if (p.brochureUrl) {
      await whatsapp.sendCtaUrl(from, '📄 Here is the brochure — tap to view:', 'View Brochure', p.brochureUrl);
      await sleep(1200);
    }
    await whatsapp.sendButtons(from, 'What would you like to do next?', [
      { id: 'tdstart_' + p.id, title: '🛠️ Test Drive' },
      BTN.booknow,
      BTN.catalog,
    ]);
    return `node:product(${id})`;
  }

  switch (id) {
    // ---------- Top level ----------
    case 'main':
      return sendMain(ctx);

    case 'catalog': {
      const cat = await catalog.getCatalog();
      await whatsapp.sendList(
        from,
        '🚗 *Our Vehicle Range*\nTap a vehicle to see details, price & brochure:',
        'View Vehicles',
        cat.sections
      );
      return 'node:catalog';
    }

    case 'pricing':
      await whatsapp.sendButtons(
        from,
        `💰 *Pricing & Offers*\nOur range starts at *₹3.2L* (Ace SCV) up to *₹24.9L+* (Tippers).\nEasy EMIs & finance available. Tap *Browse Vehicles* for model-wise prices.`,
        [BTN.catalog, BTN.testdrive, BTN.advisor]
      );
      return 'node:pricing';

    // ---------- Test drive (multi-step booking with details + location) ----------
    case 'testdrive':
      await testride.start(ctx);
      return 'node:testride_start';

    // ---------- Booking ----------
    case 'booknow':
      await whatsapp.sendButtons(
        from,
        `🛒 *Reserve your vehicle with ${COMPANY}*\nBooking amount: *${BOOKING_AMT}* (adjustable in final price).\nThis blocks a unit and starts allocation.`,
        [{ id: 'bk_pay', title: '✅ Pay & Reserve' }, BTN.advisor, BTN.main]
      );
      return 'node:booknow';

    case 'bk_pay': {
      if (lead) {
        await salesforce.updateLeadStatus(lead.Id, 'Ready For booking').catch((e) =>
          console.warn('[flow] status update skipped:', e.message)
        );
      }
      await whatsapp.sendButtons(
        from,
        `🎉 *Booking confirmed!*${firstName ? ` Thank you, ${firstName}.` : ''}\nPayment of *${BOOKING_AMT}* received ✅\nEstimated delivery (EDD): *${EDD}*.\n\nWe'll alert you the moment your vehicle is allocated.`,
        [BTN.status, BTN.main]
      );
      return 'node:booking_confirmed';
    }

    // ---------- Allocation / delivery status ----------
    case 'status':
      await whatsapp.sendButtons(
        from,
        `📦 *Your order journey*\n` +
          `✅ Booked\n🔄 Allocation in progress\n⬜ Ready for delivery\n⬜ Delivered\n\n` +
          `EDD: *${EDD}*. Once allocated, you can pick a delivery slot.`,
        [{ id: 'confirm_delivery', title: '🚚 Delivery Slot' }, BTN.advisor, BTN.main]
      );
      return 'node:status';

    case 'confirm_delivery':
      await whatsapp.sendButtons(from, '🚚 Pick a delivery slot:', [
        { id: 'slot_am', title: '🌅 Morning' },
        { id: 'slot_pm', title: '🌇 Evening' },
      ]);
      return 'node:confirm_delivery';

    case 'slot_am':
    case 'slot_pm': {
      const slot = id === 'slot_am' ? 'Morning (10 AM–1 PM)' : 'Evening (4 PM–7 PM)';
      await whatsapp.sendButtons(
        from,
        `🚚 *Delivery scheduled!*\nSlot: *${slot}*\nOur team will call to confirm the exact time & address. See you soon${firstName ? `, ${firstName}` : ''}! 🎉`,
        [{ id: 'feedback', title: '⭐ Give Feedback' }, BTN.main]
      );
      return `node:delivery_scheduled(${id})`;
    }

    // ---------- Feedback ----------
    case 'feedback':
      await whatsapp.sendButtons(from, `⭐ How was your experience with ${COMPANY}?`, [
        { id: 'fb_happy', title: '😀 Great' },
        { id: 'fb_ok', title: '😐 Okay' },
        { id: 'fb_bad', title: '☹️ Not good' },
      ]);
      return 'node:feedback';

    case 'fb_happy':
      await whatsapp.sendButtons(
        from,
        `🙏 Thank you! We're thrilled you're happy.\nKnow a fleet owner or business who needs a vehicle? Refer them and earn rewards! 🎁`,
        [BTN.main]
      );
      return 'node:fb_happy';

    case 'fb_ok':
      await whatsapp.sendButtons(
        from,
        '🙏 Thanks for the feedback! How can we make it a 😀 next time? An advisor can help.',
        [BTN.advisor, BTN.main]
      );
      return 'node:fb_ok';

    case 'fb_bad':
      await salesforce
        .createAdvisorRequest(lead ? lead.Id : null, from, 'Dissatisfied feedback — route to customer care.')
        .catch((e) => console.warn('[flow] customer-care request failed:', e.message));
      await whatsapp.sendButtons(
        from,
        "😔 We're sorry to hear that. We've notified our customer care team and they'll reach out to you shortly. 🙏",
        [BTN.main]
      );
      return 'node:fb_bad(escalate)';

    // ---------- Advisor / connect with our team ----------
    case 'advisor':
      await salesforce
        .createAdvisorRequest(lead ? lead.Id : null, from, 'Requested to talk to our team.')
        .catch((e) => console.warn('[flow] advisor request failed:', e.message));
      await whatsapp.sendButtons(
        from,
        `🧑‍💼 Done${firstName ? `, ${firstName}` : ''}! I've notified our team at ${COMPANY} — an advisor ` +
          `will reach out to you here on WhatsApp shortly. 🙏`,
        [BTN.main]
      );
      return 'node:advisor';

    // ---------- Fallback ----------
    default:
      await whatsapp.sendButtons(from, "Let's continue — what would you like to do?", [BTN.main]);
      return `node:unknown(${id})`;
  }
}

module.exports = { handleNode, sendMain, MAIN_SECTIONS, COMPANY };
