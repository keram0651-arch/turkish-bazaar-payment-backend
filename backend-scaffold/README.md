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
- `GET   /api/orders` — **admin only** (requires `X-Admin-Key` header, see below): list every order, most recent first
- `PATCH /api/orders/:orderId/fulfillment` — **admin only**: update an order's fulfillment status (`new` → `confirmed` → `preparing` → `ready` → `outfordelivery` → `completed`, or `cancelled`)
- `GET   /api/push/public-key` — public: the VAPID public key the admin panel subscribes with
- `POST  /api/push/subscribe` — **admin only**: register this device/browser to receive order push notifications
- `POST  /api/push/unsubscribe` — **admin only**: stop sending push notifications to a given subscription
- `GET   /admin.html` — the admin panel itself, served statically so it can use Web Push (see below)

## Admin panel (turkish-bazaar-admin.html)
The admin panel is a separate static HTML file (not part of this backend's deploy) that reads orders from `GET /api/orders` and updates them via `PATCH /api/orders/:orderId/fulfillment`. Both endpoints require the `X-Admin-Key` header to match `ADMIN_API_KEY` (see `.env.example`) — set that env var on Render, then enter the same value into the admin panel once (Settings page); it's stored in that browser's `localStorage`, not sent anywhere else.

The admin panel currently only has real data for **Orders** (and the dashboard/customer/sales numbers computed from orders). Products/Categories still show the storefront's static catalog as a read-only reference — there is no product database yet, so editing them there doesn't change the live site.

## Automatic WhatsApp order notifications (CallMeBot)
The moment a customer places a cash-on-delivery order (`POST /api/orders`), the server tries to send you a WhatsApp message with the order details — no action needed from the customer. This uses **CallMeBot**, a free third-party service (not run by WhatsApp/Meta) that controls a bot account to message your own phone. It is unofficial/unsupported, so it can be rate-limited or stop working without notice — fine for one merchant's own notifications, not something to depend on for anything critical. The order itself is always safely recorded regardless of whether this message goes through (see the admin panel above).

One-time setup (~2 minutes):
1. On the phone that should get the notifications, save this as a contact: **+34 644 51 95 23**.
2. From WhatsApp on that phone, message that contact exactly: `I allow callmebot to send me messages`
3. Their bot replies with your personal API key (a number).
4. In Render's Environment tab, set `CALLMEBOT_PHONE` (your own number, international format, digits only — e.g. `962790101517`) and `CALLMEBOT_APIKEY` (the number from step 3).

If you'd rather have a fully official, more robust channel later (at the cost of a Meta Business verification + approved message templates), or an equally simple but officially-supported alternative (a Telegram bot, which has no approval step at all), those are one-file swaps in `services/` — ask for it when you're ready.

## Automatic email order notifications (Gmail)
A second, independent notification channel: the same new-order trigger also emails you via your own Gmail account (`services/emailNotifier.js`), using Gmail's normal SMTP servers via the `nodemailer` package — not a third-party service like CallMeBot. This one is fully Google-official; the only "workaround" is that Gmail requires an **App Password** instead of your normal password for this kind of use. It doubles nicely as a phone push notification if you have the Gmail app installed. WhatsApp and email are independent — either can fail without affecting the other, and the order is always recorded either way.

One-time setup (~3 minutes):
1. On the Google account that should send these emails, turn on 2-Step Verification: https://myaccount.google.com/security
2. Create an App Password at https://myaccount.google.com/apppasswords (name it e.g. "Turkish Bazaar orders"). Google gives you a 16-character password — copy it.
3. In Render's Environment tab, set `GMAIL_USER` (the sending Gmail address), `GMAIL_APP_PASSWORD` (the 16-character password from step 2), and optionally `NOTIFY_EMAIL_TO` if you want the notification to land in a different inbox than the one sending it (defaults to `GMAIL_USER`).

## Web Push notifications (real notification FROM the admin panel)
This is the primary, recommended notification channel: the moment a new order
is created, the **admin panel itself** sends you a real system notification
(same mechanism as Gmail, news apps, etc. — no third-party account, no
Meta/WhatsApp) — banner, lock screen, whatever your OS/browser normally
does — and **tapping it opens the admin panel straight to that order**. This
is different from WhatsApp/email above: those are messages sent to you
outside the app; this is the app notifying you directly.

How it works: `public/admin.html` (served by this same backend) registers a
service worker (`public/push-sw.js`) and, once you tap "Enable notifications"
in Settings, subscribes to push and stores that subscription on the server
(`services/pushNotifier.js`). On every new order, the server pushes to every
stored subscription via the `web-push` library.

**Important — this only works when the admin panel is opened over HTTPS from
this backend's own URL**, e.g. `https://turkish-bazaar-payment-backend.onrender.com/admin.html`
— not the `turkish-bazaar-admin.html` file you download and open locally.
Browsers refuse to grant push permission to a page opened as a local file.
Bookmark that link (or "Add to Home Screen" on your phone) and use it from
there.

One-time setup:
1. `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` are already filled
   in `.env.example` with a ready-to-use generated key pair — copy those same
   three values into Render's Environment tab (no account/signup needed,
   these aren't tied to any service).
2. Redeploy. The startup log should stop showing the "VAPID... not set"
   warning.
3. Open `https://<your-service>.onrender.com/admin.html`, connect with your
   admin key as usual, go to **Settings → Order Notifications**, and tap
   **"Enable notifications"**. Your browser will ask permission once — allow
   it.
4. Place a test order from the storefront — a notification should appear
   within a few seconds. Tap it to confirm it opens the admin panel on that
   order.

Notes:
- Each device/browser you enable this on gets its own subscription, stored
  in memory (wiped on server restart — same tradeoff as orders, re-enabling
  takes one tap).
- On iPhone/iPad, Safari only supports this after you "Add to Home Screen"
  from `admin.html` and open it from that home-screen icon (Safari 16.4+);
  opening it as a normal browser tab won't show push notifications on iOS.
  Android Chrome and desktop browsers work directly, no extra step.
- If a subscription goes stale (browser data cleared, uninstalled, etc.) the
  server automatically stops sending to it once it gets a 404/410 back —
  nothing to clean up manually.

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
