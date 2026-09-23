require('dotenv').config();
const path = require('path');
const express = require('express');

const ordersRoute = require('./routes/orders');
const dinarakPayRoute = require('./routes/dinarak-pay');
const dinarakWebhookRoute = require('./routes/dinarak-webhook');
const dinarakResolveRoute = require('./routes/dinarak-resolve');
const pushRoute = require('./routes/push');
const store = require('./orders');
const db = require('./db');
const dinarak = require('./services/dinarakAdapter');
const whatsapp = require('./services/whatsappNotifier');
const email = require('./services/emailNotifier');
const pushNotifier = require('./services/pushNotifier');

const app = express();

// Minimal CORS middleware — avoids an extra dependency for one header.
// Left open (*) rather than locked to STOREFRONT_ORIGIN: the admin panel is
// a separate static HTML file opened from its own origin (often a local
// file, i.e. Origin: null), and nothing here relies on cookies — the two
// endpoints that expose customer data require an explicit X-Admin-Key
// header instead, which only code that already has the key can send.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

// IMPORTANT: mounted BEFORE express.json() below — kept for a future real
// webhook mechanism, even though nothing currently calls it (see
// services/dinarakAdapter.js for why the primary path is poll & reconcile,
// not a webhook).
app.use('/webhooks/dinarak', dinarakWebhookRoute);

app.use(express.json());
app.use('/api/orders', ordersRoute);
app.use('/api/orders', dinarakPayRoute);
app.use('/api/orders', dinarakResolveRoute);
app.use('/api/push', pushRoute);

// Product/site images now live as real static files under public/images
// (extracted out of index.html, which used to embed every image as base64 —
// that made the page itself ~18.5MB per visit and blew through Render's free
// 5GB/month outbound bandwidth in a few hundred page loads). Long cache
// lifetime here is safe: these filenames don't change when the storefront
// copy changes, only when an image itself is replaced (upload a new file
// with a different name in that case, so browsers/CDNs don't keep serving
// the old cached one).
app.use('/images', express.static(path.join(__dirname, 'public', 'images'), {
  maxAge: '30d',
  immutable: true,
}));

// Serves public/admin.html + public/push-sw.js over HTTPS (this same Render
// URL) — required for Web Push: browsers refuse to grant push subscriptions
// to a page opened as a local file:// download. Open the admin panel at
// https://<this-service>.onrender.com/admin.html, not the downloaded copy,
// for the "Enable Notifications" button to work.
app.use(express.static(path.join(__dirname, 'public')));

// Background reconciliation sweep — a safety net independent of the
// frontend's own polling (e.g. a customer who pays after closing the tab).
// Orders now live in Postgres (see db.js/orders.js), so this survives
// restarts/spin-down too; each order is still individually throttled via
// store.shouldReconcileNow().
const SWEEP_INTERVAL_MS = 20 * 1000;
setInterval(async () => {
  if (!dinarak.isConfigured() || !db.isConfigured()) return;
  const pending = await store.listPendingOrders();
  for (const order of pending) {
    if (!store.shouldReconcileNow(order)) continue;
    await store.markReconcileChecked(order.orderId);
    try {
      const result = await dinarak.reconcilePendingOrder(order);
      if (result.matched) await store.markOrderPaid(order.orderId, result.transactionId);
    } catch (e) {
      // Swallow — the next sweep or the customer's own status poll retries.
      console.error(`[dinarak-sweep] reconcile failed for ${order.orderId}:`, e.message);
    }
  }
}, SWEEP_INTERVAL_MS);

const port = process.env.PORT || 4000;

async function start() {
  if (!db.isConfigured()) {
    console.log('⚠️  DATABASE_URL is not set — orders and push subscriptions cannot be saved. Every request that touches them will fail until a Postgres connection string (e.g. from Supabase) is set — see .env.example / README.md "Persistent storage (Supabase)".');
  } else {
    try {
      await db.ensureSchema();
      console.log('✅ Connected to the database and confirmed the orders/push_subscriptions tables exist.');
    } catch (e) {
      console.error('⚠️  Could not connect to the database / create tables at startup:', e.message);
    }
  }

  app.listen(port, () => {
    console.log(`Turkish Bazaar payment backend listening on port ${port}`);
    if (!dinarak.isConfigured()) {
      console.log('⚠️  Dinarak GetBusinessTransactions is not configured (DINARAK_API_BASE_URL / DINARAK_BASIC_AUTH_USERNAME / DINARAK_BASIC_AUTH_PASSWORD / DINARAK_MERCHANT_ALIAS) — online payment will respond with "gateway_not_configured" until these are set.');
    }
    if (!dinarak.isAliasResolveConfigured()) {
      console.log('ℹ️  DINARAK_BEARER_TOKEN not set — phone validation via AliasResolve is disabled (optional, not required for payments to work).');
    }
    if (!process.env.ADMIN_API_KEY) {
      console.log('⚠️  ADMIN_API_KEY is not set — the admin panel (order list / status updates) will respond with "admin_key_not_configured" until it is set.');
    }
    if (!whatsapp.isConfigured()) {
      console.log('ℹ️  CALLMEBOT_PHONE / CALLMEBOT_APIKEY not set — automatic WhatsApp order notifications are disabled until these are set (see services/whatsappNotifier.js for setup steps).');
    }
    if (!email.isConfigured()) {
      console.log('ℹ️  GMAIL_USER / GMAIL_APP_PASSWORD not set — automatic email order notifications are disabled until these are set (see services/emailNotifier.js for setup steps).');
    }
    if (!pushNotifier.isConfigured()) {
      console.log('ℹ️  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — real push notifications from the admin panel are disabled until these are set (see services/pushNotifier.js and README.md).');
    }
  });
}

start();
