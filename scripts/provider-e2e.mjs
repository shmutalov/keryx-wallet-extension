// End-to-end tests for the dApp provider (window.keryx), fully offline:
//   1. inpage script  — provider surface, request/response + event plumbing
//   2. content script — page <-> background relay, origin filtering
//   3. background     — request router, approval-window lifecycle, connections
//   4. approval page  — unlock, connect, send, HTLC sign-tx, sign-message, reject
//   5. popup Settings — connected-sites list + disconnect
//
// Elements are selected by stable ids (contract with the markup). All network
// calls are intercepted; nothing here touches the live node.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { deriveWallet, addressToScriptPublicKey, hexToBytes } from '../src/lib/keryx.js';
import { transactionSigningHash, signTxJson, personalMessageHash, MIN_FEE_SOMPI } from '../src/lib/tx.js';
import { createVault } from '../src/lib/vault.js';

const bundle = (name) => readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, tries = 60, step = 250) => {
  for (let i = 0; i < tries && !fn(); i++) await sleep(step);
  return fn();
};

let failures = 0;
let n = 0;
const check = (desc, ok, extra = '') => {
  console.log(`${++n}. ${desc}:`, ok, extra);
  if (!ok) failures++;
};

const storageApi = (store) => ({
  get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : { ...store }),
  set: async (o) => Object.assign(store, o),
  remove: async (k) => delete store[k],
});

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const wallet = deriveWallet(MNEMONIC, 0);
const receiver = deriveWallet(MNEMONIC, 1);
const DAPP = 'https://dapp.example';
const STORE = { accounts: [{ id: 'acc1', label: 'Main', mnemonic: MNEMONIC, index: 0 }] };

function freshDom(url) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
    url,
    pretendToBeVisual: true,
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Event = dom.window.Event; // bundles construct events with the page's classes
  globalThis.MessageEvent = dom.window.MessageEvent;
  globalThis.location = dom.window.location;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  return dom;
}

const messageEvent = (dom, data) =>
  new dom.window.MessageEvent('message', { data, origin: new URL(dom.window.location.href).origin, source: dom.window });

// ================= 1. inpage provider =================
console.log('\n--- inpage provider ---');
{
  const dom = freshDom(`${DAPP}/`);
  const posted = [];
  dom.window.postMessage = (data) => posted.push(data); // capture outbound
  new Function(bundle('inpage.js'))();

  check('window.keryx injected and frozen', dom.window.keryx?.isKeryx === true && Object.isFrozen(dom.window.keryx));

  const p = dom.window.keryx.sendKrx(receiver.address, 12345, { feeSompi: MIN_FEE_SOMPI });
  await sleep(10);
  const sent = posted.find((m) => m.target === 'krx-content' && m.method === 'krx_sendKrx');
  check('sendKrx posts a krx-content request with params', !!sent &&
    sent.params.toAddress === receiver.address && sent.params.sompi === 12345);

  dom.window.dispatchEvent(messageEvent(dom, { target: 'krx-inpage', id: sent.id, result: 'txid-1' }));
  check('response resolves the pending promise', (await p) === 'txid-1');

  const p2 = dom.window.keryx.getAccounts();
  await sleep(10);
  const req2 = posted.find((m) => m.method === 'krx_getAccounts');
  dom.window.dispatchEvent(messageEvent(dom, { target: 'krx-inpage', id: req2.id, error: 'nope' }));
  check('error response rejects the promise', await p2.then(() => false, (e) => e.message === 'nope'));

  let evData = null;
  dom.window.keryx.on('accountsChanged', (d) => (evData = d));
  dom.window.dispatchEvent(messageEvent(dom, { target: 'krx-inpage', event: 'accountsChanged', data: [wallet.address] }));
  await sleep(10);
  check('events reach on() listeners', Array.isArray(evData) && evData[0] === wallet.address);
}

