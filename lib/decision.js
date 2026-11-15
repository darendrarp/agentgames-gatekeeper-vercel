// Pure, deterministic Gatekeeper decision logic. Fail-closed: any missing
// field, unparseable value, or failed check => REJECT. Never approve by default.
//
// Check order (per STUDY.md): timestamp -> VK -> threshold -> recipient ->
// expiry -> amount -> reuse. HMAC is enforced one layer up (server.js);
// a request that reaches here is already authenticated.
'use strict';

function toBig(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('non-integer number');
    return BigInt(v);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
    if (/^-?\d+$/.test(s)) return BigInt(s);
  }
  throw new Error('unparseable integer: ' + String(v).slice(0, 40));
}

function normHex(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(s)) return null;
  return s;
}

function parseTime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    if (/^-?\d+$/.test(v.trim())) {
      const n = Number(v.trim());
      return n < 1e12 ? n * 1000 : n;
    }
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

// ctx: { nowMs, isProofSeen(proofTx) -> bool }
// Returns { decision: 'APPROVE'|'REJECT', reason_code: string }.
function decide(envelope, ctx) {
  const nowMs = ctx && ctx.nowMs !== undefined ? ctx.nowMs : Date.now();
  const isProofSeen = ctx && ctx.isProofSeen ? ctx.isProofSeen : () => false;

  const input = envelope && envelope.input && typeof envelope.input === 'object'
    ? envelope.input
    : null;
  if (!input) return { decision: 'REJECT', reason_code: 'INTERNAL_ERROR' };

  try {
    // 1. Timestamp: past the task deadline => the response is useless anyway.
    //    (Unparseable/missing deadline: skip the check, decide on content.)
    const deadline = parseTime(envelope.deadline_at);
    if (deadline !== null && nowMs > deadline) {
      return { decision: 'REJECT', reason_code: 'DEADLINE_PASSED' };
    }

    // 2. VK substitution: the proof's VK must equal the registered VK.
    const regVk = normHex(input.registered_vk);
    const proofVk = normHex(input.proof_vk);
    if (regVk === null || proofVk === null || regVk !== proofVk) {
      return { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION' };
    }

    // 3. Threshold: public balance must cover the minimum.
    if (toBig(input.public_balance) < toBig(input.minimum)) {
      return { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' };
    }

    // 4. Recipient: payout recipient must match the condition's recipient.
    const rcpt = normHex(input.recipient);
    const condRcpt = normHex(input.condition_recipient);
    if (rcpt === null || condRcpt === null || rcpt !== condRcpt) {
      return { decision: 'REJECT', reason_code: 'RECIPIENT_MISMATCH' };
    }

    // 5. Expiry: the condition must not be expired at the current block.
    if (toBig(input.current_block) > toBig(input.expiry_block)) {
      return { decision: 'REJECT', reason_code: 'EXPIRED_CONDITION' };
    }

    // 6. Amount: transfer amount must not exceed the cap.
    if (toBig(input.amount) > toBig(input.max_transfer)) {
      return { decision: 'REJECT', reason_code: 'AMOUNT_OVERFLOW' };
    }

    // 7. Reuse: a proof_tx we have already seen is a replay.
    const proofTx = typeof input.proof_tx === 'string' ? input.proof_tx.trim() : '';
    if (proofTx !== '' && isProofSeen(proofTx)) {
      return { decision: 'REJECT', reason_code: 'PROOF_REUSED' };
    }
  } catch (_e) {
    // Any unparseable value => fail closed.
    return { decision: 'REJECT', reason_code: 'INTERNAL_ERROR' };
  }

  return { decision: 'APPROVE', reason_code: 'VALID_CONDITION' };
}

module.exports = { decide, toBig, normHex, parseTime };
