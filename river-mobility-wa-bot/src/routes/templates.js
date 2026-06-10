'use strict';

const express = require('express');
const axios = require('axios');
const config = require('../config');
const templates = require('../services/templates');

const router = express.Router();

/** Simple shared-secret guard so only Salesforce (with the key) can manage templates. */
function requireApiKey(req, res, next) {
  if (!config.templatesApiKey) return next(); // not configured -> allow (dev)
  if (req.get('x-api-key') === config.templatesApiKey) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

/**
 * POST /templates — create & submit a template for approval.
 * Body: {
 *   name, category, language, headerText?, bodyText, bodyExample?[], footer?,
 *   buttons?[{type,text,url?}],
 *   image?: { url } | { data(base64), mime }     // optional IMAGE header
 * }
 */
router.post('/', requireApiKey, async (req, res) => {
  const def = req.body || {};
  if (!def.name || !def.bodyText) {
    return res.status(400).json({ ok: false, error: 'name and bodyText are required' });
  }
  try {
    // Resolve an image header into a Meta header_handle, if provided.
    if (def.image && (def.image.url || def.image.data)) {
      let buffer, mime;
      if (def.image.url) {
        const r = await axios.get(def.image.url, { responseType: 'arraybuffer', timeout: 20000 });
        buffer = Buffer.from(r.data);
        mime = def.image.mime || r.headers['content-type'] || 'image/jpeg';
      } else {
        buffer = Buffer.from(def.image.data, 'base64');
        mime = def.image.mime || 'image/jpeg';
      }
      def.imageHandle = await templates.uploadImageToMeta(buffer, mime);
    }

    const result = await templates.createTemplate(def);
    return res.json({ ok: true, ...result });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[templates] create error:', JSON.stringify(detail));
    return res.status(502).json({ ok: false, error: detail });
  }
});

/** GET /templates — list templates + approval status (for Salesforce to sync). */
router.get('/', requireApiKey, async (_req, res) => {
  try {
    const list = await templates.listTemplates();
    return res.json({ ok: true, templates: list });
  } catch (err) {
    const detail = err.response?.data || err.message;
    return res.status(502).json({ ok: false, error: detail });
  }
});

module.exports = router;
