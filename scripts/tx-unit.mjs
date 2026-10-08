// Unit tests for the transaction builder/signer (no network needed).
import { schnorr } from '@noble/curves/secp256k1.js';
import { deriveWallet, addressToScriptPublicKey, hexToBytes } from '../src/lib/keryx.js';
import {
  buildTransferTx,
  buildInferenceTx,
  selectInferenceUtxos,
  buildInferencePayload,
  escrowScriptPublicKey,
  INFERENCE_VAULT_SCRIPT_HEX,
  transactionSigningHash,
  spendableUtxos,
  signTxJson,
  signPersonalMessage,
  personalMessageHash,
  MIN_FEE_SOMPI,
  INFERENCE_SUBNETWORK_ID,
  SIGHASH_ALL,
  SIGHASH_NONE,
  SIGHASH_SINGLE,
  SIGHASH_ANYONECANPAY,
} from '../src/lib/tx.js';
import {
  inferenceRewardSompi,
  getModel,
  selectableModels,
  H14_ACTIVATION_DAA,
} from '../src/lib/models.js';
import {
  cohortSeed,
  cohortRank,
  deriveRootKey,
  isSealed,
  maxPrivatePromptLen,
  maxRequestPayloadLen,
  openOwnPrompt,
  openRequest,
  openResponse,
  requestHeader,
  sealRecipients,
  sealRequest,
  sealResponse,
  toHex,
} from '../src/lib/private.js';
import { inferenceEra, H14_SWITCH_MARGIN_DAA } from '../src/lib/inference.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

let failures = 0;
let n = 0;
const check = (desc, ok, extra = '') => {
  console.log(`${++n}. ${desc}:`, ok, extra);
  if (!ok) failures++;
};

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const sender = deriveWallet(MNEMONIC, 0);
const receiver = deriveWallet(MNEMONIC, 1);

const utxo = (id, amount, extra = {}) => ({
  transaction_id: id.repeat(64 / id.length),
  index: 0,
  amount_sompi: amount,
  script_version: 0,
  script_public_key: addressToScriptPublicKey(sender.address),
  block_daa_score: 1000000,
  is_coinbase: false,
  ...extra,
});

// --- maturity filtering ---
const daa = 2000000;
const utxos = [
  utxo('a', 5_00000000),
  utxo('b', 2_00000000),
  utxo('c', 1_00000000, { block_daa_score: daa - 500, is_coinbase: true }), // immature coinbase
  utxo('d', 3_00000000, { block_daa_score: 0 }), // unconfirmed
  utxo('e', 50000000, { block_daa_score: daa - 5000, is_coinbase: true }), // mature coinbase
];
const spendable = spendableUtxos(utxos, daa);
check('immature coinbase and unconfirmed UTXOs excluded', spendable.length === 3 &&
  !spendable.some((u) => u.transaction_id.startsWith('c') || u.transaction_id.startsWith('d')));

// --- build a transfer: 5.5 KRX + 0.3 fee from {5, 2, 0.5} ---
const amount = 5_50000000;
const { tx, unsigned, totalIn, fee, change } = buildTransferTx({
  utxos,
  toAddress: receiver.address,
  amountSompi: amount,
  feeSompi: MIN_FEE_SOMPI,
  changeAddress: sender.address,
  privateKeyHex: sender.privateKeyHex,
  currentDaaScore: daa,
});

check('greedy largest-first selection picks 2 UTXOs (5 + 2)', tx.inputs.length === 2 && totalIn === 7_00000000);
check('change = in - amount - fee', change === 7_00000000 - amount - MIN_FEE_SOMPI);
check('output 0 pays destination script', tx.outputs[0].amount === amount &&
  tx.outputs[0].script_public_key === addressToScriptPublicKey(receiver.address));
check('output 1 returns change to sender', tx.outputs[1].amount === change &&
  tx.outputs[1].script_public_key === addressToScriptPublicKey(sender.address));
check('dest script is OP_DATA_32 <x-only pubkey> OP_CHECKSIG', /^20[0-9a-f]{64}ac$/.test(tx.outputs[0].script_public_key));

// --- wire format ---
check('sequence serialized as u64-max string', tx.inputs.every((i) => i.sequence === '18446744073709551615'));
check('native subnetwork, gas 0, lock_time 0, empty payload',
  tx.subnetwork_id === '0'.repeat(40) && tx.gas === 0 && tx.lock_time === 0 && tx.payload === '');
