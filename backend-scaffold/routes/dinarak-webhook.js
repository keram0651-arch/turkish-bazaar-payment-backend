/**
 * Receives Dinarak's payment result notification.
 *
 * THIS IS THE ONLY PLACE AN ORDER MAY BE MARKED "PAID".
 * A customer-entered "transaction ID" typed into the checkout form is NEVER
 * treated as proof of payment — only a signature-verified callback landing
 * here, going through the adapter, is.
 *
 * All Dinarak-specific parsing/verification lives in services/dinarakAdapter.js.
 * This route only orchestrates: verify -> parse -> update order state.
 */

const express = require('express');
const router = express.Router();
const store = require('../orders');
const dinarak = require('../services/dinarakAdapter');

// Keep the raw body around for signature verification (exact method TBD
// once Dinarak documents it — see the adapter file).
router.post('/', express.raw({ type: '*/*' }), (req, res) => {
  const rawBody = req.body; // Buffer

  if (!dinarak.verifyWebhookSignature(rawBody, req.headers)) {
    return res.status(401).json({ error: 'invalid_or_unverified_signature' });
  }

  let parsedBody;
  try {
    parsedBody = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'invalid_json' });
  }

  const { orderReference, transactionId, status } = dinarak.parseWebhookPayload(parsedBody);

  if (!orderReference || !transactionId || !status) {
    return res.status(400).json({ error: 'malformed_webhook_payload' });
  }

  if (status === 'SUCCESS') {
    const result = store.markOrderPaid(orderReference, transactionId);
    return res.json({ received: true, alreadyProcessed: result.alreadyProcessed });
  }

  store.markOrderFailed(orderReference, status);
  return res.json({ received: true });
});

module.exports = router;
