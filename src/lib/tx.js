// Keryx transaction building & signing.
//
// Faithful port of the official web wallet's signer (see docs/PROTOCOL.md):
// Kaspa-style sighash = keyed blake2b-256 ("TransactionSigningHash"), BIP340
// Schnorr signatures, signature_script = 0x41 || sig(64) || 0x01 (SIGHASH_ALL).

import { blake2b } from '@noble/hashes/blake2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { addressToScriptPublicKey, hexToBytes, bytesToHex } from './keryx.js';

export const NATIVE_SUBNETWORK_ID = '0000000000000000000000000000000000000000';
export const INFERENCE_SUBNETWORK_ID = '0300000000000000000000000000000000000000';
export const MIN_FEE_SOMPI = 30000000; // 0.3 KRX
export const COINBASE_MATURITY_DAA = 1000;
export const ESCROW_LOCK_BLOCKS = 36000;
// mass constraint used by the official wallet: 1e12/change + 1e12/escrow <= 8e4
const MASS_LIMIT = 80000;

const MAX_SEQUENCE = 18446744073709551615n;
const SIGHASH_KEY = new TextEncoder().encode('TransactionSigningHash');

const keyedHash = () => blake2b.create({ key: SIGHASH_KEY, dkLen: 32 });

function u16(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function u64(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
}

function safeAmount(n, what) {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${what} (${n}) outside JS safe-integer range — refusing to sign a possibly corrupted amount`);
  }
  return n;
}

function lengthPrefixed(bytes) {
  const out = new Uint8Array(8 + bytes.length);
  out.set(u64(bytes.length), 0);
  out.set(bytes, 8);
  return out;
}

/** Kaspa TransactionSigningHash for input `idx` of the unsigned tx (SIGHASH_ALL). */
export function transactionSigningHash(tx, idx) {
  const input = tx.inputs[idx];
  const h = keyedHash();
  h.update(u16(tx.version));

  const prevouts = keyedHash();
  for (const inp of tx.inputs) {
    prevouts.update(hexToBytes(inp.transaction_id));
    prevouts.update(u32(inp.index));
  }
  h.update(prevouts.digest());

  const sequences = keyedHash();
  for (const inp of tx.inputs) sequences.update(u64(inp.sequence));
  h.update(sequences.digest());

  const sigOpCounts = keyedHash();
  for (const inp of tx.inputs) sigOpCounts.update(new Uint8Array([inp.sig_op_count]));
  h.update(sigOpCounts.digest());

  h.update(hexToBytes(input.transaction_id));
  h.update(u32(input.index));
  h.update(u16(input.utxo.script_version));
  h.update(lengthPrefixed(hexToBytes(input.utxo.script_public_key)));
  h.update(u64(safeAmount(input.utxo.amount_sompi, 'input UTXO amount')));
  h.update(u64(input.sequence));
  h.update(new Uint8Array([input.sig_op_count]));

  const outputs = keyedHash();
  for (const out of tx.outputs) {
    outputs.update(u64(safeAmount(out.amount, 'output amount')));
    outputs.update(u16(out.script_version));
    outputs.update(lengthPrefixed(hexToBytes(out.script_public_key)));
  }
  h.update(outputs.digest());

  h.update(u64(tx.lock_time));
  h.update(hexToBytes(tx.subnetwork_id));
  h.update(u64(tx.gas));
  if (tx.subnetwork_id === NATIVE_SUBNETWORK_ID && tx.payload.length === 0) {
    h.update(new Uint8Array(32));
  } else {
    const p = keyedHash();
    p.update(lengthPrefixed(tx.payload));
    h.update(p.digest());
  }
  h.update(new Uint8Array([1])); // SIGHASH_ALL
  return h.digest();
}

/** UTXOs that are confirmed and past coinbase maturity. */
export function spendableUtxos(utxos, currentDaaScore = 0) {
  return utxos.filter(
    (u) =>
      u.block_daa_score > 0 &&
      !(u.is_coinbase && currentDaaScore > 0 && u.block_daa_score + COINBASE_MATURITY_DAA > currentDaaScore)
  );
}

/**
 * Build and sign a KRX transfer. Greedy largest-first coin selection until
 * amount + fee is covered; change (if any) returns to `changeAddress`.
 *
 * @returns {{ tx: object, totalIn: number, totalOut: number, fee: number, change: number }}
 */
export function buildTransferTx({
  utxos,
  toAddress,
  amountSompi,
  feeSompi,
  changeAddress,
  privateKeyHex,
  currentDaaScore = 0,
  payloadHex = '',
  subnetworkId = NATIVE_SUBNETWORK_ID,
}) {
  if (!Number.isSafeInteger(amountSompi) || amountSompi <= 0) throw new Error('Invalid amount');
  if (!Number.isSafeInteger(feeSompi) || feeSompi < 0) throw new Error('Invalid fee');

  const need = amountSompi + feeSompi;
  const candidates = spendableUtxos(utxos, currentDaaScore).sort(
    (a, b) => b.amount_sompi - a.amount_sompi
  );

  const selected = [];
  let sum = 0;
  for (const u of candidates) {
    selected.push(u);
    sum += u.amount_sompi;
    if (sum >= need) break;
  }
  if (sum < need) {
    throw new Error(`Insufficient funds: have ${sum} sompi, need ${need} sompi (amount + fee)`);
  }
  safeAmount(sum, 'total input sum');

  const change = sum - amountSompi - feeSompi;
  const outputs = [
    { amount: amountSompi, script_version: 0, script_public_key: addressToScriptPublicKey(toAddress) },
  ];
  if (change > 0) {
    outputs.push({
      amount: change,
      script_version: 0,
      script_public_key: addressToScriptPublicKey(changeAddress),
    });
  }

  const payload = payloadHex ? hexToBytes(payloadHex) : new Uint8Array(0);
  const unsigned = {
    version: 0,
    inputs: selected.map((u) => ({
      transaction_id: u.transaction_id,
      index: u.index,
      sequence: MAX_SEQUENCE,
      sig_op_count: 1,
      utxo: {
        amount_sompi: u.amount_sompi,
        script_version: u.script_version,
        script_public_key: u.script_public_key,
      },
    })),
    outputs,
    lock_time: 0n,
    subnetwork_id: subnetworkId,
    gas: 0n,
    payload,
  };

  const tx = signTransaction(unsigned, outputs, subnetworkId, payloadHex, privateKeyHex);
  return { tx, unsigned, totalIn: sum, totalOut: amountSompi, fee: feeSompi, change };
}

function signTransaction(unsigned, outputs, subnetworkId, payloadHex, privateKeyHex) {
  const privKey = hexToBytes(privateKeyHex);
  return {
    version: 0,
    inputs: unsigned.inputs.map((inp, i) => {
      const sig = schnorr.sign(transactionSigningHash(unsigned, i), privKey);
      const script = new Uint8Array(66);
      script[0] = 0x41; // push 65 bytes: sig || sighash-type
      script.set(sig, 1);
      script[65] = 0x01; // SIGHASH_ALL
      return {
        transaction_id: inp.transaction_id,
        index: inp.index,
        signature_script: bytesToHex(script),
        sequence: MAX_SEQUENCE.toString(),
        sig_op_count: 1,
      };
    }),
    outputs,
    lock_time: 0,
    subnetwork_id: subnetworkId,
    gas: 0,
    payload: payloadHex,
  };
}

// --- AI inference (AiRequest transactions) ------------------------------------

/**
 * Binary AiRequest payload, hex-encoded:
 * [0..32) model id, u32le max_tokens @32, u64le reward @36, u64le priority fee @44,
 * utf-8 prompt from 52.
 */
export function buildInferencePayload(prompt, modelIdHex, maxTokens = 128, rewardSompi = 0, priorityFeeSompi = MIN_FEE_SOMPI) {
  const promptBytes = new TextEncoder().encode(prompt);
  const buf = new ArrayBuffer(52 + promptBytes.length);
  const view = new DataView(buf);
  const arr = new Uint8Array(buf);
  arr.set(hexToBytes(modelIdHex), 0);
  view.setUint32(32, maxTokens, true);
  view.setBigUint64(36, BigInt(safeAmount(rewardSompi, 'inference reward')), true);
  view.setBigUint64(44, BigInt(safeAmount(priorityFeeSompi, 'priority fee')), true);
  arr.set(promptBytes, 52);
  return bytesToHex(arr);
}

/**
 * Escrow script paying the executing miner, refundable to them only after the
 * lock: <lockBlocks LE minimal push> OP_CHECKLOCKTIMEVERIFY OP_DATA_32 <x-only pubkey> OP_CHECKSIG
 */
export function escrowScriptPublicKey(pubkeyHex, lockBlocks = ESCROW_LOCK_BLOCKS) {
  const pubkey = hexToBytes(pubkeyHex);
  const lockBytes = [];
  let v = lockBlocks;
  while (v > 0) {
    lockBytes.push(v & 255);
    v = Math.floor(v / 256);
  }
  const out = new Uint8Array(1 + lockBytes.length + 1 + 1 + 32 + 1);
  let i = 0;
  out[i++] = lockBytes.length;
  for (const b of lockBytes) out[i++] = b;
  out[i++] = 0xb1; // OP_CHECKLOCKTIMEVERIFY
  out[i++] = 0x20; // OP_DATA_32
  out.set(pubkey, i);
  i += 32;
  out[i++] = 0xac; // OP_CHECKSIG
  return bytesToHex(out);
}

/**
 * Build and sign a payload-carrying transaction (AiRequest), faithful port of
 * the official wallet's advanced builder: self-change plus an optional escrow
 * output, with the change either kept (if the mass constraint allows) or
 * folded into the fee.
 */
export function buildInferenceTx({
  utxos,
  changeAddress,
  feeSompi,
  privateKeyHex,
  currentDaaScore = 0,
  payloadHex = '',
  subnetworkId = INFERENCE_SUBNETWORK_ID,
  escrow, // { pubkeyHex, amountSompi } | undefined
}) {
  if (!Number.isSafeInteger(feeSompi) || feeSompi < 0) throw new Error('Invalid fee');
  const escrowAmount = escrow?.amountSompi ?? 0;
  const need = feeSompi + escrowAmount;
  const escrowMass = escrowAmount > 0 ? 1e12 / escrowAmount : 0;

  const candidates = spendableUtxos(utxos, currentDaaScore).sort(
    (a, b) => b.amount_sompi - a.amount_sompi
  );
  const selected = [];
  let sum = 0;
  for (const u of candidates) {
    selected.push(u);
    sum += u.amount_sompi;
    const change = sum - need;
    if (change > 0 && 1e12 / change + escrowMass <= MASS_LIMIT) break;
  }
  if (sum <= need) {
    throw new Error(`Insufficient funds: need more than ${need} sompi across your UTXOs (have ${sum})`);
  }
  safeAmount(sum, 'total input sum');

  let change = sum - need;
  // change too small to satisfy the mass limit -> fold it into the fee
  const dropChange = escrowAmount > 0 && 1e12 / change + escrowMass > MASS_LIMIT;
  const extraFee = dropChange ? change : 0;
  if (dropChange) change = 0;

  const outputs = [];
  if (!dropChange) {
    outputs.push({
      amount: change,
      script_version: 0,
      script_public_key: addressToScriptPublicKey(changeAddress),
    });
  }
  if (escrow) {
    outputs.push({
      amount: escrowAmount,
      script_version: 0,
      script_public_key: escrowScriptPublicKey(escrow.pubkeyHex),
    });
  }

  const payload = payloadHex ? hexToBytes(payloadHex) : new Uint8Array(0);
  const unsigned = {
    version: 0,
    inputs: selected.map((u) => ({
      transaction_id: u.transaction_id,
      index: u.index,
      sequence: MAX_SEQUENCE,
      sig_op_count: 1,
      utxo: {
        amount_sompi: u.amount_sompi,
        script_version: u.script_version,
        script_public_key: u.script_public_key,
      },
    })),
    outputs,
    lock_time: 0n,
    subnetwork_id: subnetworkId,
    gas: 0n,
    payload,
  };

  const tx = signTransaction(unsigned, outputs, subnetworkId, payloadHex, privateKeyHex);
  return {
    tx,
    unsigned,
    totalIn: sum,
    totalOut: change + escrowAmount,
    fee: feeSompi + extraFee,
  };
}
