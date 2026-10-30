// Store-asset staging: loaded before the real popup/approval bundle by build.mjs (never
// shipped). It supplies an in-memory chrome.* holding an unlocked demo wallet, a mocked
// node API with demo data (window.STAGE), and the clicks that open the chosen screen.
// URL: ?scene=dashboard|ai|consolidate|receive|approval&locale=<catalog>
(() => {
  const S = window.STAGE;
  const query = new URLSearchParams(location.search);
  const scene = query.get('scene') ?? 'dashboard';
  const locale = query.get('locale') ?? 'en';

  // --- chrome.* ------------------------------------------------------------------
  const local = { ...S.local, krx_locale: locale };
  if (scene === 'receive') local.krx_receive_mode = 'phone';
  const session = { ...S.session, krx_unlocked: { ...S.session.krx_unlocked, lastActive: Date.now() } };
  const area = (store) => ({
    get: async (keys) => {
      if (keys == null) return structuredClone(store);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
    },
    set: async (items) => void Object.assign(store, structuredClone(items)),
    remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
  });
  window.chrome = {
    storage: { local: area(local), session: area(session) },
    runtime: {
      id: 'store-assets',
      getURL: (path) => `/ext/${path}`,
      getManifest: () => ({ version: S.version }),
      sendMessage: async () => undefined,
    },
  };

  // --- node API ------------------------------------------------------------------
  const json = (body, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/v1/')) return realFetch(input, init);
    const path = url.pathname.slice('/api/v1'.length);
    if (path === '/info') return json({ network: 'keryx-mainnet', last_daa_score: S.daa });
    if (path === '/market') return json({ price_usd: S.priceUsd });
    if (path.endsWith('/balance')) return json({ address: S.address, balance_sompi: S.balance });
    if (path.endsWith('/utxos/count')) return json({ count: S.utxos.length });
    if (path.endsWith('/utxos')) return json(S.utxos);
    if (path.startsWith('/addresses/')) {
      const limit = Number(url.searchParams.get('limit') ?? 10);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return json({ address: S.address, total_tx_count: S.txCount, transactions: S.history.slice(offset, offset + limit) });
    }
    if (path === '/capabilities') return json(S.capabilities);
    if (path === '/ai/providers') return json({ cohort: [], window: [] });
    if (path === '/infer' || path === '/challenges') return json([]);
    return json({ error: 'not found' }, 404);
  };

  // --- look: the designed face, no scrollbars in a still image ----------------------
  const font = Object.assign(document.createElement('link'), {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=block',
  });
  const style = Object.assign(document.createElement('style'), {
    textContent: '::-webkit-scrollbar { width: 0 !important; height: 0 !important; }',
  });
  document.head.append(font, style);

  // --- open the scene --------------------------------------------------------------
  const until = (fn, tries = 100) => new Promise((resolve) => {
    const tick = (left) => {
      const value = fn();
      if (value || !left) resolve(value);
      else setTimeout(() => tick(left - 1), 50);
    };
    tick(tries);
  });
  const byId = (id) => document.getElementById(id);
  const scenes = {
    ai: async () => {
      (await until(() => byId('inference-btn')))?.click();
      const prompt = await until(() => byId('inf-prompt'));
      prompt.value = S.prompts[locale] ?? S.prompts.en;
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    },
    consolidate: async () => (await until(() => byId('consolidate-btn')))?.click(),
    receive: async () => (await until(() => byId('receive-btn')))?.click(), // opens in Phone mode (stored above)
  };
  window.addEventListener('load', () => scenes[scene]?.());
})();
