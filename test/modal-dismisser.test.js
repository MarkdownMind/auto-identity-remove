'use strict';
/**
 * test/modal-dismisser.test.js
 *
 * Unit tests for lib/modal-dismisser.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  CMP_SELECTORS,
  ACCEPT_TEXTS,
  tryClick,
  tryClickByText,
  dismissModals,
  dismissAllModals,
} = require('../lib/modal-dismisser');

// ── Constants ─────────────────────────────────────────────────────────────────

describe('CMP_SELECTORS', () => {
  test('is a non-empty array of strings', () => {
    assert.ok(Array.isArray(CMP_SELECTORS));
    assert.ok(CMP_SELECTORS.length > 0);
    for (const s of CMP_SELECTORS) {
      assert.strictEqual(typeof s, 'string');
      assert.ok(s.length > 0);
    }
  });

  test('includes OneTrust selector', () => {
    assert.ok(CMP_SELECTORS.some(s => s.includes('onetrust')));
  });

  test('includes CookieBot selector', () => {
    assert.ok(CMP_SELECTORS.some(s => s.includes('Cybot')));
  });
});

describe('ACCEPT_TEXTS', () => {
  test('is a non-empty array of lowercase strings', () => {
    assert.ok(Array.isArray(ACCEPT_TEXTS));
    assert.ok(ACCEPT_TEXTS.length > 0);
    for (const t of ACCEPT_TEXTS) {
      assert.strictEqual(t, t.toLowerCase(), `Should be lowercase: "${t}"`);
    }
  });

  test('includes common accept phrases', () => {
    assert.ok(ACCEPT_TEXTS.includes('accept all'));
    assert.ok(ACCEPT_TEXTS.includes('i agree'));
    assert.ok(ACCEPT_TEXTS.includes('got it'));
  });
});

// ── tryClick ──────────────────────────────────────────────────────────────────

describe('tryClick', () => {
  test('returns true when element is found and clicked', async () => {
    let clicked = false;
    const mockPage = {
      locator(sel) {
        return {
          first() {
            return {
              async waitFor() {},
              async click() { clicked = true; },
            };
          },
        };
      },
    };

    const result = await tryClick(mockPage, '#some-button', 500);
    assert.strictEqual(result, true);
    assert.strictEqual(clicked, true);
  });

  test('returns false when element is not found', async () => {
    const mockPage = {
      locator() {
        return {
          first() {
            return {
              async waitFor() { throw new Error('Timeout'); },
              async click() {},
            };
          },
        };
      },
    };

    const result = await tryClick(mockPage, '#nonexistent', 100);
    assert.strictEqual(result, false);
  });

  test('returns false when click throws', async () => {
    const mockPage = {
      locator() {
        return {
          first() {
            return {
              async waitFor() {},
              async click() { throw new Error('Element detached'); },
            };
          },
        };
      },
    };

    const result = await tryClick(mockPage, '#btn', 100);
    assert.strictEqual(result, false);
  });
});

// ── dismissModals ─────────────────────────────────────────────────────────────

describe('dismissModals', () => {
  function makeMockPage({ hasElement = false, hasOverlay = false } = {}) {
    return {
      locator(sel) {
        return {
          first() {
            return {
              async waitFor() {
                if (!hasElement) throw new Error('Not found');
              },
              async click() {},
              async isVisible() { return false; },
            };
          },
          async count() { return 0; },
        };
      },
      getByRole() {
        return {
          first() {
            return {
              async waitFor() { throw new Error('Not found'); },
              async click() {},
            };
          },
        };
      },
      async evaluate(fn) {
        if (hasOverlay) return true;
        return '';
      },
      keyboard: {
        async press() {},
      },
      async waitForTimeout() {},
    };
  }

  test('returns false when no modal is present', async () => {
    const page = makeMockPage({ hasElement: false, hasOverlay: false });
    const result = await dismissModals(page);
    assert.strictEqual(result, false);
  });

  test('returns true when CMP button is clicked', async () => {
    const page = makeMockPage({ hasElement: true });
    // Make the first CMP selector work
    let clickCount = 0;
    page.locator = (sel) => ({
      first: () => ({
        async waitFor() {},
        async click() { clickCount++; },
      }),
    });

    const result = await dismissModals(page);
    assert.strictEqual(result, true);
    assert.ok(clickCount > 0);
  });

  test('does not throw when page interaction errors', async () => {
    const brokenPage = {
      locator() { return { first: () => ({ async waitFor() { throw new Error(); }, async click() {} }) }; },
      getByRole() { return { first: () => ({ async waitFor() { throw new Error(); }, async click() {} }) }; },
      async evaluate() { throw new Error('Page crashed'); },
      keyboard: { async press() { throw new Error(); } },
      async waitForTimeout() {},
    };

    // Should not throw
    const result = await dismissModals(brokenPage);
    assert.strictEqual(result, false);
  });
});

describe('dismissAllModals', () => {
  test('runs up to maxRounds times', async () => {
    let callCount = 0;
    // Mock page where each call finds a modal (so it keeps going)
    const page = {
      locator(sel) {
        return {
          first() {
            return {
              async waitFor() { if (callCount >= 2) throw new Error('no more'); },
              async click() { callCount++; },
            };
          },
        };
      },
      getByRole() { return { first: () => ({ async waitFor() { throw new Error(); }, async click() {} }) }; },
      async evaluate() { return ''; },
      keyboard: { async press() {} },
      async waitForTimeout() {},
    };

    const dismissed = await dismissAllModals(page, 3);
    assert.ok(dismissed <= 3, 'Should not exceed maxRounds');
  });

  test('stops early when no modal found', async () => {
    let roundsRun = 0;
    const page = {
      locator() { return { first: () => ({ async waitFor() { roundsRun++; throw new Error('none'); }, async click() {} }) }; },
      getByRole() { return { first: () => ({ async waitFor() { throw new Error(); }, async click() {} }) }; },
      async evaluate() { return ''; },
      keyboard: { async press() {} },
      async waitForTimeout() {},
    };

    await dismissAllModals(page, 5);
    // Should stop after first failed round, not iterate all 5
    assert.ok(roundsRun < CMP_SELECTORS.length * 5, 'Should stop early');
  });
});
