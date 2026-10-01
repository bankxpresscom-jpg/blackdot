# Blackdot Publication: full system

Everything in this folder is one Cloudflare Pages project:

```
index.html          → public 1-pager (site)
publish/index.html  → manuscript submission / publishing enquiry page
admin/index.html    → Main Admin Panel   (blackdotpublication.com/admin)
vendor/index.html   → Vendor Admin Panel (blackdotpublication.com/vendor)
setup/index.html    → one-time admin creation + password reset
_worker.js           → single-file backend: auth, books, orders, Razorpay, contact, manuscript email
schema.sql           → D1 tables + seed row for "Ishq Afsari"
robots.txt           → search engine crawl rules
sitemap.xml           → public page listing for search engines
```

`_worker.js` sits in Advanced Mode: every request to `/api/*` is handled by
the Worker; everything else (the HTML pages, images, robots.txt, sitemap.xml)
falls through to `env.ASSETS.fetch(request)`, i.e. the static files in this
same folder. That's why you only ever deploy **one zip**, with no separate
`/functions` directory needed.

---

## 1. Create the D1 database

Cloudflare dashboard → **Workers & Pages → D1 → Create database** → name it
e.g. `blackdot_db`.

Open its **Console** tab and paste the entire contents of `schema.sql`, then
run it. This creates the tables and inserts the "Ishq Afsari" row.

**Already deployed once before?** Don't re-run the whole file, it would try
to insert a duplicate row. Skip to "Migrating an existing database" near the
end of this file instead, and run only the small snippet there.

---

## 2. Create the Pages project and upload the zip

1. Zip the **contents** of this folder, not the folder itself. `index.html`,
   `_worker.js`, `schema.sql`, `admin/`, `vendor/`, `publish/`, `setup/`,
   `robots.txt`, `sitemap.xml` should all be at the zip root.
2. Dashboard → **Workers & Pages → Create → Pages → Upload assets** →
   upload the zip → name the project (e.g. `blackdot-publication`).
3. After the first deploy finishes, go to the project's **Settings → Functions**
   and confirm **Compatibility flags/date** are recent (any 2024+ date works).

---

## 3. Bind the D1 database

Project → **Settings → Bindings → Add → D1 database**
- Variable name: `DB`   ← must be exactly this, `_worker.js` reads `env.DB`
- Database: `blackdot_db`

---

## 4. Set environment variables / secrets

Project → **Settings → Environment variables** (set for both *Production*
and *Preview* if you use preview deploys):

| Name | Type | Value |
|---|---|---|
| `RAZORPAY_KEY_ID` | Plaintext | your Razorpay **Key ID** (`rzp_live_...` or `rzp_test_...`) |
| `RAZORPAY_KEY_SECRET` | **Secret** | your Razorpay **Key Secret** |
| `SESSION_SECRET` | **Secret** | any long random string (e.g. generate 40 random characters), used to pepper password hashes |
| `SETUP_TOKEN` | **Secret** | a password *you* invent. Used to create the first admin login (step 6) and also doubles as your permanent password reset key, so store it somewhere safe like a password manager |
| `SEND_FROM_EMAIL` | Plaintext | the address manuscript emails are sent from, e.g. `no-reply@blackdotpublication.com`. Must belong to the domain you onboard in step 5 |

Never put these in the HTML or JS. The worker is the only place that reads
`env.RAZORPAY_KEY_SECRET`. The public checkout page only ever receives
`RAZORPAY_KEY_ID`, which is meant to be public.

Redeploy (or trigger a new upload) after setting these so the Worker picks
them up.

---

## 5. Set up Email Sending (for manuscript submissions)

The Publish page emails every submission, with the manuscript attached,
straight to info@blackdotpublication.com. This uses Cloudflare's own Email
Service rather than a third-party provider, so there's nothing extra to sign
up for.

1. Dashboard → **Compute → Email Service → Email Sending → Onboard Domain**
   → choose `blackdotpublication.com`. Cloudflare adds the SPF/DKIM DNS
   records it needs automatically since your domain already lives on
   Cloudflare.
2. Once the domain shows as verified, go back to your Pages project →
   **Settings → Bindings → Add → Email binding** (sometimes listed under
   "Send Email"):
   - Variable name: `EMAIL`   ← must be exactly this, `_worker.js` reads `env.EMAIL`
   - Restrict senders to the address you set as `SEND_FROM_EMAIL` if the
     dashboard offers that option, it's an easy extra safety net.
3. Redeploy so the binding takes effect.

Test it by visiting `/publish/` yourself and submitting a small test file,
you should see it land in the info@ inbox within a minute, with the
attachment included.

---

## 6. Create your Main Admin login, all in the browser

Visit **`https://blackdotpublication.com/setup`**, a simple form. Fill in:

- **Setup Token**: the value you set as `SETUP_TOKEN` in step 4
- **Your Name**, **Admin Username**, **Admin Password**

Submit, and it creates a `main_admin` account directly through
`/api/setup`. No terminal needed.

This is not one-time, you can come back to this same page later and create
more main admin accounts the same way, just use a different username each
time. That's convenient if you want to give a co-founder or a second team
member their own login, but it also means anyone holding `SETUP_TOKEN` can
create a new admin account whenever they want. Treat that token the same way
you'd treat a master password, and delete or rotate it in the Cloudflare
dashboard if you ever suspect it's been shared or leaked.

