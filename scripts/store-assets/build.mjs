// Renders the Chrome Web Store screenshots (1280×800, per locale) and promo tiles
// (440×280, 1400×560) from the real extension bundle: a local server serves extension/
// with stage.js injected (demo wallet, mocked node API), a headless Chromium browser
// photographs each frame, and every PNG is re-encoded as 24-bit RGB — the store
// rejects images with an alpha channel.
//
//   npm run store-assets            all locales
//   npm run store-assets -- en ru   only these
//
// Output: docs/store-assets/. Set BROWSER=<path> to pick the browser binary.
import { createServer } from 'http';
import { execFile, execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import { crc32, deflateSync, inflateSync } from 'zlib';
import { addressToScriptPublicKey, deriveWallet } from '../../src/lib/keryx.js';
import { selectableModels, H15_ACTIVATION_DAA } from '../../src/lib/models.js';
import { CAPTIONS, PROMPTS, SCENES } from './captions.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EXT = join(ROOT, 'extension');
const ASSETS = join(ROOT, 'scripts', 'store-assets');
const OUT = join(ROOT, 'docs', 'store-assets');

// --- demo data -------------------------------------------------------------------
// The BIP39 test-vector mnemonic: a public, empty wallet — never fund it.
const DEMO_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const mining = deriveWallet(DEMO_MNEMONIC, 0);
const payee = deriveWallet(DEMO_MNEMONIC, 7).address; // the demo dApp's payment address
const DAA = H15_ACTIVATION_DAA + 1_200_000;
const DEMO_ORIGIN = 'https://dapp.example';

let seed = 20261030; // deterministic "random" amounts, so re-runs give the same images
const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const hex64 = () => Array.from({ length: 64 }, () => Math.floor(rand() * 16).toString(16)).join('');
const spk = addressToScriptPublicKey(mining.address);
// 211 pool payouts plus 3 solo-mined rewards still inside coinbase maturity
const utxos = Array.from({ length: 214 }, (_, i) => ({
  transaction_id: hex64(),
  index: 0,
  amount_sompi: Math.round((38 + rand() * 82) * 1e8),
  script_version: 0,
  script_public_key: spk,
  block_daa_score: i < 211 ? DAA - 50_000 - i * 400 : DAA - 300,
  is_coinbase: i >= 211,
}));
const balance = utxos.reduce((s, u) => s + u.amount_sompi, 0);
const history = [
  { amount: 11284112050, spend: false },
  { amount: 10927390811, spend: false },
  { amount: 25030000000, spend: true },
  ...utxos.slice(0, 17).map((u) => ({ amount: u.amount_sompi, spend: false })),
].map(({ amount, spend }, i) => ({
  tx_id: hex64(), amount_sompi: amount, is_spend: spend, daa_score: DAA - i * 900, block_hash: hex64(),
}));
const minerCounts = [26, 21, 11, 11, 9];
const config = {
  version: JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).version,
  daa: DAA,
  priceUsd: 0.00081,
  address: mining.address,
  balance,
  utxos,
  history,
  txCount: 1284,
  capabilities: selectableModels(true).map((m, i) => ({
    model: m.key, model_id_hex: m.idHex, miner_count: minerCounts[i] ?? 5, last_seen_daa: DAA - 20,
  })),
  captions: CAPTIONS,
  prompts: PROMPTS,
  local: {
    krx_sess: { v: 2, demo: true }, // presence is all the popup checks before using the session
    krx_active: 'acct-1',
    krx_connected: {
      [DEMO_ORIGIN]: { accountId: 'acct-1', address: mining.address, publicKeyHex: mining.publicKeyHex, connectedAt: 0 },
    },
  },
  session: {
    krx_unlocked: {
      store: {
        accounts: [
          { id: 'acct-1', label: 'Mining', mnemonic: DEMO_MNEMONIC, index: 0 },
          { id: 'acct-2', label: 'Savings', mnemonic: DEMO_MNEMONIC, index: 1 },
        ],
      },
      rawKeyHex: '00'.repeat(32),
    },
    krx_pending: {
      demo: { id: 'demo', type: 'send', origin: DEMO_ORIGIN, params: { toAddress: payee, sompi: 250_00000000 } },
    },
  },
};

