// AI inference requests — the one submit path behind the popup's AI page and
// the dApp provider's `submitInference` approval.
//
// Before H14 the prompt travels in plaintext; from H14 (keryx-node
// `private_inference_activation`) it is sealed to the miners of the model's
// tier and the answer comes back sealed to this wallet (private.js) — under
// key schedule 1 until H15, schedule 2 from H15, as keryx-cli does (miners
// that predate schedule 2 cannot open it; H15 makes them upgrade). A sealed
// request is recorded per account with its schedule (requests.js) so its
// answer can be opened whenever the popup is next open.

import { api } from './api.js';
import { buildInferencePayload, buildInferenceTx, selectInferenceUtxos } from './tx.js';
import { getModel, isH14Active, isH15Active, H14_ACTIVATION_DAA } from './models.js';
import {
  cohortSeed,
  deriveRequestSecret,
  hexBytes,
  KEY_SCHEDULE_V1,
  KEY_SCHEDULE_V2,
  maxRequestPayloadLen,
  openResponse,
  sealRecipients,
  sealRequest,
  toHex,
} from './private.js';
import { addRequest } from './requests.js';

/**
 * Plaintext requests stop this many DAA (~1 min) before the H14 gate: one
 * built just before it could be mined just after it, where it is invalid. A
 * sealed one mined before the gate would be read as a plaintext prompt.
 */
export const H14_SWITCH_MARGIN_DAA = 600;

/** A request still unanswered this long after sending is given up on (same as keryx-labs.com). */
export const ANSWER_TIMEOUT_MS = 15 * 60 * 1000;

/** 'plain' before H14, 'switching' right at the gate (no request can be sent safely), 'sealed' from H14. */
export function inferenceEra(daaScore) {
  if (isH14Active(daaScore)) return 'sealed';
  return daaScore >= H14_ACTIVATION_DAA - H14_SWITCH_MARGIN_DAA ? 'switching' : 'plain';
}

