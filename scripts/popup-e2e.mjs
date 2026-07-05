// End-to-end smoke test of the bundled popup against the LIVE Keryx API.
// Drives: home -> create (backup step) -> set-password step -> dashboard ->
// live balance -> add derived account -> switch accounts -> lock/unlock.
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
const findBtn = (text) =>
  [...app().querySelectorAll('button')].find((b) => b.textContent.includes(text));
const until = async (fn, tries = 60) => {
  for (let i = 0; i < tries && !fn(); i++) await sleep(500);
  return fn();
};
let failures = 0;
const check = (n, desc, ok, extra = '') => {
  console.log(`${n}. ${desc}:`, ok, extra);
  if (!ok) failures++;
};

// run the bundle
const code = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
new Function(code)();

await sleep(200);
check(1, 'initial screen shows create button', !!findBtn('Create a new wallet'));

// --- create flow: backup step ---
findBtn('Create a new wallet').click();
await sleep(100);
const words = [...app().querySelectorAll('.mnemonic-grid span')];
check(2, 'mnemonic grid has 24 words', words.length === 24);
const addr = app().querySelector('.addr')?.textContent ?? '';
check(3, 'address preview', addr.startsWith('keryx:q'), addr.slice(0, 28) + '…');
check(4, 'Next disabled before confirmation', findBtn('Next').disabled);

const checkbox = app().querySelector('input[type=checkbox]');
checkbox.checked = true;
checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep(50);
findBtn('Next').click();
await sleep(100);

// --- password step (separate page) ---
check(5, 'password page is a separate step', app().textContent.includes('Set session password'));
const pws = [...app().querySelectorAll('input[type=password]')];
check(6, 'password fields present', pws.length === 2);
for (const p of pws) {
  p.value = 'test-passphrase';
  p.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
await sleep(50);
findBtn('Open wallet').click();

// PBKDF2 600k iterations + live API round-trips
await until(() => app().textContent.includes('Balance'));
check(7, 'dashboard rendered', app().textContent.includes('Balance'));
check(8, 'vault persisted (v2, global password)', localStore.krx_sess?.v === 2 && localStore.krx_sess?.it === 600000);
check(9, 'session started', !!sessionStore.krx_unlocked?.rawKeyHex);

await until(() => app().querySelector('.balance-value'));
check(10, 'live balance loaded', !!app().querySelector('.balance-value'), app().querySelector('.balance-value')?.textContent.trim());
check(11, 'dashboard address matches preview', app().querySelector('.addr')?.textContent === addr);

// --- multi-account: derive a second address from the same seed ---
findBtn('＋ Add').click();
await sleep(100);
check(12, 'add-account chooser shown', app().textContent.includes('Add account'));
findBtn('New address from current seed').click();
await until(() => app().querySelectorAll('.account-select option').length === 2);
const addr2 = app().querySelector('.addr')?.textContent;
check(13, 'second account active with different address', addr2 !== addr && addr2?.startsWith('keryx:q'));
check(14, 'switcher lists 2 accounts', app().querySelectorAll('.account-select option').length === 2);

// --- switch back to account 1 ---
const select = app().querySelector('.account-select');
select.value = select.querySelectorAll('option')[0].value;
select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await until(() => app().querySelector('.addr')?.textContent === addr);
check(15, 'switching back restores account 1 address', app().querySelector('.addr')?.textContent === addr);

// --- lock / unlock preserves all accounts under the one password ---
findBtn('Lock').click();
await sleep(200);
check(16, 'locked screen', app().textContent.includes('WALLET LOCKED'));
const pwInput = app().querySelector('input[type=password]');
pwInput.value = 'wrong-password';
findBtn('Unlock').click();
await until(() => app().textContent.includes('Wrong password'), 30);
check(17, 'wrong password rejected', app().textContent.includes('Wrong password.'));
pwInput.value = 'test-passphrase';
findBtn('Unlock').click();
await until(() => app().textContent.includes('Balance'), 30);
check(18, 'unlock restores dashboard', app().textContent.includes('Balance'));
check(19, 'both accounts survive lock/unlock', app().querySelectorAll('.account-select option').length === 2);
check(20, 'active account preserved', app().querySelector('.addr')?.textContent === addr);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll checks passed');
process.exit(0);
