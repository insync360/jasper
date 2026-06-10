'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

/**
 * Claude-powered AI layer for the bot.
 * Lazily instantiated so the app can boot without an API key (e.g. health checks).
 */
let _client = null;
function client() {
  if (!_client) {
    if (!config.anthropic.apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set');
    }
    _client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return _client;
}

/**
 * Convert conversation history into a valid Anthropic messages array:
 * merges consecutive same-role turns, drops leading assistant turns, and ensures
 * the sequence ends with a user turn.
 * @param {Array<{role:string, content:string}>} history
 */
function toMessages(history) {
  const msgs = [];
  for (const t of history || []) {
    const role = t.role === 'assistant' ? 'assistant' : 'user';
    if (!t.content) continue;
    if (msgs.length && msgs[msgs.length - 1].role === role) {
      msgs[msgs.length - 1].content += '\n' + t.content;
    } else {
      msgs.push({ role, content: t.content });
    }
  }
  while (msgs.length && msgs[0].role === 'assistant') msgs.shift();
  while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
  return msgs.length ? msgs : [{ role: 'user', content: 'Hello' }];
}

/**
 * Generate a conversational reply, with conversation memory.
 * @param {Array<{role:string,content:string}>} history  recent turns (ends with the current user msg)
 * @param {object} ctx  Optional grounding context (lead info).
 * @returns {Promise<string>}
 */
async function generateReply(history, ctx = {}) {
  const system = [
    'You are the WhatsApp assistant for Jasper Industries, an authorized Tata commercial-vehicle',
    'dealer in India (since 1955) — selling trucks, buses, pickups, vans and mini-trucks (the Ace range).',
    'Be warm, concise, and helpful. Use simple language. Keep replies short (WhatsApp-friendly).',
    'Help with: vehicle enquiries, brochures, pricing/EMI, test drives, booking status, service and delivery.',
    'If they want to talk to a person, or you cannot help, tell them to tap the "🧑‍💼 Talk to our team"',
    'button and our team will reach out here on WhatsApp. NEVER promise a phone call, never say you will',
    '"get someone on the line", and never invent commands (like "say Connect Me"), prices, or dates.',
    'Use the prior conversation for context. Suggest tapping "Main Menu" to browse vehicles or book.',
    ctx.contextNote ? `Context: ${ctx.contextNote}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const resp = await client().messages.create({
    model: config.anthropic.model,
    max_tokens: 500,
    system,
    messages: toMessages(history),
  });

  return resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/**
 * Classify free-text customer feedback into a structured result.
 * Used for delivery/payment surveys -> sentiment + routing.
 * @param {string} feedbackText
 * @returns {Promise<{sentiment:string, category:string, escalate:boolean, summary:string}>}
 */
async function classifyFeedback(feedbackText) {
  const resp = await client().messages.create({
    model: config.anthropic.model,
    max_tokens: 300,
    system:
      'You classify automobile-dealership customer feedback. ' +
      'Respond ONLY with a compact JSON object: ' +
      '{"sentiment":"positive|neutral|negative","category":"sales|service|delivery|payment|product|other",' +
      '"escalate":true|false,"summary":"one line"}. ' +
      'Set escalate=true for any dissatisfaction, complaint, or urgent issue.',
    messages: [{ role: 'user', content: feedbackText }],
  });

  const text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    return { sentiment: 'neutral', category: 'other', escalate: false, summary: text.slice(0, 140) };
  }
}

/**
 * AI lost-case analysis. Given aggregated + sampled lost-lead data from Salesforce,
 * returns a structured, actionable analysis for the sales team:
 *   { summary, topReasons:[{reason,count,pct,insight}], rootCauses:[..],
 *     recommendations:[{title,detail}], winBack:[{reason,approach}] }
 * @param {object} data { total, byReason:[{reason,count}], bySource:[{source,count}],
 *                         byBuyingSpan:[{span,count}], samples:[{reason,note,source,buyingSpan,city,ageDays}] }
 */
async function analyzeLostCases(data = {}) {
  const system = [
    'You are a senior sales analyst for Jasper Industries, an authorized Tata vehicle dealer in India.',
    'You analyze LOST sales leads (prospects who did not convert) to find why deals are lost and how to',
    'reduce and arrest future losses. Be specific, practical, and grounded ONLY in the data provided —',
    'never invent numbers. Quantify with the counts/percentages given. Indian auto-retail context (EMI,',
    'finance, exchange, competitors like Mahindra/Ashok Leyland/Eicher, on-road price, RTO).',
    'Respond ONLY with a compact JSON object, no markdown, of the exact shape:',
    '{"summary":"2-3 sentence executive summary",',
    '"topReasons":[{"reason":"","count":0,"pct":0,"insight":"why this happens + what it signals"}],',
    '"rootCauses":["deeper systemic cause", "..."],',
    '"recommendations":[{"title":"short action","detail":"concrete step the dealership can take","impact":"high|medium|low"}],',
    '"winBack":[{"reason":"a recoverable lost-reason","approach":"how to re-engage these specific leads"}]}',
    'LIMITS so the JSON stays complete: at most 6 topReasons, 5 rootCauses, 6 recommendations, 4 winBack.',
    'Keep each insight/detail/approach under ~40 words. Output valid, complete JSON only.',
  ].join('\n');

  // Use the fast Haiku model and a bounded output so the whole call finishes well within
  // Heroku's hard 30s request timeout (the LWC triggers this synchronously).
  const resp = await client().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2600,
    system,
    messages: [{ role: 'user', content: 'Lost-lead dataset (JSON):\n' + JSON.stringify(data) }],
  });

  let text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  // Strip ```json fences if the model added them.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    // Recovery: parse the outermost {...} object if there's surrounding text.
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s !== -1 && e > s) {
      try {
        return JSON.parse(text.slice(s, e + 1));
      } catch {
        /* fall through */
      }
    }
    return {
      summary: text.slice(0, 400),
      topReasons: [],
      rootCauses: [],
      recommendations: [],
      winBack: [],
    };
  }
}

