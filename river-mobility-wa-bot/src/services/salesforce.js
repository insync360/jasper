'use strict';

const jsforce = require('jsforce');
const config = require('../config');

/**
 * Salesforce connection for the bot. Supports three auth modes (first one that is
 * fully configured wins), so the same code works locally and on Heroku:
 *
 *  1. Refresh token  — SF_REFRESH_TOKEN (+ SF_INSTANCE_URL, SF_CLIENT_ID[, SF_CLIENT_SECRET])
 *                       jsforce auto-refreshes the access token. Most durable.
 *  2. Username/Pass  — SF_USERNAME + SF_PASSWORD (password + security token). SOAP login.
 *  3. Access token   — SF_ACCESS_TOKEN + SF_INSTANCE_URL. Short-lived; handy for local tests.
 */
let _conn = null;
let _connAt = 0;
const TTL_MS = 60 * 60 * 1000; // re-establish hourly

async function getConnection() {
  if (_conn && Date.now() - _connAt < TTL_MS) return _conn;
  const sf = config.salesforce;
  let conn;

  if (sf.refreshToken && sf.instanceUrl && sf.clientId) {
    conn = new jsforce.Connection({
      oauth2: {
        loginUrl: sf.loginUrl,
        clientId: sf.clientId,
        clientSecret: sf.clientSecret || '',
      },
      instanceUrl: sf.instanceUrl,
      refreshToken: sf.refreshToken,
    });
    await conn.identity(); // forces a token refresh / validates
  } else if (sf.username && sf.password) {
    conn = new jsforce.Connection({ loginUrl: sf.loginUrl });
    await conn.login(sf.username, sf.password);
  } else if (sf.accessToken && sf.instanceUrl) {
    conn = new jsforce.Connection({
      instanceUrl: sf.instanceUrl,
      accessToken: sf.accessToken,
    });
  } else {
    throw new Error('No Salesforce credentials configured (see .env.example)');
  }

  conn.version = '62.0'; // Automotive Cloud objects (Vehicle) need a recent API version
  _conn = conn;
  _connAt = Date.now();
  return conn;
}

