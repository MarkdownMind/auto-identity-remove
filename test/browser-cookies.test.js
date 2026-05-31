'use strict';
/**
 * test/browser-cookies.test.js
 *
 * Unit tests for lib/browser-cookies.js
 *
 * We test the pure helper functions (decryption, profile discovery, cookie
 * parsing) without needing a running browser or real browser databases.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const {
  TOP_50_SITES,
  decryptChromiumValue,
  chromiumKeyLinux,
  findFirefoxProfiles,
  readFirefoxCookies,
  chromiumBrowserDefs,
} = require('../lib/browser-cookies');

// ── TOP_50_SITES ─────────────────────────────────────────────────────────────

describe('TOP_50_SITES', () => {
  test('contains exactly 50 entries', () => {
    assert.strictEqual(TOP_50_SITES.length, 50);
  });

  test('all entries are https URLs', () => {
    for (const site of TOP_50_SITES) {
      assert.ok(site.startsWith('https://'), `Not https: ${site}`);
    }
  });

  test('contains expected popular sites', () => {
    const str = TOP_50_SITES.join(',');
    for (const expected of ['google.com', 'youtube.com', 'amazon.com', 'reddit.com']) {
      assert.ok(str.includes(expected), `Missing: ${expected}`);
    }
  });

  test('has no duplicates', () => {
    const unique = new Set(TOP_50_SITES);
    assert.strictEqual(unique.size, TOP_50_SITES.length);
  });
});

// ── chromiumKeyLinux ─────────────────────────────────────────────────────────

describe('chromiumKeyLinux', () => {
  test('returns a 16-byte Buffer', () => {
    const key = chromiumKeyLinux();
    assert.ok(Buffer.isBuffer(key));
    assert.strictEqual(key.length, 16);
  });

  test('is deterministic', () => {
    assert.deepStrictEqual(chromiumKeyLinux(), chromiumKeyLinux());
  });
});

// ── decryptChromiumValue ──────────────────────────────────────────────────────

describe('decryptChromiumValue', () => {
  // Build a known plaintext → ciphertext pair using the Linux "peanuts" key
  // so we can verify the decrypt function round-trips correctly.
  function encryptLinux(plaintext) {
    const key = chromiumKeyLinux();
    const iv  = Buffer.alloc(16, 0x20);
    // Add PKCS7 padding
    const padLen = 16 - (plaintext.length % 16);
    const padded = Buffer.concat([Buffer.from(plaintext), Buffer.alloc(padLen, padLen)]);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    const enc    = Buffer.concat([cipher.update(padded), cipher.final()]);
    return Buffer.concat([Buffer.from('v10'), enc]);
  }

  test('decrypts a known v10 value', () => {
    const key        = chromiumKeyLinux();
    const plaintext  = 'hello-cookie-value';
    const encrypted  = encryptLinux(plaintext);
    const decrypted  = decryptChromiumValue(encrypted, key);
    assert.strictEqual(decrypted, plaintext);
  });

  test('returns empty string for null/empty input', () => {
    const key = chromiumKeyLinux();
    assert.strictEqual(decryptChromiumValue(null, key), '');
    assert.strictEqual(decryptChromiumValue(Buffer.alloc(0), key), '');
    assert.strictEqual(decryptChromiumValue(Buffer.from('ab'), key), '');
  });

  test('returns plain string for non-v10 buffer (legacy unencrypted)', () => {
    const key = chromiumKeyLinux();
    const buf = Buffer.from('plain-text-value');
    const result = decryptChromiumValue(buf, key);
    assert.strictEqual(result, 'plain-text-value');
  });

  test('returns empty string on decryption error (bad key)', () => {
    const badKey    = Buffer.alloc(16, 0xff);
    const encrypted = encryptLinux('test');
    const result    = decryptChromiumValue(encrypted, badKey);
    assert.strictEqual(result, '');
  });
});

// ── findFirefoxProfiles ───────────────────────────────────────────────────────

describe('findFirefoxProfiles', () => {
  test('returns an array', () => {
    const profiles = findFirefoxProfiles();
    assert.ok(Array.isArray(profiles));
  });

  test('all returned paths end with cookies.sqlite', () => {
    const profiles = findFirefoxProfiles();
    for (const p of profiles) {
      assert.ok(p.endsWith('cookies.sqlite'), `Bad path: ${p}`);
    }
  });

  test('all returned paths exist on disk', () => {
    const profiles = findFirefoxProfiles();
    for (const p of profiles) {
      assert.ok(fs.existsSync(p), `Path not found: ${p}`);
    }
  });
});

// ── readFirefoxCookies ────────────────────────────────────────────────────────

describe('readFirefoxCookies', () => {
  test('returns empty array for non-existent path', () => {
    const result = readFirefoxCookies('/no/such/file.sqlite');
    assert.deepStrictEqual(result, []);
  });

  test('returns empty array for a non-sqlite file', () => {
    // Write a temp file with garbage content
    const tmp = path.join(os.tmpdir(), `not-sqlite-${Date.now()}.sqlite`);
    fs.writeFileSync(tmp, 'this is not a sqlite database', 'utf8');
    try {
      const result = readFirefoxCookies(tmp);
      assert.deepStrictEqual(result, []);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  });

  test('cookies from real Firefox profile have expected shape', () => {
    const profiles = findFirefoxProfiles();
    if (profiles.length === 0) {
      // No Firefox installed — skip
      return;
    }
    const cookies = readFirefoxCookies(profiles[0]);
    if (cookies.length === 0) return; // empty profile — skip

    const c = cookies[0];
    assert.ok(typeof c.name     === 'string', 'name should be string');
    assert.ok(typeof c.value    === 'string', 'value should be string');
    assert.ok(typeof c.domain   === 'string', 'domain should be string');
    assert.ok(typeof c.path     === 'string', 'path should be string');
    assert.ok(typeof c.secure   === 'boolean', 'secure should be boolean');
    assert.ok(typeof c.httpOnly === 'boolean', 'httpOnly should be boolean');
    assert.ok(typeof c.expires  === 'number', 'expires should be number');
  });
});

// ── chromiumBrowserDefs ───────────────────────────────────────────────────────

describe('chromiumBrowserDefs', () => {
  test('returns an array', () => {
    const defs = chromiumBrowserDefs();
    assert.ok(Array.isArray(defs));
  });

  test('each def has label and dir properties', () => {
    for (const def of chromiumBrowserDefs()) {
      assert.ok(typeof def.label === 'string', 'def.label should be string');
      assert.ok(typeof def.dir   === 'string', 'def.dir should be string');
    }
  });

  test('macOS defs include keychain entries', () => {
    if (process.platform !== 'darwin') return;
    for (const def of chromiumBrowserDefs()) {
      assert.ok(typeof def.keychain === 'string', `Missing keychain for ${def.label}`);
    }
  });
});

// ── warmUpCookies / importFromInstalledBrowsers ───────────────────────────────

describe('warmUpCookies', () => {
  test('completes without throwing on a mock context', async () => {
    const { warmUpCookies } = require('../lib/browser-cookies');

    const opened = [];
    const mockContext = {
      async newPage() {
        const mockPage = {
          async goto() {},
          async waitForTimeout() {},
          async close() {},
        };
        opened.push(mockPage);
        return mockPage;
      },
    };

    await warmUpCookies(mockContext, { parallel: 2, timeoutMs: 100, sites: ['https://a.com', 'https://b.com', 'https://c.com'] });
    assert.strictEqual(opened.length, 3, 'Should have opened 3 pages');
  });

  test('silently ignores page errors during warm-up', async () => {
    const { warmUpCookies } = require('../lib/browser-cookies');

    let errorCount = 0;
    const mockContext = {
      async newPage() {
        return {
          async goto() { throw new Error('Network error'); },
          async waitForTimeout() {},
          async close() {},
        };
      },
    };

    // Should not throw even though every page.goto() throws
    await warmUpCookies(mockContext, { parallel: 2, timeoutMs: 100, sites: ['https://x.com'] });
    assert.strictEqual(errorCount, 0); // no uncaught errors
  });
});

describe('importFromInstalledBrowsers', () => {
  test('returns a number', async () => {
    const { importFromInstalledBrowsers } = require('../lib/browser-cookies');

    const addedCookies = [];
    const mockContext = {
      async addCookies(cookies) { addedCookies.push(...cookies); },
    };

    const total = await importFromInstalledBrowsers(mockContext);
    assert.ok(typeof total === 'number', 'Should return a number');
    assert.ok(total >= 0, 'Should return non-negative count');
  });
});
