/**
 * Blackdot Publication: single-file Cloudflare Pages Worker
 * ------------------------------------------------------------
 * Handles every /api/* route below, renders /books/<id>-<slug> book pages
 * (with SEO tags injected server-side), builds /sitemap.xml from the books
 * table, then falls through to env.ASSETS.fetch() for everything else.
 *
 * Bindings this Worker expects (set in Pages → Settings):
 *   D1 database   : DB                (binding name must be exactly "DB")
 *   Email binding : EMAIL             (Cloudflare Email Service send binding,
 *                                      used for manuscripts + order emails)
 *   Env variable  : SEND_FROM_EMAIL   (a verified sender on your onboarded
 *                                      domain, e.g. no-reply@blackdotpublication.com)
 *   Env variable  : RAZORPAY_KEY_ID
 *   Secret        : RAZORPAY_KEY_SECRET
 *   Secret        : RAZORPAY_WEBHOOK_SECRET (optional, enables /api/razorpay/webhook)
 *   Secret        : SESSION_SECRET    (any long random string, used to
 *                                      pepper password hashes)
 *   Secret        : SETUP_TOKEN       (permanent token you choose, used to
 *                                      bootstrap the first main_admin and to
 *                                      reset any password later, see README)
 *
 * The database schema is created / upgraded automatically on the first
 * request after a deploy (see ensureSchema), so new columns and tables never
 * need to be pasted into the D1 console by hand.
 *
 * No npm dependencies. Pure Web Crypto + D1 + Cloudflare Email Service.
 */

const SESSION_COOKIE = "bd_session";
const SESSION_DAYS = 7;
const SITE_URL = "https://blackdotpublication.com";
const NOTIFY_EMAIL = "info@blackdotpublication.com";
const STAGES = ["Received", "Processing", "Sent", "Delivered"];
const MAX_QTY_PER_LINE = 10;
const MAX_LINES = 20;

const INDIAN_STATES = [
  "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh",
  "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana",
  "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep",
  "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry",
  "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand",
  "West Bengal",
];

// Store-wide settings, editable from Main Admin → Settings. These are the
// defaults used until a value is saved. Keys marked public are exposed to the
// storefront through /api/store-config.
const DEFAULT_SETTINGS = {
  business_name: "Blackdot Publication",
  business_address: "",
  business_gstin: "",
  business_pan: "",
  business_email: "info@blackdotpublication.com",
  business_phone: "+91 77425 88678",
  invoice_prefix: "BD",
  invoice_footer: "Thank you for reading with Blackdot Publication. Every story leaves a mark.",
  shipping_flat_paise: "0",
  free_shipping_above_paise: "0",
  delivery_min_days: "5",
  delivery_max_days: "10",
  review_auto_approve_verified: "1",
};
const PUBLIC_SETTING_KEYS = [
  "business_name", "business_email", "business_phone",
  "shipping_flat_paise", "free_shipping_above_paise", "delivery_min_days", "delivery_max_days",
];
const INVOICE_SETTING_KEYS = [
  "business_name", "business_address", "business_gstin", "business_pan",
  "business_email", "business_phone", "invoice_footer",
];

// ---------------------------------------------------------------- utilities

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function badRequest(msg) { return json({ error: msg }, 400); }
function unauthorized(msg = "Unauthorized") { return json({ error: msg }, 401); }
function forbidden(msg = "Forbidden") { return json({ error: msg }, 403); }
function notFound(msg = "Not found") { return json({ error: msg }, 404); }

function str(v, max = 500) {
  return v == null ? "" : String(v).trim().slice(0, max);
}
function toInt(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Up to 5 image URLs per book (gallery). Trims, drops blanks, caps at 5.
function sanitizeImages(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((u) => (typeof u === "string" ? u.trim() : ""))
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 5);
}
// The `images` column is stored as a JSON string; parse it back into an
// array for API responses, falling back to [cover_url] for older rows.
function parseImages(row) {
  if (row.images) {
    try {
      const arr = JSON.parse(row.images);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (e) { /* fall through to cover_url fallback below */ }
  }
  return row.cover_url ? [row.cover_url] : [];
}

function slugify(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
function bookPath(book) {
  const slug = slugify(book.title);
  return `/books/${book.id}${slug ? "-" + slug : ""}`;
}

// Public shape of a book row. Ratings come from the reviews aggregate join.
function publicBook(row) {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    tagline: row.tagline || "",
    description: row.description || "",
    author_bio: row.author_bio || "",
    author_photo: row.author_photo || "",
    category: row.category || "",
    language: row.language || "",
    pages: row.pages || null,
    isbn: row.isbn || "",
    binding: row.binding || "Paperback",
    published_on: row.published_on || "",
    dimensions: row.dimensions || "",
    weight_grams: row.weight_grams || null,
    cover_url: row.cover_url || "",
    images: parseImages(row),
    price_paise: row.price_paise,
    mrp_paise: row.mrp_paise && row.mrp_paise > row.price_paise ? row.mrp_paise : null,
    ebook_url: row.ebook_url || "",
    ebook_price_paise: row.ebook_price_paise || null,
    sample_url: row.sample_url || "",
    available: row.available ? 1 : 0,
    featured: row.featured ? 1 : 0,
    coming_soon: row.coming_soon ? 1 : 0,
    in_stock: row.in_stock == null ? 1 : (row.in_stock ? 1 : 0),
    rating_avg: row.rating_avg ? Math.round(row.rating_avg * 10) / 10 : 0,
    rating_count: row.rating_count || 0,
    url: bookPath(row),
  };
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBuf(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr.buffer;
}
function randomHex(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bufToHex(arr.buffer);
}

async function pbkdf2(password, saltHex, pepper) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password + (pepper || "")), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBuf(saltHex), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bufToHex(bits);
}

async function hashPassword(password, pepper) {
  const saltHex = randomHex(16);
  const hashHex = await pbkdf2(password, saltHex, pepper);
  return `pbkdf2$${saltHex}$${hashHex}`;
}

async function verifyPassword(password, stored, pepper) {
  if (!stored || !stored.startsWith("pbkdf2$")) return false;
  const [, saltHex, hashHex] = stored.split("$");
  const check = await pbkdf2(password, saltHex, pepper);
  return timingSafeEqual(check, hashHex);
}

function timingSafeEqual(a, b) {
  a = String(a == null ? "" : a);
  b = String(b == null ? "" : b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  });
  return out;
}

