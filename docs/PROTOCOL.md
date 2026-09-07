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

### Sighash types (Kaspa rules)

`ALL = 0x01`, `NONE = 0x02`, `SINGLE = 0x04`, each optionally `| ANYONECANPAY (0x80)`.
The reused-value hashes above change per type (only ALL is used by the official
wallet and network-proven; the rest follow Kaspa consensus verbatim):

- `hashPrevouts`, `hashSigOpCounts`: 32 zero bytes when ANYONECANPAY
- `hashSequences`: 32 zero bytes when ANYONECANPAY or base is NONE/SINGLE
- `hashOutputs`: 32 zero bytes for NONE; for SINGLE, the hash of only the
  output at the input's index (32 zero bytes when there is none)
- final byte = the full sighash-type byte, which also terminates the 65-byte
  signature push in `signature_script`

### Script-path spending (P2SH / HTLC)

Kaspa-style P2SH `script_public_key` = `0xaa 0x20 <32-byte blake2b-256(redeem)> 0x87`
(OP_BLAKE2B <hash> OP_EQUAL). The sighash commits to the on-chain
`script_public_key` of the UTXO (NOT the redeem script — unlike Bitcoin); the
redeem script is revealed as the final data push of `signature_script`:
`<pushes consumed by redeem> <push(redeem_script)>`.

### Timelock opcodes — renumbered vs Bitcoin (verified in keryx-node txscript)

| byte | Keryx/Kaspa opcode | lock kind | verified against |
|---|---|---|---|
| `0xb0` | OP_CHECKLOCKTIMEVERIFY (CLTV) | **absolute** | `tx.lock_time` — DAA score when `< 500_000_000_000`, else unix-ms timestamp; stack and tx values must be the same kind; the spending input's `sequence` must be below u64-max |
| `0xb1` | OP_CHECKSEQUENCEVERIFY (CSV) | **relative** | the spending input's `sequence` — compared under mask `0xffffffff`; bit 63 set on the stack value = check disabled, set on the input's sequence = fail |

(Bitcoin uses 0xb1 for CLTV and 0xb2 for CSV — do not carry that mapping over.
On Keryx `0xb2` is OpTxVersion, a reserved introspection opcode. Also unlike
Bitcoin, both opcodes **pop** their stack operand — they are native opcodes,
not soft-forked NOPs — so the Bitcoin `… CLTV OP_DROP` idiom must NOT be used;
an OP_DROP there would consume the next item under the operand.)

### Personal message signing

