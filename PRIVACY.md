# Privacy Policy — Keryx Wallet

**Effective date: July 6, 2026**

Keryx Wallet is a browser extension for the Keryx Network (KRX). It is designed so that your data never leaves your device.

## Data we collect

**None.** Keryx Wallet does not collect, transmit, sell, or share any personal information, usage data, or analytics. There are no user accounts, no tracking, no advertising identifiers, and no third-party services.

## Data stored on your device

The extension stores the following **only in your browser's local extension storage**, on your device:

- Your wallet seed phrases, encrypted with a password you choose (PBKDF2-SHA256 with 600,000 iterations deriving an AES-256-GCM key). The password itself is never stored.
- Your address book (names and Keryx addresses you save) and a short list of recently used destination addresses.
- Interface state such as the selected account.

While the wallet is unlocked, decrypted keys are held only in memory-backed session storage and are erased after 15 minutes of inactivity, when you lock the wallet, or when the browser closes. Choosing "Reset wallet" deletes all stored data permanently.

## Network requests

The extension communicates with exactly one host: `keryx-labs.com`, the public Keryx node API. The requests are:

- Reading public blockchain data (balances, UTXOs, transaction history, network status, market price) for the addresses in your wallet.
- Broadcasting transactions that you created and signed locally.

Like any blockchain query service, the node operator can technically observe which addresses your installation looks up. No private keys, seed phrases, passwords, or personal information are ever transmitted.

## Clipboard

The extension writes to your clipboard only when you explicitly click a copy button (for an address or seed phrase). It never reads your clipboard.

## Permissions

- `storage` — persist the encrypted vault and address book locally
- `alarms` — run the inactivity auto-lock timer
- `clipboardWrite` — copy addresses/seed phrase on your explicit click
- host access to `keryx-labs.com` — the node API described above

## Changes

Any changes to this policy will be published at this URL with an updated effective date. The extension's full source code is available at https://github.com/shmutalov/keryx-wallet-extension for independent verification.

## Contact

Questions or concerns: open an issue at https://github.com/shmutalov/keryx-wallet-extension/issues
