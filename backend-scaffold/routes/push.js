const express = require('express');
const router = express.Router();
const pushNotifier = require('../services/pushNotifier');
const requireAdminKey = require('../middleware/requireAdminKey');

// GET /api/push/public-key — public (not a secret). The admin panel fetches
// this once to know which VAPID key to subscribe against.
router.get('/public-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'push_not_configured' });
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe — the admin panel calls this right after the
// browser grants notification permission and returns a PushSubscription.
// Admin-key gated: this is effectively "register a device to receive our
// order data", same trust level as reading /api/orders.
router.post('/subscribe', requireAdminKey, async (req, res) => {
  const sub = req.body && req.body.subscription;
  try {
    const result = await pushNotifier.addSubscription(sub);
    res.status(201).json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/push/unsubscribe — called when the admin panel's "Disable
// Notifications" toggle is used, or the browser reports the subscription is
// no longer valid.
router.post('/unsubscribe', requireAdminKey, async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
  const result = await pushNotifier.removeSubscription(endpoint);
  res.json(result);
});

module.exports = router;
