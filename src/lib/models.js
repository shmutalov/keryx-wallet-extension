// Inference model registry — the H4 lineup. Mirrors keryx-node's
// `consensus/core/src/config/params.rs` (model ids = CIDv0[2..34] of each pinned
// GGUF; base prices = INFERENCE_REWARD_MINIMUMS_V2_H4) and keryx-miner's
// `src/models.rs`. Keep this in lockstep with those; the shim resolves unknown
// ids to raw hex, and capabilities/feed fall back to id-hex matching. Live miner
// counts come from GET /api/v1/capabilities at runtime.

export const INFERENCE_MODELS = [
  {
    key: 'exaone-4.0-1.2b',
    label: 'EXAONE-4.0-1.2B · uncensored · 1.2B (Q4_K_M)',
    name: 'EXAONE-4.0-1.2B (uncensored)',
    idHex: '300a99b3a85b0ab45d1d930bb7b1d4b0f35983d521e79ff21193a6908dc4b810',
    baseSompi: 50000000, // 0.5 KRX  (--very-light)
  },
  {
    key: 'mistral-7b-v0.3',
    label: 'Mistral-7B-v0.3 · uncensored · 7B (Q6_K)',
    name: 'Mistral-7B-v0.3 (uncensored)',
    idHex: '8c2fea600f0eefe7048741a5119cb7be303037f59fc026e48382658f23581e0a',
    baseSompi: 100000000, // 1.0 KRX  (--light)
  },
  {
    key: 'glm-4-9b-0414',
    label: 'GLM-4-9B-0414 · uncensored · 9B (Q6_K)',
    name: 'GLM-4-9B-0414 (uncensored)',
    idHex: 'fa2f13be0850e26c5ce86c7ac79da85e300c1da8b3290f9a18d47105f1f2140a',
    baseSompi: 150000000, // 1.5 KRX  (default)
  },
  {
    key: 'qwen3.6-27b',
    label: 'Qwen3.6-27B · uncensored · 27B (Q4_K_M)',
    name: 'Qwen3.6-27B (uncensored)',
    idHex: 'b8bdc01fa407eab943e4fefc807483b39f8142785256049e1f559698a5284746',
    baseSompi: 250000000, // 2.5 KRX  (--high)
  },
  {
    key: 'kimi-linear-48b',
    label: 'Kimi-Linear-48B · uncensored · 48B-A3B MoE (Q4_K_M)',
    name: 'Kimi-Linear-48B (uncensored)',
    idHex: '3dc09358ad75c6ef0c9c86ee4f47c4d6acda961fecbd0e4f9cf55e8f0fdffddb',
    baseSompi: 400000000, // 4.0 KRX  (--very-high)
  },
];

export const TOKEN_SURCHARGE_PER_64 = 5000000; // 0.05 KRX per 64 max_tokens

export function getModel(key) {
  return INFERENCE_MODELS.find((m) => m.key === key);
}

/**
 * Resolve a model by its on-chain id (hex). Fallback for when the API host's
 * own model registry is out of sync with ours and returns a raw model id
 * instead of the key — see api.capabilities()/inferences().
 */
export function getModelByIdHex(idHex) {
  const h = (idHex ?? '').toLowerCase();
  return INFERENCE_MODELS.find((m) => m.idHex === h);
}

/** Escrow amount (the "inference reward"): model base price + token surcharge. */
export function inferenceRewardSompi(modelKey, maxTokens) {
  const model = getModel(modelKey);
  if (!model) throw new Error(`Unknown model: ${modelKey}`);
  return model.baseSompi + TOKEN_SURCHARGE_PER_64 * Math.ceil(maxTokens / 64);
}
