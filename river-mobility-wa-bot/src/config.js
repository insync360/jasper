'use strict';

require('dotenv').config();

/**
 * Central config, sourced from environment variables (Heroku config vars).
 * Never hardcode secrets. See .env.example for the full list.
 */
const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  whatsapp: {
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    wabaId: process.env.WHATSAPP_WABA_ID,
    appId: process.env.WHATSAPP_APP_ID,
    appSecret: process.env.WHATSAPP_APP_SECRET, // for webhook signature verification
    verifyToken: process.env.WEBHOOK_VERIFY_TOKEN,
    graphVersion: process.env.GRAPH_VERSION || 'v21.0',
    get graphBase() {
      return `https://graph.facebook.com/${this.graphVersion}`;
    },
  },

  // Shared secret protecting the /templates admin endpoints (Salesforce sends it).
  templatesApiKey: process.env.TEMPLATES_API_KEY,

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  },

  salesforce: {
    loginUrl: process.env.SF_LOGIN_URL || 'https://test.salesforce.com',
    instanceUrl: process.env.SF_INSTANCE_URL,
    clientId: process.env.SF_CLIENT_ID,
    clientSecret: process.env.SF_CLIENT_SECRET,
    // Mode 1: refresh token (durable)
    refreshToken: process.env.SF_REFRESH_TOKEN,
    // Mode 2: username/password (password + security token)
    username: process.env.SF_USERNAME,
    password: process.env.SF_PASSWORD,
    // Mode 3: direct access token (short-lived; local testing)
    accessToken: process.env.SF_ACCESS_TOKEN,
  },
};

module.exports = config;
