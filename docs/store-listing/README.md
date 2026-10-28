# Chrome Web Store listing

Listing: https://chromewebstore.google.com/detail/keryx-wallet/hoobkmlannjlgaajjlhjagdbmijggcab

The listing comes from three places — keep them in step when features change.

| Part | Source | How it reaches the store |
|---|---|---|
| Name and summary, all 7 languages | `ext_name` / `ext_description` in [`_locales/*/messages.json`](../../_locales) | ships with the next package version (pushing a `v*` tag) |
| Detailed description | one paste-ready file per language: [`en.txt`](en.txt), [`de.txt`](de.txt), [`es.txt`](es.txt), [`fr.txt`](fr.txt), [`pt_BR.txt`](pt_BR.txt), [`ru.txt`](ru.txt), [`zh_CN.txt`](zh_CN.txt) | pasted in the dashboard: **Store listing → language picker → Description** |
| Screenshots, promo tiles, video | [`docs/promo/`](../promo) | uploaded in the dashboard |

The store caps the summary at 132 characters; `npm test` (check 25l) fails when a locale goes over. Name and summary carry the security promise, so translations need a native check (the catalogs flag `ext_description` as SAFETY-CRITICAL).

## Publishing order

1. In the dashboard, paste the 7 descriptions, upload the media, and save.
2. Release the version that ships the new name and summary (push the `v*` tag; CI uploads and publishes).
3. If the dashboard still shows unsubmitted listing changes afterwards, press **Submit for review**.

The descriptions point to **Settings → About & support**, which ships in that same release — don't publish them on an older version.

## Media checklist

Screenshots: 1280×800 (or 640×400), PNG or JPEG, up to 5, captions drawn into the image.

1. Dashboard — "Your KRX, one click from any tab"
2. Private AI — "Ask private AI, pay per question in KRX"
3. Send + address book — "Signed in your browser, keys stay on your device"
4. dApp approval window — "You approve every dApp request"
5. Accounts + language picker — "Multiple accounts, 7 languages"

Also: small promo tile 440×280 (required for any featured placement), marquee 1400×560, and an optional 30–60 s YouTube demo.

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
