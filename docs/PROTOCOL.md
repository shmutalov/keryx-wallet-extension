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
| `GET /ai/providers` | H14 miners to seal to — see *Private inference* |
| `GET /inference/{id}` | one request incl. its sealed answers — see *Private inference* |
| others | `/blocks`, `/blocks/{hash}`, `/blocks/{hash}/txs`, `/transactions`, `/transactions/{id}`, `/graph`, `/infer?limit=`, `/challenges`, `/hashrate-history?period=`, `/richlist`, `/peers`, `/peers/geo`, `/capabilities` |

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

**Model registry** (hardcoded in the site bundle; H6 base price in KRX — for the H14 lineup and flat prices see *Private inference* below):

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

## Private inference — H14 (keryx-node v1.6.4, verified 2026-10-08)

keryx-node `private_inference_activation` (**mainnet DAA 121,985,000**, ≈ 2026-10-09
14:00 UTC; testnet 6,000). Spec: keryx-node `docs/private-inference.md`,
`inference/src/private.rs`; client side ported in `src/lib/private.js` and
cross-checked byte-for-byte against both the node's Rust code and keryx-labs.com's
own `/infer` sealing module (pinned vectors in `scripts/tx-unit.mjs`).

**Era rules (consensus, per block DAA).** Before the gate an AiRequest payload is
≤ 4,096 bytes and an AiResponse carries no inline body. From the gate on, every
AiRequest prompt **must** parse as a sealed envelope (`AiRequestNotPrivate`
otherwise — plaintext requests invalidate the block, the mempool rejects them), and
the payload cap rises to 65,536 bytes (AiRequest transient-mass allowance
`(64 KiB + 4 KiB) × 4`). From gate + 72,000 DAA (one ledger horizon) every
AiResponse must carry an inline body. The wallet stops sending in the last 600 DAA
(~1 min) before the gate: a plaintext request mined after it is invalid, a sealed
one mined before it would be read as a plaintext prompt.

**Pricing from H14** (`INFERENCE_REWARD_MINIMUMS_FLAT`, no token surcharge): the
`inference_reward` floor is fixed per model whatever `max_tokens` — 0.5 KRX for
tier 0, +0.5 KRX per tier. The 0.3 KRX `priority_fee` (= tx fee) comes on top; the
mass-based relay fee of a multi-KB request (≈ 1 sompi/gram, < 0.001 KRX) stays far
below that flat minimum.

**Lineup** (`POM_TIERS_H14`): tier 3 becomes Qwen3.8-27B; every other tier is unchanged.

| tier | key | model_id_hex | H6 base (+surcharge) | H14 flat |
|---|---|---|---|---|
| 0 | qwen3.5-9b-abliterated | bd34568c… | 1.0 | 0.5 |
| 1 | glm-4-9b-0414 | fa2f13be… | 1.5 | 1.0 |
| 2 | gemma-4-12b-abliterated | 39998404… | 2.0 | 1.5 |
| 3 | qwen3.6-27b → **qwen3.8-27b** | b8bdc01f… → 73740b443bdc00afda5fa34eb9999d3fea77dcc3f6de238fab701394cdc96fb3 | 2.5 | 2.0 |
| 4 | kimi-linear-48b | 3dc09358… | 4.0 | 2.5 |

**Request envelope** — the whole `prompt` field after the 52-byte header (all ints LE):

```
[magic 00 'K' 'X' 'P'] [version 01] [ephemeral pubkey E: 33, compressed]
[nonce: 12] [n: 1, 1..=128]
n × { [escrow pubkey R_i: 32, x-only, strictly ascending] [wrapped root key: 32 + 16 tag] }
[ChaCha20-Poly1305(k_prompt, nonce, prompt)]
```

Keys (HKDF-SHA256, salt `"KeryxPrivateInferenceV1"`, one 32-byte block):
`ss_i = SHA-256(compressed ECDH(e, lift_x(R_i)))` (libsecp default; `lift_x` = BIP-340
even-Y lift, so a miner with an odd-Y key negates its secret);
`kek_i = HKDF(ss_i, "kek" ‖ E ‖ R_i)`; `wrapped_i = ChaCha20-Poly1305(kek_i, nonce,
root_key, aad = 52-byte request header)`; `k_prompt = HKDF(root_key, "prompt")` with
`aad = request header ‖ envelope header` (everything before the ciphertext). The same
12-byte nonce serves every wrap and the prompt — safe, each under a different key.
Re-pricing, re-addressing or transplanting a wrapped key breaks authentication.

