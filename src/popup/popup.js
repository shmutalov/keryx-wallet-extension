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
  parseKRX,
  isValidAddress,
  shortAddress,
  DERIVATION_BASE,
} from '../lib/keryx.js';
import {
  buildTransferTx,
  buildInferenceTx,
  buildInferencePayload,
  MIN_FEE_SOMPI,
} from '../lib/tx.js';
import { INFERENCE_MODELS, getModel, getModelByIdHex, inferenceRewardSompi } from '../lib/models.js';
import {
  getAddressBook,
  addBookEntry,
  removeBookEntry,
  getRecentAddresses,
  pushRecentAddress,
} from '../lib/book.js';
import { api, API_BASE, DEFAULT_API_BASE, loadApiBase, setApiBase } from '../lib/api.js';
import { t, loadLocale, setLocale, getLocaleOverride, SUPPORTED_LOCALES, LOCALE_LABELS } from '../lib/i18n.js';
import { createVault, unlockVault, updateVault, vaultExists, clearVault } from '../lib/vault.js';
import { startSession, getSession, updateSessionStore, touchSession, endSession } from '../lib/session.js';
import { getConnections, removeConnection } from '../lib/provider.js';

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
  const btn = el('button', { ...(id ? { id } : {}), class: 'btn-small', title: t('title_copy') }, label);
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

function txRow(tx) {
  const spend = tx.is_spend === true;
  const amount = formatKRX(Math.abs(tx.amount_sompi ?? 0));
  const idText = tx.tx_id.length <= 20 ? tx.tx_id : `${tx.tx_id.slice(0, 14)}…${tx.tx_id.slice(-8)}`;
  return el('div', { class: 'tx-row' },
    el('a', { href: `${API_BASE}/tx/${tx.tx_id}`, target: '_blank', rel: 'noreferrer' }, idText),
    el('span', { class: `tx-amount ${spend ? 'out' : 'in'}` }, `${spend ? '−' : '+'}${amount} KRX`));
}

function passwordFields() {
  const password = el('input', { id: 'pw-input', type: 'password', placeholder: '••••••••' });
  const confirm = el('input', { id: 'pw-confirm', type: 'password', placeholder: '••••••••' });
  const mismatch = el('div', { class: 'error-text', style: 'display:none' }, t('err_passwords_mismatch'));
  const checkMatch = () => {
    mismatch.style.display = confirm.value && password.value !== confirm.value ? '' : 'none';
  };
  password.addEventListener('input', checkMatch);
  confirm.addEventListener('input', checkMatch);
  const block = el(
    'div',
    {},
    el('div', { class: 'field' }, el('span', { class: 'label' }, t('label_session_password_min')), password),
    el('div', { class: 'field' }, el('span', { class: 'label' }, t('label_confirm_password')), confirm, mismatch)
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
    el('h1', { class: 'glow' }, t('home_title')),
    el('p', { class: 'subtitle' }, t('home_subtitle')),
    el(
      'div',
      { class: 'card stack', style: 'margin-top:10px' },
      el('button', { id: 'create-btn', class: 'btn', onclick: () => renderCreateBackup({ firstRun: true }) }, t('home_create')),
      el('button', { id: 'import-btn', class: 'btn ghost', onclick: () => renderImport({ firstRun: true }) }, t('home_import'))
    ),
    el('div', { class: 'spacer' }),
    el('p', { class: 'hint' }, t('home_hint'))
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

  const submit = el('button', { id: 'next-btn', class: 'btn', disabled: '' }, firstRun ? t('btn_next') : t('btn_add_account'));
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
    submit.textContent = t('status_adding');
    try {
      await addAccount({ id: crypto.randomUUID(), label: nextLabel(), mnemonic, index: 0 });
    } catch (e) {
      errorBox.textContent = String(e);
      errorBox.style.display = '';
      submit.removeAttribute('disabled');
      submit.textContent = t('btn_add_account');
    }
  });

  show(
    el('div', { class: 'back-row' },
      el('button', { class: 'link-btn', onclick: firstRun ? renderHome : renderAddAccount }, t('nav_back')),
      el('h2', {}, firstRun ? t('title_new_wallet') : t('title_new_seed'))
    ),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, t('backup_mnemonic_label')),
      el('div', { class: 'mnemonic-grid' },
        words.map((w, i) => el('span', {}, el('i', {}, String(i + 1)), w))
      ),
      el('div', { style: 'margin-top:10px' }, copyButton(() => mnemonic, t('copy_phrase'), t('copied')))
    ),
    address &&
      el('div', { class: 'card' },
        el('span', { class: 'label' }, t('backup_generated_address')),
        el('div', { class: 'addr' }, address)
      ),
    el('div', { class: 'card' },
      el('label', { class: 'checkbox-row' }, checkbox,
        el('span', {}, t('backup_confirm_saved')))
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
  const submit = el('button', { id: 'open-wallet-btn', class: 'btn', disabled: '' }, t('btn_open_wallet'));
  const refresh = () => {
    if (pw.valid()) submit.removeAttribute('disabled');
    else submit.setAttribute('disabled', '');
  };
  pw.inputs.forEach((i) => i.addEventListener('input', refresh));

  submit.addEventListener('click', async () => {
    if (!pw.valid()) return;
    submit.setAttribute('disabled', '');
    submit.textContent = t('status_encrypting');
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
      submit.textContent = t('btn_open_wallet');
    }
  });

  show(
    el('div', { class: 'back-row' },
      el('button', { class: 'link-btn', onclick: onBack }, t('nav_back')),
      el('h2', {}, t('title_set_password'))
    ),
    el('div', { class: 'card stack' },
      el('p', { class: 'subtitle', style: 'text-align:left;margin:0' },
        t('setpw_intro')),
      pw.block,
      errorBox,
      submit
    ),
    el('div', { class: 'spacer' }),
    el('p', { class: 'hint' }, t('setpw_hint'))
  );
  setTimeout(() => pw.inputs[0].focus(), 50);
}

