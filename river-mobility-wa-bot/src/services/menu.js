'use strict';

/**
 * Interactive menu definitions for the WhatsApp bot.
 * IDs are referenced by the webhook router (routes/webhook.js).
 */

// Main category list (shown on greeting or "menu").
const MAIN_MENU = {
  buttonText: 'Choose an option',
  sections: [
    {
      title: 'How can we help?',
      rows: [
        { id: 'menu_brochure', title: '📄 Get Brochure', description: 'Specs & features of our EVs' },
        { id: 'menu_pricing', title: '💰 Pricing & Offers', description: 'On-road price and current offers' },
        { id: 'menu_testride', title: '🏍️ Book a Test Ride', description: 'Schedule a ride near you' },
        { id: 'menu_booking', title: '📦 Booking Status', description: 'Track your existing booking' },
        { id: 'menu_advisor', title: '🧑‍💼 Talk to an Advisor', description: 'Connect with our team' },
      ],
    },
  ],
};

// Test-ride type choice (reply buttons).
const TESTRIDE_BUTTONS = [
  { id: 'tr_home', title: '🏠 Home Test Ride' },
  { id: 'tr_store', title: '🏪 Store Test Ride' },
];

// A compact "anything else?" follow-up offered after answering.
const FOLLOWUP_BUTTONS = [
  { id: 'menu_pricing', title: '💰 Pricing' },
  { id: 'menu_testride', title: '🏍️ Test Ride' },
  { id: 'menu_advisor', title: '🧑‍💼 Advisor' },
];

function isGreeting(text) {
  return /^\s*(hi+|hello+|hey+|start|menu|namaste|hola|hii|hlo)\b/i.test(text || '');
}

/**
 * Canned welcome text (no LLM). Two variants: personalized vs generic.
 * @param {string|null} firstName
 */
function welcomeText(firstName) {
  return firstName
    ? `Hi ${firstName}! 👋\nWelcome back to *Jasper Industries* 🚛\nHow can we help you today?`
    : `Hi there! 👋\nWelcome to *Jasper Industries* 🚛 — your trusted Tata commercial vehicle dealer since 1955.\nHow can we help you today?`;
}

module.exports = { MAIN_MENU, TESTRIDE_BUTTONS, FOLLOWUP_BUTTONS, isGreeting, welcomeText };
