const sessions = new Map();
const tabArmed = new Map();
const syncTimers = new Map();

function sessionStore() {
  return chrome.storage?.session || null;
}

function persistSession(session) {
  const store = sessionStore();
  if (!store || !session?.key) return;
  const write = store.set({ [`at-session:${session.key}`]: session });
  if (write?.catch) write.catch(() => {});
}

function persistArm(tabId, value) {
  const store = sessionStore();
  if (!store) return;
  const name = `at-arm:${tabId}`;
  const write = value ? store.set({ [name]: value }) : store.remove(name);
  if (write?.catch) write.catch(() => {});
}

async function restoreSessions() {
  const store = sessionStore();
  if (!store?.get) return;
  const all = await store.get(null);
  const now = Date.now();
  for (const [name, value] of Object.entries(all || {})) {
    if (name.startsWith('at-session:') && value?.key) {
      if (value.touched && now - value.touched > 6 * 60 * 60 * 1000) {
        store.remove(name).catch(() => {});
        continue;
      }
      if (!sessions.has(value.key)) sessions.set(value.key, value);
    } else if (name.startsWith('at-arm:') && value?.until > now) {
      const tabId = Number(name.slice('at-arm:'.length));
      if (!tabArmed.has(tabId)) tabArmed.set(tabId, value);
    }
  }
}