/**
 * AI analysis of a SINGLE lost case (one lead). Returns a focused, actionable verdict:
 *   { verdict, recoverability:'High'|'Medium'|'Low', factors:[..], winBackAction, suggestedMessage }
 * @param {object} c { name, reason, note, source, buyingSpan, city, ageDays, vehicle? }
 */
async function analyzeLostCase(c = {}) {
  const system = [
    'You are a senior sales analyst for Jasper Industries, an authorized Tata vehicle dealer in India.',
    'Analyze ONE lost lead (a prospect who did not convert) and judge why it was likely lost and whether',
    'it can be recovered. Be specific and practical (Indian auto-retail: on-road price, RTO, EMI, finance,',
    'exchange, competitors like Mahindra/Ashok Leyland/Eicher). Ground your answer in the case data given.',
    'Respond ONLY with compact JSON, no markdown, of the exact shape:',
    '{"verdict":"one sentence: why this lead was most likely lost",',
    '"recoverability":"High|Medium|Low",',
    '"factors":["short factor","short factor"],',
    '"winBackAction":"the single best next step to recover this customer",',
    '"suggestedMessage":"a short, warm WhatsApp re-engagement message to this customer, under 40 words"}',
    'At most 3 factors. Keep it concise. Output valid, complete JSON only.',
  ].join('\n');

  const resp = await client().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    system,
    messages: [{ role: 'user', content: 'Lost lead (JSON):\n' + JSON.stringify(c) }],
  });

  let text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s !== -1 && e > s) {
      try {
        return JSON.parse(text.slice(s, e + 1));
      } catch {
        /* fall through */
      }
    }
    return { verdict: text.slice(0, 300), recoverability: 'Medium', factors: [], winBackAction: '', suggestedMessage: '' };
  }
}

/**
 * Segregate a batch of leads into intent segments based on their responses (conversation
 * transcript) and signals. Returns an array aligned by lead id:
 *   [{ id, segment:'Hot'|'Warm'|'Cold', interest:'short tag', reason:'one line' }]
 * @param {Array<object>} leads [{id,name,status,buyingSpan,source,city,transcript}]
 */
async function segregateLeads(leads = []) {
  const system = [
    'You are a sales analyst for Jasper Industries, an authorized Tata vehicle dealer in India.',
    'Segregate each enquiry lead into an intent segment using their conversation responses (transcript)',
    'and signals (status, buying timeframe, source). Indian auto-retail context (EMI, finance, exchange,',
    'on-road price, competitors). Definitions:',
    '- "Hot": ready to buy soon — strong intent, near-term timeframe, asked about booking/price/test drive.',
    '- "Warm": genuinely interested but still considering — needs nurturing/follow-up.',
    '- "Cold": low intent — just browsing, vague, or unresponsive.',
    'Use the transcript when present; otherwise infer from the signals. Be decisive.',
    'Respond ONLY with a compact JSON array, no markdown, one object per input lead, SAME order:',
    '[{"id":"<lead id>","segment":"Hot|Warm|Cold","interest":"short tag e.g. Harrier, needs EMI","reason":"<=12 words"}]',
    'Keep interest and reason very short so the JSON stays complete.',
  ].join('\n');

  const resp = await client().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 3500,
    system,
    messages: [{ role: 'user', content: 'Leads (JSON):\n' + JSON.stringify(leads) }],
  });

  let text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const s = text.indexOf('[');
    const e = text.lastIndexOf(']');
    if (s !== -1 && e > s) {
      try {
        return JSON.parse(text.slice(s, e + 1));
      } catch {
        /* fall through */
      }
    }
    return [];
  }
}

/**
 * Classify a free-text booking-cancellation reason into a category + a one-line summary.
 * @returns {Promise<{category:string, summary:string}>}
 */
async function classifyCancellation(text) {
  const resp = await client().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system:
      'You classify why a customer cancelled a vehicle booking at an Indian Tata dealership. ' +
      'Respond ONLY with compact JSON: {"category":"Price/Budget|Finance/Loan|Chose Competitor|' +
      'Delivery Delay|Changed Mind|Personal/Financial|Product Issue|Service Experience|Other",' +
      '"summary":"one short line"}.',
    messages: [{ role: 'user', content: text }],
  });
  let t = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    return { category: 'Other', summary: String(text || '').slice(0, 120) };
  }
}

module.exports = {
  generateReply,
  classifyFeedback,
  analyzeLostCases,
  analyzeLostCase,
  segregateLeads,
  classifyCancellation,
};
