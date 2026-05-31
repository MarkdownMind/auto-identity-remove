/**
 * lib/broker-runner.js
 *
 * Per-broker processing (`processBroker`) and email opt-outs
 * (`sendEmailOptOuts`). Verbatim logic from the monolith.
 *
 * The original closed over module-level `DRY_RUN`, `person`, and `capsolver`.
 * Here those are injected once via `configure({ dryRun, person, capsolver })`
 * before the run starts — preserving singleton semantics with no circular
 * requires (this module imports config/logger/forms/captcha; none import back).
 */

const { recordSuccess, recordPendingConfirmation, recordFailure, shouldSkip, saveCheckpoint, stateKey } = require('./config');
const { logResult } = require('./logger');
const forms = require('./forms');
const { detectAndSolveCaptcha } = require('./captcha');
const { detectConfirmationRequired } = require('./confirm');
const { classifyPostSubmit } = require('./success');
const { withRetry } = require('./retry');
const { jitterSleep } = require('./timing');
const { captureSubmitSnapshot } = require('./snapshot');
const { handleRadaris } = require('./broker-handlers/radaris');

const fillForm = forms.fillForm;
const findListingUrl = forms.findListingUrl;
const performPreSteps = forms.performPreSteps || (async () => {});
const resolveUrl = forms.resolveUrl || ((value) => value);
const clickFirstMatching = forms.clickFirstMatching || (async (page, selector) => {
  const formScopedBtn = page.locator(`form ${selector}`).first();
  const btn = (await formScopedBtn.count()) > 0
    ? formScopedBtn
    : page.locator(selector).first();
  if ((await btn.count()) > 0 && (await btn.isVisible())) {
    await btn.click();
    return true;
  }
  return false;
});

let opts = { dryRun: false, person: null, capsolver: null, noCapsolver: false, snapshot: false, personCount: 1 };

function configure(o) {
  opts = { ...opts, ...o };
}

async function setConsent(page, selector) {
  const input = page.locator(selector).first();
  if ((await input.count().catch(() => 0)) === 0 || !(await input.isVisible().catch(() => false))) {
    return false;
  }
  await input.check().catch(() => input.click().catch(() => {}));
  return true;
}

async function processBroker(context, broker) {
  return processBrokerWithPerson(context, broker, opts.person);
}

/**
 * processBrokerWithPerson — run a single broker opt-out with an explicitly
 * provided person object.  Used by noise mode to submit bogus records without
 * altering the global `opts.person`.
 *
 * @param {object} context  - Playwright browser context
 * @param {object} broker   - broker definition
 * @param {object} person   - person data to fill into the form
 */
