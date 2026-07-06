// dApp-provider state shared by the background router, the approval window and
// the popup Settings screen.
//
// Connections (per-origin grants) live in chrome.storage.local so they survive
// browser restarts, like the vault. A connection stores the account's ADDRESS
// and x-only PUBLIC key only — never key material; signing always goes through
// the approval window, which needs the unlocked session.
//
// Pending approval requests live in chrome.storage.session: they must survive
// a service-worker restart while an approval window is open, but should not
// outlive the browser.

const CONNECT_KEY = 'krx_connected';
const PENDING_KEY = 'krx_pending';

/** @returns {Promise<Record<string, {accountId, address, publicKeyHex, connectedAt}>>} keyed by origin */
export async function getConnections() {
  const { [CONNECT_KEY]: c } = await chrome.storage.local.get(CONNECT_KEY);
  return c ?? {};
}

export async function getConnection(origin) {
  return (await getConnections())[origin] ?? null;
}

export async function setConnection(origin, info) {
  const all = await getConnections();
  all[origin] = { ...info, connectedAt: Date.now() };
  await chrome.storage.local.set({ [CONNECT_KEY]: all });
}

export async function removeConnection(origin) {
  const all = await getConnections();
  delete all[origin];
  await chrome.storage.local.set({ [CONNECT_KEY]: all });
}

/** @returns {Promise<Record<string, object>>} pending approval requests keyed by id */
export async function getPendingRequests() {
  const { [PENDING_KEY]: p } = await chrome.storage.session.get(PENDING_KEY);
  return p ?? {};
}

export async function getPendingRequest(id) {
  return (await getPendingRequests())[id] ?? null;
}

export async function putPendingRequest(req) {
  const all = await getPendingRequests();
  all[req.id] = req;
  await chrome.storage.session.set({ [PENDING_KEY]: all });
}

/** Remove and return the request (null when already handled). */
export async function removePendingRequest(id) {
  const all = await getPendingRequests();
  const req = all[id] ?? null;
  if (req) {
    delete all[id];
    await chrome.storage.session.set({ [PENDING_KEY]: all });
  }
  return req;
}
