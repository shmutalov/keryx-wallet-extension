// Inference model registry — mirrors the official wallet's hardcoded list
// (model ids and base prices from keryx-labs.com/infer). Live miner counts
// come from GET /api/v1/capabilities at runtime.

export const INFERENCE_MODELS = [
  {
    key: 'qwen3-1.7b',
    label: 'Qwen3-1.7B · uncensored · 1.7B params (Q4)',
    name: 'Qwen3-1.7B (uncensored)',
    idHex: '4f21ddeb7d62bd2265bc54230d536ca3f1749927780f528c3c41fa2911df4d72',
    baseSompi: 30000000, // 0.3 KRX
  },
  {
    key: 'gemma-3-4b',
    label: 'Gemma-3-4B · uncensored · 4B params (Q4)',
    name: 'Gemma-3-4B (uncensored)',
    idHex: 'ad50ad0bd461d8ab44efc0214989eb33291685ef4ade22a0f4f217d03266d837',
    baseSompi: 50000000, // 0.5 KRX
  },
  {
    key: 'dolphin-llama3-8b',
    label: 'Dolphin-3.0-8B · uncensored · 8B params (Q4)',
    name: 'Dolphin-3.0-8B (uncensored)',
    idHex: '9421066a6400c98ba137114f7f4b7d4a2ddf13ab163a5de38c0184793af6313a',
    baseSompi: 150000000, // 1.5 KRX
  },
  {
    key: 'qwen3-32b-abliterated',
    label: 'Qwen3-32B · uncensored · 32B params (Q4)',
    name: 'Qwen3-32B (uncensored)',
    idHex: '65c6eb6fe18b9efd8060ab9d2d03bb9b01050a3b1378cbac000c5cc0acdc0d2a',
    baseSompi: 250000000, // 2.5 KRX
  },
  {
    key: 'llama-3.3-70b-q2',
    label: 'LLaMA-3.3-70B · uncensored · 70B params (Q2)',
    name: 'LLaMA-3.3-70B Q2 (uncensored)',
    idHex: '6df46a78cbe4dc579f04dbd801f1a520b9eae28ce7b50c8da7874bfa3fb5108d',
    baseSompi: 400000000, // 4.0 KRX
  },
];

export const TOKEN_SURCHARGE_PER_64 = 5000000; // 0.05 KRX per 64 max_tokens

export function getModel(key) {
  return INFERENCE_MODELS.find((m) => m.key === key);
}

/** Escrow amount (the "inference reward"): model base price + token surcharge. */
export function inferenceRewardSompi(modelKey, maxTokens) {
  const model = getModel(modelKey);
  if (!model) throw new Error(`Unknown model: ${modelKey}`);
  return model.baseSompi + TOKEN_SURCHARGE_PER_64 * Math.ceil(maxTokens / 64);
}