function setCookieHeader(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
function clearCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function getSessionAdmin(request, env) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.token, s.expires_at, a.id, a.username, a.role, a.name, a.active
     FROM sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token = ?`
  ).bind(token).first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  if (!row.active) return null;
  return { id: row.id, username: row.username, role: row.role, name: row.name, token };
}

async function requireRole(request, env, roles) {
  const admin = await getSessionAdmin(request, env);
  if (!admin) return { error: unauthorized() };
  if (roles && !roles.includes(admin.role)) return { error: forbidden() };
  return { admin };
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function rupees(paise) {
  return "₹" + (Number(paise || 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

// Indian mobile numbers: accepts "+91 98765 43210", "09876543210", "9876543210".
function normalizePhone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}
function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || ""));
}

// Financial year label for invoice numbers, e.g. "2026-27" (IST, April-March).
function financialYear(date = new Date()) {
  const ist = new Date(date.getTime() + 5.5 * 3600 * 1000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

// ------------------------------------------------------------- schema

// Every table and every column the app needs. ensureSchema() creates missing
// tables and adds missing columns on the first request of each Worker
// instance, so older databases upgrade themselves after a redeploy.
const TABLES = [
  `CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('main_admin','vendor')),
    name TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    description TEXT,
    cover_url TEXT,
    images TEXT,
    price_paise INTEGER NOT NULL,
    available INTEGER NOT NULL DEFAULT 1,
    featured INTEGER NOT NULL DEFAULT 0,
    amazon_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id),
    buyer_name TEXT NOT NULL,
    buyer_email TEXT,
    buyer_phone TEXT,
    shipping_address TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    amount_paise INTEGER NOT NULL,
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    payment_status TEXT NOT NULL DEFAULT 'created',
    fulfillment_status TEXT NOT NULL DEFAULT 'Received',
    assigned_vendor_id INTEGER REFERENCES admins(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    book_id INTEGER,
    title TEXT NOT NULL,
    author TEXT,
    format TEXT NOT NULL DEFAULT 'Paperback',
    hsn TEXT NOT NULL DEFAULT '4901',
    unit_price_paise INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    order_id INTEGER,
    name TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    title TEXT,
    body TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    reply TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS manuscripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    genre TEXT,
    book_title TEXT,
    message TEXT,
    manuscript_link TEXT,
    attachment_filename TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

const COLUMNS = {
  books: {
    images: "TEXT",
    tagline: "TEXT",
    category: "TEXT",
    language: "TEXT",
    pages: "INTEGER",
    isbn: "TEXT",
    binding: "TEXT",
    published_on: "TEXT",
    dimensions: "TEXT",
    weight_grams: "INTEGER",
    mrp_paise: "INTEGER",
    author_bio: "TEXT",
    author_photo: "TEXT",
    sample_url: "TEXT",
    ebook_url: "TEXT",
    ebook_price_paise: "INTEGER",
    coming_soon: "INTEGER NOT NULL DEFAULT 0",
    in_stock: "INTEGER NOT NULL DEFAULT 1",
    sort_order: "INTEGER NOT NULL DEFAULT 0",
  },
  orders: {
    city: "TEXT",
    state: "TEXT",
    pincode: "TEXT",
    address_line: "TEXT",
    subtotal_paise: "INTEGER",
    shipping_paise: "INTEGER NOT NULL DEFAULT 0",
    payment_method: "TEXT",
    invoice_no: "TEXT",
    access_token: "TEXT",
    courier_name: "TEXT",
    tracking_number: "TEXT",
    admin_notes: "TEXT",
    paid_at: "TEXT",
    dispatched_at: "TEXT",
    delivered_at: "TEXT",
  },
};

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_book ON reviews(book_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_rzp ON orders(razorpay_order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_vendor ON orders(assigned_vendor_id)`,
];

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = migrate(env).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}
async function migrate(env) {
  await env.DB.batch(TABLES.map((sql) => env.DB.prepare(sql)));
  for (const [table, cols] of Object.entries(COLUMNS)) {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const have = new Set(results.map((r) => r.name));
    const missing = Object.entries(cols).filter(([name]) => !have.has(name));
    for (const [name, type] of missing) {
      try {
        await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
      } catch (e) {
        // Another instance may have added it at the same moment.
        if (!/duplicate column/i.test(String(e && e.message))) throw e;
      }
    }
  }
  await env.DB.batch(INDEXES.map((sql) => env.DB.prepare(sql)));
}

async function getSettings(env) {
  const out = { ...DEFAULT_SETTINGS };
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
  for (const r of results) if (r.key in out && r.value != null) out[r.key] = r.value;
  return out;
}
function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}
function shippingFor(subtotal, settings) {
  const flat = toInt(settings.shipping_flat_paise, 0);
  const freeAbove = toInt(settings.free_shipping_above_paise, 0);
  if (flat <= 0) return 0;
  if (freeAbove > 0 && subtotal >= freeAbove) return 0;
  return flat;
}

// ------------------------------------------------------------- books

const BOOK_SELECT = `
  SELECT b.*, r.rating_avg, r.rating_count
  FROM books b
  LEFT JOIN (
    SELECT book_id, AVG(rating) AS rating_avg, COUNT(*) AS rating_count
    FROM reviews WHERE status = 'approved' GROUP BY book_id
  ) r ON r.book_id = b.id`;

async function loadBook(env, id) {
  const row = await env.DB.prepare(`${BOOK_SELECT} WHERE b.id = ? AND b.available = 1`).bind(id).first();
  return row ? publicBook(row) : null;
}

function bookFieldsFromBody(b) {
  const images = sanitizeImages(b.images);
  const optInt = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    images,
    values: {
      title: str(b.title, 200),
      author: str(b.author, 200),
      description: str(b.description, 8000),
      tagline: str(b.tagline, 200),
      category: str(b.category, 60),
      language: str(b.language, 60),
      pages: optInt(b.pages),
      isbn: str(b.isbn, 40),
      binding: str(b.binding, 40) || "Paperback",
      published_on: str(b.published_on, 40),
      dimensions: str(b.dimensions, 80),
      weight_grams: optInt(b.weight_grams),
      mrp_paise: optInt(b.mrp_paise),
      author_bio: str(b.author_bio, 4000),
      author_photo: /^https?:\/\//i.test(str(b.author_photo, 600)) ? str(b.author_photo, 600) : "",
      sample_url: /^https?:\/\//i.test(str(b.sample_url, 600)) ? str(b.sample_url, 600) : "",
      ebook_url: /^https?:\/\//i.test(str(b.ebook_url, 600)) ? str(b.ebook_url, 600) : "",
      ebook_price_paise: optInt(b.ebook_price_paise),
      price_paise: toInt(b.price_paise, 0),
      available: b.available ? 1 : 0,
      featured: b.featured ? 1 : 0,
      coming_soon: b.coming_soon ? 1 : 0,
      in_stock: b.in_stock === undefined ? 1 : (b.in_stock ? 1 : 0),
      sort_order: toInt(b.sort_order, 0),
      cover_url: images[0] || "",
      images: JSON.stringify(images),
    },
  };
}

// ------------------------------------------------------------- orders

// Line items for a set of orders. Orders placed before the cart existed have
// no order_items rows; for those a single line is rebuilt from the order.
async function attachItems(env, orders) {
  if (!orders.length) return orders;
  const ids = orders.map((o) => o.id);
  const byOrder = new Map();
  // D1 caps bound parameters per statement, so query in chunks.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT * FROM order_items WHERE order_id IN (${chunk.map(() => "?").join(",")}) ORDER BY id`
    ).bind(...chunk).all();
    for (const it of results) {
      if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
      byOrder.get(it.order_id).push(it);
    }
  }
  for (const o of orders) {
    let items = byOrder.get(o.id);
    if (!items || !items.length) {
      const qty = o.quantity || 1;
      const ship = o.shipping_paise || 0;
      items = [{
        book_id: o.book_id,
        title: o.book_title || "Book",
        author: o.book_author || "",
        format: "Paperback",
        hsn: "4901",
        quantity: qty,
        unit_price_paise: Math.round((o.amount_paise - ship) / qty),
      }];
    }
    o.items = items;
    if (o.subtotal_paise == null) {
      o.subtotal_paise = items.reduce((s, it) => s + it.unit_price_paise * it.quantity, 0);
    }
    o.shipping_paise = o.shipping_paise || 0;
    o.item_count = items.reduce((s, it) => s + it.quantity, 0);
  }
  return orders;
}

const ORDER_SELECT = `
  SELECT o.*, b.title AS book_title, b.author AS book_author, v.name AS vendor_name, v.username AS vendor_username
  FROM orders o
  LEFT JOIN books b ON b.id = o.book_id
  LEFT JOIN admins v ON v.id = o.assigned_vendor_id`;

// What a customer (or the invoice page) may see about an order.
function customerOrder(o) {
  return {
    id: o.id,
    invoice_no: o.invoice_no || null,
    created_at: o.created_at,
    paid_at: o.paid_at || null,
    dispatched_at: o.dispatched_at || null,
    delivered_at: o.delivered_at || null,
    buyer_name: o.buyer_name,
    buyer_phone: o.buyer_phone,
    buyer_email: o.buyer_email || "",
    shipping_address: o.shipping_address,
    address_line: o.address_line || "",
    city: o.city || "",
    state: o.state || "",
    pincode: o.pincode || "",
    items: o.items.map((it) => ({
      book_id: it.book_id, title: it.title, author: it.author || "", format: it.format || "Paperback",
      hsn: it.hsn || "4901", quantity: it.quantity, unit_price_paise: it.unit_price_paise,
    })),
    subtotal_paise: o.subtotal_paise,
    shipping_paise: o.shipping_paise,
    amount_paise: o.amount_paise,
    payment_status: o.payment_status,
    payment_method: o.payment_method || "",
    razorpay_payment_id: o.razorpay_payment_id || "",
    fulfillment_status: o.fulfillment_status,
    courier_name: o.courier_name || "",
    tracking_number: o.tracking_number || "",
  };
}

