/**
 * Optional checkout helper: validates the customer's phone number against
 * Dinarak's AliasResolve before we ever create an order, so a typo or a
 * non-Dinarak number is caught immediately instead of silently failing
 * reconciliation later. Purely informational — never treated as proof of
 * payment or identity.
 *
 * Not wired into the frontend yet (works once DINARAK_BEARER_TOKEN is set).
 */

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
    return res.json(result); // { picCode, fullName, bankName }
  } catch (e) {
    const code = e.code || 'unknown_error';
    const status = code === 'gateway_not_configured' ? 503 : 502;
    return res.status(status).json({ error: code, message: e.message });
  }
});

module.exports = router;
