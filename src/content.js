// Content-script relay (ISOLATED world): bridges the injected window.keryx
// provider (MAIN world) and the background service worker.
//
//   page --postMessage--> here --runtime.sendMessage--> background
//   background --tabs.sendMessage--> here --postMessage--> page
//
// Requests that need user approval get an immediate `{ pending: true }` ack;
// the real result arrives later via tabs.sendMessage once the approval window
// resolves, so nothing here depends on the service worker staying alive.

const reply = (id, result, error) => {
  window.postMessage({ target: 'krx-inpage', id, result, error }, window.location.origin);
};

window.addEventListener('message', (ev) => {
  if (ev.source !== window || !ev.data || ev.data.target !== 'krx-content') return;
  const { id, method, params } = ev.data;
  if (typeof id !== 'string' || typeof method !== 'string') return;
  chrome.runtime
    .sendMessage({ type: 'krx-request', id, method, params })
    .then((resp) => {
      if (!resp) return reply(id, undefined, 'Keryx Wallet is unavailable');
      if (resp.pending) return; // resolved later through krx-response
      reply(id, resp.result, resp.error);
    })
    .catch(() => reply(id, undefined, 'Keryx Wallet is unavailable'));
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'krx-response') {
    reply(msg.id, msg.result, msg.error);
  } else if (msg.type === 'krx-event') {
    // events are broadcast to every tab; only surface those meant for this origin
    if (msg.origin && msg.origin !== window.location.origin) return;
    window.postMessage(
      { target: 'krx-inpage', event: msg.event, data: msg.data },
      window.location.origin
    );
  }
});
