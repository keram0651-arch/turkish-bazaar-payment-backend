# Turkish Bazaar — Payment Backend Scaffold (Dinarak / CliQ)

## Why this exists
Your website is a single static HTML file. Real payment verification
requires a server component to:
- Keep any real credentials safe (never in the browser)
- Query Dinarak for incoming transfers and verify one against a pending order
- Prevent the same transaction being recorded twice
- Never trust a customer-typed transaction ID as proof of payment

This folder is a **working skeleton** you (or a developer) can deploy on any
Node.js host (Render, Railway, a VPS, etc.). **Nothing here is invented** —
see `WHAT_TO_ASK_DINARAK.md` for exactly what's still needed from Dinarak.

## Payment model: poll & reconcile (not redirect/webhook)
Based on the two API docs Dinarak has provided so far — **GetBusinessTransactions**
(query incoming transfers, Basic Auth) and **AliasResolve** (resolve a
phone/alias, Bearer auth) — there is no documented endpoint to push/request
a payment from a customer. So the flow implemented here is:

1. Customer fills the checkout form (name, phone, address). `POST /api/orders`
   creates a `PENDING_PAYMENT` order and normalizes the phone to Dinarak's
   `9627xxxxxxxx` shape.
2. `POST /api/orders/:orderId/pay/dinarak` makes **no external call** — it
   just returns our merchant alias + the exact amount, for the frontend to
   display as instructions.
3. The customer manually transfers that amount to our alias from their own
   banking app (CliQ).
4. `GET /api/orders/:orderId/status` — which the frontend already polls —
   also (throttled, at most once per 5s per order) asks
   `GetBusinessTransactions` whether a transfer from that customer's phone,
   for that exact amount, has arrived since the order was created. A match
   marks the order `PAID`. A background sweep in `server.js` does the same
   check every 20s as a safety net, independent of the frontend polling.

If Dinarak later confirms a real push/"create payment" endpoint, only
`services/dinarakAdapter.js` needs to change — routes, `orders.js`, and the
frontend all stay the same, by design (adapter pattern).

## Architecture — Payment Adapter pattern
`services/dinarakAdapter.js` is the **only** file in this codebase allowed to
know Dinarak's specific request/response shape. Routes never talk to
Dinarak directly — they call the adapter's methods:
- `createPayment(order)` — returns the alias + amount instructions to show the customer
- `reconcilePendingOrder(order)` — asks GetBusinessTransactions whether the customer's transfer has arrived
- `resolveAlias(aliasType, value)` — validates a phone/alias via AliasResolve (optional helper)
- `verifyWebhookSignature` / `parseWebhookPayload` — kept for a possible future webhook, currently unused

This means once you receive real credentials, you fill in **`.env`** (and,
only if Dinarak's real field names differ from what's assumed, this one
adapter file) — `routes/`, `orders.js`, and the frontend never need to
change. It also means adding a second payment method later is just a second
adapter file with the same method shape.

## Order lifecycle implemented here
PENDING_PAYMENT → PAID
PENDING_PAYMENT → FAILED
PENDING_PAYMENT → EXPIRED (after a timeout, see orders.js)

A PAID or FAILED order can never be silently overwritten by a later event.

## Setup
```
cd backend-scaffold
npm install
cp .env.example .env      # fill in values once Dinarak provides them
npm start
```

## Dev-only smoke test
`node test/smoke-test.js` runs the whole order → pay → reconcile → PAID
flow against a mocked Dinarak response (no real account needed) — useful to
confirm the server still behaves correctly after any change.

## Endpoints
- `POST /api/orders` — create a PENDING_PAYMENT order, returns orderId
- `POST /api/orders/:orderId/pay/dinarak` — returns `{ payInstructions: { alias, amount, currency, note } }`
- `GET  /api/orders/:orderId/status` — the frontend polls this; also triggers throttled reconciliation
- `POST /api/orders/resolve-phone` — optional: validate a phone via AliasResolve before checkout (`{ phone }` → `{ picCode, fullName, bankName }`)
- `POST /webhooks/dinarak` — kept for a possible future webhook; currently unreachable in practice (nothing calls it)

## Security notes
- `.env` (with real secrets) must NEVER be committed to git or sent to the frontend.
- The frontend only ever sees `orderId`, public status strings, and the
  merchant alias (which is meant to be public — customers transfer to it).
- Every write to "PAID" status goes through `markOrderPaid()` in `orders.js`,
  which checks `transactionReference` first so the same transaction can never
  be recorded twice (idempotency).
- Reconciliation matches strictly on the customer's own phone number +
  exact amount + a time window starting at order creation — never on a
  customer-typed transaction ID.

## A note on this scaffold's storage
`orders.js` currently stores orders in memory (a JS Map) so the scaffold
runs with zero setup. This is wiped on every restart. Before accepting real
payments, swap it for a real database (Postgres, SQLite, etc.) — the
function signatures (`createOrder`, `getOrder`, `markOrderPaid`,
`markOrderFailed`) are designed to stay the same either way.