// ================= 2. content-script relay =================
console.log('\n--- content-script relay ---');
{
  const dom = freshDom(`${DAPP}/`);
  const posted = [];
  dom.window.postMessage = (data) => posted.push(data);
  const bgListeners = [];
  let sendMessageImpl = async () => ({ result: 'ok' });
  globalThis.chrome = {
    runtime: {
      sendMessage: (msg) => sendMessageImpl(msg),
      onMessage: { addListener: (l) => bgListeners.push(l) },
    },
  };
  new Function(bundle('content.js'))();

  const relayed = [];
  sendMessageImpl = async (msg) => {
    relayed.push(msg);
    return { result: ['a', 'b'] };
  };
  dom.window.dispatchEvent(messageEvent(dom, { target: 'krx-content', id: 'r1', method: 'krx_getAccounts' }));
  await sleep(10);
  check('page request relayed to background as krx-request',
    relayed[0]?.type === 'krx-request' && relayed[0].method === 'krx_getAccounts');
  check('direct response posted back to the page',
    posted.some((m) => m.target === 'krx-inpage' && m.id === 'r1' && m.result?.[0] === 'a'));

  sendMessageImpl = async () => ({ pending: true, id: 'r2' });
  dom.window.dispatchEvent(messageEvent(dom, { target: 'krx-content', id: 'r2', method: 'krx_sendKrx', params: {} }));
  await sleep(10);
  check('pending ack posts nothing yet', !posted.some((m) => m.id === 'r2'));
  for (const l of bgListeners) l({ type: 'krx-response', id: 'r2', result: 'txid-9' });
  await sleep(10);
  check('late krx-response resolves the pending request',
    posted.some((m) => m.id === 'r2' && m.result === 'txid-9'));

  for (const l of bgListeners) l({ type: 'krx-event', origin: DAPP, event: 'disconnect' });
  for (const l of bgListeners) l({ type: 'krx-event', origin: 'https://other.example', event: 'accountsChanged', data: [] });
  await sleep(10);
  check('events filtered by origin (own passes, foreign dropped)',
    posted.some((m) => m.event === 'disconnect') && !posted.some((m) => m.event === 'accountsChanged'));

  sendMessageImpl = async () => { throw new Error('no SW'); };
  dom.window.dispatchEvent(messageEvent(dom, { target: 'krx-content', id: 'r3', method: 'krx_getNetwork' }));
  await sleep(10);
  check('service-worker failure surfaces as unavailable error',
    posted.some((m) => m.id === 'r3' && /unavailable/i.test(m.error ?? '')));
}

