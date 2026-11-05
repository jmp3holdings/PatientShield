export const maxDuration = 60;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  try {
    const payload = req.body || {};
    const senderEmail = payload.from || '';
    const attachments = payload.attachments || [];
    const subject = payload.subject || '';
    const bodyText = payload.text || payload.plain || '';
    const snippet = String(bodyText).replace(/\s+/g, ' ').trim().slice(0, 500);

    if (!senderEmail) {
      return res.status(400).json({ status: 'error', message: 'No sender email provided' });
    }

    const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL;
    const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    const sender = senderEmail.toLowerCase();
    let matched = null;

    if (redisUrl && redisToken) {
      const redis = async (cmd) => {
        const r = await fetch(redisUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(cmd)
        });
        return r.json();
      };

      const setData = await redis(['SMEMBERS', 'all_leads']);
      const leadIds = (setData && setData.result) || [];
      const receivedAt = new Date().toISOString();

      for (const leadId of leadIds) {
        const leadDataJson = await redis(['GET', `lead:${leadId}`]);
        if (!leadDataJson || !leadDataJson.result) continue;
        const lead = JSON.parse(leadDataJson.result);

        if (lead.hospitalBillingEmail && sender.includes(lead.hospitalBillingEmail.toLowerCase())) {
          const replies = Array.isArray(lead.hospitalReplies) ? lead.hospitalReplies : [];
          replies.push({ from: senderEmail, subject, receivedAt, snippet });
          lead.hospitalReplies = replies;
          if (!lead.hospitalReplyAt) lead.hospitalReplyAt = receivedAt;
          if (lead.caseState === 'dispute_sent') lead.caseState = 'hospital_review';
          await redis(['SET', `lead:${leadId}`, JSON.stringify(lead)]);
          matched = 'hospital';

          const resendKey = process.env.RESEND_API_KEY;
          const adminEmail = process.env.ADMIN_EMAIL || 'admin@thepatientshield.com';
          if (resendKey) {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'audit@thepatientshield.com',
                to: adminEmail,
                subject: `Hospital reply received — ${lead.fullName || 'client'} / ${lead.hospitalName || 'facility'}`,
                text: `A reply arrived from the hospital billing address on file (${lead.hospitalBillingEmail}).\n\nFrom: ${senderEmail}\nSubject: ${subject}\nReceived: ${receivedAt}\nCase state: ${lead.caseState}\n\nExcerpt:\n${snippet || '(no text body)'}\n\nReview the lead in the admin dashboard.`
              })
            }).catch(() => null);
          }
          break;
        }

        if (lead.clientEmail && sender.includes(lead.clientEmail.toLowerCase())) {
          if (attachments.length > 0) {
            const attachment = attachments[0];
            lead.recordsName = attachment.filename || 'Client_Reply_Document.pdf';
            if (attachment.content) {
              lead.fileData = `data:${attachment.content_type || 'application/pdf'};base64,${attachment.content}`;
            }
          }
          const clientReplies = Array.isArray(lead.clientReplies) ? lead.clientReplies : [];
          clientReplies.push({ from: senderEmail, subject, receivedAt, snippet, hasAttachment: attachments.length > 0 });
          lead.clientReplies = clientReplies;
          await redis(['SET', `lead:${leadId}`, JSON.stringify(lead)]);
          matched = 'client';
          break;
        }
      }
    }

    return res.status(200).json({ status: 'success', message: 'Inbound email processed.', matched });
  } catch (error) {
    console.error('Inbound Email Webhook Error:', error);
    return res.status(500).json({ status: 'error', message: 'Internal server error processing inbound email.' });
  }
}