check('signature_script = 0x41 || sig(64) || 0x01', tx.inputs.every((i) =>
  i.signature_script.length === 132 && i.signature_script.startsWith('41') && i.signature_script.endsWith('01')));

// --- every input signature verifies against its sighash ---
const xOnlyPub = schnorr.getPublicKey(hexToBytes(sender.privateKeyHex));
const allValid = tx.inputs.every((inp, i) => {
  const sig = hexToBytes(inp.signature_script).slice(1, 65);
  return schnorr.verify(sig, transactionSigningHash(unsigned, i), xOnlyPub);
});
check('BIP340 signatures verify against TransactionSigningHash', allValid);
check('x-only pubkey in address matches signing key',
  tx.outputs[1].script_public_key.slice(2, 66) === Buffer.from(xOnlyPub).toString('hex'));

// --- sighash properties ---
const h0 = transactionSigningHash(unsigned, 0);
check('sighash deterministic', Buffer.compare(h0, transactionSigningHash(unsigned, 0)) === 0);
check('sighash differs per input', Buffer.compare(h0, transactionSigningHash(unsigned, 1)) !== 0);

// --- exact-amount spend has no change output ---
const exact = buildTransferTx({
  utxos: [utxo('a', 1_00000000 + MIN_FEE_SOMPI)],
  toAddress: receiver.address,
  amountSompi: 1_00000000,
  feeSompi: MIN_FEE_SOMPI,
  changeAddress: sender.address,
  privateKeyHex: sender.privateKeyHex,
});
check('exact spend produces single output', exact.tx.outputs.length === 1 && exact.change === 0);

// --- errors ---
const throws = (fn, match) => {
  try {
    fn();
    return false;
  } catch (e) {
    return match === undefined || String(e).includes(match);
  }
};
check('insufficient funds throws', throws(() => buildTransferTx({
  utxos: [utxo('a', 1000)],
  toAddress: receiver.address,
  amountSompi: 1_00000000,
  feeSompi: MIN_FEE_SOMPI,
  changeAddress: sender.address,
  privateKeyHex: sender.privateKeyHex,
}), 'Insufficient funds'));
check('invalid amount throws', throws(() => buildTransferTx({
  utxos, toAddress: receiver.address, amountSompi: 0, feeSompi: MIN_FEE_SOMPI,
  changeAddress: sender.address, privateKeyHex: sender.privateKeyHex,
}), 'Invalid amount'));
check('bad destination address throws', throws(() => buildTransferTx({
  utxos, toAddress: 'keryx:qqinvalidaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  amountSompi: 1000, feeSompi: MIN_FEE_SOMPI,
  changeAddress: sender.address, privateKeyHex: sender.privateKeyHex, currentDaaScore: daa,
}), 'Invalid'));

// --- inference payload encoding ---
const model = getModel('gemma-4-12b-abliterated');
const reward = inferenceRewardSompi('gemma-4-12b-abliterated', 256);
check('token surcharge math: 2.0 base + 4*0.05', reward === 200000000 + 4 * 5000000);
const payloadHex = buildInferencePayload('Hello Keryx', model.idHex, 256, reward, MIN_FEE_SOMPI);
const pl = hexToBytes(payloadHex);
const dv = new DataView(pl.buffer);
check('payload: model id at [0..32)', payloadHex.startsWith(model.idHex));
check('payload: u32le max_tokens @32', dv.getUint32(32, true) === 256);
check('payload: u64le reward @36', dv.getBigUint64(36, true) === BigInt(reward));
check('payload: u64le priority fee @44', dv.getBigUint64(44, true) === BigInt(MIN_FEE_SOMPI));
check('payload: utf-8 prompt @52', new TextDecoder().decode(pl.slice(52)) === 'Hello Keryx');

// --- pre-H8 escrow script (legacy decode only; consensus rejects it in an AiRequest since H8) ---
const minerPub = '22'.repeat(32);
const escrowScript = escrowScriptPublicKey(minerPub);
// 36000 = 0x8CA0 -> minimal LE push [a0, 8c], CSV(0xb1 — relative lock), push32 pubkey, CHECKSIG(0xac)
check('escrow script: <36000> CSV <pubkey> CHECKSIG', escrowScript === `02a08cb120${minerPub}ac`);