// ================= 3. background router =================
console.log('\n--- background router ---');
const bgLocal = {};
const bgSession = {};
{
  const runtimeListeners = [];
  const windowRemovedListeners = [];
  const windowsCreated = [];
  const tabMessages = [];
  let winCounter = 100;
  globalThis.chrome = {
    runtime: {
      id: 'test-ext',
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: (l) => runtimeListeners.push(l) },
      getURL: (p) => `chrome-extension://test-ext/${p}`,
      getManifest: () => ({ version: '9.9.9-test' }),
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    storage: { local: storageApi(bgLocal), session: storageApi(bgSession) },
    windows: {
      create: async (opts) => {
        const w = { id: ++winCounter, opts };
        windowsCreated.push(w);
        return w;
      },
      remove: async () => {},
      onRemoved: { addListener: (l) => windowRemovedListeners.push(l) },
    },
    tabs: {
      query: async () => [{ id: 7 }, { id: 8 }],
      sendMessage: async (tabId, msg) => {
        tabMessages.push({ tabId, msg });
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/balance')) return new Response(JSON.stringify({ address: wallet.address, balance_sompi: 123 }), { status: 200 });
    if (u.includes('/utxos?')) return new Response(JSON.stringify([]), { status: 200 });
    if (u.endsWith('/broadcast')) return new Response(JSON.stringify({ transaction_id: 'bcast-1' }), { status: 200 });
    if (u.endsWith('/spend')) return new Response(JSON.stringify({ status: 'accepted', transaction: { tx_id: 'spender-1', inputs: [{ signature_script: 'preimagepush' }] } }), { status: 200 });
    if (u.includes('/transactions/')) return new Response(JSON.stringify({ tx_id: 'tx-1', inputs: [], outputs: [], payload: 'deadbeef' }), { status: 200 });
    throw new Error(`unexpected fetch ${u}`);
  };
  new Function(bundle('background.js'))();

  const contentSender = { tab: { id: 7 }, origin: DAPP, url: `${DAPP}/page` };
  const extensionSender = { url: 'chrome-extension://test-ext/approval.html?id=x' };
  const dispatch = (msg, sender) =>
    new Promise((resolve) => {
      let async = false;
      for (const l of runtimeListeners) {
        if (l(msg, sender, resolve) === true) async = true;
      }
      if (!async) resolve(undefined);
    });
  const rpc = (method, params) => dispatch({ type: 'krx-request', id: 'x', method, params }, contentSender);

  check('getAccounts before connect -> []', (await rpc('krx_getAccounts')).result?.length === 0);
  check('getNetwork', (await rpc('krx_getNetwork')).result === 'keryx-mainnet');
  check('getVersion from manifest', (await rpc('krx_getVersion')).result === '9.9.9-test');
  check('getPublicKey before connect -> not-connected error',
    /requestAccounts/.test((await rpc('krx_getPublicKey')).error ?? ''));
  check('sendKrx before connect -> not-connected error',
    /requestAccounts/.test((await rpc('krx_sendKrx', { toAddress: 'x', sompi: 1 })).error ?? ''));
  check('unknown method -> error', /Unknown method/.test((await rpc('krx_nope')).error ?? ''));

  const pend = await rpc('krx_requestAccounts');
  const reqId = pend.id;
  check('requestAccounts -> pending + approval window opened',
    pend.pending === true && windowsCreated[0]?.opts.url.includes(`approval.html?id=${reqId}`));
  check('pending request persisted with winId',
    bgSession.krx_pending?.[reqId]?.origin === DAPP && bgSession.krx_pending[reqId].winId === windowsCreated[0].id);

  await dispatch({ type: 'krx-approval-result', id: reqId, result: [wallet.address] }, extensionSender);
  check('approval result forwarded to the requesting tab',
    tabMessages.some((t) => t.tabId === 7 && t.msg.type === 'krx-response' && t.msg.id === reqId && t.msg.result?.[0] === wallet.address));
  check('connect emits accountsChanged to all tabs (origin-tagged)',
    tabMessages.some((t) => t.msg.type === 'krx-event' && t.msg.event === 'accountsChanged' && t.msg.origin === DAPP));
  check('pending request cleared after approval', !bgSession.krx_pending?.[reqId]);

  // a request from a page cannot spoof an approval result
  const before = tabMessages.length;
  await dispatch({ type: 'krx-approval-result', id: 'spoof', result: ['x'] }, contentSender);
  check('approval results from web pages are ignored', tabMessages.length === before);

  // connection record is written by the approval page; simulate it
  bgLocal.krx_connected = {
    [DAPP]: { accountId: 'acc1', address: wallet.address, publicKeyHex: wallet.publicKeyHex.slice(2), connectedAt: 1 },
  };
  check('getAccounts after connect -> [address]', (await rpc('krx_getAccounts')).result?.[0] === wallet.address);
  check('getPublicKey after connect -> x-only key', (await rpc('krx_getPublicKey')).result === wallet.publicKeyHex.slice(2));
  const winsBefore = windowsCreated.length;
  check('requestAccounts while connected resolves without a new window',
    (await rpc('krx_requestAccounts')).result?.[0] === wallet.address && windowsCreated.length === winsBefore);
  check('getBalance proxies the node API', (await rpc('krx_getBalance')).result?.balance_sompi === 123);
  check('broadcastTx returns the transaction id', (await rpc('krx_broadcastTx', { tx: { inputs: [] } })).result === 'bcast-1');
  check('getTransaction proxies the wire tx (swap recovery)',
    (await rpc('krx_getTransaction', { txId: 'tx-1' })).result?.payload === 'deadbeef');
  check('getTransaction without txId -> error',
    /Missing txId/.test((await rpc('krx_getTransaction', {})).error ?? ''));
  check('getOutpointSpend returns status + spending tx (preimage source)', await (async () => {
    const r = (await rpc('krx_getOutpointSpend', { txId: 'tx-1', index: 0 })).result;
    return r?.status === 'accepted' && r.transaction?.inputs?.[0]?.signature_script === 'preimagepush';
  })());
  check('getOutpointSpend with invalid index -> error',
    /invalid txId or index/.test((await rpc('krx_getOutpointSpend', { txId: 'tx-1', index: -1 })).error ?? ''));

  // closing the approval window = rejection
  const other = { tab: { id: 9 }, origin: 'https://other.example', url: 'https://other.example/' };
  const pend2 = await dispatch({ type: 'krx-request', id: 'y', method: 'krx_requestAccounts' }, other);
  const win2 = windowsCreated[windowsCreated.length - 1];
  for (const l of windowRemovedListeners) await l(win2.id);
  await until(() => tabMessages.some((t) => t.tabId === 9 && /rejected/.test(t.msg.error ?? '')), 20, 50);
  check('closing the approval window rejects the request',
    pend2.pending === true && tabMessages.some((t) => t.tabId === 9 && t.msg.id === pend2.id && /rejected/.test(t.msg.error ?? '')));

  await rpc('krx_disconnect');
  check('disconnect removes the connection and emits disconnect',
    !bgLocal.krx_connected[DAPP] &&
    tabMessages.some((t) => t.msg.type === 'krx-event' && t.msg.event === 'disconnect' && t.msg.origin === DAPP));
}

// ================= 3b. configurable API host =================
console.log('\n--- configurable API host ---');
{
  const runtimeListeners = [];
  const local = {
    krx_api_base: 'https://custom-node.example',
    krx_connected: {
      [DAPP]: { accountId: 'acc1', address: wallet.address, publicKeyHex: wallet.publicKeyHex.slice(2), connectedAt: 1 },
    },
  };
  globalThis.chrome = {
    runtime: {
      id: 'test-ext',
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: (l) => runtimeListeners.push(l) },
      getURL: (p) => `chrome-extension://test-ext/${p}`,
      getManifest: () => ({ version: 'test' }),
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    storage: { local: storageApi(local), session: storageApi({}) },
    windows: { create: async () => ({ id: 1 }), remove: async () => {}, onRemoved: { addListener: () => {} } },
    tabs: { query: async () => [], sendMessage: async () => {} },
  };
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(JSON.stringify({ address: wallet.address, balance_sompi: 7 }), { status: 200 });
  };
  new Function(bundle('background.js'))();
  const resp = await new Promise((resolve) => {
    let async = false;
    for (const l of runtimeListeners) {
      if (l({ type: 'krx-request', id: 'x', method: 'krx_getBalance' },
             { tab: { id: 7 }, origin: DAPP, url: `${DAPP}/` }, resolve) === true) async = true;
    }
    if (!async) resolve(undefined);
  });
  check('background fetches through the configured API host',
    resp?.result?.balance_sompi === 7 && fetched[0]?.startsWith('https://custom-node.example/api/v1/'),
    fetched[0] ?? '(no fetch)');
}

// ================= 4. approval page =================
console.log('\n--- approval page ---');

// a real vault so the unlock path exercises actual PBKDF2/AES
const vaultLocal = {};
globalThis.chrome = { storage: { local: storageApi(vaultLocal), session: storageApi({}) } };
await createVault(STORE, 'pw-test');
const VAULT_RECORD = vaultLocal.krx_sess;

const CONNECTED = {
  [DAPP]: { accountId: 'acc1', address: wallet.address, publicKeyHex: wallet.publicKeyHex.slice(2), connectedAt: 1 },
};
const MOCK_UTXOS = [
  { transaction_id: 'a'.repeat(64), index: 0, amount_sompi: 3_00000000, script_version: 0,
    script_public_key: addressToScriptPublicKey(wallet.address), block_daa_score: 100, is_coinbase: false },
  { transaction_id: 'b'.repeat(64), index: 1, amount_sompi: 3_00000000, script_version: 0,
    script_public_key: addressToScriptPublicKey(wallet.address), block_daa_score: 100, is_coinbase: false },
];

/** Boot extension/approval.js in a fresh DOM for one pending request. */
function bootApproval({ id, request, unlocked, connected = CONNECTED }) {
  const local = { krx_sess: VAULT_RECORD, krx_connected: connected };
  const session = { krx_pending: { [id]: request } };
  if (unlocked) session.krx_unlocked = { store: STORE, rawKeyHex: 'ab'.repeat(32), lastActive: Date.now() };
  const results = [];
  let closed = false;
  const dom = freshDom(`chrome-extension://test-ext/approval.html?id=${id}`);
  dom.window.close = () => (closed = true);
  globalThis.chrome = {
    storage: { local: storageApi(local), session: storageApi(session) },
    runtime: { sendMessage: async (msg) => results.push(msg) },
  };
  const broadcasts = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/utxos?')) return new Response(JSON.stringify(MOCK_UTXOS), { status: 200 });
    if (u.endsWith('/info')) return new Response(JSON.stringify({ last_daa_score: 1000 }), { status: 200 });
    if (u.endsWith('/broadcast')) {
      broadcasts.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ transaction_id: 'approved-tx-1' }), { status: 200 });
    }
    if (u.endsWith('/capabilities')) return new Response(JSON.stringify([]), { status: 200 });
    throw new Error(`unexpected fetch ${u}`);
  };
  new Function(bundle('approval.js'))();
  return {
    dom,
    byId: (i) => dom.window.document.getElementById(i),
    results,
    broadcasts,
    local,
    session,
    isClosed: () => closed,
  };
}

