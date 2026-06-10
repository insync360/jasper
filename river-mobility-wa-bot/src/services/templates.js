'use strict';

const axios = require('axios');
const config = require('../config');

/**
 * WhatsApp message-template management against the Meta Graph API:
 *  - uploadImageToMeta(): Resumable Upload API -> returns a header_handle for image headers.
 *  - createTemplate(): submit a template for approval.
 *  - listTemplates(): fetch templates + their approval status.
 */

const wa = config.whatsapp;

/**
 * Upload an image to Meta via the Resumable Upload API and return its header_handle,
 * which is required to submit an IMAGE-header template.
 * @param {Buffer} buffer
 * @param {string} mime  e.g. 'image/jpeg' | 'image/png'
 * @returns {Promise<string>} the header handle
 */
async function uploadImageToMeta(buffer, mime) {
  if (!wa.appId) throw new Error('WHATSAPP_APP_ID is not set');
  // Step 1: create an upload session.
  const start = await axios.post(`${wa.graphBase}/${wa.appId}/uploads`, null, {
    params: { file_length: buffer.length, file_type: mime, access_token: wa.token },
    timeout: 20000,
  });
  const sessionId = start.data.id; // "upload:..."

  // Step 2: upload the bytes; response carries the handle.
  const up = await axios.post(`${wa.graphBase}/${sessionId}`, buffer, {
    headers: {
      Authorization: `OAuth ${wa.token}`,
      file_offset: 0,
      'Content-Type': 'application/octet-stream',
    },
    maxBodyLength: Infinity,
    timeout: 60000,
  });
  return up.data.h;
}

/**
 * Build the components array and submit a template for approval.
 * @param {object} def
 *   { name, category, language, headerText?, imageHandle?, bodyText, bodyExample?[],
 *     footer?, buttons?[{type:'QUICK_REPLY'|'URL', text, url?}] }
 * @returns {Promise<object>} Meta response: { id, status, category }
 */
async function createTemplate(def) {
  const components = [];

  if (def.imageHandle) {
    components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [def.imageHandle] } });
  } else if (def.headerText) {
    components.push({ type: 'HEADER', format: 'TEXT', text: def.headerText });
  }

  const body = { type: 'BODY', text: def.bodyText };
  if (Array.isArray(def.bodyExample) && def.bodyExample.length) {
    body.example = { body_text: [def.bodyExample] };
  }
  components.push(body);

  if (def.footer) components.push({ type: 'FOOTER', text: def.footer });

  if (Array.isArray(def.buttons) && def.buttons.length) {
    components.push({
      type: 'BUTTONS',
      buttons: def.buttons.map((b) =>
        b.type === 'URL'
          ? { type: 'URL', text: b.text, url: b.url }
          : { type: 'QUICK_REPLY', text: b.text }
      ),
    });
  }

  const payload = {
    name: def.name,
    language: def.language || 'en',
    category: def.category || 'MARKETING',
    components,
  };

  const { data } = await axios.post(`${wa.graphBase}/${wa.wabaId}/message_templates`, payload, {
    headers: { Authorization: `Bearer ${wa.token}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  return data; // { id, status, category }
}

/** List templates with their approval status AND components (for preview rendering). */
async function listTemplates() {
  const { data } = await axios.get(`${wa.graphBase}/${wa.wabaId}/message_templates`, {
    params: {
      fields: 'name,status,category,language,id,components',
      limit: 100,
      access_token: wa.token,
    },
    timeout: 20000,
  });
  return data.data || [];
}

module.exports = { uploadImageToMeta, createTemplate, listTemplates };
