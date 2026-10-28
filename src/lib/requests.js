// Sealed (H14) inference requests sent from this wallet, kept per account so
// the popup can show their prompts and answers later — an answer arrives
// after the popup has usually closed.
//
// Stored in chrome.storage.local under `krx_inf.<address>`, encrypted with
// AES-256-GCM under a key derived from the account's private key, so prompts
// and answers are as private on disk as they are on-chain. Nothing secret is
// stored: a request's secret is re-derived from the private key and the
// record's cohort seed (private.js deriveRequestSecret) whenever an answer is
// opened.
//
// Record: { id (request tx id), seed (hex, 36 B), schedule (key schedule 1|2;
//   absent on v0.7.0 records, which are all 1), model (key), maxTokens,
//   rewardSompi, feeSompi, recipients (count), prompt, sentAt, origin?,
//   status: 'pending'|'answered'|'failed', answer?, responder?, answeredAt?,
//   responses?, note? (a responder's plaintext "could not open") }

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexBytes } from './private.js';

const PREFIX = 'krx_inf.';
const MAX_RECORDS = 50;
const utf8 = (s) => new TextEncoder().encode(s);
const STORE_SALT = utf8('KeryxWalletInferenceStoreV1');
const STORE_INFO = utf8('aes-256-gcm');

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function storeKey(privateKeyHex) {
  const raw = hkdf(sha256, hexBytes(privateKeyHex, 32), STORE_SALT, STORE_INFO, 32);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** The account's sealed requests, newest first ([] when none or unreadable). */
export async function loadRequests(wallet) {
  const key = PREFIX + wallet.address;
  try {
    const { [key]: stored } = await chrome.storage.local.get(key);
    if (!stored) return [];
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(stored.iv) },
      await storeKey(wallet.privateKeyHex),
      fromBase64(stored.data)
    );
    const list = JSON.parse(new TextDecoder().decode(plain));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function saveRequests(wallet, list) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await storeKey(wallet.privateKeyHex),
    utf8(JSON.stringify(list.slice(0, MAX_RECORDS)))
  ));
  await chrome.storage.local.set({ [PREFIX + wallet.address]: { iv: toBase64(iv), data: toBase64(data) } });
}

export async function addRequest(wallet, record) {
  const list = await loadRequests(wallet);
  await saveRequests(wallet, [record, ...list.filter((r) => r.id !== record.id)]);
}

/** Merge `patch` into the request `id`; returns the updated list. */
export async function updateRequest(wallet, id, patch) {
  const list = (await loadRequests(wallet)).map((r) => (r.id === id ? { ...r, ...patch } : r));
  await saveRequests(wallet, list);
  return list;
}
