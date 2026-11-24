const FINAL = /\b(submit|sent|send application|complete application|finish application)\b/i;
const NOT_FINAL = /\b(next|continue|back|previous|cancel|save draft)\b/i;
const CONFIRMATION = /thank you for applying|thanks for applying|thank you for your application|thanks for your application|thank you for reaching out|thanks for reaching out|your application (?:has been |was )?(?:successfully )?submitted|application (?:has been |was )?successfully submitted|\bapplication submitted\b|\bsubmitted successfully\b|successfully submitted your application|successfully applied|we (?:have )?received your application|application received|your application (?:was|has been) sent|you(?:'|’)ve applied|you have applied|application complete|we(?:'|’)ll contact you if there are next steps|we will be in touch|we(?:'|’)ll be in touch/i;

let armedUntil = 0;
let preArmConfirmation = '';
let baselineFrozen = false;
let baselineReady = false;

function isEmbedLocation() {
  const host = location.hostname;
  const path = location.pathname;
  if (/(^|\.)recaptcha\.net$/i.test(host)) return true;
  if (/(^|\.)google\.com$/i.test(host) && /recaptcha/i.test(path)) return true;
  if (/(^|\.)gstatic\.com$/i.test(host)) return true;
  if (/(^|\.)hcaptcha\.com$/i.test(host)) return true;
  if (/(^|\.)cloudflare\.com$/i.test(host) && /challenge|turnstile/i.test(path)) return true;
  return false;
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

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/\s*\*\s*/g, ' ').trim();
}

function labelFor(element) {
  const option = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null;
  const optionText = cleanText(option?.innerText);
  const legend = cleanText(element.closest('fieldset')?.querySelector('legend')?.innerText);
  if (legend && optionText && legend !== optionText) return `${legend}: ${optionText}`.slice(0, 180);
  if (optionText) return optionText.slice(0, 180);
  const upload = cleanText(element.closest('.file-upload')?.querySelector('.upload-label, .label')?.innerText);
  if (upload) return upload.slice(0, 180);
  const wrapping = element.closest('label');
  if (wrapping) {
    const text = cleanText(wrapping.innerText.replace(element.value || '', ''));
    if (text) return text.slice(0, 180);
  }
  return cleanText(element.getAttribute('aria-label') || element.getAttribute('placeholder')).slice(0, 180);
}

function customSelectValue(element) {
  const root = element.closest('.select__control, .select, .select__container');
  if (!root) return '';
  const chosen = root.querySelectorAll('.select__single-value, .select__multi-value__label');
  return [...chosen].map((node) => cleanText(node.innerText)).filter(Boolean).join(', ');
}

function selectValue(element) {
  const marked = [...element.options].filter((option) => option.getAttribute('aria-selected') === 'true' && String(option.value || '').trim());
  const selected = marked.length
    ? marked
    : [...element.selectedOptions].filter((option) => String(option.value || '').trim());
  return selected.map((option) => cleanText(option.text) || option.value).filter(Boolean).join(', ');
}

function fieldValue(element) {
  const chosen = customSelectValue(element);
  if (chosen) return chosen;
  if (element instanceof HTMLSelectElement) return selectValue(element);
  if (element instanceof HTMLInputElement && element.type === 'file') {
    return [...(element.files || [])].map((file) => file.name).filter(Boolean).join(', ');
  }
  if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
    if (!element.checked) return '';
    const option = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null;
    return cleanText(option?.innerText) || element.value || 'yes';
  }
  return element.value || '';
}

const captured = new Map();

function collect() {
  const domain = domainOf(location.href);
  if (!domain) return;
  const controls = document.querySelectorAll('input, textarea, select');
  for (const element of controls) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) continue;
    const type = (element.getAttribute('type') || element.tagName).toLowerCase();
    if (['password', 'hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(type)) continue;
    if (element.closest('.iti__dropdown-content, .grecaptcha-badge, .picker-dialog')) continue;
    if (element.classList.contains('g-recaptcha-response')) continue;
    const name = element.getAttribute('name') || element.id || '';
    if (/csrf|authenticity|token|recaptcha/i.test(name)) continue;
    const label = labelFor(element).slice(0, 180);
    const value = fieldValue(element).trim();
    if (!value && !label && !name) continue;
    const key = `${name || label}:${type}:${element.id || ''}`;
    captured.set(key, { key, label: label || name || 'Field', name, value: value.slice(0, 20000) });
  }
  if (captured.size === 0) return;
  chrome.runtime.sendMessage({
    type: 'fields',
    domain,
    url: location.href,
    title: document.title,
    fields: [...captured.values()],
  });
}

function controlText(element) {
  return `${element.innerText || ''} ${element.value || ''} ${element.getAttribute('aria-label') || ''}`.trim();
}

function isFinalSubmit(element) {
  const text = controlText(element);
  if (!text || NOT_FINAL.test(text)) return false;
  return FINAL.test(text);
}

function isButtonLike(element) {
  if (!(element instanceof Element)) return false;
  const tag = element.tagName;
  const type = (element.getAttribute('type') || '').toLowerCase();
  const role = (element.getAttribute('role') || '').toLowerCase();
  return tag === 'BUTTON' || type === 'submit' || role === 'button' || /-button$/i.test(tag);
}

