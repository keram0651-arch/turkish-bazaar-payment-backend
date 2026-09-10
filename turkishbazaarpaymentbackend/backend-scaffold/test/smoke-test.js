/**
 * Dev-only smoke test — no real Dinarak account needed, it mocks
 * global.fetch to stand in for GetBusinessTransactions. Run any time with:
 *   node test/smoke-test.js
 * Verifies the whole poll & reconcile flow: order creation, phone
 * normalization/validation, the pay/dinarak route returning instructions
 * with NO external call, reconcile throttling, and a matched transfer
 * marking the order PAID exactly once (idempotency).
 */
process.chdir(__dirname + '/..');
process.env.PORT = '4123';
process.env.DINARAK_API_BASE_URL = 'https://apitest.dinarak.com';
process.env.DINARAK_BASIC_AUTH_USERNAME = 'testuser';
process.env.DINARAK_BASIC_AUTH_PASSWORD = 'testpass';
process.env.DINARAK_MERCHANT_ALIAS = 'TURKISHBAZAAR';
process.env.STOREFRONT_ORIGIN = '*';

let fetchCallCount = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('GetBusinessTransactions')) {
    fetchCallCount++;
    const body = JSON.parse(opts.body);
    assert(body.SenderInfo === '962790000001', `expected SenderInfo 962790000001, got ${body.SenderInfo}`);
    // First call: no matching transaction yet. Second+ call: match arrives.
    const transactions = fetchCallCount >= 2 ? [
      { reference: 'TX-REF-001', createDate: new Date().toISOString(), receiverInfo: 'TURKISHBAZAAR', totalAmount: 16.5, originalAmount: 15, senderInfo: '962790000001' },
    ] : [];
    return { ok: true, status: 200, json: async () => ({ success: true, data: { transactions }, errorMessage: null }) };
  }
  return realFetch(url, opts);
};

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); } }

async function main() {
  require('../server.js');
  await new Promise((r) => setTimeout(r, 300));
  const base = `http://localhost:${process.env.PORT}`;

  // 1. health check
  let r = await fetch(`${base}/health`);
  assert(r.ok, 'health check failed');
  console.log('PASS: /health');

  // 2. create order
  const orderId = 'TB-SMOKE-1';
  r = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, amount: 15, currency: 'JOD', customer: { name: 'Test', phone: '079 000 0001', address: 'Amman' }, items: [] }),
  });
  assert(r.status === 201, `expected 201 creating order, got ${r.status}`);
  console.log('PASS: POST /api/orders');

  // 3. duplicate order id should 409
  r = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, amount: 15, currency: 'JOD', customer: { name: 'Test', phone: '079 000 0001' } }),
  });
  assert(r.status === 409, `expected 409 on duplicate order, got ${r.status}`);
  console.log('PASS: duplicate order rejected (idempotency guard)');

  // 4. start dinarak payment -> should return payInstructions with our alias, no external call yet
  const fetchCountBeforePay = fetchCallCount;
  r = await fetch(`${base}/api/orders/${orderId}/pay/dinarak`, { method: 'POST' });
  const payBody = await r.json();
  assert(r.status === 200, `expected 200 starting payment, got ${r.status}: ${JSON.stringify(payBody)}`);
  assert(payBody.payInstructions && payBody.payInstructions.alias === 'TURKISHBAZAAR', 'payInstructions.alias mismatch');
  assert(payBody.payInstructions.amount === 15, 'payInstructions.amount mismatch');
  assert(fetchCallCount === fetchCountBeforePay, 'createPayment should NOT call Dinarak (no push endpoint exists)');
  console.log('PASS: POST /pay/dinarak returns payInstructions with no external call');

  // 5. first status poll: no matching transaction yet -> still PENDING_PAYMENT
  r = await fetch(`${base}/api/orders/${orderId}/status`);
  let statusBody = await r.json();
  assert(statusBody.status === 'PENDING_PAYMENT', `expected PENDING_PAYMENT, got ${statusBody.status}`);
  console.log('PASS: status poll #1 -> PENDING_PAYMENT (no match yet)');

  // 6. second status poll: throttled (< 5s) -> should NOT call Dinarak again yet, still PENDING
  const countBeforeThrottled = fetchCallCount;
  r = await fetch(`${base}/api/orders/${orderId}/status`);
  statusBody = await r.json();
  assert(fetchCallCount === countBeforeThrottled, 'expected reconcile to be throttled on immediate re-poll');
  assert(statusBody.status === 'PENDING_PAYMENT', 'expected still PENDING_PAYMENT while throttled');
  console.log('PASS: reconcile throttling works (no Dinarak call within 5s window)');

  // 7. wait past throttle window, poll again -> mocked fetch now returns a match -> PAID
  await new Promise((r2) => setTimeout(r2, 5200));
  r = await fetch(`${base}/api/orders/${orderId}/status`);
  statusBody = await r.json();
  assert(statusBody.status === 'PAID', `expected PAID after match, got ${statusBody.status}`);
  assert(statusBody.transactionReference === 'TX-REF-001', 'transactionReference mismatch');
  console.log('PASS: status poll after throttle window -> PAID with correct transactionReference');

  // 8. paying an already-PAID order should 409
  r = await fetch(`${base}/api/orders/${orderId}/pay/dinarak`, { method: 'POST' });
  assert(r.status === 409, `expected 409 paying an already-PAID order, got ${r.status}`);
  console.log('PASS: cannot re-pay a PAID order');

  // 9. order without a valid phone cannot pay via dinarak
  const orderId2 = 'TB-SMOKE-2';
  await fetch(`${base}/api/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: orderId2, amount: 5, currency: 'JOD', customer: { name: 'NoPhone', phone: 'not-a-phone', address: 'x' } }),
  });
  r = await fetch(`${base}/api/orders/${orderId2}/pay/dinarak`, { method: 'POST' });
  assert(r.status === 400, `expected 400 for invalid phone, got ${r.status}`);
  console.log('PASS: invalid phone rejected before attempting Dinarak payment');

  console.log('\nALL SMOKE TESTS PASSED');
  process.exit(0);
}

main().catch((e) => { console.error('SMOKE TEST FAILED:', e); process.exit(1); });