async function markPaid(env, ctx, order, paymentId) {
  const invoiceNo = `${(await getSettings(env)).invoice_prefix || "BD"}/${financialYear()}/${String(order.id).padStart(5, "0")}`;
  const r = await env.DB.prepare(
    `UPDATE orders SET payment_status = 'paid', razorpay_payment_id = ?, paid_at = datetime('now'),
       invoice_no = COALESCE(invoice_no, ?), updated_at = datetime('now')
     WHERE id = ? AND payment_status != 'paid'`
  ).bind(paymentId, invoiceNo, order.id).run();
  if (r.meta && r.meta.changes > 0 && ctx) {
    ctx.waitUntil(sendOrderEmails(env, order.id).catch(() => {}));
  }
  return invoiceNo;
}

// Orders paid before invoice numbers existed get one the first time an
// invoice is needed, numbered in the financial year they were paid.
async function ensureInvoiceNumbers(env, orders) {
  const missing = orders.filter((o) => o.payment_status === "paid" && !o.invoice_no);
  if (!missing.length) return;
  const prefix = (await getSettings(env)).invoice_prefix || "BD";
  const stmts = missing.map((o) => {
    const when = new Date(String(o.paid_at || o.created_at).replace(" ", "T") + "Z");
    o.invoice_no = `${prefix}/${financialYear(isNaN(when) ? new Date() : when)}/${String(o.id).padStart(5, "0")}`;
    return env.DB.prepare(`UPDATE orders SET invoice_no = ? WHERE id = ? AND invoice_no IS NULL`).bind(o.invoice_no, o.id);
  });
  await env.DB.batch(stmts);
}

async function sendMail(env, msg) {
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") return;
  await env.EMAIL.send({ from: env.SEND_FROM_EMAIL || "no-reply@blackdotpublication.com", ...msg });
}

function itemsTableHtml(o) {
  const rows = o.items.map((it) =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${escapeHtml(it.title)}<br><span style="color:#6b7280;font-size:12px">${escapeHtml(it.format || "Paperback")} × ${it.quantity}</span></td>
     <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${rupees(it.unit_price_paise * it.quantity)}</td></tr>`
  ).join("");
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}
    <tr><td style="padding:6px 0">Shipping</td><td style="text-align:right">${o.shipping_paise ? rupees(o.shipping_paise) : "Free"}</td></tr>
    <tr><td style="padding:6px 0"><strong>Total paid</strong></td><td style="text-align:right"><strong>${rupees(o.amount_paise)}</strong></td></tr></table>`;
}

async function sendOrderEmails(env, orderId) {
  const o = await env.DB.prepare(`${ORDER_SELECT} WHERE o.id = ?`).bind(orderId).first();
  if (!o) return;
  await attachItems(env, [o]);
  const link = `${SITE_URL}/order/?id=${o.id}&t=${o.access_token || ""}`;
  const jobs = [];
  if (o.buyer_email) {
    jobs.push(sendMail(env, {
      to: o.buyer_email,
      subject: `Order confirmed: #${o.id} | Blackdot Publication`,
      headers: { "Reply-To": NOTIFY_EMAIL },
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111">
        <h2 style="font-family:Georgia,serif;font-weight:normal">Thank you, ${escapeHtml(o.buyer_name)}.</h2>
        <p>Your payment was received and order <strong>#${o.id}</strong> is now in our dispatch queue.</p>
        ${itemsTableHtml(o)}
        <p style="margin-top:18px"><strong>Shipping to</strong><br>${escapeHtml(o.shipping_address).replace(/\n/g, "<br>")}</p>
        <p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:12px 22px;text-decoration:none">Track order &amp; download invoice</a></p>
        <p style="color:#6b7280;font-size:12px">Blackdot Publication · Where Every Story Leaves a Mark.</p></div>`,
      text: `Thank you, ${o.buyer_name}. Order #${o.id} is confirmed. Total paid ${rupees(o.amount_paise)}.\nTrack your order and download the invoice: ${link}`,
    }));
  }
  jobs.push(sendMail(env, {
    to: NOTIFY_EMAIL,
    subject: `New paid order #${o.id}: ${rupees(o.amount_paise)} from ${o.buyer_name}`,
    html: `<h2>New paid order #${o.id}</h2>${itemsTableHtml(o)}
      <p><strong>${escapeHtml(o.buyer_name)}</strong> · ${escapeHtml(o.buyer_phone || "")} · ${escapeHtml(o.buyer_email || "")}</p>
      <p>${escapeHtml(o.shipping_address).replace(/\n/g, "<br>")}</p>
      <p><a href="${SITE_URL}/admin">Open the admin panel</a> to assign a vendor and print the invoice.</p>`,
    text: `New paid order #${o.id} for ${rupees(o.amount_paise)} from ${o.buyer_name} (${o.buyer_phone}).`,
  }));
  await Promise.allSettled(jobs);
}

async function sendDispatchEmail(env, orderId) {
  const o = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(orderId).first();
  if (!o || !o.buyer_email) return;
  const link = `${SITE_URL}/order/?id=${o.id}&t=${o.access_token || ""}`;
  const tracking = o.tracking_number
    ? `<p>Courier: <strong>${escapeHtml(o.courier_name || "Courier")}</strong><br>Tracking number: <strong>${escapeHtml(o.tracking_number)}</strong></p>`
    : "";
  await sendMail(env, {
    to: o.buyer_email,
    subject: `Your order #${o.id} is on its way | Blackdot Publication`,
    headers: { "Reply-To": NOTIFY_EMAIL },
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111">
      <h2 style="font-family:Georgia,serif;font-weight:normal">Your books are on their way.</h2>
      <p>Order <strong>#${o.id}</strong> has been dispatched.</p>${tracking}
      <p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:12px 22px;text-decoration:none">Track your order</a></p></div>`,
    text: `Order #${o.id} has been dispatched. ${o.tracking_number ? `Tracking: ${o.courier_name || ""} ${o.tracking_number}. ` : ""}Track: ${link}`,
  });
}

// Applies a fulfilment stage change plus the timestamp that goes with it.
function stageTimestampSql(stage) {
  if (stage === "Sent") return ", dispatched_at = COALESCE(dispatched_at, datetime('now'))";
  if (stage === "Delivered") return ", delivered_at = COALESCE(delivered_at, datetime('now')), dispatched_at = COALESCE(dispatched_at, datetime('now'))";
  return "";
}

// ------------------------------------------------------------- razorpay

async function razorpayCreateOrder(env, amountPaise, receipt, notes) {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) throw new Error("Razorpay keys are not configured");
  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
    body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt, notes }),
  });
  if (!res.ok) throw new Error(`Razorpay order creation failed: ${await res.text()}`);
  return res.json();
}

async function razorpayCapturedPayment(env, razorpayOrderId) {
  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const res = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(razorpayOrderId)}/payments`, {
    headers: { authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Razorpay lookup failed: ${await res.text()}`);
  const data = await res.json();
  return (data.items || []).find((p) => p.status === "captured") || null;
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bufToHex(sig);
}

// Validates a cart and prices it from the database (never from the browser).
async function priceCart(env, rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) return { error: "Your cart is empty" };
  const merged = new Map();
  for (const it of rawItems) {
    const id = toInt(it && it.book_id, 0);
    const q = toInt(it && it.quantity, 1);
    if (id <= 0) continue;
    merged.set(id, Math.min(MAX_QTY_PER_LINE, Math.max(1, (merged.get(id) || 0) + Math.max(1, q))));
  }
  if (!merged.size) return { error: "Your cart is empty" };
  if (merged.size > MAX_LINES) return { error: `A single order can contain at most ${MAX_LINES} different titles` };
  const ids = [...merged.keys()];
  const { results } = await env.DB.prepare(
    `SELECT * FROM books WHERE id IN (${ids.map(() => "?").join(",")})`
  ).bind(...ids).all();
  const lines = [];
  for (const id of ids) {
    const b = results.find((r) => r.id === id);
    if (!b || !b.available) return { error: "One of the books in your cart is no longer available", book_id: id };
    if (b.coming_soon) return { error: `"${b.title}" is not released yet`, book_id: id };
    if (b.in_stock === 0) return { error: `"${b.title}" is currently out of stock`, book_id: id };
    lines.push({
      book_id: b.id, title: b.title, author: b.author, format: b.binding || "Paperback", hsn: "4901",
      unit_price_paise: b.price_paise, quantity: merged.get(id), cover_url: b.cover_url || "",
    });
  }
  const settings = await getSettings(env);
  const subtotal = lines.reduce((s, l) => s + l.unit_price_paise * l.quantity, 0);
  const shipping = shippingFor(subtotal, settings);
  return { lines, subtotal, shipping, total: subtotal + shipping };
}

