/**
 * Dinarak Payment Adapter — Poll & Reconcile model
 * =================================================
 * This file is the ONLY place in the codebase allowed to know about
 * Dinarak's specific API shape. Routes never call Dinarak directly — they
 * call this adapter.
 */

const RECONCILE_WINDOW_PADDING_MS = 5 * 60 * 1000;

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
 * Lighter check just for showing payment instructions to the customer.
 * Unlike isConfigured() (which gates AUTOMATIC verification and requires the
 * Basic Auth credentials we don't have yet), createPayment() below makes no
 * external call at all — it only needs our own merchant alias. This lets the
 * storefront accept orders and show "transfer to this alias" today, while
 * automatic payment detection stays off until DINARAK_BASIC_AUTH_USERNAME /
 * DINARAK_BASIC_AUTH_PASSWORD / DINARAK_API_BASE_URL are set (isConfigured()
 * above still gates that, in routes/orders.js and the background sweep).
 */
function isPaymentInstructionsConfigured() {
  return Boolean(process.env.DINARAK_MERCHANT_ALIAS);
}

async function createPayment(order) {
  if (!isPaymentInstructionsConfigured()) {
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

async function reconcilePendingOrder(order) {
  if (!isConfigured()) {
    const err = new Error('gateway_not_configured');
    err.code = 'gateway_not_configured';
    throw err;
  }
  if (!order.customerPhone) {
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
  const match = transactions.find((tx) => Number(tx.originalAmount) === Number(order.amount));
  if (!match) return { matched: false };
  return { matched: true, transactionId: match.reference };
}

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
  if (response.status === 590) return null;
  if (!response.ok) {
    const err = new Error('dinarak_request_failed');
    err.code = 'dinarak_request_failed';
    throw err;
  }
  return response.json();
}

function verifyWebhookSignature(rawBody, headers) {
  if (!process.env.DINARAK_WEBHOOK_SIGNING_SECRET) return false;
  return false;
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
  isPaymentInstructionsConfigured,
  createPayment,
  reconcilePendingOrder,
  resolveAlias,
  verifyWebhookSignature,
  parseWebhookPayload,
};
