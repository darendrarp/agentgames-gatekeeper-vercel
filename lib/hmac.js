// HMAC signing / verification for the Agent Games dispatch protocol.
//
// ASSUMPTION (confirm in practice mode): the signature is HEX-encoded
// HMAC-SHA256 over the RAW request/response body. If practice mode shows
// base64 instead, flip one line: set HMAC_ENCODING=base64 in the env.
// The secret itself is always taken as a UTF-8 string.
'use strict';
const crypto = require('crypto');

const ENCODING = (process.env.HMAC_ENCODING || 'hex').toLowerCase();
if (!['hex', 'base64'].includes(ENCODING)) throw new Error('HMAC_ENCODING must be hex or base64');

function getSecret() {
  return process.env.AGENT_GAMES_HMAC_SECRET || '';
}

function sign(rawBody, secret) {
  const key = secret !== undefined ? secret : getSecret();
  return crypto.createHmac('sha256', key).update(rawBody).digest(ENCODING);
}

// Constant-time comparison. Accepts an optional "sha256=" prefix on the
// presented signature (some platforms include it).
function verify(rawBody, presented, secret) {
  const key = secret !== undefined ? secret : getSecret();
  if (!presented || typeof presented !== 'string') return false;
  const clean = presented.startsWith('sha256=') ? presented.slice(7) : presented;
  const expected = crypto.createHmac('sha256', key).update(rawBody).digest(ENCODING);
  const a = Buffer.from(clean, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { sign, verify, getSecret, ENCODING };
