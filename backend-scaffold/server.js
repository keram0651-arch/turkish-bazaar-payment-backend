require('dotenv').config();
const express = require('express');

const ordersRoute = require('./routes/orders');
const dinarakPayRoute = require('./routes/dinarak-pay');
const dinarakWebhookRoute = require('./routes/dinarak-webhook');
const dinarakResolveRoute = require('./routes/dinarak-resolve');
const store = require('./orders');
const dinarak = require('./services/dinarakAdapter');

const app = express();

const allowedOrigin = process.env.STOREFRONT_ORIGIN || '*';
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', allowedOrigin);
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/webhooks/dinarak', dinarakWebhookRoute);

app.use(express.json());
app.use('/api/orders', ordersRoute);
app.use('/api/orders', dinarakPayRoute);
app.use('/api/orders', dinarakResolveRoute);

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
      console.error(`[dinarak-sweep] reconcile failed for ${order.orderId}:`, e.message);
    }
  }
}, SWEEP_INTERVAL_MS);

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Turkish Bazaar payment backend listening on port ${port}`);
  if (!dinarak.isConfigured()) {
    console.log('Dinarak GetBusinessTransactions is not configured — online payment will respond with "gateway_not_configured" until DINARAK_API_BASE_URL / DINARAK_BASIC_AUTH_USERNAME / DINARAK_BASIC_AUTH_PASSWORD / DINARAK_MERCHANT_ALIAS are set.');
  }
  if (!dinarak.isAliasResolveConfigured()) {
    console.log('DINARAK_BEARER_TOKEN not set — phone validation via AliasResolve is disabled (optional, not required for payments to work).');
  }
});
