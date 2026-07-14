// Approval window — opened by the background router for dApp provider requests
// (connect / send / sign-message / sign-tx / inference). Shows the requesting
// origin and the full consequences, asks for the session password when the
// wallet is locked, performs the crypto locally on approve, and reports the
// outcome back to the background, which forwards it to the requesting tab.
//
// Closing the window without answering counts as a rejection (the background
// watches chrome.windows.onRemoved).

import {
  deriveWallet,
  formatKRX,
  isValidAddress,
  shortAddress,
  encodeAddress,
  hexToBytes,
} from '../lib/keryx.js';
import {
  buildTransferTx,
  buildInferenceTx,
  buildInferencePayload,
  signTxJson,
  signPersonalMessage,
  MIN_FEE_SOMPI,
  SIGHASH_ALL,
} from '../lib/tx.js';
import { getModel, inferenceRewardSompi } from '../lib/models.js';
import { api } from '../lib/api.js';
import { unlockVault } from '../lib/vault.js';
import { getSession, startSession, touchSession } from '../lib/session.js';
import { getPendingRequest, getConnection, setConnection } from '../lib/provider.js';
import { t, loadLocale } from '../lib/i18n.js';

const app = document.getElementById('app');
const reqId = new URLSearchParams(location.search).get('id');

// Localized action label for a request type (shown in the header / unlock screen).
const ACTION_KEY = {
  connect: 'btn_connect',
  send: 'approval_send_action',
  'sign-message': 'approval_signmsg_action',
  'sign-tx': 'approval_signtx_action',
  inference: 'approval_inference_action',
};
const actionLabel = (type) => t(ACTION_KEY[type] ?? 'approval_action');

let req = null;
let session = null; // { store, rawKeyHex }
let responded = false;

// --- tiny DOM helper (same contract as the popup's) ---------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (!child && child !== 0) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

const show = (...nodes) => app.replaceChildren(...nodes.filter(Boolean));
const row = (k, v) => el('div', { class: 'settings-row' }, el('span', {}, k), el('span', {}, v));

async function sendResult(result, error) {
  if (responded) return;
  responded = true;
  try {
    await chrome.runtime.sendMessage({ type: 'krx-approval-result', id: reqId, result, error });
  } catch {}
  window.close();
}

function header(action) {
  return el('div', { class: 'card' },
    el('span', { class: 'label' }, t('approval_request_from')),
    el('div', { id: 'approval-origin', class: 'addr', style: 'font-size:13px' }, req.origin),
    row(t('approval_action'), el('span', { id: 'approval-action' }, action))
  );
}

function statusBox() {
  return el('div', { id: 'approval-status', style: 'display:none' });
}

function setStatus(box, kind, text) {
  box.className = kind === 'error' ? 'error-box' : 'success-box';
  box.textContent = text;
  box.style.display = '';
}

/**
 * Approve/Reject row. `onApprove` runs with both buttons disabled and may
 * report progress via the returned setBusyText; a throw re-enables the UI.
 */
function actions(onApprove, approveLabel = t('btn_approve')) {
  const approve = el('button', { id: 'approve-btn', class: 'btn' }, approveLabel);
  const reject = el('button', { id: 'reject-btn', class: 'btn ghost' }, t('btn_reject'));
  reject.addEventListener('click', () => sendResult(undefined, 'User rejected the request'));
  approve.addEventListener('click', async () => {
    approve.setAttribute('disabled', '');
    reject.setAttribute('disabled', '');
    await touchSession();
    try {
      await onApprove((text) => (approve.textContent = text));
    } catch {
      // the screen handler has already surfaced the error in its status box
      approve.removeAttribute('disabled');
      reject.removeAttribute('disabled');
      approve.textContent = approveLabel;
    }
  });
  return el('div', { class: 'actions-row', style: 'margin-top:12px' }, approve, reject);
}

/** Invalid/unserviceable request: show why, only exit is to dismiss with the error. */
function renderInvalid(message) {
  const close = el('button', { id: 'reject-btn', class: 'btn ghost' }, t('btn_close'));
  close.addEventListener('click', () => sendResult(undefined, `Invalid request: ${message}`));
  show(
    header(req?.type ?? 'unknown'),
    el('div', { class: 'error-box', style: 'margin-top:12px' }, message),
    el('div', { class: 'actions-row', style: 'margin-top:12px' }, close)
  );
}

// --- account resolution --------------------------------------------------------

async function signingContext() {
  const conn = await getConnection(req.origin);
  const acct = conn && session.store.accounts.find((a) => a.id === conn.accountId);
  if (!acct) throw new Error('The account connected to this site no longer exists — reconnect first');
  return { acct, wallet: deriveWallet(acct.mnemonic, acct.index) };
}

