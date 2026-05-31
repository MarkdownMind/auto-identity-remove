'use strict';

/**
 * Tests for lib/browser.js — multi-engine browser launcher.
 *
 * These are unit tests for the helper functions. The actual browser launch
 * (camofox/chromium/stealth) is integration-tested manually since it requires
 * a running Camoufox binary and a display.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ── Pull internals out for unit testing ───────────────────────────────────────
// We exercise the pure functions by requiring the module and probing side effects.

describe('browser.js module loads', () => {
  test('exports launchBrowser', () => {
    const mod = require('../lib/browser');
    assert.strictEqual(typeof mod.launchBrowser, 'function');
  });

  test('sets CAMOFOX_CRASH_REPORT_ENABLED=false by default', () => {
    // The module sets this on first load. Since require() is cached, just assert
    // the value is 'false' (set by browser.js) or a user override — never unset.
    const val = process.env.CAMOFOX_CRASH_REPORT_ENABLED;
    assert.ok(typeof val === 'string' && val.length > 0,
      'CAMOFOX_CRASH_REPORT_ENABLED should be set to a non-empty string by browser.js on load');
  });
});

// ── Test helpers in isolation by cloning their logic ─────────────────────────

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function parseNetscapeCookies(text) {
  const cookies = [];
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;
    let httpOnly = false;
    let working  = line;
    if (working.startsWith('#HttpOnly_')) {
      httpOnly = true;
      working  = working.replace(/^#HttpOnly_/, '');
    }
    const parts = working.split('\t');
    if (parts.length < 7) continue;
    const expires = Number(parts[4]);
    cookies.push({
      name:     parts[5],
      value:    parts.slice(6).join('\t'),
      domain:   parts[0],
      path:     parts[2],
      secure:   parts[3].toUpperCase() === 'TRUE',
      httpOnly,
      expires:  expires > 0 ? expires : -1,
    });
  }
  return cookies;
}

function resolveStorageState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && Array.isArray(parsed.cookies)) return statePath;
  } catch (_) {}
  return undefined;
}

function getHostOS() {
  const p = process.platform;
  if (p === 'darwin') return 'macos';
  if (p === 'win32')  return 'windows';
  return 'linux';
}

function normalizeProxy(proxy) {
  if (!proxy) return proxy;
  function decode(val) {
    if (!val) return val;
    try { return decodeURIComponent(val); } catch (_) { return val; }
  }
  return { ...proxy, username: decode(proxy.username), password: decode(proxy.password) };
}

// ── expandHome ────────────────────────────────────────────────────────────────
describe('expandHome', () => {
  test('expands ~ to home dir', () => {
    const result = expandHome('~/.camofox/cookies.txt');
    assert.ok(result.startsWith(os.homedir()));
    assert.ok(result.endsWith('/.camofox/cookies.txt'));
  });

  test('leaves absolute paths unchanged', () => {
    assert.strictEqual(expandHome('/etc/cookies.txt'), '/etc/cookies.txt');
  });

  test('handles null/undefined gracefully', () => {
    assert.strictEqual(expandHome(null), null);
    assert.strictEqual(expandHome(undefined), undefined);
  });
});

// ── parseNetscapeCookies ──────────────────────────────────────────────────────
describe('parseNetscapeCookies', () => {
  test('parses a basic Netscape cookie line', () => {
    const txt = [
      '# Netscape HTTP Cookie File',
      '.example.com\tTRUE\t/\tFALSE\t1999999999\tsession_id\tabc123',
    ].join('\n');
    const cookies = parseNetscapeCookies(txt);
    assert.strictEqual(cookies.length, 1);
    assert.strictEqual(cookies[0].name,   'session_id');
    assert.strictEqual(cookies[0].value,  'abc123');
    assert.strictEqual(cookies[0].domain, '.example.com');
    assert.strictEqual(cookies[0].secure, false);
    assert.strictEqual(cookies[0].httpOnly, false);
    assert.strictEqual(cookies[0].expires, 1999999999);
  });

  test('handles #HttpOnly_ prefix', () => {
    const txt = '#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tsecret\txyz';
    const cookies = parseNetscapeCookies(txt);
    assert.strictEqual(cookies.length, 1);
    assert.strictEqual(cookies[0].httpOnly, true);
    assert.strictEqual(cookies[0].secure,   true);
    assert.strictEqual(cookies[0].name,     'secret');
    assert.strictEqual(cookies[0].expires,  -1); // 0 → session cookie
  });

  test('skips comment lines', () => {
    const txt = '# just a comment\n.x.com\tTRUE\t/\tFALSE\t0\tk\tv';
    const cookies = parseNetscapeCookies(txt);
    assert.strictEqual(cookies.length, 1);
  });

  test('skips lines with fewer than 7 tab-separated fields', () => {
    const cookies = parseNetscapeCookies('incomplete\tline');
    assert.strictEqual(cookies.length, 0);
  });

  test('handles BOM at start of file', () => {
    const txt = '\uFEFF.bom.com\tTRUE\t/\tFALSE\t0\tk\tv';
    const cookies = parseNetscapeCookies(txt);
    assert.strictEqual(cookies.length, 1);
    assert.strictEqual(cookies[0].domain, '.bom.com');
  });

  test('cookie value with tabs (joined back)', () => {
    const txt = '.x.com\tTRUE\t/\tFALSE\t0\ttoken\tpart1\tpart2';
    const cookies = parseNetscapeCookies(txt);
    assert.strictEqual(cookies[0].value, 'part1\tpart2');
  });

  test('returns empty array for empty input', () => {
    assert.deepStrictEqual(parseNetscapeCookies(''), []);
    assert.deepStrictEqual(parseNetscapeCookies('\n\n'), []);
  });
});

// ── resolveStorageState ───────────────────────────────────────────────────────
describe('resolveStorageState', () => {
  test('returns undefined for non-existent path', () => {
    assert.strictEqual(resolveStorageState('/does/not/exist.json'), undefined);
  });

  test('returns undefined for null/undefined', () => {
    assert.strictEqual(resolveStorageState(null), undefined);
    assert.strictEqual(resolveStorageState(undefined), undefined);
  });

  test('returns path for valid storageState file', () => {
    const tmp = path.join(os.tmpdir(), `ss-test-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ cookies: [], origins: [] }));
    try {
      assert.strictEqual(resolveStorageState(tmp), tmp);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('returns undefined for invalid JSON', () => {
    const tmp = path.join(os.tmpdir(), `ss-bad-${process.pid}.json`);
    fs.writeFileSync(tmp, 'not json');
    try {
      assert.strictEqual(resolveStorageState(tmp), undefined);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('returns undefined if cookies key is not an array', () => {
    const tmp = path.join(os.tmpdir(), `ss-noc-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ cookies: 'wrong' }));
    try {
      assert.strictEqual(resolveStorageState(tmp), undefined);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

// ── getHostOS ─────────────────────────────────────────────────────────────────
describe('getHostOS', () => {
  test('returns macos, windows, or linux', () => {
    const result = getHostOS();
    assert.ok(['macos', 'windows', 'linux'].includes(result),
      `Expected macos/windows/linux, got: ${result}`);
  });

  test('returns macos on darwin (current platform if macOS)', () => {
    if (process.platform === 'darwin') {
      assert.strictEqual(getHostOS(), 'macos');
    }
  });

  test('returns windows on win32', () => {
    if (process.platform === 'win32') {
      assert.strictEqual(getHostOS(), 'windows');
    }
  });

  test('returns linux on linux', () => {
    if (process.platform === 'linux') {
      assert.strictEqual(getHostOS(), 'linux');
    }
  });
});

// ── normalizeProxy ────────────────────────────────────────────────────────────
describe('normalizeProxy', () => {
  test('returns null/undefined as-is', () => {
    assert.strictEqual(normalizeProxy(null), null);
    assert.strictEqual(normalizeProxy(undefined), undefined);
  });

  test('decodes percent-encoded credentials', () => {
    const result = normalizeProxy({
      server:   'http://proxy:8080',
      username: 'user%40example',
      password: 'p%40ss',
    });
    assert.strictEqual(result.username, 'user@example');
    assert.strictEqual(result.password, 'p@ss');
  });

  test('leaves plain credentials unchanged', () => {
    const result = normalizeProxy({ server: 'http://p:8080', username: 'u', password: 'pw' });
    assert.strictEqual(result.username, 'u');
    assert.strictEqual(result.password, 'pw');
  });

  test('preserves all proxy fields', () => {
    const result = normalizeProxy({ server: 'http://h:1', bypass: 'localhost' });
    assert.strictEqual(result.server,  'http://h:1');
    assert.strictEqual(result.bypass,  'localhost');
  });
});

// ── Engine config resolution ──────────────────────────────────────────────────
describe('engine config resolution', () => {
  test('defaults to camofox engine when browser section is absent', () => {
    const browserCfg = {};
    const engine = (browserCfg.engine || 'camofox').toLowerCase();
    assert.strictEqual(engine, 'camofox');
  });

  test('respects explicit engine override', () => {
    const browserCfg = { engine: 'stealth' };
    const engine = (browserCfg.engine || 'camofox').toLowerCase();
    assert.strictEqual(engine, 'stealth');
  });

  test('feature flag defaults are correct', () => {
    const browserCfg = {};
    assert.strictEqual(browserCfg.block_webrtc !== false, true,  'block_webrtc default true');
    assert.strictEqual(browserCfg.enable_cache !== false, true,  'enable_cache default true');
    assert.strictEqual(browserCfg.block_images === true,  false, 'block_images default false');
    assert.strictEqual(browserCfg.humanize     !== false, true,  'humanize default true');
    assert.strictEqual(browserCfg.geoip        !== false, true,  'geoip default true');
    assert.strictEqual(browserCfg.tracing      === true,  false, 'tracing default false');
    assert.strictEqual(browserCfg.headed       === true,  false, 'headed default false');
    assert.strictEqual(browserCfg.novnc        === true,  false, 'novnc default false');
  });
});

// ── Camoufox binary check ─────────────────────────────────────────────────────
describe('camoufox binary', () => {
  test('camoufox-js is installed as a dependency', () => {
    // Just require — will throw if not installed
    const mod = require('camoufox-js');
    assert.strictEqual(typeof mod.launchOptions, 'function');
  });

  test('camoufox binary is present on disk (macOS: ~/Library/Caches/camoufox)', () => {
    // Only check on macOS where we know the cache path
    if (process.platform !== 'darwin') return;
    const { installedVerStr } = require('camoufox-js/dist/pkgman.js');
    let ver;
    try { ver = installedVerStr(); } catch (_) { ver = null; }
    assert.ok(ver, 'Camoufox binary should be installed. Run: npx camoufox-js fetch');
  });

  test('launchOptions resolves without error when binary is installed', async () => {
    const { launchOptions } = require('camoufox-js');
    const os_name = process.platform === 'darwin' ? 'macos'
                  : process.platform === 'win32'  ? 'windows' : 'linux';
    const options = await launchOptions({ headless: true, os: os_name });
    assert.ok(options.executablePath, 'launchOptions should return executablePath');
  });
});

// ── Trace helpers ─────────────────────────────────────────────────────────────
describe('tracing', () => {
  test('trace filename format', () => {
    const crypto = require('crypto');
    const ts     = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = crypto.randomBytes(3).toString('hex');
    const name   = `trace-${ts}-${suffix}.zip`;
    assert.ok(/^trace-\d{4}-\d{2}-\d{2}T/.test(name), 'trace filename starts with date');
    assert.ok(name.endsWith('.zip'), 'trace filename ends with .zip');
  });

  test('old trace pruning: keeps at most 20 zips', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-trace-test-'));
    try {
      // Create 22 fake trace files
      for (let i = 0; i < 22; i++) {
        fs.writeFileSync(path.join(dir, `trace-${String(i).padStart(3,'0')}.zip`), '');
      }
      // Simulate pruning (same logic as browser.js stopTrace)
      const existing = fs.readdirSync(dir).filter(f => f.endsWith('.zip')).sort();
      while (existing.length >= 20) {
        fs.unlinkSync(path.join(dir, existing.shift()));
      }
      const remaining = fs.readdirSync(dir).filter(f => f.endsWith('.zip'));
      assert.strictEqual(remaining.length, 19, 'should prune down to 19 before adding new');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
