import { checkAdminAuth } from './_admin-auth.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    // Gate this endpoint: the caller must send the admin password as an
    // Authorization header. Fail closed when ADMIN_PASSWORD is unset.
    const auth = await checkAdminAuth(req);
    if (!auth.ok) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized.' });
    }

    const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL;
    const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!redisUrl || !redisToken) {
      return res.status(500).json({ status: 'error', message: 'Database connection variables missing.' });
    }

    const membersRes = await fetch(redisUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SMEMBERS', 'all_leads'])
    });
    const membersData = await membersRes.json();
    const leadIds = membersData.result || [];

    let leads = [];
    for (const id of leadIds) {
      const leadRes = await fetch(redisUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['GET', `lead:${id}`])
      });
      const leadData = await leadRes.json();
      if (leadData.result) {
        try {
          leads.push(JSON.parse(leadData.result));
        } catch (e) {}
      }
    }

    leads.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    return res.status(200).json({ status: 'success', leads });
  } catch (error) {
    console.error('Get Leads Error:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch leads' });
  }
}
