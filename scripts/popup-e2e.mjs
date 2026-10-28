// End-to-end smoke test of the bundled popup.
// Drives: home -> create (backup step) -> set-password step -> dashboard ->
// live balance -> add derived account -> switch accounts -> rename ->
// lock/unlock -> settings reset.
//
// Elements are selected by stable ids (a contract with the popup markup) so
// label/icon copy can change freely. Checks that need live data from the
// Keryx API are SKIPPED with a warning when the node is unreachable.
import { JSDOM } from 'jsdom';
import jsQR from 'jsqr';
import { readFileSync, readdirSync } from 'fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes, isValidAddress } from '../src/lib/keryx.js';
import { openRequest, sealResponse, toHex } from '../src/lib/private.js';
import { H14_ACTIVATION_DAA, H15_ACTIVATION_DAA } from '../src/lib/models.js';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
  url: 'chrome-extension://test/popup.html',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
dom.window.confirm = () => true;

// chrome.* stub backed by plain objects
const localStore = {};
const sessionStore = {};
const storageApi = (store) => ({
  get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : { ...store }),
  set: async (o) => Object.assign(store, o),
  remove: async (k) => delete store[k],
});
globalThis.chrome = {
  storage: { local: storageApi(localStore), session: storageApi(sessionStore) },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = () => document.getElementById('app');
const byId = (id) => document.getElementById(id);
const fire = (node, type) => node.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
const until = async (fn, tries = 60) => {
  for (let i = 0; i < tries && !fn(); i++) await sleep(500);
  return fn();
};

// Rasterize the receive screen's QR path (one "Mx,yh1v1h-1z" square per dark module, on a
// light tile of `dim` modules) and read it back with an independent decoder.
const decodeQrPath = (d, dim, scale = 6) => {
  const px = dim * scale;
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
  for (const [, mx, my] of d.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
    for (let y = my * scale; y < (Number(my) + 1) * scale; y++) {
      for (let x = mx * scale; x < (Number(mx) + 1) * scale; x++) {
        const i = (y * px + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
      }
    }
  }
  return jsQR(rgba, px, px)?.data ?? null;
};

let failures = 0;
const check = (n, desc, ok, extra = '') => {
  console.log(`${n}. ${desc}:`, ok, extra);
  if (!ok) failures++;
};

// live-data checks are skipped when the node is down (e.g. mid-update)
let apiUp = false;
try {
  const res = await fetch('https://keryx-labs.com/api/v1/info', { signal: AbortSignal.timeout(8000) });
  apiUp = res.ok;
} catch {}
if (!apiUp) console.warn('⚠ Keryx API unreachable — live-data checks will be SKIPPED\n');
const checkLive = (n, desc, okFn, extraFn = () => '') => {
  if (!apiUp) {
    console.log(`${n}. ${desc}: SKIPPED (API unreachable)`);
    return;
  }
  check(n, desc, okFn(), extraFn());
};

// Intercept node endpoints used by the send flow so it runs against a mocked
// chain (2 spendable UTXOs, broadcast captured for inspection).
const MOCK_UTXOS = [
  { transaction_id: 'a'.repeat(64), index: 0, amount_sompi: 3_00000000, script_version: 0,
    script_public_key: '20' + '11'.repeat(32) + 'ac', block_daa_score: 100, is_coinbase: false },
  { transaction_id: 'b'.repeat(64), index: 1, amount_sompi: 3_00000000, script_version: 0,
    script_public_key: '20' + '11'.repeat(32) + 'ac', block_daa_score: 100, is_coinbase: false },
];
const MOCK_TXS = Array.from({ length: 20 }, (_, i) => ({
  tx_id: i.toString(16).padStart(2, '0').repeat(32),
  amount_sompi: (i + 1) * 10000000,
  is_spend: i % 3 === 0,
}));
const DEFAULT_MODEL_ID = '399984045600f7d58d1b2cf01e6a4bf466fa15c7ac31bd0dd1a71e003b617cc6'; // gemma-4-12b-abliterated
const MINER_PUB = '22'.repeat(32);
const MOCK_CAPABILITIES = [
  { model: 'gemma-4-12b-abliterated', model_id_hex: DEFAULT_MODEL_ID, miner_count: 3, miner_pubkeys: [MINER_PUB] },
];
const MOCK_INFERENCES = [
  { tx_id: 'cd'.repeat(32), model: 'glm-4-9b-0414', prompt: 'Answered question', max_tokens: 128,
    inference_reward: 60000000, priority_fee: 30000000, daa_score: 100, block_hash: 'ef'.repeat(32),
    payload_prefix: 'aa11'.repeat(4), result_text: 'The answer is 42.', result: 'raw' },
  { tx_id: 'ce'.repeat(32), model: 'glm-4-9b-0414', prompt: 'Pending question', max_tokens: 128,
    inference_reward: 60000000, priority_fee: 30000000, daa_score: 101, block_hash: 'ef'.repeat(32),
    payload_prefix: 'bb22'.repeat(4), result: null },
];
let mockBalance = false;
let broadcastBody = null;
let mockTxId = 'e2e0'.repeat(16); // what the mocked broadcast answers
let mockDaa = null; // set: /info answers with this DAA (which side of the H14 gate), else live
let mockInferences = MOCK_INFERENCES;
let mockProviders = null; // /ai/providers body
let mockInferenceResult = null; // /inference/{tx_id} body, null = 404 (not indexed yet)
const ipfsCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (mockDaa !== null && u.endsWith('/api/v1/info')) {
    return new Response(JSON.stringify({ network: 'keryx-mainnet', last_daa_score: mockDaa }), { status: 200 });
  }
  if (u.endsWith('/ai/providers')) {
    return new Response(JSON.stringify(mockProviders ?? { cohort: [], window: [] }), { status: 200 });
  }
  if (u.includes('/api/v1/inference/')) {
    return mockInferenceResult
      ? new Response(JSON.stringify(mockInferenceResult), { status: 200 })
      : new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  if (u.includes('/ipfs/')) {
    ipfsCalls.push(u);
    return new Response('not found', { status: 404 });
  }
  if (u.includes('/utxos?')) {
    return new Response(JSON.stringify(MOCK_UTXOS), { status: 200 });
  }
  if (u.endsWith('/broadcast')) {
    broadcastBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ transaction_id: mockTxId }), { status: 200 });
  }
  if (u.endsWith('/capabilities')) {
    return new Response(JSON.stringify(MOCK_CAPABILITIES), { status: 200 });
  }
  if (u.includes('/infer?')) {
    return new Response(JSON.stringify(mockInferences), { status: 200 });
  }
  if (u.includes('/challenges?')) {
    return new Response(JSON.stringify([]), { status: 200 });
  }
  if (mockBalance && u.endsWith('/balance')) {
    return new Response(JSON.stringify({ balance_sompi: 10000000000 }), { status: 200 });
  }
  if (u.includes('/addresses/') && u.includes('?limit=') && !u.includes('/utxos')) {
    const limit = Number(new URL(u).searchParams.get('limit'));
    const offset = Number(new URL(u).searchParams.get('offset') ?? 0);
    return new Response(JSON.stringify({
      total_tx_count: MOCK_TXS.length,
      transactions: MOCK_TXS.slice(offset, offset + limit),
    }), { status: 200 });
  }
  return realFetch(url, init);
};

