// Unit tests for the transaction builder/signer (no network needed).
import { schnorr } from '@noble/curves/secp256k1.js';
import { deriveWallet, addressToScriptPublicKey, hexToBytes } from '../src/lib/keryx.js';
import { buildTransferTx, transactionSigningHash, spendableUtxos, MIN_FEE_SOMPI } from '../src/lib/tx.js';

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

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll tx unit checks passed');
