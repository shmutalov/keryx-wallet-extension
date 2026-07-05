// Encrypted mnemonic vault, compatible with the official web wallet's scheme:
// PBKDF2-SHA256 (600k iterations) -> AES-256-GCM, random 16-byte salt / 12-byte IV.
// Ciphertext lives in chrome.storage.local; it never leaves the device.

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

async function deriveAesKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function saveVault(mnemonic, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt, ITERATIONS);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(mnemonic)
  );
  await chrome.storage.local.set({
    [VAULT_KEY]: {
      salt: bytesToHex(salt),
      iv: bytesToHex(iv),
      ct: bytesToHex(new Uint8Array(ct)),
      it: ITERATIONS,
    },
  });
}

/** @returns {Promise<string|null>} decrypted mnemonic, or null on wrong password / no vault */
export async function unlockVault(password) {
  const { [VAULT_KEY]: vault } = await chrome.storage.local.get(VAULT_KEY);
  if (!vault) return null;
  try {
    const key = await deriveAesKey(password, hexToBytes(vault.salt), vault.it ?? ITERATIONS);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(vault.iv) },
      key,
      hexToBytes(vault.ct)
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export async function vaultExists() {
  const { [VAULT_KEY]: vault } = await chrome.storage.local.get(VAULT_KEY);
  return !!vault;
}

export async function clearVault() {
  await chrome.storage.local.remove(VAULT_KEY);
}