/** Import a seed phrase. firstRun: continue to password page. Unlocked: adds the account. */
function renderImport({ firstRun }) {
  const textarea = el('textarea', { id: 'mnemonic-input', rows: '3', placeholder: t('import_placeholder') });
  const invalid = el('div', { class: 'error-text', style: 'display:none' });
  const errorBox = el('div', { class: 'error-box', style: 'display:none' });
  const submit = el('button', { id: 'next-btn', class: 'btn', disabled: '' }, firstRun ? t('btn_next') : t('btn_add_account'));

  const normalized = () => textarea.value.trim().toLowerCase().replace(/\s+/g, ' ');
  const refresh = () => {
    const m = normalized();
    let msg = '';
    if (textarea.value.trim() && !validateMnemonic(m)) msg = t('err_invalid_mnemonic');
    else if (!firstRun && m && findDuplicate(m, 0)) msg = t('err_seed_already_added');
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
    submit.textContent = t('status_adding');
    try {
      await addAccount({ id: crypto.randomUUID(), label: nextLabel(), mnemonic, index: 0 });
    } catch (e) {
      errorBox.textContent = String(e);
      errorBox.style.display = '';
      submit.removeAttribute('disabled');
      submit.textContent = t('btn_add_account');
    }
  });

  show(
    el('div', { class: 'back-row' },
      el('button', { class: 'link-btn', onclick: firstRun ? renderHome : renderAddAccount }, t('nav_back')),
      el('h2', {}, firstRun ? t('title_import_wallet') : t('title_import_seed'))
    ),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, t('import_mnemonic_label')),
      textarea,
      invalid
    ),
    errorBox,
    submit,
    el('div', { class: 'spacer' }),
    firstRun &&
      el('p', { class: 'hint' },
        t('import_hint'))
  );
}

/** Unlocked-only: choose how to add another account. */
function renderAddAccount() {
  const acct = activeAccount();
  const derivedIndex =
    Math.max(...state.store.accounts.filter((a) => a.mnemonic === acct.mnemonic).map((a) => a.index)) + 1;

  show(
    el('div', { class: 'back-row' },
      el('button', { class: 'link-btn', onclick: renderDashboard }, t('nav_back')),
      el('h2', {}, t('title_add_account'))
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
      }, t('addacct_new_address')),
      el('p', { class: 'hint', style: 'text-align:left' },
        t('addacct_derive_hint', `${DERIVATION_BASE}/${derivedIndex}`, acct.label))
    ),
    el('div', { class: 'card stack' },
      el('button', { id: 'new-seed-btn', class: 'btn ghost', onclick: () => renderCreateBackup({ firstRun: false }) }, t('addacct_new_seed')),
      el('button', { id: 'import-seed-btn', class: 'btn ghost', onclick: () => renderImport({ firstRun: false }) }, t('addacct_import_seed'))
    ),
    el('div', { class: 'spacer' }),
    el('p', { class: 'hint' }, t('addacct_hint'))
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

  // Ask the configured node which network it is, rather than printing a fixed
  // 'keryx-mainnet' — this row sits directly under the API-host field, so a
  // hardcoded answer contradicts the host the user just pointed us at.
  const netValue = el('span', {}, t('common_loading'));
  api.info().then(
    (info) => { netValue.textContent = info?.network || '—'; },
    () => { netValue.textContent = '—'; }
  );

  // dApp connections (origins granted through the provider's approval flow)
  const sitesBox = el('div', { id: 'connected-sites', class: 'stack' },
    el('span', { class: 'hint' }, t('common_loading')));
  async function refreshSites() {
    const connections = await getConnections();
    const origins = Object.keys(connections).sort();
    if (origins.length === 0) {
      sitesBox.replaceChildren(el('span', { class: 'hint' }, t('sites_none')));
      return;
    }
    sitesBox.replaceChildren(...origins.map((origin) => {
      const c = connections[origin];
      const acct = state.store.accounts.find((a) => a.id === c.accountId);
      const remove = el('button', {
        id: `site-disconnect-${origin.replace(/[^a-z0-9]/gi, '-')}`,
        class: 'btn-small',
        title: t('title_disconnect_site'),
      }, '✕');
      remove.addEventListener('click', async () => {
        await removeConnection(origin);
        // background broadcasts accountsChanged([]) + disconnect to the site's tabs
        try {
          await chrome.runtime.sendMessage({ type: 'krx-origin-disconnected', origin });
        } catch {}
        refreshSites();
      });
      return el('div', { class: 'settings-row', style: 'align-items:center' },
        el('span', { style: 'word-break:break-all' }, origin),
        el('span', {}, acct ? `${acct.label} ` : '', remove));
    }));
  }
  refreshSites();

  // interface language (auto = follow the browser); applies immediately on change
  const langSelect = el('select', { id: 'lang-select', class: 'account-select' });
  langSelect.append(el('option', { value: 'auto' }, t('locale_auto')));
  for (const loc of SUPPORTED_LOCALES) langSelect.append(el('option', { value: loc }, LOCALE_LABELS[loc]));
  getLocaleOverride().then((v) => { langSelect.value = v; });
  langSelect.addEventListener('change', async () => {
    await setLocale(langSelect.value);
    renderSettings();
  });

  // configurable API host (empty = official default)
  const hostInput = el('input', {
    id: 'api-host-input', type: 'text', placeholder: t('host_placeholder_default', DEFAULT_API_BASE),
    autocomplete: 'off', spellcheck: 'false',
  });
  hostInput.value = API_BASE === DEFAULT_API_BASE ? '' : API_BASE;
  const hostStatus = el('div', { id: 'api-host-status', style: 'display:none' });
  const hostSave = el('button', { id: 'api-host-save', class: 'btn ghost' }, t('host_save'));
  hostSave.addEventListener('click', async () => {
    try {
      const base = await setApiBase(hostInput.value);
      hostInput.value = base === DEFAULT_API_BASE ? '' : base;
      hostStatus.className = 'success-box';
      hostStatus.textContent = t('host_using', base) + (base === DEFAULT_API_BASE ? t('host_default_suffix') : '');
    } catch (e) {
      hostStatus.className = 'error-box';
      hostStatus.textContent = e instanceof Error ? e.message : String(e);
    }
    hostStatus.style.display = '';
  });

  const confirmInput = el('input', { id: 'reset-confirm-input', type: 'text', placeholder: t('reset_confirm_placeholder'), autocomplete: 'off' });
  const resetBtn = el('button', { id: 'reset-btn', class: 'btn danger', disabled: '' }, t('btn_reset_wallet'));
  confirmInput.addEventListener('input', () => {
    if (confirmInput.value.trim() === 'RESET') resetBtn.removeAttribute('disabled');
    else resetBtn.setAttribute('disabled', '');
  });
  resetBtn.addEventListener('click', async () => {
    if (confirmInput.value.trim() !== 'RESET') return;
    resetBtn.setAttribute('disabled', '');
    resetBtn.textContent = t('status_resetting');
    await resetWallet();
  });

  show(
    el('div', { class: 'back-row' },
      el('button', { class: 'link-btn', onclick: renderDashboard }, t('nav_back')),
      el('h2', {}, t('title_settings'))
    ),
    el('div', { class: 'card stack' },
      el('span', { class: 'label' }, t('settings_language_label')),
      el('p', { class: 'hint', style: 'text-align:left' }, t('settings_language_hint')),
      langSelect
    ),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, t('settings_session')),
      infoRow(t('settings_autolock_label'), t('settings_autolock_value')),
      infoRow(t('settings_accounts'), String(state.store.accounts.length)),
      el('div', { class: 'settings-row' }, el('span', {}, t('settings_network')), netValue),
      infoRow(t('settings_version'), version)
    ),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, t('settings_addressbook_label')),
      el('button', {
        id: 'settings-book-btn',
        class: 'btn ghost',
        onclick: () => renderAddressBook({ onBack: renderSettings }),
      }, t('settings_manage_book'))
    ),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, t('settings_connected_sites')),
      el('p', { class: 'hint', style: 'text-align:left;margin-bottom:8px' },
        t('settings_connected_hint')),
      sitesBox
    ),
    el('div', { class: 'card stack' },
      el('span', { class: 'label' }, t('settings_network')),
      el('p', { class: 'hint', style: 'text-align:left' },
        t('settings_network_hint')),
      hostInput,
      hostStatus,
      hostSave
    ),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, t('settings_backup_label')),
      el('button', { id: 'settings-backup-btn', class: 'btn ghost', onclick: renderBackup },
        t('settings_backup_btn')),
      el('p', { class: 'hint', style: 'text-align:left;margin-top:8px' },
        t('settings_backup_hint'))
    ),
    el('div', { class: 'card danger stack' },
      el('span', { class: 'label danger' }, t('settings_danger_zone')),
      el('p', { class: 'hint', style: 'text-align:left' },
        t('settings_danger_hint')),
      confirmInput,
      resetBtn
    )
  );
}

