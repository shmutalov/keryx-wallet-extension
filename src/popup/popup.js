// Keryx Wallet popup.
//
// Screens: home (first run) / create-backup / set-password / import /
// add-account / locked / dashboard. One global session password secures the
// whole account store; accounts are switchable from the dashboard.

import {
  generateMnemonic,
  validateMnemonic,
  deriveWallet,
  formatKRX,
  shortAddress,
  DERIVATION_BASE,
} from '../lib/keryx.js';
import { api, API_BASE } from '../lib/api.js';
import { createVault, unlockVault, updateVault, vaultExists, clearVault } from '../lib/vault.js';
import { startSession, getSession, updateSessionStore, touchSession, endSession } from '../lib/session.js';

const app = document.getElementById('app');
const ACTIVE_KEY = 'krx_active';

const state = {
  store: null, // { accounts: [{ id, label, mnemonic, index }] }
  rawKey: null, // hex AES key for vault updates (memory/session only)
  activeId: null,
  wallet: null, // { address, privateKeyHex, publicKeyHex } of the active account
  refreshTimer: null,
  addrCache: new Map(), // `${mnemonic}:${index}` -> address
};

// --- account helpers -----------------------------------------------------------

function activeAccount() {
  return state.store.accounts.find((a) => a.id === state.activeId) ?? state.store.accounts[0];
}

function accountAddress(account) {
  const key = `${account.mnemonic}:${account.index}`;
  if (!state.addrCache.has(key)) {
    state.addrCache.set(key, deriveWallet(account.mnemonic, account.index).address);
  }
  return state.addrCache.get(key);
}

async function setActive(id) {
  state.activeId = id;
  await chrome.storage.local.set({ [ACTIVE_KEY]: id });
  const acct = activeAccount();
  state.wallet = deriveWallet(acct.mnemonic, acct.index);
}

async function persistStore() {
  await updateVault(state.store, state.rawKey);
  await updateSessionStore(state.store);
}

async function addAccount(account) {
  state.store.accounts.push(account);
  await persistStore();
  await setActive(account.id);
  renderDashboard();
}

function nextLabel() {
  return `Account ${state.store.accounts.length + 1}`;
}

function findDuplicate(mnemonic, index) {
  return state.store.accounts.find((a) => a.mnemonic === mnemonic && a.index === index);
}

// --- tiny DOM helper -------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v; // static templates only
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (!child && child !== 0) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

function show(...nodes) {
  clearInterval(state.refreshTimer);
  state.refreshTimer = null;
  app.replaceChildren(...nodes.filter(Boolean));
}

const LOCK_SVG =
  '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--mx-bright)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';

const LOCK_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';

const LOGO_SVG =
  '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--mx-bright)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="filter: drop-shadow(0 0 8px rgba(46,227,88,.45))"><path d="M8 3v18"></path><path d="M8 12h3"></path><path d="M11 12 17 4h3l-6 8 6 8h-3l-6-8"></path><circle cx="8" cy="3" r="1.1" fill="var(--mx-bright)"></circle><circle cx="8" cy="21" r="1.1" fill="var(--mx-bright)"></circle><circle cx="20" cy="4" r="1.1" fill="var(--mx-bright)"></circle><circle cx="20" cy="20" r="1.1" fill="var(--mx-bright)"></circle></svg>';

function copyButton(getText, label = '⧉', copiedLabel = '✓', id) {
  const btn = el('button', { ...(id ? { id } : {}), class: 'btn-small', title: 'Copy to clipboard' }, label);
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(getText()).catch(() => {});
    btn.textContent = copiedLabel;
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove('copied');
    }, 2000);
  });
  return btn;
}

