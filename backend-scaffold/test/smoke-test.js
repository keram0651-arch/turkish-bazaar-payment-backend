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
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.CALLMEBOT_PHONE = '962790000099';
process.env.CALLMEBOT_APIKEY = 'test-callmebot-key';
process.env.GMAIL_USER = 'test@example.com';
process.env.GMAIL_APP_PASSWORD = 'test-app-password';
process.env.VAPID_PUBLIC_KEY = 'test-vapid-public-key';
process.env.VAPID_PRIVATE_KEY = 'test-vapid-private-key';
process.env.VAPID_SUBJECT = 'mailto:test@example.com';

// Mock nodemailer BEFORE anything requires services/emailNotifier.js, so no
// real SMTP connection is ever attempted in this test.
let sentEmails = [];
const nodemailerPath = require.resolve('nodemailer');
require.cache[nodemailerPath] = {
  id: nodemailerPath,
  filename: nodemailerPath,
  loaded: true,
  exports: {
    createTransport: () => ({
      sendMail: async (opts) => { sentEmails.push(opts); return { messageId: 'mock-id' }; },
    }),
  },
};

// Mock web-push BEFORE anything requires services/pushNotifier.js, so no
// real push service (Google/Mozilla/etc.) is ever contacted in this test.
let webPushSends = [];
const webPushPath = require.resolve('web-push');
require.cache[webPushPath] = {
  id: webPushPath,
  filename: webPushPath,
  loaded: true,
  exports: {
    setVapidDetails: () => {},
    sendNotification: async (subscription, payload) => {
      webPushSends.push({ subscription, payload });
      return { statusCode: 201 };
    },
  },
};

