// Inference model registry — the H6 lineup, and the H14 lineup from the
// private-inference hardfork on. Mirrors keryx-node's
// `consensus/core/src/config/params.rs` (model ids = CIDv0[2..34] of each pinned
// GGUF; reward floors = INFERENCE_REWARD_MINIMUMS_V2_H6 before H14,
// INFERENCE_REWARD_MINIMUMS_FLAT from H14 on; tiers = POM_TIERS_H6 /
// POM_TIERS_H14) and keryx-miner's `src/models.rs`. Keep this in lockstep with
// those; the shim resolves unknown ids to raw hex, and capabilities/feed fall
// back to id-hex matching. Live miner counts come from GET /api/v1/capabilities
// and the miners a sealed request goes to from GET /api/v1/ai/providers.
//
// H6 (`POM_TIERS_H6`, gated by `pom_v3_activation`, mainnet DAA 76,316,623) keeps
// 5 tiers: tier 0 = Qwen3.5-9B-abliterated (replaces BOTH Qwen3-8B and
// Mistral-7B), tier 1 = GLM-4-9B (slides from position 2), tier 2 =
// gemma-4-12B-abliterated (NEW, 16 GB cards, the new default), tiers 3-4
// unchanged.
//
// H14 (`private_inference_activation`, mainnet DAA 121,985,000) swaps tier 3 to
// Qwen3.8-27B and replaces the per-token pricing with a fixed reward per model:
// 0.5 KRX for tier 0, 0.5 KRX more per tier, whatever max_tokens. Retired
// entries stay listed (`retired: true`) so historical feed rows still render
// by name — the picker filters them out, no miner serves them anymore. `era`
// marks a model that only one side of the H14 gate serves.

/** keryx-node `private_inference_activation` on mainnet (H14). */
export const H14_ACTIVATION_DAA = 121985000;

/** Whether the H14 rules (sealed prompts, flat rewards, tier-3 swap) govern a request at `daaScore`. */
export const isH14Active = (daaScore) => daaScore >= H14_ACTIVATION_DAA;

export const INFERENCE_MODELS = [
  {
    key: 'qwen3.5-9b-abliterated',
    label: 'Qwen3.5-9B · uncensored · 9B (Q5_K_M)',
    name: 'Qwen3.5-9B (uncensored)',
    idHex: 'bd34568cd89f5f19c6c3a6e1a61b929bc868709409eaad8e672d85f3c1eb5710',
    tier: 0,
    baseSompi: 100000000, // 1.0 KRX + token surcharge before H14  (--very-light)
    flatSompi: 50000000, //  0.5 KRX from H14
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
    tier: 1,
    baseSompi: 150000000, // 1.5 KRX  (--light)
    flatSompi: 100000000, // 1.0 KRX
  },
  {
    key: 'gemma-4-12b-abliterated',
    label: 'gemma-4-12B · uncensored · 12B (Q6_K)',
    name: 'gemma-4-12B (uncensored)',
    idHex: '399984045600f7d58d1b2cf01e6a4bf466fa15c7ac31bd0dd1a71e003b617cc6',
    tier: 2,
    baseSompi: 200000000, // 2.0 KRX  (default)
    flatSompi: 150000000, // 1.5 KRX
  },
  {
    // Tier 3 until H14, then replaced by Qwen3.8-27B.
    key: 'qwen3.6-27b',
    label: 'Qwen3.6-27B · uncensored · 27B (Q4_K_M)',
    name: 'Qwen3.6-27B (uncensored)',
    idHex: 'b8bdc01fa407eab943e4fefc807483b39f8142785256049e1f559698a5284746',
    tier: 3,
    era: 'pre-h14',
    baseSompi: 250000000, // 2.5 KRX  (--high)
  },
  {
    key: 'qwen3.8-27b',
    label: 'Qwen3.8-27B · uncensored · 27B (Q4_K)',
    name: 'Qwen3.8-27B (uncensored)',
    idHex: '73740b443bdc00afda5fa34eb9999d3fea77dcc3f6de238fab701394cdc96fb3',
    tier: 3,
    era: 'h14',
    flatSompi: 200000000, // 2.0 KRX  (--high)
  },
  {
    key: 'kimi-linear-48b',
    label: 'Kimi-Linear-48B · uncensored · 48B-A3B MoE (Q4_K_M)',
    name: 'Kimi-Linear-48B (uncensored)',
    idHex: '3dc09358ad75c6ef0c9c86ee4f47c4d6acda961fecbd0e4f9cf55e8f0fdffddb',
    tier: 4,
    baseSompi: 400000000, // 4.0 KRX  (--very-high)
    flatSompi: 250000000, // 2.5 KRX
  },
];

/** The models a new AiRequest may be sent to on one side of the H14 gate (retired ones dropped). */
export function selectableModels(h14) {
  return INFERENCE_MODELS.filter((m) => !m.retired && (!m.era || m.era === (h14 ? 'h14' : 'pre-h14')));
}

/** Pre-H14 per-64-token surcharge on the reward (keryx-node INFERENCE_REWARD_TOKEN_STEP); none from H14. */
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

/** The reward floor a model starts at ("from X KRX"): its flat price from H14, else its base price. */
export function modelPriceSompi(model, h14) {
  return h14 ? model.flatSompi : model.baseSompi;
}

/**
 * Reward-vault amount (the "inference_reward"): the model's fixed price from
 * H14 on, else its base price + the token surcharge.
 */
export function inferenceRewardSompi(modelKey, maxTokens, h14 = false) {
  const model = getModel(modelKey);
  if (!model) throw new Error(`Unknown model: ${modelKey}`);
  if (h14) {
    if (model.flatSompi === undefined) throw new Error(`${model.name} is not served after the H14 upgrade`);
    return model.flatSompi;
  }
  if (model.baseSompi === undefined) throw new Error(`${model.name} is served only after the H14 upgrade`);
  return model.baseSompi + TOKEN_SURCHARGE_PER_64 * Math.ceil(maxTokens / 64);
}
