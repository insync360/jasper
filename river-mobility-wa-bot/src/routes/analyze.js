'use strict';

const express = require('express');
const config = require('../config');
const ai = require('../services/ai');

const router = express.Router();

/** Shared-secret guard (same key Salesforce uses for /templates and /catalog). */
function requireApiKey(req, res, next) {
  if (!config.templatesApiKey) return next(); // not configured -> allow (dev)
  if (req.get('x-api-key') === config.templatesApiKey) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

/**
 * POST /analyze/lost-cases — AI analysis of lost leads.
 * Body: aggregated + sampled lost-lead data gathered in Salesforce:
 *   { total, byReason:[{reason,count}], bySource:[{source,count}],
 *     byBuyingSpan:[{span,count}], samples:[{reason,note,source,buyingSpan,city,ageDays}] }
 * Returns: { ok, analysis:{ summary, topReasons, rootCauses, recommendations, winBack } }
 */
router.post('/lost-cases', requireApiKey, async (req, res) => {
  const data = req.body || {};
  if (!data.total || data.total === 0) {
    return res.status(400).json({ ok: false, error: 'no lost cases to analyze' });
  }
  try {
    const analysis = await ai.analyzeLostCases(data);
    res.json({ ok: true, analysis });
  } catch (err) {
    console.error('[analyze] lost-cases failed:', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /analyze/lost-case — AI analysis of ONE lost lead.
 * Body: { case: { name, reason, note, source, buyingSpan, city, ageDays, vehicle? } }
 * Returns: { ok, analysis:{ verdict, recoverability, factors, winBackAction, suggestedMessage } }
 */
router.post('/lost-case', requireApiKey, async (req, res) => {
  const c = (req.body && req.body.case) || null;
  if (!c) {
    return res.status(400).json({ ok: false, error: 'case is required' });
  }
  try {
    const analysis = await ai.analyzeLostCase(c);
    res.json({ ok: true, analysis });
  } catch (err) {
    console.error('[analyze] lost-case (single) failed:', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /analyze/segregate — segregate a batch of leads into intent segments.
 * Body: { leads: [{id,name,status,buyingSpan,source,city,transcript}] }
 * Returns: { ok, results:[{id,segment,interest,reason}] }
 */
router.post('/segregate', requireApiKey, async (req, res) => {
  const leads = (req.body && req.body.leads) || [];
  if (!Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ ok: false, error: 'leads are required' });
  }
  try {
    const results = await ai.segregateLeads(leads);
    res.json({ ok: true, results });
  } catch (err) {
    console.error('[analyze] segregate failed:', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
