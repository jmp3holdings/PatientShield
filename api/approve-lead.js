export const maxDuration = 60;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  try {
    // Gate this endpoint: the caller must send the admin password as an
    // Authorization header. Fail closed when ADMIN_PASSWORD is unset.
    const adminPass = process.env.ADMIN_PASSWORD;
    if (!adminPass) {
      return res.status(500).json({ status: 'error', message: 'Admin password is not configured.' });
    }
    const authHeader = req.headers.authorization || '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (!provided || provided !== adminPass) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized.' });
    }

    const { leadId } = req.body || {};
    if (!leadId) {
      return res.status(400).json({ status: 'error', message: 'Missing leadId parameter' });
    }

    const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL;
    const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!redisUrl || !redisToken) {
      return res.status(500).json({ status: 'error', message: 'Redis database configuration is missing.' });
    }

    // 1. Fetch lead data from Upstash Redis
    const getRes = await fetch(redisUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', `lead:${leadId}`])
    });
    const getData = await getRes.json();

    if (!getData || !getData.result) {
      return res.status(404).json({ status: 'error', message: 'Lead not found in database.' });
    }

    const leadData = JSON.parse(getData.result);

    if (leadData.approvalStatus === 'approved_and_sent') {
      return res.status(400).json({ status: 'error', message: 'Lead has already been approved and email sent.' });
    }

    const prepared = leadData.preparedEmailContent;
    if (!prepared || !prepared.recipient || !prepared.bodyHtml) {
      return res.status(400).json({ status: 'error', message: 'No prepared email content found for this lead.' });
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) {
      return res.status(500).json({ status: 'error', message: 'RESEND_API_KEY environment variable is missing.' });
    }

    // 2. Dispatch held audit findings email via Resend API
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'The Patient Shield <audit@thepatientshield.com>',
        to: [prepared.recipient],
        subject: prepared.subject,
        html: prepared.bodyHtml
      })
    });

    if (!emailResponse.ok) {
      const emailErrText = await emailResponse.text();
      return res.status(500).json({ status: 'error', message: `Resend API Error: ${emailErrText}` });
    }

    // 3. Update lead status in Redis to reflect successful approval and dispatch
    leadData.approvalStatus = 'approved_and_sent';
    leadData.emailSentAt = new Date().toISOString(); leadData.caseState = 'findings_sent';

    await fetch(redisUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', `lead:${leadId}`, JSON.stringify(leadData)])
    });

    return res.status(200).json({ 
      status: 'success', 
      message: 'Lead approved and email dispatched successfully to client.' 
    });

  } catch (error) {
    console.error('Admin Approval Error:', error);
    return res.status(500).json({ status: 'error', message: 'Internal server error during admin approval.' });
  }
}
