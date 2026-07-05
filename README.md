# Keryx Wallet — Chrome Extension

A client-side Chrome (MV3) extension wallet for the **Keryx Network** (PoW/PoM blockchain, ticker **KRX**), styled after and protocol-compatible with the official web wallet at [keryx-labs.com/wallet](https://keryx-labs.com/wallet).

Private keys are derived and stored **only on your device** — the extension talks to the public Keryx node API for read-only data.

## Features (phase 1)

- **Create a new wallet** — generates a 24-word BIP39 mnemonic, shows the derived `keryx:` address, and encrypts the mnemonic with a session password.
- **Import a wallet** — accepts a 12- or 24-word BIP39 mnemonic.
- **Balance dashboard** — live KRX balance (auto-refresh every 15 s), approximate USD value, UTXO count with consolidation hint, network DAA score, and paginated transaction history linking to the explorer.
- **Lock / auto-lock** — decrypted keys live only in `chrome.storage.session` (in-memory); a background alarm enforces a 15-minute inactivity auto-lock. "Lock" keeps the encrypted vault; "Disconnect" removes it.

Planned for phase 2: KRX transfer, UTXO consolidation, AI inference queries (see [docs/PROTOCOL.md](docs/PROTOCOL.md) — the full transaction-signing protocol is already documented there).

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

- The mnemonic is encrypted with **PBKDF2-SHA256 (600,000 iterations) → AES-256-GCM** — the same scheme as the official web wallet — and stored in `chrome.storage.local`.
- The decrypted mnemonic exists only in `chrome.storage.session` (memory-backed, cleared when the browser exits) and is wiped after 15 minutes of inactivity.
- No keys, mnemonics, or passwords are ever sent over the network; the only remote host is `https://keryx-labs.com` (read-only API in phase 1).

## CI / Deploy

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every push and PR: `npm ci` → build → jsdom end-to-end test against the live network → uploads the packaged `keryx-wallet-extension.zip` as a workflow artifact.

Pushing a `v*` tag deploys the **exact artifact that was tested**: it is attached to an auto-generated GitHub Release, and — if the `CWS_EXTENSION_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` repository secrets are configured — published to the Chrome Web Store. Without those secrets the store step is skipped silently.

```
git tag v0.1.0 && git push origin v0.1.0
```

## Verification

The address codec was validated against the live network: mainnet richlist addresses decode, checksum-verify, and re-encode byte-identically, and freshly derived addresses are accepted by the public node API.
