/**
 * lib/browser.js — Multi-engine browser launcher
 *
 * Returns a Playwright BrowserContext regardless of which engine is used.
 * Configure via config.json under the "browser" key.
 *
 * Engines:
 *   "camofox"   — Camoufox Firefox fork (C++-level fingerprint spoofing) — DEFAULT
 *   "stealth"   — playwright-extra + playwright-extra-plugin-stealth (Chromium JS stealth)
 *   "chrome"    — Real Google Chrome with your real user profile (cookies + logged-in sessions)
 *   "chromium"  — Playwright Chromium + handrolled stealth (lightest, no extra deps)
 *   "cdp"       — Attach to a running Chrome instance via Chrome DevTools Protocol
 *
 * config.json "browser" section (all keys optional):
 * {
 *   "engine":         "camofox",            // default — first-class option
 *   "cookiesFile":    "~/.camofox/cookies/cookies.txt",
 *   "profileDir":     "~/.camofox/profiles/auto-identity-remove",
 *   "camoufoxBinary": "/path/to/camoufox",  // custom Camoufox binary (optional)
 *   "proxy": {                              // optional proxy for camofox engine
 *     "server": "http://host:port",
 *     "username": "user",
 *     "password": "pass"
 *   },
 *   "block_webrtc":   true,                 // prevent WebRTC IP leaks (camofox, default: true)
 *   "enable_cache":   true,                 // browser-level disk cache (camofox, default: true)
 *   "block_images":   false,                // block image loads (camofox, default: false)
 *   "humanize":       true,                 // human-like mouse/timing (camofox, default: true)
 *   "geoip":          true,                 // auto-match locale/TZ to IP (camofox, default: true)
 *   "headed":         false,                // run headed (visible) browser window (default: false)
 *   "tracing":        false,                // record Playwright traces (camofox, default: false)
 *   "tracingDir":     "~/.camofox/traces",  // where to store trace .zip files
 *   "novnc":          false,                // [Linux only] launch noVNC so you can watch the headed browser in a web browser
 *   "novncPort":      6080,                 // [Linux only] noVNC web port (default: 6080)
 *   "chromeDataDir":  "~/Library/Application Support/Google/Chrome",
 *   "chromeBinary":   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
 *   "cdpUrl":         "http://localhost:9222"
 * }
 *
 * Camofox setup (one-time — runs automatically if binary missing):
 *   npm install camoufox-js playwright-core
 *   npx camoufox-js fetch      # downloads ~300MB Camoufox binary
 *   npm run setup              # convenience alias for above
 *
 * Cookie import (camofox engine):
 *   Export cookies from your browser as Netscape/cookies.txt format and place at
 *   ~/.camofox/cookies/cookies.txt  (or set browser.cookiesFile in config.json).
 *   Cookies are imported on every launch; storageState is persisted across runs.
 *
 * Captcha strategy:
 *   Camoufox's C++-level Firefox fingerprint spoofing bypasses most captchas.
 *   lib/captcha.js (CapSolver) is used only as a fallback when a captcha is
 *   explicitly detected after the page loads.
 *
 * Env vars respected:
 *   CAMOFOX_COOKIES_DIR          — dir for Netscape cookie files
 *   CAMOFOX_PROFILE_DIR          — dir for session persistence
 *   CAMOUFOX_EXECUTABLE_PATH     — path to custom Camoufox binary
 *   CAMOUFOX_EXECUTABLE          — alternate env name for custom binary
 *   CAMOFOX_EXECUTABLE_PATH      — alternate env name for custom binary
 *   CAMOFOX_CRASH_REPORT_ENABLED — set to 'false' to disable crash reporting (default: false)
 *   CAMOFOX_TRACING_DIR          — override trace output directory
 *
 * Headed browser:
 *   macOS/Windows: set browser.headed=true in config.json — the browser window opens natively.
 *   Linux (server): set browser.headed=true AND browser.novnc=true. This starts Xvfb + x11vnc +
 *     noVNC so you can watch the browser at http://localhost:6080/vnc.html in any web browser.
 *     Requires: sudo apt install xvfb x11vnc novnc  (or: npm run setup-novnc on Ubuntu/Debian)
 */

