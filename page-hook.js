(() => {
  if (window.__applicationTrackHook) return;
  window.__applicationTrackHook = true;

  function report(status, url) {
    if (status < 200 || status >= 300) return;
    window.postMessage({ source: 'application-track', kind: 'http', status, url: String(url || '') }, '*');
  }

  const originalFetch = window.fetch;
  window.fetch = function applicationTrackFetch(input, init) {
    return originalFetch.apply(this, arguments).then((response) => {
      try {
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (method === 'POST' || method === 'PUT' || method === 'PATCH') report(response.status, response.url);
      } catch {
        // The page request still returns normally.
      }
      return response;
    });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function applicationTrackOpen(method, url) {
    this.__applicationTrack = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function applicationTrackSend() {
    this.addEventListener('load', () => {
      const tracked = this.__applicationTrack;
      if (!tracked) return;
      if (tracked.method === 'POST' || tracked.method === 'PUT' || tracked.method === 'PATCH') {
        report(this.status, tracked.url);
      }
    });
    return originalSend.apply(this, arguments);
  };
})();
