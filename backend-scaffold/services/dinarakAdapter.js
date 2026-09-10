/**
 * Dinarak Payment Adapter
 * =======================
 * This file is the ONLY place in the codebase allowed to know about
 * Dinarak's specific API shape. Routes never call Dinarak directly — they
 * call this adapter. That means once you get the real integration package
 * from Dinarak, you fill in the three methods below and NOTHING else in
 * the app (routes, order state machine, frontend) needs to change.
 *
 * This is deliberately written as a small, swappable "adapter" so that if
 * you ever add a second payment method later (another bank, another
 * wallet), it becomes its own adapter file with the same three-method
 * shape, and routes/orders.js stays untouched.
 *
 * STATUS: not implemented. Every method below throws/returns a clear
 * "not configured" result until real credentials + API docs exist.
 * Nothing here is guessed.
 */

function isConfigured() {
  return Boolean(
    process.env.DINARAK_API_BASE_URL &&
    process.env.DINARAK_API_KEY &&
    process.env.DINARAK_MERCHANT_ID
  );
}

/**
 * Start a payment for an order. Should return either:
 *   { redirectUrl: string }   — send the customer to a Dinarak-hosted page
 *   { qrImageUrl: string }    — show a CliQ QR code in our own UI
 * Throws if not configured or if Dinarak's API call fails.
 *
 * @param {{orderId: string, amount: number, currency: string, customer: object}} order
 */
async function createPayment(order) {
  if (!isConfigured()) {
    const err = new Error('gateway_not_configured');
    err.code = 'gateway_not_configured';
    throw err;
  }

  // ------------------------------------------------------------------
  // TODO: DINARAK INTEGRATION
  // Replace with the real call once Dinarak provides their API docs.
  // See ../WHAT_TO_ASK_DINARAK.md for exactly what to request.
  //
  // Example shape (field names below are illustrative ONLY — replace with
  // whatever Dinarak's real documentation specifies):
  //
  //   const response = await fetch(`${process.env.DINARAK_API_BASE_URL}/<real-endpoint>`, {
  //     method: 'POST',
  //     headers: {
  //       'Content-Type': 'application/json',
  //       'Authorization': `Bearer ${process.env.DINARAK_API_KEY}`,
  //     },
  //     body: JSON.stringify({
  //       merchantId: process.env.DINARAK_MERCHANT_ID,
  //       orderReference: order.orderId,
  //       amount: order.amount,
  //       currency: order.currency,
  //     }),
  //   });
  //   if (!response.ok) {
  //     const err = new Error('dinarak_request_failed');
  //     err.code = 'dinarak_request_failed';
  //     throw err;
  //   }
  //   const data = await response.json();
  //   return data.paymentUrl ? { redirectUrl: data.paymentUrl } : { qrImageUrl: data.qrCodeUrl };
  // ------------------------------------------------------------------

  const err = new Error('not_implemented');
  err.code = 'not_implemented';
  throw err;
}

/**
 * Verify that an incoming webhook request really came from Dinarak.
 * Must be filled in using Dinarak's real signature scheme — do not accept
 * a webhook as valid without this check once it's implemented.
 *
 * @param {Buffer|string} rawBody - the raw, unparsed request body
 * @param {object} headers - the request headers
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, headers) {
  if (!process.env.DINARAK_WEBHOOK_SIGNING_SECRET) return false;

  // ------------------------------------------------------------------
  // TODO: DINARAK INTEGRATION — replace with their real signature method.
  // Common pattern (illustrative, not necessarily Dinarak's actual scheme):
  //
  //   const crypto = require('crypto');
  //   const signature = headers['x-dinarak-signature'];
  //   const expected = crypto.createHmac('sha256', process.env.DINARAK_WEBHOOK_SIGNING_SECRET)
  //                          .update(rawBody).digest('hex');
  //   return signature === expected;
  // ------------------------------------------------------------------

  return false; // fail closed until real verification is wired in
}

/**
 * Parse a verified webhook body into our own normalized shape.
 * Field names on the left are OUR normalized names; fill in the right side
 * once you know Dinarak's real payload field names.
 *
 * @param {object} body - parsed JSON body of the webhook
 * @returns {{orderReference: string, transactionId: string, status: 'SUCCESS'|'FAILED'}}
 */
function parseWebhookPayload(body) {
  // TODO: DINARAK INTEGRATION — map their real field names here, e.g.:
  //   return {
  //     orderReference: body.merchantReference,
  //     transactionId: body.dinarakTransactionId,
  //     status: body.paymentStatus === 'COMPLETED' ? 'SUCCESS' : 'FAILED',
  //   };
  return {
    orderReference: body.orderReference || null,
    transactionId: body.transactionId || null,
    status: body.status || null,
  };
}

module.exports = { isConfigured, createPayment, verifyWebhookSignature, parseWebhookPayload };
