const state = {
  config: null,
  runStatus: null,
  dashboard: [],
  history: [],
  logLines: [],
  eventSource: null,
  refreshTimer: null,
};

const els = {};

document.addEventListener('DOMContentLoaded', async () => {
  cacheElements();
  bindEvents();
  startLogStream();
  await refreshAll();
  state.refreshTimer = setInterval(refreshRunRelatedData, 5000);
});

function cacheElements() {
  els.navLinks = [...document.querySelectorAll('.nav-link')];
  els.sections = [...document.querySelectorAll('.section')];
  els.sectionTitle = document.getElementById('section-title');
  els.startRun = document.getElementById('start-run');
  els.stopRun = document.getElementById('stop-run');
  els.refreshAll = document.getElementById('refresh-all');
  els.clearLog = document.getElementById('clear-log');
  els.logStream = document.getElementById('log-stream');
  els.runStatusPill = document.getElementById('run-status-pill');
  els.runStatusDetail = document.getElementById('run-status-detail');
  els.personForm = document.getElementById('person-form');
  els.settingsForm = document.getElementById('settings-form');
  els.brokerGrid = document.getElementById('broker-grid');
  els.historyTableBody = document.getElementById('history-table-body');
  els.screenshotsGrid = document.getElementById('screenshots-grid');
  els.refreshScreenshots = document.getElementById('refresh-screenshots');
  els.toast = document.getElementById('toast');
  els.stats = {
    total: document.getElementById('stat-total'),
    success: document.getElementById('stat-success'),
    error: document.getElementById('stat-error'),
    pending: document.getElementById('stat-pending'),
  };
}

function bindEvents() {
  els.navLinks.forEach((button) => {
    button.addEventListener('click', () => setSection(button.dataset.section));
  });

  els.startRun.addEventListener('click', () => controlRun('start'));
  els.stopRun.addEventListener('click', () => controlRun('stop'));
  els.refreshAll.addEventListener('click', refreshAll);
  els.clearLog.addEventListener('click', () => {
    state.logLines = [];
    renderLogs();
  });
  els.refreshScreenshots.addEventListener('click', loadScreenshots);

  els.personForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveConfig('Person info saved');
  });

  els.settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveConfig('Settings saved');
  });
}

function setSection(sectionId) {
  els.navLinks.forEach((link) => link.classList.toggle('active', link.dataset.section === sectionId));
  els.sections.forEach((section) => section.classList.toggle('active', section.id === sectionId));
  const active = els.navLinks.find((link) => link.dataset.section === sectionId);
  els.sectionTitle.textContent = active ? active.textContent : 'Dashboard';
}

async function refreshAll() {
  await Promise.all([loadConfig(), loadState(), loadRunStatus(), loadScreenshots()]);
}

async function refreshRunRelatedData() {
  await Promise.all([loadRunStatus(), loadState()]);
}

async function loadConfig() {
  const data = await api('/api/config');
  state.config = data;
  fillPersonForm(data.person || {});
  fillSettingsForm(data.settings || {});
}

async function loadState() {
  const data = await api('/api/state');
  state.dashboard = data.dashboard || [];
  state.history = data.history || [];
  renderDashboard();
  renderHistory();
}

async function loadRunStatus() {
  const data = await api('/api/run/status');
  state.runStatus = data;
  renderRunStatus();
}

async function loadScreenshots() {
  const data = await api('/api/screenshots');
  renderScreenshots(data.files || []);
}

