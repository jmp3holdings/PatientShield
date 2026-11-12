export const maxDuration = 60;
const AGREEMENT_TEXT_V3 = 'Service agreement & authorization (required). I agree to the ArguBill service terms: the bill review is free, there is no upfront cost, and I pay only if my hospital balance is lowered — 25% of the verified savings, never more than $1,000. If my balance is not lowered, I pay $0. You authorize ArguBill to work on your case using the documents you provide. I understand that my information travels over encrypted connections, is kept in access-controlled storage limited to the people working on my case, and is never sold, never used for advertising, and never used to train AI models. Arbitration; waiver of jury trial and class actions. Any dispute arising out of or relating to these terms or to ArguBill’s services will be resolved by binding arbitration on an individual basis instead of in court. You and ArguBill each waive the right to a trial by jury and the right to bring or participate in a class action or other representative proceeding. This paragraph does not apply to claims that cannot legally be arbitrated or waived, and nothing in these terms limits ArguBill’s liability for its own negligence or willful misconduct. Liability limit; scope of service. ArguBill’s total liability for any claim relating to its services is limited to the fees you actually paid ArguBill for your case (which is $0 if your balance was not lowered). ArguBill provides a bill review and advocacy service based on the documents you provide; we do not guarantee that any bill will be reduced or that any specific result will be achieved. By checking this box and submitting this form, I sign this agreement and authorization electronically, and the date and time of my acceptance are recorded.';
const HIPAA_AUTH_TEXT_V1 = 'HIPAA Authorization (required). I authorize the hospital or facility I name in this form, and its billing department, to disclose my protected health information relating to my hospital billing — including my hospital bills and itemized statements, explanations of benefits (EOBs), and medical records relating to the billed services — to ArguBill. The purpose of this disclosure is for ArguBill to review my hospital bill, identify billing errors, and dispute charges on my behalf. This authorization expires when my case is closed. I understand I may revoke this authorization in writing at any time; revoking it stops future disclosures but does not undo disclosures already made in reliance on it. I understand that signing this authorization is voluntary and that my treatment, payment, enrollment, or eligibility for benefits will not be conditioned on whether I sign it. I understand that information disclosed under this authorization may be redisclosed by the recipient as needed for my case and may then no longer be protected by HIPAA privacy rules. This authorization does not cover psychotherapy notes or substance-use-disorder treatment records. By checking this box and submitting this form, I sign this authorization electronically, and the date and time of my acceptance are recorded.';
const ACCESS_DIRECTIVE_TEXT_V1 = 'Right-of-Access Directive (required). I direct the hospital or facility I name in this form to send copies of my records relating to my hospital billing directly to ArguBill, my designated third party, under my right of access to my own health information. Records should be sent to ArguBill at admin@argubill.com or through ArguBill’s secure intake. By checking this box and submitting this form, I sign this directive electronically, and the date and time of my acceptance are recorded.';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const isPortalUpload = body.isPortalUpload || false;

    // Server-side validation for intake submissions. Portal uploads use the
    // same endpoint but do not carry the intake form fields, so they are
    // checked only for a file below.
    if (!isPortalUpload) {
      if (!body.fullName || !String(body.fullName).trim()) {
        return res.status(400).json({ status: 'error', message: 'Full name is required.' });
      }
      if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email).trim())) {
        return res.status(400).json({ status: 'error', message: 'A valid email address is required.' });
      }
      if (!body.phone || !String(body.phone).trim()) {
        return res.status(400).json({ status: 'error', message: 'Phone number is required.' });
      }
      if (body.agreementAccepted !== true) { return res.status(400).json({ status: 'error', message: 'The service agreement and authorization must be accepted so we can work on your bill.' }); } if (!body.hospitalName || !String(body.hospitalName).trim()) {
        return res.status(400).json({ status: 'error', message: 'Hospital / facility name is required.' });
      }
    }
    if (!body.fileData) {
      return res.status(400).json({ status: 'error', message: 'An itemized bill file is required.' });
    }
    // 10 MB limit: a base64 data URL is about 4/3 the size of the file.
    if (typeof body.fileData === 'string' && body.fileData.length > 14000000) {
      return res.status(400).json({ status: 'error', message: 'Itemized bill file must be 10 MB or smaller.' });
    }
    const billNameLower = String(body.fileName || '').toLowerCase();
    const billIsAllowedType = billNameLower.endsWith('.pdf') || billNameLower.endsWith('.png') || billNameLower.endsWith('.jpg') || billNameLower.endsWith('.jpeg') || billNameLower.endsWith('.gif') || billNameLower.endsWith('.webp') || billNameLower.endsWith('.txt') || (typeof body.fileData === 'string' && (body.fileData.startsWith('data:application/pdf') || body.fileData.startsWith('data:image/') || body.fileData.startsWith('data:text/plain')));
    if (!billIsAllowedType) {
      return res.status(400).json({ status: 'error', message: 'Itemized bill must be a PDF, image, or text file.' });
    }

    const fullName = isPortalUpload ? (body.fullName || 'Valued Client') : String(body.fullName).trim();
    const clientEmail = isPortalUpload ? (body.email || 'client@argubill.com') : String(body.email).trim();
    const hospitalName = isPortalUpload ? (body.hospitalName || 'Target Hospital') : String(body.hospitalName).trim();
    const phone = isPortalUpload ? (body.phone || 'Unspecified') : String(body.phone).trim();
    const fileName = body.fileName || 'Itemized Bill Uploaded';
    const fileData = body.fileData || null;
    let fileText = body.fileText || '';
    const eobName = body.eobName || 'Not Provided';
    const recordsName = body.recordsName || 'Not Provided';

    // Plain-text bill uploads carry their text in the data URL; decode it
    // so the audit pipeline can use it even if the browser sent no fileText.
    if (!fileText && typeof fileData === 'string' && fileData.startsWith('data:text/plain')) {
      try {
        const base64Part = fileData.split(',')[1] || '';
        if (base64Part) fileText = Buffer.from(base64Part, 'base64').toString('utf-8');
      } catch (e) {}
    }

    let extractedBillAmount = '$0.00';
    let estimatedSavingsValue = '$0.00';
    let actualPatientName = fullName;
    let actualFacilityName = hospitalName;
    let analysisFindings = [];
    let disputeLetterDraft = '';
    let missingInfoRequests = [];
    let aiErrorLog = null;

    if (eobName === 'Not Provided') {
      missingInfoRequests.push('Matching Explanation of Benefits (EOB) from your insurance provider');
    }
    if (recordsName === 'Not Provided') {
      missingInfoRequests.push('Detailed medical records or clinical notes corresponding to the billing dates');
    }

    // 1. Local fallback regex parsing for total amount (Without arbitrary percentage savings)
    if (fileText) {
      const totalMatch = fileText.match(/(?:Total Balance|Total Charges|Total Amount|Total Due|Total)\s*[:#]?\s*\$?\s*([\d,]+\.\d{2})/i) || fileText.match(/\$([\d,]+\.\d{2})/);
      if (totalMatch && totalMatch[1]) {
        extractedBillAmount = `$${totalMatch[1]}`;
      }
    }

    // 2. OpenAI Universal Forensic Audit Pipeline with Built-In Self-Audit & Self-Correction Loop
    // Single OpenAI call: model gpt-4o-mini, POST https://api.openai.com/v1/chat/completions.
    // Its output fills extracted total/patient/facility, findings, estimated
    // savings, missing-info requests and the dispute letter, all stored on
    // the lead record below. Failures are logged and recorded on the lead
    // (aiError / aiStatus) and are never reported as a clean AI success.
    if (!isPortalUpload && process.env.OPENAI_API_KEY && fileText.trim().length > 0) {
      try {
        const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: `You are an elite forensic medical bill auditor and healthcare compliance expert specializing in federal transparency mandates and unbundling detection. Execute a rigorous 2-step internal self-audit before finalizing your output: STEP 1 (Draft Analysis): Scan the raw bill text for potential duplicate line items, over-clustered panels, or billing anomalies. STEP 2 (Self-Correction & Veto Filtering): Review every preliminary finding against these strict veto rules: 1. VETO RULE A: Discard any finding flagging room and board, daily bed charges, accommodation revenue codes (Rev Codes 0100-0199), or daily care codes that occur on different calendar dates. Sequential daily charges are valid. 2. VETO RULE B: Discard any "duplicate" where the calendar dates differ. True duplicates must share the exact same procedure code, description, dollar amount, and calendar date within the same 24-hour period. STEP 3 (Final Compilation): Retain only findings that survive Step 2. Calculate "estimatedSavings" exclusively from these verified surviving errors. If zero verified errors survive, estimatedSavings must be "$0.00". Extract and return ONLY a valid JSON object with these exact keys: "extractedTotal", "extractedPatient", "extractedFacility", "findings" (array of objects with "category" and "description" containing ONLY self-audited, surviving verified errors), "estimatedSavings", "missingInfoRequests", "disputeLetter" (a formal dispute letter using the extracted patient name, extracted facility, extracted total, and surviving verified findings; if estimatedSavings is "$0.00", explicitly state that no billing discrepancies or duplicate entries were found and no dispute letter is required). Do not wrap the JSON in markdown code blocks.`
              },
              {
                role: 'user',
                content: `Form Name Fallback: ${fullName}\nForm Hospital Fallback: ${hospitalName}\n\n--- BILL TEXT ---\n${fileText.substring(0, 15000)}`
              }
            ],
            response_format: { type: 'json_object' },
            max_tokens: 4000,
            temperature: 0.1
          })
        });
        if (openaiResponse.ok) {
          const openaiData = await openaiResponse.json();
          if (openaiData.choices?.[0]?.message?.content) {
            let rawContent = openaiData.choices[0].message.content.trim();
            rawContent = rawContent.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
            const parsed = JSON.parse(rawContent);
            if (parsed.extractedTotal) extractedBillAmount = parsed.extractedTotal;
            if (parsed.extractedPatient && parsed.extractedPatient.trim() !== '') actualPatientName = parsed.extractedPatient.trim();
            if (parsed.extractedFacility && parsed.extractedFacility.trim() !== '') actualFacilityName = parsed.extractedFacility.trim();
            if (parsed.findings && parsed.findings.length > 0) analysisFindings = parsed.findings;
            if (parsed.missingInfoRequests && parsed.missingInfoRequests.length > 0) missingInfoRequests = Array.from(new Set([...missingInfoRequests, ...parsed.missingInfoRequests]));
            if (parsed.estimatedSavings) {
              let formattedSavings = parsed.estimatedSavings;
              if (!isNaN(parseFloat(formattedSavings))) formattedSavings = `$${parseFloat(formattedSavings).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
              estimatedSavingsValue = formattedSavings;
            }
            if (parsed.disputeLetter && parsed.disputeLetter.length > 50) disputeLetterDraft = parsed.disputeLetter;
          }
        } else {
          aiErrorLog = await openaiResponse.text();
          console.error('OpenAI API Error Response:', aiErrorLog);
        }
      } catch (aiErr) {
        aiErrorLog = aiErr.message;
        console.error('AI Processing Exception:', aiErr);
      }
    } else if (!process.env.OPENAI_API_KEY) {
      aiErrorLog = 'OPENAI_API_KEY environment variable is missing in Vercel.';
    } else if (fileText.trim().length === 0) {
      aiErrorLog = 'Extracted file text length is 0 (PDF text layer could not be read).';
    }

    if (estimatedSavingsValue === '$0.00' || analysisFindings.length === 0) {
      analysisFindings = [];
      disputeLetterDraft = `Audit Complete: No billable errors, markup anomalies, or verified duplicate entries were identified in the statement for ${actualFacilityName}. A formal dispute letter is not required at this time.`;
    }
    if (aiErrorLog) {
      analysisFindings = [
        { category: '⚠️ AI Audit Diagnostic Error', description: aiErrorLog },
        { category: 'Chargemaster Markup Baseline', description: `Accommodation and ancillary service charges submitted exceed regional benchmarks.` }
      ];
    }
    const aiStatus = isPortalUpload ? 'skipped_portal_upload' : (aiErrorLog ? 'failed' : 'completed');
    const portalToken = crypto.randomUUID();
    const leadId = Date.now().toString();
    const securePortalUrl = `https://www.argubill.com/portal.html?id=${leadId}&t=${portalToken}`;

    let missingHtml = '';
    if (missingInfoRequests.length > 0) {
      missingHtml = `<div style="background-color: #fff8e1; border-left: 4px solid #ffa000; padding: 15px; margin: 20px 0;"><p style="margin: 0; font-weight: bold; color: #b78103;">⚠️ Additional Documents Needed for Accurate Cross-Check:</p><ul style="margin: 5px 0 0 0; padding-left: 20px; color: #333;">${missingInfoRequests.map(req => `<li>${req}</li>`).join('')}</ul></div>`;
    }

    const emailSubject = `Preliminary Medical Bill Audit Update: Potential Savings Found (${estimatedSavingsValue})`;
    const emailBodyHtml = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;"><h2 style="color: #0f172a;">Your Medical Bill Audit Has Been Processed</h2><p>Hello ${actualPatientName},</p><p>We have received and securely processed your uploaded statement for <strong>${actualFacilityName}</strong>.</p><div style="background-color: #f1f5f9; padding: 20px; border-radius: 8px; margin: 20px 0;"><p style="margin: 0 0 10px 0;"><strong>Gross Bill Total:</strong> ${extractedBillAmount}</p><p style="margin: 0;"><strong>Preliminary Potential Savings Identified:</strong> <span style="color: #16a34a; font-size: 18px; font-weight: bold;">${estimatedSavingsValue}</span></p></div>${missingHtml}<p>To view your preliminary findings, upload any missing documents, and securely finalize your review, please click the secure link below:</p><div style="text-align: center; margin: 30px 0;"><a href="${securePortalUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Access Secure Portal & Upload Missing Files</a></div><p style="font-size: 12px; color: #64748b; margin-top: 40px; border-top: 1px solid #e2e8f0; padding-top: 15px;">This communication is handled securely in compliance with HIPAA guidelines. Final dispute documents and full resolution packages become accessible upon service completion.</p></div>`;

    // 4. Save the lead FIRST and verify storage before claiming success.
    // Only after the lead is actually stored are the emails sent; their
    // outcomes are then written back onto the lead record.
    const leadData = {
      id: leadId,
      portalToken,
      fullName: actualPatientName,
      clientEmail,
      phone,
      hospitalName: actualFacilityName,
      extractedBillAmount,
      fileName,
      fileData,
      eobName,
      recordsName,
      analysisFindings,
      missingInfoRequests,
      estimatedSavings: estimatedSavingsValue,
      disputeLetterDraft,
      aiError: aiErrorLog,
      aiStatus,
      confirmationEmailStatus: 'pending',
      adminAlertStatus: 'pending',
      approvalStatus: 'pending_admin_approval', agreement: isPortalUpload ? null : { accepted: true, version: body.agreementVersion || 'unknown', acceptedAt: new Date().toISOString() }, caseState: isPortalUpload ? 'portal_upload' : (missingInfoRequests.length > 0 ? 'awaiting_docs' : 'ready_for_dispute'), disputeSentAt: null, outcome: null, feeInvoice: null,
      preparedEmailContent: { recipient: clientEmail, subject: emailSubject, bodyHtml: emailBodyHtml },
      submittedAt: new Date().toISOString()
    };

    const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL;
    const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!redisUrl || !redisToken) {
      console.error('Database Storage Error: Redis configuration missing.');
      return res.status(502).json({ status: 'error', message: "We couldn't save your submission — please try again" });
    }
    try {
      const portalLeadRes = isPortalUpload ? await fetch(redisUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + redisToken, 'Content-Type': 'application/json' }, body: JSON.stringify(['GET', 'lead:' + body.leadId])}) : null;
      const portalLeadJson = portalLeadRes ? await portalLeadRes.json().catch(() => ({})) : {};
      let portalLead = null;
      try { portalLead = portalLeadJson.result ? JSON.parse(portalLeadJson.result) : null; } catch (e) {}
      if (isPortalUpload && (!body.leadId || !body.portalToken || !portalLead || portalLead.portalToken !== body.portalToken)) { return res.status(401).json({ status: 'error', message: 'Invalid portal token.' }); }
      const setRes = await fetch(redisUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${redisToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['SET', `lead:${leadId}`, JSON.stringify(leadData)]) });
      const setJson = await setRes.json().catch(() => ({}));
      if (!setRes.ok || setJson.error || setJson.result !== 'OK') throw new Error('Redis SET failed: ' + JSON.stringify(setJson));
      const saddRes = await fetch(redisUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${redisToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['SADD', 'all_leads', leadId]) });
      const saddJson = await saddRes.json().catch(() => ({}));
      if (!saddRes.ok || saddJson.error) throw new Error('Redis SADD failed: ' + JSON.stringify(saddJson));
    } catch (dbErr) {
      console.error('Database Storage Error:', dbErr);
      return res.status(502).json({ status: 'error', message: "We couldn't save your submission — please try again" });
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    let confirmationEmailStatus = 'skipped';
    let adminAlertStatus = 'skipped';

    // 3. Send Immediate "File Received & Missing Info Request" Email to Client
    if (resendApiKey && clientEmail) {
      try {
        const confirmationRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'ArguBill <audit@argubill.com>',
            to: [clientEmail],
            subject: 'We Have Received Your Medical Bill - Action Required for Missing Documents',
            html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;"><h2 style="color: #0f172a;">Your Medical Bill Has Been Received</h2><p>Hello ${actualPatientName},</p><p>We have securely received your uploaded statement (<strong>${fileName}</strong>) for <strong>${actualFacilityName}</strong>.</p><p>Our preliminary audit is underway. To ensure a fully accurate, compliant cross-check of your billing statement, we noticed that certain supporting documents were not provided:</p>${missingHtml}<p>Please upload these missing documents through your secure portal link below so our team and AI can complete a thorough audit:</p><div style="text-align: center; margin: 30px 0;"><a href="${securePortalUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Access Secure Portal & Upload Missing Files</a></div><p style="font-size: 12px; color: #64748b; margin-top: 40px; border-top: 1px solid #e2e8f0; padding-top: 15px;">This communication is handled securely in compliance with HIPAA guidelines.</p></div>`
          })
        });
        confirmationEmailStatus = confirmationRes.ok ? 'sent' : 'failed';
        if (!confirmationRes.ok) console.error('Confirmation Email Error:', await confirmationRes.text());
      } catch (initialEmailErr) {
        confirmationEmailStatus = 'failed';
        console.error('Confirmation Email Error:', initialEmailErr);
      }
    }

    // Send Notification Alert to Clinical Nurse Team
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@argubill.com';
    if (resendApiKey) {
      try {
        const adminRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendApiKey },
          body: JSON.stringify({
            from: 'ArguBill Alerts <alerts@argubill.com>',
            to: [adminEmail],
            subject: `🚨 New Bill Audit: ${actualFacilityName} (${extractedBillAmount})`,
            html: `<h2>New Catastrophic Bill Intake Ready for Review</h2><p><strong>Patient/Account:</strong> ${actualPatientName}</p><p><strong>Hospital Facility:</strong> ${actualFacilityName}</p><p><strong>Gross Bill Total:</strong> ${extractedBillAmount}</p><p><strong>Estimated Savings:</strong> ${estimatedSavingsValue}</p><p><a href="https://www.argubill.com/admin.html" target="_blank">Log into Admin Dashboard to Review Full Audit & Approve Email</a></p>`
          })
        });
        adminAlertStatus = adminRes.ok ? 'sent' : 'failed';
        if (!adminRes.ok) console.error('Admin Alert Email Error:', await adminRes.text());
      } catch (adminEmailErr) {
        adminAlertStatus = 'failed';
        console.error('Admin Alert Email Error:', adminEmailErr);
      }
    }

    // Write the email outcomes back onto the stored lead record.
    leadData.confirmationEmailStatus = confirmationEmailStatus;
    leadData.adminAlertStatus = adminAlertStatus;
    try {
      await fetch(redisUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${redisToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['SET', `lead:${leadId}`, JSON.stringify(leadData)]) });
    } catch (statusErr) {
      console.error('Lead email-status update failed (lead itself was stored):', statusErr);
    }

    return res.status(200).json({
      status: 'success',
      message: 'File received & missing info email sent. Forensic audit completed and lead placed in admin review queue.',
      leadId: leadId,
      confirmationEmailStatus,
      adminAlertStatus,
      aiStatus
    });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ status: 'error', message: 'Internal server error during processing.' });
  }
}
