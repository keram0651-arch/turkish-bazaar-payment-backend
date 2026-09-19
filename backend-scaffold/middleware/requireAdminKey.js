/**
 * Protects admin-only endpoints (order list, fulfillment updates) with a
 * single shared secret, since these expose customer PII (name/phone/
 * address). Not real auth (no per-user accounts, no expiry) — good enough
 * for one merchant checking their own admin panel, not a substitute for a
 * real login system if this ever grows past one person.
 *
 * Setup: set ADMIN_API_KEY in Render's Environment tab to any long random
 * string, then enter that same value in the admin panel when it asks for
 * it (Settings page, stored only in that browser's localStorage).
 */
function requireAdminKey(req, res, next) {
  if (!process.env.ADMIN_API_KEY) {
    return res.status(503).json({ error: 'admin_key_not_configured', message: 'ADMIN_API_KEY is not set on the server.' });
  }
  const provided = req.header('x-admin-key');
  if (!provided || provided !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

module.exports = requireAdminKey;