/** The key schedule a request sealed at `daaScore` uses: 2 from H15, else 1. */
export function keyScheduleAt(daaScore) {
  return isH15Active(daaScore) ? KEY_SCHEDULE_V2 : KEY_SCHEDULE_V1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The tier's miners to seal to: `{ cohort, window }` escrow keys of the providers serving `model`. */
async function providersOf(model) {
  for (let attempt = 0; ; attempt++) {
    const res = await api.aiProviders();
    const keysOf = (list) => (Array.isArray(list) ? list : [])
      .filter((p) => (p.model_id ?? '').toLowerCase() === model.idHex)
      .map((p) => p.escrow_pubkey);
    const providers = { cohort: keysOf(res?.cohort), window: keysOf(res?.window) };
    if (providers.cohort.length > 0 || attempt === 1) return providers;
    await sleep(1000); // the host caches the cohort for a few seconds
  }
}

/**
 * Build, sign and broadcast an AiRequest for the active account. `sealed`
 * is the era the caller priced the request for; if the network has crossed
 * the H14 gate since, nothing is sent (the reward rules differ).
 *
 * @returns {Promise<{ txId: string, sealed: boolean, recipients: number }>}
 */
export async function submitInference({ wallet, modelKey, prompt, maxTokens, rewardSompi, feeSompi, sealed, origin, onStep = () => {} }) {
  const model = getModel(modelKey);
  if (!model) throw new Error(`Unknown model: ${modelKey}`);
  onStep('utxos');
  const [utxos, info] = await Promise.all([api.utxos(wallet.address, 400), api.info()]);
  const daa = info?.last_daa_score ?? 0;
  const era = inferenceEra(daa);
  if (era === 'switching') {
    throw new Error('The H14 network upgrade activates in about a minute — nothing has been sent. Try again once it is live.');
  }
  if ((era === 'sealed') !== sealed) {
    throw new Error('The H14 network upgrade just activated and changed inference pricing — nothing has been sent. Review the new cost and submit again.');
  }
  const selected = selectInferenceUtxos({ utxos, feeSompi, rewardSompi, currentDaaScore: daa });
  const build = (payloadHex) => buildInferenceTx({
    selectedUtxos: selected,
    changeAddress: wallet.address,
    feeSompi,
    privateKeyHex: wallet.privateKeyHex,
    currentDaaScore: daa,
    payloadHex,
    rewardSompi,
  });

  if (!sealed) {
    onStep('signing');
    const built = build(buildInferencePayload(prompt, model.idHex, maxTokens, rewardSompi, feeSompi));
    onStep('broadcasting');
    const res = await api.broadcast(built.tx);
    return { txId: res.transaction_id, sealed: false, recipients: 0 };
  }

  // The first input seeds the target cohort the mempool checks coverage
  // against, and the request's secret.
  const seed = cohortSeed(selected[0].transaction_id, selected[0].index);
  const secret = deriveRequestSecret(wallet.privateKeyHex, seed);
  const schedule = keyScheduleAt(daa);
  for (let attempt = 0; ; attempt++) {
    onStep('providers');
    const providers = await providersOf(model);
    if (providers.cohort.length === 0) {
      throw new Error(`No miner is serving ${model.name} right now — nothing has been sent.`);
    }
    const recipientsHex = sealRecipients(seed, providers.cohort, providers.window);
    onStep('signing');
    const built = build(sealRequest({
      modelIdHex: model.idHex,
      maxTokens,
      rewardSompi,
      priorityFeeSompi: feeSompi,
      prompt,
      recipientsHex,
      secret,
      schedule,
      maxPayload: maxRequestPayloadLen(selected.length),
    }));
    onStep('broadcasting');
    let res;
    try {
      res = await api.broadcast(built.tx);
    } catch (e) {
      // A miner joined the cohort between the providers read and admission:
      // re-read it once and seal again (same inputs, same secret).
      if (attempt === 0 && /not sealed to \d+ of the \d+ escrow keys/.test(String(e?.message))) {
        await sleep(3000);
        continue;
      }
      throw e;
    }
    try {
      await addRequest(wallet, {
        id: res.transaction_id,
        seed: toHex(seed),
        schedule,
        model: model.key,
        maxTokens,
        rewardSompi,
        feeSompi,
        recipients: recipientsHex.length,
        prompt,
        sentAt: Date.now(),
        ...(origin ? { origin } : {}),
        status: 'pending',
      });
    } catch (e) {
      // The request is on its way: reporting a failure now would invite a
      // second, paid submission. Only the in-wallet answer view is lost.
      console.warn('Could not record the sealed request', e);
    }
    return { txId: res.transaction_id, sealed: true, recipients: recipientsHex.length };
  }
}

/**
 * Look for the answer to one of this wallet's sealed requests. Every
 * recipient miner answers, each sealing under its own key; the first body
 * that opens wins. A body that does not open is a miner's plaintext note that
 * it could not read the request. Returns the record patch, or null while
 * still waiting.
 */
export async function checkAnswer(wallet, record) {
  let res;
  try {
    res = await api.inferenceResult(record.id);
  } catch {
    res = null; // not indexed yet, or the host has no indexer
  }
  const responses = Array.isArray(res?.sealed_responses) ? res.sealed_responses : [];
  const secret = deriveRequestSecret(wallet.privateKeyHex, hexBytes(record.seed, 36));
  const schedule = record.schedule ?? KEY_SCHEDULE_V1; // records from v0.7.0 carry no schedule: they are all schedule 1
  let note = null;
  for (const r of responses) {
    let body;
    try {
      body = hexBytes(r.body);
    } catch {
      continue;
    }
    try {
      const answer = openResponse(secret, schedule, record.id, r.responder_pubkey, body);
      return { status: 'answered', answer, responder: r.responder_pubkey, answeredAt: Date.now(), responses: responses.length };
    } catch {
      note = new TextDecoder().decode(body).slice(0, 300);
    }
  }
  if (Date.now() - record.sentAt > ANSWER_TIMEOUT_MS) return { status: 'failed', note };
  return null;
}