function passwordFields() {
  const password = el('input', { id: 'pw-input', type: 'password', placeholder: '••••••••' });
  const confirm = el('input', { id: 'pw-confirm', type: 'password', placeholder: '••••••••' });
  const mismatch = el('div', { class: 'error-text', style: 'display:none' }, "Passwords don't match.");
  const checkMatch = () => {
    mismatch.style.display = confirm.value && password.value !== confirm.value ? '' : 'none';
  };
  password.addEventListener('input', checkMatch);
  confirm.addEventListener('input', checkMatch);
  const block = el(
    'div',
    {},
    el('div', { class: 'field' }, el('span', { class: 'label' }, 'Session password (min. 6 characters)'), password),
    el('div', { class: 'field' }, el('span', { class: 'label' }, 'Confirm password'), confirm, mismatch)
  );
  return {
    block,
    valid: () => password.value.length >= 6 && password.value === confirm.value,
    value: () => password.value,
    inputs: [password, confirm],
  };
}

// --- screens -----------------------------------------------------------------

function renderHome() {
  show(
    el('div', { class: 'home-logo', html: LOGO_SVG }),
    el('h1', { class: 'glow' }, 'KERYX WALLET'),
    el('p', { class: 'subtitle' }, 'Client-side wallet — private keys never leave your device'),
    el(
      'div',
      { class: 'card stack', style: 'margin-top:10px' },
      el('button', { id: 'create-btn', class: 'btn', onclick: () => renderCreateBackup({ firstRun: true }) }, '⊕ Create a new wallet'),
      el('button', { id: 'import-btn', class: 'btn ghost', onclick: () => renderImport({ firstRun: true }) }, '↩ Import with mnemonic phrase')
    ),
    el('div', { class: 'spacer' }),
    el('p', { class: 'hint' }, 'Private keys stay in your browser — they never leave your machine.')
  );
}

/**
 * Step 1 of wallet creation: show and confirm the mnemonic backup.
 * firstRun: continue to the password page. Unlocked: adds the account directly.
 */
function renderCreateBackup({ firstRun, mnemonic: preset }) {
  const mnemonic = preset ?? generateMnemonic();
  const words = mnemonic.split(' ');
  let address = null;
  try {
    address = deriveWallet(mnemonic).address;
  } catch {}

  const submit = el('button', { id: 'next-btn', class: 'btn', disabled: '' }, firstRun ? 'Next →' : 'Add account →');
  const errorBox = el('div', { class: 'error-box', style: 'display:none' });
  const checkbox = el('input', { id: 'backup-confirm', type: 'checkbox' });
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) submit.removeAttribute('disabled');
    else submit.setAttribute('disabled', '');
  });

  submit.addEventListener('click', async () => {
    if (!checkbox.checked) return;
    if (firstRun) {
      renderSetPassword({
        account: { id: crypto.randomUUID(), label: 'Account 1', mnemonic, index: 0 },
        onBack: () => renderCreateBackup({ firstRun: true, mnemonic }),
      });
      return;
    }
    submit.setAttribute('disabled', '');
    submit.textContent = 'Adding…';
    try {
      await addAccount({ id: crypto.randomUUID(), label: nextLabel(), mnemonic, index: 0 });
    } catch (e) {
      errorBox.textContent = String(e);
      errorBox.style.display = '';
      submit.removeAttribute('disabled');
      submit.textContent = 'Add account →';
    }
  });

  show(
    el('div', { class: 'back-row' },
      el('button', { class: 'link-btn', onclick: firstRun ? renderHome : renderAddAccount }, '← Back'),
      el('h2', {}, firstRun ? 'New wallet' : 'New seed phrase')
    ),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, 'Mnemonic phrase (24 words) — save it in a safe place'),
      el('div', { class: 'mnemonic-grid' },
        words.map((w, i) => el('span', {}, el('i', {}, String(i + 1)), w))
      ),
      el('div', { style: 'margin-top:10px' }, copyButton(() => mnemonic, '⧉ Copy phrase', '✓ copied'))
    ),
    address &&
      el('div', { class: 'card' },
        el('span', { class: 'label' }, 'Generated address'),
        el('div', { class: 'addr' }, address)
      ),
    el('div', { class: 'card' },
      el('label', { class: 'checkbox-row' }, checkbox,
        el('span', {}, 'I have saved my mnemonic phrase. I understand that without it, I cannot recover my funds.'))
    ),
    errorBox,
    submit
  );
}

