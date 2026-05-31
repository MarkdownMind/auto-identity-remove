const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const originalLoad = Module._load.bind(Module);

function loadFormsWithNoopDeps() {
  function patchedLoad(request, parent, isMain) {
    if (!parent?.filename?.includes('/lib/forms.js')) return originalLoad(request, parent, isMain);
    if (request === './timing') return { jitterSleep: async () => {} };
    if (request === './modal-dismisser') return { dismissAllModals: async () => {} };
    if (request === './cloudflare-wait') return { waitForCloudflare: async () => {} };
    return originalLoad(request, parent, isMain);
  }

  Module._load = patchedLoad;
  const formsPath = require.resolve('../lib/forms');
  delete require.cache[formsPath];
  const forms = require('../lib/forms');
  Module._load = originalLoad;
  return forms;
}

test('performPreSteps handles click, fill, select, and mui-select actions', async () => {
  const { performPreSteps } = loadFormsWithNoopDeps();
  const actions = [];

  const targets = new Map([
    ['button.start', { click: async () => actions.push('click:start') }],
    ['input[name="first"]', { fill: async (value) => actions.push(`fill:first=${value}`) }],
    ['select[name="state"]', { selectOption: async (value) => actions.push(`select:state=${JSON.stringify(value)}`) }],
    ['div[role="combobox"]#state', { click: async () => actions.push('click:mui-open') }],
    ['li[data-value="ND"]', { click: async () => actions.push('click:mui-option') }],
  ]);

  const page = {
    locator: (selector) => ({
      first: () => ({
        count: async () => (targets.has(selector) ? 1 : 0),
        click: async () => targets.get(selector)?.click?.(),
        fill: async (value) => targets.get(selector)?.fill?.(value),
        selectOption: async (value) => targets.get(selector)?.selectOption?.(value),
      }),
    }),
  };

  await performPreSteps(page, [
    { action: 'click', selector: 'button.start' },
    { action: 'fill', selector: 'input[name="first"]', value: '{{firstName}}' },
    { action: 'select', selector: 'select[name="state"]', value: '{{state}}' },
    { action: 'mui-select', selector: 'div[role="combobox"]#state', value: '{{state}}' },
  ], { firstName: 'Ian', state: 'ND' });

  assert.deepEqual(actions, [
    'click:start',
    'fill:first=Ian',
    'select:state={"label":"ND"}',
    'click:mui-open',
    'click:mui-option',
  ]);
});

test('findListingUrl resolves templates and selects the city-matching listing button', async () => {
  const { findListingUrl } = loadFormsWithNoopDeps();
  const broker = {
    searchUrl: 'https://example.com/search?name={{fullName}}&state={{state}}',
    listingSelector: 'button:has-text("Proceed to Opt Out")',
    listingCityMatch: true,
    postListingForm: { formFields: { 'input[type="email"]': '{{email}}' } },
  };

  const candidates = [
    { text: 'Ian Yearsley — Bismarck, ND — Proceed to Opt Out', url: 'https://example.com/bad' },
    { text: 'Ian Yearsley — Mandan, ND — Proceed to Opt Out', url: 'https://example.com/good' },
  ];

  let visitedUrl = null;
  let currentUrl = 'https://example.com/start';
  let clickedIndex = -1;

  const page = {
    goto: async (url) => {
      visitedUrl = url;
      currentUrl = url;
    },
    locator: (selector) => {
      if (selector === broker.listingSelector) {
        return {
          count: async () => candidates.length,
          nth: (index) => ({
            evaluate: async () => candidates[index].text,
            click: async () => {
              clickedIndex = index;
              currentUrl = candidates[index].url;
            },
          }),
        };
      }
      return {
        first: () => ({ count: async () => 0, isVisible: async () => false }),
      };
    },
    waitForLoadState: async () => {},
    url: () => currentUrl,
  };

  const result = await findListingUrl(page, broker, {
    firstName: 'Ian',
    lastName: 'Yearsley',
    state: 'ND',
    city: 'Mandan',
  });

  assert.equal(visitedUrl, 'https://example.com/search?name=Ian%20Yearsley&state=ND');
  assert.equal(clickedIndex, 1, 'expected the Mandan listing to be selected');
  assert.deepEqual(result, {
    found: true,
    listingUrl: 'https://example.com/good',
    skipOptOutNavigation: true,
  });
});
