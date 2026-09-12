/**
 * Dinarak Payment Adapter — Poll & Reconcile model
 * =================================================
 * This file is the ONLY place in the codebase allowed to know about
 * Dinarak's specific API shape. Routes never call Dinarak directly — they
 * call this adapter. If the payment model below ever changes (e.g. Dinarak
 * confirms a real push/"create payment" endpoint), only THIS file needs to
 * change — routes/orders.js/the frontend stay untouched.
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
  if (response.status === 590) return null; // "Customer not found" per the doc
  if (!response.ok) {
    const err = new Error('dinarak_request_failed');
    err.code = 'dinarak_request_failed';
    throw err;
  }
  return response.json(); // { picCode, fullName, bankName }
}

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
