# Exactly what to request from Dinarak (do not proceed without these)

Contact Dinarak's business/merchant team directly (dinarak.com) and request
onboarding as an **online e-commerce merchant** for CliQ acceptance. Ask
specifically for:

## 1. Merchant onboarding
- [ ] Merchant application requirements (business license/registration, tax
      number, business bank account)
- [ ] Applicable commission/fee per transaction
- [ ] Settlement schedule (when money actually reaches your bank account)

## 2. Technical integration package (the actual "API documentation")
- [ ] API base URL — both **sandbox/test** and **production**
- [ ] Authentication method: API key? HMAC request signing? OAuth? — and the
      exact header/field names they expect
- [ ] The exact endpoint + request format to **create a CliQ payment request**
      (what fields are required: amount, currency, order reference, customer
      phone/alias, description, etc.)
- [ ] Whether they return a **QR code image/string** to display, or a
      **redirect URL** to send the customer to, or both
- [ ] The exact endpoint (or webhook) they use to **notify you when payment
      succeeds or fails** — request a sample payload
- [ ] How to **verify that a webhook really came from Dinarak** (signature
      header, secret, checksum — whatever mechanism they use)
- [ ] Whether there's also a **"check status" endpoint** you can poll as a
      backup to the webhook
- [ ] Required **Return/Redirect URL** format after the customer finishes
      paying (if it's a hosted payment page)
- [ ] **Sandbox/test credentials** and at least one test scenario for a
      successful and a failed payment
- [ ] Any **IP allowlisting** requirement for your webhook endpoint
- [ ] Supported currency — confirm **JOD** is supported for this flow
- [ ] Any minimum/maximum transaction amount limits
- [ ] Idempotency guidance — do they provide their own transaction ID you
      should store, and can you safely retry a request?
- [ ] Error code reference / list of failure reasons

## 3. Once you have these
Send me (or your developer) the documentation PDF/link they give you, and:
- Fill in `.env` in this backend folder with the real values
- Replace the three `// TODO: DINARAK INTEGRATION` blocks in `routes/`
  with the real calls, exactly as documented — nothing will be guessed.

Do not accept "just send us a transaction ID and we'll trust it" as a
verification method from anyone — that is not how real payment verification
works, and it's exactly what this scaffold is built to avoid.
