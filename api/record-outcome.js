export const maxDuration = 60;

// POST /api/record-outcome — admin only (Bearer ADMIN_PASSWORD, same gate as
// approve-lead). Records the hospital's WRITTEN outcome for a case:
//   { leadId, reducedBalance, confirmationRef }
// A reduction counts only with a written confirmation reference. On a verified
// reduction the fee is computed (25% of verified savings, capped at $1,000)
// and, when STRIPE_SECRET_KEY is configured, a Stripe invoice is created and
// its hosted payment link stored on the lead. Without the key the fee is
// recorded with invoiceStatus 'pending_stripe_config' and no invoice is made.
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

    const { leadId, reducedBalance, confirmationRef } = req.body || {};
    if (!leadId) {
      return res.status(400).json({ status: 'error', message: 'Missing leadId parameter' });
    }
    const reduced = Number(reducedBalance);
    if (!Number.isFinite(reduced) || reduced < 0) {
      return res.status(400).json({ status: 'error', message: 'reducedBalance must be a non-negative number.' });
    }
    if (!confirmationRef || !String(confirmationRef).trim()) {
      return res.status(400).json({ status: 'error', message: 'A written confirmation reference is required (e.g. corrected statement date or adjustment letter reference).' });
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

    if (leadData.outcome) {
      return res.status(400).json({ status: 'error', message: 'An outcome is already recorded for this lead.' });
    }

    const original = parseFloat(String(leadData.extractedBillAmount || '0').replace(/[^0-9.]/g, '')) || 0;
    const savings = Math.round((original - reduced) * 100) / 100;
    const recordedAt = new Date().toISOString();

    if (savings <= 0) {
      leadData.outcome = { result: 'no_reduction', originalBalance: original, reducedBalance: reduced, verifiedSavings: 0, fee: 0, confirmationRef: String(confirmationRef).trim(), recordedAt };
      leadData.caseState = 'closed_no_reduction';
      await redis(['SET', `lead:${leadId}`, JSON.stringify(leadData)]);
      return res.status(200).json({ status: 'success', message: 'Outcome recorded: no reduction. Fee is $0 and the case is closed.', outcome: leadData.outcome });
    }

    const fee = Math.round(Math.min(0.25 * savings, 1000) * 100) / 100;
    leadData.outcome = { result: 'reduced', originalBalance: original, reducedBalance: reduced, verifiedSavings: savings, fee, confirmationRef: String(confirmationRef).trim(), recordedAt };
    leadData.caseState = 'reduced_confirmed';

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (stripeKey) {
      const stripe = async (path, params) => {
        const r = await fetch(`https://api.stripe.com/v1/${path}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString()
        });
        const j = await r.json();
        if (!r.ok) throw new Error(`Stripe ${path}: ${j.error ? j.error.message : r.status}`);
        return j;
      };
      const customer = await stripe('customers', { name: leadData.fullName || 'ArguBill Client', email: leadData.clientEmail || '', 'metadata[leadId]': String(leadId) });
      const invoice = await stripe('invoices', { customer: customer.id, auto_advance: 'false', 'metadata[leadId]': String(leadId) });
      const item = await stripe('invoiceitems', { customer: customer.id, invoice: invoice.id, amount: Math.round(fee * 100), currency: 'usd', description: `ArguBill fee — 25% of verified savings ($${original.toFixed(2)} bill reduced to $${reduced.toFixed(2)}; $${savings.toFixed(2)} verified savings)` });
      const finalized = await stripe(`invoices/${invoice.id}/finalize`, {});
      const sent = await stripe(`invoices/${invoice.id}/send`, {});
      leadData.feeInvoice = { id: invoice.id, number: sent.number || finalized.number || null, amount: fee, status: sent.status || 'open', hostedInvoiceUrl: sent.hosted_invoice_url || null, invoiceStatus: 'sent' };
      leadData.caseState = 'invoiced';
    } else {
      leadData.feeInvoice = { id: null, amount: fee, status: 'not_created', invoiceStatus: 'pending_stripe_config' };
    }

    await redis(['SET', `lead:${leadId}`, JSON.stringify(leadData)]);
    return res.status(200).json({ status: 'success', message: `Outcome recorded: verified savings $${savings.toFixed(2)}, fee $${fee.toFixed(2)}${leadData.feeInvoice && leadData.feeInvoice.invoiceStatus === 'sent' ? ', invoice sent.' : ' (invoice pending Stripe configuration).'}`, outcome: leadData.outcome, feeInvoice: leadData.feeInvoice });

  } catch (error) {
    console.error('Record Outcome Error:', error);
    return res.status(500).json({ status: 'error', message: 'Internal server error while recording the outcome.' });
  }
}
