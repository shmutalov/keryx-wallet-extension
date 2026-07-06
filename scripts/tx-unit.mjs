// Unit tests for the transaction builder/signer (no network needed).
import { schnorr } from '@noble/curves/secp256k1.js';
import { deriveWallet, addressToScriptPublicKey, hexToBytes } from '../src/lib/keryx.js';
import {
  buildTransferTx,
  buildInferenceTx,
  buildInferencePayload,
  escrowScriptPublicKey,
  transactionSigningHash,
  spendableUtxos,
  MIN_FEE_SOMPI,
  INFERENCE_SUBNETWORK_ID,
} from '../src/lib/tx.js';
import { inferenceRewardSompi, getModel } from '../src/lib/models.js';

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
    return String(e).includes(match);
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
const model = getModel('gemma-3-4b');
const reward = inferenceRewardSompi('gemma-3-4b', 256);
check('token surcharge math: 0.5 base + 4*0.05', reward === 50000000 + 4 * 5000000);
const payloadHex = buildInferencePayload('Hello Keryx', model.idHex, 256, reward, MIN_FEE_SOMPI);
const pl = hexToBytes(payloadHex);
const dv = new DataView(pl.buffer);
check('payload: model id at [0..32)', payloadHex.startsWith(model.idHex));
check('payload: u32le max_tokens @32', dv.getUint32(32, true) === 256);
check('payload: u64le reward @36', dv.getBigUint64(36, true) === BigInt(reward));
check('payload: u64le priority fee @44', dv.getBigUint64(44, true) === BigInt(MIN_FEE_SOMPI));
check('payload: utf-8 prompt @52', new TextDecoder().decode(pl.slice(52)) === 'Hello Keryx');

// --- escrow script ---
const minerPub = '22'.repeat(32);
const escrowScript = escrowScriptPublicKey(minerPub);
// 36000 = 0x8CA0 -> minimal LE push [a0, 8c], CLTV(0xb1), push32 pubkey, CHECKSIG(0xac)
check('escrow script: <36000> CLTV <pubkey> CHECKSIG', escrowScript === `02a08cb120${minerPub}ac`);

// --- inference tx: escrow + change, non-native subnetwork ---
const inf = buildInferenceTx({
  utxos: [utxo('a', 5_00000000), utxo('b', 2_00000000)],
  changeAddress: sender.address,
  feeSompi: MIN_FEE_SOMPI,
  privateKeyHex: sender.privateKeyHex,
  currentDaaScore: daa,
  payloadHex,
  escrow: { pubkeyHex: minerPub, amountSompi: reward },
});
check('inference tx uses inference subnetwork + payload', inf.tx.subnetwork_id === INFERENCE_SUBNETWORK_ID && inf.tx.payload === payloadHex);
check('escrow output pays reward to escrow script',
  inf.tx.outputs.some((o) => o.amount === reward && o.script_public_key === escrowScript));
check('change returns to self', inf.tx.outputs.some(
  (o) => o.script_public_key === addressToScriptPublicKey(sender.address) &&
         o.amount === inf.totalIn - reward - MIN_FEE_SOMPI));
check('inference signatures verify', inf.tx.inputs.every((inp, i) =>
  schnorr.verify(hexToBytes(inp.signature_script).slice(1, 65),
    transactionSigningHash(inf.unsigned, i), xOnlyPub)));

// --- mass constraint: tiny change gets folded into the fee ---
const tiny = buildInferenceTx({
  utxos: [utxo('a', reward + MIN_FEE_SOMPI + 1000)], // change of 1000 sompi -> 1e12/1000 >> 8e4
  changeAddress: sender.address,
  feeSompi: MIN_FEE_SOMPI,
  privateKeyHex: sender.privateKeyHex,
  currentDaaScore: daa,
  payloadHex,
  escrow: { pubkeyHex: minerPub, amountSompi: reward },
});
check('tiny change folded into fee (no change output)',
  tiny.tx.outputs.length === 1 && tiny.tx.outputs[0].amount === reward && tiny.fee === MIN_FEE_SOMPI + 1000);

check('inference insufficient funds throws', throws(() => buildInferenceTx({
  utxos: [utxo('a', 1000)],
  changeAddress: sender.address,
  feeSompi: MIN_FEE_SOMPI,
  privateKeyHex: sender.privateKeyHex,
  payloadHex,
  escrow: { pubkeyHex: minerPub, amountSompi: reward },
}), 'Insufficient funds'));

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll tx unit checks passed');
