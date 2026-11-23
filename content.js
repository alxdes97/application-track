const FINAL = /submit|apply|send application|complete application/i;
const NOT_FINAL = /next|continue|back|previous|cancel|save draft/i;
const SUCCESS = /thank you|application (has been )?submitted|successfully submitted|we received your application|application received|your application was sent/i;

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
  if (NOT_FINAL.test(text) && !FINAL.test(text)) return false;
  if (element instanceof HTMLInputElement && element.type === 'submit' && !NOT_FINAL.test(text)) return true;
  return FINAL.test(text);
}

function arm() {
  chrome.runtime.sendMessage({
    type: 'arm',
    domain: domainOf(location.href),
    url: location.href,
    title: document.title,
  });
}

function looksSuccessful() {
  const text = document.body ? document.body.innerText.slice(0, 8000) : '';
  return SUCCESS.test(text) || SUCCESS.test(location.href);
}

document.addEventListener('input', () => collect(), true);
document.addEventListener('change', () => collect(), true);
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('button, input[type="submit"], [role="button"]') : null;
  if (target && isFinalSubmit(target)) arm();
}, true);
document.addEventListener('submit', (event) => {
  const submitter = event.submitter;
  if (submitter && !isFinalSubmit(submitter)) return;
  arm();
}, true);

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'application-track') return;
  chrome.runtime.sendMessage({
    type: 'success',
    domain: domainOf(location.href),
    url: location.href,
    title: document.title,
    reason: 'http',
  });
});

const hook = document.createElement('script');
hook.src = chrome.runtime.getURL('page-hook.js');
hook.async = false;
(document.documentElement || document.head).appendChild(hook);
hook.onload = () => hook.remove();

collect();
if (looksSuccessful()) {
  chrome.runtime.sendMessage({
    type: 'success',
    domain: domainOf(location.href),
    url: location.href,
    title: document.title,
    reason: 'page',
  });
}
