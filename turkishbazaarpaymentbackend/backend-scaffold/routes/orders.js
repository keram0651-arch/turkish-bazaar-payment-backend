const express = require('express');
const router = express.Router();
const store = require('../orders');
const dinarak = require('../services/dinarakAdapter');

// POST /api/orders — create a PENDING_PAYMENT order
router.post('/', (req, res) => {
  const { orderId, amount, currency, customer, items } = req.body || {};
  if (!orderId || !amount || !customer) {
    return res.status(400).json({ error: 'orderId, amount and customer are required' });
  }
  try {
    const order = store.createOrder({ orderId, amount, currency, customer, items });
    res.status(201).json({ orderId: order.orderId, status: order.status });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

// GET /api/orders/:orderId/status — frontend polls this.
// While the order is still PENDING_PAYMENT, this also (throttled) asks
// Dinarak's GetBusinessTransactions whether the customer's transfer has
// arrived yet, and marks the order PAID if it finds a match — this is the
// "pull" equivalent of a webhook, used because no push/webhook mechanism
// is documented by Dinarak yet. See services/dinarakAdapter.js.
router.get('/:orderId/status', async (req, res) => {
  let order = store.getOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status === 'PENDING_PAYMENT' && dinarak.isConfigured() && store.shouldReconcileNow(order)) {
    store.markReconcileChecked(order.orderId);
    try {
      const result = await dinarak.reconcilePendingOrder(order);
      if (result.matched) {
        store.markOrderPaid(order.orderId, result.transactionId);
      }
    } catch (e) {
      // Reconciliation errors never fail the status poll — the customer's
      // screen should keep showing "pending", not an error, while we retry
      // on the next poll/sweep.
    }
    order = store.getOrder(order.orderId);
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
