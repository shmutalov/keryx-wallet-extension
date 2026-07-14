// Keryx Wallet — MV3 service worker.
//
// 1. Enforces the 15-minute inactivity auto-lock (clears the in-memory session;
//    the vault ciphertext in chrome.storage.local is untouched).
// 2. Routes dApp provider requests relayed by the content script: read-only
//    calls answer directly from the per-origin connection record; anything
//    involving keys opens an approval window and the result flows back to the
//    tab via tabs.sendMessage — resilient to this worker being restarted while
//    the approval window is open, because pending requests live in
//    chrome.storage.session, not in worker memory.

import { sessionIsStale, endSession } from './lib/session.js';
import { api } from './lib/api.js';
import {
  getConnection,
  removeConnection,
  getPendingRequests,
  putPendingRequest,
  removePendingRequest,
} from './lib/provider.js';

const ALARM = 'krx-autolock';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  if (await sessionIsStale()) {
    await endSession();
  }
});

// --- dApp provider router ------------------------------------------------------

const APPROVAL_TYPES = {
  krx_requestAccounts: 'connect',
  krx_sendKrx: 'send',
  krx_signMessage: 'sign-message',
  krx_signTx: 'sign-tx',
  krx_submitInference: 'inference',
};

const NOT_CONNECTED = { error: 'Not connected — call window.keryx.requestAccounts() first' };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  // dApp requests arrive only through our content script (http/https pages)
  if (msg.type === 'krx-request' && sender.tab?.id !== undefined && /^https?:/.test(sender.origin ?? '')) {
    handleRequest(msg, sender).then(sendResponse, (e) => sendResponse({ error: errText(e) }));
    return true;
  }

  const fromExtensionPage = !!sender.url?.startsWith(chrome.runtime.getURL(''));
  if (msg.type === 'krx-approval-result' && fromExtensionPage) {
    finishApproval(msg).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'krx-origin-disconnected' && fromExtensionPage) {
    // popup Settings revoked a site — tell its tabs
    emitEvent(msg.origin, 'accountsChanged', []);
    emitEvent(msg.origin, 'disconnect');
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

const errText = (e) => String(e?.message ?? e);

async function handleRequest(msg, sender) {
  const origin = sender.origin;
  const conn = await getConnection(origin);

  switch (msg.method) {
    case 'krx_getAccounts':
      return { result: conn ? [conn.address] : [] };
    case 'krx_getNetwork':
      return { result: 'keryx-mainnet' };
    case 'krx_getVersion':
      return { result: chrome.runtime.getManifest().version };
    case 'krx_getPublicKey':
      return conn ? { result: conn.publicKeyHex } : NOT_CONNECTED;
    case 'krx_getBalance': {
      if (!conn) return NOT_CONNECTED;
      const { balance_sompi } = await api.balance(conn.address);
      return { result: { address: conn.address, balance_sompi } };
    }
    case 'krx_getUtxos': {
      if (!conn) return NOT_CONNECTED;
      return { result: await api.utxos(conn.address, 2000) };
    }
    case 'krx_getTransaction': {
      // Public chain data (swap recovery); connection-gated like the other reads.
      if (!conn) return NOT_CONNECTED;
      const txId = msg.params?.txId;
      if (typeof txId !== 'string' || !txId) return { error: 'Missing txId' };
      return { result: await api.transaction(txId) };
    }
    case 'krx_getOutpointSpend': {
      if (!conn) return NOT_CONNECTED;
      const { txId, index } = msg.params ?? {};
      if (typeof txId !== 'string' || !txId || !Number.isInteger(index) || index < 0) {
        return { error: 'Missing/invalid txId or index' };
      }
      return { result: await api.outpointSpend(txId, index) };
    }
    case 'krx_broadcastTx': {
      if (!conn) return NOT_CONNECTED;
      if (!msg.params?.tx || typeof msg.params.tx !== 'object') return { error: 'Missing tx' };
      const { transaction_id } = await api.broadcast(msg.params.tx);
      return { result: transaction_id };
    }
    case 'krx_disconnect': {
      if (conn) {
        await removeConnection(origin);
        emitEvent(origin, 'accountsChanged', []);
        emitEvent(origin, 'disconnect');
      }
      return { result: true };
    }
  }

  const type = APPROVAL_TYPES[msg.method];
  if (!type) return { error: `Unknown method: ${msg.method}` };
  // already connected -> connecting again is a no-op, no popup
  if (msg.method === 'krx_requestAccounts' && conn) return { result: [conn.address] };
  if (msg.method !== 'krx_requestAccounts' && !conn) return NOT_CONNECTED;
  if (JSON.stringify(msg.params ?? {}).length > 200000) return { error: 'Request too large' };

  const id = crypto.randomUUID();
  const req = {
    id,
    // The page keyed its pending promise by its own request id; keep it so the
    // eventual krx-response routes back to it. The internal `id` (uuid) stays
    // page-independent so it can't be used to target another tab's request.
    pageId: msg.id,
    origin,
    tabId: sender.tab.id,
    method: msg.method,
    type,
    params: msg.params ?? {},
    createdAt: Date.now(),
  };
  await putPendingRequest(req);
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`approval.html?id=${id}`),
    type: 'popup',
    width: 400,
    height: 640,
    focused: true,
  });
  req.winId = win.id;
  await putPendingRequest(req);
  return { pending: true, id };
}

/** Approval window answered: forward the outcome to the requesting tab. */
async function finishApproval({ id, result, error }) {
  const req = await removePendingRequest(id);
  if (!req) return { ok: false };
  respond(req, result, error);
  if (req.type === 'connect' && !error && Array.isArray(result)) {
    emitEvent(req.origin, 'accountsChanged', result);
  }
  if (req.winId !== undefined) chrome.windows.remove(req.winId).catch(() => {});
  return { ok: true };
}

function respond(req, result, error) {
  // Route by the page's request id (uuid fallback for older pending records).
  chrome.tabs.sendMessage(req.tabId, { type: 'krx-response', id: req.pageId ?? req.id, result, error }).catch(() => {});
}

// approval window closed without answering -> user rejected
chrome.windows.onRemoved.addListener(async (winId) => {
  const all = await getPendingRequests();
  for (const req of Object.values(all)) {
    if (req.winId === winId) {
      await removePendingRequest(req.id);
      respond(req, undefined, 'User rejected the request');
    }
  }
});

/**
 * Broadcast a provider event to every tab; the content script drops events not
 * addressed to its own origin (we can't read tab URLs without the "tabs"
 * permission, and don't want that warning just for event routing).
 */
async function emitEvent(origin, event, data) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id !== undefined) {
      chrome.tabs.sendMessage(t.id, { type: 'krx-event', origin, event, data }).catch(() => {});
    }
  }
}
