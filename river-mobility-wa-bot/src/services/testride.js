'use strict';

const whatsapp = require('./whatsapp');
const salesforce = require('./salesforce');
const catalog = require('./catalog');
const memory = require('./memory');

/**
 * Multi-step test-drive booking flow (real-world details), driven by taps +
 * WhatsApp location share. State is held per-conversation in memory.
 *
 * Steps: vehicle -> ridetype -> [location] -> date -> dl -> confirm
 */

function isActive(phone) {
  const s = memory.getState(phone);
  return !!s && s.flow === 'testride';
}

async function vehicleSections() {
  const cat = await catalog.getCatalog();
  return [
    {
      title: 'Choose a vehicle',
      rows: cat.products.map((p) => ({
        id: 'tdv_' + p.id,
        title: p.name.slice(0, 24),
        description: (p.short || '').slice(0, 72)
      }))
    }
  ];
}

const DATE_BUTTONS = [
  { id: 'td_today', title: '📅 Today' },
  { id: 'td_tomorrow', title: '📅 Tomorrow' },
  { id: 'td_weekend', title: '📅 This Weekend' }
];

function computeDate(choice) {
  const d = new Date();
  if (choice === 'td_tomorrow') {
    d.setDate(d.getDate() + 1);
  } else if (choice === 'td_weekend') {
    const day = d.getDay(); // 0 Sun .. 6 Sat
    const add = (6 - day + 7) % 7 || 7;
    d.setDate(d.getDate() + add);
  }
  d.setHours(11, 0, 0, 0);
  const label = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  return { iso: d.toISOString(), label };
}

/** Begin the booking. presetVehicle (product name) skips the vehicle step. */
async function start(ctx, presetProductId) {
  const { from } = ctx;
  const state = { flow: 'testride', step: 'vehicle' };
  const cat = await catalog.getCatalog();
  if (presetProductId && cat.byId[presetProductId]) {
    state.vehicle = cat.byId[presetProductId].name;
    state.step = 'ridetype';
    memory.setState(from, state);
    await whatsapp.sendButtons(from, `🛠️ Test drive for *${state.vehicle}*.\nWhere would you like it?`, [
      { id: 'td_site', title: '📍 At My Site' },
      { id: 'td_store', title: '🏪 At Showroom' }
    ]);
    return;
  }
  memory.setState(from, state);
  await whatsapp.sendList(from, '🛠️ Let\'s book your test drive!\nWhich vehicle would you like to try?', 'Choose Vehicle', await vehicleSections());
}

