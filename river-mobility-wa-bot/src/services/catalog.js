'use strict';

const salesforce = require('./salesforce');

/**
 * Vehicle catalog — read LIVE from the Salesforce `Vehicle` object (Automotive Cloud).
 * The dealership edits vehicles in Salesforce (name, price, image, brochure, Show In Bot,
 * sort order); Heroku is just middleware. Results are cached briefly so we don't query
 * Salesforce on every WhatsApp message.
 */
let _cache = null;
let _at = 0;
const TTL_MS = 5 * 60 * 1000; // refresh from Salesforce every 5 min

function formatPrice(v) {
  if (v == null) return 'Contact us';
  try {
    return '₹' + Number(v).toLocaleString('en-IN');
  } catch {
    return '₹' + v;
  }
}

async function load() {
  if (_cache && Date.now() - _at < TTL_MS) return _cache;
  const conn = await salesforce.getConnection();
  const res = await conn.query(
    'SELECT Id, Name, Image_URL__c, Brochure_URL__c, Bot_Description__c, MarketPrice ' +
      'FROM Vehicle WHERE Show_In_Bot__c = true ORDER BY Bot_Sort_Order__c NULLS LAST, Name'
  );
  const products = res.records.map((r) => {
    const price = formatPrice(r.MarketPrice);
    return {
      id: 'p_' + r.Id,
      name: r.Name,
      short: price,
      price,
      blurb: r.Bot_Description__c || '',
      specs: '',
      image: r.Image_URL__c || null,
      brochureUrl: r.Brochure_URL__c || null,
    };
  });
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  const sections = [
    {
      title: 'Our Vehicles',
      rows: products.slice(0, 10).map((p) => ({
        id: p.id,
        title: p.name.slice(0, 24),
        description: (p.short || '').slice(0, 72),
      })),
    },
  ];
  _cache = { products, byId, sections };
  _at = Date.now();
  return _cache;
}

/** Returns { products, byId, sections } from Salesforce (cached). */
async function getCatalog() {
  return load();
}

/** Force a refresh on the next call (e.g., after an edit in Salesforce). */
function invalidate() {
  _cache = null;
}

module.exports = { getCatalog, invalidate };
