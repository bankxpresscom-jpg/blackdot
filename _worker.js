/**
 * Blackdot Publication: single-file Cloudflare Pages Worker
 * ------------------------------------------------------------
 * Handles every /api/* route below, then falls through to
 * env.ASSETS.fetch() for everything else (the static site,
 * /admin, /vendor, images, etc).
 *
 * Bindings this Worker expects (set in Pages → Settings):
 *   D1 database   : DB                (binding name must be exactly "DB")
 *   Email binding : EMAIL              (Cloudflare Email Service send binding,
 *                                       used for manuscript submissions)
 *   Env variable  : SEND_FROM_EMAIL    (a verified sender on your onboarded
 *                                       domain, e.g. no-reply@blackdotpublication.com)
 *   Env variable  : RAZORPAY_KEY_ID
 *   Secret        : RAZORPAY_KEY_SECRET
 *   Secret        : SESSION_SECRET     (any long random string, used to
 *                                       pepper password hashes)
 *   Env variable  : SETUP_TOKEN        (permanent token you choose, used to
 *                                       bootstrap the first main_admin and to
 *                                       reset any password later, see README)
 *
 * No npm dependencies. Pure Web Crypto + D1 + Cloudflare Email Service.
 */

const SESSION_COOKIE = "bd_session";
const SESSION_DAYS = 7;

// ---------------------------------------------------------------- utilities

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function badRequest(msg) { return json({ error: msg }, 400); }
function unauthorized(msg = "Unauthorized") { return json({ error: msg }, 401); }
function forbidden(msg = "Forbidden") { return json({ error: msg }, 403); }
function notFound(msg = "Not found") { return json({ error: msg }, 404); }