const ipfsCache = new Map(); // cid -> text | Promise

/** AI inference: submit prompts on-chain (AiRequest) and watch the live feed. */
function renderInference() {
  const acct = activeAccount();
  const { address } = state.wallet;

  let availableSompi = null;
  let capabilities = null; // null = unknown (endpoint unreachable)
  let challengesByPrefix = new Map();
  let busy = false;

  const availLine = el('div', { class: 'balance-meta' }, `${t('label_balance')}: …`);
  const modelSelect = el('select', { id: 'inf-model', class: 'account-select' });
  for (const m of INFERENCE_MODELS) {
    const opt = el('option', { value: m.key },
      `${m.label} · ${t('inf_from_price', formatKRX(m.baseSompi))}`);
    if (m.key === 'glm-4-9b-0414') opt.setAttribute('selected', '');
    modelSelect.append(opt);
  }
  const minersLine = el('div', { id: 'inf-miners', class: 'balance-meta' }, '');
  const promptInput = el('textarea', {
    id: 'inf-prompt', rows: '4', placeholder: t('inf_prompt_placeholder'),
  });
  const charCount = el('span', { class: 'tx-count' }, t('inf_chars', '0'));
  const tokensVal = el('span', { id: 'inf-tokens-val', style: 'color:var(--mx-bright)' }, '256');
  const tokensSlider = el('input', {
    id: 'inf-tokens', type: 'range', min: '64', max: '4096', step: '64', value: '256',
  });
  const feeInput = el('input', {
    id: 'inf-fee', type: 'text', inputmode: 'decimal', value: '0.3',
    autocomplete: 'off', spellcheck: 'false',
  });
  const totalLine = el('div', { id: 'inf-total', class: 'balance-meta' }, '');
  const statusBox = el('div', { id: 'inf-status', style: 'display:none' });
  const submit = el('button', { id: 'inf-submit', class: 'btn', disabled: '' }, t('inf_submit'));
  const feedList = el('div', { id: 'inf-feed', class: 'stack' },
    el('div', { class: 'loading' }, t('common_loading')));

  const toSompi = (v) => parseKRX((v || '0').trim().replace(',', '.'));
  const feeSompi = () => Math.max(MIN_FEE_SOMPI, toSompi(feeInput.value) || 0);
  const maxTokens = () => Number(tokensSlider.value);
  const rewardSompi = () => inferenceRewardSompi(modelSelect.value, maxTokens());
  const totalSompi = () => rewardSompi() + feeSompi();

  function minerInfo() {
    if (!capabilities) return { count: null, pubkey: undefined }; // endpoint unreachable
    // Match on the model key, but fall back to the on-chain id: an API host
    // whose model registry lags ours reports the raw model_id_hex instead of
    // the key, which would otherwise read as "0 miners" for a valid model.
    const selected = getModel(modelSelect.value);
    const cap = capabilities.find(
      (c) => c.model === modelSelect.value || (selected && c.model_id_hex === selected.idHex)
    );
    return { count: cap?.miner_count ?? 0, pubkey: cap?.miner_pubkeys?.[0] };
  }

  function refreshEstimate() {
    const model = getModel(modelSelect.value);
    const { count } = minerInfo();
    totalLine.textContent = t('inf_total',
      formatKRX(totalSompi()),
      formatKRX(model.baseSompi),
      formatKRX(inferenceRewardSompi(modelSelect.value, maxTokens()) - model.baseSompi),
      formatKRX(feeSompi()));
    if (count === null) minersLine.textContent = t('inf_miners_unknown');
    else if (count === 0) minersLine.textContent = t('inf_no_miners', model.name);
    else minersLine.textContent = t('inf_miners_count', count);
    minersLine.style.color = count === 0 ? 'var(--mx-error)' : '';
    validate();
  }

  function validate() {
    const { count } = minerInfo();
    const funded = availableSompi === null || availableSompi > totalSompi();
    const ok = !busy && promptInput.value.trim().length > 0 && funded && count !== 0;
    if (ok) submit.removeAttribute('disabled');
    else submit.setAttribute('disabled', '');
    availLine.style.color = availableSompi !== null && !funded ? 'var(--mx-error)' : '';
  }

  modelSelect.addEventListener('change', refreshEstimate);
  feeInput.addEventListener('input', refreshEstimate);
  tokensSlider.addEventListener('input', () => {
    tokensVal.textContent = tokensSlider.value;
    refreshEstimate();
  });
  promptInput.addEventListener('input', () => {
    charCount.textContent = t('inf_chars', promptInput.value.length);
    validate();
  });
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSubmit();
  });

  function setStatus(kind, ...children) {
    statusBox.className = kind === 'error' ? 'error-box' : 'success-box';
    statusBox.replaceChildren(...children);
    statusBox.style.display = '';
  }

  async function doSubmit() {
    if (submit.disabled) return;
    const prompt = promptInput.value.trim();
    const model = getModel(modelSelect.value);
    const fee = feeSompi();
    const reward = rewardSompi();
    busy = true;
    validate();
    statusBox.style.display = 'none';
    try {
      submit.textContent = t('status_loading_utxos');
      const [utxos, info] = await Promise.all([
        api.utxos(address, 400),
        api.info().catch(() => null),
      ]);
      submit.textContent = t('status_signing');
      const payloadHex = buildInferencePayload(prompt, model.idHex, maxTokens(), reward, fee);
      const { pubkey } = minerInfo();
      const built = buildInferenceTx({
        utxos,
        changeAddress: address,
        feeSompi: fee,
        privateKeyHex: state.wallet.privateKeyHex,
        currentDaaScore: info?.last_daa_score ?? 0,
        payloadHex,
        escrow: pubkey ? { pubkeyHex: pubkey, amountSompi: reward } : undefined,
      });
      submit.textContent = t('status_broadcasting');
      const res = await api.broadcast(built.tx);
      setStatus('success',
        el('div', {}, t('inf_submitted')),
        el('div', { class: 'tx-link' }, t('inf_tx_label'),
          el('a', { href: `${API_BASE}/tx/${res.transaction_id}`, target: '_blank', rel: 'noreferrer' },
            res.transaction_id)),
        el('div', { class: 'hint', style: 'text-align:left;margin-top:4px' },
          t('inf_submitted_hint')));
      promptInput.value = '';
      charCount.textContent = t('inf_chars', '0');
      loadOverviewData();
    } catch (e) {
      setStatus('error', e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
      submit.textContent = t('inf_submit');
      validate();
    }
  }
  submit.addEventListener('click', doSubmit);

  async function loadOverviewData() {
    try {
      const bal = await api.balance(address);
      availableSompi = bal.balance_sompi ?? 0;
      availLine.textContent = `${t('label_balance')}: ${formatKRX(availableSompi)} KRX`;
    } catch {
      availLine.textContent = `${t('label_balance')}: — (${t('node_unreachable')})`;
    }
    validate();
  }

  function resultNode(item) {
    const r = item.result;
    if (!r) return null;
    const box = el('div', { class: 'inf-result' });
    const renderText = (text) => {
      const long = text.length > 400;
      const body = el('div', { class: `inf-result-text${long ? ' clamped' : ''}` }, text);
      const kids = [body];
      if (long) {
        const toggle = el('button', { class: 'link-btn', style: 'font-size:10px;margin-top:2px' }, t('inf_show_more'));
        toggle.addEventListener('click', () => {
          const clamped = body.classList.toggle('clamped');
          toggle.textContent = clamped ? t('inf_show_more') : t('inf_show_less');
        });
        kids.push(toggle);
      }
      box.replaceChildren(...kids);
    };
    if (/^Qm/.test(r) && r.length === 46) {
      box.replaceChildren(el('span', { class: 'hint' }, t('inf_fetching')));
      if (!ipfsCache.has(r)) ipfsCache.set(r, api.ipfsText(r));
      Promise.resolve(ipfsCache.get(r)).then((text) => {
        ipfsCache.set(r, text);
        renderText(text);
      }).catch(() => {
        box.replaceChildren(el('a', {
          href: `${API_BASE}/ipfs/${r}`, target: '_blank', rel: 'noreferrer', class: 'hint',
        }, `${r.slice(0, 12)}…${r.slice(-6)} ↗`));
      });
    } else {
      renderText(item.result_text || r);
    }
    return box;
  }

  async function loadFeed() {
    try {
      const [items, challenges] = await Promise.all([
        api.inferences(10),
        api.challenges(50).catch(() => []),
      ]);
      challengesByPrefix = new Map();
      for (const c of challenges) {
        if (!c.request_hash_hex) continue;
        const key = c.request_hash_hex.slice(0, 16);
        const existing = challengesByPrefix.get(key);
        if (!existing || (c.fraud_proven && !existing.fraud_proven)) challengesByPrefix.set(key, c);
      }
      if (!items.length) {
        feedList.replaceChildren(el('p', { class: 'hint', style: 'text-align:left' },
          t('inf_no_requests')));
        return;
      }
      feedList.replaceChildren(...items.map((item) => {
        const challenge = item.payload_prefix ? challengesByPrefix.get(item.payload_prefix) : null;
        const slashed = !!challenge?.fraud_proven;
        const badge = slashed
          ? el('span', { class: 'badge badge-bad' }, t('badge_slashed'))
          : challenge
            ? el('span', { class: 'badge badge-warn' }, t('badge_challenged'))
            : item.result
              ? el('span', { class: 'badge badge-ok' }, t('badge_responded'))
              : el('span', { class: 'badge badge-pend' }, t('badge_pending'));
        // item.model is normally the key; fall back to id-hex resolution when
        // the API host returned an unrecognised (raw) model id.
        const modelName = (getModel(item.model) ?? getModelByIdHex(item.model))?.name ?? item.model;
        return el('div', { class: 'inf-item' },
          el('div', { class: 'inf-item-head' },
            el('a', {
              href: `${API_BASE}/tx/${item.tx_id}`, target: '_blank', rel: 'noreferrer',
            }, `${item.tx_id.slice(0, 10)}…`),
            el('span', { class: 'badge badge-model' }, modelName),
            badge),
          el('div', { class: 'inf-prompt' }, item.prompt),
          resultNode(item));
      }));
    } catch {
      /* feed is best-effort */
    }
  }

  async function loadCapabilities() {
    try {
      capabilities = await api.capabilities();
    } catch {
      capabilities = null;
    }
    refreshEstimate();
  }

  show(
    el('div', { class: 'back-row' },
      el('button', { class: 'link-btn', onclick: renderDashboard }, t('nav_back')),
      el('h2', {}, t('title_ai_inference'))
    ),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, t('label_from_account', acct.label)),
      el('div', { class: 'addr', style: 'font-size:10px' }, address),
      availLine
    ),
    el('div', { class: 'card' },
      el('div', { class: 'field' }, el('span', { class: 'label' }, t('label_model')), modelSelect),
      minersLine
    ),
    el('div', { class: 'card' },
      el('div', { class: 'field' },
        el('span', { class: 'label' }, t('label_prompt')),
        promptInput),
      el('div', { class: 'slider-row' },
        el('span', { class: 'tx-count', style: 'white-space:nowrap' }, t('inf_max_tokens_prefix'), tokensVal),
        tokensSlider,
        charCount),
      el('div', { class: 'send-row', style: 'margin-top:10px' },
        el('div', { class: 'field', style: 'width:110px' },
          el('span', { class: 'label' }, t('inf_priority_fee')),
          feeInput),
        el('div', { class: 'field', style: 'flex:1;justify-content:flex-end' },
          totalLine))
    ),
    statusBox,
    submit,
    el('div', { class: 'card' },
      el('div', { class: 'tx-head' },
        el('span', { class: 'label', style: 'margin:0' }, t('inf_live_feed')),
        el('span', { class: 'tx-count' }, t('inf_autorefresh'))),
      feedList
    ),
    el('p', { class: 'hint' },
      t('inf_footer'))
  );

  refreshEstimate();
  loadOverviewData();
  loadCapabilities();
  loadFeed();
  state.refreshTimer = setInterval(() => {
    loadFeed();
    loadCapabilities();
  }, 5000);
}