// run the bundle
const code = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
new Function(code)();

await sleep(200);
check(1, 'initial screen shows create button', !!byId('create-btn'));

// --- create flow: backup step ---
byId('create-btn').click();
await sleep(100);
const createdPhrase = [...app().querySelectorAll('.mnemonic-grid span')]
  .map((s) => s.textContent.replace(/^\d+/, ''))
  .join(' ');
check(2, 'mnemonic grid has 24 words', createdPhrase.split(' ').length === 24);
const addr = app().querySelector('.addr')?.textContent ?? '';
check(3, 'address preview', addr.startsWith('keryx:q'), addr.slice(0, 28) + '…');
check(4, 'Next disabled before confirmation', byId('next-btn').disabled);

byId('backup-confirm').checked = true;
fire(byId('backup-confirm'), 'change');
await sleep(50);
byId('next-btn').click();
await sleep(100);

// --- password step (separate page) ---
check(5, 'password page is a separate step', app().textContent.includes('Set session password'));
check(6, 'password fields present', !!byId('pw-input') && !!byId('pw-confirm'));
for (const id of ['pw-input', 'pw-confirm']) {
  byId(id).value = 'test-passphrase';
  fire(byId(id), 'input');
}
await sleep(50);
byId('open-wallet-btn').click();

// PBKDF2 600k iterations (+ live API round-trips when up)
await until(() => byId('account-select'));
check(7, 'dashboard rendered', !!byId('account-select') && app().textContent.includes('Balance'));
check(8, 'vault persisted (v2, global password)', localStore.krx_sess?.v === 2 && localStore.krx_sess?.it === 600000);
check(9, 'session started', !!sessionStore.krx_unlocked?.rawKeyHex);

// The node can flap mid-run (e.g. during updates), so don't trust the t=0
// probe here — assert the invariant instead: dot matches the actual outcome.
await until(
  () => app().querySelector('.balance-value') || byId('api-status').className.includes('offline'),
  apiUp ? 40 : 4
);
const balLoaded = !!app().querySelector('.balance-value');
if (balLoaded) {
  check(10, 'live balance loaded', true, app().querySelector('.balance-value').textContent.trim());
} else {
  console.log('10. live balance loaded: SKIPPED (node unreachable during run)');
}
check(11, 'dashboard address matches preview', byId('address')?.textContent === addr);
check('11a', 'API status indicator present', !!byId('api-status') && !!byId('api-status-text'));
if (balLoaded) {
  check('11b', 'status dot green after successful poll',
    byId('api-status').className.includes('online') && byId('api-status-text').textContent === 'online');
} else {
  // give the offline path time to settle (api client times out at 15 s)
  await until(() => byId('api-status').className.includes('offline'), 40);
  if (byId('api-status').className.includes('offline')) {
    check('11b', 'status dot red when node unreachable',
      byId('api-status-text').textContent === 'offline');
  } else {
    console.log('11b. status dot: SKIPPED (node state never settled during run)');
  }
}

