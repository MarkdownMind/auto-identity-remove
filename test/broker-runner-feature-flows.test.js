const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const originalLoad = Module._load.bind(Module);

function loadRunner(formsMock) {
  const logged = [];
  const recorded = { success: [], failure: [], pending: [] };

  const configMock = {
    shouldSkip: () => null,
    saveCheckpoint: () => {},
    stateKey: (name) => name,
    recordSuccess: (name) => recorded.success.push(name),
    recordFailure: (name) => recorded.failure.push(name),
    recordPendingConfirmation: (name) => recorded.pending.push(name),
  };

  function patchedLoad(request, parent, isMain) {
    if (!parent?.filename?.includes('broker-runner')) return originalLoad(request, parent, isMain);
    if (request === './config') return configMock;
    if (request === './logger') return { logResult: (name, status, detail) => logged.push({ name, status, detail }) };
    if (request === './forms') return formsMock;
    if (request === './captcha') return { detectAndSolveCaptcha: async () => true };
    if (request === './confirm') return { detectConfirmationRequired: async () => ({ pending: false, snippet: '' }) };
    if (request === './success') return { classifyPostSubmit: () => ({ outcome: 'success', snippet: 'ok' }) };
    if (request === './retry') return { withRetry: async (fn) => fn() };
    if (request === './timing') return { jitterSleep: async () => {} };
    if (request === './snapshot') return { captureSubmitSnapshot: async () => null };
    return originalLoad(request, parent, isMain);
  }

  Module._load = patchedLoad;
  const runnerPath = require.resolve('../lib/broker-runner');
  delete require.cache[runnerPath];
  const runner = require('../lib/broker-runner');
  Module._load = originalLoad;
  return { ...runner, logged, recorded };
}

test('search-form brokers use postListingForm when listing selection already reached the email form', async () => {
  let filledFields = null;
  let submittedSelector = null;
  let gotoCalled = false;

  const formsMock = {
    fillForm: async (_page, fields) => { filledFields = fields; },
    findListingUrl: async () => ({ found: true, listingUrl: 'https://example.com/profile', skipOptOutNavigation: true }),
    performPreSteps: async () => {},
    clickFirstMatching: async (_page, selector) => {
      submittedSelector = selector;
      return true;
    },
    resolveUrl: (value) => value,
  };

  const { configure, processBrokerWithPerson, recorded } = loadRunner(formsMock);
  configure({ dryRun: false, person: { firstName: 'Ian', lastName: 'Yearsley' }, capsolver: null });

  const broker = {
    name: 'BeenVerified',
    method: 'search-form',
    searchUrl: 'https://example.com/search',
    optOutUrl: 'https://example.com/optout',
    formFields: { 'input[name="ignored"]': 'ignored' },
    submitSelector: 'button[type="submit"]',
    postListingForm: {
      formFields: { 'input[type="email"]': '{{email}}' },
      submitSelector: 'button[type="submit"].post',
    },
  };

  const context = {
    newPage: async () => ({
      goto: async () => { gotoCalled = true; },
      locator: () => ({
        first: () => ({
          fill: async () => {},
          count: async () => 0,
          isVisible: async () => false,
        }),
      }),
      evaluate: async () => 'ok',
      close: async () => {},
    }),
  };

  await processBrokerWithPerson(context, broker, { email: 'ian@example.com' });

  assert.equal(gotoCalled, false, 'opt-out page should not be revisited once listing flow already opened the post-listing form');
  assert.deepEqual(filledFields, broker.postListingForm.formFields);
  assert.equal(submittedSelector, 'button[type="submit"].post');
  assert.deepEqual(recorded.success, ['BeenVerified']);
});

test('direct-form brokers run preSteps and tick consentSelector before submit', async () => {
  let preStepsArgs = null;
  let consentChecked = 0;
  let submittedSelector = null;

  const formsMock = {
    fillForm: async () => {},
    findListingUrl: async () => null,
    performPreSteps: async (_page, steps, person, extras) => {
      preStepsArgs = { steps, person, extras };
    },
    clickFirstMatching: async (_page, selector) => {
      submittedSelector = selector;
      return true;
    },
    resolveUrl: (value) => value,
  };

  const { configure, processBrokerWithPerson } = loadRunner(formsMock);
  const person = { firstName: 'Ian', lastName: 'Yearsley', email: 'ian@example.com' };
  configure({ dryRun: false, person, capsolver: null });

  const broker = {
    name: 'PeopleConnectBroker',
    method: 'direct-form',
    optOutUrl: 'https://example.com/optout',
    preSteps: [{ action: 'fill', selector: 'input[name="first"]', value: '{{firstName}}' }],
    consentSelector: 'input[name="consent"]',
    submitSelector: 'button[type="submit"]',
    formFields: { 'input[type="email"]': '{{email}}' },
  };

  const context = {
    newPage: async () => ({
      goto: async () => {},
      locator: (selector) => ({
        first: () => ({
          count: async () => (selector === 'input[name="consent"]' ? 1 : 0),
          isVisible: async () => selector === 'input[name="consent"]',
          check: async () => { consentChecked += 1; },
          click: async () => {},
          fill: async () => {},
        }),
      }),
      evaluate: async () => 'ok',
      close: async () => {},
    }),
  };

  await processBrokerWithPerson(context, broker, person);

  assert.deepEqual(preStepsArgs, {
    steps: broker.preSteps,
    person,
    extras: { listingUrl: null },
  });
  assert.equal(consentChecked, 1, 'consent checkbox should be checked exactly once');
  assert.equal(submittedSelector, 'button[type="submit"]');
});