/** Dedicated paginated transaction history for the active account. */
function renderHistory() {
  const acct = activeAccount();
  const { address } = state.wallet;
  const PAGE = 15;
  let page = 0;

  const countEl = el('span', { class: 'tx-count' }, '');
  const listBox = el('div', { id: 'hist-list', class: 'tx-list' });
  const pagerBox = el('div', {});

  async function load() {
    listBox.replaceChildren(el('div', { class: 'loading' }, t('common_loading')));
    try {
      const res = await api.addressTxs(address, PAGE, PAGE * page);
      const txs = res.transactions ?? [];
      const total = res.total_tx_count ?? 0;
      countEl.textContent = t('txs_count', total.toLocaleString('en-US'));
      if (!txs.length) {
        listBox.replaceChildren(el('p', { class: 'hint', style: 'text-align:left;padding:8px 0' }, t('hist_none')));
        pagerBox.replaceChildren();
        return;
      }
      listBox.replaceChildren(...txs.map(txRow));
      const pages = Math.max(1, Math.ceil(total / PAGE));
      if (pages > 1) {
        const prev = el('button', { id: 'hist-prev', class: 'btn-small' }, t('hist_prev'));
        const next = el('button', { id: 'hist-next', class: 'btn-small' }, t('hist_next'));
        if (page === 0) prev.setAttribute('disabled', '');
        if (page >= pages - 1) next.setAttribute('disabled', '');
        prev.addEventListener('click', () => { page = Math.max(0, page - 1); load(); });
        next.addEventListener('click', () => { page = Math.min(pages - 1, page + 1); load(); });
        pagerBox.replaceChildren(el('div', { class: 'pager' }, prev,
          el('span', { id: 'hist-page' }, t('hist_page', page + 1, pages)), next));
      } else {
        pagerBox.replaceChildren();
      }
    } catch (e) {
      listBox.replaceChildren(el('div', { class: 'error-box' },
        e instanceof Error ? e.message : String(e)));
      pagerBox.replaceChildren();
    }
  }

  show(
    el('div', { class: 'back-row' },
      el('button', { class: 'link-btn', onclick: renderDashboard }, t('nav_back')),
      el('h2', {}, t('title_transactions'))
    ),
    el('div', { class: 'card' },
      el('div', { class: 'tx-head' },
        el('span', { class: 'label', style: 'margin:0' }, `${acct.label} — …${address.slice(-8)}`),
        countEl),
      listBox,
      pagerBox
    )
  );
  load();
}