// --- screens ---------------------------------------------------------------------

function renderUnlock() {
  const pw = el('input', { id: 'unlock-password', type: 'password', placeholder: t('approval_session_password_ph'), autocomplete: 'off' });
  const err = el('div', { class: 'error-box', style: 'display:none' });
  const btn = el('button', { id: 'unlock-btn', class: 'btn' }, t('btn_unlock'));
  const reject = el('button', { id: 'reject-btn', class: 'btn ghost' }, t('btn_reject'));
  reject.addEventListener('click', () => sendResult(undefined, 'User rejected the request'));

  async function doUnlock() {
    btn.setAttribute('disabled', '');
    btn.textContent = t('status_unlocking');
    err.style.display = 'none';
    const res = await unlockVault(pw.value);
    if (!res) {
      btn.removeAttribute('disabled');
      btn.textContent = t('btn_unlock');
      err.textContent = t('err_wrong_password');
      err.style.display = '';
      return;
    }
    await startSession(res.store, res.rawKeyHex);
    session = res;
    renderRequest();
  }
  btn.addEventListener('click', doUnlock);
  pw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doUnlock();
  });

  show(
    header(actionLabel(req.type)),
    el('div', { class: 'card stack', style: 'margin-top:12px' },
      el('span', { class: 'label' }, t('approval_wallet_locked')),
      el('p', { class: 'hint', style: 'text-align:left' },
        t('approval_unlock_hint')),
      pw,
      err
    ),
    el('div', { class: 'actions-row', style: 'margin-top:12px' }, btn, reject)
  );
  pw.focus();
}

function renderConnect() {
  const select = el('select', { id: 'connect-account-select', class: 'account-select' });
  for (const a of session.store.accounts) {
    select.append(el('option', { value: a.id }, `${a.label} — ${shortAddress(deriveWallet(a.mnemonic, a.index).address)}`));
  }
  const status = statusBox();

  show(
    header(t('btn_connect')),
    el('div', { class: 'card stack', style: 'margin-top:12px' },
      el('span', { class: 'label' }, t('approval_connect_share_label')),
      el('p', { class: 'hint', style: 'text-align:left' },
        t('approval_connect_hint')),
      select
    ),
    status,
    actions(async () => {
      const acct = session.store.accounts.find((a) => a.id === select.value);
      const wallet = deriveWallet(acct.mnemonic, acct.index);
      await setConnection(req.origin, {
        accountId: acct.id,
        address: wallet.address,
        // x-only key (drop the parity byte) — what scripts/HTLCs are built from
        publicKeyHex: wallet.publicKeyHex.slice(2),
      });
      await sendResult([wallet.address]);
    }, t('btn_connect'))
  );
}

function renderSend() {
  const { toAddress, sompi, options } = req.params ?? {};
  if (!isValidAddress(toAddress ?? '')) return renderInvalid('Invalid destination address');
  if (!Number.isSafeInteger(sompi) || sompi <= 0) return renderInvalid('Invalid amount (sompi)');
  const feeRaw = options?.feeSompi ?? MIN_FEE_SOMPI;
  if (!Number.isSafeInteger(feeRaw) || feeRaw < 0) return renderInvalid('Invalid fee (sompi)');
  const fee = Math.max(MIN_FEE_SOMPI, feeRaw);

  const fromLine = el('span', {}, '…');
  const status = statusBox();

  show(
    header(t('approval_send_action')),
    el('div', { class: 'card stack', style: 'margin-top:12px' },
      el('span', { class: 'label' }, t('approval_transfer')),
      row(t('label_from'), fromLine),
      row(t('label_to'), shortAddress(toAddress)),
      row(t('label_amount'), `${formatKRX(sompi)} KRX`),
      row(t('label_fee'), `${formatKRX(fee)} KRX`),
      row(t('label_total'), `${formatKRX(sompi + fee)} KRX`)
    ),
    status,
    actions(async (busy) => {
      try {
        const { wallet } = await signingContext();
        busy(t('status_loading_utxos'));
        const [utxos, info] = await Promise.all([api.utxos(wallet.address, 400), api.info().catch(() => null)]);
        busy(t('status_signing'));
        const built = buildTransferTx({
          utxos,
          toAddress,
          amountSompi: sompi,
          feeSompi: fee,
          changeAddress: wallet.address,
          privateKeyHex: wallet.privateKeyHex,
          currentDaaScore: info?.last_daa_score ?? 0,
        });
        busy(t('status_broadcasting'));
        const res = await api.broadcast(built.tx);
        await sendResult(res.transaction_id);
      } catch (e) {
        setStatus(status, 'error', e instanceof Error ? e.message : String(e));
        throw e;
      }
    })
  );

  signingContext()
    .then(({ acct, wallet }) => (fromLine.textContent = `${acct.label} (${shortAddress(wallet.address)})`))
    .catch((e) => setStatus(status, 'error', e.message));
}