// --- history: compact dashboard preview + dedicated paginated screen ---
await until(() => !!byId('history-btn'), 20);
check('11c', 'dashboard preview capped at 3 rows with view-all link',
  app().querySelectorAll('.tx-row').length === 3 && byId('history-btn').textContent.includes('20'));
byId('history-btn').click();
await until(() => byId('hist-list')?.querySelectorAll('.tx-row').length === 15, 20);
check('11d', 'history screen shows 15 per page', byId('hist-list').querySelectorAll('.tx-row').length === 15);
check('11e', 'pager shows 2 pages', byId('hist-page')?.textContent === 'Page 1 / 2' && byId('hist-prev').disabled);
byId('hist-next').click();
await until(() => byId('hist-list')?.querySelectorAll('.tx-row').length === 5, 20);
check('11f', 'page 2 shows remaining 5, next disabled',
  byId('hist-list').querySelectorAll('.tx-row').length === 5 && byId('hist-next').disabled);
app().querySelector('.link-btn').click(); // back to dashboard
await until(() => !!byId('lock-btn'), 10);

// --- multi-account: derive a second address from the same seed ---
byId('add-account-btn').click();
await sleep(100);
check(12, 'add-account chooser shown', !!byId('derive-btn') && !!byId('new-seed-btn') && !!byId('import-seed-btn'));
byId('derive-btn').click();
await until(() => byId('account-select')?.querySelectorAll('option').length === 2);
const addr2 = byId('address')?.textContent;
check(13, 'second account active with different address', addr2 !== addr && addr2?.startsWith('keryx:q'));
check(14, 'switcher lists 2 accounts', byId('account-select').querySelectorAll('option').length === 2);

// --- switch back to account 1 ---
const select = byId('account-select');
select.value = select.querySelectorAll('option')[0].value;
fire(select, 'change');
await until(() => byId('address')?.textContent === addr);
check(15, 'switching back restores account 1 address', byId('address')?.textContent === addr);

// --- receive: the QR code must decode back to the active account's address ---
byId('receive-btn').click();
await sleep(50);
const qr = byId('receive-qr');
const qrText = qr && decodeQrPath(qr.querySelector('path').getAttribute('d'), Number(qr.getAttribute('viewBox').split(' ')[2]));
check('15q', 'receive QR decodes to the active address', qrText === addr, qrText ?? 'not decodable');
check('15r', 'receive screen shows the address with a copy button',
  byId('receive-address')?.textContent === addr && !!byId('receive-copy-btn'));
// "Phone" swaps in a code for the explorer page (the iPhone Camera won't copy keryx: codes)
byId('receive-mode-phone').click();
await sleep(20);
const phoneQr = byId('receive-qr-phone');
const phoneText = phoneQr && decodeQrPath(phoneQr.querySelector('path').getAttribute('d'), Number(phoneQr.getAttribute('viewBox').split(' ')[2]));
check('15s', 'phone mode: QR opens the address on the explorer, choice remembered',
  phoneText === `https://keryx-labs.com/address/${addr}` &&
  phoneQr.parentElement.style.display === '' && qr.parentElement.style.display === 'none' &&
  byId('receive-mode-phone').getAttribute('aria-pressed') === 'true' && localStore.krx_receive_mode === 'phone',
  phoneText ?? 'not decodable');
app().querySelector('.link-btn').click(); // back to dashboard
await until(() => !!byId('send-btn'), 10);

// --- address book: add account 2's address under a name ---
byId('send-btn').click();
await sleep(100);
check('15a', 'send screen opens', !!byId('dest-input') && !!byId('send-confirm-btn'));
byId('manage-book-btn').click();
await sleep(100);
check('15b', 'address book opens from send screen', !!byId('ab-add-btn'));
byId('ab-name').value = 'Bob';
byId('ab-address').value = addr2;
byId('ab-add-btn').click();
await until(() => byId('ab-list').textContent.includes('Bob'), 10);
check('15c', 'book entry added', byId('ab-list').textContent.includes('Bob'));
byId('ab-name').value = 'Bob2';
byId('ab-address').value = addr2;
byId('ab-add-btn').click();
await until(() => byId('ab-error')?.style.display !== 'none', 10);
check('15d', 'duplicate address rejected', byId('ab-error').textContent.includes('already'));

// --- send: pick destination from the book, sign, broadcast ---
app().querySelector('.link-btn').click(); // back to send
await sleep(100);
byId('dest-input').dispatchEvent(new dom.window.Event('focus'));
fire(byId('dest-input'), 'focus');
await sleep(50);
const bookItem = [...byId('dest-suggest')?.querySelectorAll('.suggest-item') ?? []]
  .find((i) => i.textContent.includes('Bob'));