// --- locked -> unlock -> send -> broadcast ---
{
  const ctx = bootApproval({
    id: 'REQ1',
    unlocked: false,
    request: {
      id: 'REQ1', origin: DAPP, tabId: 7, method: 'krx_sendKrx', type: 'send',
      params: { toAddress: receiver.address, sompi: 1_00000000, options: {} }, createdAt: Date.now(), winId: 1,
    },
  });
  await until(() => ctx.byId('unlock-password'), 20, 100);
  check('locked wallet shows unlock screen first', !!ctx.byId('unlock-password') && !!ctx.byId('unlock-btn'));

  ctx.byId('unlock-password').value = 'wrong-password';
  ctx.byId('unlock-btn').click();
  await until(() => ctx.dom.window.document.body.textContent.includes('Wrong password'), 40, 250);
  check('wrong password rejected', ctx.dom.window.document.body.textContent.includes('Wrong password'));

  ctx.byId('unlock-password').value = 'pw-test';
  ctx.byId('unlock-btn').click();
  await until(() => ctx.byId('approve-btn'), 40, 250);
  check('correct password reveals the send approval', !!ctx.byId('approve-btn') &&
    ctx.byId('approval-origin')?.textContent === DAPP &&
    ctx.dom.window.document.body.textContent.includes('1 KRX'));
  check('session started after unlock', !!ctx.session.krx_unlocked?.rawKeyHex);

  ctx.byId('approve-btn').click();
  await until(() => ctx.results.length > 0, 40, 250);
  const res = ctx.results[0];
  check('approve signs, broadcasts and reports the txid',
    res?.type === 'krx-approval-result' && res.id === 'REQ1' && res.result === 'approved-tx-1');
  const btx = ctx.broadcasts[0];
  check('broadcast pays the requested amount to the destination',
    btx?.outputs[0]?.amount === 1_00000000 &&
    btx.outputs[0].script_public_key === addressToScriptPublicKey(receiver.address));
  check('broadcast signature verifies', (() => {
    const rebuilt = {
      version: 0,
      inputs: btx.inputs.map((i) => ({
        ...i,
        sequence: BigInt(i.sequence),
        utxo: MOCK_UTXOS.find((u) => u.transaction_id === i.transaction_id && u.index === i.index),
      })),
      outputs: btx.outputs,
      lock_time: 0n,
      subnetwork_id: btx.subnetwork_id,
      gas: 0n,
      payload: new Uint8Array(0),
    };
    const pub = schnorr.getPublicKey(hexToBytes(wallet.privateKeyHex));
    return btx.inputs.every((inp, i) =>
      schnorr.verify(hexToBytes(inp.signature_script).slice(1, 65), transactionSigningHash(rebuilt, i), pub));
  })());
  check('window closes after answering', ctx.isClosed());
}

