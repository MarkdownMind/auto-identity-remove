'use strict';
/**
 * test/cloudflare-wait.test.js
 *
 * Unit tests for lib/cloudflare-wait.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  isCloudflareChallenge,
  isCloudflareError,
  hasHCaptcha,
  waitForCloudflare,
  waitForSubmitConfirmation,
  CloudflareError,
} = require('../lib/cloudflare-wait');

// ── Helper: build a mock Playwright page ─────────────────────────────────────

function makePage({ title = '', bodyText = '', elementCounts = {}, evalFn = null } = {}) {
  return {
    async title() { return title; },
    async evaluate(fn) {
      if (evalFn) return evalFn(fn);
      // Default: return bodyText for body.innerText calls, false for overlay check
      const src = fn.toString();
      if (src.includes('innerText')) return bodyText;
      if (src.includes('querySelector')) return false;
      return '';
    },
    locator(sel) {
      return {
        async count() {
          for (const [pattern, count] of Object.entries(elementCounts)) {
            if (sel.includes(pattern)) return count;
          }
          return 0;
        },
        first() {
          return { async isVisible() { return false; } };
        },
      };
    },
    async waitForTimeout() {},
    async waitForLoadState() {},
    keyboard: { async press() {} },
  };
}

// ── isCloudflareChallenge ─────────────────────────────────────────────────────

describe('isCloudflareChallenge', () => {
  test('returns true for "Just a moment" title', async () => {
    const page = makePage({ title: 'Just a moment...' });
    assert.strictEqual(await isCloudflareChallenge(page), true);
  });

  test('returns true for challenge body text', async () => {
    const page = makePage({ bodyText: 'Checking if the site connection is secure' });
    assert.strictEqual(await isCloudflareChallenge(page), true);
  });

  test('returns true when Turnstile iframe is present', async () => {
    const page = makePage({ elementCounts: { 'challenges.cloudflare.com': 1 } });
    assert.strictEqual(await isCloudflareChallenge(page), true);
  });

  test('returns false for a normal page', async () => {
    const page = makePage({ title: 'Spokeo Opt Out', bodyText: 'Enter your information' });
    assert.strictEqual(await isCloudflareChallenge(page), false);
  });

  test('returns false when page.title() throws', async () => {
    const page = {
      async title() { throw new Error('crashed'); },
      async evaluate() { return ''; },
      locator() { return { async count() { return 0; } }; },
    };
    assert.strictEqual(await isCloudflareChallenge(page), false);
  });
});

// ── isCloudflareError ─────────────────────────────────────────────────────────

describe('isCloudflareError', () => {
  test('returns true when CF error element is present', async () => {
    const page = makePage({ elementCounts: { 'cf-error': 1 } });
    assert.strictEqual(await isCloudflareError(page), true);
  });

  test('returns false on a normal page', async () => {
    const page = makePage({});
    assert.strictEqual(await isCloudflareError(page), false);
  });

  test('returns false when locator throws', async () => {
    const page = {
      locator() { throw new Error('crashed'); },
    };
    assert.strictEqual(await isCloudflareError(page), false);
  });
});

// ── hasHCaptcha ───────────────────────────────────────────────────────────────

describe('hasHCaptcha', () => {
  test('returns true when hcaptcha iframe is present', async () => {
    const page = makePage({ elementCounts: { 'hcaptcha.com': 1 } });
    assert.strictEqual(await hasHCaptcha(page), true);
  });

  test('returns false on normal page', async () => {
    const page = makePage({});
    assert.strictEqual(await hasHCaptcha(page), false);
  });
});

// ── waitForCloudflare ─────────────────────────────────────────────────────────

describe('waitForCloudflare', () => {
  test('returns immediately when no CF challenge is detected', async () => {
    const page = makePage({ title: 'Normal Page' });
    const start = Date.now();
    await waitForCloudflare(page, { timeout: 5000, pollMs: 50 });
    assert.ok(Date.now() - start < 500, 'Should return quickly when no challenge');
  });

  test('resolves when challenge clears before timeout', async () => {
    let callCount = 0;
    const page = {
      async title() {
        // Challenge on first call, cleared on second
        callCount++;
        return callCount === 1 ? 'Just a moment...' : 'Opt Out - WhitePages';
      },
      async evaluate() { return ''; },
      locator() { return { async count() { return 0; } }; },
      async waitForTimeout() {},
      async waitForLoadState() {},
    };

    await waitForCloudflare(page, { timeout: 5000, pollMs: 50 });
    assert.ok(callCount >= 2, 'Should have polled at least twice');
  });

  test('throws CloudflareError when challenge does not clear', async () => {
    const page = {
      async title() { return 'Just a moment...'; },
      async evaluate() { return ''; },
      locator() { return { async count() { return 0; } }; },
      async waitForTimeout() {},
      async waitForLoadState() {},
    };

    await assert.rejects(
      () => waitForCloudflare(page, { timeout: 150, pollMs: 50 }),
      (err) => err instanceof CloudflareError
    );
  });

  test('throws CloudflareError when CF error page detected', async () => {
    let callCount = 0;
    const page = {
      async title() { return callCount++ === 0 ? 'Just a moment...' : 'Error'; },
      async evaluate() { return ''; },
      locator(sel) {
        return {
          async count() {
            if (sel.includes('cf-error')) return 1; // error page
            return 0;
          },
        };
      },
      async waitForTimeout() {},
      async waitForLoadState() {},
    };

    await assert.rejects(
      () => waitForCloudflare(page, { timeout: 1000, pollMs: 50 }),
      (err) => err instanceof CloudflareError && err.message.includes('error page')
    );
  });
});

// ── waitForSubmitConfirmation ─────────────────────────────────────────────────

describe('waitForSubmitConfirmation', () => {
  test('confirms on "thank you" body text', async () => {
    const page = {
      async evaluate() { return 'thank you for submitting your request'; },
      locator() { return { first: () => ({ async isVisible() { return false; } }) }; },
      async waitForTimeout() {},
    };

    const result = await waitForSubmitConfirmation(page, { timeout: 200 });
    assert.strictEqual(result.confirmed, true);
    assert.ok(result.method.includes('text'));
  });

  test('confirms on "success" body text', async () => {
    const page = {
      async evaluate() { return 'your request was a success'; },
      locator() { return { first: () => ({ async isVisible() { return false; } }) }; },
      async waitForTimeout() {},
    };

    const result = await waitForSubmitConfirmation(page, { timeout: 200 });
    assert.strictEqual(result.confirmed, true);
  });

  test('confirms on visible success element', async () => {
    const page = {
      async evaluate() { return 'unrelated content'; },
      locator(sel) {
        return {
          first() {
            return {
              async isVisible() { return sel.includes('success'); },
            };
          },
        };
      },
      async waitForTimeout() {},
    };

    const result = await waitForSubmitConfirmation(page, { timeout: 200 });
    assert.strictEqual(result.confirmed, true);
    assert.ok(result.method.includes('selector'));
  });

  test('returns not confirmed on timeout', async () => {
    const page = {
      async evaluate() { return 'nothing relevant here'; },
      locator() { return { first: () => ({ async isVisible() { return false; } }) }; },
      async waitForTimeout() {},
    };

    const result = await waitForSubmitConfirmation(page, { timeout: 100 });
    assert.strictEqual(result.confirmed, false);
    assert.strictEqual(result.method, 'timeout');
  });

  test('uses custom text patterns', async () => {
    const page = {
      async evaluate() { return 'your account has been flagged for removal'; },
      locator() { return { first: () => ({ async isVisible() { return false; } }) }; },
      async waitForTimeout() {},
    };

    const result = await waitForSubmitConfirmation(page, {
      timeout: 200,
      textPatterns: ['flagged for removal'],
    });
    assert.strictEqual(result.confirmed, true);
  });

  test('CloudflareError is exported', () => {
    assert.ok(typeof CloudflareError === 'function');
    const err = new CloudflareError('test');
    assert.ok(err instanceof Error);
    assert.strictEqual(err.name, 'CloudflareError');
  });
});
