function installMobile(backgroundSource, contentSource, version) {
  if (globalThis.__applicationTrackFrame) return;
  globalThis.__applicationTrackFrame = true;
  const manifestVersion = String(version || '1.3.0');

  function gmGet(key) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, '');
    } catch {
      // Fall through to this page's storage.
    }
    try {
      return localStorage.getItem(`application-track:${key}`) || '';
    } catch {
      return '';
    }
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return;
      }
    } catch {
      // Fall through to this page's storage.
    }
    try {
      localStorage.setItem(`application-track:${key}`, value);
    } catch {
      // Private browsing can block storage.
    }
  }

  function readArea(area) {
    try {
      const parsed = JSON.parse(gmGet(area) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeArea(area, data) {
    gmSet(area, JSON.stringify(data));
  }

  const changeListeners = new Set();

  function storageArea(area) {
    return {
      get(keys) {
        const data = readArea(area);
        if (keys == null) return Promise.resolve(data);
        const names = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || {});
        const result = {};
        for (const name of names) result[name] = Object.prototype.hasOwnProperty.call(data, name) ? data[name] : undefined;
        return Promise.resolve(result);
      },
      set(values) {
        const data = readArea(area);
        const changes = {};
        for (const [name, value] of Object.entries(values || {})) {
          changes[name] = { oldValue: data[name], newValue: value };
          data[name] = value;
        }
        writeArea(area, data);
        for (const listener of changeListeners) listener(changes, area);
        return Promise.resolve();
      },
      remove(keys) {
        const data = readArea(area);
        const names = Array.isArray(keys) ? keys : [keys];
        const changes = {};
        for (const name of names) {
          changes[name] = { oldValue: data[name] };
          delete data[name];
        }
        writeArea(area, data);
        for (const listener of changeListeners) listener(changes, area);
        return Promise.resolve();
      },
    };
  }

  function mobileFetch(url, options = {}) {
    const request = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null;
    if (!request) return fetch(url, options);
    return new Promise((resolve, reject) => {
      request({
        method: options.method || 'GET',
        url: String(url),
        headers: options.headers || {},
        data: options.body,
        onload(response) {
          const text = response.responseText || '';
          resolve({
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            json: async () => JSON.parse(text || '{}'),
            text: async () => text,
          });
        },
        onerror() {
          reject(new Error('network'));
        },
      });
    });
  }

  const messageListeners = new Set();
  const chromeShim = {
    storage: {
      local: storageArea('local'),
      session: storageArea('session'),
      onChanged: {
        addListener(listener) {
          changeListeners.add(listener);
        },
      },
    },
    runtime: {
      lastError: null,
      getManifest() {
        return { version: manifestVersion };
      },
      getURL() {
        return '';
      },
      sendMessage(message, callback) {
        let called = false;
        const sendResponse = (response) => {
          if (called) return;
          called = true;
          chromeShim.runtime.lastError = null;
          if (typeof callback === 'function') callback(response);
        };
        let pending = false;
        for (const listener of messageListeners) {
          const keep = listener(message, { tab: { id: 1, url: location.href } }, sendResponse);
          if (keep === true) pending = true;
        }
        if (!pending && !called) sendResponse(undefined);
        return true;
      },
      onMessage: {
        addListener(listener) {
          messageListeners.add(listener);
        },
      },
      onInstalled: { addListener(listener) { listener(); } },
      onStartup: { addListener() {} },
    },
    notifications: {
      create(_id, options) {
        showToast(options?.title || 'Application Track', options?.message || '');
        return Promise.resolve();
      },
    },
  };

  function showToast(title, message) {
    if (!isTopFrame()) return;
    let host = document.getElementById('application-track-toast');
    if (!host) {
      host = document.createElement('div');
      host.id = 'application-track-toast';
      host.style.cssText = 'position:fixed;left:12px;right:12px;bottom:72px;z-index:2147483647;display:flex;justify-content:center;pointer-events:none;';
      document.documentElement.appendChild(host);
    }
    const card = document.createElement('div');
    card.style.cssText = 'max-width:420px;padding:12px 14px;border-radius:10px;background:#0f766e;color:white;font:16px/1.4 sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.2);';
    card.textContent = message ? `${title}. ${message}` : title;
    host.replaceChildren(card);
    setTimeout(() => card.remove(), 5000);
  }

  function isTopFrame() {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  }

  const run = new Function('chrome', 'fetch', 'source', 'new Function("chrome","fetch", source)(chrome, fetch);');
  run(chromeShim, mobileFetch, backgroundSource);
  run(chromeShim, mobileFetch, contentSource);
  if (isTopFrame()) mountPanel(chromeShim, mobileFetch);
}

function mountPanel(chrome, mobileFetch) {
  const host = document.createElement('div');
  host.id = 'application-track-panel';
  host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483646;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      button, input { font: 16px/1.3 sans-serif; }
      .open, .close, .go { min-height: 44px; border: 0; border-radius: 8px; background: #0f766e; color: white; font-weight: 700; }
      .open { padding: 10px 14px; }
      .card { width: min(320px, calc(100vw - 24px)); margin-top: 8px; padding: 12px; border-radius: 12px; background: white; color: #1e293b; box-shadow: 0 10px 30px rgba(0,0,0,.18); }
      label { display: block; margin-top: 8px; color: #475569; font: 13px/1.3 sans-serif; }
      input { box-sizing: border-box; width: 100%; margin-top: 4px; padding: 10px; border: 1px solid #cbd5e1; border-radius: 8px; }
      .go, .close { width: 100%; margin-top: 10px; }
      .close { background: transparent; color: #0f766e; }
      p { margin: 8px 0 0; color: #64748b; font: 13px/1.4 sans-serif; }
    </style>
    <button class="open" type="button">Application Track</button>
    <div class="card" hidden>
      <label>Server <input class="server" type="url" value="http://213.59.112.27:5000" /></label>
      <label>Email <input class="email" type="email" autocomplete="username" /></label>
      <label>Password <input class="password" type="password" autocomplete="current-password" /></label>
      <button class="go" type="button">Sign in</button>
      <p class="status"></p>
    </div>
  `;
  document.documentElement.appendChild(host);
  const card = root.querySelector('.card');
  const status = root.querySelector('.status');
  const server = root.querySelector('.server');
  const email = root.querySelector('.email');
  const password = root.querySelector('.password');
  const action = root.querySelector('.go');

  function originOf(value) {
    try {
      return new URL(String(value || '').trim()).origin;
    } catch {
      return '';
    }
  }

  async function paint() {
    const data = await chrome.storage.local.get(['apiOrigin', 'token', 'email']);
    if (data.apiOrigin) server.value = data.apiOrigin;
    const signedIn = Boolean(data.token);
    email.parentElement.hidden = signedIn;
    password.parentElement.hidden = signedIn;
    server.parentElement.hidden = signedIn;
    action.textContent = signedIn ? 'Sign out' : 'Sign in';
    action.className = signedIn ? 'close' : 'go';
    status.textContent = signedIn ? `Signed in as ${data.email || 'submitter'}. A successful submit records one job.` : '';
  }

  root.querySelector('.open').addEventListener('click', () => {
    card.hidden = !card.hidden;
    if (!card.hidden) paint();
  });

  action.addEventListener('click', async () => {
    const data = await chrome.storage.local.get(['apiOrigin', 'token', 'email']);
    if (data.token) {
      await chrome.storage.local.remove(['token', 'email']);
      await chrome.storage.local.set({ connected: false });
      await new Promise((resolve) => chrome.runtime.sendMessage({
        type: 'sign-out',
        origin: data.apiOrigin,
        token: data.token,
      }, resolve));
      await paint();
      return;
    }
    const origin = originOf(server.value);
    if (!origin) {
      status.textContent = 'Enter the server address, up to the port.';
      return;
    }
    status.textContent = 'Signing in…';
    try {
      const response = await mobileFetch(`${origin}/api/application-track/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.value.trim(), password: password.value }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        status.textContent = payload.error || 'Could not sign in.';
        return;
      }
      await chrome.storage.local.set({
        apiOrigin: origin,
        token: payload.token,
        email: payload.submitter?.email || email.value.trim(),
        connected: true,
        lastError: '',
      });
      password.value = '';
      chrome.runtime.sendMessage({ type: 'check-version' });
      await paint();
    } catch {
      status.textContent = 'The server did not answer.';
    }
  });
}