let fetchCallCount = 0;
let callMeBotCalls = [];
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
  if (String(url).includes('api.callmebot.com')) {
    callMeBotCalls.push(String(url));
    return { ok: true, status: 200, text: async () => 'Message queued' };
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

  // 10. admin: cash-on-delivery order via POST /api/orders (paymentMethod: 'cod')
  const orderId3 = 'TB-SMOKE-3';
  r = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: orderId3, amount: 22, currency: 'JOD', customer: { name: 'Cod Customer', phone: '079 000 0002', address: 'Amman, Jordan' }, items: [{ nameEn: 'Baklava', qty: 1, price: 22 }], paymentMethod: 'cod' }),
  });
  assert(r.status === 201, `expected 201 creating COD order, got ${r.status}`);
  console.log('PASS: POST /api/orders with paymentMethod=cod');

  // 10b. WhatsApp notification (CallMeBot) fired for that order, fire-and-forget.
  // Every order creation triggers one (not just COD ones) — earlier orders
  // in this test (TB-SMOKE-1, TB-SMOKE-2) already added their own calls, so
  // find the one for this specific order rather than asserting a total count.
  await new Promise((r2) => setTimeout(r2, 200));
  const decodeQuery = (u) => decodeURIComponent(u.replace(/\+/g, ' ')); // URLSearchParams encodes spaces as '+'
  const codNotifyCall = callMeBotCalls.find((u) => decodeQuery(u).includes(orderId3));
  assert(codNotifyCall, `expected a CallMeBot call for ${orderId3}, got calls: ${JSON.stringify(callMeBotCalls)}`);
  assert(codNotifyCall.includes('phone=962790000099'), 'CallMeBot call missing correct phone');
  assert(codNotifyCall.includes('apikey=test-callmebot-key'), 'CallMeBot call missing correct apikey');
  assert(decodeQuery(codNotifyCall).includes('Cod Customer'), 'CallMeBot message missing customer name');
  console.log('PASS: CallMeBot WhatsApp notification sent automatically on order creation');

  // 10c. Email notification (Gmail via nodemailer, mocked) fired for that order
  const codEmail = sentEmails.find((m) => m.subject.includes(orderId3));
  assert(codEmail, `expected an email for ${orderId3}, got subjects: ${JSON.stringify(sentEmails.map((m) => m.subject))}`);
  assert(codEmail.to === 'test@example.com', `expected email to test@example.com, got ${codEmail.to}`);
  assert(codEmail.text.includes('Cod Customer'), 'email body missing customer name');
  assert(codEmail.text.includes('Amman, Jordan'), 'email body missing address');
  console.log('PASS: Email notification (Gmail) sent automatically on order creation');

  // 11. admin: GET /api/orders requires the admin key
  r = await fetch(`${base}/api/orders`);
  assert(r.status === 401, `expected 401 with no admin key, got ${r.status}`);
  r = await fetch(`${base}/api/orders`, { headers: { 'X-Admin-Key': 'wrong-key' } });
  assert(r.status === 401, `expected 401 with wrong admin key, got ${r.status}`);
  r = await fetch(`${base}/api/orders`, { headers: { 'X-Admin-Key': 'test-admin-key' } });
  assert(r.status === 200, `expected 200 with correct admin key, got ${r.status}`);
  let listBody = await r.json();
  let codOrder = listBody.orders.find((o) => o.orderId === orderId3);
  assert(codOrder, 'COD order missing from GET /api/orders list');
  assert(codOrder.customer.name === 'Cod Customer', 'customer name missing/wrong in admin order list');
  assert(codOrder.fulfillmentStatus === 'new', `expected fulfillmentStatus 'new', got ${codOrder.fulfillmentStatus}`);
  console.log('PASS: GET /api/orders (admin-key gated) returns the COD order with customer info');

  // 12. admin: PATCH fulfillment status
  r = await fetch(`${base}/api/orders/${orderId3}/fulfillment`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'test-admin-key' },
    body: JSON.stringify({ status: 'bogus-status' }),
  });
  assert(r.status === 400, `expected 400 for invalid fulfillment status, got ${r.status}`);
  r = await fetch(`${base}/api/orders/${orderId3}/fulfillment`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'test-admin-key' },
    body: JSON.stringify({ status: 'confirmed' }),
  });
  assert(r.status === 200, `expected 200 updating fulfillment status, got ${r.status}`);
  r = await fetch(`${base}/api/orders`, { headers: { 'X-Admin-Key': 'test-admin-key' } });
  listBody = await r.json();
  codOrder = listBody.orders.find((o) => o.orderId === orderId3);
  assert(codOrder.fulfillmentStatus === 'confirmed', `expected fulfillmentStatus 'confirmed', got ${codOrder.fulfillmentStatus}`);
  console.log('PASS: PATCH /api/orders/:orderId/fulfillment updates status (rejects invalid ones)');

  // 13. push: public key is public (no admin key needed)
  r = await fetch(`${base}/api/push/public-key`);
  assert(r.status === 200, `expected 200 fetching push public key, got ${r.status}`);
  let pubKeyBody = await r.json();
  assert(pubKeyBody.publicKey === 'test-vapid-public-key', 'public-key endpoint returned wrong key');
  console.log('PASS: GET /api/push/public-key (public)');

  // 14. push: subscribe requires admin key
  const fakeSubscription = { endpoint: 'https://fcm.googleapis.com/fake/endpoint-1', keys: { p256dh: 'x', auth: 'y' } };
  r = await fetch(`${base}/api/push/subscribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: fakeSubscription }),
  });
  assert(r.status === 401, `expected 401 subscribing without admin key, got ${r.status}`);
  console.log('PASS: POST /api/push/subscribe rejects missing admin key');

  // 15. push: subscribe with admin key succeeds
  r = await fetch(`${base}/api/push/subscribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'test-admin-key' },
    body: JSON.stringify({ subscription: fakeSubscription }),
  });
  assert(r.status === 201, `expected 201 subscribing to push, got ${r.status}`);
  console.log('PASS: POST /api/push/subscribe (admin-key gated) registers a subscription');

  // 16. push: a new order triggers a real push send to the stored subscription
  const orderId4 = 'TB-SMOKE-4';
  r = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: orderId4, amount: 9.5, currency: 'JOD', customer: { name: 'Push Customer', phone: '079 000 0003', address: 'Irbid' }, items: [], paymentMethod: 'cod' }),
  });
  assert(r.status === 201, `expected 201 creating order for push test, got ${r.status}`);
  await new Promise((r2) => setTimeout(r2, 200));
  const pushSend = webPushSends.find((s) => JSON.parse(s.payload).orderId === orderId4);
  assert(pushSend, `expected a web-push send for ${orderId4}, got sends: ${JSON.stringify(webPushSends.map((s) => s.payload))}`);
  assert(pushSend.subscription.endpoint === fakeSubscription.endpoint, 'push sent to wrong subscription endpoint');
  const pushPayload = JSON.parse(pushSend.payload);
  assert(pushPayload.title.includes(orderId4), 'push notification title missing order id');
  assert(pushPayload.body.includes('Push Customer'), 'push notification body missing customer name');
  console.log('PASS: real push notification (web-push) sent automatically on order creation');

  // 17. push: unsubscribe requires admin key, then removes it
  r = await fetch(`${base}/api/push/unsubscribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: fakeSubscription.endpoint }),
  });
  assert(r.status === 401, `expected 401 unsubscribing without admin key, got ${r.status}`);
  r = await fetch(`${base}/api/push/unsubscribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'test-admin-key' },
    body: JSON.stringify({ endpoint: fakeSubscription.endpoint }),
  });
  assert(r.status === 200, `expected 200 unsubscribing from push, got ${r.status}`);
  const sendsBeforeUnsub = webPushSends.length;
  const orderId5 = 'TB-SMOKE-5';
  await fetch(`${base}/api/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: orderId5, amount: 4, currency: 'JOD', customer: { name: 'After Unsub', phone: '079 000 0004' }, items: [], paymentMethod: 'cod' }),
  });
  await new Promise((r2) => setTimeout(r2, 200));
  assert(webPushSends.length === sendsBeforeUnsub, 'expected no push sent after unsubscribing (no subscriptions left)');
  console.log('PASS: POST /api/push/unsubscribe (admin-key gated) stops further pushes');

  console.log('\nALL SMOKE TESTS PASSED');
  process.exit(0);
}

main().catch((e) => { console.error('SMOKE TEST FAILED:', e); process.exit(1); });
