// End-to-end smoke test of the bundled popup.
// Drives: home -> create (backup step) -> set-password step -> dashboard ->
// live balance -> add derived account -> switch accounts -> rename ->
// lock/unlock -> settings reset.
//
// Elements are selected by stable ids (a contract with the popup markup) so
// label/icon copy can change freely. Checks that need live data from the
// Keryx API are SKIPPED with a warning when the node is unreachable.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

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
let broadcastBody = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/utxos?')) {
    return new Response(JSON.stringify(MOCK_UTXOS), { status: 200 });
  }
  if (u.endsWith('/broadcast')) {
    broadcastBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ transaction_id: 'e2e0'.repeat(16) }), { status: 200 });
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
check('11b', `status dot ${balLoaded ? 'green after successful poll' : 'red when node unreachable'}`,
  balLoaded
    ? byId('api-status').className.includes('online') && byId('api-status-text').textContent === 'online'
    : byId('api-status').className.includes('offline') && byId('api-status-text').textContent === 'offline');

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
