// Groth16 proving for the Gatekeeper circuit (Circom 2.2.3, BN128).
//
// VERIFIED 15 Nov 2026 (see test/proving-verified.md):
// - 13 scalar input signals, probed via FNV-1a + getInputSignalSize:
//   registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
//   currentBlock, recipient, conditionRecipient, amount, maxTransfer,
//   decision, taskId, salt.
// - 13 public signals: [commitment(salt-dependent), f(registeredVkHash),
//   f(proofVkHash), minimum, publicBalance, expiryBlock, currentBlock,
//   recipient, conditionRecipient, amount, maxTransfer, decision, taskId].
//   The salt is the private input; it only affects public signal [0].
// - decision=0 is UNPROVABLE and every condition violation fails the
//   circuit assertion (GatekeeperEvaluation line 102). Proofs exist ONLY
//   for genuinely valid APPROVE scenarios — never generate one for REJECT.
// - fullProve ~0.6s, verify ~20ms, proof JSON ~723 bytes (this VM).
//
// snarkjs is loaded from SNARKJS_PATH (default: the vendored 0.7.6 shim
// in ~/workspace/crosseyed-verify). Circuit artifacts default to
// ../circuits/ next to this agent dir; override with GATEKEEPER_WASM /
// GATEKEEPER_ZKEY. Buffers (not file paths) are passed to snarkjs because
// its 0.7.6 file loader uses fetch(), which rejects bare paths in Node.
// VENDORED COPY for the Vercel package (~/workspace/agentgames/vercel/).
// Identical to ~/workspace/agentgames/agent/lib/prover.js EXCEPT the three
// default paths below, which point at this package's own vendor/ + circuits/
// dirs so the function is self-contained. Env overrides still work
// (SNARKJS_PATH / GATEKEEPER_WASM / GATEKEEPER_ZKEY).
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SNARKJS_PATH = process.env.SNARKJS_PATH ||
  path.join(__dirname, '..', 'vendor', 'snarkjs');
const WASM_PATH = process.env.GATEKEEPER_WASM ||
  path.join(__dirname, '..', 'circuits', 'gatekeeper.wasm');
const ZKEY_PATH = process.env.GATEKEEPER_ZKEY ||
  path.join(__dirname, '..', 'circuits', 'gatekeeper_final.zkey');

const BN128_PRIME = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

let snarkjs = null;
let wasmBuf = null;
let zkeyBuf = null;
let vk = null;

function load() {
  if (!snarkjs) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    snarkjs = require(SNARKJS_PATH);
    wasmBuf = fs.readFileSync(WASM_PATH);
    zkeyBuf = fs.readFileSync(ZKEY_PATH);
  }
  return snarkjs;
}

async function getVk() {
  load();
  if (!vk) vk = await snarkjs.zKey.exportVerificationKey(zkeyBuf);
  return vk;
}

function toField(v) {
  if (typeof v === 'bigint') return (v % BN128_PRIME).toString();
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('non-integer field value');
    return BigInt(v).toString();
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return (BigInt(s) % BN128_PRIME).toString();
    if (/^-?\d+$/.test(s)) {
      let b = BigInt(s) % BN128_PRIME;
      if (b < 0n) b += BN128_PRIME;
      return b.toString();
    }
  }
  throw new Error('unparseable field value: ' + String(v).slice(0, 40));
}

// Map an envelope task_id (string, often a UUID) to a circuit field element.
// ASSUMPTION (confirm in practice mode): numeric ids pass through; other
// strings use the first 31 bytes of SHA-256 (248 bits, safely < p).
// If the platform expects a different mapping, proofs would still verify
// cryptographically but the public taskId signal would not match the
// envelope — practice mode is where this gets confirmed.
function taskIdToField(taskId) {
  if (taskId === undefined || taskId === null) throw new Error('missing task_id');
  const s = String(taskId).trim();
  if (/^\d+$/.test(s)) return (BigInt(s) % BN128_PRIME).toString();
  const digest = crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  return BigInt('0x' + digest.slice(0, 62)).toString();
}

function randomSalt() {
  return BigInt('0x' + crypto.randomBytes(31).toString('hex')).toString();
}

// Build the witness input for an APPROVE decision from a verified envelope.
// Throws on any unparseable value (caller fails closed to REJECT).
function buildInput(envelope) {
  const input = envelope.input;
  return {
    registeredVkHash: toField(input.registered_vk),
    proofVkHash: toField(input.proof_vk),
    minimum: toField(input.minimum),
    publicBalance: toField(input.public_balance),
    expiryBlock: toField(input.expiry_block),
    currentBlock: toField(input.current_block),
    recipient: toField(input.recipient),
    conditionRecipient: toField(input.condition_recipient),
    amount: toField(input.amount),
    maxTransfer: toField(input.max_transfer),
    decision: '1',
    taskId: taskIdToField(envelope.task_id),
    salt: randomSalt(),
  };
}

// Returns { proof, publicSignals, proveMs }. Throws if the circuit
// rejects the witness (i.e. the scenario is not genuinely valid).
async function prove(envelope) {
  load();
  const witness = buildInput(envelope);
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    witness, wasmBuf, zkeyBuf, undefined, undefined, { singleThread: true },
  );
  return { proof, publicSignals, proveMs: Date.now() - t0 };
}

async function verify(proof, publicSignals) {
  load();
  const verificationKey = await getVk();
  return snarkjs.groth16.verify(verificationKey, publicSignals, proof);
}

module.exports = { prove, verify, buildInput, taskIdToField, randomSalt, toField, load };
