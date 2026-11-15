// Kurier (zkVerify relayer) client — CODE ONLY. No API key is configured
// yet, so this module is inert until KURIER_API_KEY is set in the env.
// It is NEVER on the critical path: proof_tx in the response is OPTIONAL,
// and any Kurier failure/timeout must degrade to "no proof_tx", never to
// a failed or late decision.
//
// Documented endpoint (STUDY.md, from the /build guide):
//   POST https://api.kurier.xyz/api/v1/submit-proof/{KEY}
//   { proofType: "groth16", vkRegistered: true,
//     proofOptions: { library: "snarkjs", curve: "bn128" },
//     proofData: { proof, publicSignals, vk: registeredVkHash } }
// Job lifecycle: Submitted -> IncludedInBlock -> Finalized.
//
// NOTE: the status-poll endpoint below is NOT yet verified against live
// Kurier docs (no key, no live calls allowed in this build). It is the
// documented-style path; confirm it when the key exists. Polling runs in
// the background and only ever records an audit result in state.
'use strict';

const BASE = 'https://api.kurier.xyz';
const SUBMIT_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

function isConfigured() {
  return Boolean(process.env.KURIER_API_KEY);
}

async function postJson(url, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`kurier HTTP ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function getJson(url, timeoutMs) {
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`kurier HTTP ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// Submit a proof. Returns the job id (string) or null on any failure.
// Never throws for transport/API errors — callers treat null as "no tx".
async function submitProof({ proof, publicSignals, vkHash }) {
  if (!isConfigured()) return null;
  try {
    const key = process.env.KURIER_API_KEY;
    const out = await postJson(
      `${BASE}/api/v1/submit-proof/${encodeURIComponent(key)}`,
      {
        proofType: 'groth16',
        vkRegistered: true,
        proofOptions: { library: 'snarkjs', curve: 'bn128' },
        proofData: { proof, publicSignals, vk: vkHash },
      },
      SUBMIT_TIMEOUT_MS,
    );
    // Response shape: { jobId } (or { id } / { job_id } — accept variants).
    const jobId = out.jobId || out.job_id || out.id || null;
    return typeof jobId === 'string' && jobId !== '' ? jobId : null;
  } catch (_e) {
    return null;
  }
}

// UNVERIFIED status path — confirm against Kurier docs once a key exists.
async function getJobStatus(jobId) {
  const key = process.env.KURIER_API_KEY;
  return getJson(
    `${BASE}/api/v1/job-status/${encodeURIComponent(key)}/${encodeURIComponent(jobId)}`,
    SUBMIT_TIMEOUT_MS,
  );
}

// Poll a job until Finalized (or timeout). Returns the final status string
// ('Finalized' | 'Failed' | 'Timeout' | 'Error'). Runs in the background;
// never blocks a decision response.
async function pollToFinalized(jobId, onDone) {
  const started = Date.now();
  let status = 'Submitted';
  try {
    while (Date.now() - started < POLL_TIMEOUT_MS) {
      const st = await getJobStatus(jobId);
      status = st.status || st.state || st.jobStatus || 'Unknown';
      if (status === 'Finalized' || status === 'Failed') break;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (status !== 'Finalized' && status !== 'Failed') status = 'Timeout';
  } catch (_e) {
    status = 'Error';
  }
  if (typeof onDone === 'function') {
    try { onDone(jobId, status); } catch (_e) { /* audit only */ }
  }
  return status;
}

module.exports = { isConfigured, submitProof, getJobStatus, pollToFinalized };
