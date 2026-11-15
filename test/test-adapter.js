// Local test for the Vercel adapter (api/index.js). Invokes the exported
// handler directly in Node with mock req/res objects — no HTTP server, no
// Vercel CLI, no live APIs. Run: node test/test-adapter.js
//
// Scenarios mirror ~/workspace/agentgames/agent/test/harness.js:
// healthz, preflight (signed/unsigned), valid task end-to-end with
// groth16 verification, idempotency, all 5 envelope traps over the
// handler, PROOF_REUSED via the in-memory seen-set, 401s, malformed
// input, and the /tmp persistence fallback (fresh store instance reloads
// state from /tmp).
'use strict';

// Env must be set BEFORE requiring the handler (modules read it at load).
process.env.AGENT_GAMES_HMAC_SECRET = 'test-secret-do-not-use-in-production';
process.env.AGENT_STATE_DIR = '/tmp/agentgames-vercel-test-state';
delete process.env.KURIER_API_KEY;
delete process.env.HMAC_ENCODING;

const fs = require('fs');
const { Readable } = require('stream');
const handler = require('../api/index');
const hmac = require('../lib/hmac');
const prover = require('../lib/prover');

const VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const VK_OTHER = '0x1111111111111111111111111111111111111111111111111111111111111111';
const ADDR = '0x2A7bc2FafF1809ddcBDC4FC8d9EB0FFB5708C49F';
const ADDR_OTHER = '0x0000000000000000000000000000000000000001';

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

function envelope(taskId, proofTx, mutate) {
  const now = Date.now();
  const env = {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: taskId,
    mode: 'practice',
    issued_at: new Date(now).toISOString(),
    deadline_at: new Date(now + 60000).toISOString(),
    input: {
      registered_vk: VK,
      proof_vk: VK,
      minimum: '1000',
      public_balance: '1460',
      expiry_block: '8430000',
      current_block: '8420000',
      recipient: ADDR,
      condition_recipient: ADDR,
      amount: '500',
      max_transfer: '1000',
      proof_tx: proofTx,
    },
  };
  if (mutate) mutate(env);
  return env;
}

// Build a mock Vercel (req, res) pair and invoke the handler.
async function invoke(method, path, bodyObj, { sign = true, secret = process.env.AGENT_GAMES_HMAC_SECRET, rawBody = null, preparsed = false } = {}) {
  const body = rawBody !== null ? rawBody : (bodyObj === null ? '' : JSON.stringify(bodyObj));
  const headers = { 'content-type': 'application/json' };
  if (sign && body) headers['x-agent-games-signature'] = hmac.sign(body, secret);
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = path;
  req.headers = headers;
  if (preparsed && bodyObj !== null) req.body = JSON.parse(body); // Vercel pre-parses JSON bodies
  const res = {
    headersSent: false,
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, hdrs) { this.headersSent = true; this.statusCode = status; this.headers = hdrs; },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk); },
  };
  const done = handler(req, res);
  if (body && !preparsed) req.push(Buffer.from(body, 'utf8'));
  req.push(null);
  await done;
  let json = null;
  try { json = JSON.parse(res.body); } catch (_e) { /* keep null */ }
  return {
    status: res.statusCode,
    headers: res.headers || {},
    text: res.body,
    json,
    sig: (res.headers || {})['x-agent-games-signature'] || null,
  };
}

