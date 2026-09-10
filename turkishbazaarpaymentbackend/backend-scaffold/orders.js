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
const RECONCILE_THROTTLE_MS = 5 * 1000; // don't call Dinarak more than once per 5s per order

/**
 * Normalize a Jordanian phone number to the 9627xxxxxxxx shape Dinarak's
 * docs require (AliasResolve's `value` param, and what we match
 * GetBusinessTransactions' `senderInfo` against). Accepts common local
 * input shapes like "079 000 0000", "00962790000000", "+962790000000".
 * Returns null if it doesn't look like a Jordanian mobile number at all —
 * callers decide whether that's fatal (Dinarak payment) or just means
 * matching won't be attempted.
 */
function normalizeJordanPhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^0-9]/g, '');
  if (digits.startsWith('00962')) digits = digits.slice(2); // 00962... -> 962...
  if (digits.startsWith('0')) digits = '962' + digits.slice(1); // 07... -> 9627...
  if (!digits.startsWith('962')) digits = '962' + digits.replace(/^962/, '');
  if (!/^9627\d{8}$/.test(digits)) return null;
  return digits;
}

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
    customerPhone: normalizeJordanPhone(customer && customer.phone),
    items,
    transactionReference: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastReconcileCheckAt: null,
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
 * All orders still PENDING_PAYMENT (after lazily expiring stale ones) —
 * used by the background reconciliation sweep in server.js.
 */
function listPendingOrders() {
  return Array.from(orders.keys())
    .map(getOrder)
    .filter((o) => o && o.status === 'PENDING_PAYMENT');
}

/**
 * True if this order hasn't been checked against Dinarak in the last
 * RECONCILE_THROTTLE_MS — used to avoid hammering GetBusinessTransactions
 * every time the frontend polls /status.
 */
function shouldReconcileNow(order) {
  if (!order.lastReconcileCheckAt) return true;
  return Date.now() - new Date(order.lastReconcileCheckAt).getTime() > RECONCILE_THROTTLE_MS;
}

function markReconcileChecked(orderId) {
  const order = orders.get(orderId);
  if (order) order.lastReconcileCheckAt = new Date().toISOString();
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
    // don't treat it as an error either (a re-check can see the same
    // transaction again; that's normal and must be handled gracefully).
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

module.exports = {
  createOrder,
  getOrder,
  listPendingOrders,
  shouldReconcileNow,
  markReconcileChecked,
  markOrderPaid,
  markOrderFailed,
  normalizeJordanPhone,
};
