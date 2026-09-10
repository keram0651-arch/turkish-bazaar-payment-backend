require('dotenv').config();
const express = require('express');

const ordersRoute = require('./routes/orders');
const dinarakPayRoute = require('./routes/dinarak-pay');
const dinarakWebhookRoute = require('./routes/dinarak-webhook');

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

// IMPORTANT: mounted BEFORE express.json() below, because this route needs
// the raw, unparsed body to verify Dinarak's webhook signature. If the
// global JSON parser ran first, the raw body would already be consumed.
app.use('/webhooks/dinarak', dinarakWebhookRoute);

app.use(express.json());
app.use('/api/orders', ordersRoute);
app.use('/api/orders', dinarakPayRoute);

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Turkish Bazaar payment backend listening on port ${port}`);
  if (!process.env.DINARAK_API_KEY) {
    console.log('⚠️  DINARAK_API_KEY is not set — online payment will respond with "gateway_not_configured" until real credentials are added to .env');
  }
});
