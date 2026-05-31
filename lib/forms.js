/**
 * lib/forms.js
 *
 * Smart form filler + listing-URL discovery.
 *
 * International support: applyRegionAliases() expands a formFields map so that
 * values mapped to US state/zip selectors also get attempted against common
 * province/postal/postcode variants and a country <select>. fillForm() calls
 * this automatically when a `person` context is present.
 */

const { jitterSleep } = require('./timing');

let dismissAllModals = async () => {};
let waitForCloudflare = async () => {};

try {
  ({ dismissAllModals } = require('./modal-dismisser'));
} catch (_) {}

try {
  ({ waitForCloudflare } = require('./cloudflare-wait'));
} catch (_) {}

function buildTemplateContext(person = {}, extras = {}) {
  const firstName = person.firstName || '';
  const lastName = person.lastName || '';
  const fullName = person.fullName || [firstName, lastName].filter(Boolean).join(' ').trim();
  const city = person.city || '';
  const state = person.state || '';
  const zip = person.zip || person.postalCode || person.postcode || '';
  const email = person.email || '';
  const listingUrl = extras.listingUrl || person.listingUrl || person.profileUrl || '';

  return {
    ...person,
    ...extras,
    firstName,
    lastName,
    fullName,
    name: fullName,
    city,
    state,
    zip,
    email,
    listingUrl,
    profileUrl: extras.profileUrl || listingUrl,
    dobMonth: person.dobMonth || person.birthMonth || person.dob?.month || '',
    dobDay: person.dobDay || person.birthDay || person.dob?.day || '',
    dobYear: person.dobYear || person.birthYear || person.dob?.year || '',
    phone: person.phone || '',
    country: person.country || 'US',
  };
}

function resolveTemplateString(value, person, extras = {}, options = {}) {
  if (typeof value !== 'string') return value;
  const ctx = buildTemplateContext(person, extras);
  const encodeValues = Boolean(options.encodeValues);
  return value.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
    const resolved = ctx[key];
    if (resolved === undefined || resolved === null) return '';
    const asString = String(resolved);
    return encodeValues ? encodeURIComponent(asString) : asString;
  });
}

function resolveUrl(url, person, extras = {}) {
  return resolveTemplateString(url, person, extras, { encodeValues: true });
}

function resolveFormFields(formFields, person, extras = {}) {
  if (!formFields) return {};
  return Object.fromEntries(
    Object.entries(formFields).map(([selector, value]) => [selector, resolveTemplateString(value, person, extras)])
  );
}

function escapeCssAttributeValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Augment a formFields map for non-US users so that province/postal/postcode
 * selectors are tried in addition to the usual state/zip selectors, and a
 * country <select> is targeted when the person's country is non-US.
 *
 * For US users the map is returned unchanged (fast path, no allocation).
 *
 * This is a pure transform — no side effects, no Playwright calls.
 *
 * @param {Record<string,string>} formFields  Selector→value map
 * @param {{ country?: string, state?: string, zip?: string }} person  Person config
 * @returns {Record<string,string>}  Possibly-augmented map (new object for non-US)
 */
function applyRegionAliases(formFields, person) {
  const country = (person.country || 'US').toUpperCase();
  if (country === 'US') return formFields;

  const augmented = { ...formFields };

  // Find the value currently mapped to a state-style selector and also map it
  // to province/region selectors
  for (const [sel, val] of Object.entries(formFields)) {
    if (/state/i.test(sel)) {
      augmented[
        'input[name*="province" i],input[name*="region" i],input[placeholder*="province" i]'
      ] = val;
    }
    if (/zip/i.test(sel) || /postal/i.test(sel)) {
      augmented[
        'input[name*="postal" i],input[name*="postcode" i],input[placeholder*="postal" i],input[placeholder*="postcode" i]'
      ] = val;
    }
  }

  // Target a country <select> when present — try the full name, then the code
  augmented['select[name*="country" i]'] = country;

  return augmented;
}