/** Advance the booking based on the inbound message. */
async function handle(inbound, ctx) {
  const { from, lead, firstName } = ctx;
  const state = memory.getState(from);
  if (!state) return;
  const id = inbound.id;

  switch (state.step) {
    case 'vehicle': {
      if (inbound.kind === 'reply' && id && id.startsWith('tdv_')) {
        const cat = await catalog.getCatalog();
        const prod = cat.byId[id.slice(4)];
        state.vehicle = prod ? prod.name : 'Selected vehicle';
        state.step = 'ridetype';
        memory.setState(from, state);
        await whatsapp.sendButtons(from, `Great — *${state.vehicle}*.\nWhere would you like the test drive?`, [
          { id: 'td_site', title: '📍 At My Site' },
          { id: 'td_store', title: '🏪 At Showroom' }
        ]);
      } else {
        await whatsapp.sendList(from, 'Please pick a vehicle for your test drive:', 'Choose Vehicle', await vehicleSections());
      }
      return;
    }

    case 'ridetype': {
      if (id === 'td_site') {
        state.rideType = 'HTR';
        state.step = 'location';
        memory.setState(from, state);
        await whatsapp.sendLocationRequest(from, '📍 Please share the location where you\'d like the test drive (tap the button below).');
      } else if (id === 'td_store') {
        state.rideType = 'STR';
        state.step = 'date';
        memory.setState(from, state);
        await whatsapp.sendButtons(from, '📅 Which day works for your showroom visit?', DATE_BUTTONS);
      } else {
        await whatsapp.sendButtons(from, 'Please choose where you\'d like the test drive:', [
          { id: 'td_site', title: '📍 At My Site' },
          { id: 'td_store', title: '🏪 At Showroom' }
        ]);
      }
      return;
    }

    case 'location': {
      if (inbound.kind === 'location') {
        state.locLat = inbound.location.lat;
        state.locLng = inbound.location.lng;
        state.locName = inbound.location.name || inbound.location.address || `${inbound.location.lat}, ${inbound.location.lng}`;
        state.locUrl = `https://www.google.com/maps?q=${inbound.location.lat},${inbound.location.lng}`;
      } else if (inbound.kind === 'text' && inbound.text) {
        state.locName = inbound.text; // typed address fallback
      } else {
        await whatsapp.sendLocationRequest(from, '📍 Please tap to share your location, or type your address.');
        return;
      }
      state.step = 'date';
      memory.setState(from, state);
      await whatsapp.sendButtons(from, '📅 Which day works for you?', DATE_BUTTONS);
      return;
    }

    case 'date': {
      if (inbound.kind === 'reply' && ['td_today', 'td_tomorrow', 'td_weekend'].includes(id)) {
        const dt = computeDate(id);
        state.dateIso = dt.iso;
        state.dateLabel = dt.label;
        state.step = 'dl';
        memory.setState(from, state);
        await whatsapp.sendButtons(
          from,
          '🪪 Please type your *Driving Licence number* for the test drive (required to ride), or tap Skip.',
          [{ id: 'td_skipdl', title: 'Skip' }]
        );
      } else {
        await whatsapp.sendButtons(from, 'Please pick a day:', DATE_BUTTONS);
      }
      return;
    }

    case 'dl': {
      if (id === 'td_skipdl') {
        state.dl = null;
      } else if (inbound.kind === 'text' && inbound.text) {
        state.dl = inbound.text.trim();
      } else {
        await whatsapp.sendButtons(from, 'Please type your DL number, or tap Skip.', [{ id: 'td_skipdl', title: 'Skip' }]);
        return;
      }
      state.step = 'confirm';
      memory.setState(from, state);
      const where = state.rideType === 'HTR' ? `At my site${state.locName ? ` (${state.locName})` : ''}` : 'At showroom';
      const summary =
        `Please confirm your test drive:\n\n` +
        `🚗 Vehicle: *${state.vehicle}*\n` +
        `📍 Where: ${where}\n` +
        `📅 Date: ${state.dateLabel}\n` +
        `🪪 DL: ${state.dl || 'Not provided'}`;
      await whatsapp.sendButtons(from, summary, [
        { id: 'td_confirm', title: '✅ Confirm' },
        { id: 'td_cancel', title: '❌ Cancel' }
      ]);
      return;
    }

    case 'confirm': {
      if (id === 'td_confirm') {
        let ok = false;
        if (lead) {
          try {
            await salesforce.bookTestDrive({
              leadId: lead.Id,
              customerName: lead.Name || firstName,
              phone: from,
              rideType: state.rideType,
              vehicle: state.vehicle,
              dateIso: state.dateIso,
              dl: state.dl,
              locLat: state.locLat,
              locLng: state.locLng,
              locName: state.locName,
              locUrl: state.locUrl
            });
            ok = true;
          } catch (e) {
            console.warn('[testride] booking failed:', e.message);
          }
        }
        memory.clearState(from);
        await whatsapp.sendButtons(
          from,
          ok
            ? `✅ Test drive booked${firstName ? `, ${firstName}` : ''}!\n🚗 ${state.vehicle} · 📅 ${state.dateLabel}\nOur team will call you to confirm. Enjoy the drive — once it's done, we'll help you take the next step! 🎉`
            : `Thanks! We've noted your test drive request for *${state.vehicle}*. Our team will call to confirm.`,
          [{ id: 'main', title: '🏠 Main Menu' }, { id: 'advisor', title: '🧑‍💼 Advisor' }]
        );
      } else {
        memory.clearState(from);
        await whatsapp.sendButtons(from, 'No problem, test drive cancelled. What next?', [{ id: 'main', title: '🏠 Main Menu' }]);
      }
      return;
    }

    default:
      memory.clearState(from);
  }
}

module.exports = { isActive, start, handle };