/**
 * Seed-phrase backup. Even with the wallet unlocked, revealing a seed
 * requires re-entering the session password (verified by decrypting the
 * vault — the password itself is never stored anywhere).
 */
function renderBackup() {
  const accounts = state.store.accounts;
  const select = el('select', { id: 'backup-account-select', class: 'account-select' });
  for (const a of accounts) {
    const opt = el('option', { value: a.id }, `${a.label} (…${accountAddress(a).slice(-6)})`);
    if (a.id === state.activeId) opt.setAttribute('selected', '');
    select.append(opt);
  }

  const pwInput = el('input', { id: 'backup-pw', type: 'password', placeholder: '••••••••' });
  const errorBox = el('div', { id: 'backup-error', class: 'error-box', style: 'display:none' });
  const revealBtn = el('button', { id: 'backup-reveal-btn', class: 'btn', disabled: '' }, t('backup_reveal_btn'));
  const output = el('div', { id: 'backup-output', class: 'stack' });
  let busy = false;

  pwInput.addEventListener('input', () => {
    if (pwInput.value && !busy) revealBtn.removeAttribute('disabled');
    else revealBtn.setAttribute('disabled', '');
  });

  async function doReveal() {
    if (!pwInput.value || busy) return;
    busy = true;
    revealBtn.setAttribute('disabled', '');
    revealBtn.textContent = t('status_verifying');
    errorBox.style.display = 'none';
    const res = await unlockVault(pwInput.value);
    busy = false;
    revealBtn.textContent = t('backup_reveal_btn');
    if (!res) {
      errorBox.textContent = t('err_wrong_password_dot');
      errorBox.style.display = '';
      revealBtn.removeAttribute('disabled');
      return;
    }
    const acct = accounts.find((a) => a.id === select.value) ?? activeAccount();
    pwInput.value = '';
    output.replaceChildren(
      el('div', { class: 'card' },
        el('span', { class: 'label' }, t('backup_seed_of', acct.label)),
        el('div', { id: 'backup-phrase', class: 'mnemonic-grid' },
          acct.mnemonic.split(' ').map((w, i) => el('span', {}, el('i', {}, String(i + 1)), w))),
        el('p', { class: 'hint', style: 'text-align:left;margin-top:8px' },
          t('backup_derivation', `${DERIVATION_BASE}/${acct.index}`)),
        el('div', { style: 'margin-top:8px;display:flex;gap:8px' },
          copyButton(() => acct.mnemonic, t('copy_phrase'), t('copied')),
          el('button', {
            id: 'backup-hide-btn', class: 'btn-small', onclick: renderBackup,
          }, t('btn_hide'))))
    );
  }
  revealBtn.addEventListener('click', doReveal);
  pwInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doReveal();
  });

  show(
    el('div', { class: 'back-row' },
      el('button', { class: 'link-btn', onclick: renderSettings }, t('nav_back')),
      el('h2', {}, t('title_backup'))
    ),
    el('div', { class: 'card danger' },
      el('span', { class: 'label danger' }, t('backup_read_before')),
      el('p', { class: 'hint', style: 'text-align:left' },
        t('backup_warning'))
    ),
    el('div', { class: 'card stack' },
      el('div', { class: 'field' }, el('span', { class: 'label' }, t('label_account')), select),
      el('div', { class: 'field' }, el('span', { class: 'label' }, t('label_session_password')), pwInput),
      errorBox,
      revealBtn
    ),
    output
  );
  setTimeout(() => pwInput.focus(), 50);
}

