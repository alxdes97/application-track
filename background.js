const buckets = new Map();
const armedUntil = new Map();

function bucketKey(tabId, domain) {
  return `${tabId}::${domain}`;
}

function forgetTab(tabId) {
  const prefix = `${tabId}::`;
  for (const key of [...buckets.keys()]) {
    if (String(key).startsWith(prefix)) buckets.delete(key);
  }
  for (const key of [...armedUntil.keys()]) {
    if (String(key).startsWith(prefix) || key === `tab:${tabId}`) armedUntil.delete(key);
  }
}

chrome.tabs.onRemoved.addListener(forgetTab);

function rememberFields(tabId, message) {
  const domain = String(message.domain || '');
  if (!domain) return 0;
  const key = bucketKey(tabId, domain);
  const current = buckets.get(key) || { domain, url: '', title: '', fields: {} };
  current.url = message.url || current.url;
  current.title = message.title || current.title;
  for (const field of message.fields || []) {
    if (!field?.key || !field.value) continue;
    current.fields[field.key] = {
      label: String(field.label || field.name || 'Field'),
      name: String(field.name || ''),
      value: String(field.value),
    };
  }
  buckets.set(key, current);
  return Object.keys(current.fields).length;
}

async function apiOrigin() {
  const stored = await chrome.storage.local.get('apiOrigin');
  return String(stored.apiOrigin || '').replace(/\/+$/, '');
}

async function record(tabId, domain, url, title) {
  const tabArm = armedUntil.get(`tab:${tabId}`);
  let key = bucketKey(tabId, domain);
  if ((armedUntil.get(key) || 0) < Date.now()) {
    if (!tabArm || tabArm.until < Date.now()) return { ok: false, reason: 'not-armed' };
    domain = tabArm.domain;
    key = bucketKey(tabId, domain);
  }
  const state = buckets.get(key);
  const stored = await chrome.storage.local.get(['apiOrigin', 'token']);
  const origin = String(stored.apiOrigin || '').replace(/\/+$/, '');
  if (!origin || !stored.token) {
    await chrome.storage.local.set({ connected: false, lastError: 'Sign in before a submission can be saved.' });
    return { ok: false, reason: 'signed-out' };
  }
  const fields = state ? Object.values(state.fields) : [];
  try {
    const response = await fetch(`${origin}/api/application-track/applications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${stored.token}`,
      },
      body: JSON.stringify({
        url: url || state?.url || '',
        domain,
        pageTitle: title || state?.title || '',
        fields,
      }),
    });
    if (!response.ok) {
      await chrome.storage.local.set({ connected: response.status !== 401, lastError: 'The server did not save that application.' });
      return { ok: false, reason: 'server' };
    }
    armedUntil.delete(key);
    armedUntil.delete(`tab:${tabId}`);
    buckets.delete(key);
    await chrome.storage.local.set({ connected: true, lastError: '', lastRecordedAt: Date.now() });
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
    const domain = String(message.domain || '');
    if (domain) {
      const key = bucketKey(tabId, domain);
      const until = Date.now() + 25000;
      armedUntil.set(key, until);
      armedUntil.set(`tab:${tabId}`, { domain, until });
      const current = buckets.get(key) || { domain, url: message.url || '', title: message.title || '', fields: {} };
      current.url = message.url || current.url;
      current.title = message.title || current.title;
      buckets.set(key, current);
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'success' && tabId != null) {
    record(tabId, String(message.domain || ''), message.url, message.title).then(sendResponse);
    return true;
  }
  if (message?.type === 'status') {
    const counts = new Map();
    for (const [key, value] of buckets) {
      const tab = key.split('::')[0];
      counts.set(tab, (counts.get(tab) || 0) + Object.keys(value.fields).length);
    }
    apiOrigin().then((origin) => {
      sendResponse({
        tabs: counts.size,
        origin,
        connected: Boolean(message.connected),
      });
    });
    return true;
  }
  return false;
});