'use strict';

const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const crypto     = require('crypto');

// Disable camofox crash reporting by default unless the user explicitly opts in
if (!process.env.CAMOFOX_CRASH_REPORT_ENABLED) {
  process.env.CAMOFOX_CRASH_REPORT_ENABLED = 'false';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function getHostOS() {
  const p = process.platform;
  if (p === 'darwin') return 'macos';
  if (p === 'win32')  return 'windows';
  return 'linux';
}

/** Resolve playwright or playwright-core from local node_modules. */
function requirePlaywright(packageName = 'playwright') {
  try { return require(packageName); } catch (_) {}
  return require('playwright-core');
}

/** Decode percent-encoded proxy credentials (matches camofox server.js). */
function decodeProxyCredential(val) {
  if (!val) return val;
  try { return decodeURIComponent(val); } catch (_) { return val; }
}

/** Normalize Playwright proxy object — decode %-encoded credentials. */
function normalizeProxy(proxy) {
  if (!proxy) return proxy;
  return {
    ...proxy,
    username: decodeProxyCredential(proxy.username),
    password: decodeProxyCredential(proxy.password),
  };
}

// ─── Netscape cookie parser ───────────────────────────────────────────────────

/**
 * Parse a Netscape/cookies.txt file into Playwright cookie objects.
 * Handles #HttpOnly_ prefix lines (used by curl/wget exports).
 */
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

/** Import a Netscape cookies.txt into a Playwright context. No-ops if missing. */
async function importCookiesFile(context, cookiesFile) {
  if (!cookiesFile) return;
  const resolved = expandHome(cookiesFile);
  if (!fs.existsSync(resolved)) {
    console.log(`   ↳ No cookies file at ${resolved} — skipping import`);
    return;
  }
  try {
    const text    = fs.readFileSync(resolved, 'utf8');
    const cookies = parseNetscapeCookies(text);
    if (cookies.length > 0) {
      await context.addCookies(cookies);
      console.log(`   ↳ Imported ${cookies.length} cookies from ${resolved}`);
    }
  } catch (err) {
    console.warn(`   ⚠️  Cookie import failed: ${err.message}`);
  }
}

// ─── Session persistence (atomic storageState) ────────────────────────────────

/** Returns statePath if the file exists and is a valid storageState; else undefined. */
function resolveStorageState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && Array.isArray(parsed.cookies)) return statePath;
  } catch (_) {}
  return undefined;
}

/** Atomically persist the context's storage state so the next run picks it up. */
async function persistStorageState(context, statePath) {
  if (!statePath) return;
  const tmp = `${statePath}.tmp-${process.pid}`;
  try {
    await context.storageState({ path: tmp });
    fs.renameSync(tmp, statePath);
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (__) {}
  }
}

// ─── Playwright tracing ───────────────────────────────────────────────────────

/** Start a Playwright trace on the context (screenshots + snapshots). */
async function startTrace(context) {
  try {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  } catch (e) {
    console.warn(`   ⚠️  Tracing start failed: ${e.message}`);
  }
}

/** Stop tracing and save a timestamped .zip to tracingDir. Returns zip path or null. */
async function stopTrace(context, tracingDir) {
  if (!tracingDir) return null;
  const dir = expandHome(tracingDir);
  fs.mkdirSync(dir, { recursive: true });
  // sweep old traces if more than 20 (keep disk clean)
  try {
    const existing = fs.readdirSync(dir).filter(f => f.endsWith('.zip')).sort();
    while (existing.length >= 20) {
      fs.unlinkSync(path.join(dir, existing.shift()));
    }
  } catch (_) {}

  const ts      = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix  = crypto.randomBytes(3).toString('hex');
  const zipPath = path.join(dir, `trace-${ts}-${suffix}.zip`);
  try {
    await context.tracing.stop({ path: zipPath });
    console.log(`   ↳ Trace saved: ${zipPath}`);
    return zipPath;
  } catch (e) {
    console.warn(`   ⚠️  Tracing stop failed: ${e.message}`);
    return null;
  }
}

