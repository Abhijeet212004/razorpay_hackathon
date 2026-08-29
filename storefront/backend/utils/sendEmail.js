const nodeMailer = require('nodemailer');

// Email, with three modes and no crashes.
//
//   SMTP     a real mailbox — Gmail with an app password, Mailtrap, anything
//   sendgrid the original template-based path, kept for whoever has it configured
//   none     nothing configured: log it and carry on
//
// The last one matters. An order that fails because a receipt could not be sent is a
// worse outcome than an order with no receipt, so email is never allowed to fail a
// purchase.

const SMTP_READY = Boolean(process.env.SMTP_HOST && process.env.SMTP_MAIL && process.env.SMTP_PASSWORD);
const SENDGRID_READY = Boolean(process.env.SENDGRID_API_KEY && process.env.SENDGRID_MAIL);

let transporter = null;
if (SMTP_READY) {
    transporter = nodeMailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: { user: process.env.SMTP_MAIL, pass: process.env.SMTP_PASSWORD },
    });
    console.log(`[mail] SMTP ready via ${process.env.SMTP_HOST}`);
} else if (SENDGRID_READY) {
    console.log('[mail] SendGrid ready');
} else {
    console.log('[mail] not configured — receipts will be logged, not sent');
}

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

// A plain, readable receipt. No template id to configure, nothing to set up in a
// dashboard before the first order can be placed.
function orderReceipt(data) {
    const items = (data.orderItems || [])
        .map((i) => `<tr>
            <td style="padding:8px 0;color:#111">${i.name} <span style="color:#888">× ${i.quantity}</span></td>
            <td style="padding:8px 0;text-align:right;color:#111">${rupees(i.price * i.quantity)}</td>
        </tr>`)
        .join('');

    const s = data.shippingInfo || {};
    const address = [s.address, s.city, s.state, s.pincode].filter(Boolean).join(', ');

    return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#111">
        <h2 style="font-size:18px;margin:0 0 4px">Thanks, ${data.name || 'there'}</h2>
        <p style="color:#666;margin:0 0 18px">Your order is confirmed.${data.placedByAgent ? ' Placed by your shopping assistant.' : ''}</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
            ${items}
            <tr><td style="padding:10px 0;border-top:1px solid #eee;font-weight:600">Total</td>
                <td style="padding:10px 0;border-top:1px solid #eee;text-align:right;font-weight:600">${rupees(data.totalPrice)}</td></tr>
        </table>
        ${address ? `<p style="color:#666;font-size:13px;margin-top:16px">Delivering to<br><span style="color:#111">${address}</span>${s.phoneNo ? `<br>${s.phoneNo}` : ''}</p>` : ''}
        <p style="color:#888;font-size:12px;margin-top:20px">Order ${data.oid || ''}</p>
        ${data.auditUrl ? `<p style="color:#888;font-size:12px">Why this was allowed: <a href="${data.auditUrl}">${data.auditUrl}</a></p>` : ''}
    </div>`;
}

function resetEmail(data) {
    return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#111">
        <h2 style="font-size:18px">Reset your password</h2>
        <p style="color:#666">This link works once and expires in 30 minutes.</p>
        <p><a href="${data.resetUrl}" style="background:#2874f0;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none">Reset password</a></p>
        <p style="color:#888;font-size:12px">If you did not ask for this, ignore it — nothing changes.</p>
    </div>`;
}

const sendEmail = async (options) => {
    const data = options.data || {};
    const isReset = Boolean(data.resetUrl);
    const subject = options.subject || (isReset ? 'Reset your password' : 'Your order is confirmed');
    const html = options.message || (isReset ? resetEmail(data) : orderReceipt(data));

    try {
        if (transporter) {
            await transporter.sendMail({
                from: process.env.SMTP_FROM || process.env.SMTP_MAIL,
                to: options.email,
                subject,
                html,
            });
            console.log(`[mail] sent "${subject}" to ${options.email}`);
            return;
        }

        if (SENDGRID_READY && options.templateId) {
            const sgMail = require('@sendgrid/mail');
            sgMail.setApiKey(process.env.SENDGRID_API_KEY);
            await sgMail.send({
                to: options.email,
                from: process.env.SENDGRID_MAIL,
                templateId: options.templateId,
                dynamic_template_data: data,
            });
            console.log(`[mail] sent via SendGrid to ${options.email}`);
            return;
        }

        console.log(`[mail] would send "${subject}" to ${options.email} (no mail configured)`);
    } catch (error) {
        // Never fail the thing that triggered the email.
        console.error(`[mail] could not send to ${options.email}: ${error.message}`);
    }
};

module.exports = sendEmail;
