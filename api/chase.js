export const maxDuration = 60;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const cronSecret = process.env.CRON_SECRET;
  const adminPass = process.env.ADMIN_PASSWORD;
  const authHeader = req.headers.authorization || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const authorized = (cronSecret && provided === cronSecret) || (adminPass && provided === adminPass);
  if (!authorized) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized.' });
  }

  try {
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

    const resendKey = process.env.RESEND_API_KEY;
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@argubill.com';
    const now = Date.now();
    const summary = { scanned: 0, nudgesSent: 0, movedToReview: 0, errors: [] };

    const setData = await redis(['SMEMBERS', 'all_leads']);
    const leadIds = (setData && setData.result) || [];

    for (const leadId of leadIds) {
      try {
        const getData = await redis(['GET', `lead:${leadId}`]);
        if (!getData || !getData.result) continue;
        const lead = JSON.parse(getData.result);
        summary.scanned++;

        if (lead.caseState === 'dispute_sent' && lead.hospitalReplyAt) {
          lead.caseState = 'hospital_review';
          summary.movedToReview++;
          await redis(['SET', `lead:${leadId}`, JSON.stringify(lead)]);
          continue;
        }

        if (lead.caseState !== 'dispute_sent' || !lead.disputeSentAt) continue;
        const sentAt = Date.parse(lead.disputeSentAt);
        if (!Number.isFinite(sentAt)) continue;
        const days = Math.floor((now - sentAt) / 86400000);
        const log = Array.isArray(lead.chaseLog) ? lead.chaseLog : [];
        const already = (d) => log.some((e) => e && e.day === d);
        let dueDay = 0;
        if (days >= 21 && !already(21)) dueDay = 21;
        else if (days >= 14 && !already(14)) dueDay = 14;
        else if (days >= 7 && !already(7)) dueDay = 7;
        if (!dueDay) continue;

        const to = lead.hospitalBillingEmail || lead.disputeSentTo;
        if (!to) { summary.errors.push(`lead ${leadId}: no hospital email on file`); continue; }
        if (!resendKey) { summary.errors.push(`lead ${leadId}: RESEND_API_KEY missing`); continue; }

        const patient = lead.fullName || 'your patient';
        const facility = lead.hospitalName || 'your facility';
        const disputeDate = new Date(sentAt).toISOString().slice(0, 10);
        const nth = dueDay === 7 ? 'first' : (dueDay === 14 ? 'second' : 'final');
        const subject = `Follow-up (${nth}): billing dispute sent ${disputeDate} — ${patient} / ${facility}`;
        const text = [
          `Hello,`,
          ``,
          `This is a ${nth} follow-up from ArguBill regarding the billing dispute we sent on ${disputeDate} for ${patient} (${facility}). The patient has authorized us, in writing, to work on this bill and to receive billing information about it.`,
          ``,
          `Could you confirm the status of your review? If a corrected statement or adjustment has been issued, please send it to ${adminEmail} so we can verify the new balance with the patient.`,
          ``,
          `Thank you for your time.`,
          `ArguBill — patient billing advocacy`,
          `Reply to: ${adminEmail}`
        ].join('\n');

        const sendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'audit@argubill.com', to, reply_to: adminEmail, subject, text })
        });
        const sendJson = await sendRes.json().catch(() => ({}));
        if (!sendRes.ok) {
          summary.errors.push(`lead ${leadId}: Resend error ${sendJson.message || sendRes.status}`);
          continue;
        }
        log.push({ day: dueDay, sentAt: new Date(now).toISOString(), to, resendId: sendJson.id || null });
        lead.chaseLog = log;
        if (dueDay === 21) lead.chaseComplete = true;
        await redis(['SET', `lead:${leadId}`, JSON.stringify(lead)]);
        summary.nudgesSent++;
      } catch (leadErr) {
        summary.errors.push(`lead ${leadId}: ${String((leadErr && leadErr.message) || leadErr)}`);
      }
    }

    return res.status(200).json({ status: 'success', summary });
  } catch (error) {
    console.error('Chase Error:', error);
    return res.status(500).json({ status: 'error', message: 'Internal server error while running the chase.' });
  }
}
