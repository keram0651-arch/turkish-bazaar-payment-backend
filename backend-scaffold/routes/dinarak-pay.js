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
  if (!order.customerPhone) {
    return res.status(400).json({
      error: 'invalid_phone',
      message: 'A valid Jordanian mobile number is required to pay via Dinarak (needed to match the incoming transfer).',
    });
  }

  try {
    const result = await dinarak.createPayment(order);
    return res.json(result);
  } catch (e) {
    const code = e.code || 'unknown_error';
    const status = code === 'gateway_not_configured' || code === 'not_implemented' ? 503 : 502;
    return res.status(status).json({ error: code, message: e.message });
  }
});

module.exports = router;