`digest = keyed blake2b-256(key = "PersonalMessageSigningHash", msg-utf8)`,
signed with BIP340 Schnorr (used by the provider's `signMessage`).

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

## AI inference (confirmed from keryx-labs.com/infer, 2026-07-06)

**AiRequest transaction**: subnetwork id `03…00`, binary payload (hex-encoded):
`bytes[0..32) = model_id`, `u32le max_tokens @32`, `u64le inference_reward @36`,
`u64le priority_fee @44`, `utf-8 prompt from 52`.

**Cost model** (all sompi): `priority_fee = max(3e7, user input)` — this is the tx fee;
`inference_reward = model_base + 5e6 × ceil(max_tokens/64)` — locked in
`outputs[1]`, the **reward vault**.

**Reward vault (H8 reward routing — keryx-node `reward_routing_activation`,
mainnet DAA 79,210,000; re-verified against the site bundle and keryx-node
v1.6.1 on 2026-09-07).** Consensus (`check_ai_request_escrow_output`) requires
of every AiRequest: `outputs.len() ≥ 2`; `outputs[1]` has script version 0 and
EXACTLY the script `6a0761697661756c74` = `OP_RETURN(0x6a) PUSH7 "aivault"`
(`keryx_inference::INFERENCE_VAULT_SCRIPT`); `outputs[1].value ≥ inference_reward`;
tx fee ≥ `priority_fee`. The vault is keyless and provably unspendable — it
names no miner; a later coinbase mints the reward to the first accepted
responder, or it burns if nobody serves the request. The mempool exempts this
exact script from the dust/non-standard output checks (a look-alike OP_RETURN
is rejected). The site passes `{ vault: true }` unconditionally — there is no
DAA switch, H8 is long past. `/capabilities` `miner_pubkeys` is no longer used
for anything; the UI still blocks submission when `miner_count === 0` because
an unserved vault burns the reward.

*Pre-H8 (historical, for decoding old feed rows only):* `outputs[1]` was a CSV
escrow paying `capabilities[model].miner_pubkeys[0]` with script
`<36000 LE minimal push> 0xb1(OP_CHECKSEQUENCEVERIFY) 0x20 <miner x-only pubkey> 0xac(CHECKSIG)`
— a **relative (sequence) lock**, not CLTV, which keryx-node classifies as
`ScriptClass::CsvPubKey` ("OPoI escrow"); see the timelock-opcode table below.
Consensus now rejects that script in an AiRequest (`AiRequestInvalidEscrowScript`).

The site also refused submissions while `last_daa_score < 92,550,000` (its
"paused until the H12 activation" banner); H12 is past and the gate is inert.

**Model registry** (hardcoded in the site bundle; base price in KRX):

| key | model_id_hex | base |
|---|---|---|
| qwen3.5-9b-abliterated | bd34568cd89f5f19c6c3a6e1a61b929bc868709409eaad8e672d85f3c1eb5710 | 1.0 |
| glm-4-9b-0414 | fa2f13be0850e26c5ce86c7ac79da85e300c1da8b3290f9a18d47105f1f2140a | 1.5 |
| gemma-4-12b-abliterated | 399984045600f7d58d1b2cf01e6a4bf466fa15c7ac31bd0dd1a71e003b617cc6 | 2.0 |
| qwen3.6-27b | b8bdc01fa407eab943e4fefc807483b39f8142785256049e1f559698a5284746 | 2.5 |
| kimi-linear-48b | 3dc09358ad75c6ef0c9c86ee4f47c4d6acda961fecbd0e4f9cf55e8f0fdffddb | 4.0 |

The H6 hardfork (`pom_v3_activation`, mainnet DAA 76,316,623) retired
`qwen3-8b-abliterated` (`d42fa6ee…`, the H5 tier 0) and `mistral-7b-v0.3`
(`8c2fea60…`), replacing both with `qwen3.5-9b-abliterated` as tier 0 and
inserting `gemma-4-12b-abliterated` as the new tier 2 (and default); there is
no sub-1-KRX tier anymore. Retired ids — including H4's `exaone-4.0-1.2b`
(`300a99b3…`) — stay in the registry so pre-fork feed rows still resolve to a
name instead of raw hex.

**Coin selection** (advanced builder): largest-first; select until
`change > 0 && 1e12/change + 1e12/vault ≤ 8e4`; insufficient if
`sum ≤ fee + vault`. The site still folds a change that violates the mass
constraint into the fee (no change output) — but that leaves the vault at
`outputs[0]` and the node rejects the tx (`AiRequestMissingEscrowOutput`), so
this wallet fails the build with an "Insufficient funds" error instead
(minimum change = `ceil(1e12 / (8e4 − 1e12/vault))`, ≈0.142 KRX at a 1.05 KRX
reward).

**Feed**: `GET /infer?limit=` items
`{ tx_id, model, prompt, max_tokens, inference_reward, priority_fee, daa_score,
block_hash, payload_prefix, result, result_text, result_block_hash }`.
`result` of 46 chars starting `Qm` is an IPFS CID — fetch text from
`https://keryx-labs.com/ipfs/{cid}`. Status: SLASHED / CHALLENGED via
`GET /challenges?limit=` matching `challenge.request_hash_hex.slice(0,16) ===
item.payload_prefix` (fraud_proven ⇒ slashed); else RESPONDED (has result) or
PENDING. The site polls the feed every 5 s.