async function main() {
  const start = Date.now();
  fs.rmSync(process.env.AGENT_STATE_DIR, { recursive: true, force: true });

  // 1. GET /healthz
  const health = await invoke('GET', '/healthz', null, { sign: false });
  check('GET /healthz 200 ok:true', health.status === 200 && health.json && health.json.ok === true,
    JSON.stringify(health.json));
  check('healthz reports memory+tmp backend', health.json && health.json.backend === 'memory+tmp');

  // 2. Preflight (signed + unsigned)
  const pf = await invoke('POST', '/agent', { type: 'agent-games.preflight.v1', agent_id: 'test', issued_at: new Date().toISOString(), nonce: 'n1' });
  check('preflight signed -> 200 ok:true v1', pf.status === 200 && pf.json && pf.json.ok === true && pf.json.protocolVersion === 'v1', JSON.stringify(pf.json));
  check('preflight response signature valid', pf.sig !== null && hmac.verify(pf.text, pf.sig));
  const pfUnsigned = await invoke('POST', '/agent', { type: 'agent-games.preflight.v1' }, { sign: false });
  check('preflight unsigned tolerated', pfUnsigned.status === 200);

  // 3. Valid task end-to-end (fresh proof_tx)
  const task1 = envelope('vc-valid-1', '0xddd1');
  const r1 = await invoke('POST', '/agent', task1);
  check('valid task -> APPROVE', r1.status === 200 && r1.json.decision === 'APPROVE' && r1.json.reason_code === 'VALID_CONDITION', JSON.stringify(r1.json).slice(0, 200));
  check('valid task has proof + 13 signals', r1.json.proof && Array.isArray(r1.json.public_signals) && r1.json.public_signals.length === 13);
  check('valid task response signature valid', r1.sig !== null && hmac.verify(r1.text, r1.sig));
  check('no proof_tx without Kurier key', !('proof_tx' in r1.json));
  const e2eOk = await prover.verify(r1.json.proof, r1.json.public_signals);
  check('end-to-end proof verifies (groth16)', e2eOk === true);
  console.log(`      proofBytes=${JSON.stringify(r1.json.proof).length} signals=${r1.json.public_signals.length}`);

  // 3b. Pre-parsed body (Vercel runtime parses JSON before the handler):
  // re-serialization must reproduce the signed bytes, so HMAC still verifies.
  const task1p = envelope('vc-valid-preparsed', '0xddd2');
  const r1p = await invoke('POST', '/agent', task1p, { preparsed: true });
  check('pre-parsed body -> APPROVE', r1p.status === 200 && r1p.json.decision === 'APPROVE' && r1p.json.reason_code === 'VALID_CONDITION', JSON.stringify(r1p.json).slice(0, 200));
  check('pre-parsed response signature valid', r1p.sig !== null && hmac.verify(r1p.text, r1p.sig));
  const e2eOkP = r1p.json.proof ? await prover.verify(r1p.json.proof, r1p.json.public_signals) : false;
  check('pre-parsed proof verifies (groth16)', e2eOkP === true);

  // 4. Idempotency: same task_id again -> byte-identical response
  const r1b = await invoke('POST', '/agent', task1);
  check('idempotency: repeat task identical body', r1b.text === r1.text);

  // 5. Traps over the handler (fresh proof_tx each)
  const trapCases = [
    ['VK_SUBSTITUTION', envelope('vc-vk', '0xddd2', (e) => { e.input.proof_vk = VK_OTHER; }), 'VK_SUBSTITUTION'],
    ['THRESHOLD_MISMATCH', envelope('vc-thr', '0xddd3', (e) => { e.input.public_balance = '500'; }), 'THRESHOLD_MISMATCH'],
    ['RECIPIENT_MISMATCH', envelope('vc-rcpt', '0xddd4', (e) => { e.input.recipient = ADDR_OTHER; }), 'RECIPIENT_MISMATCH'],
    ['EXPIRED_CONDITION', envelope('vc-exp', '0xddd5', (e) => { e.input.current_block = '8440000'; }), 'EXPIRED_CONDITION'],
    ['AMOUNT_OVERFLOW', envelope('vc-amt', '0xddd6', (e) => { e.input.amount = '1500'; }), 'AMOUNT_OVERFLOW'],
  ];
  for (const [name, env, wantReason] of trapCases) {
    const r = await invoke('POST', '/agent', env);
    check(`handler ${name}`, r.status === 200 && r.json.decision === 'REJECT' && r.json.reason_code === wantReason && !('proof' in r.json),
      JSON.stringify(r.json).slice(0, 160));
  }

  // 6. Reuse: same proof_tx as the APPROVED vc-valid-1, new task_id
  //    (exercises the in-memory seen-set of the serverless store)
  const reuseEnv = envelope('vc-reuse-1', '0xddd1');
  const rr = await invoke('POST', '/agent', reuseEnv);
  check('handler PROOF_REUSED (same proof_tx, new task)', rr.status === 200 && rr.json.decision === 'REJECT' && rr.json.reason_code === 'PROOF_REUSED' && !('proof' in rr.json),
    JSON.stringify(rr.json).slice(0, 160));

  // 7. Auth failures
  const unsigned = await invoke('POST', '/agent', envelope('vc-nosig', '0xddd9'), { sign: false });
  check('unsigned task -> 401', unsigned.status === 401, `got ${unsigned.status}`);
  const wrongSig = await invoke('POST', '/agent', envelope('vc-wrongsig', '0xddda'), { secret: 'wrong-secret' });
  check('wrong-signature task -> 401', wrongSig.status === 401, `got ${wrongSig.status}`);

  // 8. Malformed input + routing
  const badJson = await invoke('POST', '/agent', null, { rawBody: '{not json' });
  check('invalid JSON -> 400', badJson.status === 400, `got ${badJson.status}`);
  const unknownType = await invoke('POST', '/agent', { type: 'agent-games.something-else.v1', task_id: 'x' });
  check('unknown type -> 400', unknownType.status === 400, `got ${unknownType.status}`);
  const noTaskId = await invoke('POST', '/agent', { type: 'agent-games.proof-gatekeeper.v1', input: {} });
  check('missing task_id -> 400', noTaskId.status === 400, `got ${noTaskId.status}`);
  const del = await invoke('DELETE', '/agent', null, { sign: false });
  check('DELETE -> 404', del.status === 404, `got ${del.status}`);
  // Rewritten path (what Vercel passes after the /agent rewrite): the
  // adapter routes by method, so /api/index must dispatch identically.
  const viaRewrite = await invoke('POST', '/api/index', envelope('vc-rewrite-1', '0xdddb'));
  check('POST /api/index (rewritten) -> APPROVE', viaRewrite.status === 200 && viaRewrite.json.decision === 'APPROVE',
    JSON.stringify(viaRewrite.json).slice(0, 160));

  // 9. /tmp persistence fallback: files exist, and a FRESH store instance
  //    (require-cache bust, simulating a new container) reloads them.
  const responsesFile = process.env.AGENT_STATE_DIR + '/responses.json';
  const seenFile = process.env.AGENT_STATE_DIR + '/seen_proofs.json';
  check('/tmp responses.json written', fs.existsSync(responsesFile));
  check('/tmp seen_proofs.json written', fs.existsSync(seenFile));
  const storePath = require.resolve('../lib/store-serverless');
  delete require.cache[storePath];
  const freshStore = require('../lib/store-serverless');
  const reloaded = freshStore.getResponse('vc-valid-1');
  check('fresh store reloads stored response from /tmp', reloaded !== null && reloaded.decision === 'APPROVE');
  check('fresh store reloads seen proof_tx from /tmp', freshStore.isProofSeen('0xddd1') === true);
  check('fresh store does not invent unseen proof_tx', freshStore.isProofSeen('0xnever-seen') === false);

  console.log(`\n==== ${passed} passed, ${failed} failed (${Date.now() - start}ms total) ====`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ADAPTER TEST ERROR:', e); process.exit(2); });