/** Address book management. Reachable from Settings and the Send screen. */
function renderAddressBook({ onBack = renderDashboard, prefillAddress = '' } = {}) {
  const nameInput = el('input', { id: 'ab-name', type: 'text', placeholder: t('ab_name_placeholder'), maxlength: '24' });
  const addrInput = el('input', { id: 'ab-address', type: 'text', placeholder: t('ab_address_placeholder'), value: prefillAddress, spellcheck: 'false' });
  const errorText = el('div', { id: 'ab-error', class: 'error-text', style: 'display:none' });
  const addBtn = el('button', { id: 'ab-add-btn', class: 'btn' }, t('ab_add_entry'));
  const listCard = el('div', { id: 'ab-list', class: 'card' });

  async function refreshList() {
    const book = await getAddressBook();
    const rows = book.map((e, i) =>
      el('div', { class: 'book-row' },
        el('div', { class: 'book-info' },
          el('div', { class: 'book-name' }, e.name),
          el('div', { class: 'book-addr' }, shortAddress(e.address, 18, 8))),
        el('button', {
          id: `ab-del-${i}`,
          class: 'btn-small danger',
          title: t('ab_remove', e.name),
          onclick: async () => {
            await removeBookEntry(e.address);
            refreshList();
          },
        }, '✕'))
    );
    listCard.replaceChildren(
      el('span', { class: 'label' }, t('ab_saved')),
      ...(rows.length ? rows : [el('p', { class: 'hint', style: 'text-align:left' }, t('ab_none'))])
    );
  }

  addBtn.addEventListener('click', async () => {
    errorText.style.display = 'none';
    try {
      await addBookEntry(nameInput.value, addrInput.value);
      nameInput.value = '';
      addrInput.value = '';
      await refreshList();
    } catch (e) {
      errorText.textContent = e instanceof Error ? e.message : String(e);
      errorText.style.display = '';
    }
  });

  show(
    el('div', { class: 'back-row' },
      el('button', { class: 'link-btn', onclick: onBack }, t('nav_back')),
      el('h2', {}, t('title_address_book'))
    ),
    el('div', { class: 'card stack' },
      el('div', { class: 'field' }, el('span', { class: 'label' }, t('label_name')), nameInput),
      el('div', { class: 'field' }, el('span', { class: 'label' }, t('label_address')), addrInput, errorText),
      addBtn
    ),
    listCard
  );
  refreshList();
  if (prefillAddress) setTimeout(() => nameInput.focus(), 50);
}

