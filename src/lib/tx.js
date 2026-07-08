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
const MESSAGE_KEY = new TextEncoder().encode('PersonalMessageSigningHash');

// Kaspa sighash types. Only SIGHASH_ALL is used by the official wallet and is
// network-proven; the other types follow the Kaspa consensus rules verbatim
// (needed for HTLC/P2SH flows initiated by dApps through the provider).
export const SIGHASH_ALL = 0x01;
export const SIGHASH_NONE = 0x02;
export const SIGHASH_SINGLE = 0x04;
export const SIGHASH_ANYONECANPAY = 0x80;
const SIGHASH_MASK = 0x07;
const VALID_SIGHASH_TYPES = new Set([0x01, 0x02, 0x04, 0x81, 0x82, 0x84]);
const ZERO_HASH = new Uint8Array(32);

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

// Sompi amounts arrive from the API as JSON numbers, and res.json() rounds any
// integer above Number.MAX_SAFE_INTEGER (2^53-1 sompi ≈ 90.07M KRX). We can't
// tell a rounded value from an exact one, so rather than risk signing a
// corrupted amount we refuse it here. This caps a single UTXO / one-tx input
// sum at ~90.07M KRX — unreachable for a personal wallet (~0.3% of total
// supply in one output). To lift it, parse amount fields from the raw response
// body with a BigInt-aware reviver (the shim writes exact digits; only
// JSON.parse loses them) and thread BigInt through coin selection and the u64()
// boundary, which already accepts BigInt.
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

/**
 * Kaspa TransactionSigningHash for input `idx` of the unsigned tx.
 * `hashType` follows the Kaspa consensus reused-values rules: ANYONECANPAY
 * zeroes the prevouts/sequences/sig-op-counts hashes, NONE/SINGLE zero or
 * narrow the outputs hash, and the type byte itself is the final update.
 */
