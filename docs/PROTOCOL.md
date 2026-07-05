# Keryx Network — protocol notes

Reverse-engineered from the official web wallet bundle at `https://keryx-labs.com/wallet`
(Next.js chunks, 2026-07-05). Keryx is a **Kaspa-derived UTXO chain** (sompi units, DAA
scores, blake2b sighash, BIP340 Schnorr). Everything in phase 1 (addresses, balances) is
verified against the live network; the transaction section is a faithful transcription of
the site's signing code and is the spec for phase 2.

## Constants

| item | value |
|---|---|
| API base | `https://keryx-labs.com` |
| Network name | `keryx-mainnet` |
| Ticker / unit | KRX; 1 KRX = 1e8 **sompi** |
| Address prefixes | `keryx:` (also accepted by UI: `keryxtest:`, `keryxsim:`, `keryxdev:`) |
| Derivation path | `m/44'/111111'/0'/0/{index}` (BIP32 secp256k1; site always uses index 0) |
| Mnemonic | BIP39 English; 24 words generated (256-bit), 12/24 accepted on import; seed = `mnemonicToSeedSync(m)` (no passphrase) |
| Native subnetwork id | `0000000000000000000000000000000000000000` (20 bytes) |
| Inference subnetwork id | `0300000000000000000000000000000000000000` |
| Max sequence | `18446744073709551615` (u64 max) |
| Min/default fee | 0.3 KRX = 3e7 sompi |
| Coinbase maturity | UTXO unusable while `block_daa_score + 1000 > current_daa_score` |
| Session vault | localStorage key `krx_sess`; PBKDF2-SHA256 600k iters → AES-256-GCM; 15-min inactivity auto-lock |

## Addresses (cashaddr variant)

- Payload: `version byte (0) || 32-byte x-only pubkey` (drop the parity byte of the
  33-byte compressed secp256k1 key).
- Convert payload to 5-bit groups, append 8 checksum chars, charset
  `qpzry9x8gf2tvdw0s3jn54khce6mua7l`, rendered as `keryx:<base32>`.
- Checksum: BCH polymod over `prefix chars & 31` + `0` + data words + 8 zero words,
  40-bit, generators `0x98f2bc8e61, 0x79b76d99e2, 0xf33e5fb3c4, 0xae2eabe2a8, 0x1e4f43e470`
  (same as Bitcoin Cash cashaddr), final `^ 1`, serialized as 5 bytes BE → 8 words.
- `script_public_key` for a version-0 address: `0x20 || pubkey(32) || 0xac`
  (OP_DATA_32 <key> OP_CHECKSIG), `script_version: 0`.

## REST API (`/api/v1`)

| endpoint | response (observed) |
|---|---|
| `GET /info` | `{ network, last_daa_score, block_reward_krx, total_supply_krx, max_supply_krx, hashrate_hps, total_blocks, total_txs, burned_krx, total_escrow_krx, total_real_inferences, mined_pct }` |
| `GET /addresses/{addr}/balance` | `{ address, balance_sompi }` |
| `GET /addresses/{addr}/utxos?limit=N` | array of `{ transaction_id, index, amount_sompi, script_version, script_public_key, block_daa_score, is_coinbase }` (site fetches limit 2000) |
| `GET /addresses/{addr}/utxos/count` | `{ count }` |
| `GET /addresses/{addr}?limit=N&offset=M` | `{ address, total_received_sompi, total_tx_count, transactions: [{ tx_id, amount_sompi, is_spend, daa_score, block_hash, address }] }` |
| `POST /broadcast` | body = signed tx JSON (below) → `{ transaction_id }` |
| `GET /market` | `{ price_usd, market_cap_usd, volume_24h_usd, change_24h_pct, ... }` |
| others | `/blocks`, `/blocks/{hash}`, `/blocks/{hash}/txs`, `/transactions`, `/transactions/{id}`, `/graph`, `/infer?limit=`, `/inference/{id}`, `/challenges`, `/hashrate-history?period=`, `/richlist`, `/peers`, `/peers/geo`, `/capabilities` |

