// Keryx node REST API client (same endpoints the official web wallet uses).
//
// The API host is configurable (Settings → Network): a custom base URL is
// stored in chrome.storage.local under `krx_api_base` and falls back to the
// official keryx-labs.com indexer. `API_BASE` is a live binding, loaded
// lazily on first request and kept in sync across extension contexts
// (popup / approval window / service worker) via storage.onChanged.
// A custom host must allow CORS — the stock Keryx indexer serves
// `access-control-allow-origin: *`, so a self-hosted instance just works.

export const DEFAULT_API_BASE = 'https://keryx-labs.com';
const API_BASE_KEY = 'krx_api_base';

export let API_BASE = DEFAULT_API_BASE;
let baseLoaded = false;

/**
 * Loopback hosts are "potentially trustworthy" secure contexts, so the browser
 * allows plain-http requests to them from the extension; every other host is
 * mixed-content-blocked over http. Covers localhost (+ subdomains), 127.0.0.0/8
 * and ::1.
 */
function isLoopbackHost(hostname) {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' || h.endsWith('.localhost') ||
    h === '[::1]' || h === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(h)
  );
}

/**
 * Validate and canonicalize an API base URL (no trailing slash; a path prefix
 * like https://my-proxy/keryx is allowed). Empty input → null (use default).
 */
export function normalizeApiBase(value) {
  const s = (value ?? '').trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('Invalid URL — expected e.g. https://my-node.example');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('Only http(s) API hosts are supported');
  }
  // A remote http host would silently fail: the extension is a secure context,
  // so the browser blocks its plain-http requests as mixed content. Only
  // loopback (a local shim) is exempt.
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
    throw new Error('http:// is only allowed for localhost — use https:// for a remote API host');
  }
  if (u.search || u.hash) throw new Error('API host must not contain a query string or fragment');
  return u.href.replace(/\/+$/, '');
}

/** Load the configured host into the live `API_BASE` binding. */
export async function loadApiBase() {
  const { [API_BASE_KEY]: stored } = await chrome.storage.local.get(API_BASE_KEY);
  try {
    API_BASE = normalizeApiBase(stored) ?? DEFAULT_API_BASE;
  } catch {
    API_BASE = DEFAULT_API_BASE; // corrupted stored value — fall back safely
  }
  baseLoaded = true;
  return API_BASE;
}

/** Persist a new API host; '' resets to the default. Returns the effective base. */
export async function setApiBase(value) {
  const norm = normalizeApiBase(value); // throws on invalid input
  if (norm === null) await chrome.storage.local.remove(API_BASE_KEY);
  else await chrome.storage.local.set({ [API_BASE_KEY]: norm });
  API_BASE = norm ?? DEFAULT_API_BASE;
  baseLoaded = true;
  return API_BASE;
}

// Other contexts run their own copy of this module; storage.onChanged keeps
// every copy current when the user saves a new host in Settings.
globalThis.chrome?.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local' || !(API_BASE_KEY in changes)) return;
  try {
    API_BASE = normalizeApiBase(changes[API_BASE_KEY].newValue) ?? DEFAULT_API_BASE;
  } catch {
    API_BASE = DEFAULT_API_BASE;
  }
  baseLoaded = true;
});

async function doFetch(path, init) {
  if (!baseLoaded) await loadApiBase();
  try {
    // Timeout matters: a flapping node can accept the TCP connection and then
    // stall indefinitely, which would leave the UI in "checking…" forever.
    return await fetch(`${API_BASE}${path}`, { ...init, signal: AbortSignal.timeout(15000) });
  } catch {
    // TCP-level failure or timeout (node down/updating, DNS, offline) — fetch
    // gives an opaque TypeError; translate it for the UI. The dashboard
    // auto-refresh retries every 15 s.
    throw new Error('Keryx node unreachable — it may be restarting or updating. Will retry shortly.');
  }
}

async function get(path) {
  const res = await doFetch(path, { cache: 'no-store' });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error ?? '';
    } catch {}
    throw new Error(`API ${res.status}${detail ? ` — ${detail}` : ''} (${path})`);
  }
  return res.json();
}

async function post(path, body) {
  const res = await doFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error ?? '';
    } catch {}
    throw new Error(`API ${res.status}${detail ? ` — ${detail}` : ''} (${path})`);
  }
  return res.json();
}

export const api = {
  // { network, last_daa_score, total_supply_krx, hashrate_hps, ... }
  info: () => get('/api/v1/info'),
  // { address, balance_sompi }
  balance: (address) => get(`/api/v1/addresses/${encodeURIComponent(address)}/balance`),
  // { count }
  utxoCount: (address) => get(`/api/v1/addresses/${encodeURIComponent(address)}/utxos/count`),
  // [{ transaction_id, index, amount_sompi, script_version, script_public_key, block_daa_score, is_coinbase }]
  utxos: (address, limit = 400) =>
    get(`/api/v1/addresses/${encodeURIComponent(address)}/utxos?limit=${limit}`),
  // { address, total_received_sompi, total_tx_count, transactions: [{ tx_id, amount_sompi, is_spend, daa_score, block_hash }] }
  addressTxs: (address, limit = 10, offset = 0) =>
    get(`/api/v1/addresses/${encodeURIComponent(address)}?limit=${limit}&offset=${offset}`),
  // broadcast signed transaction
  broadcast: (tx) => post('/api/v1/broadcast', tx),
  market: () => get('/api/v1/market'),
  // [{ model, model_id_hex, miner_count, last_seen_daa, miner_pubkeys: [hex32] }]
  capabilities: () => get('/api/v1/capabilities'),
  // [{ tx_id, model, prompt, max_tokens, inference_reward, priority_fee, daa_score,
  //    block_hash, payload_prefix, result, result_text, result_block_hash }]
  inferences: (limit = 20, offset = 0) => get(`/api/v1/infer?limit=${limit}&offset=${offset}`),
  // [{ tx_id, request_hash_hex, fraud_proven }]
  challenges: (limit = 50) => get(`/api/v1/challenges?limit=${limit}`),
  // inference results that are IPFS CIDs resolve to text via the same host
  ipfsText: async (cid) => {
    const res = await doFetch(`/ipfs/${encodeURIComponent(cid)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`IPFS fetch failed (${res.status})`);
    return res.text();
  },
};
