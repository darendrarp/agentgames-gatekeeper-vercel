// Vercel serverless function adapter for the Proof Gatekeeper agent.
//
// This is the HTTP glue from ~/workspace/agentgames/agent/server.js,
// adapted to Vercel's (req, res) function signature. The decision logic
// (lib/decision.js), proving (lib/prover.js), HMAC (lib/hmac.js) and
// Kurier client (lib/kurier.js) are IMPORTED from the vendored copies in
// this package — not duplicated here. The only deliberately different
// module is the store: lib/store-serverless.js (in-memory + /tmp),
// because Vercel functions are stateless (see README.md caveat).
//
// Routing is deliberately path-tolerant: after a vercel.json rewrite the
// function cannot reliably see the original path, so it routes by METHOD:
//   GET  -> healthz (liveness + store stats, no auth)
//   POST -> dispatch (preflight or task, by envelope.type; HMAC-gated)
// Anything else -> 404. The public URLs are /agent and /healthz via the
// rewrites in vercel.json; the function itself also answers at /api/index.
//
// Env: AGENT_GAMES_HMAC_SECRET (required in production; without it the
// function runs in INSECURE DEV MODE and logs a warning per request),
// KURIER_API_KEY (optional; no key => no Kurier calls, proof_tx omitted),
// HMAC_ENCODING (hex|base64, default hex), AGENT_STATE_DIR (default
// /tmp/agentgames-state — see store-serverless.js).
'use strict';
const hmac = require('../lib/hmac');
const { decide } = require('../lib/decision');
const prover = require('../lib/prover');
const kurier = require('../lib/kurier');
const store = require('../lib/store-serverless');

const MAX_BODY_BYTES = 1024 * 1024; // envelopes are a few KB; 1MB is generous

