// Encrypted account-store vault.
//
// One global session password secures ALL accounts: the vault ciphertext is a
// JSON store { accounts: [{ id, label, mnemonic, index }] } encrypted with
// PBKDF2-SHA256 (600k iterations) -> AES-256-GCM (the scheme the official web
// wallet uses for its single mnemonic). Ciphertext lives in
// chrome.storage.local and never leaves the device.
//
// The derived AES key (raw hex) is handed to the caller so the store can be
// re-encrypted on account add/change without re-prompting for the password;
// it must only ever be kept in chrome.storage.session (memory-backed).

const VAULT_KEY = 'krx_sess';
const ITERATIONS = 600000;

function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

async function deriveRawKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    256
  );
  return new Uint8Array(bits);
}

function importAesKey(rawKey) {
  return crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptToRecord(plaintext, rawKey, saltHex, iterations) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(rawKey);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { v: 2, salt: saltHex, iv: bytesToHex(iv), ct: bytesToHex(new Uint8Array(ct)), it: iterations };
}

/** Create a fresh vault for `store` under `password`. Returns the raw AES key (hex). */
export async function createVault(store, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const rawKey = await deriveRawKey(password, salt, ITERATIONS);
  const record = await encryptToRecord(JSON.stringify(store), rawKey, bytesToHex(salt), ITERATIONS);
  await chrome.storage.local.set({ [VAULT_KEY]: record });
  return { rawKeyHex: bytesToHex(rawKey) };
}

/**
 * Decrypt the vault. Returns { store, rawKeyHex } or null on wrong password /
 * no vault. Transparently migrates a v1 vault (plaintext = bare mnemonic) to
 * the v2 account-store format.
 */
export async function unlockVault(password) {
  const { [VAULT_KEY]: vault } = await chrome.storage.local.get(VAULT_KEY);
  if (!vault) return null;
  try {
    const rawKey = await deriveRawKey(password, hexToBytes(vault.salt), vault.it ?? ITERATIONS);
    const key = await importAesKey(rawKey);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(vault.iv) },
      key,
      hexToBytes(vault.ct)
    );
    const text = new TextDecoder().decode(pt);
    const rawKeyHex = bytesToHex(rawKey);

    let store;
    try {
      store = JSON.parse(text);
    } catch {
      store = null;
    }
    if (!store || !Array.isArray(store.accounts)) {
      // v1 vault: plaintext was a single bare mnemonic
      store = {
        accounts: [{ id: crypto.randomUUID(), label: 'Account 1', mnemonic: text.trim(), index: 0 }],
      };
      await updateVault(store, rawKeyHex);
    }
    return { store, rawKeyHex };
  } catch {
    return null;
  }
}

/** Re-encrypt `store` with the already-derived key (no password prompt). */
export async function updateVault(store, rawKeyHex) {
  const { [VAULT_KEY]: vault } = await chrome.storage.local.get(VAULT_KEY);
  if (!vault) throw new Error('No vault to update');
  const record = await encryptToRecord(
    JSON.stringify(store),
    hexToBytes(rawKeyHex),
    vault.salt,
    vault.it ?? ITERATIONS
  );
  await chrome.storage.local.set({ [VAULT_KEY]: record });
}

export async function vaultExists() {
  const { [VAULT_KEY]: vault } = await chrome.storage.local.get(VAULT_KEY);
  return !!vault;
}

export async function clearVault() {
  await chrome.storage.local.remove(VAULT_KEY);
}
