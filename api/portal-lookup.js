export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }
  const leadId = req.query.id;
  const portalToken = req.query.t;
  if (!leadId || !portalToken) {
    return res.status(401).json({ status: 'error', message: 'Invalid portal link.' });
  }
  const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL;
  const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) {
    return res.status(502).json({ status: 'error', message: 'Portal lookup is unavailable.' });
  }
  try {
    const getRes = await fetch(redisUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', 'lead:' + leadId])
    });
    const getJson = await getRes.json().catch(() => ({}));
    let lead = null;
    try { lead = getJson.result ? JSON.parse(getJson.result) : null; } catch (e) {}
    if (!lead || lead.portalToken !== portalToken) {
      return res.status(401).json({ status: 'error', message: 'Invalid portal link.' });
    }
    return res.status(200).json({
      status: 'success',
      lead: { id: lead.id, hospitalName: lead.hospitalName, extractedBillAmount: lead.extractedBillAmount }
    });
  } catch (err) {
    console.error('Portal Lookup Error:', err);
    return res.status(502).json({ status: 'error', message: 'Portal lookup is unavailable.' });
  }
}
