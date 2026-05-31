/**
 * lib/browser.js — Multi-engine browser launcher
 *
 * Returns a Playwright BrowserContext regardless of which engine is used.
 * Configure via config.json under the "browser" key.
 *
 * Engines:
 *   "chromium"  — Playwright Chromium + handrolled stealth (default, current behaviour)
 *   "stealth"   — playwright-extra + playwright-extra-plugin-stealth (comprehensive JS stealth)
 *   "chrome"    — Real Google Chrome with your real user profile (cookies + logged-in sessions)
 *   "camofox"   — Camoufox Firefox fork (C++-level fingerprint spoofing, best anti-detect)
 *   "cdp"       — Attach to a running Chrome instance via Chrome DevTools Protocol
 *
 * config.json example:
 * {
 *   "browser": {
 *     "engine": "camofox",
 *     "chromeDataDir": "~/Library/Application Support/Google/Chrome",
 *     "chromeBinary": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
 *     "cdpUrl": "http://localhost:9222"
 *   }
 * }
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Resolve Playwright (or playwright-core) from local node_modules or fallback
 * to the openclaw global install path.
 */
function requirePlaywright(packageName = 'playwright') {
  try {
    return require(packageName);
  } catch (_) {
    const fallback = path.join(os.homedir(), '.openclaw', 'plugins', 'node_modules', packageName);
    return require(fallback);
  }
}

/**
 * Launch a browser and return a Playwright BrowserContext.
 *
 * @param {object}   config             - Full config.json object
 * @param {boolean}  headless
 * @param {string}   profileDir         - App-owned persistent profile dir (chromium/stealth/chrome engines)
 * @param {Function} buildStealthScript - Returns the stealth initScript string (chromium/chrome engines)
 * @returns {Promise<import('playwright').BrowserContext>}
 */
async function launchBrowser(config, headless, profileDir, buildStealthScript) {
  const browserCfg = config.browser || {};
  const engine     = browserCfg.engine || 'chromium';

  console.log(`🌐 Browser engine: ${engine}`);

  // ── CDP: attach to an already-running Chrome ──────────────────────────────
  if (engine === 'cdp') {
    const { chromium } = requirePlaywright();
    const cdpUrl = browserCfg.cdpUrl || 'http://localhost:9222';
    console.log(`   ↳ Connecting via CDP at ${cdpUrl}`);
    const browser  = await chromium.connectOverCDP(cdpUrl);
    const contexts = browser.contexts();
    return contexts.length > 0 ? contexts[0] : browser.newContext();
  }

  // ── Camofox: Camoufox Firefox fork with C++-level fingerprint spoofing ───
  if (engine === 'camofox') {
    let NewBrowser, firefox;
    try {
      ({ NewBrowser } = require('camoufox-js'));
      ({ firefox }    = require('playwright-core'));
    } catch (e) {
      throw new Error(
        'Camofox engine requires camoufox-js and playwright-core. ' +
        'Run: npm install camoufox-js playwright-core\n' +
        'Then fetch the Camoufox binary: npx camoufox-js fetch\n' +
        `Original error: ${e.message}`
      );
    }

    const camofoxProfileDir = path.join(os.homedir(), '.camofox', 'profiles', 'auto-identity-remove');
    fs.mkdirSync(camofoxProfileDir, { recursive: true });

    console.log(`   ↳ Camoufox profile: ${camofoxProfileDir}`);

    // NewBrowser(playwright, headless, options, userDataDir) — returns a Playwright Browser
    const browser = await NewBrowser(
      { firefox },           // pass playwright-core's firefox engine
      headless,
      { geoip: true },       // auto-match locale/timezone to IP
      camofoxProfileDir      // persistent profile directory
    );

    const storageStatePath = path.join(camofoxProfileDir, 'storage_state.json');
    const storageState = fs.existsSync(storageStatePath) ? storageStatePath : undefined;

    const context = await browser.newContext({
      storageState,
      viewport: { width: 1280, height: 900 },
    });

    // Persist storage state (cookies + localStorage) when context closes
    context.on('close', async () => {
      try {
        const state = await context.storageState().catch(() => null);
        if (state) fs.writeFileSync(storageStatePath, JSON.stringify(state));
      } catch (_) {}
    });

    return context;
  }

  // ── Real Chrome: your actual Google Chrome profile (real cookies + logins) ─
  if (engine === 'chrome') {
    const { chromium } = requirePlaywright();

    const isMac = process.platform === 'darwin';
    const isWin = process.platform === 'win32';

    const defaultBinary = isMac
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : isWin
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : '/usr/bin/google-chrome';

    const defaultDataDir = isMac
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
      : isWin
      ? path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
      : path.join(os.homedir(), '.config', 'google-chrome');

    const executablePath = expandHome(browserCfg.chromeBinary || defaultBinary);
    const userDataDir    = expandHome(browserCfg.chromeDataDir || defaultDataDir);

    console.log(`   ↳ Binary : ${executablePath}`);
    console.log(`   ↳ Profile: ${userDataDir}`);
    console.warn('   ⚠️  Chrome must be fully closed before launching here (profile lock).');

    const context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless,
      viewport: { width: 1280, height: 900 },
      args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    if (buildStealthScript) await context.addInitScript(buildStealthScript());
    return context;
  }

  // ── Stealth: playwright-extra + stealth plugin (comprehensive JS stealth) ──
  if (engine === 'stealth') {
    let chromium;
    try {
      chromium = require('playwright-extra').chromium;
      const StealthPlugin = require('playwright-extra-plugin-stealth');
      chromium.use(StealthPlugin());
      console.log('   ↳ playwright-extra-plugin-stealth active');
    } catch (e) {
      console.warn(`   ⚠️  playwright-extra-plugin-stealth unavailable (${e.message}), falling back to chromium+handrolled stealth`);
      ({ chromium } = requirePlaywright());
    }

    fs.mkdirSync(profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1280, height: 900 },
      args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    // stealth plugin handles fingerprinting; only add handrolled script if plugin failed to load
    if (!context.__stealthPluginActive && buildStealthScript) {
      await context.addInitScript(buildStealthScript());
    }

    return context;
  }

  // ── Default: "chromium" — existing behaviour + handrolled stealth ──────────
  const { chromium } = requirePlaywright();

  fs.mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  if (buildStealthScript) await context.addInitScript(buildStealthScript());
  return context;
}

module.exports = { launchBrowser };
