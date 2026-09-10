const express = require('express');
const router = express.Router();
const store = require('../orders');
const dinarak = require('../services/dinarakAdapter');

router.post('/:orderId/pay/dinarak', async (req, res) => {
  const order = store.getOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'PENDING_PAYMENT') {
    return res.status(409).json({ error: `Order is already ${order.status}` });
  }

  try {
    const result = await dinarak.createPayment(order);
    return res.json(result); // { redirectUrl } or { qrImageUrl }
  } catch (e) {
    // Honest failure — matches the frontend's handling. No fake success,
    // ever, regardless of why the adapter couldn't start a payment.
    const code = e.code || 'unknown_error';
    const status = code === 'gateway_not_configured' || code === 'not_implemented' ? 503 : 502;
    return res.status(status).json({ error: code, message: e.message });
  }
});

module.exports = router;