function renderSignMessage() {
  const { message } = req.params ?? {};
  if (typeof message !== 'string' || message.length === 0) return renderInvalid('Missing message');
  if (message.length > 10000) return renderInvalid('Message too long (max 10,000 chars)');
  const status = statusBox();

  show(
    header(t('approval_signmsg_action')),
    el('div', { class: 'card stack', style: 'margin-top:12px' },
      el('span', { class: 'label' }, t('approval_message')),
      el('pre', { id: 'sign-message-text', class: 'approval-pre' }, message),
      el('p', { class: 'hint', style: 'text-align:left' },
        t('approval_signmsg_hint'))
    ),
    status,
    actions(async () => {
      try {
        const { wallet } = await signingContext();
        await sendResult(signPersonalMessage(message, wallet.privateKeyHex));
      } catch (e) {
        setStatus(status, 'error', e instanceof Error ? e.message : String(e));
        throw e;
      }
    }, t('btn_sign'))
  );
}

function decodeOutputScript(spk) {
  const p2pk = /^20([0-9a-f]{64})ac$/.exec(spk ?? '');
  if (p2pk) return shortAddress(encodeAddress(0, hexToBytes(p2pk[1])));
  if (/^aa20[0-9a-f]{64}87$/.test(spk ?? '')) return t('script_p2sh');
  return t('script_custom');
}

function renderSignTx() {
  const { tx, options } = req.params ?? {};
  if (!tx || !Array.isArray(tx.inputs) || tx.inputs.length === 0 || !Array.isArray(tx.outputs) || tx.outputs.length === 0) {
    return renderInvalid('Malformed transaction: inputs and outputs are required');
  }
  const broadcast = options?.broadcast === true;

  const haveAllUtxos = tx.inputs.every((i) => Number.isSafeInteger(i?.utxo?.amount_sompi));
  const totalIn = haveAllUtxos ? tx.inputs.reduce((n, i) => n + i.utxo.amount_sompi, 0) : null;
  const outsOk = tx.outputs.every((o) => Number.isSafeInteger(o?.amount) && o.amount >= 0);
  if (!outsOk) return renderInvalid('Malformed transaction: invalid output amounts');
  const totalOut = tx.outputs.reduce((n, o) => n + o.amount, 0);

  const sighashTypes = [...new Set(tx.inputs.map((i) => i.sighash_type ?? SIGHASH_ALL))];
  const hasCustomScript = tx.inputs.some((i) => i.redeem_script || i.sig_script_prefix || i.sig_script_suffix);

  const outputRows = tx.outputs.map((o, i) =>
    row(t('approval_output_arrow', i, decodeOutputScript(o.script_public_key)), `${formatKRX(o.amount)} KRX`));

  const status = statusBox();
  show(
    header(t('approval_signtx_action')),
    el('div', { class: 'card stack', style: 'margin-top:12px' },
      el('span', { class: 'label' }, t('approval_summary')),
      row(t('label_inputs'), `${tx.inputs.length}${totalIn !== null ? ` — ${formatKRX(totalIn)} KRX` : ''}`),
      outputRows,
      row(t('label_fee'), totalIn !== null ? `${formatKRX(totalIn - totalOut)} KRX` : t('approval_fee_unknown')),
      Number(tx.lock_time ?? 0) > 0 ? row(t('approval_locktime'), String(tx.lock_time)) : null,
      sighashTypes.some((ty) => ty !== SIGHASH_ALL)
        ? row(t('approval_sighash_types'), sighashTypes.map((ty) => `0x${ty.toString(16).padStart(2, '0')}`).join(', '))
        : null
    ),
    hasCustomScript
      ? el('div', { id: 'sign-tx-script-warning', class: 'warn-box', style: 'margin-top:12px' },
          t('approval_custom_script_warn'))
      : null,
    el('div', { class: broadcast ? 'warn-box' : 'hint', id: 'sign-tx-broadcast-note', style: 'margin-top:12px;text-align:left' },
      broadcast
        ? t('approval_broadcast_yes')
        : t('approval_broadcast_no')),
    el('details', { class: 'raw-tx', style: 'margin-top:12px' },
      el('summary', {}, t('approval_raw_tx')),
      el('pre', { id: 'sign-tx-raw', class: 'approval-pre' }, JSON.stringify(tx, null, 2))),
    status,
    actions(async (busyText) => {
      try {
        const { wallet } = await signingContext();
        busyText(t('status_signing'));
        const signed = signTxJson(tx, wallet.privateKeyHex);
        if (broadcast) {
          busyText(t('status_broadcasting'));
          const res = await api.broadcast(signed.tx);
          await sendResult({ tx: signed.tx, transaction_id: res.transaction_id });
        } else {
          await sendResult({ tx: signed.tx });
        }
      } catch (e) {
        setStatus(status, 'error', e instanceof Error ? e.message : String(e));
        throw e;
      }
    }, t('btn_sign'))
  );
}