Log in at **`/admin`** with the username/password you just created.

### If a password is ever forgotten

The `/setup` page has a second tab, **Reset Password**, sitting right next
to Create Main Admin. It resets the password for any existing username you
give it, whether that's a main admin or a vendor, rather than creating a new
account. It's gated by the same `SETUP_TOKEN`, so as long as you still have
that value saved somewhere, you can always get back in. This is also why
`SETUP_TOKEN` is worth keeping in a password manager rather than just in
your head. If you ever lose `SETUP_TOKEN` itself, you'd need to open the D1
console in the Cloudflare dashboard and update the `admins` table directly,
which is a lot more manual, so keeping the token safe is the
easier path.

---

## 7. Add print vendors

From the Main Admin panel → **Vendors** tab → **Add Vendor**. Share the
username/password you set with your printer. They log in at **`/vendor`**
and only ever see orders you assign to them, moving each one forward through
**Received → Processing → Sent → Delivered** (one stage at a time, no
skipping, no going back. That's enforced server-side, not just in the UI).

---

## 8. Add book titles

Main Admin → **Books** tab → **Add Title**. Paste up to 5 Cloudinary (or any
public) image URLs — the first is used as the cover thumbnail everywhere,
and if you add more than one, visitors can swipe through all of them on the
homepage (both the featured hero slot and the grid cards). Mark **Featured**
to make a title appear in the large hero book slot on the homepage instead
of the grid. The public site pulls this live from `/api/books`, so no
redeploy is needed when you add or edit a title. There is a single **Buy
Now** flow for every title, there's no Amazon link anywhere on the
storefront.

Main Admin → **Orders** tab → **Download Excel** exports every order
currently loaded (buyer, address, quantity, amount, payment/fulfilment
status, assigned vendor, Razorpay IDs) as an `.xlsx` file you can open
directly in Excel or Google Sheets.

---

## How orders flow end to end

1. Visitor clicks **Buy Now** → fills quantity/name/phone/address →
   `POST /api/razorpay/create-order` creates a D1 order row (`payment_status:
   created`) and a matching Razorpay order.
2. Razorpay Checkout opens client-side with the public `key_id` only.
3. On successful payment, the browser calls `POST /api/razorpay/verify`,
   which recomputes the HMAC signature server-side with your secret key and
   only then marks the order `paid`.
4. Paid orders show up in **Main Admin → Orders**, showing the order date,
   the buyer's shipping address, and the fulfillment status, where you set
   the fulfillment status and/or assign a vendor.
5. The assigned vendor sees the order in **/vendor** and can only push it
   forward one stage at a time.

If Razorpay isn't configured yet (keys missing), `create-order` will return
a 502 with the gateway error, and the person can still reach you directly
through the WhatsApp button while you sort it out.

Every row in the Orders table has a **Delete** button, useful for clearing
out test orders you placed while trying the site yourself. Deleting an order
only removes that database row, it doesn't refund or cancel anything with
Razorpay, so only use it for orders that were never real (test payments or
duplicates), not to hide a real customer's order.

---

## How manuscript submissions flow

1. An author fills the form at **`/publish/`**: contact details, book title,
   genre, message, and either an attached file (up to 4 MB in the browser) or
   a link to a larger file hosted elsewhere.
2. The browser converts the attached file to base64 and posts it to
   `POST /api/manuscript-submission`.
3. The Worker emails info@blackdotpublication.com through Cloudflare's Email
   Service, with the file attached and the author's address set as
   Reply-To, so you can just hit reply.
4. The submission is also saved to the `manuscripts` table in D1, visible
   under **Main Admin → Manuscripts**, as a running record alongside the
   email.

Cloudflare's Email Service caps a message (including attachments) at 5 MiB
total, and file attachments grow by about a third once base64-encoded, so
the form warns authors above 4 MB and asks for a shareable link instead.

---

## Migrating an existing database

You already ran `schema.sql` once and created your admin login, so don't
run the full file again. Open the D1 **Console** tab for `blackdot_db` and
run this instead:

```sql
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

UPDATE books
SET cover_url = 'https://res.cloudinary.com/dhn6pvsr1/image/upload/v1784984695/WhatsApp_Image_2026-07-17_at_11.35.52_AM_wjvpyk.jpg',
    price_paise = 19900,
    updated_at = datetime('now')
WHERE title = 'Ishq Afsari';
```

That creates the new table for manuscript records and updates the existing
"Ishq Afsari" row to the new cover and the new ₹199 price. Everything else
in `schema.sql` (the `admins`, `sessions`, `orders`, `leads` tables) is
untouched, so your existing admin login and any orders already placed are
unaffected.

### Adding the multi-image (gallery) column

If your database was created before the "up to 5 images per book" feature
was added, run this once too (also safe, only adds a column):

```sql
ALTER TABLE books ADD COLUMN images TEXT;
```

Existing titles will keep working immediately, showing their current
`cover_url` as a single image, until you re-save them from **Main Admin →
Books → Edit** with additional image links filled in.

---

## Redeploying after edits

Since you deploy by zip upload rather than the CLI: edit files locally,
re-zip the same folder contents, and upload again from the project's
**Deployments** tab (**Create deployment → Upload assets**). The D1 binding,
Email binding, and environment variables carry over automatically between
deployments, you only need to touch them once.
