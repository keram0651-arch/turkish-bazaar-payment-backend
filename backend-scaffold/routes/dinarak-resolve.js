const express = require('express');
const router = express.Router();
const dinarak = require('../services/dinarakAdapter');
const { normalizeJordanPhone } = require('../orders');

// POST /api/orders/resolve-phone  { phone: "079 000 0000" }
router.post('/resolve-phone', async (req, res) => {
  const phone = normalizeJordanPhone((req.body || {}).phone);
  if (!phone) {
    return res.status(400).json({ error: 'invalid_phone', message: 'Not a valid Jordanian mobile number.' });
  }
  try {
    const result = await dinarak.resolveAlias('MOBL', phone);
    if (!result) return res.status(404).json({ error: 'not_found', message: 'This number is not registered with Dinarak.' });
    return res.json(result);
  } catch (e) {
    const code = e.code || 'unknown_error';
    const status = code === 'gateway_not_configured' ? 503 : 502;
    return res.status(status).json({ error: code, message: e.message });
  }
});

module.exports = router;
