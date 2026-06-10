'use strict';

const express = require('express');
const whatsapp = require('../services/whatsapp');

const router = express.Router();

/**
 * POST /send/template — business-initiated outreach (Salesforce calls this).
 * Body: { to, template, language?, components? }
 */
router.post('/template', async (req, res) => {
  const { to, template, language = 'en_US', components = [] } = req.body || {};
  if (!to || !template) {
    return res.status(400).json({ error: 'to and template are required' });
  }
  try {
    const data = await whatsapp.sendTemplate(to, template, language, components);
    return res.json({ ok: true, data });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[send/template] error:', detail);
    return res.status(502).json({ ok: false, error: detail });
  }
});

/**
 * POST /send/text — free-form text (only valid inside the 24h window).
 * Body: { to, body }
 */
router.post('/text', async (req, res) => {
  const { to, body } = req.body || {};
  if (!to || !body) {
    return res.status(400).json({ error: 'to and body are required' });
  }
  try {
    const data = await whatsapp.sendText(to, body);
    return res.json({ ok: true, data });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[send/text] error:', detail);
    return res.status(502).json({ ok: false, error: detail });
  }
});

module.exports = router;
