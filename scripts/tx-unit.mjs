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
// 36000 = 0x8CA0 -> minimal LE push [a0, 8c], CSV(0xb1 — relative lock), push32 pubkey, CHECKSIG(0xac)
check('escrow script: <36000> CSV <pubkey> CHECKSIG', escrowScript === `02a08cb120${minerPub}ac`);

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