function renderInference() {
  const { model: modelKey, prompt, maxTokens: tokensRaw, priorityFeeSompi } = req.params ?? {};
  const model = getModel(modelKey);
  if (!model) return renderInvalid(`Unknown model: ${modelKey}`);
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return renderInvalid('Missing prompt');
  if (prompt.length > 8192) return renderInvalid('Prompt too long (max 8,192 chars)');
  const maxTokens = tokensRaw ?? 256;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) {
    return renderInvalid('maxTokens must be an integer between 1 and 4096');
  }
  const feeRaw = priorityFeeSompi ?? MIN_FEE_SOMPI;
  if (!Number.isSafeInteger(feeRaw) || feeRaw < 0) return renderInvalid('Invalid priorityFeeSompi');
  const fee = Math.max(MIN_FEE_SOMPI, feeRaw);
  const reward = inferenceRewardSompi(modelKey, maxTokens);

  const status = statusBox();
  show(
    header(t('approval_inference_action')),
    el('div', { class: 'card stack', style: 'margin-top:12px' },
      el('span', { class: 'label' }, t('approval_query')),
      el('pre', { id: 'inference-prompt', class: 'approval-pre' }, prompt),
      row(t('label_model'), model.name),
      row(t('approval_max_tokens'), String(maxTokens)),
      row(t('approval_reward_escrow'), `${formatKRX(reward)} KRX`),
      row(t('label_fee'), `${formatKRX(fee)} KRX`),
      row(t('label_total'), `${formatKRX(reward + fee)} KRX`)
    ),
    status,
    actions(async (busy) => {
      try {
        const { wallet } = await signingContext();
        busy(t('status_loading_utxos'));
        const capabilities = await api.capabilities().catch(() => null);
        const cap = capabilities?.find((c) => c.model === modelKey);
        if (capabilities && (cap?.miner_count ?? 0) === 0) {
          throw new Error(`No active miners for ${model.name} — the request would stay pending, fees lost`);
        }
        const [utxos, info] = await Promise.all([api.utxos(wallet.address, 400), api.info().catch(() => null)]);
        busy(t('status_signing'));
        const payloadHex = buildInferencePayload(prompt.trim(), model.idHex, maxTokens, reward, fee);
        const minerPubkey = cap?.miner_pubkeys?.[0];
        const built = buildInferenceTx({
          utxos,
          changeAddress: wallet.address,
          feeSompi: fee,
          privateKeyHex: wallet.privateKeyHex,
          currentDaaScore: info?.last_daa_score ?? 0,
          payloadHex,
          escrow: minerPubkey ? { pubkeyHex: minerPubkey, amountSompi: reward } : undefined,
        });
        busy(t('status_broadcasting'));
        const res = await api.broadcast(built.tx);
        await sendResult(res.transaction_id);
      } catch (e) {
        setStatus(status, 'error', e instanceof Error ? e.message : String(e));
        throw e;
      }
    }, t('btn_approve_submit'))
  );
}

function renderRequest() {
  switch (req.type) {
    case 'connect': return renderConnect();
    case 'send': return renderSend();
    case 'sign-message': return renderSignMessage();
    case 'sign-tx': return renderSignTx();
    case 'inference': return renderInference();
    default: return renderInvalid(`Unsupported request type: ${req.type}`);
  }
}

async function init() {
  await loadLocale();
  req = reqId ? await getPendingRequest(reqId) : null;
  if (!req) {
    const close = el('button', { class: 'btn ghost' }, t('btn_close'));
    close.addEventListener('click', () => window.close());
    show(
      el('div', { class: 'card stack' },
        el('span', { class: 'label' }, t('approval_expired_title')),
        el('p', { class: 'hint', style: 'text-align:left' }, t('approval_expired_body'))),
      el('div', { class: 'actions-row', style: 'margin-top:12px' }, close)
    );
    return;
  }
  session = await getSession();
  if (!session) return renderUnlock();
  renderRequest();
}

init();
