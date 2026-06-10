'use strict';

const express = require('express');
const config = require('./config');
const webhookRouter = require('./routes/webhook');
const sendRouter = require('./routes/send');
const templatesRouter = require('./routes/templates');
const catalogRouter = require('./routes/catalog');
const analyzeRouter = require('./routes/analyze');

const app = express();

// Health check
app.get('/', (_req, res) => {
  res.json({ service: 'river-mobility-wa-bot', status: 'ok', env: config.nodeEnv });
});

// Webhook needs the RAW body for signature verification -> mount raw parser before JSON.
app.use('/webhook', express.raw({ type: '*/*' }), webhookRouter);

// Everything else uses JSON. Allow larger bodies for base64 image uploads.
app.use(express.json({ limit: '12mb' }));
app.use('/send', sendRouter);
app.use('/templates', templatesRouter);
app.use('/catalog', catalogRouter);
app.use('/analyze', analyzeRouter);

// 404
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

app.listen(config.port, () => {
  console.log(`river-mobility-wa-bot listening on :${config.port} (${config.nodeEnv})`);
});