check('15e', 'picker lists the book entry', !!bookItem);
bookItem.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
await sleep(50);
check('15f', 'picking fills the destination', byId('dest-input').value === addr2);
byId('amount-input').value = '1.5';
fire(byId('amount-input'), 'input');
await sleep(50);
check('15g', 'send enabled with valid inputs', !byId('send-confirm-btn').disabled);
byId('send-confirm-btn').click();
await until(() => byId('send-status')?.className === 'success-box', 30);
check('15h', 'broadcast succeeded, tx id shown',
  byId('send-status').className === 'success-box' && byId('send-status').textContent.includes('e2e0'));
const out0 = broadcastBody?.outputs?.[0];
const totalOut = (broadcastBody?.outputs ?? []).reduce((s, o) => s + o.amount, 0);
check('15i', 'broadcast tx pays 1.5 KRX to picked address with change - fee',
  broadcastBody?.inputs?.length === 1 && out0?.amount === 1_50000000 &&
  totalOut === 3_00000000 - 30000000 &&
  broadcastBody.inputs.every((i) => /^41[0-9a-f]{128}01$/.test(i.signature_script) &&
    i.sequence === '18446744073709551615'));
check('15j', 'destination saved to recents', localStore.krx_recent?.[0]?.address === addr2);
check('15k', 'no save-to-book offer for known address', !byId('save-dest-btn'));

app().querySelector('.link-btn').click(); // back to dashboard
await until(() => !!byId('lock-btn'), 10);

// --- AI inference: dedicated page, cost math, vaulted AiRequest broadcast (H8 reward routing) ---
mockBalance = true;
mockDaa = H14_ACTIVATION_DAA - 1_000_000; // before the H14 gate: plaintext prompts, token surcharge
const modelOptions = () => [...byId('inf-model').querySelectorAll('option')].map((o) => o.value);
byId('inference-btn').click();
await sleep(100);
check('15l', 'inference page opens', !!byId('inf-model') && !!byId('inf-submit') && !!byId('inf-prompt'));
await until(() => modelOptions().length > 0, 20);
check('15m', 'model picker lists 5 models, gemma-4-12b default',
  modelOptions().length === 5 && byId('inf-model').value === 'gemma-4-12b-abliterated');
check('15m2', 'retired models (exaone, qwen3-8b, mistral-7b) not offered',
  !modelOptions().some((k) => ['exaone-4.0-1.2b', 'qwen3-8b-abliterated', 'mistral-7b-v0.3'].includes(k)));
check('15m3', 'before H14: tier 3 is Qwen3.6-27B, no private-requests card',
  modelOptions().includes('qwen3.6-27b') && !modelOptions().includes('qwen3.8-27b') &&
  byId('inf-mine').parentElement.style.display === 'none' && byId('inf-privacy').style.display === 'none' &&
  byId('inf-feed-note').style.display === 'none');
await until(() => byId('inf-miners')?.textContent.includes('3 active miners'), 20);
check('15n', 'live miner count shown from capabilities', byId('inf-miners').textContent.includes('3 active miners'));
await until(() => app().textContent.includes('Balance: 100 KRX'), 20);
byId('inf-prompt').value = 'What is Keryx?';
fire(byId('inf-prompt'), 'input');
await sleep(50);
check('15o', 'cost estimate: 2.0 base + 0.2 tokens + 0.3 fee = 2.5 KRX',
  byId('inf-total').textContent.includes('Total: 2.5 KRX'));
check('15p', 'submit enabled with prompt + funds + miners', !byId('inf-submit').disabled);
broadcastBody = null;
byId('inf-submit').click();
await until(() => byId('inf-status')?.className === 'success-box', 30);
check('15q', 'AiRequest submitted, tx id shown', byId('inf-status').textContent.includes('e2e0'));
const promptHex = Buffer.from('What is Keryx?', 'utf8').toString('hex');
const vaultOut = broadcastBody?.outputs?.[1]; // consensus: outputs[1] = OP_RETURN "aivault", value >= reward
check('15r', 'broadcast: inference subnetwork, model-id payload with prompt, reward vault at outputs[1]',
  broadcastBody?.subnetwork_id === '03' + '0'.repeat(38) &&
  broadcastBody?.payload?.startsWith(DEFAULT_MODEL_ID) &&
  broadcastBody?.payload?.endsWith(promptHex) &&
  broadcastBody?.outputs?.length === 2 &&
  vaultOut?.amount === 220000000 && // gemma 2.0 base + 0.2 tokens
  vaultOut?.script_version === 0 &&
  vaultOut?.script_public_key === '6a0761697661756c74' &&
  !broadcastBody.outputs.some((o) => o.script_public_key === `02a08cb120${MINER_PUB}ac`));
await until(() => byId('inf-feed')?.querySelectorAll('.inf-item').length === 2, 20);
check('15s', 'live feed renders responded + pending items with badges',
  byId('inf-feed').textContent.includes('✓ RESPONDED') &&
  byId('inf-feed').textContent.includes('⏳ PENDING') &&
  byId('inf-feed').textContent.includes('The answer is 42.'));

