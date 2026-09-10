/**
 * Dinarak Payment Adapter — Poll & Reconcile model
 * =================================================
 * This file is the ONLY place in the codebase allowed to know about
 * Dinarak's specific API shape. Routes never call Dinarak directly — they
 * call this adapter. If the payment model below ever changes (e.g. Dinarak
 * confirms a real push/"create payment" endpoint), only THIS file needs to
 * change — routes/orders.js/the frontend stay untouched.
 *
 * WHY "poll & reconcile" instead of a redirect/QR/webhook flow:
 * As of the two API docs Dinarak has provided so far, there is NO endpoint
 * to push/request a payment from a customer. The only two documented
 * endpoints are:
 *   - GetBusinessTransactions (POST, Basic Auth) — lists incoming transfers
 *     to our business account, filterable by sender phone/alias + date range.
 *   - AliasResolve (GET, Bearer Auth) — resolves a phone/alias to a name +
 *     bank, so we can validate a customer's number before checkout.
 * Given that, the real-world payment flow for CliQ merchants without a push
 * API is: the customer manually sends money to our merchant alias from
 * their own banking app, and we detect + verify that transfer by polling
 * GetBusinessTransactions and matching it to the pending order.
 *
 * STILL BLOCKING — must be requested from Dinarak before this can hit real
 * servers (nothing below is guessed beyond what's in the two doc's tables):
 *   1. DINARAK_BASIC_AUTH_USERNAME / DINARAK_BASIC_AUTH_PASSWORD — the doc
 *      says GetBusinessTransactions uses "Basic Authentication" but does not
 *      say whose credentials (merchant portal login? separate API creds?).
 *   2. DINARAK_BEARER_TOKEN — the doc says AliasResolve uses "Bearer" auth
 *      but documents no login/token endpoint. Ask Dinarak how this token is
 *      obtained/refreshed, or whether it's a static long-lived token.
 * See ../WHAT_TO_ASK_DINARAK.md for the exact question list.
 *
 * MATCHING CAVEAT: GetBusinessTransactions' transaction objects (per the
 * doc's example) only carry {reference, createDate, receiverInfo,
 * totalAmount, originalAmount, senderInfo} — no order reference/note field.
 * So a transfer is matched to a pending order by senderInfo (the phone
 * number the customer gave us at checkout) + originalAmount + a time
 * window starting at order creation. This assumes originalAmount is the
 * amount that actually lands in our account (i.e. the sender pays any
 * Dinarak fee on top, via totalAmount) — verify this assumption against a
 * real test transaction before going live; if it's backwards, swap
 * originalAmount for totalAmount below in one place.
 */

const RECONCILE_WINDOW_PADDING_MS = 5 * 60 * 1000; // absorb clock drift by looking slightly before order creation

function isConfigured() {
  return Boolean(
    process.env.DINARAK_API_BASE_URL &&
    process.env.DINARAK_BASIC_AUTH_USERNAME &&
    process.env.DINARAK_BASIC_AUTH_PASSWORD &&
    process.env.DINARAK_MERCHANT_ALIAS
  );
}

function isAliasResolveConfigured() {
  return Boolean(process.env.DINARAK_API_BASE_URL && process.env.DINARAK_BEARER_TOKEN);
}

/**
 * "Start" a payment. Since there is no push/create endpoint, this makes NO
 * external call — it just returns the instructions the frontend shows the
 * customer: our merchant alias + the exact amount to transfer themselves.
 *
 * @param {{orderId: string, amount: number, currency: string}} order
 * @returns {{payInstructions: {method: string, alias: string, amount: number, currency: string, note: string}}}
 */
async function createPayment(order) {
  if (!isConfigured()) {
    const err = new Error('gateway_not_configured');
    err.code = 'gateway_not_configured';
    throw err;
  }
  return {
    payInstructions: {
      method: 'dinarak_cliq_manual_transfer',
      alias: process.env.DINARAK_MERCHANT_ALIAS,
      amount: order.amount,
      currency: order.currency,
      note: `Turkish Bazaar order ${order.orderId}`,
    },
  };
}

/**
 * Ask Dinarak whether an incoming transfer matching this pending order has
 * arrived yet. Called (throttled) from the status route, and/or a periodic
 * background sweep — never trusts anything the customer typed in.
 *
 * @param {{orderId: string, amount: number, createdAt: string, customerPhone?: string}} order
 * @returns {Promise<{matched: boolean, transactionId?: string}>}
 */