/**
 * Keywords too generic for safe getByLabel() fallback.
 * 'first' matches 'First Observed Date', 'first_name_on_account', etc.
 * 'last'  matches 'Last Modified', 'Last Login', etc.
 * 'name'  matches 'Username', 'Company Name', 'File Name', etc.
 * 'address' matches 'Billing Address', 'IP Address', etc.
 * 'number' matches 'Order Number', 'Phone Number (hidden field)', etc.
 * Specific keywords like 'email', 'zip', 'phone', 'city' are safe to keep.
 */
const AMBIGUOUS_KEYWORDS = new Set(['first', 'last', 'name', 'middle', 'address', 'number']);

/**
 * Returns true when a keyword is too generic for a safe getByLabel() fallback.
 * @param {string} kw
 */
function isAmbiguousKeyword(kw) {
  return AMBIGUOUS_KEYWORDS.has((kw || '').toLowerCase());
}

/**
 * Extracts the substring-match keyword from a CSS attribute selector.
 * Returns null when no *="..." pattern is found.
 * @param {string} selector
 * @returns {string|null}
 */
function extractKeyword(selector) {
  const m = selector.match(/\*="([^"]+)"/);
  return m ? m[1] : null;
}

async function clickFirstMatching(page, selector) {
  const formScopedBtn = page.locator(`form ${selector}`).first();
  const btn = (await formScopedBtn.count().catch(() => 0)) > 0
    ? formScopedBtn
    : page.locator(selector).first();
  if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
    await btn.click();
    return true;
  }
  return false;
}

async function performPreSteps(page, preSteps = [], person, extras = {}) {
  for (const step of preSteps) {
    const action = step?.action;
    if (!action) continue;

    if (action === 'navigate' && step.url) {
      await page.goto(resolveUrl(step.url, person, extras), { waitUntil: 'domcontentloaded', timeout: 20000 });
      await waitForCloudflare(page, { timeout: 30_000, verbose: true });
      await dismissAllModals(page, 3);
      await jitterSleep(700, 1200);
      continue;
    }

    if (!step.selector) continue;
    const target = page.locator(step.selector).first();
    const resolvedValue = resolveTemplateString(step.value, person, extras);

    if ((await target.count().catch(() => 0)) === 0) continue;

    if (action === 'click') {
      await target.click().catch(() => {});
    } else if (action === 'fill') {
      if (resolvedValue !== undefined && resolvedValue !== null && resolvedValue !== '') {
        await target.fill(String(resolvedValue)).catch(() => {});
      }
    } else if (action === 'select') {
      if (resolvedValue !== undefined && resolvedValue !== null && resolvedValue !== '') {
        await target.selectOption({ label: String(resolvedValue) })
          .catch(() => target.selectOption(String(resolvedValue)))
          .catch(() => {});
      }
    } else if (action === 'mui-select') {
      if (resolvedValue !== undefined && resolvedValue !== null && resolvedValue !== '') {
        await target.click().catch(() => {});
        const valueSelector = `li[data-value="${escapeCssAttributeValue(resolvedValue)}"]`;
        const option = page.locator(valueSelector).first();
        if ((await option.count().catch(() => 0)) > 0) {
          await option.click().catch(() => {});
        } else {
          await page.locator(`li[role="option"]:has-text("${String(resolvedValue)}")`).first().click().catch(() => {});
        }
      }
    }

    await jitterSleep(250, 500);
  }
}

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textHasWholeWord(text, word) {
  return new RegExp(`\\b${escapeRegex(word)}\\b`, 'i').test(text);
}

function classifyLocationMatch(text, person) {
  const haystack = normalizeText(text);
  const city = normalizeText(person?.city || '');
  const state = normalizeText(person?.state || '');

  if (!city) return 2;
  if (!haystack.includes(city)) return 0;
  if (!state) return 1;
  return textHasWholeWord(haystack, state) ? 2 : 1;
}

