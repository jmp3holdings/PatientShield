import crypto from 'node:crypto';

// Shared admin authentication for ArguBill.
// Named accounts live in the existing Redis/KV store:
//   admin:user:<username>      -> JSON { username, passwordHash, totpSecret, active, recoveryHashes, createdAt }
//   admin:session_secret       -> HMAC secret for session tokens (auto-created)
//   admin:loginfails:<username>-> JSON { pw, code, lockedUntil }
// Transition rule: the legacy shared ADMIN_PASSWORD is still accepted
// (as a login and as a Bearer token) until the cutover pass removes it.

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

export async function redisCmd(...args) {
  const { url, token } = redisConfig();
  if (!url || !token) throw new Error('Database connection variables missing.');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  const data = await r.json();
  if (data.error) throw new Error('Redis error: ' + data.error);
  return data.result;
}

export function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase();
}

export async function getUser(username) {
  const raw = await redisCmd('GET', 'admin:user:' + username);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function saveUser(user) {
  await redisCmd('SET', 'admin:user:' + user.username, JSON.stringify(user));
}

export async function deleteUser(username) {
  await redisCmd('DEL', 'admin:user:' + username);
  await redisCmd('DEL', 'admin:loginfails:' + username);
}

// ---- password hashing (scrypt) ----
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return 'scrypt:' + salt.toString('base64') + ':' + hash.toString('base64');
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

export function timingSafeStringEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---- base32 (RFC 4648) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// ---- TOTP (RFC 6238, SHA-1, 30s step, 6 digits) ----
export function totpCode(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(binary % 1000000).padStart(6, '0');
}

export function totpVerify(secretBase32, code) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const now = Math.floor(Date.now() / 30000);
  for (const delta of [-1, 0, 1]) {
    if (timingSafeStringEqual(totpCode(secretBase32, now + delta), clean)) return true;
  }
  return false;
}

export function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// ---- recovery codes ----
export function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}
export function makeRecoveryCodes() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const codes = [];
  for (let i = 0; i < 8; i++) {
    let part = () => Array.from(crypto.randomBytes(4)).map(b => alphabet[b % alphabet.length]).join('');
    codes.push(part() + '-' + part());
  }
  return codes;
}
export function normalizeRecoveryCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[\s-]/g, '');
}

// ---- session tokens (HMAC-SHA256, 12h) ----
async function sessionSecret() {
  let secret = await redisCmd('GET', 'admin:session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    await redisCmd('SET', 'admin:session_secret', secret);
  }
  return secret;
}
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

export async function signSession(username) {
  const secret = await sessionSecret();
  const payload = { u: username, exp: Math.floor(Date.now() / 1000) + 12 * 3600 };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return body + '.' + sig;
}

export async function verifySession(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const secret = await sessionSecret();
    const expected = b64url(crypto.createHmac('sha256', secret).update(parts[0]).digest());
    if (!timingSafeStringEqual(expected, parts[1])) return null;
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload.u || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ---- login failure lockouts: 5 bad passwords / 8 bad codes -> 15 min ----
export async function getFails(username) {
  const raw = await redisCmd('GET', 'admin:loginfails:' + username);
  if (!raw) return { pw: 0, code: 0, lockedUntil: 0 };
  try { return JSON.parse(raw); } catch { return { pw: 0, code: 0, lockedUntil: 0 }; }
}
export async function saveFails(username, fails) {
  await redisCmd('SET', 'admin:loginfails:' + username, JSON.stringify(fails));
}
export async function recordFail(username, kind) {
  const fails = await getFails(username);
  fails[kind] = (fails[kind] || 0) + 1;
  if (fails.pw >= 5 || fails.code >= 8) {
    fails.lockedUntil = Date.now() + 15 * 60 * 1000;
  }
  await saveFails(username, fails);
  return fails;
}
export async function clearFails(username) {
  await redisCmd('DEL', 'admin:loginfails:' + username);
}
export function isLocked(fails) {
  return fails && fails.lockedUntil && fails.lockedUntil > Date.now();
}

// ---- the gate every admin endpoint uses ----
export async function checkAdminAuth(req) {
  const authHeader = (req.headers && req.headers.authorization) || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  if (!provided) return { ok: false };
  const session = await verifySession(provided);
  if (session) return { ok: true, via: 'session', user: session.u };
  const legacy = process.env.ADMIN_PASSWORD;
  if (legacy && timingSafeStringEqual(provided, legacy)) return { ok: true, via: 'legacy' };
  return { ok: false };
}
