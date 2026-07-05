// Keryx Wallet popup — screens: home / create / import / locked / dashboard.

import {
  generateMnemonic,
  validateMnemonic,
  deriveWallet,
  formatKRX,
  DERIVATION_BASE,
} from '../lib/keryx.js';
import { api, API_BASE } from '../lib/api.js';
import { saveVault, unlockVault, vaultExists, clearVault } from '../lib/vault.js';
import { startSession, getSessionMnemonic, touchSession, endSession } from '../lib/session.js';

const app = document.getElementById('app');

const state = {
  wallet: null, // { address, privateKeyHex, publicKeyHex }
  refreshTimer: null,
};

// --- tiny DOM helper ---------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v; // static templates only
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
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

const LOGO_SVG =
  '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--mx-bright)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="filter: drop-shadow(0 0 8px rgba(46,227,88,.45))"><path d="M8 3v18"></path><path d="M8 12h3"></path><path d="M11 12 17 4h3l-6 8 6 8h-3l-6-8"></path><circle cx="8" cy="3" r="1.1" fill="var(--mx-bright)"></circle><circle cx="8" cy="21" r="1.1" fill="var(--mx-bright)"></circle><circle cx="20" cy="4" r="1.1" fill="var(--mx-bright)"></circle><circle cx="20" cy="20" r="1.1" fill="var(--mx-bright)"></circle></svg>';

function copyButton(getText, label = 'copy') {
  const btn = el('button', { class: 'btn-small' }, label);
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(getText()).catch(() => {});
    btn.textContent = '✓ copied';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove('copied');
    }, 2000);
  });
  return btn;
}

function passwordFields() {
  const password = el('input', { type: 'password', placeholder: '••••••••' });
  const confirm = el('input', { type: 'password', placeholder: '••••••••' });
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
      el('button', { class: 'btn', onclick: renderCreate }, '⊕ Create a new wallet'),
      el('button', { class: 'btn ghost', onclick: renderImport }, '↩ Import with mnemonic phrase')
    ),
    el('div', { class: 'spacer' }),
    el('p', { class: 'hint' }, 'Private keys stay in your browser — they never leave your machine.')
  );
}

function renderCreate() {
  const mnemonic = generateMnemonic();
  const words = mnemonic.split(' ');
  let derived = null;
  try {
    derived = deriveWallet(mnemonic);
  } catch {}

  const pw = passwordFields();
  const errorBox = el('div', { class: 'error-box', style: 'display:none' });
  const submit = el('button', { class: 'btn', disabled: '' }, 'Open wallet →');
  const pwCard = el('div', { class: 'card', style: 'display:none' },
    el('p', { class: 'subtitle', style: 'text-align:left;margin:0 0 12px' },
      "Set a password to protect your wallet in this browser. You'll use it instead of the mnemonic next time."),
    pw.block,
    errorBox,
    el('div', { style: 'margin-top:12px' }, submit)
  );

  const checkbox = el('input', { type: 'checkbox' });
  const refresh = () => {
    pwCard.style.display = checkbox.checked ? '' : 'none';
    if (checkbox.checked && pw.valid()) submit.removeAttribute('disabled');
    else submit.setAttribute('disabled', '');
  };
  checkbox.addEventListener('change', refresh);
  pw.inputs.forEach((i) => i.addEventListener('input', refresh));

  submit.addEventListener('click', async () => {
    if (!checkbox.checked || !pw.valid()) return;
    submit.setAttribute('disabled', '');
    submit.textContent = 'Encrypting…';
    errorBox.style.display = 'none';
    try {
      await saveVault(mnemonic, pw.value());
      await startSession(mnemonic);
      state.wallet = derived ?? deriveWallet(mnemonic);
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
      el('button', { class: 'link-btn', onclick: renderHome }, '← Back'),
      el('h2', {}, 'New wallet')
    ),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, 'Mnemonic phrase (24 words) — save it in a safe place'),
      el('div', { class: 'mnemonic-grid' },
        words.map((w, i) => el('span', {}, el('i', {}, String(i + 1)), w))
      ),
      el('div', { style: 'margin-top:10px' }, copyButton(() => mnemonic, 'Copy phrase'))
    ),
    derived &&
      el('div', { class: 'card' },
        el('span', { class: 'label' }, 'Generated address'),
        el('div', { class: 'addr' }, derived.address)
      ),
    el('div', { class: 'card' },
      el('label', { class: 'checkbox-row' }, checkbox,
        el('span', {}, 'I have saved my mnemonic phrase. I understand that without it, I cannot recover my funds.'))
    ),
    pwCard
  );
}

