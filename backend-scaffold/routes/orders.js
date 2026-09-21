const express = require('express');
const router = express.Router();
const store = require('../orders');
const dinarak = require('../services/dinarakAdapter');
const whatsapp = require('../services/whatsappNotifier');
const email = require('../services/emailNotifier');
const pushNotifier = require('../services/pushNotifier');
const requireAdminKey = require('../middleware/requireAdminKey');

// POST /api/orders — create a PENDING_PAYMENT order
router.post('/', async (req, res) => {
  const { orderId, amount, currency, customer, items, paymentMethod } = req.body || {};
  if (!orderId || !amount || !customer) {
    return res.status(400).json({ error: 'orderId, amount and customer are required' });
  }
  try {
    const order = await store.createOrder({ orderId, amount, currency, customer, items, paymentMethod });
    // Best-effort merchant notifications — independent channels, never
    // block or fail the response to the customer, even if unconfigured or
    // a send fails (see services/whatsappNotifier.js, services/emailNotifier.js,
    // services/pushNotifier.js). pushNotifier is the real "notification from
    // the admin panel itself" channel — a system push, tap it and it opens
    // the admin panel straight to this order (see public/push-sw.js).
    whatsapp.notifyNewOrder(order).catch(() => {});
    email.notifyNewOrder(order).catch(() => {});
    pushNotifier.notifyNewOrder(order).catch(() => {});
    res.status(201).json({ orderId: order.orderId, status: order.status });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

// GET /api/orders — list every order, most recent first. Used by the admin
// panel. Exposes customer PII (name/phone/address), so it's gated behind
// ADMIN_API_KEY (see middleware/requireAdminKey.js).
router.get('/', requireAdminKey, async (req, res) => {
  const orders = await store.listAllOrders();
  const list = orders.map((order) => ({
    orderId: order.orderId,
    status: order.status, // payment status: PENDING_PAYMENT | PAID | FAILED | EXPIRED
    fulfillmentStatus: order.fulfillmentStatus, // new | confirmed | preparing | ready | outfordelivery | completed | cancelled
    paymentMethod: order.paymentMethod,
    amount: order.amount,
    currency: order.currency,
    customer: order.customer,
    items: order.items,
    transactionReference: order.transactionReference || null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  }));
  res.json({ orders: list });
});

// PATCH /api/orders/:orderId/fulfillment — admin panel moves an order
// through new -> confirmed -> preparing -> ready -> outfordelivery ->
// completed, or marks it cancelled. Independent of Dinarak/payment status.
router.patch('/:orderId/fulfillment', requireAdminKey, async (req, res) => {
  const { status } = req.body || {};
  if (!status || !store.FULFILLMENT_STATUSES.has(status)) {
    return res.status(400).json({ error: 'invalid_status', allowed: [...store.FULFILLMENT_STATUSES] });
  }
  try {
    const order = await store.setFulfillmentStatus(req.params.orderId, status);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ orderId: order.orderId, fulfillmentStatus: order.fulfillmentStatus });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/orders/:orderId/status — frontend polls this.
// While the order is still PENDING_PAYMENT, this also (throttled) asks
// Dinarak's GetBusinessTransactions whether the customer's transfer has
// arrived yet, and marks the order PAID if it finds a match — this is the
// "pull" equivalent of a webhook, used because no push/webhook mechanism
// is documented by Dinarak yet. See services/dinarakAdapter.js.
router.get('/:orderId/status', async (req, res) => {
  let order = await store.getOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status === 'PENDING_PAYMENT' && dinarak.isConfigured() && store.shouldReconcileNow(order)) {
    await store.markReconcileChecked(order.orderId);
    try {
      const result = await dinarak.reconcilePendingOrder(order);
      if (result.matched) {
        await store.markOrderPaid(order.orderId, result.transactionId);
      }
    } catch (e) {
      // Reconciliation errors never fail the status poll — the customer's
      // screen should keep showing "pending", not an error, while we retry
      // on the next poll/sweep.
    }
    order = await store.getOrder(order.orderId);
  }

  res.json({
    orderId: order.orderId,
    status: order.status, // PENDING_PAYMENT | PAID | FAILED | EXPIRED
    amount: order.amount,
    currency: order.currency,
    transactionReference: order.transactionReference || null,
  });
});

module.exports = router;
