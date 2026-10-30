# Chrome Web Store listing

Listing: https://chromewebstore.google.com/detail/keryx-wallet/hoobkmlannjlgaajjlhjagdbmijggcab

The listing comes from three places — keep them in step when features change.

| Part | Source | How it reaches the store |
|---|---|---|
| Name and summary, all 7 languages | `ext_name` / `ext_description` in [`_locales/*/messages.json`](../../_locales) | ships with the next package version (pushing a `v*` tag) |
| Detailed description | one paste-ready file per language: [`en.txt`](en.txt), [`de.txt`](de.txt), [`es.txt`](es.txt), [`fr.txt`](fr.txt), [`pt_BR.txt`](pt_BR.txt), [`ru.txt`](ru.txt), [`zh_CN.txt`](zh_CN.txt) | pasted in the dashboard: **Store listing → language picker → Description** |
| Screenshots and promo tiles | [`docs/store-assets/`](../store-assets), rendered by `npm run store-assets` | uploaded in the dashboard |

The store caps the summary at 132 characters; `npm test` (check 25l) fails when a locale goes over. Name and summary carry the security promise, so translations need a native check (the catalogs flag `ext_description` as SAFETY-CRITICAL).

## Publishing order

1. In the dashboard, paste the 7 descriptions, upload the media, and save.
2. Release the version that ships the new name and summary (push the `v*` tag; CI uploads and publishes).
3. If the dashboard still shows unsubmitted listing changes afterwards, press **Submit for review**.

The descriptions point to **Settings → About & support**, which ships in that same release — don't publish them on an older version.

## Media

`npm run store-assets` renders every image from the real extension bundle (built first): a local server stages a demo wallet and a mocked node, headless Chrome or Edge photographs each screen, and the PNGs are saved as 24-bit RGB, since the store rejects images with an alpha channel. `npm run store-assets -- en ru` limits it to some locales; `BROWSER=<path>` picks the browser. Re-run it after UI changes. Captions and the demo AI prompt live in [`scripts/store-assets/captions.js`](../../scripts/store-assets/captions.js).

| File | Size | Upload to |
|---|---|---|
| `screenshots/<locale>/1-dashboard.png` … `5-approval.png` | 1280×800 | Store listing → that language → Screenshots, in number order. English also serves every language without its own set. |
| `promo-tile-440x280.png` | 440×280 | Small promo tile (required for any featured placement) |
| `marquee-1400x560.png` | 1400×560 | Marquee promo tile |

The five screens: dashboard, private AI, Consolidate, Receive (Phone mode), and a dApp payment approval. The demo wallet is the public BIP39 test-vector mnemonic; its address in the images is empty, and nobody should fund it.

## Other dashboard fields

- **Homepage URL:** https://github.com/shmutalov/keryx-wallet-extension (until a website exists)
- **Support URL:** https://github.com/shmutalov/keryx-wallet-extension/issues
- **Category:** Workflow & Planning (where MetaMask is listed too)

## Permission justifications (privacy tab)

- storage — persist the password-encrypted wallet vault and address book on the user's device
- alarms — run the 15-minute inactivity auto-lock timer in the background service worker
- clipboardWrite — copy addresses and the seed phrase to the clipboard on explicit user click
- host permission https://keryx-labs.com/* — read balances/UTXOs/history from the public Keryx node API and broadcast user-signed transactions
- content scripts on all sites — inject the standard `window.keryx` wallet-provider API (same pattern as other crypto-wallet extensions) so Keryx applications can request payments and signatures; the script does not read or modify page content, and a site learns nothing until the user approves its connection request in a wallet-controlled popup. Details: https://github.com/shmutalov/keryx-wallet-extension/blob/master/docs/PROVIDER.md

Data collection: none. All user data stays on-device; no remote logging or analytics.