// ─── Camoufox binary auto-fetch ───────────────────────────────────────────────

/**
 * Check whether the Camoufox binary is installed.
 * If not, run `npx camoufox-js fetch` automatically (blocking).
 */
async function ensureCamoufoxBinary() {
  try {
    const { installedVerStr } = require('camoufox-js/dist/pkgman.js');
    installedVerStr(); // throws if not installed
    return; // already installed
  } catch (e) {
    if (!e.message.includes('Version information not found') &&
        !e.message.includes('not found') && !e.message.includes('Camoufox executable')) {
      throw e; // unexpected error
    }
  }

  console.log('📦 Camoufox binary not found — downloading now (one-time, ~300 MB)...');
  const { execSync } = require('child_process');
  try {
    execSync('npx camoufox-js fetch', {
      stdio: 'inherit',
      cwd:   path.join(__dirname, '..'),
    });
    console.log('✅ Camoufox binary installed.');
  } catch (e) {
    throw new Error(
      'Camoufox binary download failed. Please run manually:\n' +
      '  npx camoufox-js fetch\n' +
      `Error: ${e.message}`
    );
  }
}

// ─── VirtualDisplay (Linux Xvfb) + noVNC ─────────────────────────────────────

/**
 * On Linux, spin up Xvfb so Camoufox can run headless without a real display.
 * Returns { display, vd } or null on non-Linux / when Xvfb unavailable.
 */
async function maybeStartVirtualDisplay() {
  if (process.platform !== 'linux') return null;
  try {
    // ESM module — import dynamically
    const { VirtualDisplay } = await (async () => {
      try {
        return await import('camoufox-js/dist/virtdisplay.js');
      } catch (_) {
        return require('camoufox-js/dist/virtdisplay.js');
      }
    })();
    const vd      = new VirtualDisplay();
    const display = vd.get();
    console.log(`   ↳ Xvfb virtual display: ${display}`);
    return { vd, display };
  } catch (e) {
    // Xvfb not installed or not Linux — fall back to headless:true
    if (!e.message.includes('VirtualDisplayNotSupported') &&
        !e.message.includes('Cannot find') && !e.message.includes('spawn')) {
      console.warn(`   ⚠️  VirtualDisplay unavailable: ${e.message}`);
    }
    return null;
  }
}

/**
 * Start noVNC on Linux so a headed Xvfb session can be watched in a browser.
 * Requires: xvfb x11vnc novnc  (apt install xvfb x11vnc novnc)
 * Accessible at: http://localhost:<novncPort>/vnc.html
 *
 * Returns a cleanup() function that kills the spawned processes.
 */
function maybeStartNoVNC(display, novncPort) {
  if (process.platform !== 'linux' || !display) return () => {};

  const { spawn } = require('child_process');
  const port = novncPort || 6080;
  const vncPort = 5900 + parseInt((display.replace(':', '') || '1'), 10);

  const procs = [];

  function spawnSilent(cmd, args) {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore', detached: false });
      procs.push(p);
      p.on('error', () => {}); // ignore ENOENT — tool not installed
      return p;
    } catch (_) { return null; }
  }

  // x11vnc: expose Xvfb display over VNC
  spawnSilent('x11vnc', ['-display', display, '-forever', '-nopw', '-quiet', '-rfbport', String(vncPort)]);

  // Brief delay then start noVNC websocket proxy
  setTimeout(() => {
    spawnSilent('websockify', ['--web', '/usr/share/novnc', String(port), `localhost:${vncPort}`]);
    console.log(`   ↳ noVNC: http://localhost:${port}/vnc.html  (watch headed browser)`);
  }, 1000);

  return function cleanup() {
    for (const p of procs) {
      try { p.kill(); } catch (_) {}
    }
  };
}

// ─── Main launcher ────────────────────────────────────────────────────────────

/**
 * Launch a browser and return a Playwright BrowserContext.
 *
 * @param {object}   config             - Full config.json object
 * @param {boolean}  headless
 * @param {string}   fallbackProfileDir - Persistent profile dir (chromium/stealth/chrome engines)
 * @param {Function} buildStealthScript - Returns the stealth initScript string
 * @returns {Promise<import('playwright-core').BrowserContext>}
 */
