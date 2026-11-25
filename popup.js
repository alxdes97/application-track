document.querySelector('#version').textContent = `v${chrome.runtime.getManifest().version}`;

const connection = document.querySelector('#connection');
const connectionLabel = document.querySelector('#connection-label');
const signalDetail = document.querySelector('#signal-detail');
const setup = document.querySelector('#setup');
const main = document.querySelector('#main');
const setupStatus = document.querySelector('#setup-status');
const who = document.querySelector('#who');
const watching = document.querySelector('#watching');
const last = document.querySelector('#last');

const DEFAULT_SERVER = 'http://213.59.112.27:5000';

function originOf(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

function extensionDownloadUrl(server) {
  return `${originOf(server) || DEFAULT_SERVER}/api/extensions/application-track/download`;
}

function showDownloadLink(server) {
  const href = extensionDownloadUrl(server);
  const link = document.querySelector('#download');
  link.href = href;
  link.textContent = href;
  showLatestVersion(server);
}

async function showLatestVersion(server) {
  const node = document.querySelector('#latest');
  const origin = originOf(server) || DEFAULT_SERVER;
  try {
    const response = await fetch(`${origin}/api/extensions`);
    if (!response.ok) {
      node.textContent = 'Latest version unavailable';
      return;
    }
    const payload = await response.json();
    const release = (payload.extensions || []).find((item) => item.key === 'application-track');
    const latest = release?.packageVersion || release?.version;
    node.textContent = latest ? `Latest version v${latest}` : 'Latest version unavailable';
  } catch {
    node.textContent = 'Latest version unavailable';
  }
}

function showSignal(state, label, detail) {
  connection.className = state === 'ok' ? 'dot ok' : state === 'server' ? 'dot server' : 'dot';
  connection.title = label;
  connectionLabel.textContent = label;
  signalDetail.textContent = detail;
}

async function stored() {
  return chrome.storage.local.get(['apiOrigin', 'token', 'email', 'lastRecordedAt', 'lastError']);
}

async function ping() {
  const data = await stored();
  const origin = originOf(data.apiOrigin);
  if (!origin) {
    showSignal('off', 'Not connected', 'Enter the server address and sign in.');
    return data;
  }
  let serverUp = false;
  try {
    const health = await fetch(`${origin}/api/health`);
    serverUp = health.ok;
  } catch {
    serverUp = false;
  }
  if (!serverUp) {
    showSignal('off', 'Not connected', 'The server did not answer.');
    await chrome.storage.local.set({ connected: false });
    return data;
  }
  if (!data.token) {
    showSignal('server', 'Server reachable', 'The server is up. Sign in with a submitter account to connect.');
    return data;
  }
  try {
    const session = await fetch(`${origin}/api/application-track/session`, {
      headers: { Authorization: `Bearer ${data.token}` },
    });
    if (!session.ok) {
      showSignal('server', 'Server reachable', 'The server is up, but this sign-in is no longer valid.');
      await chrome.storage.local.set({ connected: false, token: '' });
      return { ...data, token: '' };
    }
    const payload = await session.json();
    showSignal('ok', 'Connected', `Connected as ${payload.submitter?.email || data.email}.`);
    await chrome.storage.local.set({ connected: true });
    return { ...data, email: payload.submitter?.email || data.email };
  } catch {
    showSignal('off', 'Not connected', 'The server did not answer.');
    await chrome.storage.local.set({ connected: false });
    return data;
  }
}

function renderAccount(data) {
  const signedIn = Boolean(data.token);
  setup.hidden = signedIn;
  main.hidden = !signedIn;
  if (!signedIn) return;
  who.textContent = data.email ? `Signed in as ${data.email}` : 'Signed in';
  chrome.runtime.sendMessage({ type: 'status' }, (response) => {
    const count = response?.tabs || 0;
    watching.textContent = count === 0
      ? 'No application form is open in a tab yet.'
      : `Keeping the form content in ${count} tab${count === 1 ? '' : 's'} until submit.`;
  });
  if (data.lastError) last.textContent = data.lastError;
  else if (data.lastRecordedAt) last.textContent = 'The last successful submission was sent to the server.';
  else last.textContent = 'A successful submit sends one new applied job.';
}

async function refresh() {
  const data = await ping();
  renderAccount(data);
}

document.querySelector('#sign-in').addEventListener('click', async () => {
  const origin = originOf(document.querySelector('#api-url').value);
  const email = document.querySelector('#email').value.trim();
  const password = document.querySelector('#password').value;
  if (!origin) {
    setupStatus.textContent = 'Enter the server address, up to the port.';
    return;
  }
  setupStatus.textContent = 'Signing in…';
  try {
    const response = await fetch(`${origin}/api/application-track/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setupStatus.textContent = payload.error || 'Could not sign in.';
      showSignal('server', 'Server reachable', 'The server answered, but the email or password was not accepted.');
      return;
    }
    await chrome.storage.local.set({
      apiOrigin: origin,
      token: payload.token,
      email: payload.submitter?.email || email,
      connected: true,
      lastError: '',
    });
    document.querySelector('#password').value = '';
    setupStatus.textContent = '';
    chrome.runtime.sendMessage({ type: 'check-version' });
    await refresh();
  } catch {
    setupStatus.textContent = 'The server did not answer.';
    showSignal('off', 'Not connected', 'The server did not answer.');
  }
});

document.querySelector('#sign-out').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['apiOrigin', 'token']);
  await chrome.storage.local.remove(['token', 'email']);
  await chrome.storage.local.set({ connected: false });
  if (data.token) {
    await chrome.runtime.sendMessage({
      type: 'sign-out',
      origin: data.apiOrigin,
      token: data.token,
    });
  }
  await refresh();
});

function showExtensionUpdate(update) {
  const node = document.querySelector('#update');
  if (!update?.version) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.textContent = `Update this extension to v${update.version}. This copy is v${chrome.runtime.getManifest().version}.`;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.extensionUpdate) showExtensionUpdate(changes.extensionUpdate.newValue);
});

const serverInput = document.querySelector('#api-url');
serverInput.addEventListener('input', () => showDownloadLink(serverInput.value));

chrome.storage.local.get(['apiOrigin', 'extensionUpdate']).then((data) => {
  if (data.apiOrigin) serverInput.value = data.apiOrigin;
  showDownloadLink(serverInput.value);
  showExtensionUpdate(data.extensionUpdate);
});

chrome.runtime.sendMessage({ type: 'check-version' });

refresh();
setInterval(refresh, 4000);