async function reconcilePendingOrder(order) {
  if (!isConfigured()) {
    const err = new Error('gateway_not_configured');
    err.code = 'gateway_not_configured';
    throw err;
  }
  if (!order.customerPhone) {
    // Matching on amount alone risks crossing two different customers'
    // payments — refuse to guess without a phone number to narrow by.
    return { matched: false };
  }

  const startDate = new Date(new Date(order.createdAt).getTime() - RECONCILE_WINDOW_PADDING_MS).toISOString();
  const endDate = new Date().toISOString();

  const authHeader = 'Basic ' + Buffer.from(
    `${process.env.DINARAK_BASIC_AUTH_USERNAME}:${process.env.DINARAK_BASIC_AUTH_PASSWORD}`
  ).toString('base64');

  let response;
  try {
    response = await fetch(`${process.env.DINARAK_API_BASE_URL}/v2.0/Services/GetBusinessTransactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({ SenderInfo: order.customerPhone, StartDate: startDate, EndDate: endDate }),
    });
  } catch (e) {
    const err = new Error('dinarak_network_error');
    err.code = 'dinarak_network_error';
    throw err;
  }

  if (!response.ok) {
    const err = new Error('dinarak_request_failed');
    err.code = 'dinarak_request_failed';
    throw err;
  }
  const data = await response.json();
  if (!data.success) {
    const err = new Error(data.errorMessage || 'dinarak_error');
    err.code = 'dinarak_error';
    throw err;
  }

  const transactions = (data.data && data.data.transactions) || [];
  // See the MATCHING CAVEAT note at the top of this file about originalAmount.
  const match = transactions.find((tx) => Number(tx.originalAmount) === Number(order.amount));
  if (!match) return { matched: false };
  return { matched: true, transactionId: match.reference };
}

/**
 * Look up a phone/alias before accepting it at checkout, so we can tell the
 * customer immediately if it's not a real Dinarak-registered number (bonus:
 * shows whose account they're about to pay from). Purely a validation/UX
 * helper — never used as proof of payment.
 *
 * @param {'MOBL'|'ALIAS'} aliasType
 * @param {string} value - mobile number (9627xxxxxxxx) or alias
 * @returns {Promise<{picCode: string, fullName: string, bankName: string}|null>} null if not found
 */
async function resolveAlias(aliasType, value) {
  if (!isAliasResolveConfigured()) {
    const err = new Error('gateway_not_configured');
    err.code = 'gateway_not_configured';
    throw err;
  }
  const url = `${process.env.DINARAK_API_BASE_URL}/v2.0/Transfer/AliasResolve?aliastype=${encodeURIComponent(aliasType)}&value=${encodeURIComponent(value)}`;
  let response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.DINARAK_BEARER_TOKEN}` } });
  } catch (e) {
    const err = new Error('dinarak_network_error');
    err.code = 'dinarak_network_error';
    throw err;
  }
  if (response.status === 590) return null; // "Customer not found" per the doc
  if (!response.ok) {
    const err = new Error('dinarak_request_failed');
    err.code = 'dinarak_request_failed';
    throw err;
  }
  return response.json(); // { picCode, fullName, bankName }
}

/* ------------------------------------------------------------------------
 * Legacy webhook hooks — kept in case Dinarak later documents a real push
 * notification mechanism. Currently unused: routes/dinarak-webhook.js still
 * exists but nothing calls it, since no webhook has ever been documented.
 * verifyWebhookSignature() fails closed (returns false) until real
 * credentials + a real signature scheme are documented.
 * ---------------------------------------------------------------------- */
function verifyWebhookSignature(rawBody, headers) {
  if (!process.env.DINARAK_WEBHOOK_SIGNING_SECRET) return false;
  return false; // fail closed until Dinarak documents a real webhook + signature scheme
}

function parseWebhookPayload(body) {
  return {
    orderReference: body.orderReference || null,
    transactionId: body.transactionId || null,
    status: body.status || null,
  };
}

module.exports = {
  isConfigured,
  isAliasResolveConfigured,
  createPayment,
  reconcilePendingOrder,
  resolveAlias,
  verifyWebhookSignature,
  parseWebhookPayload,
};