/** SOQL-escape a string literal. */
function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Last 10 digits of any phone string (WhatsApp gives E.164 like 919182444249). */
function last10(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

/**
 * Find the most recent OPEN Lead matching a WhatsApp number (by last 10 digits).
 * Converted leads are excluded — once a lead converts it is no longer an open enquiry,
 * and a converted lead can be an orphan (its Account/Contact/Opportunity were deleted but
 * the lead survives with dangling pointers). Returning customers are resolved separately
 * via findCustomerByPhone.
 * @returns {Promise<object|null>}
 */
async function findLeadByPhone(waNumber) {
  const conn = await getConnection();
  const p = esc(last10(waNumber));
  if (!p) return null;
  const soql =
    `SELECT Id, Name, FirstName, Status, Source__c, Buying_Span__c, ` +
    `Lost_Reason__c, OwnerId FROM Lead ` +
    `WHERE (Phone = '${p}' OR MobilePhone = '${p}') AND IsConverted = false ` +
    `ORDER BY CreatedDate DESC LIMIT 1`;
  const res = await conn.query(soql);
  return res.records[0] || null;
}

/**
 * Find a returning CUSTOMER (a converted lead's Contact) by WhatsApp number. Matched directly
 * on the Contact's phone — never via a converted lead's pointers — so deleted customers don't
 * resurface. Returns the normalized identity used by the bot's "customer path".
 * @returns {Promise<{contactId:string, accountId:string|null, name:string, firstName:string|null}|null>}
 */
async function findCustomerByPhone(waNumber) {
  const conn = await getConnection();
  const p = esc(last10(waNumber));
  if (!p) return null;
  const res = await conn.query(
    `SELECT Id, Name, FirstName, AccountId FROM Contact ` +
      `WHERE Phone LIKE '%${p}%' OR MobilePhone LIKE '%${p}%' ` +
      `ORDER BY CreatedDate DESC LIMIT 1`
  );
  const c = res.records[0];
  if (!c) return null;
  return {
    contactId: c.Id,
    accountId: c.AccountId || null,
    name: c.Name,
    firstName: c.FirstName || (c.Name ? c.Name.split(' ')[0] : null),
  };
}

/**
 * Log a WhatsApp interaction as a Task on the Lead's activity timeline.
 * @param {string} leadId
 * @param {'inbound'|'outbound'} direction
 * @param {string} message
 */
async function logInteraction(leadId, direction, message) {
  if (!leadId) return null;
  const conn = await getConnection();
  const subject = `WhatsApp ${direction}`;
  const task = {
    WhoId: leadId,
    Subject: subject,
    Description: message,
    Status: 'Completed',
    Priority: 'Normal',
    TaskSubtype: 'Call',
  };
  return conn.sobject('Task').create(task);
}

/** Split a WhatsApp profile name into { firstName, lastName } (LastName is required on Lead). */
function splitName(profileName) {
  const parts = String(profileName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: 'WhatsApp Lead' };
  if (parts.length === 1) return { firstName: '', lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Create a new Lead captured from WhatsApp, using the sender's profile name.
 * The name is a best-guess default the user/agent can correct later in Salesforce.
 * @param {string} waNumber   E.164 without '+'
 * @param {string} profileName WhatsApp profile display name
 * @param {object} [extra]     additional fields (e.g. PostalCode, City) to satisfy validations
 */
async function createLeadFromWhatsApp(waNumber, profileName, extra = {}) {
  const conn = await getConnection();
  const { firstName, lastName } = splitName(profileName);
  const rec = {
    FirstName: firstName,
    LastName: lastName,
    Company: 'WhatsApp Lead',
    Phone: last10(waNumber),
    Status: 'New',
    Source__c: 'Telephone',
    ...extra,
  };
  const res = await conn.sobject('Lead').create(rec);
  return { id: res.id, FirstName: firstName, Name: `${firstName} ${lastName}`.trim() };
}

/** Update a Lead's name (when the user corrects the captured WhatsApp name). */
async function updateLeadName(leadId, profileName) {
  const conn = await getConnection();
  const { firstName, lastName } = splitName(profileName);
  return conn.sobject('Lead').update({ Id: leadId, FirstName: firstName, LastName: lastName });
}

/**
 * Upsert the consolidated WhatsApp conversation transcript record. Linked to the Lead
 * (open enquiry) or the Contact (returning customer), whichever the conversation belongs to.
 * @param {{convoId?:string, leadId?:string, contactId?:string, phone:string, transcript:string, count:number}} p
 * @returns {Promise<string>} the WhatsApp_Conversation__c record id
 */
async function saveConversation({ convoId, leadId, contactId, phone, transcript, count }) {
  const conn = await getConnection();
  const rec = {
    Lead__c: leadId || null,
    Contact__c: contactId || null,
    Contact_Number__c: phone,
    Transcript__c: String(transcript || '').slice(0, 131000),
    Message_Count__c: count || 0,
    Last_Activity__c: new Date().toISOString(),
  };
  if (convoId) {
    await conn.sobject('WhatsApp_Conversation__c').update({ Id: convoId, ...rec });
    return convoId;
  }
  const res = await conn.sobject('WhatsApp_Conversation__c').create(rec);
  return res.id;
}

/**
 * Update a Lead's funnel Status. Valid values:
 * New -> RNR -> Test Ride -> Follow Up -> Ready For booking -> Converted/Close lost/Junk.
 */
async function updateLeadStatus(leadId, status) {
  if (!leadId) return null;
  const conn = await getConnection();
  return conn.sobject('Lead').update({ Id: leadId, Status: status });
}

/**
 * Create a Test Drive request linked to a Lead, and advance the Lead's funnel
 * Status to "Test Ride" (best-effort) so it reflects the real lifecycle stage.
 * @param {string} leadId
 * @param {'HTR'|'STR'} rideType  Home Test Ride or Store Test Ride
 */
async function createTestDrive(leadId, rideType) {
  if (!leadId) return null;
  const conn = await getConnection();
  const res = await conn.sobject('Test_Drive__c').create({
    Lead__c: leadId,
    Ride_Type__c: rideType,
    Test_Drive_Status__c: 'New',
  });
  // Move the Lead forward in the funnel to reflect the booked test ride.
  await updateLeadStatus(leadId, 'Test Ride').catch((e) =>
    console.warn('[sf] lead status update skipped:', e.message)
  );
  return res;
}

/**
 * Book a fully-detailed test drive and advance the Lead to "Test Ride".
 * @param {object} d {leadId, phone, rideType:'HTR'|'STR', vehicle, dateIso, dl,
 *                     locLat, locLng, locName, locUrl}
 */
async function bookTestDrive(d) {
  const conn = await getConnection();
  const who = d.customerName || 'Customer';
  const rec = {
    Name: `${who} – ${d.vehicle || 'Test Drive'}`.slice(0, 80),
    Lead__c: d.leadId,
    Ride_Type__c: d.rideType,
    Test_Drive_Status__c: 'Scheduled',
    Vehicle_Model__c: d.vehicle,
  };
  if (d.dateIso) {
    rec.Test_Drive_Date__c = d.dateIso;
    rec.Test_Ride_Date__c = d.dateIso; // org layout uses this field for the scheduled date
  }
  if (d.dl) rec.Drivers_License_Number__c = d.dl;
  if (d.phone) rec.Phone__c = d.phone;
  if (d.locName) rec['Address__Street__s'] = String(d.locName).slice(0, 255);
  if (d.locLat != null) rec['Address__Latitude__s'] = d.locLat;
  if (d.locLng != null) rec['Address__Longitude__s'] = d.locLng;
  if (d.locUrl) rec.Location_URL__c = d.locUrl;
  const res = await conn.sobject('Test_Drive__c').create(rec);
  await updateLeadStatus(d.leadId, 'Test Ride').catch((e) =>
    console.warn('[sf] lead status update skipped:', e.message)
  );
  return res;
}

/**
 * Book a test drive for a returning CUSTOMER (no open Lead). Test_Drive__c only links to a
 * Lead or an Opportunity, so we open a fresh Opportunity under the customer's Account (a
 * returning customer wanting another vehicle is a new deal) and link the test drive to it.
 * Opportunity creation is best-effort: if it fails (validation rules, missing Account), we
 * still create the Test_Drive__c unlinked and log a fallback Task so the request is never lost.
 * @param {object} d {accountId, contactId, customerName, phone, rideType:'HTR'|'STR', vehicle,
 *                     dateIso, dl, locLat, locLng, locName, locUrl}
 * @returns {Promise<{id:string, opportunityId:string|null}>}
 */
async function createCustomerTestDrive(d) {
  const conn = await getConnection();
  const who = d.customerName || 'Customer';

  // 1) Open a new Opportunity under the customer's Account (best-effort).
  let oppId = null;
  if (d.accountId) {
    try {
      const close = new Date();
      close.setDate(close.getDate() + 30);
      const opp = await conn.sobject('Opportunity').create({
        Name: `${who} – ${d.vehicle || 'Vehicle'} (Test Drive)`.slice(0, 120),
        StageName: 'Prospecting',
        CloseDate: close.toISOString().slice(0, 10),
        AccountId: d.accountId,
      });
      oppId = opp.id;
    } catch (e) {
      console.warn('[sf] customer opportunity create failed:', e.message);
    }
  }

  // 2) Create the Test_Drive__c, linked to the Opportunity when we have one.
  const rec = {
    Name: `${who} – ${d.vehicle || 'Test Drive'}`.slice(0, 80),
    Ride_Type__c: d.rideType,
    Test_Drive_Status__c: 'Scheduled',
    Vehicle_Model__c: d.vehicle,
  };
  if (oppId) rec.Opportunity__c = oppId;
  if (d.dateIso) {
    rec.Test_Drive_Date__c = d.dateIso;
    rec.Test_Ride_Date__c = d.dateIso;
  }
  if (d.dl) rec.Drivers_License_Number__c = d.dl;
  if (d.phone) rec.Phone__c = d.phone;
  if (d.locName) rec['Address__Street__s'] = String(d.locName).slice(0, 255);
  if (d.locLat != null) rec['Address__Latitude__s'] = d.locLat;
  if (d.locLng != null) rec['Address__Longitude__s'] = d.locLng;
  if (d.locUrl) rec.Location_URL__c = d.locUrl;
  const res = await conn.sobject('Test_Drive__c').create(rec);

  // 3) If we couldn't open an Opportunity, log a Task on the Contact so it's actioned.
  if (!oppId) {
    try {
      const task = {
        Subject: '🛠️ Returning customer requested a test drive',
        Description: `Vehicle: ${d.vehicle || 'n/a'} · Ride: ${d.rideType || 'n/a'} · DL: ${d.dl || 'n/a'}`,
        Priority: 'Normal',
        Status: 'Open',
      };
      if (d.contactId) task.WhoId = d.contactId;
      task.Phone_number__c = last10(d.phone);
      await conn.sobject('Task').create(task);
    } catch (e) {
      console.warn('[sf] customer test-drive fallback Task failed:', e.message);
    }
  }

  return { id: res.id, opportunityId: oppId };
}

/**
 * Record a customer's WhatsApp "Confirm Delivery" tap on their most recent order.
 * Matches the order by phone (Order.Phone__c = Account.Phone). Best-effort.
 * @returns {Promise<{orderNumber:string, vehicle:string}|null>}
 */
async function confirmDelivery(waNumber) {
  const conn = await getConnection();
  const d10 = last10(waNumber);
  if (!d10) return null;
  const rows = await conn.query(
    `SELECT Id, OrderNumber, Phone__c, (SELECT Product2.Name FROM OrderItems LIMIT 1) ` +
      `FROM Order WHERE Phone__c LIKE '%${esc(d10)}%' ORDER BY CreatedDate DESC LIMIT 1`
  );
  if (!rows.records || !rows.records.length) return null;
  const o = rows.records[0];
  await conn.sobject('Order').update({
    Id: o.Id,
    Delivery_Confirmed__c: true,
    Delivery_Confirmed_On__c: new Date().toISOString(),
  });
  const vehicle =
    o.OrderItems && o.OrderItems.records && o.OrderItems.records[0]
      ? o.OrderItems.records[0].Product2 && o.OrderItems.records[0].Product2.Name
      : '';
  return { orderNumber: o.OrderNumber, vehicle: vehicle || '' };
}

/**
 * Save a booking-cancellation reason (from the WhatsApp survey) onto the customer's most
 * recent order, matched by phone. Best-effort.
 * @returns {Promise<{orderNumber:string}|null>}
 */
async function saveCancellationReason(waNumber, reasonText) {
  const conn = await getConnection();
  const d10 = last10(waNumber);
  if (!d10) return null;
  const rows = await conn.query(
    `SELECT Id, OrderNumber FROM Order WHERE Phone__c LIKE '%${esc(d10)}%' ORDER BY CreatedDate DESC LIMIT 1`
  );
  if (!rows.records || !rows.records.length) return null;
  const o = rows.records[0];
  await conn.sobject('Order').update({
    Id: o.Id,
    Reason_for_Cancellation__c: String(reasonText || '').slice(0, 255),
  });
  return { orderNumber: o.OrderNumber };
}

/**
 * Escalate a dissatisfied delivery-feedback case to customer care: creates a high-priority
 * Task (linked to the customer's Account when found by phone) with the feedback + AI classification.
 * @returns {Promise<object>}
 */
/**
 * Resolve the records to link a Task to, from a phone number:
 *  - whoId  = the person (Contact preferred, else Lead)
 *  - whatId = the Order (so it appears on the order's activities) when one exists
 *  - orderId = the Order (also set on the Task's Order__c lookup)
 */
async function findLinksByPhone(conn, waNumber) {
  const d10 = last10(waNumber);
  const out = { whoId: null, whatId: null, orderId: null };
  if (!d10) return out;
  try {
    const o = await conn.query(
      `SELECT Id FROM Order WHERE Phone__c LIKE '%${esc(d10)}%' ORDER BY CreatedDate DESC LIMIT 1`
    );
    if (o.records && o.records.length) {
      out.orderId = o.records[0].Id;
      out.whatId = o.records[0].Id;
    }
  } catch (e) {
    /* ignore */
  }
  try {
    const c = await conn.query(
      `SELECT Id FROM Contact WHERE Phone LIKE '%${esc(d10)}%' OR MobilePhone LIKE '%${esc(d10)}%' ORDER BY CreatedDate DESC LIMIT 1`
    );
    if (c.records && c.records.length) out.whoId = c.records[0].Id;
  } catch (e) {
    /* ignore */
  }
  if (!out.whoId) {
    try {
      const l = await conn.query(
        `SELECT Id FROM Lead WHERE Phone = '${esc(d10)}' ORDER BY CreatedDate DESC LIMIT 1`
      );
      if (l.records && l.records.length) out.whoId = l.records[0].Id;
    } catch (e) {
      /* ignore */
    }
  }
  return out;
}

/** Apply phone + Lead/Contact/Order links to a Task record (mutates and returns it). */
async function applyTaskLinks(conn, task, waNumber, leadId) {
  task.Phone_number__c = last10(waNumber);
  const links = await findLinksByPhone(conn, waNumber);
  const who = leadId || links.whoId;
  if (who) task.WhoId = who;
  if (links.whatId) task.WhatId = links.whatId;
  if (links.orderId) task.Order__c = links.orderId;
  return task;
}

async function escalateDeliveryFeedback(waNumber, feedbackText, classification) {
  const conn = await getConnection();
  const c = classification || {};
  const task = await applyTaskLinks(
    conn,
    {
      Subject: '⚠️ Dissatisfied delivery feedback — Customer Care follow-up',
      Description:
        `Delivery feedback (WhatsApp):\n"${feedbackText}"\n\n` +
        `AI sentiment: ${c.sentiment || 'negative'}\nAI category: ${c.category || 'delivery'}\n` +
        `AI summary: ${c.summary || feedbackText}`,
      Priority: 'High',
    },
    waNumber,
    null
  );
  return conn.sobject('Task').create(task);
}

/**
 * Store a "connect with our team" / advisor request as a high-priority Task so the team follows up.
 * Linked to the Lead (WhoId) when known. This is where advisor/handoff requests are captured.
 * @returns {Promise<object>}
 */
async function createAdvisorRequest(leadId, phone, note) {
  const conn = await getConnection();
  const task = await applyTaskLinks(
    conn,
    {
      Subject: '🧑‍💼 Customer wants to connect with our team',
      Description: note || 'Customer requested to talk to our team.',
      Priority: 'High',
    },
    phone,
    leadId
  );
  return conn.sobject('Task').create(task);
}

/** Log a referral shared by a happy customer as a Task for the sales team. */
async function logReferral(waNumber, text) {
  const conn = await getConnection();
  const task = await applyTaskLinks(
    conn,
    {
      Subject: '🌟 Referral from a happy delivery customer',
      Description: `Referral shared via WhatsApp:\n"${text}"`,
      Priority: 'Normal',
    },
    waNumber,
    null
  );
  return conn.sobject('Task').create(task);
}

module.exports = {
  getConnection,
  findLeadByPhone,
  findCustomerByPhone,
  createCustomerTestDrive,
  confirmDelivery,
  escalateDeliveryFeedback,
  logReferral,
  createAdvisorRequest,
  saveCancellationReason,
  createLeadFromWhatsApp,
  updateLeadName,
  updateLeadStatus,
  saveConversation,
  logInteraction,
  createTestDrive,
  bookTestDrive,
  last10,
};