// --- connect ---
{
  const ctx = bootApproval({
    id: 'REQ2',
    unlocked: true,
    connected: {},
    request: { id: 'REQ2', origin: DAPP, tabId: 7, method: 'krx_requestAccounts', type: 'connect', params: {}, createdAt: Date.now(), winId: 1 },
  });
  await until(() => ctx.byId('connect-account-select'), 20, 100);
  check('connect screen lists accounts', ctx.byId('connect-account-select')?.querySelectorAll('option').length === 1);
  ctx.byId('approve-btn').click();
  await until(() => ctx.results.length > 0, 20, 100);
  check('connect returns [address]', ctx.results[0]?.result?.[0] === wallet.address);
  const conn = ctx.local.krx_connected?.[DAPP];
  check('connection persisted with x-only pubkey',
    conn?.accountId === 'acc1' && conn.address === wallet.address && conn.publicKeyHex === wallet.publicKeyHex.slice(2));
}

// --- sign-tx: HTLC claim, no broadcast ---
{
  const P2SH_SPK = 'aa20' + '33'.repeat(32) + '87';
  const REDEEM = 'ab'.repeat(113);
  const SUFFIX = '20' + 'cd'.repeat(32) + '51';
  const htlcTx = {
    inputs: [{
      transaction_id: 'f'.repeat(64), index: 0,
      utxo: { amount_sompi: 5_00000000, script_public_key: P2SH_SPK },
      redeem_script: REDEEM, sig_script_suffix: SUFFIX,
    }],
    outputs: [{ amount: 5_00000000 - MIN_FEE_SOMPI, script_public_key: addressToScriptPublicKey(wallet.address) }],
  };
  const ctx = bootApproval({
    id: 'REQ3',
    unlocked: true,
    request: {
      id: 'REQ3', origin: DAPP, tabId: 7, method: 'krx_signTx', type: 'sign-tx',
      params: { tx: htlcTx, options: { broadcast: false } }, createdAt: Date.now(), winId: 1,
    },
  });
  await until(() => ctx.byId('approve-btn'), 20, 100);
  check('custom-script warning shown for HTLC spends', !!ctx.byId('sign-tx-script-warning'));
  check('no-broadcast note shown', /NOT broadcast/.test(ctx.byId('sign-tx-broadcast-note')?.textContent ?? ''));
  ctx.byId('approve-btn').click();
  await until(() => ctx.results.length > 0, 20, 100);
  const signed = ctx.results[0]?.result?.tx;
  const ss = signed?.inputs[0]?.signature_script ?? '';
  check('HTLC claim assembled: sig push + preimage suffix + PUSHDATA1 redeem',
    ss.startsWith('41') && ss.slice(130, 132) === '01' &&
    ss.slice(132, 132 + SUFFIX.length) === SUFFIX && ss.endsWith('4c71' + REDEEM));
  check('HTLC signature verifies against the P2SH sighash', (() => {
    const { unsigned } = signTxJson(htlcTx, wallet.privateKeyHex); // rebuild digest input
    const pub = schnorr.getPublicKey(hexToBytes(wallet.privateKeyHex));
    return schnorr.verify(hexToBytes(ss).slice(1, 65), transactionSigningHash(unsigned, 0), pub);
  })());
  check('signed tx returned without broadcasting', ctx.broadcasts.length === 0 && !ctx.results[0].result.transaction_id);
}