// --- H8 reward vault: OP_RETURN(0x6a) PUSH7 "aivault" (keryx_inference::INFERENCE_VAULT_SCRIPT) ---
check('vault script is OP_RETURN "aivault"',
  INFERENCE_VAULT_SCRIPT_HEX === '6a07' + Buffer.from('aivault', 'utf8').toString('hex'));

// --- inference tx: change + vault, non-native subnetwork ---
const inf = buildInferenceTx({
  utxos: [utxo('a', 5_00000000), utxo('b', 2_00000000)],
  changeAddress: sender.address,
  feeSompi: MIN_FEE_SOMPI,
  privateKeyHex: sender.privateKeyHex,
  currentDaaScore: daa,
  payloadHex,
  rewardSompi: reward,
});
check('inference tx uses inference subnetwork + payload', inf.tx.subnetwork_id === INFERENCE_SUBNETWORK_ID && inf.tx.payload === payloadHex);
check('outputs[1] is the reward vault worth inference_reward (consensus: exact script, version 0)',
  inf.tx.outputs.length === 2 && inf.tx.outputs[1].amount === reward &&
  inf.tx.outputs[1].script_version === 0 && inf.tx.outputs[1].script_public_key === INFERENCE_VAULT_SCRIPT_HEX);
check('outputs[0] is the change back to self',
  inf.tx.outputs[0].script_public_key === addressToScriptPublicKey(sender.address) &&
  inf.tx.outputs[0].amount === inf.totalIn - reward - MIN_FEE_SOMPI);
check('no output ever pays a miner escrow', !inf.tx.outputs.some((o) => o.script_public_key === escrowScript));
check('inference signatures verify', inf.tx.inputs.every((inp, i) =>
  schnorr.verify(hexToBytes(inp.signature_script).slice(1, 65),
    transactionSigningHash(inf.unsigned, i), xOnlyPub)));

// --- mass constraint: the vault must stay at outputs[1], so tiny change can no longer be folded away ---
check('tiny change (would leave the vault at outputs[0]) throws instead of building', throws(() => buildInferenceTx({
  utxos: [utxo('a', reward + MIN_FEE_SOMPI + 1000)], // change of 1000 sompi -> 1e12/1000 >> 8e4
  changeAddress: sender.address,
  feeSompi: MIN_FEE_SOMPI,
  privateKeyHex: sender.privateKeyHex,
  currentDaaScore: daa,
  payloadHex,
  rewardSompi: reward,
}), 'Insufficient funds'));
// Smallest change that clears 1e12/change + 1e12/reward <= 8e4 builds fine.
const minChange = Math.ceil(1e12 / (80000 - 1e12 / reward));
const edge = buildInferenceTx({
  utxos: [utxo('a', reward + MIN_FEE_SOMPI + minChange)],
  changeAddress: sender.address,
  feeSompi: MIN_FEE_SOMPI,
  privateKeyHex: sender.privateKeyHex,
  currentDaaScore: daa,
  payloadHex,
  rewardSompi: reward,
});
check('minimal viable change keeps both outputs and the fee untouched',
  edge.tx.outputs.length === 2 && edge.tx.outputs[0].amount === minChange && edge.fee === MIN_FEE_SOMPI);

check('inference insufficient funds throws', throws(() => buildInferenceTx({
  utxos: [utxo('a', 1000)],
  changeAddress: sender.address,
  feeSompi: MIN_FEE_SOMPI,
  privateKeyHex: sender.privateKeyHex,
  payloadHex,
  rewardSompi: reward,
}), 'Insufficient funds'));

check('AiRequest without a reward vault is refused', throws(() => buildInferenceTx({
  utxos: [utxo('a', 5_00000000)],
  changeAddress: sender.address,
  feeSompi: MIN_FEE_SOMPI,
  privateKeyHex: sender.privateKeyHex,
  payloadHex,
}), 'reward vault'));

check('plaintext prompt over the pre-H14 4 KiB payload cap is refused',
  throws(() => buildInferencePayload('x'.repeat(4045), model.idHex, 256, reward), 'Prompt too long') &&
  !throws(() => buildInferencePayload('x'.repeat(4044), model.idHex, 256, reward)));

// --- H14 pricing + lineup (keryx-node INFERENCE_REWARD_MINIMUMS_FLAT, POM_TIERS_H14) ---
check('H14 reward is the flat model price, whatever max_tokens',
  inferenceRewardSompi('gemma-4-12b-abliterated', 4096, true) === 150000000 &&
  inferenceRewardSompi('qwen3.5-9b-abliterated', 64, true) === 50000000 &&
  inferenceRewardSompi('qwen3.8-27b', 256, true) === 200000000 &&
  inferenceRewardSompi('kimi-linear-48b', 256, true) === 250000000);
