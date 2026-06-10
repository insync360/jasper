'use strict';

const express = require('express');
const config = require('../config');
const catalog = require('../services/catalog');

const router = express.Router();

function requireApiKey(req, res, next) {
  if (!config.templatesApiKey) return next();
  if (req.get('x-api-key') === config.templatesApiKey) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

/** POST /catalog/refresh — drop the cache and reload vehicles from Salesforce now. */
router.post('/refresh', requireApiKey, async (_req, res) => {
  try {
    catalog.invalidate();
    const c = await catalog.getCatalog();
    return res.json({ ok: true, count: c.products.length });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
});

module.exports = router;
