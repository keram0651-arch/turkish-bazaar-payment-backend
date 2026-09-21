/**
 * Shared Postgres connection (works with Supabase's free Postgres, or any
 * standard Postgres connection string — Render's own Postgres, Neon, a
 * self-hosted instance, etc.).
 *
 * This exists because orders and push subscriptions must NOT only live in
 * this server's memory: a redeploy, a crash, or (on Render's free web
 * service plan) the server simply going to sleep after 15 minutes of no
 * traffic all wipe in-memory data. See README.md "Persistent storage
 * (Supabase)" for the 5-minute setup.
 */

const { Pool } = require('pg');

let pool = null;

function isConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!isConfigured()) {
    throw new Error(
      'DATABASE_URL is not set. Orders and push subscriptions require a real database — see .env.example / README.md "Persistent storage (Supabase)".'
    );
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Supabase (and most hosted Postgres) require SSL but use a
      // certificate chain Node doesn't automatically trust; a local
      // Postgres (e.g. `localhost` during development) doesn't use SSL.
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

/**
 * Creates the tables this app needs if they don't already exist. Safe to
 * call on every server startup (CREATE TABLE IF NOT EXISTS is a no-op once
 * the tables exist) — there is no separate "migration" step to remember.
 */
async function ensureSchema() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
      fulfillment_status TEXT NOT NULL DEFAULT 'new',
      payment_method TEXT,
      amount NUMERIC NOT NULL,
      currency TEXT NOT NULL DEFAULT 'JOD',
      customer JSONB NOT NULL,
      customer_phone TEXT,
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      transaction_reference TEXT,
      failure_reason TEXT,
      last_reconcile_check_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

module.exports = { getPool, ensureSchema, isConfigured };