// --- local server ----------------------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/assets/stage-config.js') {
    res.writeHead(200, { 'Content-Type': TYPES['.js'] }).end(`window.STAGE = ${JSON.stringify(config)};`);
    return;
  }
  const [base, rel] = pathname.startsWith('/ext/') ? [EXT, pathname.slice(5)]
    : pathname.startsWith('/assets/') ? [ASSETS, pathname.slice(8)] : [null, null];
  const file = base && normalize(join(base, decodeURIComponent(rel)));
  if (!file || !file.startsWith(base) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  let body = readFileSync(file);
  if (/(popup|approval)\.html$/.test(file)) {
    // staging must run before the bundle
    body = String(body).replace(/<script src="(popup|approval)\.js"><\/script>/,
      '<script src="/assets/stage-config.js"></script><script src="/assets/stage.js"></script>$&');
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
});

// --- browser ---------------------------------------------------------------------
const BROWSERS = [
  process.env.BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
].filter(Boolean);
const BROWSER = BROWSERS.find((b) => existsSync(b));
if (!BROWSER) throw new Error('No Chrome/Chromium/Edge found — set BROWSER=<path to the binary>');
const profile = mkdtempSync(join(tmpdir(), 'keryx-store-assets-'));

const capture = (url, file, [width, height]) => new Promise((resolve, reject) => {
  execFile(BROWSER, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--window-size=${width},${height}`, '--force-device-scale-factor=1',
    '--virtual-time-budget=15000', `--screenshot=${file}`, url,
  ], { timeout: 120000 }, (err) => {
    if (err && !existsSync(file)) return reject(err);
    try {
      const size = toRgbPng(file);
      if (size.width !== width || size.height !== height) {
        return reject(new Error(`${file}: ${size.width}×${size.height}, expected ${width}×${height}`));
      }
      resolve();
    } catch (e) {
      reject(e);
    }
  });
});

// --- 24-bit PNG ------------------------------------------------------------------
/** Rewrites an 8-bit RGBA PNG as RGB (the browser's screenshots are opaque anyway). */
function toRgbPng(file) {
  const png = readFileSync(file);
  let pos = 8;
  let width, height, colorType;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error(`${file}: expected 8-bit, non-interlaced PNG`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (colorType === 2) return { width, height };
  if (colorType !== 6) throw new Error(`${file}: unexpected PNG color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgb = Buffer.alloc((width * 3 + 1) * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) { // undo the PNG row filter in place
      const a = x >= 4 ? line[x - 4] : 0;
      const b = prev[x];
      const c = x >= 4 ? prev[x - 4] : 0;
      if (filter === 1) line[x] += a;
      else if (filter === 2) line[x] += b;
      else if (filter === 3) line[x] += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        line[x] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
    }
    const o = y * (width * 3 + 1); // filter byte 0, then RGB
    for (let x = 0; x < width; x++) line.copy(rgb, o + 1 + x * 3, x * 4, x * 4 + 3);
    prev = line;
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  writeFileSync(file, Buffer.concat([
    png.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rgb, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]));
  return { width, height };
}

// --- run -------------------------------------------------------------------------
const locales = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CAPTIONS);
const unknown = locales.filter((l) => !CAPTIONS[l]);
if (unknown.length) throw new Error(`No captions for: ${unknown.join(', ')}`);

execFileSync(process.execPath, [join(ROOT, 'build.mjs')], { cwd: ROOT, stdio: 'inherit' }); // fresh bundle
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log(`Rendering with ${BROWSER}`);
try {
  mkdirSync(OUT, { recursive: true });
  await capture(`${origin}/assets/tile-small.html`, join(OUT, 'promo-tile-440x280.png'), [440, 280]);
  await capture(`${origin}/assets/marquee.html`, join(OUT, 'marquee-1400x560.png'), [1400, 560]);
  console.log('promo tiles: done');
  for (const locale of locales) {
    const dir = join(OUT, 'screenshots', locale);
    mkdirSync(dir, { recursive: true });
    for (const [i, scene] of SCENES.entries()) {
      await capture(`${origin}/assets/frame.html?scene=${scene}&locale=${locale}`, join(dir, `${i + 1}-${scene}.png`), [1280, 800]);
    }
    console.log(`${locale}: ${SCENES.length} screenshots`);
  }
} finally {
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(`Written to ${OUT}`);
