/**
 * Automatic email order notifications, sent via your own Gmail account.
 *
 * Sends an email the moment a new order is created (see routes/orders.js)
 * — no action needed from the customer. This is a second, independent
 * notification channel alongside WhatsApp (services/whatsappNotifier.js);
 * either can fail without affecting the other, and the order itself is
 * always recorded regardless (see the admin panel).
 *
 * Why Gmail: it's what most small merchants already have, it's free, and
 * unlike CallMeBot this uses Google's own mail servers (SMTP), so delivery
 * is as reliable as any other Gmail-sent email — and it doubles as a push
 * notification on your phone through the Gmail app, which is the point.
 *
 * One-time setup (~3 minutes):
 *   1. On the Google account that should send these emails, turn on
 *      2-Step Verification: https://myaccount.google.com/security
 *   2. Create an "App Password": https://myaccount.google.com/apppasswords
 *      (name it e.g. "Turkish Bazaar orders") — Google gives you a 16-
 *      character password. This is NOT your normal Gmail password, and it
 *      only works for this one purpose.
 *   3. In Render's Environment tab, set:
 *      GMAIL_USER = the full Gmail address that will send the emails
 *      GMAIL_APP_PASSWORD = the 16-character App Password from step 2
 *      NOTIFY_EMAIL_TO = the address that should RECEIVE the notifications
 *      (can be the same Gmail address, or a different one you check more
 *      often — defaults to GMAIL_USER if left unset)
 */

let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  nodemailer = null; // package.json lists it, but guard anyway so a missing
  // install doesn't crash the whole server — it just disables this feature.
}

function isConfigured() {
  return Boolean(nodemailer && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function recipient() {
  return process.env.NOTIFY_EMAIL_TO || process.env.GMAIL_USER;
}

function formatOrderText(order) {
  const c = order.customer || {};
  const lines = [
    `New order #${order.orderId}`,
    `${order.amount} ${order.currency || 'JOD'} - Cash on delivery`,
    '',
    `Name: ${c.name || '-'}`,
    `Phone: ${c.phone || '-'}`,
    `Address: ${c.address || '-'}`,
  ];
  if (c.notes) lines.push(`Notes: ${c.notes}`);
  if (Array.isArray(order.items) && order.items.length) {
    lines.push('', 'Items:');
    for (const it of order.items) {
      const name = (it && (it.nameEn || it.nameAr)) || 'item';
      const weight = it && it.weight ? ` (${it.weight})` : '';
      const qty = (it && it.qty) || 1;
      const price = it && it.price != null ? it.price : '';
      lines.push(`- ${name}${weight} x${qty} - ${price}`);
    }
  }
  return lines.join('\n');
}

let cachedTransporter = null;
function getTransporter() {
  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }
  return cachedTransporter;
}

/**
 * Fire-and-forget from the caller's perspective — callers should NOT await
 * this in a way that blocks or fails the HTTP response to the customer.
 */
async function notifyNewOrder(order) {
  if (!isConfigured()) return { sent: false, reason: 'not_configured' };
  try {
    await getTransporter().sendMail({
      from: `"Turkish Bazaar Orders" <${process.env.GMAIL_USER}>`,
      to: recipient(),
      subject: `New order #${order.orderId} — ${order.amount} ${order.currency || 'JOD'}`,
      text: formatOrderText(order),
    });
    return { sent: true };
  } catch (e) {
    console.error('[email] send failed:', e.message);
    return { sent: false, reason: 'send_error' };
  }
}

module.exports = { isConfigured, notifyNewOrder, formatOrderText };