function isMailbox(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (/(^|\.)mail\.google\.com$/.test(host) || host === 'gmail.com' || host === 'inbox.google.com') return true;
    if (/(^|\.)outlook\.(live|office|office365)\.com$/.test(host) || host === 'outlook.cloud.microsoft') return true;
    if (/(^|\.)mail\.yahoo\./.test(host)) return true;
    if (host === 'mail.proton.me' || host === 'mail.protonmail.com' || host === 'app.proton.me') return true;
    if (/(^|\.)mail\.aol\.com$/.test(host) || /(^|\.)mail\.zoho\.com$/.test(host)) return true;
    if (/(^|\.)fastmail\.com$/.test(host) || host === 'app.hey.com' || /(^|\.)superhuman\.com$/.test(host)) return true;
    if (host === 'www.icloud.com' && /^\/mail(\/|$)/.test(parsed.pathname)) return true;
    if (/^webmail\./.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

function isEmbedUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const path = parsed.pathname;
    if (/(^|\.)recaptcha\.net$/i.test(host)) return true;
    if (/(^|\.)google\.com$/i.test(host) && /recaptcha/i.test(path)) return true;
    if (/(^|\.)gstatic\.com$/i.test(host)) return true;
    if (/(^|\.)hcaptcha\.com$/i.test(host)) return true;
    if (/(^|\.)cloudflare\.com$/i.test(host) && /challenge|turnstile/i.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

function cleanUrl(url) {
  try {
    const parsed = new URL(url);
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function fullJobUrl(url) {
  const cleaned = cleanUrl(url);
  if (!cleaned || isEmbedUrl(cleaned) || isMailbox(cleaned)) return '';
  try {
    const parsed = new URL(cleaned);
    if (/(^|\.)greenhouse\.io$/i.test(parsed.hostname) && /\/embed\/job_app/i.test(parsed.pathname)) {
      const board = parsed.searchParams.get('for') || '';
      const token = parsed.searchParams.get('token') || '';
      if (/^[\w.-]+$/.test(board) && /^[\w.-]+$/.test(token)) {
        return `https://job-boards.greenhouse.io/${board}/jobs/${token}`;
      }
    }
    if (!parsed.pathname || parsed.pathname === '/') return '';
    return cleaned;
  } catch {
    return '';
  }
}

function urlRank(url) {
  if (!url) return 0;
  try {
    const host = new URL(url).hostname;
    if (/(^|\.)greenhouse\.io$/i.test(host) && /\/jobs\/[^/?#]+/i.test(url)) return 100;
    if (/(^|\.)greenhouse\.io$/i.test(host)) return 90;
    if (/(^|\.)lever\.co$/i.test(host) || /myworkdayjobs\.com$/i.test(host) || /(^|\.)ashbyhq\.com$/i.test(host)) return 80;
  } catch {
    return 0;
  }
  return 10;
}

async function jobPageUrl(sender, message) {
  const urls = [];
  if (sender?.tab?.url) urls.push(sender.tab.url);
  if (message?.url) urls.push(String(message.url));
  if (sender?.tab?.id != null) {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: sender.tab.id });
      for (const frame of frames || []) {
        if (frame.url) urls.push(frame.url);
      }
    } catch {
      // The tab URL is still available when frame lookup is blocked.
    }
  }
  let best = '';
  let bestRank = 0;
  for (const candidate of urls) {
    const cleaned = fullJobUrl(candidate);
    const score = urlRank(cleaned);
    if (score > bestRank) {
      best = cleaned;
      bestRank = score;
    }
  }
  return best;
}

function pageKey(url) {
  try {
    const parsed = new URL(url);
    if (/(^|\.)applytojob\.com$/i.test(parsed.hostname)) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      const applyAt = parts.findIndex((part) => part.toLowerCase() === 'apply');
      if (applyAt >= 0) {
        const rest = parts.slice(applyAt + 1);
        const id = rest[0]?.toLowerCase() === 'confirm' ? rest[1] : rest[0];
        if (id && /^[A-Za-z0-9_-]+$/.test(id)) return `${parsed.origin}/apply/${id}`;
      }
    }
    const path = parsed.pathname.replace(/\/$/, '');
    return `${parsed.origin}${path}`;
  } catch {
    return '';
  }
}

function sessionKey(tabId, url) {
  return `${tabId}::${pageKey(url)}`;
}

function forgetTab(tabId) {
  const prefix = `${tabId}::`;
  const store = sessionStore();
  for (const key of [...sessions.keys()]) {
    if (!String(key).startsWith(prefix)) continue;
    sessions.delete(key);
    if (store) store.remove(`at-session:${key}`).catch(() => {});
  }
  tabArmed.delete(tabId);
  if (store) store.remove(`at-arm:${tabId}`).catch(() => {});
  syncTimers.delete(tabId);
}

chrome.tabs?.onRemoved?.addListener(forgetTab);

function usableTitle(title) {
  const value = String(title || '').trim();
  if (!value || /recaptcha|hcaptcha|turnstile/i.test(value)) return '';
  return value;
}

function ensureSession(tabId, url, title) {
  const key = sessionKey(tabId, url);
  const nextTitle = usableTitle(title);
  let session = sessions.get(key);
  if (!session || session.closed) {
    session = {
      id: crypto.randomUUID(),
      key,
      pageKey: pageKey(url),
      url: url || '',
      title: nextTitle,
      fields: {},
      closed: false,
      touched: Date.now(),
    };
    sessions.set(key, session);
  } else {
    session.url = url || session.url;
    session.title = nextTitle || usableTitle(session.title);
    session.touched = Date.now();
  }
  persistSession(session);
  return session;
}

function latestOpenSession(tabId) {
  const prefix = `${tabId}::`;
  let latest = null;
  let latestWithFields = null;
  for (const [key, session] of sessions) {
    if (!String(key).startsWith(prefix) || session.closed) continue;
    if (!latest || session.touched > latest.touched) latest = session;
    if (Object.keys(session.fields).length > 0 && (!latestWithFields || session.touched > latestWithFields.touched)) {
      latestWithFields = session;
    }
  }
  return latestWithFields || latest;
}

function storeFields(session, fields) {
  for (const field of fields || []) {
    if (!field?.key) continue;
    session.fields[field.key] = {
      label: String(field.label || field.name || 'Field'),
      name: String(field.name || ''),
      value: String(field.value ?? ''),
    };
  }
  persistSession(session);
}

async function rememberFields(tabId, message, sender) {
  const url = await jobPageUrl(sender, message);
  if (!pageKey(url)) return 0;
  const existing = sessions.get(sessionKey(tabId, url));
  if (existing?.closed && Date.now() - existing.touched < 1500) {
    storeFields(existing, message.fields);
    return Object.keys(existing.fields).length;
  }
  const frameUrl = String(message.url || '');
  const title = frameUrl && isEmbedUrl(frameUrl) ? '' : message.title;
  const session = ensureSession(tabId, url, title);
  storeFields(session, message.fields);
  scheduleSync(tabId, session);
  return Object.keys(session.fields).length;
}

function scheduleSync(tabId, session) {
  const current = syncTimers.get(session.key);
  if (current) clearTimeout(current);
  syncTimers.set(session.key, setTimeout(() => {
    syncTimers.delete(session.key);
    send(tabId, session, false);
  }, 800));
}

function jobLabel(session) {
  const titled = Object.values(session.fields || {}).find((field) => /job title|position|role/i.test(`${field.label} ${field.name}`));
  if (titled?.value) return titled.value;
  if (session.title && !/recaptcha/i.test(session.title)) return session.title;
  return 'Job application';
}

function notify(id, title, message) {
  if (!chrome.notifications?.create) return;
  const iconUrl = chrome.runtime.getURL?.('icons/icon128.png') || '';
  const options = { type: 'basic', title, message, priority: 2 };
  if (iconUrl) options.iconUrl = iconUrl;
  const created = chrome.notifications.create(id, options);
  if (created?.catch) created.catch(() => {});
}

function notifyApplied(session) {
  let host = '';
  try {
    host = new URL(session.url).hostname.replace(/^www\./, '');
  } catch {
    host = '';
  }
  const label = jobLabel(session);
  notify(`applied-${session.id}`, '1 job applied', host ? `${label} — ${host}` : label);
}

async function send(tabId, session, submitted) {
  if (!session || session.closed) return { ok: false, reason: 'closed' };
  const fields = Object.values(session.fields);
  if (!submitted && fields.length === 0) return { ok: false, reason: 'empty' };
  const stored = await chrome.storage.local.get(['apiOrigin', 'token']);
  const origin = String(stored.apiOrigin || '').replace(/\/+$/, '');
  if (!origin || !stored.token) {
    await chrome.storage.local.set({ connected: false, lastError: 'Sign in before a submission can be saved.' });
    return { ok: false, reason: 'signed-out' };
  }
  let domain = '';
  try {
    domain = new URL(session.url).hostname;
  } catch {
    domain = '';
  }
  try {
    const response = await fetch(`${origin}/api/application-track/applications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${stored.token}`,
      },
      body: JSON.stringify({
        sessionId: session.id,
        url: session.url,
        domain,
        pageTitle: usableTitle(session.title),
        fields,
        submitted,
      }),
    });
    if (response.status === 204) return { ok: true };
    if (!response.ok) {
      await chrome.storage.local.set({ connected: response.status !== 401, lastError: 'The server did not save that application.' });
      return { ok: false, reason: 'server' };
    }
    if (submitted) {
      session.closed = true;
      tabArmed.delete(tabId);
      persistSession(session);
      persistArm(tabId, null);
      notifyApplied(session);
    }
    await chrome.storage.local.set({
      connected: true,
      lastError: '',
      ...(submitted ? { lastRecordedAt: Date.now() } : {}),
    });
    return { ok: true };
  } catch {
    await chrome.storage.local.set({ connected: false, lastError: 'The server could not be reached.' });
    return { ok: false, reason: 'offline' };
  }
}

const EXTENSION_KEY = 'application-track';
const DEFAULT_ORIGIN = 'http://213.59.112.27:5000';

function extensionDownloadUrl(origin) {
  const base = String(origin || DEFAULT_ORIGIN).replace(/\/+$/, '');
  return `${base}/api/extensions/application-track/download`;
}

let versionCheck = Promise.resolve();

function checkExtensionVersion() {
  const run = reportExtensionVersion();
  versionCheck = Promise.all([versionCheck, run]).then(() => {});
  return run;
}

async function markSignedOut(origin, token) {
  if (!token) return;
  let pending = versionCheck;
  await pending;
  while (versionCheck !== pending) {
    pending = versionCheck;
    await pending;
  }
  const base = String(origin || DEFAULT_ORIGIN).replace(/\/+$/, '');
  try {
    await fetch(`${base}/api/extensions/${EXTENSION_KEY}/offline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // The site keeps the last check-in until this sign-out reaches the server.
  }
}

async function reportExtensionVersion() {
  const installed = chrome.runtime.getManifest().version;
  const stored = await chrome.storage.local.get(['apiOrigin', 'token', 'notifiedExtensionVersion']);
  const origin = String(stored.apiOrigin || DEFAULT_ORIGIN).replace(/\/+$/, '');
  try {
    const response = await fetch(`${origin}/api/extensions/${EXTENSION_KEY}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(stored.token ? { Authorization: `Bearer ${stored.token}` } : {}),
      },
      body: JSON.stringify({ version: installed }),
    });
    if (!response.ok) return;
    const payload = await response.json();
    if (!payload.update) {
      await chrome.storage.local.set({ extensionUpdate: null, notifiedExtensionVersion: '' });
      return;
    }
    await chrome.storage.local.set({ extensionUpdate: { version: payload.version, installed } });
    if (stored.notifiedExtensionVersion === payload.version) return;
    await chrome.storage.local.set({ notifiedExtensionVersion: payload.version });
    notify(`extension-update-${EXTENSION_KEY}`, 'Update Application Track', `This copy is v${installed}. Install v${payload.version}. ${extensionDownloadUrl(origin)}`);
  } catch {
    // The server was unreachable.
  }
}

