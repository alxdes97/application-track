const sessions = new Map();
const tabArmed = new Map();
const syncTimers = new Map();

function pageKey(url) {
  try {
    const parsed = new URL(url);
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
  for (const key of [...sessions.keys()]) {
    if (String(key).startsWith(prefix)) sessions.delete(key);
  }
  tabArmed.delete(tabId);
  syncTimers.delete(tabId);
}

chrome.tabs.onRemoved.addListener(forgetTab);

function ensureSession(tabId, url, title) {
  const key = sessionKey(tabId, url);
  let session = sessions.get(key);
  if (!session || session.closed) {
    session = {
      id: crypto.randomUUID(),
      key,
      pageKey: pageKey(url),
      url: url || '',
      title: title || '',
      fields: {},
      closed: false,
      touched: Date.now(),
    };
    sessions.set(key, session);
  } else {
    session.url = url || session.url;
    session.title = title || session.title;
    session.touched = Date.now();
  }
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

function rememberFields(tabId, message) {
  const url = String(message.url || '');
  if (!pageKey(url)) return 0;
  const session = ensureSession(tabId, url, message.title);
  for (const field of message.fields || []) {
    if (!field?.key || !field.value) continue;
    session.fields[field.key] = {
      label: String(field.label || field.name || 'Field'),
      name: String(field.name || ''),
      value: String(field.value),
    };
  }
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
        pageTitle: session.title,
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (message?.type === 'fields' && tabId != null) {
    sendResponse({ count: rememberFields(tabId, message) });
    return false;
  }
  if (message?.type === 'arm' && tabId != null) {
    const session = ensureSession(tabId, message.url, message.title);
    tabArmed.set(tabId, { key: session.key, until: Date.now() + 20000 });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'success' && tabId != null) {
    const armed = tabArmed.get(tabId);
    let session = armed ? sessions.get(armed.key) : null;
    if (!session || session.closed) session = latestOpenSession(tabId);
    if (!session) session = ensureSession(tabId, message.url, message.title);
    if (message.confirmation) {
      session.fields.confirmation = {
        label: 'Confirmation',
        name: 'confirmation',
        value: String(message.confirmation).slice(0, 500),
      };
    }
    const pending = syncTimers.get(session.key);
    if (pending) clearTimeout(pending);
    send(tabId, session, true).then(sendResponse);
    return true;
  }
  if (message?.type === 'status') {
    const openTabs = new Set([...sessions.keys()].map((key) => String(key).split('::')[0]));
    sendResponse({ tabs: openTabs.size });
    return false;
  }
  return false;
});