check('Qwen3.6-27B is pre-H14 only, Qwen3.8-27B H14 only',
  throws(() => inferenceRewardSompi('qwen3.6-27b', 256, true)) && throws(() => inferenceRewardSompi('qwen3.8-27b', 256, false)));
const tiersOf = (h14) => selectableModels(h14).map((m) => `${m.tier}:${m.key}`).join(',');
check('lineups: 5 tiers each side of the gate, only tier 3 differs',
  tiersOf(false) === '0:qwen3.5-9b-abliterated,1:glm-4-9b-0414,2:gemma-4-12b-abliterated,3:qwen3.6-27b,4:kimi-linear-48b' &&
  tiersOf(true) === '0:qwen3.5-9b-abliterated,1:glm-4-9b-0414,2:gemma-4-12b-abliterated,3:qwen3.8-27b,4:kimi-linear-48b');
check('Qwen3.8-27B model id (keryx-node QWEN3_8_27B_MODEL_ID)',
  getModel('qwen3.8-27b').idHex === '73740b443bdc00afda5fa34eb9999d3fea77dcc3f6de238fab701394cdc96fb3');
check('era: plaintext, then a no-send margin, then sealed at H14_ACTIVATION_DAA',
  inferenceEra(H14_ACTIVATION_DAA - H14_SWITCH_MARGIN_DAA - 1) === 'plain' &&
  inferenceEra(H14_ACTIVATION_DAA - H14_SWITCH_MARGIN_DAA) === 'switching' &&
  inferenceEra(H14_ACTIVATION_DAA - 1) === 'switching' &&
  inferenceEra(H14_ACTIVATION_DAA) === 'sealed');

// --- H14 private inference envelopes, pinned to vectors from keryx-node's own
// inference/src/private.rs (seeded rng) and keryx-labs.com's /infer module ---
const ESCROW = ['11', '22', '33'].map((b) => b.repeat(32));
const ESCROW_PUB = [
  '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa',
  '466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27',
  '3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1',
];
// seal_request_with_rng(gemma, 256, 1.5 KRX, 0.3 KRX, "vector prompt", [pub0, pub1], StdRng(7))
const NODE_REQUEST = hexToBytes('399984045600f7d58d1b2cf01e6a4bf466fa15c7ac31bd0dd1a71e003b617cc60001000080d1f0080000000080c3c90100000000004b58500102ad4063e56d12d439afe71e1837f1ce9c435c8b2a9c959b339f6e8e003e7150d3b621629ead61c245e06bb0bc02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27aabdb06ee8345e31bf9f9898d2930d99fd276120ef40e474ff48a3fbbc7e1c57bb634d4ad730412af408bd481ff198424f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aae313f16b0353c79b31fcd28ab79564e3c5f9f6a651ff9c2215b56724a8f486862c713d8516d3ee4045795b69387f4faa0bd1222917019e5806b4b59ed611243dc35550955b9de8457ae0c06f53');
const NODE_ROOT = hexToBytes('befba86ae9e0c207865f7e24e8349d4ecdbc8b0f4632842499a0dfa60568e28a');
// seal_response_with_rng(NODE_ROOT, ab×32, pub1, "vector answer", StdRng(3))
const NODE_BODY = hexToBytes('004b585001ecd9c4a53ea15f18447b08fb48318320b5b9b8062bc2d149dbcfd33862fa57e9b31d3ebe95ff5bf451');
check('escrow keys used by the vectors (the first has an odd-Y full key)', ESCROW.every((sk, i) =>
  toHex(secp256k1.getPublicKey(hexToBytes(sk), true).subarray(1)) === ESCROW_PUB[i]) &&
  secp256k1.getPublicKey(hexToBytes(ESCROW[0]), true)[0] === 0x03);
check('requester opens its own node-sealed prompt', openOwnPrompt(NODE_ROOT, NODE_REQUEST) === 'vector prompt');
check('both named miners open the node-sealed request and recover the root key', [0, 1].every((i) => {
  const opened = openRequest(NODE_REQUEST, ESCROW[i]);
  return opened.prompt === 'vector prompt' && toHex(opened.rootKey) === toHex(NODE_ROOT);
}));
check('a miner the request does not name cannot open it', throws(() => openRequest(NODE_REQUEST, ESCROW[2]), 'not among'));
check('node-sealed answer opens for its request id and responder',
  openResponse(NODE_ROOT, 'ab'.repeat(32), ESCROW_PUB[1], NODE_BODY) === 'vector answer');
