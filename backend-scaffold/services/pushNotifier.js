/**
 * Real push notifications FROM the admin panel itself — a system
 * notification (like any app's), sent the moment a new order is created,
 * that when tapped opens the admin panel straight to that order.
 *
 * This is standard Web Push (the same mechanism news sites/webmail use),
 * via VAPID keys — no third-party service, no Meta/WhatsApp account, fully
 * under your control. It only works when the admin panel is opened over
 * HTTPS (which is why server.js now also serves it as a static file — see
 * public/admin.html) — a downloaded local copy (file://) cannot receive
 * push notifications, browsers don't allow it.
 *
 * Subscriptions are stored in Postgres (see db.js), not in memory — so
 * "Enable Notifications" only has to be tapped once per device, ever, even
 * across server restarts or Render's free-tier spin-down.
 *
 * How it fits together:
 *   1. The admin panel (public/admin.html), when you tap "Enable
 *      Notifications", asks the browser to subscribe to push and POSTs
 *      that subscription to POST /api/push/subscribe (stored below).
 *   2. On every new order, notifyNewOrder() pushes a message to every
 *      stored subscription via the `web-push` library.
 *   3. public/push-sw.js (the service worker) receives it in the
 *      background and shows the OS notification; tapping it focuses/opens
 *      the admin panel and jumps to that order (see push-sw.js).
 *
 * VAPID keys: a plain ECDSA key pair used to prove pushes come from this
 * server — NOT tied to any account/service, so they can just be generated
 * once and kept as env vars. Regenerate anytime with:
 *   npx web-push generate-vapid-keys
 * The private key is a secret (env var only, never in the frontend/git);
 * the public key is meant to be public (the admin panel fetches it from
 * GET /api/push/public-key to subscribe).
 */

const webpush = require('web-push');
const db = require('../db');

function isConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

let configured = false;
function ensureConfigured() {
  if (configured || !isConfigured()) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  configured = true;
}

async function addSubscription(sub) {
  if (!sub || !sub.endpoint) throw new Error('Invalid push subscription');
  const pool = db.getPool();
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, subscription) VALUES ($1, $2)
     ON CONFLICT (endpoint) DO UPDATE SET subscription = EXCLUDED.subscription`,
    [sub.endpoint, sub]
  );
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM push_subscriptions`);
  return { count: rows[0].count };
}

async function removeSubscription(endpoint) {
  const pool = db.getPool();
  await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM push_subscriptions`);
  return { count: rows[0].count };
}

/**
 * Fire-and-forget from the caller's perspective.
 */
async function notifyNewOrder(order) {
  if (!isConfigured()) return { sent: 0, reason: 'not_configured' };
  ensureConfigured();
  const pool = db.getPool();
  const { rows } = await pool.query(`SELECT endpoint, subscription FROM push_subscriptions`);
  const c = order.customer || {};
  const payload = JSON.stringify({
    title: `New order #${order.orderId}`,
    body: `${c.name || 'Customer'} — ${order.amount} ${order.currency || 'JOD'} — Cash on delivery`,
    orderId: order.orderId,
  });
  let sent = 0;
  const deadEndpoints = [];
  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(row.subscription, payload);
        sent++;
      } catch (e) {
        // 404/410 = the browser unsubscribed or the subscription expired —
        // stop trying it. Any other error is transient/unrelated; leave it.
        if (e.statusCode === 404 || e.statusCode === 410) deadEndpoints.push(row.endpoint);
        else console.error('[push] send failed:', e.statusCode || '', e.message);
      }
    })
  );
  await Promise.all(deadEndpoints.map(removeSubscription));
  return { sent, total: rows.length - deadEndpoints.length };
}

module.exports = { isConfigured, addSubscription, removeSubscription, notifyNewOrder };
