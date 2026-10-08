// Private (end-to-end encrypted) AI inference — keryx-node H14.
//
// From the H14 hardfork (keryx-node `private_inference_activation`, mainnet
// DAA 121,985,000) every AiRequest prompt must be a sealed envelope readable
// only by the miners of the requested tier, and every answer comes back
// inline in the AiResponse, sealed to the requester. Port of keryx-node
// `inference/src/private.rs` (wire formats, key schedule) and
// `consensus/core/src/collateral.rs` (target cohort); see docs/PROTOCOL.md.
//
// Request envelope = the whole `prompt` field of the AiRequest payload:
//   [magic 00 'K' 'X' 'P'] [version 01] [ephemeral pubkey: 33 compressed]
//   [nonce: 12] [n: 1, 1..=128]
//   n × { [escrow pubkey: 32 x-only, strictly ascending] [wrapped root key: 48] }
//   [ChaCha20-Poly1305(k_prompt, nonce, prompt)]
// Response envelope = the AiResponse inline body:
//   [magic] [version] [nonce: 12] [ChaCha20-Poly1305(k_response, nonce, answer)]
//
// Keys: ss_i = SHA-256(compressed ECDH(e, lift_x(R_i))) (libsecp default),
// kek_i = HKDF(salt, ss_i, "kek" ‖ E ‖ R_i) wraps the root key under the
// 52-byte request header as AAD; k_prompt = HKDF(salt, root, "prompt") with
// AAD = request header ‖ envelope header; k_response = HKDF(salt, root,
// "response" ‖ responder key) with AAD = request id ‖ responder key. The
// request id is the AiRequest's tx id (H8 request identity).
//
// The root key is derived, not drawn: HKDF(salt "KeryxChatRootKeyV1",
// ikm = account private key, info = "root" ‖ cohort seed), exactly as the
// keryx-labs.com /infer page does. The cohort seed is the outpoint the first
// input spends, which no other transaction can spend, so every request gets
// its own key — and both clients can open each other's answers from the
// seed phrase alone, with no secret stored anywhere.

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

const utf8 = (s) => new TextEncoder().encode(s);

export const PRIVATE_MAGIC = new Uint8Array([0x00, 0x4b, 0x58, 0x50]); // 00 'K' 'X' 'P'
export const PRIVATE_VERSION = 1;
/** Recipients one envelope may name — the whole target cohort. */
export const MAX_PRIVATE_RECIPIENTS = 128;
/** The fixed AiRequest header before the prompt: model id, max_tokens, reward, fee. */
export const AI_REQUEST_HEADER_LEN = 52;
/** Largest AiRequest payload before H14 (plaintext prompts). */
export const MAX_AI_REQUEST_PAYLOAD_LEN = 4096;
/** Largest AiRequest payload from H14 on (sealed prompts). */
export const MAX_AI_REQUEST_PRIVATE_PAYLOAD_LEN = 65536;
/** keryx-cli and keryx-labs.com also seal to the providers of the last 18,000 DAA (~30 min). */
export const SEAL_WINDOW_DAA = 18000;

const NONCE_LEN = 12;
const TAG_LEN = 16;
const ENTRY_LEN = 32 + 32 + TAG_LEN; // escrow key + wrapped root key
const REQUEST_HEADER_LEN = PRIVATE_MAGIC.length + 1 + 33 + NONCE_LEN + 1;
const RESPONSE_HEADER_LEN = PRIVATE_MAGIC.length + 1 + NONCE_LEN;

const KDF_SALT = utf8('KeryxPrivateInferenceV1');
const INFO_KEK = utf8('kek');
const INFO_PROMPT = utf8('prompt');
const INFO_RESPONSE = utf8('response');
const COHORT_DOMAIN = utf8('KeryxPrivateCohortV1');
const ROOT_SALT = utf8('KeryxChatRootKeyV1');
const INFO_ROOT = utf8('root');

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function compare(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Strict hex → bytes: these values come from the API host, never trust their shape. */
export function hexBytes(hex, len) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  if (len !== undefined && out.length !== len) throw new Error(`Expected ${len} bytes, got ${out.length}`);
  return out;
}

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