/**
 * Step 2 of first-run setup (create or import): set the global session
 * password. It secures ALL accounts — new accounts added later never need
 * their own password.
 */
function renderSetPassword({ account, onBack }) {
  const pw = passwordFields();
  const errorBox = el('div', { class: 'error-box', style: 'display:none' });
  const submit = el('button', { id: 'open-wallet-btn', class: 'btn', disabled: '' }, 'Open wallet →');
  const refresh = () => {
    if (pw.valid()) submit.removeAttribute('disabled');
    else submit.setAttribute('disabled', '');
  };
  pw.inputs.forEach((i) => i.addEventListener('input', refresh));

  submit.addEventListener('click', async () => {
    if (!pw.valid()) return;
    submit.setAttribute('disabled', '');
    submit.textContent = 'Encrypting…';
    errorBox.style.display = 'none';
    try {
      const store = { accounts: [account] };
      const { rawKeyHex } = await createVault(store, pw.value());
      await startSession(store, rawKeyHex);
      state.store = store;
      state.rawKey = rawKeyHex;
      await setActive(account.id);
      renderDashboard();
    } catch (e) {
      errorBox.textContent = String(e);
      errorBox.style.display = '';
      submit.removeAttribute('disabled');
      submit.textContent = 'Open wallet →';
    }
  });

  show(
    el('div', { class: 'back-row' },
      el('button', { class: 'link-btn', onclick: onBack }, '← Back'),
      el('h2', {}, 'Set session password')
    ),
    el('div', { class: 'card stack' },
      el('p', { class: 'subtitle', style: 'text-align:left;margin:0' },
        'One password protects your whole wallet in this browser — every account you add is secured by it. You\'ll use it instead of the mnemonic on future visits.'),
      pw.block,
      errorBox,
      submit
    ),
    el('div', { class: 'spacer' }),
    el('p', { class: 'hint' }, 'Password is never stored. It encrypts your seed phrases on this device.')
  );
  setTimeout(() => pw.inputs[0].focus(), 50);
}

/** Import a seed phrase. firstRun: continue to password page. Unlocked: adds the account. */
function renderImport({ firstRun }) {
  const textarea = el('textarea', { id: 'mnemonic-input', rows: '3', placeholder: 'word1 word2 word3 …' });
  const invalid = el('div', { class: 'error-text', style: 'display:none' });
  const errorBox = el('div', { class: 'error-box', style: 'display:none' });
  const submit = el('button', { id: 'next-btn', class: 'btn', disabled: '' }, firstRun ? 'Next →' : 'Add account →');

  const normalized = () => textarea.value.trim().toLowerCase().replace(/\s+/g, ' ');
  const refresh = () => {
    const m = normalized();
    let msg = '';
    if (textarea.value.trim() && !validateMnemonic(m)) msg = 'Invalid mnemonic — check spelling and word count.';
    else if (!firstRun && m && findDuplicate(m, 0)) msg = 'This seed phrase is already added.';
    invalid.textContent = msg;
    invalid.style.display = msg ? '' : 'none';
    if (m && !msg && validateMnemonic(m)) submit.removeAttribute('disabled');
    else submit.setAttribute('disabled', '');
  };
  textarea.addEventListener('input', refresh);

  submit.addEventListener('click', async () => {
    const mnemonic = normalized();
    if (!validateMnemonic(mnemonic)) return;
    if (firstRun) {
      renderSetPassword({
        account: { id: crypto.randomUUID(), label: 'Account 1', mnemonic, index: 0 },
        onBack: () => renderImport({ firstRun: true }),
      });
      return;
    }
    if (findDuplicate(mnemonic, 0)) return;
    submit.setAttribute('disabled', '');
    submit.textContent = 'Adding…';
    try {
      await addAccount({ id: crypto.randomUUID(), label: nextLabel(), mnemonic, index: 0 });
    } catch (e) {
      errorBox.textContent = String(e);
      errorBox.style.display = '';
      submit.removeAttribute('disabled');
      submit.textContent = 'Add account →';
    }
  });

  show(
    el('div', { class: 'back-row' },
      el('button', { class: 'link-btn', onclick: firstRun ? renderHome : renderAddAccount }, '← Back'),
      el('h2', {}, firstRun ? 'Import wallet' : 'Import seed phrase')
    ),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, 'Mnemonic phrase (12 or 24 words)'),
      textarea,
      invalid
    ),
    errorBox,
    submit,
    el('div', { class: 'spacer' }),
    firstRun &&
      el('p', { class: 'hint' },
        'Password is never stored. To remove your wallet, click "Reset" or clear extension data.')
  );
}