/** Send KRX: destination (with book/recents picker), amount, fee, broadcast. */
function renderSend() {
  const acct = activeAccount();
  const { address } = state.wallet;

  let availableSompi = null;
  let bookEntries = [];
  let recents = [];
  let busy = false;

  const availLine = el('div', { class: 'balance-meta' }, `${t('label_available')}: …`);
  const destInput = el('input', {
    id: 'dest-input', type: 'text', placeholder: t('send_dest_placeholder'),
    autocomplete: 'off', spellcheck: 'false',
  });
  const destError = el('div', { class: 'error-text', style: 'display:none' }, t('err_invalid_address'));
  const suggest = el('div', { id: 'dest-suggest', class: 'suggest', style: 'display:none' });
  const amountInput = el('input', {
    id: 'amount-input', type: 'text', inputmode: 'decimal', placeholder: '0.001',
    autocomplete: 'off', spellcheck: 'false',
  });
  const feeInput = el('input', {
    id: 'fee-input', type: 'text', inputmode: 'decimal', value: '0.3',
    autocomplete: 'off', spellcheck: 'false',
  });
  const feeError = el('div', { class: 'error-text', style: 'display:none' }, t('err_min_fee'));
  const statusBox = el('div', { id: 'send-status', style: 'display:none' });
  const submit = el('button', { id: 'send-confirm-btn', class: 'btn', disabled: '' }, t('send_submit'));

  const destValid = () => isValidAddress(destInput.value.trim());
  // accept both "0.3" and "0,3"
  const toSompi = (v) => parseKRX((v || '0').trim().replace(',', '.'));
  const feeSompi = () => toSompi(feeInput.value);
  const amountSompi = () => toSompi(amountInput.value);

  function validate() {
    const dest = destInput.value.trim();
    destError.style.display = dest && !destValid() ? '' : 'none';
    feeError.style.display = feeInput.value && !(feeSompi() >= MIN_FEE_SOMPI) ? '' : 'none';
    const ok = !busy && destValid() && amountSompi() > 0 && feeSompi() >= MIN_FEE_SOMPI;
    if (ok) submit.removeAttribute('disabled');
    else submit.setAttribute('disabled', '');
  }

  function renderSuggest() {
    const q = destInput.value.trim().toLowerCase();
    const items = [];
    for (const e of bookEntries) {
      if (!q || e.name.toLowerCase().includes(q) || e.address.startsWith(q)) {
        items.push({ name: e.name, address: e.address, tag: 'book' });
      }
    }
    for (const r of recents) {
      if (bookEntries.some((b) => b.address === r.address)) continue;
      if (!q || r.address.startsWith(q)) items.push({ address: r.address, tag: 'recent' });
    }
    if (!items.length) {
      suggest.style.display = 'none';
      return;
    }
    suggest.replaceChildren(
      ...items.map((it) =>
        el('div', {
          class: 'suggest-item',
          // mousedown fires before the input's blur, so the click always lands
          onmousedown: (ev) => {
            ev.preventDefault();
            destInput.value = it.address;
            suggest.style.display = 'none';
            validate();
          },
        },
        el('span', { class: 'suggest-name' }, it.name ?? shortAddress(it.address, 12, 6)),
        el('span', { class: 'suggest-tag' }, it.tag))
      )
    );
    suggest.style.display = '';
  }

  destInput.addEventListener('focus', renderSuggest);
  destInput.addEventListener('input', () => { renderSuggest(); validate(); });
  destInput.addEventListener('blur', () => setTimeout(() => { suggest.style.display = 'none'; }, 100));
  destInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') suggest.style.display = 'none';
  });
  amountInput.addEventListener('input', validate);
  feeInput.addEventListener('input', validate);

  const maxBtn = el('button', {
    id: 'max-btn', class: 'btn-small', title: t('title_max'),
    onclick: () => {
      if (availableSompi == null) return;
      const max = Math.max(0, availableSompi - feeSompi());
      amountInput.value = formatKRX(max);
      validate();
    },
  }, t('btn_max'));

  function setStatus(kind, ...children) {
    statusBox.className = kind === 'error' ? 'error-box' : 'success-box';
    statusBox.replaceChildren(...children);
    statusBox.style.display = '';
  }

  async function doSend() {
    if (submit.disabled) return;
    const dest = destInput.value.trim();
    const amount = amountSompi();
    const fee = feeSompi();
    busy = true;
    validate();
    statusBox.style.display = 'none';
    try {
      submit.textContent = t('status_loading_utxos');
      const [utxos, info] = await Promise.all([
        api.utxos(address, 2000),
        api.info().catch(() => null),
      ]);
      submit.textContent = t('status_signing');
      const built = buildTransferTx({
        utxos,
        toAddress: dest,
        amountSompi: amount,
        feeSompi: fee,
        changeAddress: address,
        privateKeyHex: state.wallet.privateKeyHex,
        currentDaaScore: info?.last_daa_score ?? 0,
      });
      submit.textContent = t('status_broadcasting');
      const res = await api.broadcast(built.tx);
      await pushRecentAddress(dest);
      recents = await getRecentAddresses();
      const children = [
        el('div', {}, t('send_success', formatKRX(amount), shortAddress(dest, 14, 6))),
        el('div', { class: 'tx-link' }, t('send_tx_label'),
          el('a', { href: `${API_BASE}/tx/${res.transaction_id}`, target: '_blank', rel: 'noreferrer' },
            res.transaction_id)),
      ];
      if (!bookEntries.some((b) => b.address === dest)) {
        children.push(el('button', {
          id: 'save-dest-btn', class: 'btn-small', style: 'margin-top:6px',
          onclick: () => renderAddressBook({ onBack: renderSend, prefillAddress: dest }),
        }, t('send_save_book')));
      }
      setStatus('success', ...children);
      amountInput.value = '';
      setTimeout(loadAvailable, 3000);
    } catch (e) {
      setStatus('error', e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
      submit.textContent = t('send_submit');
      validate();
    }
  }
  submit.addEventListener('click', doSend);

  async function loadAvailable() {
    try {
      const bal = await api.balance(address);
      availableSompi = bal.balance_sompi ?? 0;
      availLine.textContent = `${t('label_available')}: ${formatKRX(availableSompi)} KRX`;
    } catch {
      availLine.textContent = `${t('label_available')}: — (${t('node_unreachable')})`;
    }
  }

  show(
    el('div', { class: 'back-row' },
      el('button', { class: 'link-btn', onclick: renderDashboard }, t('nav_back')),
      el('h2', {}, t('title_send_krx'))
    ),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, t('label_from_account', acct.label)),
      el('div', { class: 'addr', style: 'font-size:10px' }, address),
      availLine
    ),
    el('div', { class: 'card' },
      el('div', { class: 'field rel' },
        el('span', { class: 'label' }, t('label_destination')),
        destInput,
        suggest,
        destError),
      el('div', { style: 'margin-top:8px' },
        el('button', {
          id: 'manage-book-btn', class: 'link-btn',
          onclick: () => renderAddressBook({ onBack: renderSend }),
        }, t('settings_manage_book')))
    ),
    el('div', { class: 'card' },
      el('div', { class: 'send-row' },
        el('div', { class: 'field', style: 'flex:1' },
          el('span', { class: 'label' }, t('label_amount_krx')),
          el('div', { class: 'amount-row' }, amountInput, maxBtn)),
        el('div', { class: 'field', style: 'width:110px' },
          el('span', { class: 'label' }, t('label_fee_krx')),
          feeInput)),
      feeError
    ),
    statusBox,
    submit,
    el('p', { class: 'hint' }, t('send_footer'))
  );

  loadAvailable();
  Promise.all([getAddressBook(), getRecentAddresses()]).then(([b, r]) => {
    bookEntries = b;
    recents = r;
  });
}