check('the answer is bound to responder key and request id',
  throws(() => openResponse(NODE_ROOT, 'ab'.repeat(32), ESCROW_PUB[0], NODE_BODY)) &&
  throws(() => openResponse(NODE_ROOT, 'ac'.repeat(32), ESCROW_PUB[1], NODE_BODY)));
check('a plaintext "could not open" note is not an envelope',
  throws(() => openResponse(NODE_ROOT, 'ab'.repeat(32), ESCROW_PUB[1], new TextEncoder().encode('could not open')), 'Not a private'));

const vSeed = cohortSeed('5e'.repeat(32), 3);
check('cohort seed = txid ‖ u32le index', toHex(vSeed) === '5e'.repeat(32) + '03000000');
check('root key derivation matches keryx-labs.com (HKDF "KeryxChatRootKeyV1")',
  toHex(deriveRootKey('01'.repeat(32), vSeed)) === '3c21c6e93a7af5d47b109517e033fc1bd1c94bf2ea112667d7f2c34ae35888ec');
check('cohort rank matches keryx-node private_cohort_rank (blake2b-256)',
  toHex(cohortRank(vSeed, hexToBytes(ESCROW_PUB[0]))) === 'b08da7922cf9e3adb67352880b76dc589d33f3db51eee917e35c4c0d3f85e1f5' &&
  toHex(cohortRank(vSeed, hexToBytes(ESCROW_PUB[2]))) === 'd35581a98168c30b03b29652638a8390291d6fd1e06724b0d4806a5f588ecb50');
check('recipients: cohort + window extras, deduplicated, ascending',
  JSON.stringify(sealRecipients(vSeed, [ESCROW_PUB[0], ESCROW_PUB[1].toUpperCase(), ESCROW_PUB[0]], ESCROW_PUB)) ===
  JSON.stringify([ESCROW_PUB[2], ESCROW_PUB[1], ESCROW_PUB[0]]));
const many = Array.from({ length: 140 }, () => toHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true).subarray(1)));
const capped = sealRecipients(vSeed, many, [ESCROW_PUB[0]]);
const lowest = [...many].sort((a, b) => Buffer.compare(cohortRank(vSeed, hexToBytes(a)), cohortRank(vSeed, hexToBytes(b)))).slice(0, 128).sort();
check('a cohort above 128 is cut to its 128 lowest ranks, window extras dropped',
  capped.length === 128 && JSON.stringify(capped) === JSON.stringify(lowest) && !capped.includes(ESCROW_PUB[0]));
check('prompt caps match keryx-node max_private_prompt_len (64 KiB payload)',
  maxPrivatePromptLen(1) === 65337 && maxPrivatePromptLen(45) === 61817 && maxPrivatePromptLen(128) === 55177);

const myRoot = deriveRootKey(sender.privateKeyHex, vSeed);
const sealedHex = sealRequest({
  modelIdHex: getModel('qwen3.8-27b').idHex, maxTokens: 512, rewardSompi: 200000000, priorityFeeSompi: MIN_FEE_SOMPI,
  prompt: 'Private question ✓', recipientsHex: ESCROW_PUB, rootKey: myRoot,
});
const sealedBytes = hexToBytes(sealedHex);
check('sealed payload: the 52-byte header stays public, then the envelope marker',
  sealedHex.startsWith(toHex(requestHeader(getModel('qwen3.8-27b').idHex, 512, 200000000, MIN_FEE_SOMPI))) &&
  isSealed(sealedBytes.subarray(52)) && sealedBytes[56] === 1 && sealedBytes[102] === 3);
check('sealed payload never carries the prompt in clear',
  !sealedHex.includes(Buffer.from('Private question', 'utf8').toString('hex')));
check('every recipient (incl. odd-Y keys) opens the wallet-sealed request', ESCROW.every((sk) => {
  const opened = openRequest(sealedBytes, sk);
  return opened.prompt === 'Private question ✓' && toHex(opened.rootKey) === toHex(myRoot);
}));
check('miner-sealed answer round-trips to the requester', openResponse(myRoot, 'cd'.repeat(32), ESCROW_PUB[2],
  sealResponse(openRequest(sealedBytes, ESCROW[2]).rootKey, 'cd'.repeat(32), ESCROW_PUB[2], 'Answer ✓')) === 'Answer ✓');
