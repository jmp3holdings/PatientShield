import {
  normalizeUsername, getUser, saveUser, deleteUser, hashPassword,
  newTotpSecret, totpVerify, makeRecoveryCodes, sha256Hex,
  normalizeRecoveryCode, timingSafeStringEqual
} from './_admin-auth.js';

// POST /api/admin-enroll — gated by the CURRENT legacy admin password
// (body.currentPassword). Actions:
//   start   { username, newPassword } -> { totpSecret, otpauthUrl } (shown once)
//   confirm { username, code }        -> activates the account, returns 8
//                                        one-time recovery codes (shown once)
//   remove  { username }              -> deletes the account
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }
  try {
    const adminPass = process.env.ADMIN_PASSWORD;
    if (!adminPass) {
      return res.status(500).json({ status: 'error', message: 'Admin password is not configured.' });
    }
    const { action, currentPassword, username: rawUsername, newPassword, code } = req.body || {};
    if (!currentPassword || !timingSafeStringEqual(currentPassword, adminPass)) {
      return res.status(401).json({ status: 'error', message: 'Incorrect admin password.' });
    }
    const username = normalizeUsername(rawUsername);
    if (!/^[a-z0-9@._+\-]{3,64}$/.test(username)) {
      return res.status(400).json({ status: 'error', message: 'Username must be 3-64 characters (letters, numbers, @ . _ + -).' });
    }

    if (action === 'start') {
      if (!newPassword || String(newPassword).length < 12) {
        return res.status(400).json({ status: 'error', message: 'New password must be at least 12 characters.' });
      }
      const existing = await getUser(username);
      if (existing && existing.active) {
        return res.status(409).json({ status: 'error', message: 'That username already has an active account. Remove it first to re-enroll.' });
      }
      const totpSecret = newTotpSecret();
      const user = {
        username,
        passwordHash: hashPassword(String(newPassword)),
        totpSecret,
        active: false,
        recoveryHashes: [],
        createdAt: new Date().toISOString()
      };
      await saveUser(user);
      const otpauthUrl = 'otpauth://totp/ArguBill:' + encodeURIComponent(username) +
        '?secret=' + totpSecret + '&issuer=ArguBill&digits=6&period=30';
      return res.status(200).json({ status: 'success', totpSecret, otpauthUrl });
    }

    if (action === 'confirm') {
      const user = await getUser(username);
      if (!user) {
        return res.status(404).json({ status: 'error', message: 'No enrollment was started for that username.' });
      }
      if (user.active) {
        return res.status(409).json({ status: 'error', message: 'That account is already active.' });
      }
      if (!totpVerify(user.totpSecret, code)) {
        return res.status(401).json({ status: 'error', message: 'That code did not match the setup key. Check the authenticator entry and try again.' });
      }
      const codes = makeRecoveryCodes();
      user.recoveryHashes = codes.map(c => sha256Hex(normalizeRecoveryCode(c)));
      user.active = true;
      user.activatedAt = new Date().toISOString();
      await saveUser(user);
      return res.status(200).json({ status: 'success', recoveryCodes: codes });
    }

    if (action === 'remove') {
      await deleteUser(username);
      return res.status(200).json({ status: 'success', message: 'Account removed.' });
    }

    return res.status(400).json({ status: 'error', message: 'Unknown action.' });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Enrollment failed: ' + err.message });
  }
}