const kdf = (ikm, ...info) => hkdf(sha256, ikm, KDF_SALT, concat(...info), 32);

const hasMagic = (bytes) => bytes.length >= PRIVATE_MAGIC.length && compare(bytes.subarray(0, 4), PRIVATE_MAGIC) === 0;

/** The 52-byte AiRequest header — bound into every key wrap and the prompt as AAD. */
export function requestHeader(modelIdHex, maxTokens, rewardSompi, priorityFeeSompi) {
  if (!Number.isInteger(maxTokens) || maxTokens < 0 || maxTokens > 0xffffffff) throw new Error('max_tokens out of range');
  for (const [v, what] of [[rewardSompi, 'inference reward'], [priorityFeeSompi, 'priority fee']]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`Invalid ${what}`);
  }
  const out = new Uint8Array(AI_REQUEST_HEADER_LEN);
  const view = new DataView(out.buffer);
  out.set(hexBytes(modelIdHex, 32), 0);
  view.setUint32(32, maxTokens, true);
  view.setBigUint64(36, BigInt(rewardSompi), true);
  view.setBigUint64(44, BigInt(priorityFeeSompi), true);
  return out;
}

/** Cohort seed of a request whose first input spends `txId:index` (`txid ‖ u32le index`). */
export function cohortSeed(txId, index) {
  const seed = new Uint8Array(36);
  seed.set(hexBytes(txId, 32), 0);
  new DataView(seed.buffer).setUint32(32, index, true);
  return seed;
}

/** Rank of an escrow key in the target cohort drawn from `seed`; lower ranks are kept. */
export function cohortRank(seed, key) {
  return blake2b(concat(COHORT_DOMAIN, seed, key), { dkLen: 32 });
}

function uniqueKeys(keysHex) {
  return [...new Set(keysHex.map((k) => k.toLowerCase()))].map((k) => hexBytes(k, 32)).sort(compare);
}

function byRank(seed, keys) {
  return keys
    .map((key) => ({ key, rank: cohortRank(seed, key) }))
    .sort((a, b) => compare(a.rank, b.rank) || compare(a.key, b.key))
    .map((e) => e.key);
}

/**
 * The escrow keys (hex, ascending) a request seeded with `seed` is sealed to:
 * the target cohort — the whole tier cohort up to 128 keys, else its 128
 * lowest-ranked — which the mempool requires in full, completed by rank with
 * the tier's providers of the last SEAL_WINDOW_DAA up to the 128 cap, so
 * miners that rejoin before the request arms can read it too.
 */
export function sealRecipients(seed, cohortHex, windowHex = []) {
  let target = uniqueKeys(cohortHex);
  if (target.length > MAX_PRIVATE_RECIPIENTS) target = byRank(seed, target).slice(0, MAX_PRIVATE_RECIPIENTS);
  const named = new Set(target.map(toHex));
  const extra = byRank(seed, uniqueKeys(windowHex).filter((k) => !named.has(toHex(k))))
    .slice(0, MAX_PRIVATE_RECIPIENTS - target.length);
  return [...target, ...extra].sort(compare).map(toHex);
}

/** The request's root key, derived like keryx-labs.com /infer: HKDF(privkey, "root" ‖ seed). */
export function deriveRootKey(privateKeyHex, seed) {
  return hkdf(sha256, hexBytes(privateKeyHex, 32), ROOT_SALT, concat(INFO_ROOT, seed), 32);
}

/** Largest prompt (bytes) an envelope naming `n` recipients fits in a payload of `maxPayload`. */
export function maxPrivatePromptLen(n, maxPayload = MAX_AI_REQUEST_PRIVATE_PAYLOAD_LEN) {
  const cap = Math.min(maxPayload, MAX_AI_REQUEST_PRIVATE_PAYLOAD_LEN);
  return Math.max(0, cap - AI_REQUEST_HEADER_LEN - (REQUEST_HEADER_LEN + ENTRY_LEN * n + TAG_LEN));
}