async function launchBrowser(config, headless, fallbackProfileDir, buildStealthScript) {
  const browserCfg = config.browser || {};
  const engine     = (browserCfg.engine || 'camofox').toLowerCase();

  console.log(`🌐 Browser engine: ${engine}`);

  // ── Camofox: Camoufox Firefox fork — C++-level fingerprint spoofing ───────
  if (engine === 'camofox') {
    let launchOptions, firefox;
    try {
      ({ launchOptions } = require('camoufox-js'));
      ({ firefox }       = require('playwright-core'));
    } catch (e) {
      throw new Error(
        'Camofox engine requires camoufox-js and playwright-core.\n' +
        '  npm install camoufox-js playwright-core\n' +
        '  npx camoufox-js fetch\n' +
        `Original error: ${e.message}`
      );
    }

    // Ensure binary is downloaded (auto-fetches if missing)
    await ensureCamoufoxBinary();

    // ── Profile / session persistence ───────────────────────────────────────
    const profileDir = expandHome(
      browserCfg.profileDir ||
      process.env.CAMOFOX_PROFILE_DIR ||
      path.join(os.homedir(), '.camofox', 'profiles', 'auto-identity-remove')
    );
    fs.mkdirSync(profileDir, { recursive: true });
    const storageStatePath = path.join(profileDir, 'storage-state.json');

    // ── Cookies ─────────────────────────────────────────────────────────────
    const cookiesDir  = expandHome(
      process.env.CAMOFOX_COOKIES_DIR ||
      path.join(os.homedir(), '.camofox', 'cookies')
    );
    const cookiesFile = browserCfg.cookiesFile
      ? expandHome(browserCfg.cookiesFile)
      : path.join(cookiesDir, 'cookies.txt');

    // ── Custom binary (env vars or config) ──────────────────────────────────
    const executablePath = (
      process.env.CAMOUFOX_EXECUTABLE_PATH ||
      process.env.CAMOUFOX_EXECUTABLE ||
      process.env.CAMOFOX_EXECUTABLE_PATH ||
      browserCfg.camoufoxBinary ||
      ''
    ).trim() || undefined;

    // ── Proxy ────────────────────────────────────────────────────────────────
    const proxyCfg   = browserCfg.proxy || null;
    const launchProxy = proxyCfg ? normalizeProxy(proxyCfg) : undefined;

    // ── Feature flags (sensible defaults) ───────────────────────────────────
    const blockWebRTC  = browserCfg.block_webrtc  !== false; // default: true
    const enableCache  = browserCfg.enable_cache  !== false; // default: true
    const blockImages  = browserCfg.block_images  === true;  // default: false
    const humanize     = browserCfg.humanize      !== false; // default: true
    const geoip        = browserCfg.geoip         !== false; // default: true
    const tracingOn    = browserCfg.tracing        === true;  // default: false
    const headed       = browserCfg.headed          === true;  // default: false (headless)
    const novnc        = browserCfg.novnc           === true;  // Linux only
    const novncPort    = browserCfg.novncPort        || 6080;
    const tracingDir   = expandHome(
      browserCfg.tracingDir ||
      process.env.CAMOFOX_TRACING_DIR ||
      path.join(os.homedir(), '.camofox', 'traces')
    );

    console.log(`   ↳ Profile   : ${storageStatePath}`);
    console.log(`   ↳ Cookies   : ${cookiesFile}`);
    if (executablePath) console.log(`   ↳ Binary    : ${executablePath}`);
    if (launchProxy)    console.log(`   ↳ Proxy     : ${launchProxy.server}`);
    console.log(`   ↳ block_webrtc=${blockWebRTC} enable_cache=${enableCache} block_images=${blockImages} humanize=${humanize} geoip=${geoip} tracing=${tracingOn} headed=${headed}`);

    // ── VirtualDisplay (Linux Xvfb) + noVNC ────────────────────────────────
    // On macOS/Windows, headed=true just opens a native window — no Xvfb needed.
    // On Linux with headed=true we spin up Xvfb so Camoufox has a display,
    // and optionally noVNC so you can watch it in a web browser.
    let vdResult = null;
    let cleanupNoVNC = () => {};
    if (process.platform === 'linux' && (headed || !headless)) {
      vdResult = await maybeStartVirtualDisplay();
      if (vdResult && novnc) {
        cleanupNoVNC = maybeStartNoVNC(vdResult.display, novncPort);
      }
    }
    const vdDisplay  = vdResult ? vdResult.display : undefined;
    // On macOS/Windows: headed=true → headless=false for a native window
    const effectiveHeadless = vdDisplay
      ? false                              // Linux Xvfb: always non-headless
      : (headed ? false : headless);       // macOS/Windows: honour headed flag

    const options = await launchOptions({
      executable_path: executablePath,
      headless:        effectiveHeadless,
      os:               getHostOS(),
      humanize,
      enable_cache:     enableCache,
      block_webrtc:     blockWebRTC,
      block_images:     blockImages,
      geoip,
      ...(vdDisplay ? { virtual_display: vdDisplay } : {}),
      ...(launchProxy  ? { proxy: launchProxy }       : {}),
    });

    // Normalize proxy in options (camoufox may reconstruct it)
    if (options.proxy) options.proxy = normalizeProxy(options.proxy);

    const browser = await firefox.launch(options);

    // Kill VirtualDisplay and noVNC when browser closes
    if (vdResult || cleanupNoVNC) {
      browser.on('disconnected', () => {
        cleanupNoVNC();
        if (vdResult) try { vdResult.vd.kill(); } catch (_) {}
      });
    }

    const storageState = resolveStorageState(storageStatePath);
    const context = await browser.newContext({
      storageState,
      viewport:    { width: 1280, height: 900 },
      locale:      options.locale || 'en-US',
      timezoneId:  options.timezoneId,
      userAgent:   options.userAgent,
    });

    // Import bootstrap cookies (Netscape format) on top of any persisted session
    await importCookiesFile(context, cookiesFile);

    // Start Playwright trace if enabled
    if (tracingOn) await startTrace(context);

    // On close: persist session + stop trace
    context.on('close', () => {
      persistStorageState(context, storageStatePath).catch(() => {});
      if (tracingOn) stopTrace(context, tracingDir).catch(() => {});
    });

    return context;
  }

  // ── CDP: attach to an already-running Chrome ──────────────────────────────
  if (engine === 'cdp') {
    const { chromium } = requirePlaywright();
    const cdpUrl = browserCfg.cdpUrl || 'http://localhost:9222';
    console.log(`   ↳ Connecting via CDP at ${cdpUrl}`);
    const browser  = await chromium.connectOverCDP(cdpUrl);
    const contexts = browser.contexts();
    return contexts.length > 0 ? contexts[0] : browser.newContext();
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
    console.warn('   ⚠️  Chrome must be fully closed before launching here (single-process profile lock).');

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

  // ── Stealth: playwright-extra + stealth plugin ────────────────────────────
  if (engine === 'stealth') {
    let chromium;
    try {
      chromium = require('playwright-extra').chromium;
      const StealthPlugin = require('playwright-extra-plugin-stealth');
      chromium.use(StealthPlugin());
      console.log('   ↳ playwright-extra-plugin-stealth active');
    } catch (e) {
      console.warn(`   ⚠️  playwright-extra-plugin-stealth unavailable (${e.message}), falling back to handrolled stealth`);
      ({ chromium } = requirePlaywright());
    }

    fs.mkdirSync(fallbackProfileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(fallbackProfileDir, {
      headless,
      viewport: { width: 1280, height: 900 },
      args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    if (!context.__stealthPluginActive && buildStealthScript) {
      await context.addInitScript(buildStealthScript());
    }
    return context;
  }

  // ── chromium: existing behaviour + handrolled stealth ─────────────────────
  const { chromium } = requirePlaywright();

  fs.mkdirSync(fallbackProfileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(fallbackProfileDir, {
    headless,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  if (buildStealthScript) await context.addInitScript(buildStealthScript());
  return context;
}

module.exports = { launchBrowser };
