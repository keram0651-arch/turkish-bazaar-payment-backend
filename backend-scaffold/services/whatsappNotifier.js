/**
 * Automatic WhatsApp order notifications via CallMeBot.
 *
 * Sends a WhatsApp message straight to the merchant's own phone the moment
 * a new order is created (see routes/orders.js) — no customer action
 * involved. CallMeBot is a free third-party service, NOT run by WhatsApp/
 * Meta: it works by controlling a WhatsApp bot account that messages you.
 * It is not an official/supported integration, so it can be rate-limited
 * or stop working without notice — acceptable for a low-volume single-
 * merchant notification, not something to build a business on long-term.
 * (The officially supported path is the WhatsApp Business Cloud API, which
 * needs Meta Business verification and approved message templates.)
 *
 * Entirely optional/best-effort — if CALLMEBOT_PHONE or CALLMEBOT_APIKEY
 * isn't set, this silently does nothing, and a failed send never fails or
 * delays the order response to the customer.
 *
 * One-time setup (~2 minutes):
 *   1. On the phone that should receive notifications, save this number as
 *      a contact: +34 644 51 95 23 (the official CallMeBot number).
 *   2. From WhatsApp on that phone, message that contact:
 *      "I allow callmebot to send me messages"
 *   3. Wait for their bot to reply with your personal API key (a number).
 *   4. Set CALLMEBOT_PHONE (your own number, international format, digits
 *      only, e.g. 962790101517) and CALLMEBOT_APIKEY (the number from step
 *      3) in Render's Environment tab.
 */

function isConfigured() {
  return Boolean(process.env.CALLMEBOT_PHONE && process.env.CALLMEBOT_APIKEY);
}

function formatOrderMessage(order) {
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

/**
 * Fire-and-forget from the caller's perspective — callers should NOT await
 * this in a way that blocks or fails the HTTP response to the customer.
 */
async function notifyNewOrder(order) {
  if (!isConfigured()) return { sent: false, reason: 'not_configured' };
  const params = new URLSearchParams({
    phone: process.env.CALLMEBOT_PHONE,
    text: formatOrderMessage(order),
    apikey: process.env.CALLMEBOT_APIKEY,
  });
  const url = `https://api.callmebot.com/whatsapp.php?${params.toString()}`;
  try {
    const res = await fetch(url, { method: 'GET' });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      console.error(`[whatsapp] CallMeBot send failed: ${res.status} ${body}`);
      return { sent: false, reason: 'callmebot_error' };
    }
    return { sent: true, response: body };
  } catch (e) {
    console.error('[whatsapp] CallMeBot send failed:', e.message);
    return { sent: false, reason: 'network_error' };
  }
}

module.exports = { isConfigured, notifyNewOrder, formatOrderMessage };