// --- sign-message ---
{
  const ctx = bootApproval({
    id: 'REQ4',
    unlocked: true,
    request: {
      id: 'REQ4', origin: DAPP, tabId: 7, method: 'krx_signMessage', type: 'sign-message',
      params: { message: 'Login to dApp: nonce 42' }, createdAt: Date.now(), winId: 1,
    },
  });
  await until(() => ctx.byId('approve-btn'), 20, 100);
  check('message displayed verbatim', ctx.byId('sign-message-text')?.textContent === 'Login to dApp: nonce 42');
  ctx.byId('approve-btn').click();
  await until(() => ctx.results.length > 0, 20, 100);
  const sig = ctx.results[0]?.result ?? '';
  check('personal-message signature verifies',
    schnorr.verify(hexToBytes(sig), personalMessageHash('Login to dApp: nonce 42'),
      schnorr.getPublicKey(hexToBytes(wallet.privateKeyHex))));
}

// --- reject + invalid request ---
{
  const ctx = bootApproval({
    id: 'REQ5',
    unlocked: true,
    request: {
      id: 'REQ5', origin: DAPP, tabId: 7, method: 'krx_sendKrx', type: 'send',
      params: { toAddress: receiver.address, sompi: 1000, options: {} }, createdAt: Date.now(), winId: 1,
    },
  });
  await until(() => ctx.byId('reject-btn'), 20, 100);
  ctx.byId('reject-btn').click();
  await until(() => ctx.results.length > 0, 20, 100);
  check('reject reports "User rejected"', /User rejected/.test(ctx.results[0]?.error ?? '') && ctx.isClosed());
}
{
  const ctx = bootApproval({
    id: 'REQ6',
    unlocked: true,
    request: {
      id: 'REQ6', origin: DAPP, tabId: 7, method: 'krx_sendKrx', type: 'send',
      params: { toAddress: 'not-an-address', sompi: 1000, options: {} }, createdAt: Date.now(), winId: 1,
    },
  });
  await until(() => ctx.byId('reject-btn'), 20, 100);
  check('invalid params render an error with no approve button',
    !ctx.byId('approve-btn') && ctx.dom.window.document.body.textContent.includes('Invalid destination address'));
  ctx.byId('reject-btn').click();
  await until(() => ctx.results.length > 0, 20, 100);
  check('dismissing reports the validation error', /Invalid request/.test(ctx.results[0]?.error ?? ''));
}

