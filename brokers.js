/**
 * brokers.js — data broker opt-out definitions
 *
 * Each entry describes one broker and HOW to automate its opt-out.
 *
 * method:
 *   'search-form'  — search for the person, extract listing URL, submit opt-out
 *   'direct-form'  — go straight to the opt-out URL and fill the form
 *   'email'        — send a removal-request email
 *   'manual'       — too complex to automate; added to the printed manual list
 *
 * captchaLikely    — true = pre-attempt CapSolver before submit
 * priority         — 1 = highest (most commonly searched / highest risk)
 * timeoutMs        — optional per-broker navigation timeout in ms (default: 15000)
 *
 * No personal info lives here — all values come from config.json at runtime.
 */

let _cachedConfig = null;
function _getConfig() {
  if (_cachedConfig) return _cachedConfig;
  try {
    _cachedConfig = require('./config.json');
  } catch (_) {
    _cachedConfig = { person: {}, persons: [], email: {} };
  }
  return _cachedConfig;
}

const config = new Proxy({}, {
  get(_, prop) { return _getConfig()[prop]; },
});

const { firstName: F, lastName: L, fullName: N, state: ST, city: C, email: E, zip: Z } = new Proxy({}, {
  get(_, prop) { return (_getConfig().person || {})[prop]; },
});
const enc = s => encodeURIComponent(s);

