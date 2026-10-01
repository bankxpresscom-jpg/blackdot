-- Blackdot Publication: D1 schema
-- ------------------------------------------------------------------
-- NEW DATABASE: paste this whole file into the D1 "Console" tab once
-- (or: wrangler d1 execute blackdot_db --remote --file=./schema.sql).
--
-- EXISTING DATABASE: you do NOT need to run anything. _worker.js checks the
-- schema on its first request after every deploy and creates any missing
-- tables (order_items, reviews, settings) and adds any missing columns to
-- books / orders automatically. Existing rows are never modified or deleted.
-- Do not re-run this file on an existing database: the INSERT at the bottom
-- would add a duplicate "Ishq Afsari" row.

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
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT NOT NULL,
  author            TEXT NOT NULL,
  description       TEXT,                -- "About the Book"
  cover_url         TEXT,                -- mirrors images[0]
  images            TEXT,                -- JSON array of up to 5 image URLs
  price_paise       INTEGER NOT NULL,    -- selling price in paise (₹1 = 100)
  available         INTEGER NOT NULL DEFAULT 1,   -- 0 = hidden from the store
  featured          INTEGER NOT NULL DEFAULT 0,
  amazon_url        TEXT,                -- legacy, unused by the storefront
  tagline           TEXT,                -- one-line hook under the title
  category          TEXT,                -- e.g. Fiction, Non-Fiction, Poetry
  language          TEXT,
  pages             INTEGER,
  isbn              TEXT,
  binding           TEXT,                -- e.g. Paperback, Hardcover
  published_on      TEXT,
  dimensions        TEXT,
  weight_grams      INTEGER,
  mrp_paise         INTEGER,             -- optional printed MRP, shown struck-through
  author_bio        TEXT,
  author_photo      TEXT,
  sample_url        TEXT,                -- "Look Inside" sample PDF / preview link
  ebook_url         TEXT,                -- optional external eBook store link
  ebook_price_paise INTEGER,
  coming_soon       INTEGER NOT NULL DEFAULT 0,
  in_stock          INTEGER NOT NULL DEFAULT 1,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id             INTEGER NOT NULL REFERENCES books(id),  -- first item (legacy single-book orders)
  buyer_name          TEXT NOT NULL,
  buyer_email         TEXT,
  buyer_phone         TEXT,
  shipping_address    TEXT NOT NULL,      -- full printable address
  address_line        TEXT,
  city                TEXT,
  state               TEXT,
  pincode             TEXT,
  quantity            INTEGER NOT NULL DEFAULT 1,   -- total copies across items
  subtotal_paise      INTEGER,
  shipping_paise      INTEGER NOT NULL DEFAULT 0,
  amount_paise        INTEGER NOT NULL,             -- grand total charged
  payment_method      TEXT,               -- preferred method picked at checkout
  razorpay_order_id   TEXT,
  razorpay_payment_id TEXT,
  payment_status      TEXT NOT NULL DEFAULT 'created',   -- created | paid | failed
  fulfillment_status  TEXT NOT NULL DEFAULT 'Received',  -- Received | Processing | Sent | Delivered
  assigned_vendor_id  INTEGER REFERENCES admins(id),
  invoice_no          TEXT,               -- assigned when payment is confirmed
  access_token        TEXT,               -- secret for the customer's tracking / invoice link
  courier_name        TEXT,
  tracking_number     TEXT,
  admin_notes         TEXT,
  paid_at             TEXT,
  dispatched_at       TEXT,
  delivered_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  book_id          INTEGER,
  title            TEXT NOT NULL,         -- snapshot at time of purchase
  author           TEXT,
  format           TEXT NOT NULL DEFAULT 'Paperback',
  hsn              TEXT NOT NULL DEFAULT '4901',
  unit_price_paise INTEGER NOT NULL,
  quantity         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  order_id   INTEGER,                     -- set when the review is a Verified Purchase
  name       TEXT NOT NULL,
  rating     INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  title      TEXT,
  body       TEXT NOT NULL,
  verified   INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | hidden
  reply      TEXT,                        -- public reply from Blackdot
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
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

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_reviews_book ON reviews(book_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_rzp ON orders(razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_vendor ON orders(assigned_vendor_id);

-- Seed data: the featured title, so the public site has a real row from day one.
INSERT INTO books (title, author, tagline, description, category, language, binding, cover_url, images, price_paise, available, featured)
VALUES (
  'Ishq Afsari',
  'Pratima Upadhyay',
  'A story of love, dreams and destiny.',
  'A heartfelt Hindi literary work exploring the emotions of love, relationships, memories, and human experiences through expressive storytelling and poetic narration.',
  'Fiction',
  'Hindi',
  'Paperback',
  'https://res.cloudinary.com/dhn6pvsr1/image/upload/v1784984695/WhatsApp_Image_2026-07-17_at_11.35.52_AM_wjvpyk.jpg',
  '["https://res.cloudinary.com/dhn6pvsr1/image/upload/v1784984695/WhatsApp_Image_2026-07-17_at_11.35.52_AM_wjvpyk.jpg"]',
  19900,
  1,
  1
);

-- No admin accounts are seeded here on purpose (passwords must never live in
-- plaintext SQL). Create the first main_admin at /setup, see README.md.
