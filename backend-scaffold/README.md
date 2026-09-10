# Turkish Bazaar — Payment Backend Scaffold (Dinarak / CliQ)

## Why this exists
Your website is a single static HTML file. Real payment gateways (Dinarak
included) require a server component to:
- Keep the secret API key safe (never in the browser)
- Receive Dinarak's payment confirmation (webhook/callback)
- Verify that confirmation is authentic before marking an order PAID
- Prevent the same transaction being recorded twice

This folder is a **working skeleton** you (or a developer) can deploy on any
Node.js host (Render, Railway, a VPS, etc.). It implements the correct
*structure* — order states, idempotency, separation of secret vs public data —
but the actual calls to Dinarak are left as clearly marked placeholders,
because Dinarak has not published a public API. **Nothing here is invented.**
You must request the real integration package from Dinarak and fill in the
TODOs marked below.

## What you need from Dinarak before this goes live
See `WHAT_TO_ASK_DINARAK.md` in this folder — do not guess these values.

## Architecture — Payment Adapter pattern
`services/dinarakAdapter.js` is the **only** file in this codebase allowed to
know Dinarak's specific request/response shape. Routes never talk to
Dinarak directly — they call the adapter's methods:
- `createPayment(order)` — start a payment, return a redirect URL or QR image
- `verifyWebhookSignature(rawBody, headers)` — confirm a webhook really came from Dinarak
- `parseWebhookPayload(body)` — map Dinarak's real field names to our normalized shape

This means once you receive real credentials, you fill in **only this one
file** (plus `.env`) — `routes/`, `orders.js`, and the frontend never need to
change. It also means adding a second payment method later is just a second
adapter file with the same method shape.

## Order lifecycle implemented here
PENDING_PAYMENT → PAID
PENDING_PAYMENT → FAILED
PENDING_PAYMENT → EXPIRED (after a timeout, see orders.js)

A PAID or FAILED order can never be silently overwritten by a later event.
Verified directly with a small test script against `orders.js` covering:
order creation, marking paid, duplicate-transaction rejection (idempotency),
and refusing to "resurrect" an already-FAILED order.

## Setup
```
cd backend-scaffold
npm install
cp .env.example .env      # fill in values once Dinarak provides them
npm start
```

## Endpoints
- `POST /api/orders` — create a PENDING_PAYMENT order, returns orderId
- `POST /api/orders/:orderId/pay/dinarak` — starts the Dinarak payment (via the adapter)
- `POST /webhooks/dinarak` — receives Dinarak's payment result (via the adapter)
- `GET  /api/orders/:orderId/status` — the frontend polls this to know PAID/FAILED/PENDING

## Security notes
- `.env` (with real secrets) must NEVER be committed to git or sent to the frontend.
- The frontend only ever sees `orderId` and public status strings.
- Every write to "PAID" status goes through `markOrderPaid()` in `orders.js`,
  which checks `transactionReference` first so the same transaction can never
  be recorded twice (idempotency).
- The webhook route reads the **raw** request body (not pre-parsed JSON) so
  a real signature check can be performed on the exact bytes Dinarak sent.

## A note on this scaffold's storage
`orders.js` currently stores orders in memory (a JS Map) so the scaffold
runs with zero setup. This is wiped on every restart. Before accepting real
payments, swap it for a real database (Postgres, SQLite, etc.) — the
function signatures (`createOrder`, `getOrder`, `markOrderPaid`,
`markOrderFailed`) are designed to stay the same either way.
