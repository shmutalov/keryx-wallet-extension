// Inference model registry — the H6 lineup. Mirrors keryx-node's
// `consensus/core/src/config/params.rs` (model ids = CIDv0[2..34] of each pinned
// GGUF; base prices = INFERENCE_REWARD_MINIMUMS_V2_H6) and keryx-miner's
// `src/models.rs`. Keep this in lockstep with those; the shim resolves unknown
// ids to raw hex, and capabilities/feed fall back to id-hex matching. Live miner
// counts come from GET /api/v1/capabilities at runtime.
//
// H6 (`POM_TIERS_H6`, gated by `pom_v3_activation`, mainnet DAA 76,316,623) keeps
// 5 tiers: tier 0 = Qwen3.5-9B-abliterated (replaces BOTH Qwen3-8B and
// Mistral-7B), tier 1 = GLM-4-9B (slides from position 2), tier 2 =
// gemma-4-12B-abliterated (NEW, 16 GB cards, the new default), tiers 3-4
// unchanged. There is no sub-1-KRX tier anymore. Retired entries stay listed
// (`retired: true`) so historical feed rows still render by name — the picker
// filters them out, no miner serves them post-H6.

export const INFERENCE_MODELS = [
  {
    key: 'qwen3.5-9b-abliterated',
    label: 'Qwen3.5-9B · uncensored · 9B (Q5_K_M)',
    name: 'Qwen3.5-9B (uncensored)',
    idHex: 'bd34568cd89f5f19c6c3a6e1a61b929bc868709409eaad8e672d85f3c1eb5710',
    baseSompi: 100000000, // 1.0 KRX  (--very-light)
  },
  {
    // Retired at H6 (the H5 tier 0) — kept for historical AiRequest decode only.
    key: 'qwen3-8b-abliterated',
    label: 'Qwen3-8B · uncensored · 8B (Q4_K_S)',
    name: 'Qwen3-8B (uncensored)',
    idHex: 'd42fa6ee00e07d49b046090a56af0e7bd61025937c502e2c574a72874c350d24',
    baseSompi: 50000000, // 0.5 KRX  (was --very-light)
    retired: true,
  },
  {
    // Retired at H5 (the H4 tier 0) — kept for historical AiRequest decode only.
    key: 'exaone-4.0-1.2b',
    label: 'EXAONE-4.0-1.2B · uncensored · 1.2B (Q4_K_M)',
    name: 'EXAONE-4.0-1.2B (uncensored)',
    idHex: '300a99b3a85b0ab45d1d930bb7b1d4b0f35983d521e79ff21193a6908dc4b810',
    baseSompi: 50000000, // 0.5 KRX  (was --very-light)
    retired: true,
  },
  {
    // Retired at H6 (the H4/H5 tier 1) — kept for historical AiRequest decode only.
    key: 'mistral-7b-v0.3',
    label: 'Mistral-7B-v0.3 · uncensored · 7B (Q6_K)',
    name: 'Mistral-7B-v0.3 (uncensored)',
    idHex: '8c2fea600f0eefe7048741a5119cb7be303037f59fc026e48382658f23581e0a',
    baseSompi: 100000000, // 1.0 KRX  (was --light)
    retired: true,
  },
  {
    key: 'glm-4-9b-0414',
    label: 'GLM-4-9B-0414 · uncensored · 9B (Q6_K)',
    name: 'GLM-4-9B-0414 (uncensored)',
    idHex: 'fa2f13be0850e26c5ce86c7ac79da85e300c1da8b3290f9a18d47105f1f2140a',
    baseSompi: 150000000, // 1.5 KRX  (--light)
  },
  {
    key: 'gemma-4-12b-abliterated',
    label: 'gemma-4-12B · uncensored · 12B (Q6_K)',
    name: 'gemma-4-12B (uncensored)',
    idHex: '399984045600f7d58d1b2cf01e6a4bf466fa15c7ac31bd0dd1a71e003b617cc6',
    baseSompi: 200000000, // 2.0 KRX  (default)
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

/** The models a new AiRequest may be sent to (the current lineup, retired ones dropped). */
export const SELECTABLE_MODELS = INFERENCE_MODELS.filter((m) => !m.retired);

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

/** Reward-vault amount (the "inference_reward"): model base price + token surcharge. */
export function inferenceRewardSompi(modelKey, maxTokens) {
  const model = getModel(modelKey);
  if (!model) throw new Error(`Unknown model: ${modelKey}`);
  return model.baseSompi + TOKEN_SURCHARGE_PER_64 * Math.ceil(maxTokens / 64);
}