module.exports = [

  // ═══ Priority 1 — California DELETE Act portal (covers all ~500 CA-registered brokers) ═══

  // CA DROP (Delete Request and Opt-out Platform) is not yet live as of late 2025.
  // SB 362 broker-side compliance deadline is August 1, 2026.
  // Keeping this entry as manual with the official CPPA registry landing page.
  {
    name: 'California DELETE Portal',
    optOutUrl: 'https://cppa.ca.gov/data_broker_registry/',
    method: 'manual',
    priority: 1,
    confidence: 'documented_not_live',
    usOnly: false,
    note: 'CA DROP delete portal is not yet live. SB 362 broker-side compliance deadline is August 1, 2026.',
    notes: 'CA DROP (Delete Request and Opt-out Platform) under SB 362 is not yet live. The broker-side compliance deadline is August 1, 2026. CPPA has missed several preceding milestones; ongoing litigation (Data Brokers Association v. Bonta) may further delay. Official registry: https://cppa.ca.gov/data_broker_registry/',
  },

  // ═══ Priority 1 — High-traffic people-search sites ═══════════════════════

  {
    name: 'Spokeo',
    method: 'search-form',
    searchUrl: `https://www.spokeo.com/search?q=${enc(N)}&type=pp&state=${ST}`,
    listingPattern: /spokeo\.com\/[^/]+\/[^/]+\/[^/]+-p\d+/i,
    optOutUrl: 'https://www.spokeo.com/optout',
    formFields: { 'input[name="email"]': E },
    submitSelector: 'button[type="submit"],input[type="submit"]',
    captchaLikely: false,
    priority: 1,
    usOnly: true,
    expectedSender: 'optout@spokeo.com',
  },

  {
    name: 'WhitePages',
    method: 'search-form',
    searchUrl: `https://www.whitepages.com/name/${enc(F)}-${enc(L)}/${ST}`,
    listingPattern: /whitepages\.com\/people\//i,
    optOutUrl: 'https://www.whitepages.com/suppression-requests',
    formFields: { 'input[name="name"]': N, 'input[name="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
    usOnly: true,
    expectedSender: 'noreply@whitepages.com',
  },

  {
    name: 'FastPeopleSearch',
    method: 'search-form',
    searchUrl: `https://www.fastpeoplesearch.com/name/${enc(F)}-${enc(L)}_${ST}`,
    listingPattern: /fastpeoplesearch\.com\/name\//i,
    optOutUrl: 'https://www.fastpeoplesearch.com/optout',
    formFields: { 'input[id="optout_name"],input[name*="name"]': N, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
    usOnly: true,
  },

  {
    name: 'TruePeopleSearch',
    method: 'direct-form',
    optOutUrl: 'https://www.truepeoplesearch.com/removal',
    formFields: { 'input[name*="name"],input[placeholder*="name" i]': N, 'input[type="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
    usOnly: true,
    expectedSender: 'noreply@truepeoplesearch.com',
  },

  {
    name: 'BeenVerified',
    method: 'manual',
    optOutUrl: 'https://www.beenverified.com/svc/optout/search',
    captchaLikely: true,
    priority: 1,
    usOnly: true,
    notes: 'Cloudflare challenge on load; current flow is search -> choose listing -> email verification, so this broker now needs manual handling.',
  },

  {
    name: 'Radaris',
    method: 'manual',
    searchUrl: `https://radaris.com/p/${enc(F)}/${enc(L)}/`,
    listingPattern: /radaris\.com\/p\//i,
    optOutUrl: 'https://radaris.com/radar/',
    timeoutMs: 30000,
    priority: 1,
    notes: 'The old /control/privacy URL now redirects to the Privacy Monitor search flow at /radar/, which is a multi-step search and removal process.',
  },

  {
    name: 'Intelius',
    method: 'manual',
    optOutUrl: 'https://www.intelius.com/optout',
    priority: 1,
    notes: 'The verified /optout page currently returns a site 404, so there is no live self-service form to automate here.',
  },

  {
    name: 'PeopleFinders',
    method: 'manual',
    optOutUrl: 'https://www.peoplefinders.com/opt-out',
    priority: 1,
    notes: 'The live privacy request form now asks for extra personal details (DOB, phone, address, state, consent) beyond this tool\'s available fields.',
  },

  {
    name: 'PeopleSmart',
    method: 'manual',
    optOutUrl: 'https://www.peoplesmart.com/svc/optout/search/contact_optouts',
    captchaLikely: true,
    priority: 1,
    notes: 'The old /optout-go URL is gone; the live page is a React search flow with name/city/state plus Turnstile before record selection.',
  },

  {
    name: 'MyLife',
    method: 'email',
    emailTo: 'privacy@mylife.com',
    optOutUrl: 'https://www.mylife.com/privacy-policy',
    priority: 1,
  },

  {
    name: 'Nuwber',
    method: 'manual',
    searchUrl: `https://nuwber.com/person/search?name=${enc(N)}&state=${ST}`,
    listingPattern: /nuwber\.com\/person\//i,
    optOutUrl: 'https://nuwber.com/removal/link',
    captchaLikely: true,
    priority: 1,
    notes: 'The live opt-out page now requires pasting a profile URL and then completing a separate email-removal step, so the old one-form automation no longer matches.',
  },

  {
    name: 'FamilyTreeNow',
    method: 'direct-form',
    optOutUrl: 'https://www.familytreenow.com/optout',
    formFields: {
      'select[name="RequestType"]': 'The person whose information is being opted out',
      'input[name="FirstName"],input[id="FirstName"]': F,
      'input[name="LastName"],input[id="LastName"]': L,
      'input[name="Email"],input[id="Email"]': E,
    },
    submitSelector: 'button[type="submit"]',
    captchaLikely: true,
    priority: 1,
    expectedSender: 'noreply@familytreenow.com',
  },

  {
    name: 'CheckPeople',
    method: 'direct-form',
    optOutUrl: 'https://checkpeople.com/opt-out',
    formFields: { 'input[name="requestorEmail"]': E, 'input[id="acknowledge"]': true },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
  },

  // ═══ Priority 2 — Additional people-search sites ══════════════════════════

  {
    name: 'ThatsThem',
    method: 'direct-form',
    optOutUrl: 'https://thatsthem.com/optout',
    formFields: { 'input[name="name"]': N, 'input[name="email"]': E },
    submitSelector: 'button[type="submit"]',
    captchaLikely: true,
    priority: 2,
    // No SSN/DOB gate — safe to submit arbitrary name/email for noise mode
    acceptsBogus: true,
  },

  {
    name: 'USPhonebook',
    method: 'direct-form',
    optOutUrl: 'https://www.usphonebook.com/removal',
    formFields: {
      'select[name="user-type"]': 'subject',
      'input[name="subject-firstname"]': F,
      'input[name="subject-lastname"]': L,
      'input[name="subject-email"]': E,
      'input[name="agreement"]': true,
    },
    submitSelector: '#BRP',
    captchaLikely: false,
    priority: 2,
    usOnly: true,
  },

  {
    name: 'PublicDataUSA',
    method: 'manual',
    optOutUrl: 'https://www.publicdatausa.com/remove.php',
    captchaLikely: true,
    priority: 2,
    usOnly: true,
    notes: 'Cloudflare blocks the live opt-out page before the form loads, so this broker currently needs manual handling.',
  },

  {
    name: 'SmartBackgroundChecks',
    method: 'direct-form',
    optOutUrl: 'https://www.smartbackgroundchecks.com/optout',
    formFields: { 'input[name="email"]': E, 'input[name="accept_terms"]': true },
    submitSelector: 'button[type="submit"]',
    captchaLikely: true,
    priority: 2,
  },

  {
    name: 'SearchPeopleFree',
    method: 'direct-form',
    optOutUrl: 'https://www.searchpeoplefree.com/opt-out',
    formFields: {
      'input[id="o_first"]': F,
      'input[id="o_last"]': L,
      'input[id="o_email"]': E,
      'input[id="o_terms"]': true,
    },
    submitSelector: '#o_submit',
    captchaLikely: true,
    priority: 2,
    // No SSN/DOB gate — safe to submit arbitrary name/email for noise mode
    acceptsBogus: true,
  },

  {
    name: 'PeopleSearchNow',
    method: 'direct-form',
    optOutUrl: 'https://www.peoplesearchnow.com/opt-out',
    formFields: {
      'select[name="user-type"]': 'subject',
      'input[name="subject-firstname"]': F,
      'input[name="subject-lastname"]': L,
      'input[name="subject-email"]': E,
      'input[name="agreement"]': true,
    },
    submitSelector: '#BRP',
    captchaLikely: true,
    priority: 2,
    // No SSN/DOB gate — safe to submit arbitrary name/email for noise mode
    acceptsBogus: true,
  },

  {
    name: 'InfoTracer',
    method: 'direct-form',
    optOutUrl: 'https://infotracer.com/optout/',
    formFields: {
      'input[name="InfoPay_Core_Components_OptOuts_DataRemovalServiceModel[fname]"]': F,
      'input[name="InfoPay_Core_Components_OptOuts_DataRemovalServiceModel[lname]"]': L,
      'select[name="InfoPay_Core_Components_OptOuts_DataRemovalServiceModel[state]"]': ST,
      'input[name="InfoPay_Core_Components_OptOuts_DataRemovalServiceModel[city]"]': C,
    },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 2,
    // No SSN/DOB gate — safe to submit arbitrary name/email for noise mode
    acceptsBogus: true,
  },

  {
    name: 'SocialCatfish',
    method: 'direct-form',
    optOutUrl: 'https://socialcatfish.com/opt-out/?id=request_optout',
    formFields: { 'input[name="firstname"]': F, 'input[name="lastname"]': L, 'input[name="email"]': E },
    submitSelector: 'button:has-text("Submit Now")',
    captchaLikely: true,
    priority: 2,
  },

  {
    name: 'NationalPublicData',
    method: 'manual',
    optOutUrl: 'https://nationalpublicdata.com/optout.html',
    priority: 2,
    notes: 'The live page is now a search/link-removal workflow, not a first-name/last-name/email form.',
  },

  {
    name: 'ClustrMaps',
    method: 'manual',
    optOutUrl: 'https://clustrmaps.com/bl/opt-out',
    priority: 2,
    notes: 'The verified opt-out URL currently fails DNS resolution in the browser.',
  },

  {
    name: 'PrivateRecords',
    method: 'manual',
    optOutUrl: 'https://www.privaterecords.net/api/helper/optOutLight/search',
    priority: 2,
    notes: 'The live flow starts with a search form (first/last/city/state) and then requires selecting a matching record before removal.',
  },

  // ═══ Priority 1 — Major upstream aggregators ══════════════════════════════
  // These feed many smaller sites — highest leverage opt-outs

  {
    name: 'Acxiom',
    method: 'manual',
    optOutUrl: 'https://www.acxiom.com/optout/',
    priority: 1,
    notes: 'The old isapps URL now redirects to a broader Acxiom contact form rather than a simple first/last/email/zip opt-out flow.',
  },

  {
    name: 'LexisNexis',
    method: 'manual',
    optOutUrl: 'https://optout.lexisnexis.com/',
    priority: 1,
    notes: 'The live suppression site is now a multi-step wizard that collects reason, identity, address history, and supporting details.',
  },

  {
    name: 'ZoomInfo',
    method: 'manual',
    optOutUrl: 'https://www.zoominfo.com/update-my-info',
    priority: 1,
    notes: 'The verified update-my-info URL currently returns a 404 page.',
  },

  {
    name: 'Clearbit',
    method: 'email',
    emailTo: 'privacy@clearbit.com',
    optOutUrl: 'https://clearbit.com/ccpa-opt-out',
    priority: 1,
  },

  // ═══ Additional people-search / data broker sites ════════════════════════

  {
    name: 'PeekYou',
    method: 'manual',
    optOutUrl: 'https://www.peekyou.com/about/contact/optout/',
    priority: 1,
    notes: 'The old opt-out URL now drops on the PeekYou homepage search flow instead of a dedicated opt-out form.',
  },

  {
    name: 'Addresses.com',
    method: 'manual',
    optOutUrl: 'https://www.addresses.com/optout.php',
    priority: 2,
    notes: 'The live URL now serves a 404/search page rather than an opt-out form.',
  },

  {
    name: 'AnyWho',
    method: 'manual',
    optOutUrl: 'https://www.spokeo.com/optout',
    priority: 2,
    notes: 'AnyWho now redirects into Spokeo\'s opt-out flow, which requires a record URL plus email and no longer matches the old first/last/email form.',
  },

  {
    name: 'TruthFinder',
    method: 'direct-form',
    optOutUrl: 'https://suppression.peopleconnect.us/login',
    formFields: { 'input[name="login-email"]': E, 'input[name="consent"]': true },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
  },

  {
    name: 'InstantCheckmate',
    method: 'direct-form',
    optOutUrl: 'https://suppression.peopleconnect.us/login',
    formFields: { 'input[name="login-email"]': E, 'input[name="consent"]': true },
    submitSelector: 'button[type="submit"]',
    captchaLikely: false,
    priority: 1,
    expectedSender: 'noreply@instantcheckmate.com',
  },

  {
    name: 'Spokeo (email)',
    method: 'email',
    emailTo: 'privacy@spokeo.com',
    priority: 2,
  },

  {
    name: 'Epsilon',
    method: 'manual',
    optOutUrl: 'https://www.epsilon.com/privacy/data-subject-rights-request',
    priority: 2,
    notes: 'The verified URL currently lands on a 404 page with a generic contact form, not a dedicated privacy request flow.',
  },

  {
    name: 'Oracle Data Cloud',
    method: 'manual',
    optOutUrl: 'https://datacloudoptout.oracle.com/',
    priority: 2,
    notes: 'The old Oracle Data Cloud opt-out URL now redirects to a contracts/info page with no consumer removal form.',
  },

  {
    name: 'Equifax (marketing)',
    method: 'manual',
    optOutUrl: 'https://www.equifax.com/privacy/opt-out/',
    priority: 2,
    notes: 'The verified Equifax marketing opt-out URL currently returns a 404 page.',
  },

  {
    name: 'Experian (marketing)',
    method: 'manual',
    optOutUrl: 'https://www.experian.com/privacy/opting_out',
    priority: 2,
    notes: 'The live page is now Experian\'s privacy policy content and no longer exposes a simple marketing opt-out form.',
  },

  {
    name: 'DataAxle',
    method: 'manual',
    optOutUrl: 'https://www.data-axle.com/privacy-policy/#optout',
    priority: 2,
    notes: 'The privacy policy currently embeds a marketing/contact form rather than a dedicated consumer opt-out form.',
  },

  // ═══ Email-based opt-outs ═════════════════════════════════════════════════

  {
    name: 'Pipl',
    method: 'email',
    emailTo: 'privacy@pipl.com',
    priority: 2,
  },

  // ═══ Manual-only (requires human interaction) ═════════════════════════════

  {
    name: 'Google — Results About You',
    method: 'manual',
    optOutUrl: 'https://myaccount.google.com/data-and-privacy',
    notes: 'Use "Results about you" to flag address/phone in search results.',
    priority: 1,
  },

  {
    name: 'Google — Outdated Content',
    method: 'manual',
    optOutUrl: 'https://search.google.com/search-console/remove-outdated-content',
    notes: 'Submit if any cached pages show your personal info.',
    priority: 3,
  },

  {
    name: 'CalPrivacy DROP',
    method: 'manual',
    optOutUrl: 'https://cppa.ca.gov/data_broker_registry/',
    notes: 'California one-stop opt-out: submits to all 4000+ registered CA data brokers. Submit once if you are a CA resident.',
    priority: 1,
  },

];