/** Unlocked-only: choose how to add another account. */
function renderAddAccount() {
  const acct = activeAccount();
  const derivedIndex =
    Math.max(...state.store.accounts.filter((a) => a.mnemonic === acct.mnemonic).map((a) => a.index)) + 1;

  show(
    el('div', { class: 'back-row' },
      el('button', { class: 'link-btn', onclick: renderDashboard }, '← Back'),
      el('h2', {}, 'Add account')
    ),
    el('div', { class: 'card stack' },
      el('button', {
        id: 'derive-btn',
        class: 'btn',
        onclick: async () => {
          await addAccount({
            id: crypto.randomUUID(),
            label: nextLabel(),
            mnemonic: acct.mnemonic,
            index: derivedIndex,
          });
        },
      }, '⊕ New address from current seed'),
      el('p', { class: 'hint', style: 'text-align:left' },
        `Derives ${DERIVATION_BASE}/${derivedIndex} from ${acct.label}'s seed phrase — nothing new to back up.`)
    ),
    el('div', { class: 'card stack' },
      el('button', { id: 'new-seed-btn', class: 'btn ghost', onclick: () => renderCreateBackup({ firstRun: false }) }, '✚ Create a new seed phrase'),
      el('button', { id: 'import-seed-btn', class: 'btn ghost', onclick: () => renderImport({ firstRun: false }) }, '↩ Import a seed phrase')
    ),
    el('div', { class: 'spacer' }),
    el('p', { class: 'hint' }, 'All accounts are secured by your one session password.')
  );
}

async function resetWallet() {
  await clearVault();
  await endSession();
  await chrome.storage.local.remove(ACTIVE_KEY);
  state.store = null;
  state.rawKey = null;
  state.wallet = null;
  renderHome();
}

function renderSettings() {
  const infoRow = (k, v) =>
    el('div', { class: 'settings-row' }, el('span', {}, k), el('span', {}, v));
  const version = (globalThis.chrome?.runtime?.getManifest?.() ?? {}).version ?? 'dev';

  const confirmInput = el('input', { id: 'reset-confirm-input', type: 'text', placeholder: 'Type RESET to confirm', autocomplete: 'off' });
  const resetBtn = el('button', { id: 'reset-btn', class: 'btn danger', disabled: '' }, 'Reset wallet');
  confirmInput.addEventListener('input', () => {
    if (confirmInput.value.trim() === 'RESET') resetBtn.removeAttribute('disabled');
    else resetBtn.setAttribute('disabled', '');
  });
  resetBtn.addEventListener('click', async () => {
    if (confirmInput.value.trim() !== 'RESET') return;
    resetBtn.setAttribute('disabled', '');
    resetBtn.textContent = 'Resetting…';
    await resetWallet();
  });

  show(
    el('div', { class: 'back-row' },
      el('button', { class: 'link-btn', onclick: renderDashboard }, '← Back'),
      el('h2', {}, 'Settings')
    ),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, 'Session'),
      infoRow('Auto-lock', 'after 15 min of inactivity'),
      infoRow('Accounts', String(state.store.accounts.length)),
      infoRow('Network', 'keryx-mainnet'),
      infoRow('Version', version)
    ),
    el('div', { class: 'card danger stack' },
      el('span', { class: 'label danger' }, 'Danger zone'),
      el('p', { class: 'hint', style: 'text-align:left' },
        'Reset removes ALL accounts and the encrypted vault from this browser. Funds are only recoverable with the seed phrases — make sure every one of them is backed up before continuing.'),
      confirmInput,
      resetBtn
    )
  );
}