function renderImport() {
  const textarea = el('textarea', { rows: '3', placeholder: 'word1 word2 word3 …' });
  const invalid = el('div', { class: 'error-text', style: 'display:none' },
    'Invalid mnemonic — check spelling and word count.');
  const pw = passwordFields();
  const errorBox = el('div', { class: 'error-box', style: 'display:none' });
  const submit = el('button', { class: 'btn', disabled: '' }, 'Open wallet →');
  const pwCard = el('div', { class: 'card', style: 'display:none' },
    pw.block,
    errorBox,
    el('div', { style: 'margin-top:12px' }, submit)
  );

  const normalized = () => textarea.value.trim().toLowerCase().replace(/\s+/g, ' ');
  const refresh = () => {
    const ok = normalized() && validateMnemonic(normalized());
    invalid.style.display = textarea.value.trim() && !ok ? '' : 'none';
    pwCard.style.display = ok ? '' : 'none';
    if (ok && pw.valid()) submit.removeAttribute('disabled');
    else submit.setAttribute('disabled', '');
  };
  textarea.addEventListener('input', refresh);
  pw.inputs.forEach((i) => i.addEventListener('input', refresh));

  submit.addEventListener('click', async () => {
    const mnemonic = normalized();
    if (!validateMnemonic(mnemonic) || !pw.valid()) return;
    submit.setAttribute('disabled', '');
    submit.textContent = 'Deriving keys…';
    errorBox.style.display = 'none';
    try {
      state.wallet = deriveWallet(mnemonic);
      await saveVault(mnemonic, pw.value());
      await startSession(mnemonic);
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
      el('button', { class: 'link-btn', onclick: renderHome }, '← Back'),
      el('h2', {}, 'Import wallet')
    ),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, 'Mnemonic phrase (12 or 24 words)'),
      textarea,
      invalid
    ),
    pwCard,
    el('div', { class: 'spacer' }),
    el('p', { class: 'hint' },
      'Password is never stored. To remove your wallet, click "Disconnect" or clear extension data.')
  );
}

function renderLocked() {
  const password = el('input', { type: 'password', placeholder: '••••••••' });
  const errorBox = el('div', { class: 'error-box', style: 'display:none' });
  const submit = el('button', { class: 'btn' }, 'Unlock →');

  async function unlock() {
    if (!password.value || submit.disabled) return;
    submit.setAttribute('disabled', '');
    submit.textContent = 'Decrypting…';
    errorBox.style.display = 'none';
    const mnemonic = await unlockVault(password.value);
    if (!mnemonic) {
      errorBox.textContent = 'Wrong password.';
      errorBox.style.display = '';
      submit.removeAttribute('disabled');
      submit.textContent = 'Unlock →';
      return;
    }
    await startSession(mnemonic);
    state.wallet = deriveWallet(mnemonic);
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
        if (!window.confirm('Remove the stored wallet from this browser? Make sure you have your mnemonic phrase backed up.')) return;
        await clearVault();
        await endSession();
        state.wallet = null;
        renderHome();
      },
    }, 'Use a different wallet (clear session)')
  );
  setTimeout(() => password.focus(), 50);
}

function renderDashboard() {
  const { address } = state.wallet;

  const balanceBody = el('div', { class: 'loading' }, 'Loading…');
  const netRow = el('div', { class: 'net-row', style: 'display:none' });
  const txCard = el('div', { class: 'card', style: 'display:none' });

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

  const refreshBtn = el('button', { class: 'btn-small', title: 'Refresh', onclick: () => { loadOverview(); loadTxs(); } }, '↺');

  show(
    el('div', { class: 'topbar' },
      el('div', {},
        el('h2', { class: 'glow' }, 'KERYX WALLET'),
        el('div', { class: 'hint', style: 'text-align:left;margin-top:2px' }, `Derivation path: ${DERIVATION_BASE}/0`)),
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn-small',
          title: 'Lock wallet (keeps encrypted vault)',
          onclick: async () => { await endSession(); state.wallet = null; renderLocked(); },
        }, 'Lock'),
        el('button', {
          class: 'btn-small danger',
          title: 'Remove wallet from this browser',
          onclick: async () => {
            if (!window.confirm('Disconnect and remove the stored wallet from this browser? Make sure your mnemonic phrase is backed up.')) return;
            await clearVault();
            await endSession();
            state.wallet = null;
            renderHome();
          },
        }, 'Disconnect'))),
    el('div', { class: 'card' },
      el('span', { class: 'label' }, 'Your KRX address'),
      el('div', { class: 'addr-row' },
        el('div', { class: 'addr' }, address),
        copyButton(() => address),
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
  const mnemonic = await getSessionMnemonic();
  if (mnemonic) {
    try {
      state.wallet = deriveWallet(mnemonic);
      renderDashboard();
      return;
    } catch {
      await endSession();
    }
  }
  renderLocked();
})();
