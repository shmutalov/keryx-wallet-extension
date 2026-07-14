# Keryx Wallet — examples

Runnable dApp integration demos for the `window.keryx` provider (see
[../docs/PROVIDER.md](../docs/PROVIDER.md) for the full API).

## `sign-message.html`

Connect an account and sign a message end-to-end: detect the provider →
`requestAccounts()` → `signMessage()` → show the BIP340 signature.

**The provider is injected only into top-level `http(s)` pages** — not `file://`
and not iframes — so serve the folder over HTTP rather than double-clicking the
file:

```sh
# from the repo root, any static server works:
npx serve examples          # → http://localhost:3000/sign-message.html
# or
python -m http.server -d examples 8080   # → http://localhost:8080/sign-message.html
```

Then open the printed URL in a browser that has the Keryx Wallet extension
installed and unlocked. Signing opens the wallet's approval popup.
