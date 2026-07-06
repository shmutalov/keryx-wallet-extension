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
