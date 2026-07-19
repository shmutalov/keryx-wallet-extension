# `window.keryx` — dApp provider API

Keryx Wallet injects a provider into every `http(s)` page (MetaMask/KasWare
pattern). It is pure messaging: the page never sees keys, and every operation
that signs or spends opens a wallet-controlled approval window showing the
requesting origin and the full consequences.

```js
if (window.keryx?.isKeryx) {
  const [address] = await window.keryx.requestAccounts();
}
// injected at document_start; if you race it, wait for the event:
window.addEventListener('keryx#initialized', onProviderReady);
```

All amounts are integers in **sompi** (1 KRX = 100,000,000 sompi). All calls
return promises; a user rejection rejects with `Error('User rejected the request')`.

## Connection

| method | returns | notes |
|---|---|---|
| `requestAccounts()` | `Promise<string[]>` | Opens the connect approval on first use; afterwards resolves immediately. `[address]` of the account the user chose. |
| `getAccounts()` | `Promise<string[]>` | `[]` when not connected. Never prompts. |
| `getPublicKey()` | `Promise<string>` | 32-byte **x-only** public key (hex) of the connected account — what P2PK scripts and HTLC redeem scripts are built from. |
| `getBalance()` | `Promise<{address, balance_sompi}>` | |
| `getUtxos()` | `Promise<UtxoEntry[]>` | `{ transaction_id, index, amount_sompi, script_version, script_public_key, block_daa_score, is_coinbase }` |
| `getNetwork()` | `Promise<string>` | Network reported by the API host in use — `"keryx-mainnet"` on the default host, `"keryx-simnet"` etc. against a custom one (Settings → Network). Read live from the node, never assumed: **rejects** if the host is unreachable or reports no network rather than falling back to a default, since a confidently wrong network is worse than an error. Check it before acting on funds. |
| `getVersion()` | `Promise<string>` | extension version |
| `disconnect()` | `Promise<true>` | revokes this origin's grant |

Events (also emitted when the user disconnects the site from wallet Settings):

```js
window.keryx.on('accountsChanged', (accounts) => { /* [] on disconnect */ });
window.keryx.on('disconnect', () => {});
```

## Transfers & messages

```js
const txid = await window.keryx.sendKrx(toAddress, amountSompi, { feeSompi }); // fee ≥ 0.3 KRX enforced
const sigHex = await window.keryx.signMessage('login nonce 42');
```

`signMessage` signs the keyed blake2b-256 digest
(`key = "PersonalMessageSigningHash"`) of the UTF-8 message with BIP340
Schnorr and resolves with the 64-byte signature as hex. Verify against the
x-only key from `getPublicKey()`.

## AI inference

```js
const txid = await window.keryx.submitInference({
  model: 'glm-4-9b-0414',     // registry key
  prompt: 'What is Keryx?',
  maxTokens: 256,             // 1..4096, reward surcharge per 64
  priorityFeeSompi: 30000000, // optional, floored at 0.3 KRX
});
```

The wallet computes the escrowed reward (model base + token surcharge), builds
the AiRequest transaction and shows the full cost in the approval window.

## `signTx` — arbitrary transactions, HTLC claim & refund

For anything the high-level methods don't cover — P2SH spends, custom
scripts, HTLCs — build the transaction yourself (use `getUtxos()` /
`getPublicKey()`) and ask the wallet to sign specific inputs:

```js
const { tx, transaction_id } = await window.keryx.signTx(txJson, { broadcast: true });
```

`txJson` is the node's wire JSON (`version?`, `inputs`, `outputs`,
`lock_time?`, `subnetwork_id?`, `gas?`, `payload?` hex) with per-input signing
directives:

| field | meaning |
|---|---|
| `utxo` | `{ amount_sompi, script_public_key, script_version? }` of the outpoint being spent — **required** to sign the input (it is committed by the sighash) |
| `sighash_type` | default `0x01` (ALL); `0x02` NONE, `0x04` SINGLE, each optionally `| 0x80` ANYONECANPAY |
| `redeem_script` | hex; appended as the **final push** of `signature_script` (P2SH / script-path spend) |
| `sig_script_suffix` | hex placed between the signature push and the redeem push |
| `sig_script_prefix` | hex placed before the signature push |
| `signature_script` | verbatim hex — the input is passed through untouched (signed by another party) |
| `sequence` | default u64-max; set below max to make `lock_time`/CLTV enforceable |

The wallet assembles each signed input as:

```
[prefix] || 0x41 <64-byte BIP340 sig || sighash_type> || [suffix] || push(redeem_script)
```

With `{ broadcast: false }` (the default) the signed transaction is returned
to the page and **not** broadcast; submit it later with `broadcastTx(tx)`.

### HTLC example

With a redeem script of the usual shape
`OP_IF <hashlock branch: hash check + claimer key> OP_ELSE <locktime> OP_CHECKLOCKTIMEVERIFY <refunder key> OP_ENDIF … OP_CHECKSIG`:

> ⚠ **Two Bitcoin habits break here.**
> 1. **Opcode bytes differ**: on Keryx/Kaspa `OP_CHECKLOCKTIMEVERIFY`
>    (absolute, vs `lock_time`) is **`0xb0`** and `OP_CHECKSEQUENCEVERIFY`
>    (relative, vs the input's `sequence`) is **`0xb1`**. Bitcoin's
>    `0xb1`/`0xb2` mapping does not apply — Bitcoin bytes put a CSV where you
>    meant a CLTV.
> 2. **No `OP_DROP` after CLTV/CSV**: unlike Bitcoin (where they are
>    soft-forked NOPs that must leave the stack untouched), Keryx's CLTV/CSV
>    **pop** their operand. The Bitcoin idiom `<locktime> CLTV OP_DROP` would
>    drop the next stack item — the signature, in the shape above — and the
>    script fails.

```js
// claim (hashlock branch): reveal the preimage, select the IF branch
await window.keryx.signTx({
  inputs: [{
    transaction_id: htlcOutpoint.txid,
    index: htlcOutpoint.index,
    utxo: { amount_sompi: htlcOutpoint.amount, script_public_key: htlcOutpoint.spk },
    redeem_script: redeemHex,
    sig_script_suffix: '20' + preimageHex + '51', // push32 preimage, OP_TRUE
  }],
  outputs: [{ amount: htlcOutpoint.amount - 30000000, script_public_key: myScriptPubKey }],
}, { broadcast: true });

// refund (timelock branch): non-final sequence + lock_time arm CLTV
await window.keryx.signTx({
  lock_time: refundDaaScore,
  inputs: [{
    transaction_id: htlcOutpoint.txid,
    index: htlcOutpoint.index,
    sequence: 0,
    utxo: { amount_sompi: htlcOutpoint.amount, script_public_key: htlcOutpoint.spk },
    redeem_script: redeemHex,
    sig_script_suffix: '00', // OP_FALSE — select the ELSE branch
  }],
  outputs: [{ amount: htlcOutpoint.amount - 30000000, script_public_key: myScriptPubKey }],
}, { broadcast: true });
```

The approval window flags custom-script spends and non-ALL sighash types
before the user confirms, and shows the raw transaction JSON.

## Security model

- Keys and seed phrases never leave the extension; pages only ever receive
  addresses, public keys, signatures and signed transactions.
- Grants are **per-origin** and stored locally; manage/revoke them under
  *Settings → Connected sites*. Every sign/spend requires a fresh approval.
- A locked wallet asks for the session password inside the approval window —
  the page cannot observe or bypass it.
- Closing the approval window rejects the request.
