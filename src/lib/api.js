// Keryx node REST API client (same endpoints the official web wallet uses).

export const API_BASE = 'https://keryx-labs.com';

async function doFetch(path, init) {
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
  // phase 2: broadcast signed transaction
  broadcast: (tx) => post('/api/v1/broadcast', tx),
  market: () => get('/api/v1/market'),
};