function renderLocked() {
  const password = el('input', { id: 'unlock-pw', type: 'password', placeholder: '••••••••' });
  const errorBox = el('div', { class: 'error-box', style: 'display:none' });
  const submit = el('button', { id: 'unlock-btn', class: 'btn' }, 'Unlock →');

  async function unlock() {
    if (!password.value || submit.disabled) return;
    submit.setAttribute('disabled', '');
    submit.textContent = 'Decrypting…';
    errorBox.style.display = 'none';
    const res = await unlockVault(password.value);
    if (!res) {
      errorBox.textContent = 'Wrong password.';
      errorBox.style.display = '';
      submit.removeAttribute('disabled');
      submit.textContent = 'Unlock →';
      return;
    }
    state.store = res.store;
    state.rawKey = res.rawKeyHex;
    await startSession(res.store, res.rawKeyHex);
    const { [ACTIVE_KEY]: savedId } = await chrome.storage.local.get(ACTIVE_KEY);
    const acct = res.store.accounts.find((a) => a.id === savedId) ?? res.store.accounts[0];
    await setActive(acct.id);
    renderDashboard();
  }

  submit.addEventListener('click', unlock);
  password.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') unlock();
  });

  show(
    el('div', { style: 'margin-top:36px' },
      el('div', { class: 'lock-icon', html: LOCK_SVG }),
      el('h1', { class: 'glow', style: 'font-size:16px' }, 'WALLET LOCKED'),
      el('p', { class: 'subtitle' }, 'Enter your password to continue.')
    ),
    el('div', { class: 'card stack' },
      el('div', { class: 'field' }, el('span', { class: 'label' }, 'Password'), password),
      errorBox,
      submit
    ),
    el('div', { class: 'spacer' }),
    el('button', {
      class: 'link-btn center',
      style: 'opacity:.5;width:100%',
      onclick: async () => {
        if (!window.confirm('Remove ALL accounts and the encrypted vault from this browser? Make sure every seed phrase is backed up.')) return;
        await resetWallet();
      },
    }, 'Use a different wallet (clear all data)')
  );
  setTimeout(() => password.focus(), 50);
}