// ------------------------------------------------------------------ routes

async function handleApi(request, env, url, ctx) {
  const { pathname } = url;
  const method = request.method;

  // ---------- create a main_admin, gated by SETUP_TOKEN ----------
  if (pathname === "/api/setup" && method === "POST") {
    const body = await readJson(request);
    if (!body || !body.setup_token || !body.username || !body.password) return badRequest("Missing fields");
    if (!env.SETUP_TOKEN || !timingSafeEqual(body.setup_token, env.SETUP_TOKEN)) return unauthorized("Invalid setup token");
    if (String(body.password).length < 8) return badRequest("Password must be at least 8 characters");
    const hash = await hashPassword(String(body.password), env.SESSION_SECRET);
    try {
      await env.DB.prepare(
        `INSERT INTO admins (username, password_hash, role, name) VALUES (?, ?, 'main_admin', ?)`
      ).bind(str(body.username, 60), hash, str(body.name, 100) || "Main Admin").run();
    } catch (e) {
      return badRequest("That username is already taken, please choose another");
    }
    return json({ ok: true });
  }

  // ---------- password reset, gated by the same SETUP_TOKEN ----------
  if (pathname === "/api/admin/reset-password" && method === "POST") {
    const body = await readJson(request);
    if (!body || !body.setup_token || !body.username || !body.new_password) return badRequest("Missing fields");
    if (!env.SETUP_TOKEN || !timingSafeEqual(body.setup_token, env.SETUP_TOKEN)) return unauthorized("Invalid setup token");
    if (String(body.new_password).length < 8) return badRequest("Password must be at least 8 characters");
    const admin = await env.DB.prepare(`SELECT * FROM admins WHERE username = ?`).bind(String(body.username)).first();
    if (!admin) return notFound("No account with that username");
    const hash = await hashPassword(String(body.new_password), env.SESSION_SECRET);
    await env.DB.prepare(`UPDATE admins SET password_hash = ? WHERE id = ?`).bind(hash, admin.id).run();
    await env.DB.prepare(`DELETE FROM sessions WHERE admin_id = ?`).bind(admin.id).run();
    return json({ ok: true, role: admin.role });
  }

  // ---------- auth ----------
  if (pathname === "/api/auth/login" && method === "POST") {
    const body = await readJson(request);
    if (!body || !body.username || !body.password) return badRequest("Missing username/password");
    const admin = await env.DB.prepare(
      `SELECT * FROM admins WHERE username = ? AND active = 1`
    ).bind(String(body.username)).first();
    if (!admin) return unauthorized("Invalid credentials");
    const ok = await verifyPassword(String(body.password), admin.password_hash, env.SESSION_SECRET);
    if (!ok) return unauthorized("Invalid credentials");
    if (body.role && body.role !== admin.role) return forbidden("Wrong login portal for this account");
    const token = randomHex(32);
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(new Date().toISOString()),
      env.DB.prepare(`INSERT INTO sessions (token, admin_id, role, expires_at) VALUES (?, ?, ?, ?)`)
        .bind(token, admin.id, admin.role, expires),
    ]);
    return json(
      { ok: true, role: admin.role, name: admin.name, username: admin.username },
      200,
      { "Set-Cookie": setCookieHeader(token, SESSION_DAYS * 86400) }
    );
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    const token = parseCookies(request)[SESSION_COOKIE];
    if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
    return json({ ok: true }, 200, { "Set-Cookie": clearCookieHeader() });
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    const admin = await getSessionAdmin(request, env);
    if (!admin) return unauthorized();
    return json({ admin: { username: admin.username, role: admin.role, name: admin.name } });
  }

  // ---------- public: store configuration (shipping, delivery estimate) ----------
  if (pathname === "/api/store-config" && method === "GET") {
    const s = await getSettings(env);
    return json({ ...pick(s, PUBLIC_SETTING_KEYS), states: INDIAN_STATES });
  }

  // ---------- public: books ----------
  if (pathname === "/api/books" && method === "GET") {
    const { results } = await env.DB.prepare(
      `${BOOK_SELECT} WHERE b.available = 1 ORDER BY b.featured DESC, b.sort_order ASC, b.created_at DESC`
    ).all();
    return json({ books: results.map(publicBook) });
  }

  const publicBookMatch = pathname.match(/^\/api\/books\/(\d+)$/);
  if (publicBookMatch && method === "GET") {
    const data = await bookPageData(env, toInt(publicBookMatch[1]));
    if (!data) return notFound("Book not found");
    return json(data);
  }

  // ---------- public: submit a review ----------
  const reviewMatch = pathname.match(/^\/api\/books\/(\d+)\/reviews$/);
  if (reviewMatch && method === "POST") {
    const bookId = toInt(reviewMatch[1]);
    const body = await readJson(request);
    if (!body) return badRequest("Missing body");
    if (body.website) return json({ ok: true, status: "pending" }); // honeypot: silently drop bots
    const book = await env.DB.prepare(`SELECT id, title FROM books WHERE id = ? AND available = 1`).bind(bookId).first();
    if (!book) return notFound("Book not found");
    const rating = toInt(body.rating, 0);
    const name = str(body.name, 60);
    const title = str(body.title, 120);
    const text = str(body.body, 3000);
    if (rating < 1 || rating > 5) return badRequest("Please choose a star rating");
    if (name.length < 2) return badRequest("Please enter your name");
    if (text.length < 10) return badRequest("Please write at least a sentence about the book");

    // A matching paid order (order number + the phone used at checkout)
    // marks the review as a Verified Purchase.
    let verified = 0;
    let orderId = null;
    if (body.order_id || body.phone) {
      const oid = toInt(String(body.order_id || "").replace(/\D/g, ""), 0);
      const phone = normalizePhone(body.phone);
      const order = oid && phone
        ? await env.DB.prepare(`SELECT * FROM orders WHERE id = ? AND payment_status = 'paid'`).bind(oid).first()
        : null;
      if (!order || normalizePhone(order.buyer_phone) !== phone) {
        return badRequest("We couldn't match that order number and phone number. Leave both blank to post without the Verified Purchase badge.");
      }
      const [withItems] = await attachItems(env, [order]);
      if (!withItems.items.some((it) => it.book_id === bookId)) {
        return badRequest("That order doesn't include this book");
      }
      const dup = await env.DB.prepare(`SELECT id FROM reviews WHERE order_id = ? AND book_id = ?`).bind(oid, bookId).first();
      if (dup) return badRequest("You've already reviewed this book for that order. Thank you!");
      verified = 1;
      orderId = oid;
    }
    const settings = await getSettings(env);
    const status = verified && settings.review_auto_approve_verified === "1" ? "approved" : "pending";
    await env.DB.prepare(
      `INSERT INTO reviews (book_id, order_id, name, rating, title, body, verified, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(bookId, orderId, name, rating, title, text, verified, status).run();
    return json({ ok: true, status, verified: !!verified });
  }

  // ---------- public: pincode → city/state lookup (best effort) ----------
  const pinMatch = pathname.match(/^\/api\/pincode\/([1-9]\d{5})$/);
  if (pinMatch && method === "GET") {
    const cache = caches.default;
    const cacheKey = new Request(`https://pincode.cache/${pinMatch[1]}`);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(`https://api.postalpincode.in/pincode/${pinMatch[1]}`, { signal: ctl.signal });
      clearTimeout(timer);
      const data = await res.json();
      const po = data && data[0] && data[0].Status === "Success" && data[0].PostOffice && data[0].PostOffice[0];
      if (!po) return json({ found: false });
      const out = json({ found: true, city: po.District, state: po.State }, 200, { "cache-control": "public, max-age=604800" });
      ctx.waitUntil(cache.put(cacheKey, out.clone()));
      return out;
    } catch (e) {
      return json({ found: false });
    }
  }

  // ---------- public: contact form ----------
  if (pathname === "/api/contact" && method === "POST") {
    const body = await readJson(request);
    if (!body || !body.name || !body.email || !body.message) return badRequest("Missing fields");
    await env.DB.prepare(
      `INSERT INTO leads (name, email, message) VALUES (?, ?, ?)`
    ).bind(str(body.name, 200), str(body.email, 200), str(body.message, 4000)).run();
    return json({ ok: true });
  }

  // ---------- public: manuscript submission (Publish With Us page) ----------
  if (pathname === "/api/manuscript-submission" && method === "POST") {
    const body = await readJson(request);
    const required = ["name", "email", "phone", "book_title", "message"];
    if (!body || required.some((k) => !body[k])) return badRequest("Missing required fields");
    if (!body.attachment && !body.manuscript_link) {
      return badRequest("Please attach a manuscript file or provide a link to one");
    }
    if (!env.EMAIL) return json({ error: "Email sending isn't set up yet, please WhatsApp us your manuscript instead" }, 503);

    const attachments = [];
    if (body.attachment && body.attachment.base64) {
      const approxBytes = body.attachment.base64.length * 0.75;
      if (approxBytes > 4.5 * 1024 * 1024) {
        return badRequest("That attachment is too large for email, please use the manuscript link field instead");
      }
      attachments.push({
        content: body.attachment.base64,
        filename: str(body.attachment.filename, 200) || "manuscript",
        type: str(body.attachment.mime, 120) || "application/octet-stream",
        disposition: "attachment",
      });
    }

    const html = `
      <h2>New manuscript submission</h2>
      <p><strong>Name:</strong> ${escapeHtml(body.name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(body.email)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(body.phone)}</p>
      <p><strong>Genre:</strong> ${escapeHtml(body.genre || "Not specified")}</p>
      <p><strong>Book Title:</strong> ${escapeHtml(body.book_title)}</p>
      ${body.manuscript_link ? `<p><strong>Manuscript link:</strong> ${escapeHtml(body.manuscript_link)}</p>` : ""}
      <p><strong>Message:</strong><br>${escapeHtml(body.message).replace(/\n/g, "<br>")}</p>
    `;
    const text =
      `New manuscript submission\n` +
      `Name: ${body.name}\nEmail: ${body.email}\nPhone: ${body.phone}\nGenre: ${body.genre || "Not specified"}\n` +
      `Book Title: ${body.book_title}\n` +
      (body.manuscript_link ? `Manuscript link: ${body.manuscript_link}\n` : "") +
      `\nMessage:\n${body.message}`;

    try {
      await sendMail(env, {
        to: NOTIFY_EMAIL,
        subject: `New manuscript submission: ${str(body.book_title, 150)}`,
        html,
        text,
        headers: { "Reply-To": str(body.email, 200) },
        attachments,
      });
    } catch (e) {
      return json({ error: "Could not send your submission, please try again or WhatsApp us directly", detail: String(e && e.message ? e.message : e) }, 502);
    }

    await env.DB.prepare(
      `INSERT INTO manuscripts (name, email, phone, genre, book_title, message, manuscript_link, attachment_filename)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      str(body.name, 200), str(body.email, 200), str(body.phone, 40), str(body.genre, 60), str(body.book_title, 300),
      str(body.message, 8000), str(body.manuscript_link, 1000) || null, body.attachment ? str(body.attachment.filename, 200) : null
    ).run();

    return json({ ok: true });
  }

  // ---------- main admin: view manuscript submissions ----------
  if (pathname === "/api/admin/manuscripts" && method === "GET") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const { results } = await env.DB.prepare(`SELECT * FROM manuscripts ORDER BY created_at DESC`).all();
    return json({ manuscripts: results });
  }

  // ---------- public: price a cart (checkout summary) ----------
  if (pathname === "/api/checkout/quote" && method === "POST") {
    const body = await readJson(request);
    const quote = await priceCart(env, body && body.items);
    if (quote.error) return json(quote, 400);
    return json(quote);
  }

  // ---------- public: create a Razorpay order ----------
  if (pathname === "/api/razorpay/create-order" && method === "POST") {
    const body = await readJson(request);
    if (!body) return badRequest("Missing body");
    // Older single-book payload ({ book_id, quantity }) is still accepted.
    const rawItems = Array.isArray(body.items) ? body.items : (body.book_id ? [{ book_id: body.book_id, quantity: body.quantity }] : []);
    const quote = await priceCart(env, rawItems);
    if (quote.error) return json(quote, 400);

    const name = str(body.buyer_name, 100);
    const phone = normalizePhone(body.buyer_phone);
    const email = str(body.buyer_email, 200);
    const addressLine = str(body.address || body.shipping_address, 500);
    const city = str(body.city, 100);
    const state = str(body.state, 60);
    const pincode = str(body.pincode, 6);
    const legacy = !body.items;
    if (name.length < 2) return badRequest("Please enter your full name");
    if (!phone) return badRequest("Please enter a valid 10-digit Indian mobile number");
    if (email && !isEmail(email)) return badRequest("Please enter a valid email address, or leave it blank");
    if (addressLine.length < 5) return badRequest("Please enter your full delivery address");
    if (!legacy) {
      if (city.length < 2) return badRequest("Please enter your city");
      if (!INDIAN_STATES.includes(state)) return badRequest("Please select your state");
      if (!/^[1-9]\d{5}$/.test(pincode)) return badRequest("Please enter a valid 6-digit pincode");
    }
    const fullAddress = legacy ? addressLine : `${addressLine}\n${city}, ${state} - ${pincode}`;
    const paymentMethod = ["upi", "card", "netbanking", "wallet"].includes(body.payment_method) ? body.payment_method : null;
    const accessToken = randomHex(16);

    const insert = await env.DB.prepare(
      `INSERT INTO orders (book_id, buyer_name, buyer_email, buyer_phone, shipping_address, address_line, city, state, pincode,
         quantity, subtotal_paise, shipping_paise, amount_paise, payment_method, access_token, payment_status, fulfillment_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', 'Received')`
    ).bind(
      quote.lines[0].book_id, name, email || null, phone, fullAddress, addressLine, city || null, state || null, pincode || null,
      quote.lines.reduce((s, l) => s + l.quantity, 0), quote.subtotal, quote.shipping, quote.total, paymentMethod, accessToken
    ).run();
    const orderId = insert.meta.last_row_id;
    await env.DB.batch(quote.lines.map((l) => env.DB.prepare(
      `INSERT INTO order_items (order_id, book_id, title, author, format, hsn, unit_price_paise, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(orderId, l.book_id, l.title, l.author, l.format, l.hsn, l.unit_price_paise, l.quantity)));

    let rzpOrder;
    try {
      rzpOrder = await razorpayCreateOrder(env, quote.total, `bd_${orderId}`, { blackdot_order_id: String(orderId) });
    } catch (e) {
      await env.DB.prepare(`UPDATE orders SET payment_status = 'failed', admin_notes = ? WHERE id = ?`)
        .bind("Payment gateway error at checkout", orderId).run();
      return json({ error: "The payment gateway is not responding right now. Please try again in a minute, or order on WhatsApp.", detail: String(e && e.message ? e.message : e) }, 502);
    }
    await env.DB.prepare(`UPDATE orders SET razorpay_order_id = ? WHERE id = ?`).bind(rzpOrder.id, orderId).run();

    return json({
      order_id: orderId,
      access_token: accessToken,
      razorpay_order_id: rzpOrder.id,
      amount: quote.total,
      currency: "INR",
      key_id: env.RAZORPAY_KEY_ID,
      book_title: quote.lines.length === 1 ? quote.lines[0].title : `${quote.lines.length} books`,
    });
  }

  // ---------- public: verify payment ----------
  if (pathname === "/api/razorpay/verify" && method === "POST") {
    const body = await readJson(request);
    const required = ["order_id", "razorpay_order_id", "razorpay_payment_id", "razorpay_signature"];
    if (!body || required.some((k) => !body[k])) return badRequest("Missing fields");

    const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(toInt(body.order_id)).first();
    if (!order || order.razorpay_order_id !== body.razorpay_order_id) return notFound("Order not found");

    const expected = await hmacHex(env.RAZORPAY_KEY_SECRET, `${body.razorpay_order_id}|${body.razorpay_payment_id}`);
    if (!timingSafeEqual(expected, body.razorpay_signature)) {
      // Never downgrade an order that is already confirmed as paid.
      await env.DB.prepare(`UPDATE orders SET payment_status = 'failed' WHERE id = ? AND payment_status = 'created'`).bind(order.id).run();
      return badRequest("Signature verification failed");
    }
    const invoiceNo = await markPaid(env, ctx, order, String(body.razorpay_payment_id));
    const fresh = await env.DB.prepare(`SELECT invoice_no, access_token FROM orders WHERE id = ?`).bind(order.id).first();
    return json({ ok: true, order_id: order.id, invoice_no: fresh.invoice_no || invoiceNo, access_token: fresh.access_token });
  }

  // ---------- Razorpay webhook (safety net if the buyer closes the tab after paying) ----------
  if (pathname === "/api/razorpay/webhook" && method === "POST") {
    if (!env.RAZORPAY_WEBHOOK_SECRET) return json({ error: "Webhook secret not configured" }, 503);
    const raw = await request.text();
    const sig = request.headers.get("X-Razorpay-Signature") || "";
    const expected = await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, raw);
    if (!timingSafeEqual(expected, sig)) return unauthorized("Bad signature");
    let evt;
    try { evt = JSON.parse(raw); } catch { return badRequest("Bad JSON"); }
    const payment = evt && evt.payload && evt.payload.payment && evt.payload.payment.entity;
    if ((evt.event === "payment.captured" || evt.event === "order.paid") && payment && payment.order_id) {
      const order = await env.DB.prepare(`SELECT * FROM orders WHERE razorpay_order_id = ?`).bind(payment.order_id).first();
      if (order && payment.amount === order.amount_paise) await markPaid(env, ctx, order, payment.id);
    }
    return json({ ok: true });
  }

  // ---------- public: order lookup (tracking page, customer invoice) ----------
  if (pathname === "/api/orders/lookup" && method === "GET") {
    const id = toInt(url.searchParams.get("id"), 0);
    const token = url.searchParams.get("t") || "";
    const phone = normalizePhone(url.searchParams.get("phone"));
    if (!id || (!token && !phone)) return badRequest("Enter your order number and the mobile number used at checkout");
    const o = await env.DB.prepare(`${ORDER_SELECT} WHERE o.id = ?`).bind(id).first();
    const match = o && (
      (token && o.access_token && timingSafeEqual(token, o.access_token)) ||
      (phone && normalizePhone(o.buyer_phone) === phone)
    );
    if (!match) return notFound("We couldn't find an order with those details");
    await attachItems(env, [o]);
    await ensureInvoiceNumbers(env, [o]);
    const settings = await getSettings(env);
    return json({ order: { ...customerOrder(o), access_token: o.access_token }, business: pick(settings, INVOICE_SETTING_KEYS) });
  }

  // ---------- main admin: book management ----------
  if (pathname === "/api/admin/books" && method === "POST") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const b = await readJson(request);
    if (!b) return badRequest("Missing body");
    const { images, values } = bookFieldsFromBody(b);
    if (!values.title || !values.author || values.price_paise <= 0) return badRequest("Title, author and price are required");
    if (!images.length) return badRequest("At least one image URL is required");
    const cols = Object.keys(values);
    const r = await env.DB.prepare(
      `INSERT INTO books (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
    ).bind(...cols.map((c) => values[c])).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }

  const bookIdMatch = pathname.match(/^\/api\/admin\/books\/(\d+)$/);
  if (bookIdMatch && (method === "PUT" || method === "DELETE")) {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const id = toInt(bookIdMatch[1]);
    if (method === "DELETE") {
      // Books that appear in orders are archived instead, so past orders and
      // invoices keep working.
      const used = await env.DB.prepare(
        `SELECT 1 FROM orders WHERE book_id = ? UNION SELECT 1 FROM order_items WHERE book_id = ? LIMIT 1`
      ).bind(id, id).first();
      if (used) {
        await env.DB.prepare(`UPDATE books SET available = 0, featured = 0, updated_at = datetime('now') WHERE id = ?`).bind(id).run();
        return json({ ok: true, archived: true });
      }
      await env.DB.prepare(`DELETE FROM books WHERE id = ?`).bind(id).run();
      return json({ ok: true });
    }
    const b = await readJson(request);
    if (!b) return badRequest("Missing body");
    const { images, values } = bookFieldsFromBody(b);
    if (!values.title || !values.author || values.price_paise <= 0) return badRequest("Title, author and price are required");
    if (!images.length) return badRequest("At least one image URL is required");
    const cols = Object.keys(values);
    await env.DB.prepare(
      `UPDATE books SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`
    ).bind(...cols.map((c) => values[c]), id).run();
    return json({ ok: true });
  }

  // ---------- main admin: all books incl. unavailable ----------
  if (pathname === "/api/admin/books-all" && method === "GET") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const { results } = await env.DB.prepare(`${BOOK_SELECT} ORDER BY b.sort_order ASC, b.created_at DESC`).all();
    return json({ books: results.map((r) => ({ ...publicBook(r), amazon_url: r.amazon_url || "", sort_order: r.sort_order || 0 })) });
  }

  // ---------- main admin: vendor account management ----------
  if (pathname === "/api/admin/vendors" && method === "GET") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const { results } = await env.DB.prepare(
      `SELECT id, username, name, active, created_at FROM admins WHERE role = 'vendor' ORDER BY created_at DESC`
    ).all();
    return json({ vendors: results });
  }

  if (pathname === "/api/admin/vendors" && method === "POST") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const b = await readJson(request);
    if (!b || !b.username || !b.password) return badRequest("Missing username/password");
    if (String(b.password).length < 8) return badRequest("Password must be at least 8 characters");
    const hash = await hashPassword(String(b.password), env.SESSION_SECRET);
    try {
      const r = await env.DB.prepare(
        `INSERT INTO admins (username, password_hash, role, name) VALUES (?, ?, 'vendor', ?)`
      ).bind(str(b.username, 60), hash, str(b.name, 100) || str(b.username, 60)).run();
      return json({ ok: true, id: r.meta.last_row_id });
    } catch (e) {
      return badRequest("Username may already be taken");
    }
  }

  const vendorIdMatch = pathname.match(/^\/api\/admin\/vendors\/(\d+)$/);
  if (vendorIdMatch && method === "PUT") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const b = await readJson(request);
    if (!b || b.active === undefined) return badRequest("Nothing to update");
    const id = toInt(vendorIdMatch[1]);
    await env.DB.prepare(`UPDATE admins SET active = ? WHERE id = ? AND role = 'vendor'`).bind(b.active ? 1 : 0, id).run();
    if (!b.active) await env.DB.prepare(`DELETE FROM sessions WHERE admin_id = ?`).bind(id).run();
    return json({ ok: true });
  }

  // ---------- main admin: orders ----------
  if (pathname === "/api/admin/orders" && method === "GET") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const { results } = await env.DB.prepare(`${ORDER_SELECT} ORDER BY o.created_at DESC, o.id DESC`).all();
    await attachItems(env, results);
    return json({ orders: results });
  }

  // Printable invoices / labels for several orders at once.
  if ((pathname === "/api/admin/invoices" || pathname === "/api/vendor/invoices") && method === "GET") {
    const isVendor = pathname.startsWith("/api/vendor");
    const { error, admin } = await requireRole(request, env, [isVendor ? "vendor" : "main_admin"]);
    if (error) return error;
    const ids = (url.searchParams.get("ids") || "").split(",").map((v) => toInt(v, 0)).filter((v) => v > 0).slice(0, 90);
    if (!ids.length) return badRequest("No orders selected");
    const where = `o.id IN (${ids.map(() => "?").join(",")})` + (isVendor ? ` AND o.assigned_vendor_id = ? AND o.payment_status = 'paid'` : "");
    const { results } = await env.DB.prepare(`${ORDER_SELECT} WHERE ${where} ORDER BY o.id`)
      .bind(...ids, ...(isVendor ? [admin.id] : [])).all();
    await attachItems(env, results);
    await ensureInvoiceNumbers(env, results);
    const settings = await getSettings(env);
    return json({ orders: results.map(customerOrder), business: pick(settings, INVOICE_SETTING_KEYS) });
  }

  const adminOrderSync = pathname.match(/^\/api\/admin\/orders\/(\d+)\/sync$/);
  if (adminOrderSync && method === "POST") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(toInt(adminOrderSync[1])).first();
    if (!order) return notFound("Order not found");
    if (order.payment_status === "paid") return json({ ok: true, payment_status: "paid" });
    if (!order.razorpay_order_id) return badRequest("This order never reached Razorpay, so there is no payment to check");
    let payment;
    try { payment = await razorpayCapturedPayment(env, order.razorpay_order_id); }
    catch (e) { return json({ error: "Could not reach Razorpay", detail: String(e && e.message) }, 502); }
    if (!payment) return json({ ok: true, payment_status: order.payment_status, message: "Razorpay has no captured payment for this order" });
    await markPaid(env, ctx, order, payment.id);
    return json({ ok: true, payment_status: "paid" });
  }

  const adminOrderMatch = pathname.match(/^\/api\/admin\/orders\/(\d+)$/);
  if (adminOrderMatch && method === "PUT") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const id = toInt(adminOrderMatch[1]);
    const b = await readJson(request);
    if (!b) return badRequest("Missing body");
    const current = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(id).first();
    if (!current) return notFound("Order not found");
    const fields = [];
    const values = [];
    let extra = "";
    if (b.fulfillment_status !== undefined) {
      if (!STAGES.includes(b.fulfillment_status)) return badRequest("Invalid status");
      fields.push("fulfillment_status = ?"); values.push(b.fulfillment_status);
      extra = stageTimestampSql(b.fulfillment_status);
    }
    if (b.assigned_vendor_id !== undefined) {
      const vid = b.assigned_vendor_id ? toInt(b.assigned_vendor_id, 0) : null;
      if (vid) {
        const v = await env.DB.prepare(`SELECT id FROM admins WHERE id = ? AND role = 'vendor'`).bind(vid).first();
        if (!v) return badRequest("Unknown vendor");
      }
      fields.push("assigned_vendor_id = ?"); values.push(vid);
    }
    if (b.courier_name !== undefined) { fields.push("courier_name = ?"); values.push(str(b.courier_name, 80)); }
    if (b.tracking_number !== undefined) { fields.push("tracking_number = ?"); values.push(str(b.tracking_number, 80)); }
    if (b.admin_notes !== undefined) { fields.push("admin_notes = ?"); values.push(str(b.admin_notes, 2000)); }
    if (!fields.length) return badRequest("Nothing to update");
    values.push(id);
    await env.DB.prepare(`UPDATE orders SET ${fields.join(", ")}, updated_at = datetime('now')${extra} WHERE id = ?`).bind(...values).run();
    if (b.fulfillment_status === "Sent" && current.fulfillment_status !== "Sent" && current.payment_status === "paid") {
      ctx.waitUntil(sendDispatchEmail(env, id).catch(() => {}));
    }
    return json({ ok: true });
  }
  if (adminOrderMatch && method === "DELETE") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const id = toInt(adminOrderMatch[1]);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM order_items WHERE order_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM orders WHERE id = ?`).bind(id),
    ]);
    return json({ ok: true });
  }

  // ---------- main admin: reviews moderation ----------
  if (pathname === "/api/admin/reviews" && method === "GET") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const { results } = await env.DB.prepare(
      `SELECT r.*, b.title AS book_title FROM reviews r LEFT JOIN books b ON b.id = r.book_id ORDER BY r.created_at DESC, r.id DESC`
    ).all();
    return json({ reviews: results });
  }
  const adminReviewMatch = pathname.match(/^\/api\/admin\/reviews\/(\d+)$/);
  if (adminReviewMatch && (method === "PUT" || method === "DELETE")) {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const id = toInt(adminReviewMatch[1]);
    if (method === "DELETE") {
      await env.DB.prepare(`DELETE FROM reviews WHERE id = ?`).bind(id).run();
      return json({ ok: true });
    }
    const b = await readJson(request);
    if (!b) return badRequest("Missing body");
    const fields = [];
    const values = [];
    if (b.status !== undefined) {
      if (!["pending", "approved", "hidden"].includes(b.status)) return badRequest("Invalid status");
      fields.push("status = ?"); values.push(b.status);
    }
    if (b.reply !== undefined) { fields.push("reply = ?"); values.push(str(b.reply, 2000) || null); }
    if (!fields.length) return badRequest("Nothing to update");
    await env.DB.prepare(`UPDATE reviews SET ${fields.join(", ")} WHERE id = ?`).bind(...values, id).run();
    return json({ ok: true });
  }

  // ---------- main admin: store settings ----------
  if (pathname === "/api/admin/settings" && method === "GET") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    return json({ settings: await getSettings(env) });
  }
  if (pathname === "/api/admin/settings" && method === "PUT") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const b = await readJson(request);
    if (!b) return badRequest("Missing body");
    const numeric = ["shipping_flat_paise", "free_shipping_above_paise", "delivery_min_days", "delivery_max_days"];
    const stmts = [];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (b[key] === undefined) continue;
      let v = str(b[key], 1000);
      if (numeric.includes(key)) v = String(Math.max(0, toInt(v, 0)));
      if (key === "review_auto_approve_verified") v = b[key] && b[key] !== "0" ? "1" : "0";
      stmts.push(env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(key, v));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, settings: await getSettings(env) });
  }

  // ---------- vendor: assigned orders ----------
  if (pathname === "/api/vendor/orders" && method === "GET") {
    const { error, admin } = await requireRole(request, env, ["vendor"]);
    if (error) return error;
    const { results } = await env.DB.prepare(
      `${ORDER_SELECT} WHERE o.assigned_vendor_id = ? AND o.payment_status = 'paid' ORDER BY o.created_at DESC, o.id DESC`
    ).bind(admin.id).all();
    await attachItems(env, results);
    return json({ orders: results.map(customerOrder) });
  }

  const vendorOrderMatch = pathname.match(/^\/api\/vendor\/orders\/(\d+)\/status$/);
  if (vendorOrderMatch && method === "PUT") {
    const { error, admin } = await requireRole(request, env, ["vendor"]);
    if (error) return error;
    const id = toInt(vendorOrderMatch[1]);
    const b = await readJson(request);
    if (!b || !b.status) return badRequest("Missing status");
    const order = await env.DB.prepare(
      `SELECT * FROM orders WHERE id = ? AND assigned_vendor_id = ? AND payment_status = 'paid'`
    ).bind(id, admin.id).first();
    if (!order) return notFound("Order not found");
    const currentIdx = STAGES.indexOf(order.fulfillment_status);
    const nextIdx = STAGES.indexOf(b.status);
    if (nextIdx === -1) return badRequest("Invalid status");
    if (nextIdx !== currentIdx + 1) return forbidden(`Orders can only move forward, one stage at a time (${STAGES.join(" → ")})`);
    const fields = ["fulfillment_status = ?"];
    const values = [b.status];
    if (b.status === "Sent") {
      if (b.courier_name !== undefined) { fields.push("courier_name = ?"); values.push(str(b.courier_name, 80)); }
      if (b.tracking_number !== undefined) { fields.push("tracking_number = ?"); values.push(str(b.tracking_number, 80)); }
    }
    await env.DB.prepare(
      `UPDATE orders SET ${fields.join(", ")}, updated_at = datetime('now')${stageTimestampSql(b.status)} WHERE id = ?`
    ).bind(...values, id).run();
    if (b.status === "Sent") ctx.waitUntil(sendDispatchEmail(env, id).catch(() => {}));
    return json({ ok: true });
  }

  return notFound("Unknown API route");
}

// Everything the book page needs in one round trip.
async function bookPageData(env, id) {
  const book = await loadBook(env, id);
  if (!book) return null;
  const [{ results: reviews }, { results: dist }, { results: others }] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, rating, title, body, verified, reply, created_at FROM reviews
       WHERE book_id = ? AND status = 'approved' ORDER BY verified DESC, created_at DESC LIMIT 100`
    ).bind(id).all(),
    env.DB.prepare(
      `SELECT rating, COUNT(*) AS n FROM reviews WHERE book_id = ? AND status = 'approved' GROUP BY rating`
    ).bind(id).all(),
    env.DB.prepare(
      `${BOOK_SELECT} WHERE b.available = 1 AND b.id != ? ORDER BY (b.category = ?) DESC, b.featured DESC, b.created_at DESC LIMIT 8`
    ).bind(id, book.category || "").all(),
  ]);
  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const d of dist) distribution[d.rating] = d.n;
  return { book, reviews, distribution, related: others.map(publicBook) };
}