Errors: non-2xx with JSON `{ error }`. Explorer links: `/tx/{tx_id}`.

## Transaction JSON (`POST /broadcast`)

```json
{
  "version": 0,
  "inputs": [{
    "transaction_id": "<hex>",
    "index": 0,
    "signature_script": "<hex: 0x41 || 64-byte schnorr sig || 0x01>",
    "sequence": "18446744073709551615",
    "sig_op_count": 1
  }],
  "outputs": [{ "amount": 12345, "script_version": 0, "script_public_key": "<hex>" }],
  "lock_time": 0,
  "subnetwork_id": "0000000000000000000000000000000000000000",
  "gas": 0,
  "payload": ""
}
```

Amounts are JSON numbers (sompi); the wallet refuses to sign values outside the JS
safe-integer range.

## Sighash (Kaspa `TransactionSigningHash`)

Hash = **keyed blake2b-256**, key = ASCII `TransactionSigningHash`, digest 32 bytes.
All integers little-endian. "blake(...)" below = same keyed blake2b-256.
For input *i*:

```
update u16  version
update blake( for each input: txid_bytes(32) || u32 index )          # hashPrevouts
update blake( for each input: u64 sequence )                          # hashSequences
update blake( for each input: u8 sig_op_count )                       # hashSigOpCounts
update txid_bytes(32) of input i || u32 index of input i              # outpoint
update u16 utxo.script_version
update u64 len(script_public_key) || script_public_key bytes
update u64 utxo.amount_sompi
update u64 sequence
update u8  sig_op_count
update blake( for each output: u64 amount || u16 script_version
              || (u64 len || script bytes) )                          # hashOutputs
update u64 lock_time
update subnetwork_id bytes (20)
update u64 gas
update payloadHash: 32 zero bytes if native subnetwork && empty payload,
       else blake( u64 len || payload bytes )
update u8 0x01                                                        # SIGHASH_ALL
```

Sign the digest with **BIP340 Schnorr** (secp256k1) using the 32-byte private key;
`signature_script = 0x41 || sig(64) || 0x01`.

## Send flow (site behavior)

1. Fetch UTXOs (limit 2000). Filter: `block_daa_score > 0` and not immature coinbase
   (`is_coinbase && block_daa_score + 1000 > current_daa_score`).
2. Sort descending by `amount_sompi`; accumulate until `sum >= amount + fee`.
3. Outputs: destination, plus change back to self when `sum − amount − fee > 0`.
4. Sign every input (sighash above), broadcast. UI default fee 0.3 KRX.

## Consolidation flow (site behavior)

Loop rounds until a fetch returns < 2000 UTXOs **and** ≤ 80 eligible remain:
batch eligible UTXOs in groups of 80; each batch is a self-send of
`sum(batch) − 3e7` sompi with fee 3e7; broadcast up to 10 batches in parallel,
500 ms between waves, 4 s between rounds; ignore "already accepted" errors;
skip batches whose value ≤ fee.

## AI inference (phase 2, partially mapped)

- Inference txs use subnetwork id `03…00` and a binary payload (hex-encoded):
  `bytes[0..32) = 32-byte id (hex arg; likely model/requester key), u32le max_tokens
  (default 128) at 32, u64le inference_reward at 36 (default 0), u64le priority_fee at 44
  (default 3e7), utf-8 prompt from 52`.
- The inference builder creates an **escrow output** with script:
  `<minimal-LE push of lock-blocks (default 36000)> 0xb1 0x20 <32-byte pubkey> 0xac`
  (0xb1 = OP_CHECKLOCKTIMEVERIFY in Bitcoin numbering) paying the inference amount,
  and selects UTXOs under a mass-like constraint `1e12/change + 1e12/amount ≤ 8e4`
  (change is dropped into the fee when the constraint fails).
- Results are polled via `GET /api/v1/inference/{id}`.
