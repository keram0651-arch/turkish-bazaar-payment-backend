/**
 * Order store — persistent, backed by Postgres via db.js (works with
 * Supabase's free Postgres, or any standard Postgres connection string).
 *
 * Every function here is async now (it talks to a real database) — callers
 * must `await` them. This replaced an earlier in-memory-Map version; that
 * version is gone on purpose, not kept as a fallback, so there is no way to
 * silently end up back on non-persistent storage without DATABASE_URL being
 * set loudly failing first (see db.js).
 *
 * Order status values match what the frontend expects:
 *   PENDING_PAYMENT | PAID | FAILED | EXPIRED
 */

const db = require('./db');

const ORDER_TTL_MS = 30 * 60 * 1000; // 30 minutes before a pending order is considered expired
const RECONCILE_THROTTLE_MS = 5 * 1000; // don't call Dinarak more than once per 5s per order

// Fulfillment status — separate from `status` (PENDING_PAYMENT|PAID|FAILED|
// EXPIRED, which tracks payment). This tracks the merchant's own
// pack-and-deliver workflow in the admin panel, and applies to every order
// regardless of payment method (today: cash on delivery only).
const FULFILLMENT_FLOW = ['new', 'confirmed', 'preparing', 'ready', 'outfordelivery', 'completed'];
const FULFILLMENT_STATUSES = new Set([...FULFILLMENT_FLOW, 'cancelled']);

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

