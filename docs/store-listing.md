# Chrome Web Store listing copy

## Short description (max 132 chars)

Client-side wallet for the Keryx Network. Create or import a KRX wallet, track balances, and send — keys never leave your device.

## Detailed description

Keryx Wallet is a lightweight, fully client-side wallet for the Keryx Network (KRX) — the PoW/PoM blockchain with on-chain AI inference.

Your keys, your device. Seed phrases are generated locally, encrypted with your password (PBKDF2, 600,000 iterations + AES-256-GCM), and never transmitted anywhere. The extension talks only to the public Keryx node API to read balances and broadcast transactions you sign locally.

FEATURES

⊕ Create a wallet — 24-word BIP39 seed phrase with a guided backup step
↩ Import a wallet — restore from any 12- or 24-word BIP39 phrase
⧉ Multiple accounts — derive extra addresses from one seed or add separate seeds, all secured by a single session password; switch and rename them freely
◈ Live dashboard — KRX balance with USD estimate, UTXO count, network status indicator, and paginated transaction history linked to the explorer
➤ Send KRX — transactions are built and signed entirely in your browser (BIP340 Schnorr, Kaspa-style sighash) and broadcast to the network
⌂ Address book — save named addresses; the send screen suggests saved and recently used destinations as you type
🔒 Auto-lock — unlocked keys live only in memory and are wiped after 15 minutes of inactivity, when you lock manually, or when the browser closes

PRIVACY

No analytics, no tracking, no accounts, no data collection. The only network host contacted is keryx-labs.com (the public node API). The full source code is open: https://github.com/shmutalov/keryx-wallet-extension

DISCLAIMER

Keryx Wallet is community-built software provided as-is. Always back up your seed phrase — it is the only way to recover your funds. Never share it with anyone.

## Permission justifications (privacy tab)

- storage — persist the password-encrypted wallet vault and address book on the user's device
- alarms — run the 15-minute inactivity auto-lock timer in the background service worker
- clipboardWrite — copy addresses and the seed phrase to the clipboard on explicit user click
- host permission https://keryx-labs.com/* — read balances/UTXOs/history from the public Keryx node API and broadcast user-signed transactions

Data collection: none. All user data stays on-device; no remote logging or analytics.