/**
 * Largest AiRequest payload a transaction with `nInputs` inputs can carry
 * within the standard mass limits: transient mass (4 per byte) under the
 * AiRequest allowance of (64 KiB + 4 KiB) × 4, compute mass (1 per byte,
 * 1000 per sig-op, 10 per script byte) under 100,000. Same conservative
 * size estimate as keryx-labs.com.
 */
export function maxRequestPayloadLen(nInputs) {
  const overhead = 120 + 130 * nInputs + 180;
  return Math.max(0, Math.min(
    MAX_AI_REQUEST_PRIVATE_PAYLOAD_LEN,
    MAX_AI_REQUEST_PRIVATE_PAYLOAD_LEN + 4096 - overhead,
    100000 - overhead - 1000 * nInputs - 1200
  ));
}

/** Whether bytes start with the envelope marker (no plaintext UTF-8 prompt can). */
export function isSealed(bytes) {
  return hasMagic(bytes);
}

/**
 * Requester side: the AiRequest payload (hex) carrying `prompt` sealed to
 * `recipientsHex` (escrow keys, any order). `rootKey` comes from deriveRootKey.
 */
export function sealRequest({ modelIdHex, maxTokens, rewardSompi, priorityFeeSompi, prompt, recipientsHex, rootKey, maxPayload }) {
  const keys = uniqueKeys(recipientsHex);
  if (keys.length === 0) throw new Error('No recipients: no miner of this tier is eligible right now');
  if (keys.length > MAX_PRIVATE_RECIPIENTS) throw new Error(`Too many recipients: ${keys.length}`);
  if (rootKey?.length !== 32) throw new Error('Root key must be 32 bytes');
  const points = keys.map((k) => {
    try {
      return secp256k1.Point.fromBytes(concat(new Uint8Array([0x02]), k)).toBytes(true); // BIP-340 even-Y lift
    } catch {
      throw new Error('Invalid escrow key');
    }
  });
  const message = typeof prompt === 'string' ? utf8(prompt) : prompt;
  const maxPrompt = maxPrivatePromptLen(keys.length, maxPayload);
  if (message.length > maxPrompt) {
    throw new Error(`Prompt of ${message.length} bytes does not fit (maximum ${maxPrompt} for ${keys.length} recipients)`);
  }

  const header = requestHeader(modelIdHex, maxTokens, rewardSompi, priorityFeeSompi);
  const nonce = randomBytes(NONCE_LEN);
  const ephemeral = secp256k1.utils.randomSecretKey();
  const E = secp256k1.getPublicKey(ephemeral, true);
  const entries = keys.map((key, i) => {
    const ss = sha256(secp256k1.getSharedSecret(ephemeral, points[i], true));
    const kek = kdf(ss, INFO_KEK, E, key);
    return concat(key, chacha20poly1305(kek, nonce, header).encrypt(rootKey));
  });
  const envelopeHeader = concat(PRIVATE_MAGIC, new Uint8Array([PRIVATE_VERSION]), E, nonce,
    new Uint8Array([keys.length]), ...entries);
  const ciphertext = chacha20poly1305(kdf(rootKey, INFO_PROMPT), nonce, concat(header, envelopeHeader)).encrypt(message);
  return toHex(concat(header, envelopeHeader, ciphertext));
}

function parseRequestEnvelope(payload) {
  const prompt = payload.subarray(AI_REQUEST_HEADER_LEN);
  if (!hasMagic(prompt)) throw new Error('Not a private-inference envelope');
  if (prompt.length < REQUEST_HEADER_LEN) throw new Error('Truncated envelope');
  if (prompt[4] !== PRIVATE_VERSION) throw new Error('Unsupported envelope version');
  const n = prompt[50];
  const headerLen = REQUEST_HEADER_LEN + ENTRY_LEN * n;
  if (n === 0 || prompt.length < headerLen + TAG_LEN) throw new Error('Truncated envelope');
  return {
    header: payload.subarray(0, AI_REQUEST_HEADER_LEN),
    ephemeral: prompt.subarray(5, 38),
    nonce: prompt.subarray(38, 50),
    recipients: Array.from({ length: n }, (_, i) => {
      const at = REQUEST_HEADER_LEN + i * ENTRY_LEN;
      return { key: prompt.subarray(at, at + 32), wrapped: prompt.subarray(at + 32, at + ENTRY_LEN) };
    }),
    envelopeHeader: prompt.subarray(0, headerLen),
    ciphertext: prompt.subarray(headerLen),
  };
}