function renderLocked() {
  const password = el('input', { id: 'unlock-pw', type: 'password', placeholder: '••••••••' });
  const errorBox = el('div', { class: 'error-box', style: 'display:none' });
  const submit = el('button', { id: 'unlock-btn', class: 'btn' }, t('unlock_submit'));

  async function unlock() {
    if (!password.value || submit.disabled) return;
    submit.setAttribute('disabled', '');
    submit.textContent = t('status_decrypting');
    errorBox.style.display = 'none';
    const res = await unlockVault(password.value);
    if (!res) {
      errorBox.textContent = t('err_wrong_password_dot');
      errorBox.style.display = '';
      submit.removeAttribute('disabled');
      submit.textContent = t('unlock_submit');
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
      el('h1', { class: 'glow', style: 'font-size:16px' }, t('locked_title')),
      el('p', { class: 'subtitle' }, t('locked_subtitle'))
    ),
    el('div', { class: 'card stack' },
      el('div', { class: 'field' }, el('span', { class: 'label' }, t('label_password')), password),
      errorBox,
      submit
    ),
    el('div', { class: 'spacer' }),
    el('button', {
      class: 'link-btn center',
      style: 'opacity:.5;width:100%',
      onclick: async () => {
        if (!window.confirm(t('locked_reset_confirm'))) return;
        await resetWallet();
      },
    }, t('locked_use_different'))
  );
  setTimeout(() => password.focus(), 50);
}

function renderDashboard() {
  const acct = activeAccount();
  const { address } = state.wallet;

  const balanceBody = el('div', { class: 'loading' }, t('common_loading'));
  const netRow = el('div', { class: 'net-row', style: 'display:none' });
  const txCard = el('div', { class: 'card', style: 'display:none' });

  // API reachability indicator, refreshed with every overview poll
  const statusDot = el('span', { id: 'api-status', class: 'status-dot' });
  const statusText = el('span', { id: 'api-status-text' }, t('status_checking'));
  const setStatus = (online) => {
    statusDot.className = `status-dot ${online ? 'online' : 'offline'}`;
    statusText.textContent = online ? t('status_online') : t('status_offline');
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
            t('utxos_count', utxo.count.toLocaleString('en-US')) + (utxo.count >= 80 ? t('consolidation_recommended') : ''))
        );
      }
      setStatus(true);
      balanceBody.replaceChildren(...parts);
      balanceBody.className = '';
      if (info) {
        netRow.replaceChildren(
          el('span', {}, info.network ?? '—'),
          el('span', {}, t('dash_daa', Number(info.last_daa_score ?? 0).toLocaleString('en-US')))
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

  // compact preview: 3 most recent, full list lives on the History screen
  async function loadTxs() {
    try {
      const res = await api.addressTxs(address, 3, 0);
      const txs = res.transactions ?? [];
      const total = res.total_tx_count ?? 0;
      if (total === 0 && txs.length === 0) {
        txCard.style.display = 'none';
        return;
      }
      const children = [
        el('div', { class: 'tx-head' },
          el('span', { class: 'label', style: 'margin:0' }, t('dash_recent_tx')),
          el('span', { class: 'tx-count' }, t('txs_count', total.toLocaleString('en-US')))),
        el('div', { class: 'tx-list' }, txs.map(txRow)),
      ];
      if (total > 3) {
        children.push(el('button', {
          id: 'history-btn', class: 'link-btn', style: 'margin-top:8px',
          onclick: renderHistory,
        }, t('dash_view_all', total.toLocaleString('en-US'))));
      }
      txCard.replaceChildren(...children);
      txCard.style.display = '';
    } catch {
      /* history is best-effort */
    }
  }

  // account switcher with inline rename
  const accountSelect = el('select', { id: 'account-select', class: 'account-select', title: t('title_switch_account') });
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
      el('button', { id: 'rename-btn', class: 'btn-small', title: t('title_rename_account'), onclick: renderEditMode }, '✎'),
      el('button', { id: 'add-account-btn', class: 'btn-small', title: t('title_add_account'), onclick: renderAddAccount }, t('dash_add'))
    );
  };
  function renderEditMode() {
    const nameInput = el('input', { id: 'rename-input', type: 'text', value: acct.label, maxlength: '24', title: t('title_account_name') });
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
      el('button', { id: 'rename-save-btn', class: 'btn-small', title: t('title_save_name'), onclick: save }, '✓'),
      el('button', { id: 'rename-cancel-btn', class: 'btn-small', title: t('title_cancel'), onclick: renderSwitchMode }, '✕')
    );
    nameInput.focus();
    nameInput.select();
  }
  renderSwitchMode();

  const refreshBtn = el('button', { id: 'refresh-btn', class: 'btn-small', title: t('title_refresh'), onclick: () => { loadOverview(); loadTxs(); } }, '↺');

  show(
    el('div', { class: 'topbar' },
      el('div', {},
        el('h2', { class: 'glow' }, t('home_title')),
        el('div', { class: 'status-row' },
          statusDot, statusText,
          el('span', { class: 'status-sep' }, '·'),
          `${DERIVATION_BASE}/${acct.index}`)),
      el('div', { class: 'actions' },
        el('button', {
          id: 'lock-btn',
          class: 'btn-small icon',
          title: t('title_lock'),
          html: LOCK_ICON,
          onclick: async () => { await endSession(); state.wallet = null; renderLocked(); },
        }),
        el('button', { id: 'settings-btn', class: 'btn-small', title: t('title_settings'), onclick: renderSettings }, '⚙'))),
    accountRow,
    el('div', { class: 'card' },
      el('span', { class: 'label' }, t('dash_krx_address', acct.label)),
      el('div', { class: 'addr-row' },
        el('div', { id: 'address', class: 'addr' }, address),
        copyButton(() => address, '⧉', '✓', 'copy-address-btn'),
        refreshBtn)),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, t('label_balance')),
      balanceBody,
      netRow),
    el('div', { class: 'actions-row' },
      el('button', { id: 'send-btn', class: 'btn', onclick: renderSend }, t('dash_send')),
      el('button', { id: 'inference-btn', class: 'btn ghost', onclick: renderInference }, t('dash_inference'))),
    txCard,
    el('p', { class: 'hint', style: 'margin-top:2px' },
      t('dash_consolidate'))
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
  await Promise.all([loadApiBase(), loadLocale()]); // resolve API host + UI language before rendering
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
