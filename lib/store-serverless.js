// Serverless adaptation of lib/store.js (same interface: getResponse,
// putResponse, isProofSeen, markProofSeen, stats, STATE_DIR).
//
// Vercel functions are stateless: there is no durable disk, and each
// concurrent instance has its own memory. This store therefore keeps
// state in MEMORY (primary — survives warm invocations in the same
// container) with a best-effort /tmp persistence fallback (/tmp survives
// within one container across warm invocations, and is re-read on module
// load). Writes never throw: if /tmp is unavailable, memory remains the
// source of truth for that container.
//
// CAVEAT (see README.md): the PROOF_REUSED seen-set is per-instance and
// is lost on cold start. A replayed proof_tx hitting a FRESH container
// would NOT be recognised as reused, so that task would be decided on its
// envelope alone (the other 6 checks still apply — a reused proof whose
// envelope is otherwise valid would be APPROVED). The durable fix is
// Vercel KV (or any shared store) for the seen-set; that is an upgrade,
// not part of this package.
'use strict';
const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.AGENT_STATE_DIR || '/tmp/agentgames-state';
const RESPONSES_FILE = path.join(STATE_DIR, 'responses.json');
const SEEN_FILE = path.join(STATE_DIR, 'seen_proofs.json');

let responses = null; // task_id -> stored response object
let seenProofs = null; // Set of proof_tx strings

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return fallback;
  }
}

// Best-effort atomic write. Never throws — callers must not fail a
// decision because persistence failed.
function saveJson(file, data) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (_e) {
    // Memory remains the source of truth for this container.
  }
}

function loadAll() {
  if (responses === null) {
    const raw = loadJson(RESPONSES_FILE, {});
    responses = raw && typeof raw === 'object' ? raw : {};
  }
  if (seenProofs === null) {
    const raw = loadJson(SEEN_FILE, []);
    seenProofs = new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []);
  }
}

function getResponse(taskId) {
  loadAll();
  return Object.prototype.hasOwnProperty.call(responses, taskId) ? responses[taskId] : null;
}

function putResponse(taskId, response) {
  loadAll();
  responses[taskId] = response;
  saveJson(RESPONSES_FILE, responses);
}

function isProofSeen(proofTx) {
  loadAll();
  return typeof proofTx === 'string' && proofTx !== '' && seenProofs.has(proofTx);
}

// Record a proof_tx as seen (called for every processed task that carries
// one, regardless of decision). Returns true if it was newly added.
function markProofSeen(proofTx) {
  loadAll();
  if (typeof proofTx !== 'string' || proofTx === '' || seenProofs.has(proofTx)) return false;
  seenProofs.add(proofTx);
  saveJson(SEEN_FILE, [...seenProofs]);
  return true;
}

function stats() {
  loadAll();
  return {
    tasks: Object.keys(responses).length,
    seenProofs: seenProofs.size,
    backend: 'memory+tmp',
  };
}

module.exports = { getResponse, putResponse, isProofSeen, markProofSeen, stats, STATE_DIR };