// --- H14 private inference: the prompt is sealed to the tier's miners, the
// request is kept encrypted per account, the miner's sealed answer is opened.
// The test plays the miners with the responder side of private.js. ---
const reopenInference = async () => {
  app().querySelector('.link-btn').click(); // back to dashboard
  await until(() => !!byId('inference-btn'), 10);
  byId('inference-btn').click();
  await until(() => !!byId('inf-model'), 10);
};
const ESCROW_SK = ['11', '22', '33', '44'].map((b) => b.repeat(32));
const escrowPub = (sk) => toHex(secp256k1.getPublicKey(hexToBytes(sk), true).subarray(1));
const [PUB_A, PUB_B, PUB_C, PUB_GLM] = ESCROW_SK.map(escrowPub);
const provider = (pub, modelId, tier) => ({ tier, model: 'x', model_id: modelId, identity: 'ab'.repeat(32), escrow_pubkey: pub });
const GLM_ID = 'fa2f13be0850e26c5ce86c7ac79da85e300c1da8b3290f9a18d47105f1f2140a';
mockProviders = {
  virtual_daa_score: H14_ACTIVATION_DAA + 5000,
  window_daa: 18000,
  // gemma's current cohort is A+B; C served it in the last 30 min; the GLM miner must never be named
  cohort: [provider(PUB_A, DEFAULT_MODEL_ID, 2), provider(PUB_B, DEFAULT_MODEL_ID, 2), provider(PUB_GLM, GLM_ID, 1)],
  window: [provider(PUB_A, DEFAULT_MODEL_ID, 2), provider(PUB_B, DEFAULT_MODEL_ID, 2), provider(PUB_C, DEFAULT_MODEL_ID, 2),
    provider(PUB_GLM, GLM_ID, 1)],
};
const OWN_TX = mockTxId;
const STRANGER = { tx_id: 'cf'.repeat(32), model: 'gemma-4-12b-abliterated', prompt: '', sealed: true, sealed_recipients: 45,
  max_tokens: 256, inference_reward: 150000000, priority_fee: 30000000, daa_score: H14_ACTIVATION_DAA + 10,
  block_hash: 'ef'.repeat(32), payload_prefix: 'cf'.repeat(8), result: 'Qm' + 'Z'.repeat(44), result_text: null };
mockInferences = [STRANGER];
mockDaa = H14_ACTIVATION_DAA + 5000;
await reopenInference();
await until(() => modelOptions().includes('qwen3.8-27b'), 20);
check('15t', 'from H14: tier 3 is Qwen3.8-27B, flat prices, gemma kept as default',
  modelOptions().length === 5 && !modelOptions().includes('qwen3.6-27b') &&
  byId('inf-model').value === 'gemma-4-12b-abliterated' &&
  byId('inf-model').selectedOptions[0].textContent.endsWith('· 1.5 KRX'));
check('15u', 'privacy notice + empty "Your private requests" card shown',
  byId('inf-privacy').style.display === '' && byId('inf-mine').parentElement.style.display === '' &&
  byId('inf-mine').textContent.includes('No private requests'));
check('15u2', 'the feed notes that API hosts do not list private requests (hidden before H14)',
  byId('inf-feed-note').style.display === '' && byId('inf-feed-note').textContent.includes('Private requests are not listed'));
await until(() => byId('inf-feed')?.textContent.includes('Sealed prompt'), 20);
check('15v', 'a stranger\'s sealed request shows as sealed, its answer is never fetched from IPFS',
  byId('inf-feed').textContent.includes('🔒 Sealed prompt — readable only by the requester and 45 miners') &&
  byId('inf-feed').textContent.includes('🔒 Sealed answer') && ipfsCalls.length === 0);
byId('inf-prompt').value = 'Secret question';
fire(byId('inf-prompt'), 'input');
await sleep(50);
check('15w', 'H14 cost: flat 1.5 reward + 0.3 fee = 1.8 KRX, whatever max_tokens',
  byId('inf-total').textContent.includes('Total: 1.8 KRX (1.5 reward + 0.3 fee)'));
broadcastBody = null;
byId('inf-submit').click();
await until(() => byId('inf-status')?.className === 'success-box', 30);
check('15x', 'sealed request submitted to the 3 gemma miners', byId('inf-status').textContent.includes('Sealed to 3 miners'));
const sealedPayload = hexToBytes(broadcastBody?.payload ?? '');
const openedBy = (sk) => { try { return openRequest(sealedPayload, sk); } catch { return null; } };
const minerView = openedBy(ESCROW_SK[2]);
check('15y', 'broadcast: public header (flat reward), vault at outputs[1], prompt sealed',
  broadcastBody?.payload?.startsWith(DEFAULT_MODEL_ID) &&
  new DataView(sealedPayload.buffer).getBigUint64(36, true) === 150000000n &&
  broadcastBody?.outputs?.[1]?.amount === 150000000 &&
  broadcastBody?.outputs?.[1]?.script_public_key === '6a0761697661756c74' &&
  !broadcastBody.payload.includes(Buffer.from('Secret question', 'utf8').toString('hex')));