function renderDashboard() {
  const acct = activeAccount();
  const { address } = state.wallet;

  const balanceBody = el('div', { class: 'loading' }, 'Loading…');
  const netRow = el('div', { class: 'net-row', style: 'display:none' });
  const txCard = el('div', { class: 'card', style: 'display:none' });

  // API reachability indicator, refreshed with every overview poll
  const statusDot = el('span', { id: 'api-status', class: 'status-dot' });
  const statusText = el('span', { id: 'api-status-text' }, 'checking…');
  const setStatus = (online) => {
    statusDot.className = `status-dot ${online ? 'online' : 'offline'}`;
    statusText.textContent = online ? 'online' : 'offline';
  };

  async function loadOverview() {
    try {
      const [bal, info, utxo, market] = await Promise.all([
        api.balance(address),
        api.info().catch(() => null),
        api.utxoCount(address).catch(() => null),
        api.market().catch(() => null),
      ]);
      const sompi = bal.balance_sompi ?? 0;
      const value = el('div', { class: 'balance-value' },
        formatKRX(sompi), ' ',
        el('span', { class: 'unit' }, 'KRX'));
      const parts = [value];
      if (market && typeof market.price_usd === 'number') {
        const usd = (sompi / 1e8) * market.price_usd;
        parts.push(el('div', { class: 'balance-meta' },
          `≈ $${usd.toLocaleString('en-US', { maximumFractionDigits: 2 })} · $${market.price_usd.toFixed(8).replace(/0+$/, '')}/KRX`));
      }
      if (utxo && typeof utxo.count === 'number') {
        parts.push(
          el('div', { class: `balance-meta${utxo.count >= 80 ? ' warn' : ''}` },
            `${utxo.count.toLocaleString('en-US')} UTXOs${utxo.count >= 80 ? ' — consolidation recommended' : ''}`)
        );
      }
      setStatus(true);
      balanceBody.replaceChildren(...parts);
      balanceBody.className = '';
      if (info) {
        netRow.replaceChildren(
          el('span', {}, info.network ?? 'keryx-mainnet'),
          el('span', {}, `DAA ${Number(info.last_daa_score ?? 0).toLocaleString('en-US')}`)
        );
        netRow.style.display = '';
      }
    } catch (e) {
      setStatus(false);
      balanceBody.className = 'error-text';
      balanceBody.style.fontSize = '12px';
      balanceBody.textContent = e instanceof Error ? e.message : String(e);
    }
  }

  let txPage = 0;
  async function loadTxs() {
    try {
      const res = await api.addressTxs(address, 10, 10 * txPage);
      const txs = res.transactions ?? [];
      const total = res.total_tx_count ?? 0;
      if (total === 0 && txs.length === 0) {
        txCard.style.display = 'none';
        return;
      }
      const pages = Math.max(1, Math.ceil(total / 10));
      const rows = txs.map((t) => {
        const spend = t.is_spend === true;
        const amount = formatKRX(Math.abs(t.amount_sompi ?? 0));
        const idText = t.tx_id.length <= 20 ? t.tx_id : `${t.tx_id.slice(0, 14)}…${t.tx_id.slice(-8)}`;
        return el('div', { class: 'tx-row' },
          el('a', { href: `${API_BASE}/tx/${t.tx_id}`, target: '_blank', rel: 'noreferrer' }, idText),
          el('span', { class: `tx-amount ${spend ? 'out' : 'in'}` },
            `${spend ? '−' : '+'}${amount} KRX`));
      });
      const children = [
        el('div', { class: 'tx-head' },
          el('span', { class: 'label', style: 'margin:0' }, 'Transaction history'),
          el('span', { class: 'tx-count' }, `${total.toLocaleString('en-US')} txs`)),
        el('div', { class: 'tx-list' }, rows),
      ];
      if (pages > 1) {
        const prev = el('button', { class: 'btn-small' }, '← Prev');
        const next = el('button', { class: 'btn-small' }, 'Next →');
        if (txPage === 0) prev.setAttribute('disabled', '');
        if (txPage >= pages - 1) next.setAttribute('disabled', '');
        prev.addEventListener('click', () => { txPage = Math.max(0, txPage - 1); loadTxs(); });
        next.addEventListener('click', () => { txPage = Math.min(pages - 1, txPage + 1); loadTxs(); });
        children.push(el('div', { class: 'pager' }, prev,
          el('span', {}, `Page ${txPage + 1} / ${pages}`), next));
      }
      txCard.replaceChildren(...children);
      txCard.style.display = '';
    } catch {
      /* history is best-effort */
    }
  }

  // account switcher with inline rename
  const accountSelect = el('select', { id: 'account-select', class: 'account-select', title: 'Switch account' });
  for (const a of state.store.accounts) {
    const opt = el('option', { value: a.id }, `${a.label} (…${accountAddress(a).slice(-6)})`);
    if (a.id === acct.id) opt.setAttribute('selected', '');
    accountSelect.append(opt);
  }
  accountSelect.addEventListener('change', async () => {
    await setActive(accountSelect.value);
    renderDashboard();
  });

  const accountRow = el('div', { class: 'account-row' });
  const renderSwitchMode = () => {
    accountRow.replaceChildren(
      accountSelect,
      el('button', { id: 'rename-btn', class: 'btn-small', title: 'Rename account', onclick: renderEditMode }, '✎'),
      el('button', { id: 'add-account-btn', class: 'btn-small', title: 'Add account', onclick: renderAddAccount }, '＋ Add')
    );
  };
  function renderEditMode() {
    const nameInput = el('input', { id: 'rename-input', type: 'text', value: acct.label, maxlength: '24', title: 'Account name' });
    const save = async () => {
      const label = nameInput.value.trim();
      if (label && label !== acct.label) {
        acct.label = label;
        await persistStore();
      }
      renderDashboard();
    };
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') renderSwitchMode();
    });
    accountRow.replaceChildren(
      nameInput,
      el('button', { id: 'rename-save-btn', class: 'btn-small', title: 'Save name', onclick: save }, '✓'),
      el('button', { id: 'rename-cancel-btn', class: 'btn-small', title: 'Cancel', onclick: renderSwitchMode }, '✕')
    );
    nameInput.focus();
    nameInput.select();
  }
  renderSwitchMode();

  const refreshBtn = el('button', { id: 'refresh-btn', class: 'btn-small', title: 'Refresh', onclick: () => { loadOverview(); loadTxs(); } }, '↺');

  show(
    el('div', { class: 'topbar' },
      el('div', {},
        el('h2', { class: 'glow' }, 'KERYX WALLET'),
        el('div', { class: 'status-row' },
          statusDot, statusText,
          el('span', { class: 'status-sep' }, '·'),
          `${DERIVATION_BASE}/${acct.index}`)),
      el('div', { class: 'actions' },
        el('button', {
          id: 'lock-btn',
          class: 'btn-small icon',
          title: 'Lock wallet (keeps encrypted vault)',
          html: LOCK_ICON,
          onclick: async () => { await endSession(); state.wallet = null; renderLocked(); },
        }),
        el('button', { id: 'settings-btn', class: 'btn-small', title: 'Settings', onclick: renderSettings }, '⚙'))),
    accountRow,
    el('div', { class: 'card' },
      el('span', { class: 'label' }, `${acct.label} — KRX address`),
      el('div', { class: 'addr-row' },
        el('div', { id: 'address', class: 'addr' }, address),
        copyButton(() => address, '⧉', '✓', 'copy-address-btn'),
        refreshBtn)),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, 'Balance'),
      balanceBody,
      netRow),
    txCard,
    el('p', { class: 'hint', style: 'margin-top:2px' },
      'Send · Consolidate · AI inference — coming in the next release.')
  );

  loadOverview();
  loadTxs();
  state.refreshTimer = setInterval(loadOverview, 15000);
}

// --- activity tracking (feeds the 15-min auto-lock) ---------------------------

let lastTouch = 0;
for (const evt of ['mousedown', 'keydown']) {
  document.addEventListener(evt, () => {
    const now = Date.now();
    if (now - lastTouch > 30000) {
      lastTouch = now;
      touchSession().catch(() => {});
    }
  }, { passive: true });
}

// --- init ----------------------------------------------------------------------

(async function init() {
  if (!(await vaultExists())) {
    renderHome();
    return;
  }
  const session = await getSession();
  if (session) {
    try {
      state.store = session.store;
      state.rawKey = session.rawKeyHex;
      const { [ACTIVE_KEY]: savedId } = await chrome.storage.local.get(ACTIVE_KEY);
      const acct = session.store.accounts.find((a) => a.id === savedId) ?? session.store.accounts[0];
      await setActive(acct.id);
      renderDashboard();
      return;
    } catch {
      await endSession();
    }
  }
  renderLocked();
})();
