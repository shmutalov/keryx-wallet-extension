# Keryx Wallet — Chrome Extension

A client-side Chrome (MV3) extension wallet for the **Keryx Network** (PoW/PoM blockchain, ticker **KRX**), styled after and protocol-compatible with the official web wallet at [keryx-labs.com/wallet](https://keryx-labs.com/wallet).

Private keys are derived and stored **only on your device** — the extension talks to the public Keryx node API for read-only data.

## Features (phase 1)

- **Create a new wallet** — generates a 24-word BIP39 mnemonic with a backup-confirmation step, then a separate page to set the session password.
- **Import a wallet** — accepts a 12- or 24-word BIP39 mnemonic.
- **Multiple accounts** — switchable and renamable from the dashboard. "Add account" offers: next address from the current seed (`m/44'/111111'/0'/0/{n}`), a brand-new seed phrase, or an imported one. **One global session password secures the entire account store** — accounts added while unlocked need no extra password.
- **Seed backup** — reveal any account's seed phrase from Settings; requires re-entering the session password (verified by decrypting the vault) even while unlocked.
- **Settings page** — session info plus a danger zone: the destructive "Reset wallet" (removes all accounts + vault) lives there and only unlocks after typing `RESET`.
- **Balance dashboard** — live KRX balance (auto-refresh every 15 s), approximate USD value, UTXO count with consolidation hint, network DAA score, and a 3-row recent-transactions preview; a dedicated History screen paginates the full list (15 per page) with explorer links.
- **Send KRX** — Kaspa-style transaction building and signing fully client-side: keyed blake2b-256 `TransactionSigningHash`, BIP340 Schnorr signatures, greedy largest-first UTXO selection with coinbase-maturity filtering, change back to self, broadcast via the public node.
- **Address book & recents** — save `name → address` entries (managed from Settings or the Send screen); the destination field offers a picker with saved and recently-used addresses, filtered as you type.
- **AI inference** — submit prompts to the Keryx Inference Oracle from a dedicated page: model picker with live miner counts, max-tokens slider, cost estimate (base + token surcharge + priority fee), escrowed AiRequest transaction signed locally, and a live feed with statuses (pending/responded/challenged/slashed) and IPFS-fetched results.
- **Lock / auto-lock** — decrypted secrets live only in `chrome.storage.session` (in-memory); a background alarm enforces a 15-minute inactivity auto-lock. "Lock" keeps the encrypted vault; "Reset" (in Settings) removes it.

Still planned: UTXO consolidation (see [docs/PROTOCOL.md](docs/PROTOCOL.md) — the flow is already specified there).

## Install (Load unpacked)

1. `npm install`
2. `npm run build` — bundles everything into `extension/`
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `extension/` folder.

## Project layout

```
src/
  lib/keryx.js      Wallet primitives: BIP39/BIP32 derivation (m/44'/111111'/0'/0/i),
                    cashaddr-style keryx: address codec, KRX/sompi formatting
  lib/api.js        Keryx node REST client (https://keryx-labs.com/api/v1)
  lib/vault.js      Mnemonic vault: PBKDF2-SHA256 (600k) -> AES-256-GCM in chrome.storage.local
  lib/session.js    Unlocked session in chrome.storage.session + activity timestamps
  popup/            Popup UI (vanilla JS, theme extracted from keryx-labs.com)
  background.js     MV3 service worker: auto-lock alarm
build.mjs           esbuild bundling -> extension/
manifest.json       MV3 manifest
docs/PROTOCOL.md    Reverse-engineered Keryx protocol notes (addresses, sighash, tx format)
```

## Security model

- All seed phrases live in a single **account store**, encrypted as one blob with **PBKDF2-SHA256 (600,000 iterations) → AES-256-GCM** under the global session password, and stored in `chrome.storage.local`. (A v1 single-mnemonic vault is migrated automatically on unlock.)
- While unlocked, the decrypted store and the derived AES key exist only in `chrome.storage.session` (memory-backed, cleared when the browser exits) and are wiped after 15 minutes of inactivity. The AES key is retained so adding an account re-encrypts the vault without re-prompting for the password.
- No keys, mnemonics, or passwords are ever sent over the network; the only remote host is `https://keryx-labs.com` (read-only API in phase 1).

## CI / Deploy

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every push and PR: `npm ci` → build → jsdom end-to-end test against the live network → uploads the packaged `keryx-wallet-extension.zip` as a workflow artifact.

Pushing a `v*` tag deploys the **exact artifact that was tested**: it is attached to an auto-generated GitHub Release, and — if the `CWS_EXTENSION_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` repository secrets are configured — published to the Chrome Web Store. Without those secrets the store step is skipped silently.

```
git tag v0.1.0 && git push origin v0.1.0
```

## Verification

The address codec was validated against the live network: mainnet richlist addresses decode, checksum-verify, and re-encode byte-identically, and freshly derived addresses are accepted by the public node API.

Two test suites run via `npm test` (both gate CI):

- `scripts/tx-unit.mjs` — signer unit tests: coin selection, coinbase maturity, change math, wire format, and BIP340 signature verification against the recomputed sighash.
- `scripts/popup-e2e.mjs` — jsdom end-to-end drive of the real bundle: onboarding, vault, multi-account, address book, and a full send against a mocked node (broadcast body inspected); live-data checks auto-skip when the node is unreachable.