check('15z', 'cohort + window miners of the tier open the prompt; the other tier\'s miner cannot',
  [0, 1, 2].every((i) => openedBy(ESCROW_SK[i])?.prompt === 'Secret question') && openedBy(ESCROW_SK[3]) === null &&
  JSON.stringify(minerView?.recipients) === JSON.stringify([PUB_A, PUB_B, PUB_C].sort()));
check('15z2', 'before H15 the request is sealed under key schedule 1 (as keryx-cli seals)', minerView?.schedule === 1);
const recordKey = Object.keys(localStore).find((k) => k.startsWith('krx_inf.keryx:'));
check('15aa', 'the request is kept per account, encrypted at rest (no plaintext prompt in storage)',
  !!recordKey && !!localStore[recordKey]?.iv && !JSON.stringify(localStore[recordKey]).includes('Secret question'));
await until(() => byId('inf-mine')?.textContent.includes('Secret question'), 20);
check('15ab', 'own request listed as pending with its prompt',
  byId('inf-mine').textContent.includes('Secret question') && byId('inf-mine').textContent.includes('⏳ PENDING') &&
  byId('inf-mine').textContent.includes('Waiting for a sealed answer from 3 miners'));
// Two miners answer: one could not open the request (plaintext note), one seals the answer.
mockInferenceResult = {
  tx_id: OWN_TX, status: 'completed', sealed: true, sealed_recipients: 3,
  sealed_responses: [
    { responder_pubkey: PUB_A, body: Buffer.from('could not open the request').toString('hex') },
    { responder_pubkey: PUB_C, body: toHex(sealResponse(minerView.responseKey, OWN_TX, PUB_C, 'The secret answer.')) },
  ],
};
mockInferences = [{ ...STRANGER, tx_id: OWN_TX, sealed_recipients: 3, result: 'Qm' + 'Y'.repeat(44) }, STRANGER];
await until(() => byId('inf-mine')?.textContent.includes('The secret answer.'), 30);
check('15ac', 'the sealed answer is decrypted (the unreadable note skipped)',
  byId('inf-mine').textContent.includes('The secret answer.') && byId('inf-mine').textContent.includes('✓ RESPONDED'));
await until(() => byId('inf-feed')?.textContent.includes('The secret answer.'), 20);
check('15ad', 'own row in the live feed shows its own prompt and answer, still no IPFS fetch',
  byId('inf-feed').textContent.includes('Secret question') && byId('inf-feed').textContent.includes('The secret answer.') &&
  ipfsCalls.length === 0);
mockInferenceResult = null;
await reopenInference();
await until(() => byId('inf-mine')?.textContent.includes('The secret answer.'), 20);
check('15ae', 'answer persists across popup sessions (encrypted store)', byId('inf-mine').textContent.includes('The secret answer.'));

// --- H15: requests seal under key schedule 2, stage-2 answers carry the token
// ids inside the sealed plaintext, and the context rule warns on long prompts ---
mockDaa = H15_ACTIVATION_DAA + 5000;
mockTxId = 'e2e1'.repeat(16);
mockInferences = [];
await reopenInference();
await until(() => modelOptions().length === 5, 20);
const setTokens = (v) => { byId('inf-tokens').value = String(v); fire(byId('inf-tokens'), 'input'); };
const setPrompt = (v) => { byId('inf-prompt').value = v; fire(byId('inf-prompt'), 'input'); };
byId('inf-model').value = 'qwen3.5-9b-abliterated';
fire(byId('inf-model'), 'change');
setTokens(4096);
setPrompt('x'.repeat(4000));
await sleep(50);
check('15ag', 'context rule: 4,000 bytes on tier 0 at 4,096 max tokens warns (only 3,584 sure to fit)',
  byId('inf-context').style.display === '' && byId('inf-context').textContent.includes('8,192-token context') &&
  byId('inf-context').textContent.includes('3,584 bytes'));