function rowToOrder(row) {
  if (!row) return null;
  return {
    orderId: row.order_id,
    status: row.status,
    fulfillmentStatus: row.fulfillment_status,
    paymentMethod: row.payment_method,
    amount: Number(row.amount),
    currency: row.currency,
    customer: row.customer,
    customerPhone: row.customer_phone,
    items: row.items,
    transactionReference: row.transaction_reference,
    failureReason: row.failure_reason || undefined,
    lastReconcileCheckAt: row.last_reconcile_check_at
      ? new Date(row.last_reconcile_check_at).toISOString()
      : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function createOrder({ orderId, amount, currency, customer, items, paymentMethod }) {
  const pool = db.getPool();
  const customerPhone = normalizeJordanPhone(customer && customer.phone);
  try {
    const { rows } = await pool.query(
      `INSERT INTO orders (order_id, payment_method, amount, currency, customer, customer_phone, items)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [orderId, paymentMethod || null, amount, currency || 'JOD', customer, customerPhone, JSON.stringify(items || [])]
    );
    return rowToOrder(rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      // unique_violation on order_id's primary key
      throw new Error(`Order ${orderId} already exists`);
    }
    throw e;
  }
}

/**
 * Looks up one order by id. Lazily expires it (PENDING_PAYMENT -> EXPIRED)
 * if it's been sitting unpaid past ORDER_TTL_MS, same as before.
 */
async function getOrder(orderId) {
  const pool = db.getPool();
  const { rows } = await pool.query(`SELECT * FROM orders WHERE order_id = $1`, [orderId]);
  let order = rowToOrder(rows[0]);
  if (!order) return null;
  if (order.status === 'PENDING_PAYMENT' && Date.now() - new Date(order.createdAt).getTime() > ORDER_TTL_MS) {
    const { rows: updated } = await pool.query(
      `UPDATE orders SET status='EXPIRED', updated_at=now() WHERE order_id=$1 AND status='PENDING_PAYMENT' RETURNING *`,
      [orderId]
    );
    if (updated[0]) order = rowToOrder(updated[0]);
  }
  return order;
}

/**
 * All orders, most recent first — used by the admin panel. Also lazily
 * expires any stale pending orders found in the batch.
 */
async function listAllOrders() {
  const pool = db.getPool();
  const { rows } = await pool.query(`SELECT * FROM orders ORDER BY created_at DESC`);
  const results = [];
  for (const row of rows) {
    let order = rowToOrder(row);
    if (order.status === 'PENDING_PAYMENT' && Date.now() - new Date(order.createdAt).getTime() > ORDER_TTL_MS) {
      order = await getOrder(order.orderId); // reuse the single expiry code path above
    }
    results.push(order);
  }
  return results;
}

/**
 * All orders still PENDING_PAYMENT (after lazily expiring stale ones) —
 * used by the background reconciliation sweep in server.js.
 */
async function listPendingOrders() {
  const all = await listAllOrders();
  return all.filter((o) => o.status === 'PENDING_PAYMENT');
}

/**
 * True if this order hasn't been checked against Dinarak in the last
 * RECONCILE_THROTTLE_MS — used to avoid hammering GetBusinessTransactions
 * every time the frontend polls /status. Pure function, no DB access.
 */
function shouldReconcileNow(order) {
  if (!order.lastReconcileCheckAt) return true;
  return Date.now() - new Date(order.lastReconcileCheckAt).getTime() > RECONCILE_THROTTLE_MS;
}

async function markReconcileChecked(orderId) {
  const pool = db.getPool();
  await pool.query(`UPDATE orders SET last_reconcile_check_at = now() WHERE order_id = $1`, [orderId]);
}

/**
 * Marks an order PAID — the ONLY function allowed to do so.
 * Guards against:
 *  - Marking an order that doesn't exist
 *  - Marking the same transactionReference twice (idempotency, checked
 *    across ALL orders, matching the previous in-memory behavior)
 *  - Marking an order that's already PAID/FAILED/EXPIRED
 */
async function markOrderPaid(orderId, transactionReference) {
  if (!transactionReference) {
    throw new Error('transactionReference is required to mark an order PAID');
  }
  const pool = db.getPool();
  const { rows: existing } = await pool.query(
    `SELECT * FROM orders WHERE transaction_reference = $1 LIMIT 1`,
    [transactionReference]
  );
  if (existing.length) {
    return { alreadyProcessed: true, order: await getOrder(orderId) };
  }
  const { rows } = await pool.query(
    `UPDATE orders SET status='PAID', transaction_reference=$2, updated_at=now()
     WHERE order_id=$1 AND status='PENDING_PAYMENT'
     RETURNING *`,
    [orderId, transactionReference]
  );
  if (!rows.length) {
    const current = await getOrder(orderId);
    if (!current) throw new Error(`Cannot mark unknown order ${orderId} as PAID`);
    return { alreadyProcessed: true, order: current }; // already PAID/FAILED/EXPIRED
  }
  return { alreadyProcessed: false, order: rowToOrder(rows[0]) };
}

async function markOrderFailed(orderId, reason) {
  const pool = db.getPool();
  const { rows } = await pool.query(
    `UPDATE orders SET status='FAILED', failure_reason=$2, updated_at=now()
     WHERE order_id=$1 AND status='PENDING_PAYMENT' RETURNING *`,
    [orderId, reason || 'unknown']
  );
  if (rows.length) return rowToOrder(rows[0]);
  return getOrder(orderId); // null if unknown, or the existing final state — don't overwrite silently
}

/**
 * Updates an order's fulfillment status (the admin panel's new -> confirmed
 * -> preparing -> ready -> outfordelivery -> completed flow, or
 * 'cancelled'). Independent of payment `status` — cancelling an order here
 * does NOT touch its payment state, and vice versa.
 */
async function setFulfillmentStatus(orderId, fulfillmentStatus) {
  if (!FULFILLMENT_STATUSES.has(fulfillmentStatus)) {
    throw new Error(`Invalid fulfillment status: ${fulfillmentStatus}`);
  }
  const pool = db.getPool();
  const { rows } = await pool.query(
    `UPDATE orders SET fulfillment_status=$2, updated_at=now() WHERE order_id=$1 RETURNING *`,
    [orderId, fulfillmentStatus]
  );
  return rowToOrder(rows[0]) || null;
}

module.exports = {
  createOrder,
  getOrder,
  listAllOrders,
  listPendingOrders,
  shouldReconcileNow,
  markReconcileChecked,
  markOrderPaid,
  markOrderFailed,
  setFulfillmentStatus,
  normalizeJordanPhone,
  FULFILLMENT_FLOW,
  FULFILLMENT_STATUSES,
};
