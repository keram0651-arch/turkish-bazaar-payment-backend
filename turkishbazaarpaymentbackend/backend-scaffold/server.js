require('dotenv').config();
const express = require('express');

const ordersRoute = require('./routes/orders');
const dinarakPayRoute = require('./routes/dinarak-pay');
const dinarakWebhookRoute = require('./routes/dinarak-webhook');
const dinarakResolveRoute = require('./routes/dinarak-resolve');
const store = require('./orders');
const dinarak = require('./services/dinarakAdapter');

const app = express();

// Minimal CORS middleware — avoids an extra dependency for one header.
const allowedOrigin = process.env.STOREFRONT_ORIGIN || '*';
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', allowedOrigin);
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
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

// Background reconciliation sweep — a safety net independent of the
// frontend's own polling (e.g. a customer who pays after closing the tab).
// Cheap because the store is in-memory and orders are few; each order is
// still individually throttled via store.shouldReconcileNow().
const SWEEP_INTERVAL_MS = 20 * 1000;
setInterval(async () => {
  if (!dinarak.isConfigured()) return;
  const pending = store.listPendingOrders();
  for (const order of pending) {
    if (!store.shouldReconcileNow(order)) continue;
    store.markReconcileChecked(order.orderId);
    try {
      const result = await dinarak.reconcilePendingOrder(order);
      if (result.matched) store.markOrderPaid(order.orderId, result.transactionId);
    } catch (e) {
      // Swallow — the next sweep or the customer's own status poll retries.
      console.error(`[dinarak-sweep] reconcile failed for ${order.orderId}:`, e.message);
    }
  }
}, SWEEP_INTERVAL_MS);

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Turkish Bazaar payment backend listening on port ${port}`);
  if (!dinarak.isConfigured()) {
    console.log('⚠️  Dinarak GetBusinessTransactions is not configured (DINARAK_API_BASE_URL / DINARAK_BASIC_AUTH_USERNAME / DINARAK_BASIC_AUTH_PASSWORD / DINARAK_MERCHANT_ALIAS) — online payment will respond with "gateway_not_configured" until these are set.');
  }
  if (!dinarak.isAliasResolveConfigured()) {
    console.log('ℹ️  DINARAK_BEARER_TOKEN not set — phone validation via AliasResolve is disabled (optional, not required for payments to work).');
  }
});