const inflight = new Map(); // task_id -> Promise<response object> (concurrent-dup guard)

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sendJson(res, status, obj, signIt) {
  const body = JSON.stringify(obj);
  const headers = { 'content-type': 'application/json' };
  if (signIt && hmac.getSecret()) headers['x-agent-games-signature'] = hmac.sign(body);
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  // Vercel's Node runtime pre-parses JSON bodies into req.body (object)
  // despite module.exports.config bodyParser:false, which @vercel/node
  // only honors for ESM `export const config`. Prefer the raw stream when
  // available; when the body is already parsed, re-serialize it. That is
  // byte-identical to the sender's body when the sender used compact JSON
  // (standard for JSON API clients): JSON.parse preserves key order for
  // string keys and JSON.stringify emits them in the same order.
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body, 'utf8'));
  if (req.body !== undefined && req.body !== null) {
    try {
      return Promise.resolve(Buffer.from(JSON.stringify(req.body), 'utf8'));
    } catch (e) {
      return Promise.reject(new Error('pre-parsed body not serializable'));
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleTask(envelope) {
  const taskId = envelope.task_id;
  const nowMs = Date.now();

  // Idempotency: a re-dispatched task gets the exact stored response.
  const stored = store.getResponse(taskId);
  if (stored) {
    log(`task ${taskId}: replay (stored ${stored.decision}/${stored.reason_code})`);
    return stored;
  }

  const t0 = Date.now();
  const verdict = decide(envelope, { nowMs, isProofSeen: (tx) => store.isProofSeen(tx) });

  // Record the proof_tx as seen for every processed task, whatever the
  // decision — a later task reusing it is a PROOF_REUSED trap.
  const proofTx = envelope.input && typeof envelope.input.proof_tx === 'string'
    ? envelope.input.proof_tx.trim()
    : '';
  if (proofTx !== '') store.markProofSeen(proofTx);

  let response;
  if (verdict.decision === 'APPROVE') {
    try {
      const { proof, publicSignals, proveMs } = await prover.prove(envelope);
      response = {
        decision: 'APPROVE',
        reason_code: 'VALID_CONDITION',
        proof,
        public_signals: publicSignals,
      };
      // Optional Kurier submission (inert without a key; never blocks the
      // decision — 15s cap inside the client, failure => no proof_tx).
      if (kurier.isConfigured()) {
        const jobId = await kurier.submitProof({
          proof,
          publicSignals,
          vkHash: envelope.input.registered_vk,
        });
        if (jobId) {
          response.proof_tx = jobId;
          kurier.pollToFinalized(jobId, (_id, status) => {
            log(`task ${taskId}: kurier job ${jobId} -> ${status}`);
          }).catch(() => {});
        }
      }
      log(`task ${taskId}: APPROVE VALID_CONDITION prove=${proveMs}ms total=${Date.now() - t0}ms`);
    } catch (e) {
      // The circuit enforces the same conditions as decide(), so this
      // should never happen on a genuinely valid task. Fail closed.
      log(`task ${taskId}: prove FAILED (${String(e.message).slice(0, 120)}) -> REJECT`);
      response = { decision: 'REJECT', reason_code: 'INTERNAL_ERROR' };
    }
  } else {
    // REJECT responses carry NO proof: the circuit cannot prove
    // decision=0, and PROOF_REUSED tasks have no proof to submit.
    response = { decision: 'REJECT', reason_code: verdict.reason_code };
    log(`task ${taskId}: REJECT ${verdict.reason_code} total=${Date.now() - t0}ms`);
  }

  store.putResponse(taskId, response);
  return response;
}

function handlePreflight() {
  return { ok: true, protocolVersion: 'v1' };
}

async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...store.stats() }, false);
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 404, { error: 'not found' }, false);
      return;
    }

    let rawBody;
    try {
      rawBody = await readBody(req);
    } catch (e) {
      log(`body read failed: ${String(e.message).slice(0, 120)}`);
      sendJson(res, 400, { error: 'bad request' }, false);
      return;
    }
    const secret = hmac.getSecret();
    const signature = req.headers['x-agent-games-signature'];

    // HMAC verification BEFORE acting on the content. A present signature
    // must verify (checked here, before any JSON parsing). An absent
    // signature is tolerated ONLY for preflight (liveness check — the
    // platform may or may not sign it); task dispatches require one.
    if (secret) {
      if (typeof signature === 'string') {
        if (!hmac.verify(rawBody, signature, secret)) {
          log('HMAC mismatch -> 401');
          sendJson(res, 401, { error: 'bad signature' }, false);
          return;
        }
      }
    } else {
      log('WARNING: AGENT_GAMES_HMAC_SECRET unset — INSECURE DEV MODE, skipping HMAC');
    }

    let envelope;
    try {
      envelope = JSON.parse(rawBody.toString('utf8'));
    } catch (_e) {
      sendJson(res, 400, { error: 'invalid JSON' }, false);
      return;
    }

    if (secret && typeof signature !== 'string' && envelope.type !== 'agent-games.preflight.v1') {
      log('missing signature on non-preflight request -> 401');
      sendJson(res, 401, { error: 'missing signature' }, false);
      return;
    }
    if (secret && typeof signature !== 'string' && envelope.type === 'agent-games.preflight.v1') {
      log('preflight without signature — answering anyway (liveness check)');
    }

    if (envelope.type === 'agent-games.preflight.v1') {
      sendJson(res, 200, handlePreflight(), true);
      return;
    }

    if (envelope.type !== 'agent-games.proof-gatekeeper.v1') {
      sendJson(res, 400, { error: 'unknown type' }, true);
      return;
    }

    if (typeof envelope.task_id !== 'string' || envelope.task_id === '') {
      sendJson(res, 400, { error: 'missing task_id' }, true);
      return;
    }

    // Concurrent duplicates of the same task_id share one handling run.
    let job = inflight.get(envelope.task_id);
    if (!job) {
      job = handleTask(envelope).finally(() => inflight.delete(envelope.task_id));
      inflight.set(envelope.task_id, job);
    }
    const response = await job;
    sendJson(res, 200, response, true);
  } catch (e) {
    log(`handler error: ${String(e.message).slice(0, 200)}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }, false);
  }
}

module.exports = handler;
module.exports.handleTask = handleTask;
module.exports.handlePreflight = handlePreflight;
// Disable Vercel's default JSON body parser: HMAC verification needs the
// exact raw request bytes, and a pre-parsed req.body loses them (live
// 400s on 2026-11-15 proved the runtime pre-parses without this).
module.exports.config = { api: { bodyParser: false } };