// ------------------------------------------------------------ pages

// /books/<id>-<slug>: serves /book/index.html with title, description,
// canonical, Open Graph tags and Product JSON-LD (with star ratings) filled
// in on the server, plus the page data inlined so it renders instantly.
async function renderBookPage(request, env, url, id) {
  const assetUrl = new URL("/book/", url);
  // No conditional headers: a 304 here would leave nothing to rewrite.
  const page = await env.ASSETS.fetch(new Request(assetUrl.toString()));
  let data = null;
  try { data = await bookPageData(env, id); } catch (e) { data = null; }
  if (!data) {
    return new Response(page.body, { status: 404, headers: page.headers });
  }
  const { book } = data;
  const canonicalPath = book.url;
  if (decodeURIComponent(url.pathname).replace(/\/$/, "") !== canonicalPath) {
    return Response.redirect(new URL(canonicalPath, url).toString(), 301);
  }
  const canonical = SITE_URL + canonicalPath;
  const title = `${book.title} by ${book.author} | Blackdot Publication`;
  const desc = (book.tagline ? book.tagline + " " : "") + (book.description || "").replace(/\s+/g, " ");
  const shortDesc = desc.slice(0, 157) + (desc.length > 157 ? "…" : "");
  const image = book.images[0] || "";
  const ld = {
    "@context": "https://schema.org",
    "@type": ["Product", "Book"],
    name: book.title,
    author: { "@type": "Person", name: book.author },
    image: book.images,
    description: desc.slice(0, 500),
    ...(book.isbn ? { isbn: book.isbn, gtin13: book.isbn.replace(/\D/g, "").length === 13 ? book.isbn.replace(/\D/g, "") : undefined } : {}),
    ...(book.language ? { inLanguage: book.language } : {}),
    ...(book.pages ? { numberOfPages: book.pages } : {}),
    brand: { "@type": "Brand", name: "Blackdot Publication" },
    publisher: { "@type": "Organization", name: "Blackdot Publication" },
    offers: {
      "@type": "Offer",
      url: canonical,
      priceCurrency: "INR",
      price: (book.price_paise / 100).toFixed(2),
      availability: book.coming_soon ? "https://schema.org/PreOrder"
        : (book.in_stock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock"),
      itemCondition: "https://schema.org/NewCondition",
    },
    ...(book.rating_count ? {
      aggregateRating: { "@type": "AggregateRating", ratingValue: book.rating_avg, reviewCount: book.rating_count, bestRating: 5, worstRating: 1 },
      review: data.reviews.slice(0, 5).map((r) => ({
        "@type": "Review",
        author: { "@type": "Person", name: r.name },
        reviewRating: { "@type": "Rating", ratingValue: r.rating, bestRating: 5 },
        ...(r.title ? { name: r.title } : {}),
        reviewBody: r.body,
        datePublished: String(r.created_at || "").slice(0, 10),
      })),
    } : {}),
  };
  const safeJson = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
  const setAttr = (attr, value) => ({ element(el) { el.setAttribute(attr, value); } });
  const rewritten = new HTMLRewriter()
    .on("title", { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', setAttr("content", shortDesc))
    .on('link[rel="canonical"]', setAttr("href", canonical))
    .on('meta[property="og:title"]', setAttr("content", title))
    .on('meta[property="og:description"]', setAttr("content", shortDesc))
    .on('meta[property="og:url"]', setAttr("content", canonical))
    .on('meta[property="og:image"]', setAttr("content", image))
    .on('meta[name="twitter:title"]', setAttr("content", title))
    .on('meta[name="twitter:description"]', setAttr("content", shortDesc))
    .on('meta[name="twitter:image"]', setAttr("content", image))
    .on("head", {
      element(el) {
        el.append(`<script type="application/ld+json">${safeJson(ld)}</script>`, { html: true });
        el.append(`<script>window.__BOOK_DATA__=${safeJson(data)};</script>`, { html: true });
      },
    })
    .transform(page);
  const headers = new Headers(rewritten.headers);
  headers.set("cache-control", "no-cache");
  return new Response(rewritten.body, { status: 200, headers });
}

async function renderSitemap(env, url) {
  const staticPaths = [
    ["/", "weekly", "1.0"], ["/books/", "weekly", "0.9"], ["/publish/", "monthly", "0.8"],
    ["/about-us/", "monthly", "0.6"], ["/contact-us/", "monthly", "0.6"],
    ["/privacy-policy/", "yearly", "0.4"], ["/terms-and-conditions/", "yearly", "0.4"],
    ["/shipping-policy/", "yearly", "0.4"], ["/refund-policy/", "yearly", "0.4"],
  ];
  let books = [];
  try {
    const { results } = await env.DB.prepare(`SELECT id, title, updated_at FROM books WHERE available = 1`).all();
    books = results;
  } catch (e) { books = []; }
  const entries = [
    ...staticPaths.map(([p, f, pr]) => `  <url><loc>${SITE_URL}${p}</loc><changefreq>${f}</changefreq><priority>${pr}</priority></url>`),
    ...books.map((b) => `  <url><loc>${SITE_URL}${escapeHtml(bookPath(b))}</loc>${b.updated_at ? `<lastmod>${String(b.updated_at).slice(0, 10)}</lastmod>` : ""}<changefreq>weekly</changefreq><priority>0.8</priority></url>`),
  ];
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`,
    { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } }
  );
}

const PRIVATE_PREFIXES = ["/admin", "/vendor", "/setup", "/invoice", "/checkout", "/order"];

function withSecurityHeaders(response, pathname) {
  const res = new Response(response.body, response);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (PRIVATE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    res.headers.set("X-Frame-Options", "DENY");
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
  } else {
    res.headers.set("X-Frame-Options", "SAMEORIGIN");
  }
  return res;
}

// ------------------------------------------------------------------- entry

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/")) {
      try {
        if (!env.DB) return json({ error: "Database binding DB is not configured" }, 500);
        await ensureSchema(env);
        return await handleApi(request, env, url, ctx);
      } catch (err) {
        return json({ error: "Server error", detail: String(err && err.message ? err.message : err) }, 500);
      }
    }

    if (pathname === "/sitemap.xml" && env.DB) {
      try { await ensureSchema(env); } catch (e) { /* sitemap still renders the static pages */ }
      return renderSitemap(env, url);
    }

    const bookMatch = pathname.match(/^\/books\/(\d+)(?:-[^/]*)?\/?$/);
    if (bookMatch && request.method === "GET" && env.DB) {
      try {
        await ensureSchema(env);
        return withSecurityHeaders(await renderBookPage(request, env, url, toInt(bookMatch[1])), pathname);
      } catch (e) {
        // Fall through to the plain page; it loads its data from /api/books/:id.
        const page = await env.ASSETS.fetch(new Request(new URL("/book/", url).toString()));
        return withSecurityHeaders(page, pathname);
      }
    }

    // Everything else: serve the static site (index.html, /books/, /admin, /vendor, ...)
    const res = await env.ASSETS.fetch(request);
    return withSecurityHeaders(res, pathname);
  },
};