// Up to 5 image URLs per book (gallery). Trims, drops blanks, caps at 5.
function sanitizeImages(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((u) => (typeof u === "string" ? u.trim() : "")).filter(Boolean).slice(0, 5);
}
// The `images` column is stored as a JSON string; parse it back into an
// array for API responses, falling back to [cover_url] for older rows
// saved before this column existed.
function parseImages(row) {
  if (row.images) {
    try {
      const arr = JSON.parse(row.images);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (e) { /* fall through to cover_url fallback below */ }
  }
  return row.cover_url ? [row.cover_url] : [];
}
function withParsedImages(row) {
  return { ...row, images: parseImages(row) };
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
    "raw",
    enc.encode(password + (pepper || "")),
    "PBKDF2",
    false,
    ["deriveBits"]
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
    if (k) out[k] = decodeURIComponent(v);
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

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ------------------------------------------------------------- razorpay

async function razorpayCreateOrder(env, amountPaise, receipt) {
  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Razorpay order creation failed: ${text}`);
  }
  return res.json();
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bufToHex(sig);
}

// ------------------------------------------------------------------ routes

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  // ---------- create a main_admin, gated by SETUP_TOKEN. Works any number of ----------
  // times, not just once, so you can add more main admins later from the same
  // /setup page. Each admin still needs their own username and password.
  if (pathname === "/api/setup" && method === "POST") {
    const body = await readJson(request);
    if (!body || !body.setup_token || !body.username || !body.password) return badRequest("Missing fields");
    if (!env.SETUP_TOKEN || body.setup_token !== env.SETUP_TOKEN) return unauthorized("Invalid setup token");
    if (body.password.length < 8) return badRequest("Password must be at least 8 characters");
    const hash = await hashPassword(body.password, env.SESSION_SECRET);
    try {
      await env.DB.prepare(
        `INSERT INTO admins (username, password_hash, role, name) VALUES (?, ?, 'main_admin', ?)`
      ).bind(body.username, hash, body.name || "Main Admin").run();
    } catch (e) {
      return badRequest("That username is already taken, please choose another");
    }
    return json({ ok: true });
  }

  // ---------- password reset, works any time, gated by the same SETUP_TOKEN ----------
  // Use this if a main_admin or vendor forgets their password rather than
  // wants a brand new account. Both this and /api/setup share the same
  // SETUP_TOKEN gate, so keep that token safe.
  if (pathname === "/api/admin/reset-password" && method === "POST") {
    const body = await readJson(request);
    if (!body || !body.setup_token || !body.username || !body.new_password) return badRequest("Missing fields");
    if (!env.SETUP_TOKEN || body.setup_token !== env.SETUP_TOKEN) return unauthorized("Invalid setup token");
    if (body.new_password.length < 8) return badRequest("Password must be at least 8 characters");
    const admin = await env.DB.prepare(`SELECT * FROM admins WHERE username = ?`).bind(body.username).first();
    if (!admin) return notFound("No account with that username");
    const hash = await hashPassword(body.new_password, env.SESSION_SECRET);
    await env.DB.prepare(`UPDATE admins SET password_hash = ? WHERE id = ?`).bind(hash, admin.id).run();
    // Log every existing session out for this account once the password changes.
    await env.DB.prepare(`DELETE FROM sessions WHERE admin_id = ?`).bind(admin.id).run();
    return json({ ok: true, role: admin.role });
  }

  // ---------- auth ----------
  if (pathname === "/api/auth/login" && method === "POST") {
    const body = await readJson(request);
    if (!body || !body.username || !body.password) return badRequest("Missing username/password");
    const admin = await env.DB.prepare(
      `SELECT * FROM admins WHERE username = ? AND active = 1`
    ).bind(body.username).first();
    if (!admin) return unauthorized("Invalid credentials");
    const ok = await verifyPassword(body.password, admin.password_hash, env.SESSION_SECRET);
    if (!ok) return unauthorized("Invalid credentials");
    if (body.role && body.role !== admin.role) return forbidden("Wrong login portal for this account");
    const token = randomHex(32);
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    await env.DB.prepare(
      `INSERT INTO sessions (token, admin_id, role, expires_at) VALUES (?, ?, ?, ?)`
    ).bind(token, admin.id, admin.role, expires).run();
    return json(
      { ok: true, role: admin.role, name: admin.name, username: admin.username },
      200,
      { "Set-Cookie": setCookieHeader(token, SESSION_DAYS * 86400) }
    );
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    const cookies = parseCookies(request);
    const token = cookies[SESSION_COOKIE];
    if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
    return json({ ok: true }, 200, { "Set-Cookie": clearCookieHeader() });
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    const admin = await getSessionAdmin(request, env);
    if (!admin) return unauthorized();
    return json({ admin: { username: admin.username, role: admin.role, name: admin.name } });
  }

  // ---------- public: books ----------
  if (pathname === "/api/books" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, title, author, description, cover_url, images, price_paise, available, featured, amazon_url
       FROM books WHERE available = 1 ORDER BY featured DESC, created_at DESC`
    ).all();
    return json({ books: results.map(withParsedImages) });
  }

  // ---------- public: contact form ----------
  if (pathname === "/api/contact" && method === "POST") {
    const body = await readJson(request);
    if (!body || !body.name || !body.email || !body.message) return badRequest("Missing fields");
    await env.DB.prepare(
      `INSERT INTO leads (name, email, message) VALUES (?, ?, ?)`
    ).bind(String(body.name).slice(0, 200), String(body.email).slice(0, 200), String(body.message).slice(0, 4000)).run();
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

    const attachments = [];
    if (body.attachment && body.attachment.base64) {
      const approxBytes = body.attachment.base64.length * 0.75;
      if (approxBytes > 4.5 * 1024 * 1024) {
        return badRequest("That attachment is too large for email, please use the manuscript link field instead");
      }
      attachments.push({
        content: body.attachment.base64,
        filename: body.attachment.filename || "manuscript",
        type: body.attachment.mime || "application/octet-stream",
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
      await env.EMAIL.send({
        to: "info@blackdotpublication.com",
        from: env.SEND_FROM_EMAIL || "no-reply@blackdotpublication.com",
        subject: `New manuscript submission: ${body.book_title}`,
        html,
        text,
        headers: { "Reply-To": body.email },
        attachments,
      });
    } catch (e) {
      return json({ error: "Could not send your submission, please try again or WhatsApp us directly", detail: String(e && e.message ? e.message : e) }, 502);
    }

    await env.DB.prepare(
      `INSERT INTO manuscripts (name, email, phone, genre, book_title, message, manuscript_link, attachment_filename)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      body.name, body.email, body.phone, body.genre || "", body.book_title, body.message,
      body.manuscript_link || null, body.attachment ? body.attachment.filename : null
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

  // ---------- public: create a Razorpay order ----------
  if (pathname === "/api/razorpay/create-order" && method === "POST") {
    const body = await readJson(request);
    const required = ["book_id", "buyer_name", "buyer_phone", "shipping_address"];
    if (!body || required.some((k) => !body[k])) return badRequest("Missing required fields");
    const qty = Math.max(1, parseInt(body.quantity || 1, 10));
    const book = await env.DB.prepare(`SELECT * FROM books WHERE id = ? AND available = 1`).bind(body.book_id).first();
    if (!book) return notFound("Book not available");
    const amount = book.price_paise * qty;

    const insert = await env.DB.prepare(
      `INSERT INTO orders (book_id, buyer_name, buyer_email, buyer_phone, shipping_address, quantity, amount_paise, payment_status, fulfillment_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'created', 'Received')`
    ).bind(book.id, body.buyer_name, body.buyer_email || null, body.buyer_phone, body.shipping_address, qty, amount).run();
    const orderId = insert.meta.last_row_id;

    let rzpOrder;
    try {
      rzpOrder = await razorpayCreateOrder(env, amount, `bd_${orderId}`);
    } catch (e) {
      return json({ error: "Payment gateway error", detail: String(e) }, 502);
    }
    await env.DB.prepare(`UPDATE orders SET razorpay_order_id = ? WHERE id = ?`).bind(rzpOrder.id, orderId).run();

    return json({
      order_id: orderId,
      razorpay_order_id: rzpOrder.id,
      amount,
      currency: "INR",
      key_id: env.RAZORPAY_KEY_ID,
      book_title: book.title,
    });
  }

  // ---------- public: verify payment ----------
  if (pathname === "/api/razorpay/verify" && method === "POST") {
    const body = await readJson(request);
    const required = ["order_id", "razorpay_order_id", "razorpay_payment_id", "razorpay_signature"];
    if (!body || required.some((k) => !body[k])) return badRequest("Missing fields");

    const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(body.order_id).first();
    if (!order || order.razorpay_order_id !== body.razorpay_order_id) return notFound("Order not found");

    const expected = await hmacHex(env.RAZORPAY_KEY_SECRET, `${body.razorpay_order_id}|${body.razorpay_payment_id}`);
    if (!timingSafeEqual(expected, body.razorpay_signature)) {
      await env.DB.prepare(`UPDATE orders SET payment_status = 'failed' WHERE id = ?`).bind(order.id).run();
      return badRequest("Signature verification failed");
    }
    await env.DB.prepare(
      `UPDATE orders SET payment_status = 'paid', razorpay_payment_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(body.razorpay_payment_id, order.id).run();
    return json({ ok: true });
  }

  // ---------- main admin: book management ----------
  if (pathname === "/api/admin/books" && method === "POST") {
    const { error, admin } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const b = await readJson(request);
    if (!b || !b.title || !b.author || !b.price_paise) return badRequest("Missing required fields");
    const images = sanitizeImages(b.images);
    if (!images.length) return badRequest("At least one image URL is required");
    const r = await env.DB.prepare(
      `INSERT INTO books (title, author, description, cover_url, images, price_paise, available, featured, amazon_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      b.title, b.author, b.description || "", images[0], JSON.stringify(images), b.price_paise,
      b.available ? 1 : 0, b.featured ? 1 : 0, b.amazon_url || ""
    ).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }

  const bookIdMatch = pathname.match(/^\/api\/admin\/books\/(\d+)$/);
  if (bookIdMatch && (method === "PUT" || method === "DELETE")) {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const id = bookIdMatch[1];
    if (method === "DELETE") {
      await env.DB.prepare(`DELETE FROM books WHERE id = ?`).bind(id).run();
      return json({ ok: true });
    }
    const b = await readJson(request);
    if (!b) return badRequest("Missing body");
    const images = sanitizeImages(b.images);
    if (!images.length) return badRequest("At least one image URL is required");
    await env.DB.prepare(
      `UPDATE books SET title=?, author=?, description=?, cover_url=?, images=?, price_paise=?, available=?, featured=?, amazon_url=?, updated_at=datetime('now')
       WHERE id=?`
    ).bind(
      b.title, b.author, b.description || "", images[0], JSON.stringify(images), b.price_paise,
      b.available ? 1 : 0, b.featured ? 1 : 0, b.amazon_url || "", id
    ).run();
    return json({ ok: true });
  }

  // ---------- main admin: all books incl. unavailable (for the dashboard table) ----------
  if (pathname === "/api/admin/books-all" && method === "GET") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const { results } = await env.DB.prepare(`SELECT * FROM books ORDER BY created_at DESC`).all();
    return json({ books: results.map(withParsedImages) });
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
    const hash = await hashPassword(b.password, env.SESSION_SECRET);
    try {
      const r = await env.DB.prepare(
        `INSERT INTO admins (username, password_hash, role, name) VALUES (?, ?, 'vendor', ?)`
      ).bind(b.username, hash, b.name || b.username).run();
      return json({ ok: true, id: r.meta.last_row_id });
    } catch (e) {
      return badRequest("Username may already be taken");
    }
  }

  // ---------- main admin: orders ----------
  if (pathname === "/api/admin/orders" && method === "GET") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const { results } = await env.DB.prepare(
      `SELECT o.*, b.title as book_title, v.name as vendor_name
       FROM orders o
       JOIN books b ON b.id = o.book_id
       LEFT JOIN admins v ON v.id = o.assigned_vendor_id
       ORDER BY o.created_at DESC`
    ).all();
    return json({ orders: results });
  }

  const adminOrderMatch = pathname.match(/^\/api\/admin\/orders\/(\d+)$/);
  if (adminOrderMatch && method === "PUT") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    const id = adminOrderMatch[1];
    const b = await readJson(request);
    if (!b) return badRequest("Missing body");
    const fields = [];
    const values = [];
    if (b.fulfillment_status) { fields.push("fulfillment_status = ?"); values.push(b.fulfillment_status); }
    if (b.assigned_vendor_id !== undefined) { fields.push("assigned_vendor_id = ?"); values.push(b.assigned_vendor_id); }
    if (!fields.length) return badRequest("Nothing to update");
    fields.push("updated_at = datetime('now')");
    values.push(id);
    await env.DB.prepare(`UPDATE orders SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
    return json({ ok: true });
  }
  if (adminOrderMatch && method === "DELETE") {
    const { error } = await requireRole(request, env, ["main_admin"]);
    if (error) return error;
    await env.DB.prepare(`DELETE FROM orders WHERE id = ?`).bind(adminOrderMatch[1]).run();
    return json({ ok: true });
  }

  // ---------- vendor: assigned orders ----------
  if (pathname === "/api/vendor/orders" && method === "GET") {
    const { error, admin } = await requireRole(request, env, ["vendor"]);
    if (error) return error;
    const { results } = await env.DB.prepare(
      `SELECT o.id, o.buyer_name, o.buyer_phone, o.shipping_address, o.quantity, o.fulfillment_status, o.created_at, b.title as book_title
       FROM orders o JOIN books b ON b.id = o.book_id
       WHERE o.assigned_vendor_id = ? AND o.payment_status = 'paid'
       ORDER BY o.created_at DESC`
    ).bind(admin.id).all();
    return json({ orders: results });
  }

  const STAGES = ["Received", "Processing", "Sent", "Delivered"];
  const vendorOrderMatch = pathname.match(/^\/api\/vendor\/orders\/(\d+)\/status$/);
  if (vendorOrderMatch && method === "PUT") {
    const { error, admin } = await requireRole(request, env, ["vendor"]);
    if (error) return error;
    const id = vendorOrderMatch[1];
    const b = await readJson(request);
    if (!b || !b.status) return badRequest("Missing status");
    const order = await env.DB.prepare(
      `SELECT * FROM orders WHERE id = ? AND assigned_vendor_id = ?`
    ).bind(id, admin.id).first();
    if (!order) return notFound("Order not found");
    const currentIdx = STAGES.indexOf(order.fulfillment_status);
    const nextIdx = STAGES.indexOf(b.status);
    if (nextIdx === -1) return badRequest("Invalid status");
    if (nextIdx !== currentIdx + 1) return forbidden(`Orders can only move forward, one stage at a time (${STAGES.join(" → ")})`);
    await env.DB.prepare(
      `UPDATE orders SET fulfillment_status = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(b.status, id).run();
    return json({ ok: true });
  }

  return notFound("Unknown API route");
}

// ------------------------------------------------------------------- entry

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: "Server error", detail: String(err && err.message ? err.message : err) }, 500);
      }
    }
    // Everything else: serve the static site (index.html, /admin, /vendor, images, css, js)
    return env.ASSETS.fetch(request);
  },
};