export function transactionSigningHash(tx, idx, hashType = SIGHASH_ALL) {
  if (!VALID_SIGHASH_TYPES.has(hashType)) {
    throw new Error(`Invalid sighash type 0x${hashType.toString(16)} — allowed: ALL, NONE, SINGLE, each optionally | ANYONECANPAY`);
  }
  const anyoneCanPay = (hashType & SIGHASH_ANYONECANPAY) !== 0;
  const base = hashType & SIGHASH_MASK;
  const input = tx.inputs[idx];
  const h = keyedHash();
  h.update(u16(tx.version));

  if (anyoneCanPay) {
    h.update(ZERO_HASH);
  } else {
    const prevouts = keyedHash();
    for (const inp of tx.inputs) {
      prevouts.update(hexToBytes(inp.transaction_id));
      prevouts.update(u32(inp.index));
    }
    h.update(prevouts.digest());
  }

  if (anyoneCanPay || base === SIGHASH_NONE || base === SIGHASH_SINGLE) {
    h.update(ZERO_HASH);
  } else {
    const sequences = keyedHash();
    for (const inp of tx.inputs) sequences.update(u64(inp.sequence));
    h.update(sequences.digest());
  }

  if (anyoneCanPay) {
    h.update(ZERO_HASH);
  } else {
    const sigOpCounts = keyedHash();
    for (const inp of tx.inputs) sigOpCounts.update(new Uint8Array([inp.sig_op_count]));
    h.update(sigOpCounts.digest());
  }

  h.update(hexToBytes(input.transaction_id));
  h.update(u32(input.index));
  h.update(u16(input.utxo.script_version));
  h.update(lengthPrefixed(hexToBytes(input.utxo.script_public_key)));
  h.update(u64(safeAmount(input.utxo.amount_sompi, 'input UTXO amount')));
  h.update(u64(input.sequence));
  h.update(new Uint8Array([input.sig_op_count]));

  const hashOutput = (sink, out) => {
    sink.update(u64(safeAmount(out.amount, 'output amount')));
    sink.update(u16(out.script_version));
    sink.update(lengthPrefixed(hexToBytes(out.script_public_key)));
  };
  if (base === SIGHASH_NONE) {
    h.update(ZERO_HASH);
  } else if (base === SIGHASH_SINGLE) {
    if (idx >= tx.outputs.length) {
      h.update(ZERO_HASH);
    } else {
      const single = keyedHash();
      hashOutput(single, tx.outputs[idx]);
      h.update(single.digest());
    }
  } else {
    const outputs = keyedHash();
    for (const out of tx.outputs) hashOutput(outputs, out);
    h.update(outputs.digest());
  }

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
  h.update(new Uint8Array([hashType]));
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
 * Escrow script paying the executing miner, spendable only via an input whose
 * sequence encodes a relative lock >= lockBlocks:
 *   <lockBlocks LE minimal push> OP_CHECKSEQUENCEVERIFY OP_DATA_32 <x-only pubkey> OP_CHECKSIG
 * This is a RELATIVE (sequence) lock — keryx-node classifies exactly this
 * pattern as ScriptClass::CsvPubKey ("OPoI escrow"). Note the opcode
 * renumbering vs Bitcoin: on Keryx/Kaspa CSV = 0xb1 and CLTV = 0xb0.
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
  out[i++] = 0xb1; // OP_CHECKSEQUENCEVERIFY (Keryx/Kaspa numbering; CLTV is 0xb0)
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

// --- generalized signing (provider `signTx`: HTLC claim/refund, P2SH) ----------

const isHex = (s) => typeof s === 'string' && s.length % 2 === 0 && /^[0-9a-f]*$/.test(s);

function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Minimal data push: direct (≤75), OP_PUSHDATA1 (≤255) or OP_PUSHDATA2. */
function pushData(bytes) {
  if (bytes.length === 0) throw new Error('Refusing to push empty data');
  if (bytes.length <= 75) return concatBytes([new Uint8Array([bytes.length]), bytes]);
  if (bytes.length <= 255) return concatBytes([new Uint8Array([0x4c, bytes.length]), bytes]);
  if (bytes.length <= 65535) {
    return concatBytes([new Uint8Array([0x4d, bytes.length & 255, bytes.length >> 8]), bytes]);
  }
  throw new Error('Push data too large');
}

/**
 * Sign a dApp-supplied transaction (wire-JSON shape plus per-input directives).
 * This is the low-level path behind the provider's `signTx` — it makes HTLC
 * claim/refund and other custom-script spends possible.
 *
 * Input directives (per input):
 *   utxo               { amount_sompi, script_public_key, script_version? } —
 *                      required to sign this input (the on-chain script_public_key
 *                      of the outpoint, e.g. the P2SH script itself)
 *   sighash_type       default SIGHASH_ALL; any valid Kaspa combination
 *   redeem_script      hex — appended as the FINAL push of signature_script
 *                      (P2SH / script-path spend)
 *   sig_script_prefix  hex — raw bytes placed BEFORE the signature push
 *   sig_script_suffix  hex — raw bytes between the signature push and the
 *                      redeem-script push (e.g. `<preimage push> OP_TRUE` for
 *                      an HTLC claim branch)
 *   signature_script   hex — verbatim; the input is passed through untouched
 *                      (already signed elsewhere)
 *
 * Assembly for a signed input:
 *   prefix || 0x41 <sig(64) || hashType> || suffix || push(redeem_script)
 *
 * @returns {{ tx: object, unsigned: object, totalIn: number|null, totalOut: number, fee: number|null }}
 */
export function signTxJson(txJson, privateKeyHex) {
  if (!txJson || !Array.isArray(txJson.inputs) || txJson.inputs.length === 0) {
    throw new Error('Transaction has no inputs');
  }
  if (!Array.isArray(txJson.outputs) || txJson.outputs.length === 0) {
    throw new Error('Transaction has no outputs');
  }
  const subnetworkId = (txJson.subnetwork_id ?? NATIVE_SUBNETWORK_ID).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(subnetworkId)) throw new Error('Invalid subnetwork_id');
  const payloadHex = (txJson.payload ?? '').toLowerCase();
  if (!isHex(payloadHex)) throw new Error('Invalid payload hex');
  const lockTime = safeAmount(Number(txJson.lock_time ?? 0), 'lock_time');
  const gas = safeAmount(Number(txJson.gas ?? 0), 'gas');
  const version = txJson.version ?? 0;

  const outputs = txJson.outputs.map((o, i) => {
    safeAmount(o.amount, `output ${i} amount`);
    const spk = (o.script_public_key ?? '').toLowerCase();
    if (!isHex(spk) || spk.length === 0) throw new Error(`Output ${i}: missing/invalid script_public_key`);
    return { amount: o.amount, script_version: o.script_version ?? 0, script_public_key: spk };
  });

  const unsigned = {
    version,
    inputs: txJson.inputs.map((inp, i) => {
      const txid = (inp.transaction_id ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error(`Input ${i}: invalid transaction_id`);
      if (!Number.isInteger(inp.index) || inp.index < 0) throw new Error(`Input ${i}: invalid index`);
      const sequence = inp.sequence === undefined ? MAX_SEQUENCE : BigInt(inp.sequence);
      if (sequence < 0n || sequence > MAX_SEQUENCE) throw new Error(`Input ${i}: invalid sequence`);
      let utxo;
      if (inp.utxo) {
        const spk = (inp.utxo.script_public_key ?? '').toLowerCase();
        if (!isHex(spk) || spk.length === 0) throw new Error(`Input ${i}: invalid utxo script_public_key`);
        utxo = {
          amount_sompi: safeAmount(inp.utxo.amount_sompi, `input ${i} UTXO amount`),
          script_version: inp.utxo.script_version ?? 0,
          script_public_key: spk,
        };
      }
      return {
        transaction_id: txid,
        index: inp.index,
        sequence,
        sig_op_count: inp.sig_op_count ?? 1,
        utxo,
      };
    }),
    outputs,
    lock_time: BigInt(lockTime),
    subnetwork_id: subnetworkId,
    gas: BigInt(gas),
    payload: payloadHex ? hexToBytes(payloadHex) : new Uint8Array(0),
  };

  const privKey = hexToBytes(privateKeyHex);
  let signedCount = 0;
  const wireInputs = unsigned.inputs.map((inp, i) => {
    const src = txJson.inputs[i];
    let scriptHex;
    if (typeof src.signature_script === 'string' && src.signature_script.length > 0) {
      scriptHex = src.signature_script.toLowerCase();
      if (!isHex(scriptHex)) throw new Error(`Input ${i}: invalid verbatim signature_script`);
    } else {
      if (!inp.utxo) {
        throw new Error(`Input ${i}: cannot sign without a utxo entry (amount_sompi + script_public_key)`);
      }
      for (const [k, v] of Object.entries({
        sig_script_prefix: src.sig_script_prefix,
        sig_script_suffix: src.sig_script_suffix,
        redeem_script: src.redeem_script,
      })) {
        if (v !== undefined && (!isHex(String(v).toLowerCase()) || v.length === 0)) {
          throw new Error(`Input ${i}: invalid ${k} hex`);
        }
      }
      const hashType = src.sighash_type ?? SIGHASH_ALL;
      const sig = schnorr.sign(transactionSigningHash(unsigned, i, hashType), privKey);
      const sigPush = new Uint8Array(66);
      sigPush[0] = 0x41; // push 65 bytes: sig || sighash-type
      sigPush.set(sig, 1);
      sigPush[65] = hashType;
      const parts = [];
      if (src.sig_script_prefix) parts.push(hexToBytes(src.sig_script_prefix.toLowerCase()));
      parts.push(sigPush);
      if (src.sig_script_suffix) parts.push(hexToBytes(src.sig_script_suffix.toLowerCase()));
      if (src.redeem_script) parts.push(pushData(hexToBytes(src.redeem_script.toLowerCase())));
      scriptHex = bytesToHex(concatBytes(parts));
      signedCount++;
    }
    return {
      transaction_id: inp.transaction_id,
      index: inp.index,
      signature_script: scriptHex,
      sequence: inp.sequence.toString(),
      sig_op_count: inp.sig_op_count,
    };
  });
  if (signedCount === 0) {
    throw new Error('Nothing to sign: every input already carries a signature_script');
  }

  const totalOut = outputs.reduce((n, o) => n + o.amount, 0);
  const totalIn = unsigned.inputs.every((inp) => inp.utxo)
    ? unsigned.inputs.reduce((n, inp) => n + inp.utxo.amount_sompi, 0)
    : null;

  return {
    tx: {
      version,
      inputs: wireInputs,
      outputs,
      lock_time: lockTime,
      subnetwork_id: subnetworkId,
      gas,
      payload: payloadHex,
    },
    unsigned,
    totalIn,
    totalOut,
    fee: totalIn === null ? null : totalIn - totalOut,
  };
}

// --- personal message signing (provider `signMessage`) -------------------------

/** Kaspa-style personal message digest: keyed blake2b-256 ("PersonalMessageSigningHash"). */
export function personalMessageHash(message) {
  const h = blake2b.create({ key: MESSAGE_KEY, dkLen: 32 });
  h.update(new TextEncoder().encode(message));
  return h.digest();
}

/** @returns {string} 64-byte BIP340 Schnorr signature, hex. */
export function signPersonalMessage(message, privateKeyHex) {
  return bytesToHex(schnorr.sign(personalMessageHash(message), hexToBytes(privateKeyHex)));
}