async function selectListingFromPage(page, broker, person) {
  const buttons = page.locator(broker.listingSelector);
  const count = await buttons.count().catch(() => 0);
  if (count === 0) return null;

  let bestCandidate = null;
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    const text = await button.evaluate(el => {
      let node = el;
      for (let depth = 0; depth < 5 && node; depth += 1, node = node.parentElement) {
        const content = (node.innerText || node.textContent || '').trim();
        if (content) return content;
      }
      return (el.innerText || el.textContent || '').trim();
    }).catch(() => '');

    const score = broker.listingCityMatch ? classifyLocationMatch(text, person) : 1;
    if (!broker.listingCityMatch || score > 0) {
      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = { button, score };
      }
      if (score === 2) break;
    }
  }

  if (!bestCandidate) return null;

  await bestCandidate.button.click().catch(() => {});
  if (typeof page.waitForLoadState === 'function') {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }
  await waitForCloudflare(page, { timeout: 30_000, verbose: true });
  await dismissAllModals(page, 2);
  await jitterSleep(1200, 2200);

  return {
    found: true,
    listingUrl: typeof page.url === 'function' ? page.url() : null,
    skipOptOutNavigation: Boolean(broker.postListingForm),
  };
}

/**
 * Fill every field in `formFields` on `page`. When `person` is provided,
 * applyRegionAliases() is called first so non-US province/postal selectors are
 * also attempted. For US users there is zero overhead — the map is returned as-is.
 *
 * @param {import('playwright').Page} page
 * @param {Record<string,string>} formFields
 * @param {{ country?: string, state?: string, zip?: string }} [person]
 * @param {Record<string, string>} [extras]
 */
async function fillForm(page, formFields, person, extras = {}) {
  const resolved = resolveFormFields(formFields, person, extras);
  const fields = person ? applyRegionAliases(resolved, person) : resolved;

  for (const [selector, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;

    const selectors = selector.split(',').map(s => s.trim());
    let filled = false;
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible())) {
          const tag  = await el.evaluate(n => n.tagName.toLowerCase());
          const type = await el.evaluate(n => n.type || '');
          if (tag === 'select') {
            await el.selectOption({ label: String(value) }).catch(() => el.selectOption(String(value)));
          } else if (type === 'checkbox' || type === 'radio') {
            if (value === false || String(value).toLowerCase() === 'false') {
              await el.uncheck?.().catch(() => {});
            } else {
              await el.check();
            }
          } else {
            await el.fill(String(value));
          }
          filled = true;
          break;
        }
      } catch (_) {}
    }
    if (!filled && typeof value === 'string') {
      const kw = extractKeyword(selector);
      if (kw && !isAmbiguousKeyword(kw)) {
        // Escape regex metacharacters before constructing the RegExp so that
        // keywords like "na(me" do not cause a SyntaxError.
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await page.getByLabel(new RegExp(escaped, 'i')).first().fill(String(value)).catch(() => {});
      }
    }
  }
}

async function findListingUrl(page, broker, person, extras = {}) {
  await page.goto(resolveUrl(broker.searchUrl, person, extras), { waitUntil: 'domcontentloaded', timeout: 20000 });
  await waitForCloudflare(page, { timeout: 30_000, verbose: true });
  await dismissAllModals(page, 3);
  await jitterSleep(1500, 2500);

  if (Array.isArray(broker.preSteps) && broker.preSteps.length > 0) {
    await performPreSteps(page, broker.preSteps, person, extras);
    if (broker.submitSelector) {
      await clickFirstMatching(page, broker.submitSelector).catch(() => {});
      if (typeof page.waitForLoadState === 'function') {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      }
      await waitForCloudflare(page, { timeout: 30_000, verbose: true });
      await dismissAllModals(page, 2);
      await jitterSleep(1200, 2200);
    }
  }

  if (broker.listingSelector) {
    return selectListingFromPage(page, broker, person);
  }

  if (!broker.listingPattern) return null;

  // Pass both source and flags so the 'i' (and any other flags) on the original
  // RegExp are preserved inside page.evaluate. Passing only .source drops the flags
  // because new RegExp(src) without a second argument is case-sensitive.
  const links = await page.evaluate(({ src, flags }) => {
    const re = new RegExp(src, flags);
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(h => re.test(h));
  }, { src: broker.listingPattern.source, flags: broker.listingPattern.flags });
  return links[0] || null;
}

module.exports = {
  applyRegionAliases,
  buildTemplateContext,
  clickFirstMatching,
  extractKeyword,
  fillForm,
  findListingUrl,
  isAmbiguousKeyword,
  performPreSteps,
  resolveFormFields,
  resolveTemplateString,
  resolveUrl,
};
