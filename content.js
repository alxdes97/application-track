const FINAL = /\b(submit|send application|complete application|finish application)\b/i;
const NOT_FINAL = /\b(next|continue|back|previous|cancel|save draft)\b/i;
const CONFIRMATION = /thank you for applying|thanks for applying|thank you for your application|thanks for your application|your application (?:has been |was )?(?:successfully )?submitted|application (?:has been |was )?successfully submitted|successfully submitted your application|successfully applied|we (?:have )?received your application|application received|your application (?:was|has been) sent|you(?:'|’)ve applied|you have applied|application complete|we(?:'|’)ll contact you if there are next steps/i;

let armedUntil = 0;

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

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function labelFor(element) {
  if (element.id) {
    const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    if (label && label.innerText.trim()) return label.innerText.trim();
  }
  const wrapping = element.closest('label');
  if (wrapping) {
    const text = wrapping.innerText.replace(element.value || '', '').trim();
    if (text) return text;
  }
  return element.getAttribute('aria-label') || element.getAttribute('placeholder') || '';
}

function fieldValue(element) {
  if (element instanceof HTMLSelectElement) {
    return [...element.selectedOptions].map((option) => option.text.trim() || option.value).filter(Boolean).join(', ');
  }
  if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
    return element.checked ? element.value || 'yes' : '';
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
    if (['password', 'hidden', 'file', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
    const name = element.getAttribute('name') || element.id || '';
    if (/csrf|authenticity|token/i.test(name)) continue;
    const value = fieldValue(element).trim();
    if (!value) continue;
    const label = labelFor(element).slice(0, 180);
    const key = `${name || label}:${type}`;
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

function arm() {
  armedUntil = Date.now() + 20000;
  chrome.runtime.sendMessage({
    type: 'arm',
    domain: domainOf(location.href),
    url: location.href,
    title: document.title,
  });
}

function pageText() {
  const chunks = [];
  let size = 0;
  const limit = 30000;
  function walk(node) {
    if (!node || size >= limit) return;
    if (node.nodeType === Node.TEXT_NODE) {
      chunks.push(node.textContent || '');
      size += (node.textContent || '').length;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
    }
    if (node.shadowRoot) walk(node.shadowRoot);
    for (const child of node.childNodes) walk(child);
  }
  walk(document.body || document.documentElement);
  return chunks.join(' ');
}

function confirmationSnippet() {
  const source = `${document.title}\n${location.href}\n${pageText()}`.replace(/\s+/g, ' ');
  const match = source.match(CONFIRMATION);
  if (!match || match.index == null) return '';
  const start = Math.max(0, match.index - 40);
  return source.slice(start, match.index + match[0].length + 80).trim();
}

let reportedConfirmation = false;
let reporting = false;

function reportConfirmation() {
  if (reportedConfirmation || reporting) return;
  const confirmation = confirmationSnippet();
  if (!confirmation) return;
  reporting = true;
  collect();
  chrome.runtime.sendMessage({
    type: 'success',
    domain: domainOf(location.href),
    url: location.href,
    title: document.title,
    confirmation,
    reason: 'confirmation',
  }, (response) => {
    reporting = false;
    if (chrome.runtime.lastError || !response?.ok) return;
    reportedConfirmation = true;
  });
}

if (!isEmbedLocation()) {
  document.addEventListener('input', () => collect(), true);
  document.addEventListener('change', () => collect(), true);
  document.addEventListener('click', (event) => {
    collect();
    const target = event.target instanceof Element ? event.target.closest('button, input[type="submit"], [role="button"]') : null;
    if (target && isFinalSubmit(target)) arm();
    setTimeout(reportConfirmation, 400);
    setTimeout(reportConfirmation, 1500);
  }, true);
  document.addEventListener('submit', (event) => {
    const submitter = event.submitter;
    if (!submitter || !isFinalSubmit(submitter)) return;
    arm();
  }, true);

  const hook = document.createElement('script');
  hook.src = chrome.runtime.getURL('page-hook.js');
  hook.async = false;
  (document.documentElement || document.head).appendChild(hook);
  hook.onload = () => hook.remove();

  collect();
  reportConfirmation();
  let confirmationQueued = false;
  const confirmationObserver = new MutationObserver(() => {
    if (reportedConfirmation || confirmationQueued) return;
    confirmationQueued = true;
    setTimeout(() => {
      confirmationQueued = false;
      reportConfirmation();
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
    reportConfirmation();
  }, 1000);
}
