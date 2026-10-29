// UTXO consolidation — merges an address's spendable UTXOs the way the official web
// wallet does (docs/PROTOCOL.md, "Consolidation flow"): rounds of self-sends of up to
// 80 inputs each, paying MIN_FEE_SOMPI per transaction, until what is left fits one
// batch. Every batch goes through buildTransferTx (one output back to the same
// address, no change), so it reuses the network-proven signer.

import { buildTransferTx, spendableUtxos, computeMass, MAX_STANDARD_MASS, MIN_FEE_SOMPI } from './tx.js';

/** Inputs per transaction: 80 signed P2PK inputs weigh 89,946 grams, under the 100k standard mass. */
export const CONSOLIDATE_BATCH = 80;
/** UTXOs per fetch (the API page the official wallet uses); later rounds pick up the rest. */
export const UTXO_FETCH_LIMIT = 2000;

const WAVE_SIZE = 10; // batches broadcast in parallel
const WAVE_PAUSE_MS = 500;
const ROUND_PAUSE_MS = 4000; // lets the indexer catch up with the previous round
const MAX_ROUNDS = 50;
const MAX_IDLE_ROUNDS = 3; // rounds in a row in which every batch was already submitted
const STORAGE_MASS_PARAMETER = 1e12; // KIP-9 C = SOMPI_PER_KASPA * 10,000

// Mempool rejections (keryx-node mining/errors/src/mempool.rs) meaning the batch, or one
// of its inputs, is already on its way — e.g. rebuilt from a fetch the indexer hadn't
// updated yet. Kaspa txids leave signature scripts out, so a rebuilt batch has the same id.
const ALREADY_SUBMITTED = /already (accepted by the consensus|in the mempool|in the orphan pool|spent by transaction)/i;

const byOutpoint = (a, b) =>
  a.transaction_id < b.transaction_id ? -1 : a.transaction_id > b.transaction_id ? 1 : a.index - b.index;
const sumOf = (utxos) => utxos.reduce((s, u) => s + u.amount_sompi, 0);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * KIP-9 storage mass of a one-output transaction (the relaxed formula the node applies
 * when |O| = 1): max(0, C/out − Σ C/in), with the node's integer division.
 */
function singleOutputStorageMass(inputs, outAmount) {
  const ins = inputs.reduce((s, u) => s + Math.floor(STORAGE_MASS_PARAMETER / u.amount_sompi), 0);
  return Math.max(0, Math.floor(STORAGE_MASS_PARAMETER / outAmount) - ins);
}

/**
 * Split UTXOs into consolidation batches. Only spendable ones count (confirmed, past
 * coinbase maturity). Outpoint order keeps a rebuilt batch identical. A lone leftover
 * waits for the next round instead of paying a fee to move alone, and a batch that the
 * fee would all but eat (output ≤ 0 or over the storage-mass limit) is skipped.
 *
 * @returns {{ eligible: object[], batches: object[][] }}
 */
export function planConsolidation(utxos, currentDaaScore, feeSompi = MIN_FEE_SOMPI) {
  const eligible = spendableUtxos(utxos, currentDaaScore).sort(byOutpoint);
  const batches = [];
  for (let i = 0; i < eligible.length; i += CONSOLIDATE_BATCH) {
    const batch = eligible.slice(i, i + CONSOLIDATE_BATCH);
    const out = sumOf(batch) - feeSompi;
    if (batch.length > 1 && out > 0 && singleOutputStorageMass(batch, out) <= MAX_STANDARD_MASS) {
      batches.push(batch);
    }
  }
  return { eligible, batches };
}

/** Transactions needed to merge `count` spendable UTXOs into one, given the lone-leftover rule. */
export function estimateTxCount(count) {
  let txs = 0;
  while (count > 1) {
    const rest = count % CONSOLIDATE_BATCH;
    const batches = Math.floor(count / CONSOLIDATE_BATCH) + (rest > 1 ? 1 : 0);
    txs += batches;
    count = batches + (rest === 1 ? 1 : 0);
  }
  return txs;
}

/** The signed self-send that merges one batch. */
export function buildConsolidationTx(batch, address, privateKeyHex, currentDaaScore, feeSompi = MIN_FEE_SOMPI) {
  const { tx } = buildTransferTx({
    utxos: batch,
    toAddress: address,
    amountSompi: sumOf(batch) - feeSompi,
    feeSompi,
    changeAddress: address,
    privateKeyHex,
    currentDaaScore,
  });
  const mass = computeMass(tx);
  if (mass > MAX_STANDARD_MASS) throw new Error(`Consolidation batch mass ${mass} exceeds ${MAX_STANDARD_MASS}`);
  return tx;
}

/**
 * Consolidate `address`: fetch, plan and broadcast round after round until the spendable
 * UTXOs fit one batch. Safe to run again after an interruption — it starts from whatever
 * is still unmerged. Network failures and rejections end the run with `error` set.
 *
 * @param {{ api: object, address: string, privateKeyHex: string,
 *   onProgress?: (p: { round: number, done: number, total: number, sent: number, fees: number }) => void,
 *   sleep?: (ms: number) => Promise<void> }} opts
 * @returns {Promise<{ sent: number, fees: number, rounds: number, stalled: boolean, error: Error|null }>}
 */
export async function consolidate({ api, address, privateKeyHex, onProgress = () => {}, sleep = delay }) {
  const result = { sent: 0, fees: 0, rounds: 0, stalled: false, error: null };
  let idle = 0;
  try {
    for (;;) {
      if (result.rounds >= MAX_ROUNDS) {
        result.stalled = true;
        break;
      }
      const [utxos, info] = await Promise.all([api.utxos(address, UTXO_FETCH_LIMIT), api.info()]);
      const daa = info?.last_daa_score ?? 0;
      const { eligible, batches } = planConsolidation(utxos, daa);
      if (!batches.length) break;
      result.rounds++;

      let accepted = 0;
      for (let w = 0; w < batches.length; w += WAVE_SIZE) {
        if (w) await sleep(WAVE_PAUSE_MS);
        const wave = batches.slice(w, w + WAVE_SIZE);
        const outcomes = await Promise.allSettled(
          wave.map(async (batch) => api.broadcast(buildConsolidationTx(batch, address, privateKeyHex, daa)))
        );
        for (const o of outcomes) {
          if (o.status === 'fulfilled') {
            accepted++;
            result.sent++;
            result.fees += MIN_FEE_SOMPI;
          } else if (!ALREADY_SUBMITTED.test(o.reason instanceof Error ? o.reason.message : String(o.reason))) {
            result.error ??= o.reason instanceof Error ? o.reason : new Error(String(o.reason));
          }
        }
        onProgress({ round: result.rounds, done: w + wave.length, total: batches.length, sent: result.sent, fees: result.fees });
        if (result.error) return result;
      }

      // a short page whose spendable UTXOs all fit one batch was the last round
      if (utxos.length < UTXO_FETCH_LIMIT && eligible.length <= CONSOLIDATE_BATCH) break;
      idle = accepted ? 0 : idle + 1;
      if (idle >= MAX_IDLE_ROUNDS) {
        result.stalled = true;
        break;
      }
      await sleep(ROUND_PAUSE_MS);
    }
  } catch (e) {
    result.error = e instanceof Error ? e : new Error(String(e));
  }
  return result;
}
