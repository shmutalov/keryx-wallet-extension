// End-to-end smoke test of the bundled popup against the LIVE Keryx API.
// Drives: home -> create wallet -> vault encrypt -> dashboard -> live balance.
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

// run the bundle
const code = readFileSync('d:/Projects/mine/keryx-wallet-extension/extension/popup.js', 'utf8');
new Function(code)();

await sleep(200);
console.log('1. initial screen shows create button:', !!findBtn('Create a new wallet'));

findBtn('Create a new wallet').click();
await sleep(100);
const words = [...app().querySelectorAll('.mnemonic-grid span')].map((s) => s.textContent.replace(/^\d+/, ''));
console.log('2. mnemonic grid has 24 words:', words.length === 24);
const addr = app().querySelector('.addr')?.textContent ?? '';
console.log('3. address preview:', addr.startsWith('keryx:q'), addr.slice(0, 28) + '…');

// tick the confirmation checkbox
const checkbox = app().querySelector('input[type=checkbox]');
checkbox.checked = true;
checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await sleep(50);

// set password
const pws = [...app().querySelectorAll('input[type=password]')];
console.log('4. password fields visible:', pws.length === 2);
for (const p of pws) {
  p.value = 'test-passphrase';
  p.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
await sleep(50);
const openBtn = findBtn('Open wallet');
console.log('5. submit enabled:', !openBtn.disabled);

openBtn.click();
// PBKDF2 600k iterations + live API round-trips
for (let i = 0; i < 60 && !app().textContent.includes('Balance'); i++) await sleep(500);
console.log('6. dashboard rendered:', app().textContent.includes('KERYX WALLET') && app().textContent.includes('Balance'));
console.log('7. vault persisted:', !!localStore.krx_sess && localStore.krx_sess.it === 600000);
console.log('8. session started:', !!sessionStore.krx_unlocked);

for (let i = 0; i < 40 && !app().querySelector('.balance-value'); i++) await sleep(500);
const bal = app().querySelector('.balance-value')?.textContent;
console.log('9. live balance loaded:', bal?.trim());
console.log('10. address on dashboard matches preview:', app().querySelector('.addr')?.textContent === addr);

// lock flow
findBtn('Lock').click();
await sleep(200);
console.log('11. locked screen:', app().textContent.includes('WALLET LOCKED'));
const pwInput = app().querySelector('input[type=password]');
pwInput.value = 'wrong-password';
findBtn('Unlock').click();
for (let i = 0; i < 30 && !app().textContent.includes('Wrong password'); i++) await sleep(500);
console.log('12. wrong password rejected:', app().textContent.includes('Wrong password.'));
pwInput.value = 'test-passphrase';
findBtn('Unlock').click();
for (let i = 0; i < 30 && !app().textContent.includes('Balance'); i++) await sleep(500);
console.log('13. unlock restores dashboard:', app().textContent.includes('Balance'));

process.exit(0);