async function processBrokerWithPerson(context, broker, person) {
  const key = stateKey(broker.name, person, opts.personCount);

  saveCheckpoint(key);

  const skip = shouldSkip(key);
  if (skip) {
    logResult(broker.name, 'skipped', skip.reason);
    return;
  }

  if (broker.usOnly && (person?.country || 'US') !== 'US') {
    logResult(broker.name, 'skipped', 'US-only broker — skipped for non-US user');
    return;
  }

  if (broker.method === 'manual') {
    logResult(broker.name, 'manual', broker.notes || broker.optOutUrl || '');
    return;
  }

  if (broker.method === 'email') {
    return;
  }

  // Custom handlers for sites with unique wizard flows
  if (broker.method === 'radaris') {
    return handleRadaris(context, broker, person, opts, key);
  }

  const page = await context.newPage();
  try {
    let listingUrl = null;
    let skipOptOutNavigation = false;
    let activeFormFields = broker.formFields || {};
    let activeSubmitSelector = broker.submitSelector;

    if (broker.method === 'search-form' && broker.searchUrl) {
      const listingResult = await findListingUrl(page, broker, person).catch(() => null);
      const normalized = typeof listingResult === 'string'
        ? { found: true, listingUrl: listingResult }
        : listingResult;

      if (!normalized?.found && !normalized?.listingUrl) {
        logResult(broker.name, 'notFound', 'Not listed - nothing to remove');
        await page.close();
        return;
      }

      listingUrl = normalized?.listingUrl || null;
      skipOptOutNavigation = Boolean(normalized?.skipOptOutNavigation);
      if (skipOptOutNavigation && broker.postListingForm) {
        activeFormFields = broker.postListingForm.formFields || {};
        activeSubmitSelector = broker.postListingForm.submitSelector || broker.submitSelector;
      }

      if (listingUrl) {
        console.log(`     🔗 Listing: ${String(listingUrl).slice(0, 70)}`);
      }
    }

    if (broker.method === 'url-params') {
      await withRetry(() => page.goto(resolveUrl(broker.optOutUrl, person), {
        waitUntil: 'domcontentloaded',
        timeout: broker.timeoutMs || 15000,
      }));
      logResult(broker.name, 'success', 'navigated to broker URL');
      recordSuccess(key);
      await page.close();
      return;
    }

    if (!skipOptOutNavigation) {
      await withRetry(() => page.goto(resolveUrl(broker.optOutUrl, person, { listingUrl }), {
        waitUntil: 'domcontentloaded',
        timeout: broker.timeoutMs || 15000,
      }));
      await jitterSleep(1200, 2200);

      if (Array.isArray(broker.preSteps) && broker.preSteps.length > 0) {
        await performPreSteps(page, broker.preSteps, person, { listingUrl });
        await jitterSleep(300, 700);
      }
    }

    if (listingUrl) {
      const urlSel = 'input[name*="url" i],input[placeholder*="url" i],input[placeholder*="link" i],input[name*="link" i],input[type="url"]';
      await page.locator(urlSel).first().fill(listingUrl).catch(() => {});
    }

    if (activeFormFields) {
      await fillForm(page, activeFormFields, person, { listingUrl });
      await jitterSleep(400, 800);
    }

    if (broker.consentSelector) {
      await setConsent(page, broker.consentSelector);
    }

    if (broker.captchaLikely) {
      if (opts.noCapsolver) {
        logResult(broker.name, 'manual', broker.optOutUrl || '');
        await page.close();
        return;
      }
      const solved = await detectAndSolveCaptcha(page, opts.capsolver);
      if (!solved) {
        logResult(broker.name, 'captcha_failed', broker.optOutUrl);
        recordFailure(key, 'captcha_failed');
        await page.close();
        return;
      }
    }

    if (opts.preview) {
      const fields = await page.evaluate(() =>
        [...document.querySelectorAll('input,select,textarea')]
          .map(el => ({ name: el.name || el.id, value: el.value, type: el.type }))
      );
      const fieldPairs = fields
        .filter(f => f.name && f.value)
        .map(f => `input[${f.name}]="${f.value}"`)
        .join(' ');
      const detail = `${fieldPairs}${fieldPairs ? ' ' : ''}→ would POST to ${broker.optOutUrl}`;
      logResult(broker.name, 'preview', detail);
      await page.close();
      return;
    }

    if (opts.dryRun) {
      logResult(broker.name, 'skipped', 'dry-run — form filled but not submitted');
      await page.close();
      return;
    }

    let snapshotFile = null;
    if (opts.snapshot) {
      snapshotFile = await captureSubmitSnapshot(page, broker.name);
    }

    if (activeSubmitSelector) {
      const clicked = await clickFirstMatching(page, activeSubmitSelector).catch(() => false);
      if (clicked) {
        await jitterSleep(1500, 2500);
      }
    }

    const body = await Promise.resolve().then(() => page.evaluate(() => document.body?.innerText || '')).catch(() => '');
    const confirm = await detectConfirmationRequired(page);
    const snapshotSuffix = snapshotFile ? ` [snapshot: ${snapshotFile}]` : '';
    if (confirm.pending) {
      logResult(broker.name, 'pending_confirm', (confirm.snippet || 'check your email to confirm') + snapshotSuffix);
      recordPendingConfirmation(key, confirm.snippet);
    } else {
      const { outcome, snippet } = classifyPostSubmit(body);
      if (outcome === 'failure') {
        logResult(broker.name, 'error', (snippet || 'form submission may have failed') + snapshotSuffix);
        recordFailure(key, 'error');
      } else if (outcome === 'success') {
        logResult(broker.name, 'success', snippet + snapshotSuffix);
        recordSuccess(key);
      } else {
        logResult(broker.name, 'unverified', 'no explicit confirmation - re-check next run' + snapshotSuffix);
      }
    }

  } catch (err) {
    const msg = err.message?.includes('Timeout') ? 'Timeout' : err.message?.slice(0, 80) || 'unknown';
    logResult(broker.name, 'error', msg);
    recordFailure(key, 'error');
  } finally {
    await page.close().catch(() => {});
    await jitterSleep(5000, 15000);
  }
}

module.exports = { configure, processBroker, processBrokerWithPerson };
