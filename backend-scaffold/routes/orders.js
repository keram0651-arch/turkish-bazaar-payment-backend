const express = require('express');
const router = express.Router();
const store = require('../orders');

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

// GET /api/orders/:orderId/status — frontend polls this
router.get('/:orderId/status', (req, res) => {
  const order = store.getOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({
    orderId: order.orderId,
    status: order.status, // PENDING_PAYMENT | PAID | FAILED | EXPIRED
    amount: order.amount,
    currency: order.currency,
    transactionReference: order.transactionReference || null,
  });
});

module.exports = router;
