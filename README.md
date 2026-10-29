# Keryx Wallet — Chrome Extension

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/hoobkmlannjlgaajjlhjagdbmijggcab?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/keryx-wallet/hoobkmlannjlgaajjlhjagdbmijggcab?utm_source=github&utm_medium=referral&utm_campaign=readme)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/keryx-wallet/hoobkmlannjlgaajjlhjagdbmijggcab?utm_source=github&utm_medium=referral&utm_campaign=readme)** — works in Chrome, Brave and other Chromium-based browsers.

A client-side Chrome (MV3) extension wallet for the **Keryx Network** (PoW/PoM blockchain, ticker **KRX**), styled after and protocol-compatible with the official web wallet at [keryx-labs.com/wallet](https://keryx-labs.com/wallet). Send and receive KRX, ask private on-chain AI, and connect to Keryx dApps through `window.keryx`.

Private keys are derived and stored **only on your device** — the extension talks to the public Keryx node API for read-only data.

## Features

- **Create a new wallet** — generates a 24-word BIP39 mnemonic with a backup-confirmation step, then a separate page to set the session password.
- **Import a wallet** — accepts a 12- or 24-word BIP39 mnemonic.
- **Multiple accounts** — switchable and renamable from the dashboard. "Add account" offers: next address from the current seed (`m/44'/111111'/0'/0/{n}`), a brand-new seed phrase, or an imported one. **One global session password secures the entire account store** — accounts added while unlocked need no extra password.
- **Seed backup** — reveal any account's seed phrase from Settings; requires re-entering the session password (verified by decrypting the vault) even while unlocked.
- **Settings page** — session info, connected dApp sites, a configurable **API host** (point the wallet at your own Keryx node/indexer; empty = official host; the host must allow CORS, which the stock indexer does), an **About & support** card (rate the wallet, buy or mine KRX, source code, report a problem, tip address), plus a danger zone: the destructive "Reset wallet" (removes all accounts + vault) lives there and only unlocks after typing `RESET`.
- **Balance dashboard** — live KRX balance (auto-refresh every 15 s), approximate USD value, UTXO count with a Consolidate link beside it once there are two or more, network DAA score, and a 3-row recent-transactions preview; a dedicated History screen paginates the full list (15 per page) with explorer links.
- **Send KRX** — Kaspa-style transaction building and signing fully client-side: keyed blake2b-256 `TransactionSigningHash`, BIP340 Schnorr signatures, greedy largest-first UTXO selection with coinbase-maturity filtering, change back to self, broadcast via the public node.
- **Receive KRX** — the QR button next to the dashboard address opens a Receive screen: a QR code (dark modules on a light tile with the standard quiet zone) plus a copy button. An **Address / Phone** switch picks what the code holds: the standard `keryx:` address for wallet apps, or a link to the address's page on the Keryx explorer — the iPhone Camera won't copy `keryx:` codes (it reads the prefix as an app link) but opens links in Safari. The last choice is remembered.
- **Consolidate UTXOs** — merges many small UTXOs (pool payouts) the way the official web wallet does: rounds of self-sends of up to 80 inputs each (89,946 grams, under the 100k standard mass) paying the 0.3 KRX fee per transaction, up to 10 broadcast at once, until what's left fits one batch. The screen shows spendable vs. not-yet-spendable UTXOs and an estimate of transactions and fees. It is resumable, and batches the node already has (after a stale indexer fetch) count as sent. A send that would need more inputs than fit one transaction (89+) stops before broadcast and points to Consolidate.
- **Address book & recents** — save `name → address` entries (managed from Settings or the Send screen); the destination field offers a picker with saved and recently-used addresses, filtered as you type.
- **AI inference** — submit prompts to the Keryx Inference Oracle from a dedicated page: model picker with live miner counts, max-tokens slider, cost estimate, AiRequest transaction signed locally with the reward locked in the H8 keyless `aivault` output, and a live feed with statuses (pending/responded/challenged/slashed). From the **H14** hardfork (keryx-node v1.6.4, mainnet DAA 121,985,000) inference is **private**: the prompt is sealed in the browser to the model's tier cohort (ECDH + HKDF + ChaCha20-Poly1305, wire-compatible with keryx-node and keryx-labs.com), each miner seals its answer back, and *Your private requests* decrypts it — kept encrypted per account, with the per-request key re-derived from the seed, never stored. Pricing switches to the flat H14 price per model and tier 3 to Qwen3.8-27B automatically at the gate. From **H15** (keryx-node v1.6.6, mainnet DAA 140,115,000) requests seal under key schedule 2 (each answer key bound to its responder, so no miner can pass off another’s answer), stage-2 answers have their token-id trailer stripped, and long prompts that may overflow the model context get a warning.
- **Localized UI** — English, Deutsch, Español, Français, Português (Brasil), Русский and 中文（简体）. Follows the browser's UI language by default (every regional variant maps to its base locale, so `es-CR`/`es-419`/`es-MX` all get Español and `fr-CA`/`fr-BE` get Français; Traditional-Chinese variants like `zh-TW` deliberately stay English until a zh_TW catalog exists), with a manual override in Settings that applies immediately across the popup, approval window and background. The same `_locales/` files drive the Chrome Web Store listing and extension name via the manifest's `__MSG_*__` placeholders, so there is one source of truth per string.
- **Lock / auto-lock** — decrypted secrets live only in `chrome.storage.session` (in-memory); a background alarm enforces a 15-minute inactivity auto-lock. "Lock" keeps the encrypted vault; "Reset" (in Settings) removes it.
- **dApp provider (`window.keryx`)** — a MetaMask/KasWare-style provider injected into web pages (see [docs/PROVIDER.md](docs/PROVIDER.md)): per-origin connect grants, `sendKrx`, `signMessage`, `submitInference`, and a low-level `signTx` that supports P2SH/custom-script spending — redeem script, script-sig prefix/suffix and the full set of Kaspa sighash types — enough for HTLC claim & refund flows. Every signature goes through an approval window that shows the origin, amounts, decoded outputs and custom-script warnings; connected sites are managed from Settings.
## Install

**From the Chrome Web Store:** [Keryx Wallet](https://chromewebstore.google.com/detail/keryx-wallet/hoobkmlannjlgaajjlhjagdbmijggcab?utm_source=github&utm_medium=referral&utm_campaign=readme). The official listing ID is `hoobkmlannjlgaajjlhjagdbmijggcab` — any other extension calling itself "Keryx Wallet" is not this project. Never enter your seed phrase anywhere else.

**From source (Load unpacked):**

1. `npm install`
2. `npm run build` — bundles everything into `extension/`
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `extension/` folder.

## Project layout

```
src/
  lib/keryx.js      Wallet primitives: BIP39/BIP32 derivation (m/44'/111111'/0'/0/i),
                    cashaddr-style keryx: address codec, KRX/sompi formatting
  lib/tx.js         Tx building/signing: Kaspa sighash (all types), transfers,
                    inference, generalized signTxJson (HTLC/P2SH), message signing
  lib/private.js    H14 private inference: sealed request/answer envelopes, cohort
                    seed/rank + recipient selection, site-compatible root-key derivation
  lib/inference.js  One AiRequest submit path (popup + dApp approval): era gate,
                    plaintext or sealed payload, answer polling
  lib/consolidate.js
                    UTXO consolidation (official-wallet flow): 80-input self-sends in
                    waves of 10, resumable rounds, mass and storage-mass guards
  lib/requests.js   This wallet's sealed requests, AES-GCM-encrypted per account
  lib/models.js     Model registry: H6/H14 lineups, base vs flat reward floors
  lib/api.js        Keryx node REST client (https://keryx-labs.com/api/v1)
  lib/vault.js      Mnemonic vault: PBKDF2-SHA256 (600k) -> AES-256-GCM in chrome.storage.local
  lib/session.js    Unlocked session in chrome.storage.session + activity timestamps
  lib/provider.js   Per-origin dApp grants + pending approval requests
  lib/i18n.js       t() over _locales/*/messages.json: browser-language resolution,
                    Settings override synced across contexts, per-key fallback to en
  lib/vendor/       qrcodegen.ts: Project Nayuki's QR Code encoder (MIT), vendored
                    at upstream commit 3c6d0b3 with only an export added
_locales/           en · de · es · fr · pt_BR · ru · zh_CN message catalogs (also the store listing)
  popup/            Popup UI (vanilla JS, theme extracted from keryx-labs.com)
  approval/         Approval window for dApp requests (connect/send/sign/inference)
  inpage.js         window.keryx provider injected into pages (MAIN world)
  content.js        page <-> background relay (ISOLATED world)
  background.js     MV3 service worker: auto-lock alarm + provider request router
build.mjs           esbuild bundling -> extension/
manifest.json       MV3 manifest
docs/PROTOCOL.md    Reverse-engineered Keryx protocol notes (addresses, sighash, tx format)
docs/PROVIDER.md    window.keryx dApp API reference (incl. HTLC claim/refund examples)
docs/store-listing/ Chrome Web Store listing: per-locale descriptions + dashboard checklist
```

## Security model

- All seed phrases live in a single **account store**, encrypted as one blob with **PBKDF2-SHA256 (600,000 iterations) → AES-256-GCM** under the global session password, and stored in `chrome.storage.local`. (A v1 single-mnemonic vault is migrated automatically on unlock.)
- While unlocked, the decrypted store and the derived AES key exist only in `chrome.storage.session` (memory-backed, cleared when the browser exits) and are wiped after 15 minutes of inactivity. The AES key is retained so adding an account re-encrypts the vault without re-prompting for the password.
- No keys, mnemonics, or passwords are ever sent over the network; the only remote host is `https://keryx-labs.com` (or the API host you configure in Settings).

## CI / Deploy

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every push and PR: `npm ci` → build → jsdom end-to-end test against the live network → uploads the packaged `keryx-wallet-extension.zip` as a workflow artifact.

Pushing a `v*` tag deploys the **exact artifact that was tested**: it is attached to an auto-generated GitHub Release, and — if the `CWS_EXTENSION_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` repository secrets are configured — published to the Chrome Web Store. Without those secrets the store step is skipped silently.

```
git tag v0.1.0 && git push origin v0.1.0
```

## Verification

The address codec was validated against the live network: mainnet richlist addresses decode, checksum-verify, and re-encode byte-identically, and freshly derived addresses are accepted by the public node API.

Three test suites run via `npm test` (all gate CI):

- `scripts/tx-unit.mjs` — signer unit tests: coin selection, coinbase maturity, change math, wire format, BIP340 signature verification against the recomputed sighash, all Kaspa sighash-type rules, HTLC claim/refund signature-script assembly, personal-message signing, compute mass, and consolidation planning plus full runs against a simulated node (stale indexer, rejections).
- `scripts/provider-e2e.mjs` — fully offline drive of the dApp provider chain: the injected `window.keryx`, the content-script relay, the background router (approval-window lifecycle, per-origin grants, window-close rejection) and the approval page itself (unlock, connect, send, HTLC sign-tx, sign-message, reject).
- `scripts/popup-e2e.mjs` — jsdom end-to-end drive of the real bundle: onboarding, vault, multi-account, the receive QR in both modes (rasterized and decoded back with jsQR), address book, a full send against a mocked node (broadcast body inspected), consolidation, and the too-many-inputs send guard; live-data checks auto-skip when the node is unreachable.

## License

[ISC](LICENSE). Includes [Project Nayuki's QR Code generator](https://www.nayuki.io/page/qr-code-generator-library) (MIT); its notice stays in `src/lib/vendor/qrcodegen.ts`.
