# Proof Gatekeeper agent — Vercel deployment package

Deploy-ready, self-contained package for the zkVerify Agent Games
Proof Gatekeeper agent. Run `vercel deploy` from THIS directory alone —
no other directory is needed: the agent logic, snarkjs, and the
gatekeeper circuit artifacts are all vendored here.

**Status: PACKAGING ONLY.** Nothing here has been deployed and no account
has been created. Deployment is one step once the user gives the go-ahead
(see below).

## What is inside

| Path | What it is |
|---|---|
| `api/index.js` | Vercel serverless function: HMAC gate, preflight, task dispatch, response signing. Imports (does not duplicate) the decision/proving code. |
| `lib/hmac.js`, `lib/decision.js`, `lib/prover.js`, `lib/kurier.js` | Vendored copies of the agent's lib modules. Only `prover.js` differs from the original: its three default paths point at this package's own `vendor/` + `circuits/` dirs (env overrides still work). |
| `lib/store-serverless.js` | In-memory + `/tmp` idempotency + seen-set (same interface as the agent's disk-backed `store.js`). See the caveat below. |
| `vendor/snarkjs/` | snarkjs 0.7.6: the UMD bundle (`snarkjs.min.js`, 688 KB) + the shim `index.cjs` (bundle path made relative to the file). No npm install needed. |
| `circuits/gatekeeper.wasm`, `circuits/gatekeeper_final.zkey` | The real Gatekeeper circuit artifacts (sha256-verified against `~/workspace/agentgames/circuits/`). |
| `vercel.json` | Routes `/agent` + `/healthz` to the function; `maxDuration: 10` (prove takes ~0.6s); `includeFiles` forces the circuit + vendor files into the function bundle (they are read via `fs.readFileSync`, which Vercel's file tracer would otherwise miss). |
| `test/test-adapter.js` | Local test: invokes the handler directly with mock req/res. **29/29 PASS** (15 Nov 2026, ~1.5s): healthz, preflight signed/unsigned, valid task → APPROVE + groth16-verified proof, idempotency, all 5 traps, PROOF_REUSED, 401s, malformed input, rewritten `/api/index` path, /tmp persistence reload. Run with `node test/test-adapter.js`. |
| `.env.example`, `.gitignore`, `package.json` | Env template (blanks only), git ignores (`.env`, `node_modules`), zero npm dependencies. |

## Deploy — exact steps

### Prerequisites (do these first)

1. **Vercel account.** Create one at https://vercel.com/signup
   (GitHub OAuth with the `darendrarp` account is the natural path).
   Do NOT create it until the user says go.
2. **HMAC secret.** In the Agent Games dashboard, register the agent
   and use **Rotate Secret** to get the 32-byte HMAC secret. The secret
   is shown ONCE — copy it immediately. (Registration is blocked by the
   site's profile 500 as of 15 Nov ~13:28; the retry cron runs 17:14.)
3. **Vercel CLI** on this VM (one-time):
   `npm install -g vercel` — if npm install fails in this VM sandbox
   (EPERM, as with snarkjs), use `npx vercel@latest` instead, or use
   the dashboard route (Option B) which needs no CLI.

### Option A — Vercel CLI (fastest)

```bash
cd ~/workspace/agentgames/vercel
vercel login            # browser OAuth — approve the Vercel account
vercel --prod --yes     # first run links/creates the project; note the URL
```

Then set the secret (non-interactive, value via stdin — never in a file):

```bash
printf '%s' '<PASTE_THE_32_BYTE_HMAC_SECRET>' | vercel env add AGENT_GAMES_HMAC_SECRET production
```

Optional: `printf '%s' '<KURIER_API_KEY>' | vercel env add KURIER_API_KEY production`
(only if a Kurier key exists; without it `proof_tx` is omitted, which is fine).

Env-var changes need a redeploy to take effect:

```bash
vercel --prod --yes
```

### Option B — Dashboard (no CLI)

1. Push this directory to a GitHub repo (e.g. `darendrarp/agentgames-gatekeeper`):
   `git init && git add . && git commit -m "gatekeeper vercel package" && git push`.
   (Never commit a filled `.env` — it is git-ignored.)
2. https://vercel.com/new → **Import Git Repository** → pick the repo →
   Framework Preset: **Other** → Root Directory: `.` (repo root) → Deploy.
3. Project → **Settings → Environment Variables** → add
   `AGENT_GAMES_HMAC_SECRET` = the 32-byte secret (Production scope),
   and `KURIER_API_KEY` if available → **Redeploy**
   (Deployments → ⋯ → Redeploy).

### After deploy — verify, then register

1. Health check (replace `<project>` with the deployed URL):
   `curl -s https://<project>.vercel.app/healthz`
   Expect: `{"ok":true,"tasks":0,"seenProofs":0,"backend":"memory+tmp"}`.
2. Preflight from the Agent Games dashboard should pass (the platform
   POSTs `{type:"agent-games.preflight.v1"}` to the endpoint).
3. Register the endpoint URL in the dashboard as
   `https://<project>.vercel.app/agent` (the full handler path, not root).
4. Run at least **one practice task** and confirm the response is signed
   and, for a valid task, carries a verifying proof — this also confirms
   the open questions (HMAC hex vs base64, taskId mapping, proof JSON
   shape) before any scored round.
5. Enter the next Gatekeeper round (rounds run 17:30–03:30 WIB;
   entries lock while a round is open).

### Cold starts

The first request to a cold container loads snarkjs (~0.7 MB) + the
circuit (~2 MB) into memory — measured locally at well under 2s total
including the ~0.6s prove. That is far inside the 60s task deadline and
the 10s `maxDuration`. Warm invocations answer in milliseconds for
REJECT and ~0.6s for APPROVE.

## State-persistence caveat (read before racing)

Vercel functions are stateless: each invocation may run in a fresh
container with empty memory and an empty `/tmp`, and concurrent
invocations run in separate containers. This package's store keeps state
in memory (primary) with a best-effort `/tmp` fallback, so idempotency
and the PROOF_REUSED seen-set work **within one warm container** but are
**lost on cold start and not shared across concurrent instances**. A
replayed `proof_tx` that lands on a fresh container would NOT be
recognised as reused: the task would then be decided on its envelope
alone, and if the envelope is otherwise valid it would be APPROVED
(−6 for a wrong approve, vs −3 for a wrong reject). In practice the
platform dispatches at most 8 tasks per round over 10 hours, so
concurrent-instance splits are unlikely, but cold starts between rounds
are expected — the seen-set effectively resets between rounds.

**Upgrade path (do this before relying on the agent in scored rounds):**
move the seen-set (and, ideally, the idempotency store) to **Vercel KV**
(Upstash Redis, free tier): `vercel kv create` in the dashboard, then
swap `lib/store-serverless.js` for a KV-backed store with the same
interface (`getResponse`/`putResponse`/`isProofSeen`/`markProofSeen`).
No KV store has been created by this package — that needs the Vercel
account + a user decision.

## Assumptions still to confirm in practice mode

Same as the agent README: (1) HMAC encoding is hex (flip with
`HMAC_ENCODING=base64` if practice mode shows base64); (2) taskId
mapping (numeric passthrough, else first 31 bytes of SHA-256);
(3) proof JSON shape (raw snarkjs object + decimal-string
`public_signals`). If practice mode contradicts any of these, fix the
vendored `lib/` here AND the original in `~/workspace/agentgames/agent/`
so the two do not drift.
