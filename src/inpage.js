// window.keryx — the injected Keryx provider (MetaMask/KasWare pattern).
//
// Runs in the page's MAIN world at document_start. It is pure messaging: every
// call is relayed to the extension via window.postMessage -> content script ->
// background service worker. NO key material, signing logic or chrome.* API
// ever exists in this context.
//
// dApp usage:
//   const [address] = await window.keryx.requestAccounts();
//   const txid = await window.keryx.sendKrx('keryx:qq…', 150000000);
//   const { tx } = await window.keryx.signTx({ inputs: […], outputs: […] });
//   window.keryx.on('accountsChanged', (accounts) => …);

(() => {
  if (window.keryx) return; // don't clobber an already-injected provider

  const pending = new Map(); // id -> { resolve, reject }
  let counter = 0;

  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = `krx-${++counter}-${Math.random().toString(36).slice(2)}`;
      pending.set(id, { resolve, reject });
      window.postMessage({ target: 'krx-content', id, method, params }, window.location.origin);
    });
  }

  const listeners = new Map(); // event -> Set<cb>

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.target !== 'krx-inpage') return;
    const { id, event, data, result, error } = ev.data;
    if (event) {
      for (const cb of listeners.get(event) ?? []) {
        try {
          cb(data);
        } catch {}
      }
      return;
    }
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  });

  const keryx = {
    isKeryx: true,
    providerApiVersion: 1,

    /** Connect: opens an approval window on first use. @returns {Promise<string[]>} [address] */
    requestAccounts: () => request('krx_requestAccounts'),
    /** Connected accounts, [] when this site is not connected (never prompts). */
    getAccounts: () => request('krx_getAccounts'),
    /** 32-byte x-only public key (hex) of the connected account — for building scripts/HTLCs. */
    getPublicKey: () => request('krx_getPublicKey'),
    /** @returns {Promise<{address: string, balance_sompi: number}>} */
    getBalance: () => request('krx_getBalance'),
    /** Spendable UTXO entries of the connected account (for building custom transactions). */
    getUtxos: () => request('krx_getUtxos'),
    getNetwork: () => request('krx_getNetwork'),
    getVersion: () => request('krx_getVersion'),

    /**
     * Transfer KRX. Opens an approval window.
     * @param {string} toAddress  keryx: address
     * @param {number} sompi      amount in sompi (1 KRX = 1e8)
     * @param {{feeSompi?: number}} [options]
     * @returns {Promise<string>} transaction id
     */
    sendKrx: (toAddress, sompi, options) => request('krx_sendKrx', { toAddress, sompi, options }),

    /**
     * BIP340-sign a personal message (keyed blake2b-256 "PersonalMessageSigningHash").
     * @returns {Promise<string>} 64-byte Schnorr signature, hex
     */
    signMessage: (message) => request('krx_signMessage', { message }),

    /**
     * Sign an arbitrary transaction (wire-JSON shape) with per-input directives —
     * supports P2SH/custom-script spends such as HTLC claim & refund:
     *   input.utxo              on-chain outpoint data { amount_sompi, script_public_key }
     *   input.sighash_type      default 0x01 (ALL); NONE/SINGLE/…|ANYONECANPAY accepted
     *   input.redeem_script     hex, appended as the final push of signature_script
     *   input.sig_script_suffix hex placed between the signature push and the redeem
     *                           push (e.g. preimage push + OP_TRUE for an HTLC claim)
     *   input.sig_script_prefix hex placed before the signature push
     *   input.signature_script  verbatim hex — input is passed through unsigned
     * @param {object} tx
     * @param {{broadcast?: boolean}} [options] broadcast after signing (default false)
     * @returns {Promise<{tx: object, transaction_id?: string}>}
     */
    signTx: (tx, options) => request('krx_signTx', { tx, options }),

    /** Broadcast an already-signed transaction. @returns {Promise<string>} transaction id */
    broadcastTx: (tx) => request('krx_broadcastTx', { tx }),

    /**
     * Submit an AI inference request (AiRequest transaction with miner escrow).
     * @param {{model: string, prompt: string, maxTokens?: number, priorityFeeSompi?: number}} opts
     * @returns {Promise<string>} transaction id
     */
    submitInference: (opts) => request('krx_submitInference', opts),

    /** Revoke this site's connection. */
    disconnect: () => request('krx_disconnect'),

    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
      return keryx;
    },
    removeListener(event, cb) {
      listeners.get(event)?.delete(cb);
      return keryx;
    },
  };

  Object.defineProperty(window, 'keryx', {
    value: Object.freeze(keryx),
    writable: false,
    configurable: false,
  });
  window.dispatchEvent(new Event('keryx#initialized'));
})();
