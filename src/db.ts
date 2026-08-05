import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_telegram_id BIGINT NOT NULL,
      customer_name TEXT,
      customer_phone TEXT,
      order_type TEXT NOT NULL CHECK (order_type IN ('delivery', 'pickup')),
      delivery_address TEXT,
      total_amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_payment',
      payment_screenshot_file_id TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      item_price INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS menu_availability (
      item_id TEXT PRIMARY KEY,
      available BOOLEAN NOT NULL DEFAULT true
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS menu_price_overrides (
      item_id TEXT PRIMARY KEY,
      price INTEGER NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS marquee (
      id INTEGER PRIMARY KEY DEFAULT 1,
      message TEXT NOT NULL DEFAULT '',
      expires_at TIMESTAMP
    );
  `);

  console.log("Database initialized.");
}
