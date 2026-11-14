import {
  normalizeUsername, getUser, saveUser, verifyPassword, totpVerify,
  sha256Hex, normalizeRecoveryCode, signSession,
  getFails, recordFail, clearFails, isLocked, timingSafeStringEqual
} from './_admin-auth.js';

// POST /api/admin-login
// Named account:  { username, password } -> { codeRequired: true } -> { username, password, code } -> { status:'success', token }
//   The code is the 6-digit authenticator code, or a one-time recovery code.
// Legacy (transition): { password } -> { status:'success', token } where the
//   token is the legacy password itself, which checkAdminAuth still accepts.
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }
  try {
    const { username: rawUsername, password, code } = req.body || {};
    const username = normalizeUsername(rawUsername);

    if (!username) {
      // Legacy shared-password path (removed at cutover).
      const adminPass = process.env.ADMIN_PASSWORD;
      if (!adminPass) {
        return res.status(500).json({ status: 'error', message: 'Admin password is not configured.' });
      }
      if (!password || !timingSafeStringEqual(password, adminPass)) {
        return res.status(401).json({ status: 'error', message: 'Incorrect admin password.' });
      }
      return res.status(200).json({ status: 'success', token: password });
    }

    if (!password) {
      return res.status(400).json({ status: 'error', message: 'Password is required.' });
    }

    const fails = await getFails(username);
    if (isLocked(fails)) {
      return res.status(401).json({ status: 'error', message: 'Too many failed attempts. This account is locked for 15 minutes.' });
    }

    const user = await getUser(username);
    if (!user || !user.active || !verifyPassword(password, user.passwordHash)) {
      await recordFail(username, 'pw');
      return res.status(401).json({ status: 'error', message: 'Incorrect username, password, or code.' });
    }

    if (!code) {
      return res.status(401).json({ status: 'error', codeRequired: true, message: 'Enter the 6-digit code from your authenticator app (or a recovery code).' });
    }

    if (totpVerify(user.totpSecret, code)) {
      await clearFails(username);
      const token = await signSession(username);
      return res.status(200).json({ status: 'success', token });
    }

    // One-time recovery code path: consume on use.
    const hash = sha256Hex(normalizeRecoveryCode(code));
    const hashes = Array.isArray(user.recoveryHashes) ? user.recoveryHashes : [];
    const idx = hashes.indexOf(hash);
    if (idx !== -1) {
      hashes.splice(idx, 1);
      user.recoveryHashes = hashes;
      await saveUser(user);
      await clearFails(username);
      const token = await signSession(username);
      return res.status(200).json({ status: 'success', token });
    }

    await recordFail(username, 'code');
    return res.status(401).json({ status: 'error', codeRequired: true, message: 'That code did not match. Try again.' });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Login failed: ' + err.message });
  }
}
