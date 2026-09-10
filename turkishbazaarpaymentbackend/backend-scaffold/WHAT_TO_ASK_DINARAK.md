# Exactly what to request from Dinarak (do not proceed without item 1 and 2)

We already have two of Dinarak's API docs: **GetBusinessTransactions** (query
incoming transfers, Basic Auth) and **AliasResolve** (resolve a phone/alias
to a name + bank, Bearer auth). Neither is a push/"request payment from a
customer" endpoint — based on what we have, the real flow is: the customer
manually transfers to our merchant alias via their own bank app, and we
detect it by polling GetBusinessTransactions. The two items below are what's
actually blocking — everything else is optional/nice-to-have.

## 1. Basic Auth credentials for GetBusinessTransactions — BLOCKING
- [ ] The doc says "Auth: Basic Authentication" but not whose username/
      password. Is this our merchant portal login? A separate API
      username/password issued for this endpoint specifically?
- [ ] Are these different between the staging (`apitest.dinarak.com`) and
      production (`api.dinarak.com`) environments?

## 2. How to obtain the Bearer token for AliasResolve — BLOCKING for that endpoint only
- [ ] The doc says "Auth: Bearer" but documents no login/token endpoint.
      Is there one? What do we call, with what credentials, to get a token?
- [ ] How long does the token last, and how do we refresh it?
- [ ] (This one only blocks the optional phone-validation helper — it does
      NOT block payments, which only need item 1.)

## 3. Confirm our reconciliation assumptions — important, not blocking
- [ ] In a GetBusinessTransactions transaction object, which of
      `originalAmount` / `totalAmount` is the amount that actually lands in
      our business account? (We're currently assuming `originalAmount` —
      i.e. the sender pays any Dinarak fee on top via `totalAmount`.)
- [ ] Is there any note/reference/description field a sender can attach to
      a CliQ transfer that would show up in GetBusinessTransactions? (The
      doc's example transaction object doesn't include one — if one exists,
      it would let us match orders exactly instead of by amount + phone +
      time window.)
- [ ] Our merchant alias (`DINARAK_MERCHANT_ALIAS` in `.env`) — confirm the
      exact string customers should see/type in their banking app.

## 4. Ask if a real push/"create payment" endpoint exists after all — optional
- [ ] Is there (now or planned) an endpoint to request/collect a payment
      from a customer directly (Request Money / Create Payment / P2P
      Transfer initiated by the merchant)? If so, request its full request/
      response shape — this would let us swap the poll & reconcile flow in
      `services/dinarakAdapter.js` for an instant one, with no changes
      needed anywhere else in the app (routes/orders.js/frontend stay the
      same, by design).
- [ ] If such an endpoint exists: what's the real webhook/notification
      mechanism for it, and how do we verify a webhook actually came from
      Dinarak (signature header, secret, checksum)?

## 5. Everything else, for completeness
- [ ] Applicable commission/fee per transaction, and settlement schedule.
- [ ] Any IP allowlisting requirement.
- [ ] Confirm JOD is supported (should be, for a Jordan-based CliQ account).
- [ ] Minimum/maximum transaction amount limits.
- [ ] Error code reference / list of failure reasons for both endpoints.

## Once you have items 1 and 2
Send me the answers (usernames/passwords go straight into `.env`, never
into this chat), and:
- Fill in `.env` in this backend folder with the real values.
- Nothing in the code needs to change for items 1–3 — only `.env`. Item 4,
  if it comes through, means rewriting `createPayment()` and
  `reconcilePendingOrder()` in `services/dinarakAdapter.js` — nothing else.

Do not accept "just send us a transaction ID and we'll trust it" as a
verification method from anyone — that is not how real payment verification
works, and it's exactly what this scaffold is built to avoid.