check('tampered header (re-priced request) fails to open',
  throws(() => openRequest(Uint8Array.from(sealedBytes, (b, i) => (i === 40 ? b ^ 1 : b)), ESCROW[0])));
check('sealing refuses no recipients, bad keys and oversized prompts',
  throws(() => sealRequest({ modelIdHex: model.idHex, maxTokens: 1, rewardSompi: 1, priorityFeeSompi: 1, prompt: 'p', recipientsHex: [], rootKey: myRoot }), 'No recipients') &&
  throws(() => sealRequest({ modelIdHex: model.idHex, maxTokens: 1, rewardSompi: 1, priorityFeeSompi: 1, prompt: 'p', recipientsHex: ['ff'.repeat(32)], rootKey: myRoot }), 'Invalid escrow key') &&
  throws(() => sealRequest({ modelIdHex: model.idHex, maxTokens: 1, rewardSompi: 1, priorityFeeSompi: 1, prompt: 'x'.repeat(65338), recipientsHex: [ESCROW_PUB[0]], rootKey: myRoot }), 'does not fit'));

// --- sealed AiRequest tx: inputs chosen first (the first seeds the cohort), order kept ---
const flatReward = inferenceRewardSompi('gemma-4-12b-abliterated', 256, true);
const picked = selectInferenceUtxos({
  utxos: [utxo('b', 2_00000000), utxo('a', 5_00000000)], feeSompi: MIN_FEE_SOMPI, rewardSompi: flatReward, currentDaaScore: daa,
});
const sealedTx = buildInferenceTx({
  selectedUtxos: picked, changeAddress: sender.address, feeSompi: MIN_FEE_SOMPI, privateKeyHex: sender.privateKeyHex,
  currentDaaScore: daa, payloadHex: sealedHex, rewardSompi: flatReward,
});
check('largest UTXO is the first input (cohort seed) and the built tx keeps it first',
  picked[0].transaction_id === 'a'.repeat(64) && sealedTx.tx.inputs[0].transaction_id === picked[0].transaction_id);
check('sealed tx: vault at outputs[1] worth the flat reward, payload carried verbatim',
  sealedTx.tx.outputs[1].amount === flatReward && sealedTx.tx.outputs[1].script_public_key === INFERENCE_VAULT_SCRIPT_HEX &&
  sealedTx.tx.payload === sealedHex);
check('payload above the 64 KiB mass budget is refused', throws(() => buildInferenceTx({
  selectedUtxos: picked, changeAddress: sender.address, feeSompi: MIN_FEE_SOMPI, privateKeyHex: sender.privateKeyHex,
  payloadHex: '00'.repeat(65537), rewardSompi: flatReward,
}), 'mass limit'));
check('payload budget shrinks with inputs (compute mass: 1000 per sig-op)',
  maxRequestPayloadLen(1) === 65536 && maxRequestPayloadLen(40) < 65536);

// --- sighash types (Kaspa reused-values rules; `unsigned` has 2 inputs, 2 outputs) ---
const eq = (a, b) => Buffer.compare(a, b) === 0;
const mutate = (fn) => {
  const c = structuredClone(unsigned);
  fn(c);
  return c;
};

check('ALL and ALL|ANYONECANPAY digests differ',
  !eq(transactionSigningHash(unsigned, 0), transactionSigningHash(unsigned, 0, SIGHASH_ALL | SIGHASH_ANYONECANPAY)));

const otherInputChanged = mutate((c) => { c.inputs[1].transaction_id = 'e'.repeat(64); });
check('ANYONECANPAY: other input\'s outpoint does not affect the digest',
  eq(transactionSigningHash(unsigned, 0, SIGHASH_ALL | SIGHASH_ANYONECANPAY),
     transactionSigningHash(otherInputChanged, 0, SIGHASH_ALL | SIGHASH_ANYONECANPAY)) &&
  !eq(transactionSigningHash(unsigned, 0), transactionSigningHash(otherInputChanged, 0)));

const otherOutputChanged = mutate((c) => { c.outputs[1].amount += 1; });
check('SINGLE: non-corresponding output does not affect the digest',
  eq(transactionSigningHash(unsigned, 0, SIGHASH_SINGLE),
     transactionSigningHash(otherOutputChanged, 0, SIGHASH_SINGLE)) &&
  !eq(transactionSigningHash(unsigned, 0), transactionSigningHash(otherOutputChanged, 0)));