setTokens(256);
await sleep(50);
check('15ah', 'the warning clears once the prompt fits (7,424 bytes at 256 max tokens)', byId('inf-context').style.display === 'none');
byId('inf-model').value = 'gemma-4-12b-abliterated';
fire(byId('inf-model'), 'change');
setPrompt('Stage two question');
await sleep(50);
broadcastBody = null;
byId('inf-submit').click();
await until(() => byId('inf-status')?.className === 'success-box', 30);
const h15Payload = hexToBytes(broadcastBody?.payload ?? '');
const h15Miner = (() => { try { return openRequest(h15Payload, ESCROW_SK[1]); } catch { return null; } })();
check('15ai', 'from H15 the request is sealed under key schedule 2', h15Miner?.schedule === 2 && h15Miner.prompt === 'Stage two question');
const stage2 = (text, ids) => {
  const t = new TextEncoder().encode(text);
  const out = new Uint8Array(t.length + 4 * ids.length + 8);
  const dv = new DataView(out.buffer);
  out.set(t);
  ids.forEach((id, i) => dv.setUint32(t.length + 4 * i, id, true));
  dv.setUint32(t.length + 4 * ids.length, ids.length, true);
  out.set(new TextEncoder().encode('KXTK'), t.length + 4 * ids.length + 4);
  return out;
};
mockInferenceResult = {
  tx_id: mockTxId, status: 'completed', sealed: true, sealed_recipients: 3,
  sealed_responses: [{ responder_pubkey: PUB_B, response_length: 40,
    body: toHex(sealResponse(h15Miner.responseKey, mockTxId, PUB_B, stage2('The traced answer.', [151644, 872, 1048576]))) }],
};
await until(() => byId('inf-mine')?.textContent.includes('The traced answer.'), 30);
const ownH15 = [...byId('inf-mine').querySelectorAll('.inf-item')].find((n) => n.textContent.includes('Stage two question'));
check('15aj', 'the schedule-2 answer opens and shows its text only (token-id trailer stripped)',
  !!ownH15 && ownH15.querySelector('.inf-result-text')?.textContent === 'The traced answer.');
check('15ak', 'the schedule-1 request from before H15 still shows its answer',
  byId('inf-mine').textContent.includes('The secret answer.'));
mockInferenceResult = null;
// Right before the gate nothing may be sent: a request could land on either side of it.
mockDaa = H14_ACTIVATION_DAA - 100;
await reopenInference();
await until(() => byId('inf-era')?.style.display === '', 20);
byId('inf-prompt').value = 'Too close to the gate';
fire(byId('inf-prompt'), 'input');
await sleep(50);
check('15af', 'within a minute of the H14 gate: notice shown, submit disabled',
  byId('inf-era').textContent.includes('H14') && byId('inf-submit').disabled);
mockDaa = null;
mockInferences = MOCK_INFERENCES;
mockBalance = false;

app().querySelector('.link-btn').click(); // back to dashboard
await until(() => !!byId('lock-btn'), 10);

// --- lock / unlock preserves all accounts under the one password ---
byId('lock-btn').click();
await sleep(200);
check(16, 'locked screen', app().textContent.includes('WALLET LOCKED') && !!byId('unlock-btn'));
byId('unlock-pw').value = 'wrong-password';
byId('unlock-btn').click();
await until(() => app().textContent.includes('Wrong password'), 30);
check(17, 'wrong password rejected', app().textContent.includes('Wrong password.'));
byId('unlock-pw').value = 'test-passphrase';
byId('unlock-btn').click();
await until(() => !!byId('account-select'), 30);
check(18, 'unlock restores dashboard', !!byId('account-select'));
check(19, 'both accounts survive lock/unlock', byId('account-select').querySelectorAll('option').length === 2);
check(20, 'active account preserved', byId('address')?.textContent === addr);

// --- rename account ---
byId('rename-btn').click();
await sleep(50);
check(21, 'rename input appears', byId('rename-input')?.value === 'Account 1');
byId('rename-input').value = 'Main';
byId('rename-save-btn').click();
await until(() => [...byId('account-select')?.querySelectorAll('option') ?? []].some((o) => o.textContent.startsWith('Main (')), 10);
check(22, 'account renamed in switcher', [...byId('account-select').querySelectorAll('option')][0]?.textContent.startsWith('Main ('));
check(23, 'rename persisted to store label', app().textContent.includes('Main — KRX address'));

// --- settings page hides the destructive reset ---
check(24, 'no Reset on dashboard, settings button instead', !byId('reset-btn') && !!byId('settings-btn'));
byId('settings-btn').click();
await sleep(50);
check(25, 'settings page opens', app().textContent.includes('Danger zone') && !!byId('reset-btn'));

// --- i18n: the picker and the bundled locale files must agree, both ways ---
const localeDirs = readdirSync(new URL('../_locales', import.meta.url)).sort();
const langOpts = [...byId('lang-select').options].map((o) => o.value);
check('25j', 'language picker offers auto + exactly the bundled locales',
  langOpts[0] === 'auto' && JSON.stringify(langOpts.slice(1).sort()) === JSON.stringify(localeDirs));
