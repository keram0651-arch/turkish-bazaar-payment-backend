/**
 * Order store — minimal in-memory implementation.
 *
 * IMPORTANT: this uses a plain in-memory Map so the scaffold runs with zero
 * setup. Replace this with a real database (Postgres/SQLite/etc.) before
 * accepting real payments — an in-memory store is wiped every time the
 * server restarts, which is not acceptable for real orders.
 *
 * Order status values match what the frontend expects:
 *   PENDING_PAYMENT | PAID | FAILED | EXPIRED
 */

const orders = new Map();
const seenTransactionRefs = new Set(); // idempotency guard

const ORDER_TTL_MS = 30 * 60 * 1000; // 30 minutes before a pending order is considered expired

function createOrder({ orderId, amount, currency, customer, items }) {
  if (orders.has(orderId)) {
    throw new Error(`Order ${orderId} already exists`);
  }
  const order = {
    orderId,
    status: 'PENDING_PAYMENT',
    amount,
    currency: currency || 'JOD',
    customer,
    items,
    transactionReference: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  orders.set(orderId, order);
  return order;
}

function getOrder(orderId) {
  const order = orders.get(orderId);
  if (!order) return null;
  // Lazily expire stale pending orders when read
  if (
    order.status === 'PENDING_PAYMENT' &&
    Date.now() - new Date(order.createdAt).getTime() > ORDER_TTL_MS
  ) {
    order.status = 'EXPIRED';
    order.updatedAt = new Date().toISOString();
  }
  return order;
}

/**
 * Marks an order PAID — the ONLY function allowed to do so.
 * Guards against:
 *  - Marking an order that doesn't exist
 *  - Marking the same transactionReference twice (idempotency)
 *  - Marking an order that's already PAID/FAILED/EXPIRED
 */
function markOrderPaid(orderId, transactionReference) {
  if (!transactionReference) {
    throw new Error('transactionReference is required to mark an order PAID');
  }
  if (seenTransactionRefs.has(transactionReference)) {
    // Already processed this exact transaction before — do nothing, but
    // don't treat it as an error either (webhooks can be retried by the
    // provider; that's normal and must be handled gracefully).
    return { alreadyProcessed: true, order: getOrder(orderId) };
  }
  const order = orders.get(orderId);
  if (!order) {
    throw new Error(`Cannot mark unknown order ${orderId} as PAID`);
  }
  if (order.status !== 'PENDING_PAYMENT') {
    // Order was already PAID, FAILED, or EXPIRED — do not overwrite silently.
    return { alreadyProcessed: true, order };
  }
  order.status = 'PAID';
  order.transactionReference = transactionReference;
  order.updatedAt = new Date().toISOString();
  seenTransactionRefs.add(transactionReference);
  return { alreadyProcessed: false, order };
}

function markOrderFailed(orderId, reason) {
  const order = orders.get(orderId);
  if (!order) return null;
  if (order.status !== 'PENDING_PAYMENT') return order; // don't overwrite a final state
  order.status = 'FAILED';
  order.failureReason = reason || 'unknown';
  order.updatedAt = new Date().toISOString();
  return order;
}

module.exports = { createOrder, getOrder, markOrderPaid, markOrderFailed };