// ================= 5. popup Settings: connected sites =================
console.log('\n--- popup connected sites ---');
{
  const local = {
    krx_sess: VAULT_RECORD,
    krx_active: 'acc1',
    krx_connected: { ...CONNECTED },
  };
  const session = { krx_unlocked: { store: STORE, rawKeyHex: 'ab'.repeat(32), lastActive: Date.now() } };
  const dom = freshDom('chrome-extension://test-ext/popup.html');
  const bgMsgs = [];
  globalThis.chrome = {
    storage: { local: storageApi(local), session: storageApi(session) },
    runtime: { sendMessage: async (m) => bgMsgs.push(m), getManifest: () => ({ version: 'test' }) },
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/balance')) return new Response(JSON.stringify({ balance_sompi: 0 }), { status: 200 });
    if (u.includes('/utxos/count')) return new Response(JSON.stringify({ count: 0 }), { status: 200 });
    if (u.includes('/addresses/')) return new Response(JSON.stringify({ total_tx_count: 0, transactions: [] }), { status: 200 });
    if (u.endsWith('/info')) return new Response(JSON.stringify({ last_daa_score: 1000 }), { status: 200 });
    if (u.endsWith('/market')) return new Response(JSON.stringify({ price_usd: 0 }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  new Function(bundle('popup.js'))();
  const byId = (i) => dom.window.document.getElementById(i);

  await until(() => byId('settings-btn'), 40, 250);
  byId('settings-btn').click();
  await until(() => byId('connected-sites')?.textContent.includes(DAPP), 20, 100);
  check('Settings lists the connected site with its account',
    byId('connected-sites')?.textContent.includes(DAPP) && byId('connected-sites')?.textContent.includes('Main'));

  byId('connected-sites').querySelector('button').click();
  await until(() => byId('connected-sites')?.textContent.includes('No sites connected'), 20, 100);
  check('disconnect removes the site and notifies the background',
    !local.krx_connected[DAPP] && bgMsgs.some((m) => m.type === 'krx-origin-disconnected' && m.origin === DAPP));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll provider e2e checks passed');
