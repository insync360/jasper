'use strict';

const axios = require('axios');
const config = require('../config');
const memory = require('./memory');

/** Record an outbound message into conversation memory (best-effort, never throws). */
function rec(to, text) {
  try {
    memory.record(to, 'assistant', text);
  } catch {
    /* ignore */
  }
}

/**
 * Thin wrapper over the Meta WhatsApp Cloud API.
 *
 * Messaging rule (Cloud API):
 *  - Business-initiated (first contact / outside 24h window) -> MUST be an approved template.
 *  - Inside the 24h customer-service window (customer messaged last) -> free-form text/media OK.
 */

function client() {
  return axios.create({
    baseURL: `${config.whatsapp.graphBase}/${config.whatsapp.phoneNumberId}`,
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

/**
 * Send an approved template message (business-initiated outreach).
 * @param {string} to            E.164 number without '+', e.g. "919182444249"
 * @param {string} templateName  Approved template name, e.g. "hello_world"
 * @param {string} languageCode  e.g. "en_US" or "en"
 * @param {Array}  components     Optional template components (header/body variables, buttons)
 */
async function sendTemplate(to, templateName, languageCode = 'en_US', components = []) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components.length ? { components } : {}),
    },
  };
  const { data } = await client().post('/messages', payload);
  rec(to, `[template: ${templateName}]`);
  return data;
}

/**
 * Send a free-form text message. Only valid inside the 24h service window.
 * @param {string} to    E.164 number without '+'
 * @param {string} body  Message text
 */
async function sendText(to, body) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { preview_url: false, body },
  };
  const { data } = await client().post('/messages', payload);
  rec(to, body);
  return data;
}

/**
 * Send an image by public URL with an optional caption.
 * @param {string} to
 * @param {string} link     publicly-accessible image URL
 * @param {string} [caption]
 */
async function sendImage(to, link, caption) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { link, ...(caption ? { caption } : {}) },
  };
  const { data } = await client().post('/messages', payload);
  rec(to, caption || '[image]');
  return data;
}

/**
 * Send interactive reply buttons (max 3). Great for quick yes/no/choice.
 * @param {string} to
 * @param {string} bodyText
 * @param {Array<{id:string,title:string}>} buttons  title <= 20 chars
 * @param {string} [header]  optional short header text
 */
async function sendButtons(to, bodyText, buttons, header) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(header ? { header: { type: 'text', text: header.slice(0, 60) } } : {}),
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  };
  const { data } = await client().post('/messages', payload);
  rec(to, bodyText);
  return data;
}

/**
 * Send an interactive list message (a tap-to-open menu). Up to 10 rows total.
 * @param {string} to
 * @param {string} bodyText
 * @param {string} buttonText  the menu-open button label (<= 20 chars)
 * @param {Array<{title?:string, rows:Array<{id:string,title:string,description?:string}>}>} sections
 * @param {string} [header]
 */
async function sendList(to, bodyText, buttonText, sections, header) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      ...(header ? { header: { type: 'text', text: header.slice(0, 60) } } : {}),
      body: { text: bodyText },
      action: {
        button: buttonText.slice(0, 20),
        sections: sections.map((s) => ({
          ...(s.title ? { title: s.title.slice(0, 24) } : {}),
          rows: s.rows.map((r) => ({
            id: r.id,
            title: r.title.slice(0, 24),
            ...(r.description ? { description: r.description.slice(0, 72) } : {}),
          })),
        })),
      },
    },
  };
  const { data } = await client().post('/messages', payload);
  rec(to, bodyText);
  return data;
}

/**
 * Send a single call-to-action URL button (opens the link in the phone's browser).
 * @param {string} to
 * @param {string} bodyText
 * @param {string} buttonText  <= 20 chars
 * @param {string} url
 */
async function sendCtaUrl(to, bodyText, buttonText, url) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: bodyText },
      action: { name: 'cta_url', parameters: { display_text: buttonText.slice(0, 20), url } },
    },
  };
  const { data } = await client().post('/messages', payload);
  rec(to, `${bodyText} [${buttonText}]`);
  return data;
}

/**
 * Send an interactive "share your location" request. The user taps it and shares
 * a location, which arrives back as an inbound message of type 'location'.
 * @param {string} to
 * @param {string} bodyText
 */
async function sendLocationRequest(to, bodyText) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: { text: bodyText },
      action: { name: 'send_location' },
    },
  };
  const { data } = await client().post('/messages', payload);
  rec(to, bodyText);
  return data;
}

/**
 * Mark an inbound message as read (blue ticks).
 */
async function markRead(messageId) {
  const payload = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  };
  const { data } = await client().post('/messages', payload);
  return data;
}

module.exports = {
  sendTemplate,
  sendText,
  sendImage,
  sendButtons,
  sendList,
  sendLocationRequest,
  sendCtaUrl,
  markRead,
};
