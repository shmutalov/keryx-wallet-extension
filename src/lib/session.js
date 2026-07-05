// Unlocked-wallet session state.
//
// The decrypted mnemonic is held only in chrome.storage.session (in-memory,
// cleared when the browser closes). The background service worker enforces a
// 15-minute inactivity auto-lock (same timeout as the official web wallet);
// the popup refreshes the activity timestamp on user interaction.

const SESSION_KEY = 'krx_unlocked';
export const AUTOLOCK_MS = 15 * 60 * 1000;

export async function startSession(mnemonic) {
  await chrome.storage.session.set({
    [SESSION_KEY]: { mnemonic, lastActive: Date.now() },
  });
}

/** @returns {Promise<string|null>} mnemonic if an unlocked, non-expired session exists */
export async function getSessionMnemonic() {
  const { [SESSION_KEY]: s } = await chrome.storage.session.get(SESSION_KEY);
  if (!s) return null;
  if (Date.now() - s.lastActive > AUTOLOCK_MS) {
    await endSession();
    return null;
  }
  return s.mnemonic;
}

export async function touchSession() {
  const { [SESSION_KEY]: s } = await chrome.storage.session.get(SESSION_KEY);
  if (s) {
    await chrome.storage.session.set({ [SESSION_KEY]: { ...s, lastActive: Date.now() } });
  }
}

export async function endSession() {
  await chrome.storage.session.remove(SESSION_KEY);
}

export async function sessionIsStale() {
  const { [SESSION_KEY]: s } = await chrome.storage.session.get(SESSION_KEY);
  return !!s && Date.now() - s.lastActive > AUTOLOCK_MS;
}
