export const maxDuration = 60;

// POST /api/send-dispute — admin only (Bearer ADMIN_PASSWORD, same gate as
// approve-lead). Body: { leadId, hospitalEmail? }
// Sends the case's dispute packet to the hospital billing department by email
// via Resend: the AI-drafted dispute letter, the itemized findings, the
// patient's intake authorization (agreement record), and the bill file as an
// attachment when available. Refuses when: no authorization on file, no
// disputable findings (estimatedSavings $0.00 / no-findings letter), no
// destination email, or the dispute was already sent. On success records
// disputeSentAt / disputeSentTo / disputeChannel and caseState 'dispute_sent'.
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
    const authHeader = req.headers.authorization || '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (!provided || provided !== adminPass) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized.' });
    }

    const { leadId, hospitalEmail } = req.body || {};
    if (!leadId) {
      return res.status(400).json({ status: 'error', message: 'Missing leadId parameter' });
    }

    const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL;
    const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!redisUrl || !redisToken) {
      return res.status(500).json({ status: 'error', message: 'Redis database configuration is missing.' });
    }
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
      return res.status(404).json({ status: 'error', message: 'Lead not found in database.' });
    }
    const leadData = JSON.parse(getData.result);

    if (leadData.disputeSentAt) {
      return res.status(400).json({ status: 'error', message: 'The dispute for this lead has already been sent.' });
    }
    if (!leadData.agreement || leadData.agreement.accepted !== true) {
      return res.status(400).json({ status: 'error', message: 'No patient authorization on file for this lead; the dispute cannot be sent.' });
    }
    const letter = String(leadData.disputeLetterDraft || '');
    const hasFindings = Array.isArray(leadData.analysisFindings) && leadData.analysisFindings.length > 0;
    if (!hasFindings || leadData.estimatedSavings === '$0.00' || letter.startsWith('Audit Complete: No billable errors')) {
      return res.status(400).json({ status: 'error', message: 'This lead has no disputable findings; there is no dispute to send.' });
    }

    const destination = String(hospitalEmail || leadData.hospitalBillingEmail || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination)) {
      return res.status(400).json({ status: 'error', message: 'A valid hospital billing email is required (none on file and none provided).' });
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) {
      return res.status(500).json({ status: 'error', message: 'RESEND_API_KEY environment variable is missing.' });
    }

    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const findingsHtml = leadData.analysisFindings.map(f => `<li><strong>${esc(f.category)}:</strong> ${esc(f.description)}</li>`).join('');
    const letterHtml = esc(letter).replace(/\n/g, '<br>');
    const authDate = leadData.agreement.acceptedAt ? new Date(leadData.agreement.acceptedAt).toLocaleString('en-US') : 'on file';
    const html = `<div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; color: #222;">
<p style="font-size: 13px; color: #555;">Submitted by ArguBill on behalf of the patient named below, under the patient's written authorization provided at intake on ${esc(authDate)} (agreement version ${esc(leadData.agreement.version || 'n/a')}). ArguBill is authorized to contact your billing department about this bill, to share the patient's documents, and to receive billing information on the patient's behalf.</p>
<hr>
<div style="font-size: 14px; line-height: 1.55;">${letterHtml}</div>
<hr>
<p style="font-size: 14px;"><strong>Itemized findings under dispute:</strong></p>
<ul style="font-size: 14px; line-height: 1.55;">${findingsHtml}</ul>
<p style="font-size: 13px; color: #555;">Patient: ${esc(leadData.fullName)} · Facility: ${esc(leadData.hospitalName)} · Bill total: ${esc(leadData.extractedBillAmount)} · Contact: ${esc(leadData.clientEmail)} / ${esc(leadData.phone)}. Please respond to this email with your review outcome and, if charges are corrected, the corrected balance in writing.</p>
</div>`;

    const payload = {
      from: 'ArguBill <audit@argubill.com>',
      to: [destination],
      reply_to: 'admin@argubill.com',
      subject: `Billing Dispute — ${leadData.fullName} — ${leadData.hospitalName} — Bill Total ${leadData.extractedBillAmount}`,
      html
    };
    if (typeof leadData.fileData === 'string' && leadData.fileData.includes(',')) {
      const content = leadData.fileData.split(',')[1];
      if (content) {
        payload.attachments = [{ filename: leadData.fileName || 'itemized-bill', content }];
      }
    }

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!emailResponse.ok) {
      const emailErrText = await emailResponse.text();
      return res.status(500).json({ status: 'error', message: `Resend API Error: ${emailErrText}` });
    }

    leadData.disputeSentAt = new Date().toISOString();
    leadData.disputeSentTo = destination;
    leadData.disputeChannel = 'email';
    leadData.caseState = 'dispute_sent';
    await redis(['SET', `lead:${leadId}`, JSON.stringify(leadData)]);

    return res.status(200).json({ status: 'success', message: `Dispute packet sent to ${destination}.`, disputeSentAt: leadData.disputeSentAt });

  } catch (error) {
    console.error('Send Dispute Error:', error);
    return res.status(500).json({ status: 'error', message: 'Internal server error while sending the dispute.' });
  }
}