async function controlRun(action) {
  try {
    await api(`/api/run/${action}`, { method: 'POST' });
    showToast(action === 'start' ? 'Watcher started' : 'Watcher stop requested');
    await refreshRunRelatedData();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function saveConfig(successMessage) {
  const payload = {
    person: collectPersonForm(),
    settings: collectSettingsForm(),
  };
  try {
    state.config = await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    fillPersonForm(state.config.person || {});
    fillSettingsForm(state.config.settings || {});
    showToast(successMessage);
  } catch (error) {
    showToast(error.message, true);
  }
}

function fillPersonForm(person) {
  setValue(els.personForm, 'firstName', person.firstName || '');
  setValue(els.personForm, 'lastName', person.lastName || '');
  setValue(els.personForm, 'city', person.city || '');
  setValue(els.personForm, 'state', person.state || '');
  setValue(els.personForm, 'zip', person.zip || '');
  setValue(els.personForm, 'email', person.email || '');
  setValue(els.personForm, 'phone', person.phone || '');
  setValue(els.personForm, 'aliases', (person.aliases || []).join('\n'));
}

function fillSettingsForm(settings) {
  setValue(els.settingsForm, 'browserEngine', settings.browserEngine || 'camofox');
  setChecked(els.settingsForm, 'headed', Boolean(settings.headed));
  setValue(els.settingsForm, 'proxyServer', settings.proxyServer || '');
  setValue(els.settingsForm, 'proxyUsername', settings.proxyUsername || '');
  setValue(els.settingsForm, 'proxyPassword', settings.proxyPassword || '');
  setValue(els.settingsForm, 'capsolverApiKey', settings.capsolverApiKey || '');
  setValue(els.settingsForm, 'notificationWebhook', settings.notificationWebhook || '');
  setValue(els.settingsForm, 'notificationSms', settings.notificationSms || '');
  setValue(els.settingsForm, 'profileDir', settings.profileDir || '');
}

function collectPersonForm() {
  return {
    firstName: getValue(els.personForm, 'firstName'),
    lastName: getValue(els.personForm, 'lastName'),
    city: getValue(els.personForm, 'city'),
    state: getValue(els.personForm, 'state'),
    zip: getValue(els.personForm, 'zip'),
    email: getValue(els.personForm, 'email'),
    phone: getValue(els.personForm, 'phone'),
    aliases: splitAliases(getValue(els.personForm, 'aliases')),
  };
}

function collectSettingsForm() {
  return {
    browserEngine: getValue(els.settingsForm, 'browserEngine'),
    headed: getChecked(els.settingsForm, 'headed'),
    proxyServer: getValue(els.settingsForm, 'proxyServer'),
    proxyUsername: getValue(els.settingsForm, 'proxyUsername'),
    proxyPassword: getValue(els.settingsForm, 'proxyPassword'),
    capsolverApiKey: getValue(els.settingsForm, 'capsolverApiKey'),
    notificationWebhook: getValue(els.settingsForm, 'notificationWebhook'),
    notificationSms: getValue(els.settingsForm, 'notificationSms'),
    profileDir: getValue(els.settingsForm, 'profileDir'),
  };
}

function renderRunStatus() {
  const running = Boolean(state.runStatus && state.runStatus.running);
  els.runStatusPill.textContent = running ? 'Running' : 'Stopped';
  els.runStatusPill.className = `pill ${running ? 'pill-running' : 'pill-stopped'}`;
  els.runStatusDetail.textContent = running
    ? `PID ${state.runStatus.pid} · started ${formatTimestamp(state.runStatus.startedAt)}`
    : 'Ready to start watcher.js';
  els.startRun.disabled = running;
  els.stopRun.disabled = !running;
}

function renderDashboard() {
  const brokers = state.dashboard || [];
  const counts = brokers.reduce(
    (acc, broker) => {
      acc.total += 1;
      if (broker.status === 'success') acc.success += 1;
      if (broker.status === 'error') acc.error += 1;
      if (broker.status === 'pending' || broker.status === 'manual') acc.pending += 1;
      return acc;
    },
    { total: 0, success: 0, error: 0, pending: 0 }
  );

  els.stats.total.textContent = counts.total;
  els.stats.success.textContent = counts.success;
  els.stats.error.textContent = counts.error;
  els.stats.pending.textContent = counts.pending;

  els.brokerGrid.innerHTML = brokers
    .map(
      (broker) => `
        <article class="broker-tile broker-${escapeHtml(broker.status)}">
          <div class="broker-tile-header">
            <strong>${escapeHtml(broker.broker)}</strong>
            <span class="badge badge-${escapeHtml(broker.status)}">${escapeHtml(broker.status)}</span>
          </div>
          <div class="broker-meta">${escapeHtml(broker.rawStatus || 'pending')}</div>
          <p>${escapeHtml(broker.detail || 'No result recorded yet.')}</p>
          <div class="broker-footer">
            <span>Attempt: ${escapeHtml(formatCompactTimestamp(broker.lastAttempt))}</span>
            <span>Errors: ${escapeHtml(String(broker.consecutiveErrors || 0))}</span>
          </div>
        </article>
      `
    )
    .join('');
}

function renderHistory() {
  els.historyTableBody.innerHTML = (state.history || [])
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.broker)}</td>
          <td><span class="badge badge-${escapeHtml(normalizeBadge(row.lastResult))}">${escapeHtml(row.lastResult || 'pending')}</span></td>
          <td>${escapeHtml(formatCompactTimestamp(row.lastSuccess))}</td>
          <td>${escapeHtml(formatCompactTimestamp(row.lastAttempt))}</td>
          <td>${escapeHtml(String(row.consecutiveErrors || 0))}</td>
        </tr>
      `
    )
    .join('');
}

function renderScreenshots(files) {
  if (!files.length) {
    els.screenshotsGrid.className = 'screenshots-grid empty-state';
    els.screenshotsGrid.textContent = 'No screenshots found yet.';
    return;
  }
  els.screenshotsGrid.className = 'screenshots-grid';
  els.screenshotsGrid.innerHTML = files
    .slice(0, 12)
    .map(
      (file) => `
        <a class="shot-card" href="${encodeURI(file.url)}" target="_blank" rel="noreferrer">
          <img src="${encodeURI(file.url)}" alt="${escapeHtml(file.name)}" loading="lazy" />
          <div class="shot-meta">
            <strong>${escapeHtml(file.name)}</strong>
            <span>${escapeHtml(formatCompactTimestamp(file.modTime))}</span>
          </div>
        </a>
      `
    )
    .join('');
}

function startLogStream() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = new EventSource('/api/logs/stream');
  state.eventSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      const prefix = payload.stream === 'stderr' ? '[stderr]' : payload.stream === 'system' ? '[system]' : '[stdout]';
      state.logLines.push(`${formatTimestamp(payload.time)} ${prefix} ${payload.line}`);
      if (state.logLines.length > 500) state.logLines = state.logLines.slice(-500);
      renderLogs();
      applyLiveBrokerUpdate(payload.line);
    } catch (error) {
      console.error('log parse failed', error);
    }
  };
}

function renderLogs() {
  els.logStream.textContent = state.logLines.join('\n');
  els.logStream.scrollTop = els.logStream.scrollHeight;
}

function applyLiveBrokerUpdate(line) {
  const match = line.match(/\[(.+?)\]\s+([a-z_]+)(?:\s+—\s+(.*))?$/i);
  if (!match) return;
  const [, brokerName, rawStatus, detail = ''] = match;
  const found = state.dashboard.find((entry) => entry.broker === brokerName);
  const normalized = normalizeBadge(rawStatus);
  const next = {
    broker: brokerName,
    rawStatus,
    status: normalized,
    detail,
    consecutiveErrors: normalized === 'error' ? (found?.consecutiveErrors || 0) + 1 : 0,
    lastAttempt: new Date().toISOString(),
    lastSuccess: normalized === 'success' ? new Date().toISOString() : found?.lastSuccess,
  };
  if (found) {
    Object.assign(found, next);
  } else {
    state.dashboard.unshift(next);
  }
  renderDashboard();
}

function normalizeBadge(status) {
  if (['success'].includes(status)) return 'success';
  if (['manual', 'captcha_failed'].includes(status)) return 'manual';
  if (['skipped', 'notFound', 'not_found', 'preview'].includes(status)) return 'skipped';
  if (['pending_confirm', 'pending'].includes(status)) return 'pending';
  if (['error', 'dead', 'unverified'].includes(status)) return 'error';
  return 'pending';
}

function splitAliases(value) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getValue(form, name) {
  return form.elements.namedItem(name)?.value?.trim() || '';
}

function setValue(form, name, value) {
  const field = form.elements.namedItem(name);
  if (field) field.value = value;
}

function getChecked(form, name) {
  return Boolean(form.elements.namedItem(name)?.checked);
}

function setChecked(form, name, value) {
  const field = form.elements.namedItem(name);
  if (field) field.checked = Boolean(value);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.error || `Request failed: ${response.status}`);
  }
  return data;
}

function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatCompactTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function showToast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.className = `toast ${isError ? 'toast-error' : 'toast-success'}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.className = 'toast hidden';
  }, 2800);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
