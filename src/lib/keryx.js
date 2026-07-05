// Keryx Network wallet primitives.
//
// Keryx is a Kaspa-derived UTXO chain. Facts below were extracted from the
// official wallet at https://keryx-labs.com/wallet (see docs/PROTOCOL.md):
//   - BIP39 mnemonic (24 words generated, 12/24 accepted on import)
//   - BIP32 secp256k1 HD derivation, path m/44'/111111'/0'/0/{index}
//   - Address: cashaddr-style base32, prefix "keryx", version byte 0,
//     payload = 32-byte x-only public key, 40-bit polymod checksum
//   - 1 KRX = 1e8 sompi

import {
  generateMnemonic as bip39Generate,
  validateMnemonic as bip39Validate,
  mnemonicToSeedSync,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';

export const ADDRESS_PREFIX = 'keryx';
export const DERIVATION_BASE = "m/44'/111111'/0'/0";
export const SOMPI_PER_KRX = 1e8;

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CHARSET_REV = new Int8Array(123).fill(-1);
for (let i = 0; i < CHARSET.length; i++) CHARSET_REV[CHARSET.charCodeAt(i)] = i;

// --- base32 (5-bit) conversion ---------------------------------------------

function toWords(bytes) {
  const out = new Uint8Array(Math.ceil((8 * bytes.length) / 5));
  let acc = 0, bits = 0, i = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out[i++] = (acc >> bits) & 31;
    }
  }
  if (bits > 0) out[i] = (acc << (5 - bits)) & 31;
  return out;
}

function fromWords(words) {
  const out = new Uint8Array(Math.floor((5 * words.length) / 8));
  let acc = 0, bits = 0, i = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out[i++] = (acc >> bits) & 255;
    }
  }
  return out;
}

// --- cashaddr polymod checksum (40-bit) -------------------------------------

function polymod(values) {
  let c = 1n;
  for (const v of values) {
    const top = c >> 35n;
    c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(v);
    if (top & 1n) c ^= 0x98f2bc8e61n;
    if (top & 2n) c ^= 0x79b76d99e2n;
    if (top & 4n) c ^= 0xf33e5fb3c4n;
    if (top & 8n) c ^= 0xae2eabe2a8n;
    if (top & 16n) c ^= 0x1e4f43e470n;
  }
  return c ^ 1n;
}

function checksumInput(dataWords, prefix) {
  const prefixBits = new TextEncoder().encode(prefix).map((c) => c & 31);
  const out = new Uint8Array(prefixBits.length + 1 + dataWords.length + 8);
  out.set(prefixBits, 0);
  out[prefixBits.length] = 0;
  out.set(dataWords, prefixBits.length + 1);
  return out; // trailing 8 zero slots = checksum template
}

function checksumWords(dataWords, prefix) {
  let mod = polymod(checksumInput(dataWords, prefix));
  const bytes = new Uint8Array(5);
  for (let i = 4; i >= 0; i--) {
    bytes[i] = Number(mod & 255n);
    mod >>= 8n;
  }
  return toWords(bytes).slice(0, 8);
}

// --- addresses ---------------------------------------------------------------

export function encodeAddress(version, payload, prefix = ADDRESS_PREFIX) {
  const raw = new Uint8Array(1 + payload.length);
  raw[0] = version;
  raw.set(payload, 1);
  const data = toWords(raw);
  const check = checksumWords(data, prefix);
  let s = '';
  for (const w of data) s += CHARSET[w];
  for (const w of check) s += CHARSET[w];
  return `${prefix}:${s}`;
}

export function decodeAddress(address) {
  const sep = address.indexOf(':');
  if (sep === -1) throw new Error('Invalid address: missing prefix');
  const prefix = address.slice(0, sep);
  const body = address.slice(sep + 1);
  if (body.length < 9) throw new Error('Invalid address: too short');
  const words = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) {
    const w = CHARSET_REV[body.charCodeAt(i)] ?? -1;
    if (w === -1) throw new Error(`Invalid character: ${body[i]}`);
    words[i] = w;
  }
  const data = words.slice(0, -8);
  const check = words.slice(-8);
  const expected = checksumWords(data, prefix);
  for (let i = 0; i < 8; i++) {
    if (check[i] !== expected[i]) throw new Error('Invalid address checksum');
  }
  const raw = fromWords(data);
  if (raw.length < 33) throw new Error('Address payload too short');
  return { prefix, version: raw[0], payload: raw.slice(1, 33) };
}

export function isValidAddress(address, prefix = ADDRESS_PREFIX) {
  try {
    return decodeAddress(address).prefix === prefix;
  } catch {
    return false;
  }
}

// script_public_key for a version-0 (schnorr) address: OP_DATA_32 <pubkey> OP_CHECKSIG
export function addressToScriptPublicKey(address) {
  const { payload } = decodeAddress(address);
  const script = new Uint8Array(34);
  script[0] = 0x20;
  script.set(payload, 1);
  script[33] = 0xac;
  return bytesToHex(script);
}

// --- keys --------------------------------------------------------------------

export function generateMnemonic() {
  return bip39Generate(wordlist, 256); // 24 words
}

export function validateMnemonic(mnemonic) {
  return bip39Validate(mnemonic, wordlist);
}

export function deriveWallet(mnemonic, index = 0) {
  const seed = mnemonicToSeedSync(mnemonic);
  const node = HDKey.fromMasterSeed(seed).derive(`${DERIVATION_BASE}/${index}`);
  if (!node.privateKey || !node.publicKey) throw new Error('Key derivation failed');
  return {
    // x-only pubkey: drop the parity byte of the 33-byte compressed key
    address: encodeAddress(0, node.publicKey.slice(1)),
    privateKeyHex: bytesToHex(node.privateKey),
    publicKeyHex: bytesToHex(node.publicKey),
  };
}

// --- amounts / misc ----------------------------------------------------------

export function formatKRX(sompi) {
  return (sompi / SOMPI_PER_KRX).toFixed(8).replace(/\.?0+$/, '') || '0';
}

export function parseKRX(str) {
  return Math.round(SOMPI_PER_KRX * parseFloat(str));
}

export function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function shortAddress(addr, head = 14, tail = 8) {
  if (!addr || addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