const ownOutputChanged = mutate((c) => { c.outputs[0].amount += 1; });
check('SINGLE: corresponding output DOES affect the digest',
  !eq(transactionSigningHash(unsigned, 0, SIGHASH_SINGLE),
      transactionSigningHash(ownOutputChanged, 0, SIGHASH_SINGLE)));

check('NONE: outputs do not affect the digest',
  eq(transactionSigningHash(unsigned, 0, SIGHASH_NONE),
     transactionSigningHash(ownOutputChanged, 0, SIGHASH_NONE)));

check('invalid sighash type throws', throws(() => transactionSigningHash(unsigned, 0, 0x03), 'Invalid sighash type'));

// --- generalized signer: P2PK spend matches the standard signer's wire format ---
const asJson = {
  inputs: unsigned.inputs.map((i) => ({
    transaction_id: i.transaction_id,
    index: i.index,
    utxo: { amount_sompi: i.utxo.amount_sompi, script_public_key: i.utxo.script_public_key },
  })),
  outputs: unsigned.outputs.map((o) => ({ amount: o.amount, script_public_key: o.script_public_key })),
};
const generic = signTxJson(asJson, sender.privateKeyHex);
check('signTxJson P2PK: signature_script = 0x41 || sig || 0x01 and signatures verify',
  generic.tx.inputs.every((inp, i) =>
    inp.signature_script.length === 132 && inp.signature_script.startsWith('41') &&
    inp.signature_script.endsWith('01') &&
    schnorr.verify(hexToBytes(inp.signature_script).slice(1, 65),
      transactionSigningHash(generic.unsigned, i), xOnlyPub)));
check('signTxJson totals: totalIn/fee computed from utxo entries',
  generic.totalIn === 7_00000000 && generic.fee === generic.totalIn - generic.totalOut);
check('signTxJson defaults: max sequence, native subnetwork, lock_time 0',
  generic.tx.inputs.every((i) => i.sequence === '18446744073709551615') &&
  generic.tx.subnetwork_id === '0'.repeat(40) && generic.tx.lock_time === 0 && generic.tx.payload === '');

// --- HTLC claim: P2SH-style spend with redeem script + preimage suffix ---
const P2SH_SPK = 'aa20' + '33'.repeat(32) + '87'; // OP_BLAKE2B <hash> OP_EQUAL
const REDEEM = 'ab'.repeat(113); // opaque 113-byte redeem script -> needs OP_PUSHDATA1
const PREIMAGE = 'cd'.repeat(32);
const CLAIM_SUFFIX = '20' + PREIMAGE + '51'; // <preimage push> OP_TRUE (claim branch)
const htlcUtxoAmount = 5_00000000;
const claim = signTxJson({
  inputs: [{
    transaction_id: 'f'.repeat(64),
    index: 0,
    utxo: { amount_sompi: htlcUtxoAmount, script_public_key: P2SH_SPK },
    redeem_script: REDEEM,
    sig_script_suffix: CLAIM_SUFFIX,
  }],
  outputs: [{ amount: htlcUtxoAmount - MIN_FEE_SOMPI, script_public_key: addressToScriptPublicKey(receiver.address) }],
}, sender.privateKeyHex);
const claimScript = claim.tx.inputs[0].signature_script;
check('HTLC claim: <sig push> <suffix> <PUSHDATA1 redeem> assembly',
  claimScript.startsWith('41') &&
  claimScript.slice(130, 132) === '01' && // sighash byte after the 64-byte sig
  claimScript.slice(132, 132 + CLAIM_SUFFIX.length) === CLAIM_SUFFIX &&
  claimScript.slice(132 + CLAIM_SUFFIX.length) === '4c71' + REDEEM); // 0x71 = 113
check('HTLC claim: signature verifies against the P2SH sighash',
  schnorr.verify(hexToBytes(claimScript).slice(1, 65),
    transactionSigningHash(claim.unsigned, 0), xOnlyPub));