**Root key.** The node only needs it random per request. keryx-labs.com derives it —
`root_key = HKDF(salt "KeryxChatRootKeyV1", ikm = account private key, info = "root" ‖
seed)` — and this wallet does the same, so either client opens the other's answers
from the seed phrase alone and no secret is ever stored. `seed` (the **cohort seed**)
is the outpoint the request's **first input** spends: `txid (32) ‖ index u32le` —
unique, since no other transaction can spend it. The inputs are therefore chosen
before the payload is built. (This is key schedule 1; from H15 requests seal under
key schedule 2 — see *Verifiable inference — H15* below.)

**Recipients.** `GET /api/v1/ai/providers` (keryx-labs.com and the shim, same
shape) → `{ virtual_daa_score, window_daa: 18000, cohort: [...], window: [...] }`, each
`{ tier, model, model_id, identity, escrow_pubkey }` (node RPC `getServiceProviders`,
≥ 1.6.4). Filter both lists by the request's `model_id`. The **target cohort** = the
cohort's keys if ≤ 128, else the 128 with the lowest
`rank = BLAKE2b-256("KeryxPrivateCohortV1" ‖ seed ‖ key)` (unkeyed, 32-byte digest);
then add the window's other keys in rank order up to 128 (miners active in the last
~30 min, as keryx-cli and the site do). Mainnet tiers had 7–46 miners on 2026-10-08,
so an envelope is ~0.6–3.8 KB plus the prompt. Mempool admission
(`validate_private_request_coverage`) rejects a request that misses **any** key of the
target cohort at the sink (`the private AiRequest is not sealed to N of the M escrow
keys of its tier cohort` — the wallet re-reads the providers and reseals once) or
whose tier has no eligible miner. Consensus later tolerates
`max(3, ⌈|T|/4⌉)` missing keys (miners who joined between sealing and arming). Every
recipient must answer (silent ones are struck); the first credited answer wins the vault.

**Answers.** A V2 AiResponse (174 bytes) may append `[0x80] [len: 4 LE] [body ≤
32 KiB]`; the responder's Schnorr signature then covers `78 v1 bytes ‖ extension`.
The body is a response envelope `[magic] [version] [nonce: 12]
[ChaCha20-Poly1305(k_response, nonce, answer)]` with
`k_response = HKDF(root_key, "response" ‖ responder escrow pubkey)` and
`aad = request id ‖ responder escrow pubkey`. The **request id is the AiRequest's tx
id** (H8 request identity). A body that does not start with the magic is the miner's
plaintext note that it could not open the request.