chrome.runtime.onInstalled?.addListener(() => checkExtensionVersion());
chrome.runtime.onStartup?.addListener(() => checkExtensionVersion());
if (chrome.alarms?.create && chrome.alarms.onAlarm) {
  chrome.alarms.create('extension-version', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'extension-version') checkExtensionVersion();
  });
} else {
  setInterval(() => checkExtensionVersion(), 60000);
}
checkExtensionVersion();

const restored = restoreSessions().catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  restored.then(() => handleMessage(message, sender, sendResponse));
  return true;
});

function handleMessage(message, sender, sendResponse) {
  const tabId = sender.tab?.id;
  if (message?.type === 'fields' && tabId != null) {
    rememberFields(tabId, message, sender).then((count) => sendResponse({ count }));
    return true;
  }
  if (message?.type === 'arm' && tabId != null) {
    jobPageUrl(sender, message).then((url) => {
      if (!url) {
        sendResponse({ ok: false });
        return;
      }
      const session = ensureSession(tabId, url, isEmbedUrl(message.url || '') ? '' : message.title);
      const requested = Number(message.until);
      const cap = Date.now() + 180000;
      const until = Number.isFinite(requested) && requested > Date.now()
        ? Math.min(requested, cap)
        : Date.now() + 20000;
      const existing = tabArmed.get(tabId);
      const keep = existing && existing.key === session.key ? existing.until : 0;
      const armed = { key: session.key, until: Math.max(until, keep) };
      tabArmed.set(tabId, armed);
      persistArm(tabId, armed);
      sendResponse({ ok: true });
    });
    return true;
  }
  if (message?.type === 'armed-status' && tabId != null) {
    const armed = tabArmed.get(tabId);
    const active = !!armed && armed.until > Date.now();
    if (armed && !active) {
      tabArmed.delete(tabId);
      persistArm(tabId, null);
    }
    sendResponse({ armed: active, until: active ? armed.until : 0 });
    return false;
  }
  if (message?.type === 'success' && tabId != null) {
    const armed = tabArmed.get(tabId);
    if (!armed || armed.until < Date.now()) {
      if (armed) {
        tabArmed.delete(tabId);
        persistArm(tabId, null);
      }
      sendResponse({ ok: false, reason: 'not-armed' });
      return false;
    }
    jobPageUrl(sender, message).then((url) => {
      if (!url) {
        sendResponse({ ok: false, reason: 'embed' });
        return;
      }
      const armed = tabArmed.get(tabId);
      let session = armed ? sessions.get(armed.key) : null;
      if (!session || session.closed) session = latestOpenSession(tabId);
      if (!session || (pageKey(url) && pageKey(url) !== session.pageKey && urlRank(url) > urlRank(session.url))) {
        const next = ensureSession(tabId, url, session?.title || message.title);
        if (session) {
          next.fields = { ...session.fields, ...next.fields };
          session.closed = true;
          persistSession(session);
        }
        session = next;
      } else {
        session.url = url;
      }
      storeFields(session, message.fields);
      if (message.confirmation) {
        session.fields.confirmation = {
          label: 'Confirmation',
          name: 'confirmation',
          value: String(message.confirmation).slice(0, 500),
        };
      }
      session.touched = Date.now();
      const pending = syncTimers.get(session.key);
      if (pending) clearTimeout(pending);
      send(tabId, session, true).then(sendResponse);
    });
    return true;
  }
  if (message?.type === 'check-version') {
    checkExtensionVersion().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'sign-out') {
    markSignedOut(message.origin, message.token).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'status') {
    const openTabs = new Set([...sessions.keys()].map((key) => String(key).split('::')[0]));
    sendResponse({ tabs: openTabs.size });
  }
}