// --- HTLC refund: CLTV path (lock_time set, non-final sequence, redeem only) ---
const refund = signTxJson({
  lock_time: 123456,
  inputs: [{
    transaction_id: 'f'.repeat(64),
    index: 0,
    sequence: 0,
    utxo: { amount_sompi: htlcUtxoAmount, script_public_key: P2SH_SPK },
    redeem_script: REDEEM,
  }],
  outputs: [{ amount: htlcUtxoAmount - MIN_FEE_SOMPI, script_public_key: addressToScriptPublicKey(sender.address) }],
}, sender.privateKeyHex);
check('HTLC refund: lock_time + non-final sequence serialized, sig verifies',
  refund.tx.lock_time === 123456 && refund.tx.inputs[0].sequence === '0' &&
  refund.tx.inputs[0].signature_script.endsWith('4c71' + REDEEM) &&
  schnorr.verify(hexToBytes(refund.tx.inputs[0].signature_script).slice(1, 65),
    transactionSigningHash(refund.unsigned, 0), xOnlyPub));
check('lock_time is part of the sighash',
  !eq(transactionSigningHash(refund.unsigned, 0),
      transactionSigningHash({ ...refund.unsigned, lock_time: 0n }, 0)));

// --- custom sighash type flows into both the digest and the type byte ---
const acp = signTxJson({
  inputs: [{
    transaction_id: 'f'.repeat(64),
    index: 0,
    utxo: { amount_sompi: htlcUtxoAmount, script_public_key: P2SH_SPK },
    sighash_type: SIGHASH_ALL | SIGHASH_ANYONECANPAY,
    redeem_script: REDEEM,
  }],
  outputs: [{ amount: htlcUtxoAmount - MIN_FEE_SOMPI, script_public_key: addressToScriptPublicKey(receiver.address) }],
}, sender.privateKeyHex);
const acpScript = acp.tx.inputs[0].signature_script;
check('ALL|ANYONECANPAY: type byte 0x81 in the sig push, verifies against typed digest',
  acpScript.slice(130, 132) === '81' &&
  schnorr.verify(hexToBytes(acpScript).slice(1, 65),
    transactionSigningHash(acp.unsigned, 0, SIGHASH_ALL | SIGHASH_ANYONECANPAY), xOnlyPub));

// --- pass-through inputs (multi-party txs) ---
const PRESIGNED = '41' + '99'.repeat(65);
const mixed = signTxJson({
  inputs: [
    { transaction_id: 'a'.repeat(64), index: 0, signature_script: PRESIGNED },
    { transaction_id: 'b'.repeat(64), index: 1,
      utxo: { amount_sompi: 1_00000000, script_public_key: addressToScriptPublicKey(sender.address) } },
  ],
  outputs: [{ amount: 50000000, script_public_key: addressToScriptPublicKey(receiver.address) }],
}, sender.privateKeyHex);
check('verbatim signature_script passed through untouched; other input signed',
  mixed.tx.inputs[0].signature_script === PRESIGNED &&
  mixed.tx.inputs[1].signature_script.startsWith('41') &&
  mixed.totalIn === null && mixed.fee === null);

check('all-verbatim tx throws (nothing to sign)', throws(() => signTxJson({
  inputs: [{ transaction_id: 'a'.repeat(64), index: 0, signature_script: PRESIGNED }],
  outputs: [{ amount: 1000, script_public_key: addressToScriptPublicKey(receiver.address) }],
}, sender.privateKeyHex), 'Nothing to sign'));

check('signable input without utxo entry throws', throws(() => signTxJson({
  inputs: [{ transaction_id: 'a'.repeat(64), index: 0 }],
  outputs: [{ amount: 1000, script_public_key: addressToScriptPublicKey(receiver.address) }],
}, sender.privateKeyHex), 'cannot sign without a utxo entry'));

check('unsafe output amount refused', throws(() => signTxJson({
  inputs: [{ transaction_id: 'a'.repeat(64), index: 0,
    utxo: { amount_sompi: 1000, script_public_key: P2SH_SPK } }],
  outputs: [{ amount: 2 ** 53, script_public_key: addressToScriptPublicKey(receiver.address) }],
}, sender.privateKeyHex), 'outside JS safe-integer range'));

// --- personal message signing ---
const msgSig = signPersonalMessage('Login to dApp: nonce 42', sender.privateKeyHex);
check('personal message signature verifies against keyed blake2b digest',
  msgSig.length === 128 &&
  schnorr.verify(hexToBytes(msgSig), personalMessageHash('Login to dApp: nonce 42'), xOnlyPub));
check('different messages give different digests',
  !eq(personalMessageHash('a'), personalMessageHash('b')));

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll tx unit checks passed');