function submitControl(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const node of path) {
    if (isButtonLike(node)) return node;
  }
  const target = event.target instanceof Element ? event.target : null;
  return target ? target.closest('button, input[type="submit"], [role="button"]') : null;
}

function arm() {
  if (!baselineFrozen) {
    preArmConfirmation = visibleConfirmation();
    baselineFrozen = true;
  }
  armedUntil = Date.now() + 20000;
  chrome.runtime.sendMessage({
    type: 'arm',
    domain: domainOf(location.href),
    url: location.href,
    title: document.title,
  });
}

function snippetAround(source, match) {
  const start = Math.max(0, match.index - 40);
  return source.slice(start, match.index + match[0].length + 80).trim();
}

function matchConfirmation(source) {
  const flat = String(source || '').replace(/\s+/g, ' ');
  const match = flat.match(CONFIRMATION);
  if (!match || match.index == null) return '';
  return snippetAround(flat, match);
}

function isConcealed(element) {
  if (!(element instanceof Element)) return false;
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return true;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') return true;
  if (Number.parseFloat(style.opacity) === 0) return true;
  if (typeof element.checkVisibility === 'function') {
    try {
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
    } catch {
      // The visibility check above still applies.
    }
  }
  return false;
}

function urlLooksConfirmed() {
  let path = `${location.pathname}${location.hash}`;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw path when it is not valid encoding.
  }
  return CONFIRMATION.test(`${document.title}\n${path}`.replace(/[-_]+/g, ' '));
}

function visibleConfirmation() {
  let tail = '';
  let found = '';
  function take(text) {
    if (found || !text) return;
    tail = `${tail} ${text}`.replace(/\s+/g, ' ');
    if (tail.length > 2000) tail = tail.slice(-2000);
    const match = tail.match(CONFIRMATION);
    if (match && match.index != null) found = snippetAround(tail, match);
  }
  function walk(node) {
    if (!node || found) return;
    if (node.nodeType === Node.TEXT_NODE) {
      take(node.textContent || '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
      if (isConcealed(node)) return;
    }
    if (node.shadowRoot) walk(node.shadowRoot);
    for (const child of node.childNodes) walk(child);
  }
  walk(document.body || document.documentElement);
  return found;
}

let reportedConfirmation = false;
let reporting = false;

function reportConfirmation() {
  if (reportedConfirmation || reporting || !baselineReady || Date.now() >= armedUntil) return;
  const confirmation = visibleConfirmation();
  if (!confirmation || confirmation === preArmConfirmation) return;
  reporting = true;
  collect();
  chrome.runtime.sendMessage({
    type: 'success',
    domain: domainOf(location.href),
    url: location.href,
    title: document.title,
    confirmation,
    reason: 'confirmation',
    fields: [...captured.values()],
  }, (response) => {
    reporting = false;
    if (chrome.runtime.lastError || !response?.ok) return;
    reportedConfirmation = true;
  });
}

if (!isEmbedLocation() && !isMailbox(location.href)) {
  document.addEventListener('input', () => collect(), true);
  document.addEventListener('change', () => collect(), true);
  document.addEventListener('click', (event) => {
    collect();
    const target = submitControl(event);
    if (target && isFinalSubmit(target)) arm();
    setTimeout(reportConfirmation, 400);
    setTimeout(reportConfirmation, 1500);
  }, true);
  document.addEventListener('submit', (event) => {
    const submitter = event.submitter;
    if (submitter) {
      if (isFinalSubmit(submitter)) arm();
      return;
    }
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const control = [...form.querySelectorAll('button, input[type="submit"]')].find((element) => isFinalSubmit(element));
    if (control) arm();
  }, true);

  const hook = document.createElement('script');
  hook.src = chrome.runtime.getURL('page-hook.js');
  hook.async = false;
  (document.documentElement || document.head).appendChild(hook);
  hook.onload = () => hook.remove();

  function watchConfirmation() {
    collect();
    if (!baselineReady) return;
    if (Date.now() < armedUntil) {
      reportConfirmation();
      return;
    }
    if (!baselineFrozen) preArmConfirmation = visibleConfirmation();
  }

  chrome.runtime.sendMessage({ type: 'armed-status' }, (response) => {
    if (!chrome.runtime.lastError && response?.armed && response.until > Date.now()) {
      armedUntil = response.until;
    }
    const arrivedSubmitted = Date.now() < armedUntil && (urlLooksConfirmed() || !!visibleConfirmation());
    if (!baselineFrozen && !arrivedSubmitted) preArmConfirmation = visibleConfirmation();
    baselineReady = true;
    if (arrivedSubmitted) reportConfirmation();
  });

  let confirmationQueued = false;
  const confirmationObserver = new MutationObserver(() => {
    if (reportedConfirmation || confirmationQueued) return;
    confirmationQueued = true;
    setTimeout(() => {
      confirmationQueued = false;
      watchConfirmation();
    }, 250);
  });
  confirmationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  const confirmationPoll = setInterval(() => {
    if (reportedConfirmation) {
      clearInterval(confirmationPoll);
      confirmationObserver.disconnect();
      return;
    }
    watchConfirmation();
  }, 1000);
}