`GET /api/v1/inference/{tx_id}` → `{ tx_id, model, prompt, status: pending|completed,
sealed, sealed_recipients, sealed_responses: [{ responder_pubkey, body (hex), … }],
result_cid, result_block_hash, result_daa_score, … }` lists every inline answer,
oldest first; the requester tries each until one opens (the site gives up after
15 min). In the `/infer` feed a sealed request has `prompt: ""`, `sealed: true`,
`sealed_recipients: n`, and `result` is only the multihash of the sealed body — not an
IPFS pin, never fetch it. When a prompt (with its chat context) does not fit,
keryx-labs.com seals it deflate-raw compressed behind a `00 'K' 'Z' 01` marker —
a miner-side convention (the node's H14 banner advertises "prompts up to 64 KiB
(compressed)"; keryx-node itself never inspects the plaintext). This wallet never
compresses: the envelope fits a 55 KB prompt even at 128 recipients.

## Verifiable inference — H15 (keryx-node v1.6.6, verified 2026-10-28)

keryx-node `verifiable_inference_activation` and the trace gates bundled with it
(`trace_chain_activation`, `trace_context_activation`, …): **mainnet DAA 140,115,000**
(≈ 2026-10-30 at the chain's ~10.13 DAA/s; mainnet was at 138.03M on 2026-10-28;
testnet 3,500). Miners now commit an inference trace with every answer and open
parts of it on demand (new subnetwork `06` opening transactions, `getAwaitedOpenings`);
none of that is requester-facing. The model lineup, the flat prices, the envelope
format and the request identity are unchanged. What changes for a requester:

**Key schedule 2** (`inference/src/private.rs`, node v1.6.5). Under H14's schedule 1
every recipient unwraps the same root key and could derive every responder's answer
key, so a miner could read a competitor's sealed answer in the mempool, re-seal it
as its own and be credited. Schedule 2 binds each answer key to the requester–
responder ECDH secret. All derivations use salt `"KeryxPrivateInferenceV2"`:

- the request secret is a 32-byte **seed**; `root_key = HKDF(seed, "root")`;
- the ephemeral secret `e` = the first valid scalar of `HKDF(seed, "ephemeral" ‖ ctr)`,
  `ctr` = one byte from 0, so the requester can recompute `e` (and every `ss_i`) later;
- `kek_i` and `k_prompt` as in schedule 1, under the V2 salt;
- `k_response_i = HKDF(ss_i ‖ root_key, "response" ‖ R_i)`.

The schedule is **not on the wire** (consensus accepts envelope version 1 only): a
responder tries the V2 KEK first, then V1 — exactly one authenticates its wrapped root
key — and the requester knows it from its secret (keryx-cli prints `02 ‖ seed` for
schedule 2, a bare 32-byte root key for schedule 1). Schedule-1 requests stay
servable. Rollout is miners first: a miner built before schedule 2 cannot unwrap it
and answers with its plaintext error body, which used to be credited; keryx-cli
therefore seals schedule 1 until H15 and schedule 2 from it, and so does this wallet
(`keyScheduleAt` in `src/lib/inference.js`). From H15 an untraced response earns no
credit on the audited tiers, so a pre-H15 miner's error body cannot win the vault.

This wallet keeps one derivation for both schedules — `secret = HKDF(salt
"KeryxChatRootKeyV1", account private key, "root" ‖ cohort seed)`, used as the root
key under schedule 1 (as keryx-labs.com does) and as the seed under schedule 2 — and
records each request's schedule. The cohort seed is the first input's outpoint, so a
secret is used for exactly one request under exactly one schedule. As of 2026-10-28
keryx-labs.com's `/infer` still seals schedule 1 and has no schedule-2 derivation; if
it adopts a different one, the two clients simply stop being able to open each
other's schedule-2 answers (each still opens its own).

**Stage-2 answers** (`trace_chain_activation`, `verifiable-inference/src/answer.rs`).
The sealed answer's plaintext becomes `text ‖ token ids (u32 LE each) ‖ count (u32 LE)
‖ "KXTK"`, so the trace can be checked against the generated tokens. Decode as the
node does: if the last 4 bytes are `KXTK` and `count × 4 + 8` bytes fit, the text is
what precedes the ids; otherwise the whole plaintext is text. The inline body cap rises
from 32 to 48 KiB, and a second response extension follows the body:
`[0x81] [len: 4 LE] [trace_root: 32] [n_prompt: 4 LE] [n_pos: 4 LE] [stage: 1]
[tokens_root: 32]?` (41 or 73 bytes). API hosts strip it: `sealed_responses[].body` is
still the response envelope alone (keryx-api-shim a7aa8bc; `response_length` added).

**Context rule** (`trace_context_activation`). Each tier holds its responders to a
context floor — 8,192 tokens for tier 0, 32,768 for tiers 1–4 (`CONTEXT_FLOORS_H14`) —
and a request's prompt is sure to fit when its plaintext length in bytes (envelope
ciphertext − 16) is at most `floor − max_tokens − 512` (`safe_prompt_len`; a token
spans at least one byte, 512 covers the chat template). When a longer prompt goes
unanswered and no responder proves it fits, the silent miners are excused rather than
struck, so the request can lapse and the reward be lost. Bytes overstate tokens
(~4 bytes/token for English), so this wallet warns above the safe length instead of
refusing: on tier 0 at 4,096 max tokens only 3,584 bytes are sure to fit.

**Feed.** keryx-labs.com — and the shim since a7aa8bc — leave sealed requests out of
`GET /infer`: their prompts are unreadable, and a requester reads its answer from
`/inference/{tx_id}`. Since every request is sealed from H14, the feed holds only
pre-H14 public requests (newest at DAA 121,365,687 on 2026-10-28).
