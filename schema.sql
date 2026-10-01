-- Blackdot Publication: D1 schema
-- Run this once against your D1 database before first deploy:
--   wrangler d1 execute blackdot_db --remote --file=./schema.sql
-- or paste it into the D1 "Console" tab in the Cloudflare dashboard.
--
-- UPDATING AN EXISTING DEPLOYMENT (already had a books table before the
-- "multiple images" feature was added): run this ONE extra line once,
-- either via wrangler or the D1 Console. It's safe, it only adds a column
-- and does not touch any existing rows:
--   ALTER TABLE books ADD COLUMN images TEXT;

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,           -- format: pbkdf2$<saltHex>$<hashHex>
  role          TEXT NOT NULL CHECK(role IN ('main_admin','vendor')),
  name          TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS books (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  author      TEXT NOT NULL,
  description TEXT,
  cover_url   TEXT,
  images      TEXT,                      -- JSON array of up to 5 image URLs (gallery); images[0] mirrors cover_url
  price_paise INTEGER NOT NULL,          -- price in paise (₹1 = 100)
  available   INTEGER NOT NULL DEFAULT 1,
  featured    INTEGER NOT NULL DEFAULT 0,
  amazon_url  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id             INTEGER NOT NULL REFERENCES books(id),
  buyer_name          TEXT NOT NULL,
  buyer_email         TEXT,
  buyer_phone         TEXT,
  shipping_address    TEXT NOT NULL,
  quantity            INTEGER NOT NULL DEFAULT 1,
  amount_paise        INTEGER NOT NULL,
  razorpay_order_id   TEXT,
  razorpay_payment_id TEXT,
  payment_status      TEXT NOT NULL DEFAULT 'created',   -- created | paid | failed
  fulfillment_status  TEXT NOT NULL DEFAULT 'Received',  -- Received | Processing | Sent | Delivered
  assigned_vendor_id  INTEGER REFERENCES admins(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  message    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS manuscripts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  email               TEXT NOT NULL,
  phone               TEXT,
  genre               TEXT,
  book_title          TEXT,
  message             TEXT,
  manuscript_link     TEXT,
  attachment_filename TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed data: the featured title, so the public site has a real row from day one.
INSERT INTO books (title, author, description, cover_url, images, price_paise, available, featured)
VALUES (
  'Ishq Afsari',
  'Pratima Upadhyay',
  'A heartfelt Hindi literary work exploring the emotions of love, relationships, memories, and human experiences through expressive storytelling and poetic narration.',
  'https://res.cloudinary.com/dhn6pvsr1/image/upload/v1784984695/WhatsApp_Image_2026-07-17_at_11.35.52_AM_wjvpyk.jpg',
  '["https://res.cloudinary.com/dhn6pvsr1/image/upload/v1784984695/WhatsApp_Image_2026-07-17_at_11.35.52_AM_wjvpyk.jpg"]',
  19900,
  1,
  1
);

-- No admin accounts are seeded here on purpose (passwords must never live in
-- plaintext SQL). Create the first main_admin via POST /api/setup, see README.md.