/** Requester side: the plaintext of one's own sealed request, from its payload bytes. */
export function openOwnPrompt(rootKey, payload) {
  const env = parseRequestEnvelope(payload);
  const aad = concat(env.header, env.envelopeHeader);
  return new TextDecoder().decode(chacha20poly1305(kdf(rootKey, INFO_PROMPT), env.nonce, aad).decrypt(env.ciphertext));
}

/**
 * Requester side: the answer a responder sealed for request `requestIdHex`
 * (the AiRequest tx id). Throws when the body does not open — a responder
 * that could not read the request answers with a plaintext note instead.
 */
export function openResponse(rootKey, requestIdHex, responderHex, body) {
  if (!hasMagic(body) || body.length < RESPONSE_HEADER_LEN + TAG_LEN) throw new Error('Not a private-inference envelope');
  if (body[4] !== PRIVATE_VERSION) throw new Error('Unsupported envelope version');
  const responder = hexBytes(responderHex, 32);
  const key = kdf(rootKey, INFO_RESPONSE, responder);
  const aad = concat(hexBytes(requestIdHex, 32), responder);
  const nonce = body.subarray(PRIVATE_MAGIC.length + 1, RESPONSE_HEADER_LEN);
  return new TextDecoder().decode(chacha20poly1305(key, nonce, aad).decrypt(body.subarray(RESPONSE_HEADER_LEN)));
}

// --- responder side (what a tier miner does) — used by the test suites ----------

/** Miner side: opens a sealed request with its escrow secret → { prompt, rootKey }. */
export function openRequest(payload, escrowSecretHex) {
  const env = parseRequestEnvelope(payload);
  let sk = hexBytes(escrowSecretHex, 32);
  const full = secp256k1.getPublicKey(sk, true);
  const mine = full.subarray(1);
  const entry = env.recipients.find((r) => compare(r.key, mine) === 0);
  if (!entry) throw new Error('This escrow key is not among the envelope recipients');
  if (full[0] === 0x03) {
    // The requester lifted the x-only key to its even-Y point: negate the secret to match.
    const n = secp256k1.Point.CURVE().n;
    sk = hexBytes((n - BigInt('0x' + toHex(sk))).toString(16).padStart(64, '0'), 32);
  }
  const ss = sha256(secp256k1.getSharedSecret(sk, env.ephemeral, true));
  const rootKey = chacha20poly1305(kdf(ss, INFO_KEK, env.ephemeral, mine), env.nonce, env.header).decrypt(entry.wrapped);
  const aad = concat(env.header, env.envelopeHeader);
  const prompt = new TextDecoder().decode(chacha20poly1305(kdf(rootKey, INFO_PROMPT), env.nonce, aad).decrypt(env.ciphertext));
  return { prompt, rootKey, recipients: env.recipients.map((r) => toHex(r.key)) };
}

/** Miner side: seals `answer` for the requester (the AiResponse inline body). */
export function sealResponse(rootKey, requestIdHex, responderHex, answer) {
  const responder = hexBytes(responderHex, 32);
  const nonce = randomBytes(NONCE_LEN);
  const aad = concat(hexBytes(requestIdHex, 32), responder);
  const ct = chacha20poly1305(kdf(rootKey, INFO_RESPONSE, responder), nonce, aad).encrypt(utf8(answer));
  return concat(PRIVATE_MAGIC, new Uint8Array([PRIVATE_VERSION]), nonce, ct);
}
