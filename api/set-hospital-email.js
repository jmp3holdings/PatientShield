export const maxDuration = 30;

// POST /api/set-hospital-email — patient-side, authenticated by the lead's
// portal token (same trust model as portal-lookup). Body:
// { leadId, portalToken, hospitalBillingEmail }
// Stores the hospital billing department's email on the lead so the dispute
// packet can be sent directly when the case is ready.
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  const { leadId, portalToken, hospitalBillingEmail } = req.body || {};
  if (!leadId || !portalToken) {
    return res.status(401).json({ status: 'error', message: 'Invalid portal link.' });
  }
  const email = String(hospitalBillingEmail || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ status: 'error', message: 'Please enter a valid email address.' });
  }

  const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL;
  const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) {
    return res.status(502).json({ status: 'error', message: 'Service unavailable.' });
  }

  try {
    const redis = async (cmd) => {
      const r = await fetch(redisUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd)
      });
      return r.json();
    };
    const getData = await redis(['GET', `lead:${leadId}`]);
    if (!getData || !getData.result) {
      return res.status(404).json({ status: 'error', message: 'Audit profile not found.' });
    }
    const leadData = JSON.parse(getData.result);
    if (leadData.portalToken !== portalToken) {
      return res.status(401).json({ status: 'error', message: 'Invalid portal link.' });
    }
    leadData.hospitalBillingEmail = email;
    await redis(['SET', `lead:${leadId}`, JSON.stringify(leadData)]);
    return res.status(200).json({ status: 'success', message: 'Hospital billing email saved.' });
  } catch (err) {
    console.error('Set Hospital Email Error:', err);
    return res.status(502).json({ status: 'error', message: 'Service unavailable.' });
  }
}
