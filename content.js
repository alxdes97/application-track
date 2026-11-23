const FINAL = /\b(submit|send application|complete application|finish application)\b/i;
const NOT_FINAL = /\b(next|continue|back|previous|cancel|save draft)\b/i;
const CONFIRMATION = /thank you for applying|thanks for applying|thank you for your application|thanks for your application|your application (has been |was )?submitted|application (has been |was )?successfully submitted|successfully submitted your application|successfully applied|we (have )?received your application|application received|your application (was|has been) sent|you(?:'|’)ve applied|you have applied|application complete/i;

let armedUntil = 0;

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

function confirmationSnippet() {
  const source = `${document.title}\n${location.href}\n${document.body ? document.body.innerText.slice(0, 20000) : ''}`;
  const match = source.match(CONFIRMATION);
  if (!match || match.index == null) return '';
  const start = Math.max(0, match.index - 40);
  return source.slice(start, match.index + match[0].length + 80).replace(/\s+/g, ' ').trim();
}

let reportedConfirmation = false;

function reportConfirmation() {
  if (reportedConfirmation) return;
  const confirmation = confirmationSnippet();
  if (!confirmation) return;
  reportedConfirmation = true;
  chrome.runtime.sendMessage({
    type: 'success',
    domain: domainOf(location.href),
    url: location.href,
    title: document.title,
    confirmation,
    reason: 'confirmation',
  });
}

document.addEventListener('input', () => collect(), true);
document.addEventListener('change', () => collect(), true);
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('button, input[type="submit"], [role="button"]') : null;
  if (target && isFinalSubmit(target)) arm();
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
let confirmationTimer = 0;
const confirmationObserver = new MutationObserver(() => {
  if (reportedConfirmation) {
    confirmationObserver.disconnect();
    return;
  }
  clearTimeout(confirmationTimer);
  confirmationTimer = setTimeout(reportConfirmation, 300);
});
confirmationObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
