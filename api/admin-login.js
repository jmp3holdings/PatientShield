export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  try {
    const { password, action } = req.body || {};

    // Forgot-password requests no longer email a password. The owner
    // resets the password in the hosting (Vercel) environment settings.
    if (action === 'forgot') {
      return res.status(200).json({ status: 'success', message: 'The admin password is reset by the owner in the Vercel project environment settings.' });
    }

    const adminPass = process.env.ADMIN_PASSWORD;
    if (!adminPass) {
      return res.status(500).json({ status: 'error', message: 'Admin password is not configured.' });
    }

    if (password === adminPass) {
      return res.status(200).json({ status: 'success' });
    } else {
      return res.status(401).json({ status: 'error', message: 'Incorrect admin password.' });
    }
  } catch (error) {
    console.error('Admin Auth Error:', error);
    return res.status(500).json({ status: 'error', message: 'Authentication error.' });
  }
}
