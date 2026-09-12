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

function normalizeJordanPhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^0-9]/g, '');
  if (digits.startsWith('00962')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = '962' + digits.slice(1);
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
  if (
    order.status === 'PENDING_PAYMENT' &&
    Date.now() - new Date(order.createdAt).getTime() > ORDER_TTL_MS
  ) {
    order.status = 'EXPIRED';
    order.updatedAt = new Date().toISOString();
  }
  return order;
}

function listPendingOrders() {
  return Array.from(orders.keys())
    .map(getOrder)
    .filter((o) => o && o.status === 'PENDING_PAYMENT');
}

function shouldReconcileNow(order) {
  if (!order.lastReconcileCheckAt) return true;
  return Date.now() - new Date(order.lastReconcileCheckAt).getTime() > RECONCILE_THROTTLE_MS;
}

function markReconcileChecked(orderId) {
  const order = orders.get(orderId);
  if (order) order.lastReconcileCheckAt = new Date().toISOString();
}

function markOrderPaid(orderId, transactionReference) {
  if (!transactionReference) {
    throw new Error('transactionReference is required to mark an order PAID');
  }
  if (seenTransactionRefs.has(transactionReference)) {
    return { alreadyProcessed: true, order: getOrder(orderId) };
  }
  const order = orders.get(orderId);
  if (!order) {
    throw new Error(`Cannot mark unknown order ${orderId} as PAID`);
  }
  if (order.status !== 'PENDING_PAYMENT') {
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
  if (order.status !== 'PENDING_PAYMENT') return order;
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
