# Privacy Policy — Keryx Wallet

**Effective date: October 28, 2026**

Keryx Wallet is a browser extension for the Keryx Network (KRX). It is designed so that your data never leaves your device.

## Data we collect

**None.** Keryx Wallet does not collect, transmit, sell, or share any personal information, usage data, or analytics. There are no user accounts, no tracking, no advertising identifiers, and no third-party services.

## Data stored on your device

The extension stores the following **only in your browser's local extension storage**, on your device:

- Your wallet seed phrases, encrypted with a password you choose (PBKDF2-SHA256 with 600,000 iterations deriving an AES-256-GCM key). The password itself is never stored.
- Your address book (names and Keryx addresses you save) and a short list of recently used destination addresses.
- Interface state such as the selected account.
- The list of websites you have explicitly connected to the wallet (see "Website access" below), with the account you granted each one.
- Your private AI inference requests (the prompt, the decrypted answer and the transaction reference), so their answers can be shown when you reopen the wallet — encrypted with AES-256-GCM under a key derived from the account's private key, readable only while the wallet is unlocked.

While the wallet is unlocked, decrypted keys are held only in memory-backed session storage and are erased after 15 minutes of inactivity, when you lock the wallet, or when the browser closes. Choosing "Reset wallet" deletes all stored data permanently.

## Network requests

The extension communicates with exactly one API host: `keryx-labs.com` (the public Keryx node API) by default, or — only if you explicitly configure one under **Settings → Network** — a custom API host of your choosing, such as your own self-hosted Keryx node/indexer. The requests are:

- Reading public blockchain data (balances, UTXOs, transaction history, network status, market price) for the addresses in your wallet.
- Broadcasting transactions that you created and signed locally.
- For AI inference: reading the public list of miners serving each model, and fetching the encrypted answers to your requests.

Like any blockchain query service, the operator of the API host you use can technically observe which addresses your installation looks up. No private keys, seed phrases, passwords, or personal information are ever transmitted. Since the Keryx H14 network upgrade, AI inference prompts are encrypted in your browser to the miners serving the chosen model before they are broadcast, and answers are encrypted to your wallet and decrypted locally — neither the API host nor anyone else on the network can read them.

## Website access (`window.keryx` provider)

So that Keryx applications can request payments and signatures, the extension makes a small script available on web pages that exposes a `window.keryx` API — the same pattern used by other wallet extensions. This script:

- **Does not read, collect, or modify page content**, browsing history, form data, or anything else on the sites you visit. It only listens for explicit `window.keryx` API calls made by the page itself.
- Reveals **nothing** about you or your wallet to a website until you approve that site's connection request in a wallet-controlled popup. Until then, a site cannot even tell whether you have a wallet configured.
- After you connect a site, that site can see the connected account's address, public key, balance, and UTXO list, and may *request* transactions or signatures — every such request requires your explicit approval in a wallet popup that shows the requesting site and the full details.
- Connections are stored only on your device and can be revoked at any time under **Settings → Connected sites**.

## Links

**Settings → About & support** links to this wallet's store page (to leave a review), its source code and issue tracker on GitHub, the Keryx miner download, and an exchange that lists KRX. A link opens in a normal browser tab only when you click it; the extension sends no data with it. Sites opened this way are third parties with their own privacy policies.

The Receive screen's **Phone** QR code holds a link to your address's public page on the keryx-labs.com explorer. The extension doesn't open it; a phone that scans the code does, in its own browser.

## Clipboard

The extension writes to your clipboard only when you explicitly click a copy button (for an address or seed phrase). It never reads your clipboard.

## Permissions

- `storage` — persist the encrypted vault and address book locally
- `alarms` — run the inactivity auto-lock timer
- `clipboardWrite` — copy addresses/seed phrase on your explicit click
- host access to `keryx-labs.com` — the node API described above
- content-script access to websites — solely to expose the `window.keryx` provider API described above; no page data is read or transmitted

## Changes

Any changes to this policy will be published at this URL with an updated effective date. The extension's full source code is available at https://github.com/shmutalov/keryx-wallet-extension for independent verification.

## Contact

Questions or concerns: open an issue at https://github.com/shmutalov/keryx-wallet-extension/issues