const enMsgs = JSON.parse(readFileSync(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'));
const phSet = (s) => [...new Set(s.match(/\$\d/g) ?? [])].sort().join('');
const incomplete = localeDirs.filter((loc) => {
  const m = JSON.parse(readFileSync(new URL(`../_locales/${loc}/messages.json`, import.meta.url), 'utf8'));
  return Object.keys(enMsgs).some(
    (k) => !m[k]?.message?.trim() || phSet(enMsgs[k].message) !== phSet(m[k].message));
});
check('25k', 'every locale is complete: all keys present, $n placeholders match en',
  incomplete.length === 0, incomplete.join(', '));
// ext_description is the store-listing summary: the store caps it at 132 characters
const summaryTooLong = localeDirs.filter((loc) => {
  const m = JSON.parse(readFileSync(new URL(`../_locales/${loc}/messages.json`, import.meta.url), 'utf8'));
  return [...m.ext_description.message].length > 132;
});
check('25l', 'store summary fits the 132-character limit in every locale',
  summaryTooLong.length === 0, summaryTooLong.join(', '));

// --- About & support: outbound links open in a new tab; the tip row needs a valid address ---
const outbound = ['settings-rate-link', 'settings-buy-link', 'settings-mine-link', 'settings-source-link', 'settings-issues-link'];
check('25m', 'about links present and open in a new tab without a referrer',
  outbound.every((id) => byId(id)?.target === '_blank' && byId(id).rel === 'noreferrer') &&
  byId('settings-rate-link').href.endsWith('/hoobkmlannjlgaajjlhjagdbmijggcab/reviews') &&
  new URL(byId('settings-buy-link').href).host === 'nonkyc.io');
const donateRow = byId('settings-donate');
check('25n', 'tip row hidden, or shows a valid keryx: address',
  !donateRow || isValidAddress(donateRow.querySelector('.addr')?.textContent ?? ''));

// --- seed backup requires re-entering the password ---
byId('settings-backup-btn').click();
await sleep(100);
check('25a', 'backup screen asks for password', !!byId('backup-pw') && !byId('backup-phrase'));
byId('backup-pw').value = 'wrong-password';
fire(byId('backup-pw'), 'input');
byId('backup-reveal-btn').click();
await until(() => byId('backup-error')?.style.display !== 'none', 30);
check('25b', 'wrong password does not reveal seed',
  byId('backup-error').textContent.includes('Wrong password') && !byId('backup-phrase'));
byId('backup-pw').value = 'test-passphrase';
fire(byId('backup-pw'), 'input');
byId('backup-reveal-btn').click();
await until(() => !!byId('backup-phrase'), 30);
const revealedPhrase = [...byId('backup-phrase')?.querySelectorAll('span') ?? []]
  .map((s) => s.textContent.replace(/^\d+/, ''))
  .join(' ');
check('25c', 'revealed seed matches the created mnemonic', revealedPhrase === createdPhrase);
check('25d', 'derivation path shown for the account', app().textContent.includes("m/44'/111111'/0'/0/0"));
byId('backup-hide-btn').click();
await until(() => !byId('backup-phrase'), 10);
check('25e', 'hide clears the revealed seed', !byId('backup-phrase') && !!byId('backup-pw'));
app().querySelector('.link-btn').click(); // back to settings
await until(() => !!byId('reset-btn'), 10);

// --- configurable API host ---
check('25f', 'API host input empty while on default host',
  !!byId('api-host-input') && byId('api-host-input').value === '');
byId('api-host-input').value = 'https://custom.example/';
byId('api-host-save').click();
await until(() => byId('api-host-status')?.style.display !== 'none', 10);
check('25g', 'custom host saved and normalized (no trailing slash)',
  localStore.krx_api_base === 'https://custom.example' &&
  byId('api-host-status').className === 'success-box' &&
  byId('api-host-input').value === 'https://custom.example');
byId('api-host-input').value = 'not a url';
byId('api-host-save').click();
await until(() => byId('api-host-status')?.className === 'error-box', 10);
check('25h', 'invalid host rejected, stored value untouched',
  byId('api-host-status').className === 'error-box' && localStore.krx_api_base === 'https://custom.example');
// remote http is mixed-content-blocked from the extension → rejected up front
byId('api-host-input').value = 'http://remote.example:8787';
byId('api-host-save').click();
await until(() => byId('api-host-status')?.textContent?.includes('localhost'), 10);
check('25h2', 'remote http host rejected, stored value untouched',
  byId('api-host-status').className === 'error-box' &&
  byId('api-host-status').textContent.includes('localhost') &&
  localStore.krx_api_base === 'https://custom.example');
// loopback http is a valid local-shim target
byId('api-host-input').value = 'http://127.0.0.1:8787';
byId('api-host-save').click();
await until(() => byId('api-host-status')?.className === 'success-box', 10);
check('25h3', 'loopback http host accepted',
  localStore.krx_api_base === 'http://127.0.0.1:8787' &&
  byId('api-host-input').value === 'http://127.0.0.1:8787');
byId('api-host-input').value = '';
byId('api-host-save').click();
await until(() => byId('api-host-status')?.textContent?.includes('(default)'), 10);
check('25i', 'empty input resets to the default host',
  !('krx_api_base' in localStore) && byId('api-host-status').textContent.includes('(default)'));

check(26, 'reset disabled without confirmation text', byId('reset-btn').disabled);
byId('reset-confirm-input').value = 'RESET';
fire(byId('reset-confirm-input'), 'input');
await sleep(50);
check(27, 'reset enabled after typing RESET', !byId('reset-btn').disabled);
byId('reset-btn').click();
await until(() => !!byId('create-btn'), 10);
check(28, 'reset returns to first-run screen', !!byId('create-btn'));
check(29, 'vault and active id cleared', !localStore.krx_sess && !localStore.krx_active);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll checks passed${apiUp ? '' : ' (live-data checks skipped — API was unreachable)'}`);
process.exit(0);
