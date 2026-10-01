/* Blackdot Publication: shared storefront helpers.
   Cart (localStorage), API calls, money/stars formatting, the store header,
   the slide-in cart drawer and toasts. Exposed as window.BD. */
(function () {
  'use strict';

  const CART_KEY = 'bd_cart_v1';
  const BUYNOW_KEY = 'bd_buynow_v1';
  const ORDERS_KEY = 'bd_my_orders_v1';
  const MAX_QTY = 10;
  const LOGO = 'https://res.cloudinary.com/dhn6pvsr1/image/upload/v1784738286/Logo_nwdku8.png';
  const WHATSAPP = '917742588678';

  // ---------- icons (stroke = currentColor) ----------
  const svg = (inner, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${inner}</svg>`;
  const ICONS = {
    cart: svg('<path d="M3 4h2l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.7a1.5 1.5 0 0 0 1.5-1.1L21 8H6.2"/><circle cx="9.5" cy="20" r="1.3"/><circle cx="17.5" cy="20" r="1.3"/>'),
    search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
    menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    check: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.6 2.6L16.5 9"/>'),
    alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>'),
    truck: svg('<path d="M3 6h11v9H3zM14 9h4l3 3v3h-7z"/><circle cx="7" cy="17.5" r="1.7"/><circle cx="17.5" cy="17.5" r="1.7"/>'),
    shield: svg('<path d="M12 3l7 3v5c0 5-3.5 8.3-7 9.5C8.5 19.3 5 16 5 11V6z"/><path d="M9 12l2 2 4-4"/>'),
    returns: svg('<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.7M20 4v4.7h-4.7M20 12a8 8 0 0 1-13.7 5.6L4 15.3M4 20v-4.7h4.7"/>'),
    lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
    book: svg('<path d="M4 5c3-1.4 6-1.4 8 0v14c-2-1.4-5-1.4-8 0zM20 5c-3-1.4-6-1.4-8 0v14c2-1.4 5-1.4 8 0z"/>'),
    chat: svg('<path d="M4 12a8 8 0 1 1 4.6 7.2L4 20l1.2-4.4A8 8 0 0 1 4 12z"/><path d="M8.5 10.5h7M8.5 13.5H13"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    eye: svg('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.7"/>'),
    share: svg('<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1"/>'),
    pin: svg('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
    external: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
    print: svg('<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3"/><rect x="7" y="14" width="10" height="7"/>'),
    copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.6l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>',
  };

  // ---------- formatting ----------
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const money = (paise) => '₹' + (Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });

  // Cloudinary URLs get automatic format/quality and a sensible width.
  function img(url, w) {
    if (!url) return '';
    const m = String(url).match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.*)$/);
    if (!m) return url;
    const first = m[2].split('/')[0];
    const hasTransform = /(^|,)(w|h|c|f|q)_/.test(first);
    if (hasTransform) return url;
    return `${m[1]}f_auto,q_auto${w ? ',w_' + w : ''}/${m[2]}`;
  }

  function stars(avg, size) {
    const pct = Math.max(0, Math.min(100, (Number(avg) || 0) / 5 * 100));
    const five = ICONS.star.repeat(5);
    return `<span class="bd-stars" style="--s:${size || 15}px" role="img" aria-label="${(Number(avg) || 0).toFixed(1)} out of 5 stars">` +
      `<span class="bd-stars-base">${five}</span><span class="bd-stars-fill" style="width:${pct}%">${five}</span></span>`;
  }

  function addDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d;
  }
  const fmtDate = (d, opts) => d.toLocaleDateString('en-IN', opts || { day: 'numeric', month: 'short', year: 'numeric' });
  function deliveryBy(cfg) {
    const max = parseInt((cfg && cfg.delivery_max_days) || 10, 10);
    return fmtDate(addDays(max));
  }
  function deliveryRange(cfg) {
    const min = parseInt((cfg && cfg.delivery_min_days) || 5, 10);
    const max = parseInt((cfg && cfg.delivery_max_days) || 10, 10);
    const a = addDays(min), b = addDays(max);
    const sameMonth = a.getMonth() === b.getMonth();
    return sameMonth
      ? `${a.getDate()} – ${fmtDate(b)}`
      : `${fmtDate(a, { day: 'numeric', month: 'short' })} – ${fmtDate(b)}`;
  }
  function fmtDateTime(s) {
    if (!s) return '';
    // D1 datetime('now') is UTC without a zone marker.
    const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : String(s).replace(' ', 'T') + 'Z');
    return isNaN(d) ? s : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function fmtDay(s) {
    if (!s) return '';
    const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : String(s).replace(' ', 'T') + 'Z');
    return isNaN(d) ? s : fmtDate(d);
  }

  // ---------- storage (never throws, e.g. in private mode) ----------
  function readStore(key, fallback, storage) {
    try {
      const raw = (storage || localStorage).getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeStore(key, value, storage) {
    try { (storage || localStorage).setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  // ---------- API ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Please try again.');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  let booksPromise = null;
  function books() {
    if (!booksPromise) {
      booksPromise = api('/api/books').then((d) => d.books || []).catch((e) => { booksPromise = null; throw e; });
    }
    return booksPromise;
  }
  const CONFIG_DEFAULTS = { shipping_flat_paise: '0', free_shipping_above_paise: '0', delivery_min_days: '5', delivery_max_days: '10', states: [] };
  let configPromise = null;
  function config() {
    if (!configPromise) {
      configPromise = api('/api/store-config').then((c) => ({ ...CONFIG_DEFAULTS, ...c })).catch(() => ({ ...CONFIG_DEFAULTS }));
    }
    return configPromise;
  }
  function shippingFor(subtotal, cfg) {
    const flat = parseInt(cfg.shipping_flat_paise || 0, 10);
    const freeAbove = parseInt(cfg.free_shipping_above_paise || 0, 10);
    if (flat <= 0) return 0;
    if (freeAbove > 0 && subtotal >= freeAbove) return 0;
    return flat;
  }

  // ---------- cart ----------
  function cleanLines(lines) {
    if (!Array.isArray(lines)) return [];
    const seen = new Map();
    for (const l of lines) {
      const id = parseInt(l && l.id, 10);
      const qty = Math.min(MAX_QTY, Math.max(1, parseInt(l && l.qty, 10) || 1));
      if (id > 0) seen.set(id, qty);
    }
    return [...seen].map(([id, qty]) => ({ id, qty }));
  }
  const cart = {
    get() { return cleanLines(readStore(CART_KEY, [])); },
    save(lines) {
      writeStore(CART_KEY, cleanLines(lines));
      document.dispatchEvent(new CustomEvent('bd:cart'));
    },
    add(id, qty = 1) {
      const lines = cart.get();
      const line = lines.find((l) => l.id === id);
      if (line) line.qty = Math.min(MAX_QTY, line.qty + qty);
      else lines.push({ id, qty: Math.min(MAX_QTY, qty) });
      cart.save(lines);
    },
    set(id, qty) {
      cart.save(cart.get().map((l) => (l.id === id ? { id, qty } : l)));
    },
    remove(id) { cart.save(cart.get().filter((l) => l.id !== id)); },
    clear() { cart.save([]); },
    count() { return cart.get().reduce((s, l) => s + l.qty, 0); },
    has(id) { return cart.get().some((l) => l.id === id); },
  };
  window.addEventListener('storage', (e) => {
    if (e.key === CART_KEY) document.dispatchEvent(new CustomEvent('bd:cart'));
  });

  // "Buy Now" checks out a single title without touching the saved cart.
  const buyNow = {
    start(id, qty) {
      writeStore(BUYNOW_KEY, [{ id, qty }], sessionStorage);
      location.href = '/checkout/?mode=buynow';
    },
    get() { return cleanLines(readStore(BUYNOW_KEY, [], sessionStorage)); },
    save(lines) { writeStore(BUYNOW_KEY, cleanLines(lines), sessionStorage); },
    clear() { try { sessionStorage.removeItem(BUYNOW_KEY); } catch (e) { /* ignore */ } },
  };

  const myOrders = {
    get() { return readStore(ORDERS_KEY, []); },
    add(o) {
      const list = myOrders.get().filter((x) => x.id !== o.id);
      list.unshift(o);
      writeStore(ORDERS_KEY, list.slice(0, 20));
    },
  };

  // ---------- toast ----------
  function toast(message, opts = {}) {
    let wrap = document.querySelector('.bd-toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'bd-toast-wrap';
      wrap.setAttribute('role', 'status');
      wrap.setAttribute('aria-live', 'polite');
      document.body.appendChild(wrap);
    }
    const el = document.createElement('div');
    el.className = 'bd-toast' + (opts.error ? ' error' : '');
    el.innerHTML = (opts.error ? ICONS.alert : ICONS.check) + `<span>${esc(message)}</span>`;
    if (opts.action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = opts.action.label;
      b.addEventListener('click', () => { opts.action.onClick(); dismiss(); });
      el.appendChild(b);
    }
    wrap.appendChild(el);
    const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
    setTimeout(dismiss, opts.duration || 3600);
  }

  // ---------- header / menu ----------
  function header(active) {
    const links = [
      ['home', '/', 'Home'],
      ['books', '/books/', 'Books'],
      ['publish', '/publish/', 'Publish With Us'],
      ['track', '/order/', 'Track Order'],
      ['about', '/about-us/', 'About Us'],
      ['contact', '/contact-us/', 'Contact'],
    ];
    const nav = links.map(([k, href, label]) => `<a href="${href}"${k === active ? ' class="active" aria-current="page"' : ''}>${label}</a>`).join('');
    const html = `
      <header class="bd-header">
        <div class="bd-header-top">
          <a href="/" class="bd-header-brand" aria-label="Blackdot Publication home"><img src="${LOGO}" alt="Blackdot Publication" width="140" height="40"></a>
          <div class="bd-header-actions">
            <button class="bd-icon-btn" type="button" data-bd-search aria-label="Search books">${ICONS.search}</button>
            <button class="bd-icon-btn" type="button" data-bd-cart aria-label="Open cart">${ICONS.cart}<span class="bd-cart-badge" data-bd-badge>0</span></button>
            <button class="bd-icon-btn" type="button" data-bd-menu aria-label="Open menu">${ICONS.menu}</button>
          </div>
        </div>
        <div class="bd-search-bar" data-bd-searchbar>
          <form action="/books/" method="get" role="search">
            <input type="search" name="q" placeholder="Search by title or author" aria-label="Search books">
            <button class="bd-btn bd-btn-dark bd-btn-sm" type="submit">Search</button>
          </form>
        </div>
        <nav class="bd-nav" aria-label="Store">${nav}</nav>
      </header>`;
    document.currentScript
      ? document.currentScript.insertAdjacentHTML('beforebegin', html)
      : document.body.insertAdjacentHTML('afterbegin', html);
    const menuHtml = `
      <div class="bd-menu-overlay" data-bd-menu-close></div>
      <nav class="bd-menu" aria-label="Mobile menu" aria-hidden="true">
        <div class="bd-menu-head"><span>Blackdot</span><button class="bd-icon-btn" type="button" data-bd-menu-close aria-label="Close menu">${ICONS.close}</button></div>
        ${links.map(([, href, label]) => `<a href="${href}">${label}</a>`).join('')}
        <div class="bd-menu-foot">Blackdot Publication · Where Every Story Leaves a Mark.</div>
      </nav>`;
    document.body.insertAdjacentHTML('beforeend', menuHtml);
    wireChrome();
  }

  function footer() {
    const year = new Date().getFullYear();
    const html = `
      <footer class="bd-footer">
        <div class="bd-footer-inner">
          <div><img src="${LOGO}" alt="Blackdot Publication"><p>An independent Indian publishing house. Every book we publish is printed and dispatched with care, from our hands to yours.</p></div>
          <div><h5>Shop</h5><ul><li><a href="/books/">All Books</a></li><li><a href="/order/">Track Your Order</a></li><li><a href="/checkout/">Checkout</a></li><li><a href="/publish/">Publish With Us</a></li></ul></div>
          <div><h5>Policies</h5><ul><li><a href="/shipping-policy/">Shipping Policy</a></li><li><a href="/refund-policy/">Refund &amp; Cancellation</a></li><li><a href="/privacy-policy/">Privacy Policy</a></li><li><a href="/terms-and-conditions/">Terms &amp; Conditions</a></li></ul></div>
          <div><h5>Get In Touch</h5><ul><li><a href="mailto:info@blackdotpublication.com">info@blackdotpublication.com</a></li><li><a href="tel:+917742588678">+91 77425 88678</a></li><li><a href="https://wa.me/${WHATSAPP}" target="_blank" rel="noopener">Chat on WhatsApp</a></li></ul></div>
        </div>
        <div class="bd-footer-bottom"><span>Blackdot Publication · © ${year} All rights reserved.</span><span>Secure payments by Razorpay</span></div>
      </footer>`;
    document.currentScript
      ? document.currentScript.insertAdjacentHTML('beforebegin', html)
      : document.body.insertAdjacentHTML('beforeend', html);
  }

  let chromeWired = false;
  function wireChrome() {
    if (chromeWired) return;
    chromeWired = true;
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-bd-cart],[data-bd-menu],[data-bd-menu-close],[data-bd-search],[data-bd-drawer-close]');
      if (!t) return;
      if (t.hasAttribute('data-bd-cart')) { e.preventDefault(); openCart(); }
      else if (t.hasAttribute('data-bd-menu')) toggleMenu(true);
      else if (t.hasAttribute('data-bd-menu-close')) toggleMenu(false);
      else if (t.hasAttribute('data-bd-drawer-close')) closeCart();
      else if (t.hasAttribute('data-bd-search')) {
        if (location.pathname === '/books/' && document.getElementById('book-search')) {
          const s = document.getElementById('book-search');
          s.focus();
          s.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        const bar = document.querySelector('[data-bd-searchbar]');
        if (bar) { bar.classList.toggle('open'); if (bar.classList.contains('open')) bar.querySelector('input').focus(); }
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { toggleMenu(false); closeCart(); }
    });
    document.addEventListener('bd:cart', updateBadge);
    updateBadge();
  }
  function toggleMenu(open) {
    const menu = document.querySelector('.bd-menu');
    const overlay = document.querySelector('.bd-menu-overlay');
    if (!menu) return;
    menu.classList.toggle('open', open);
    overlay.classList.toggle('open', open);
    menu.setAttribute('aria-hidden', open ? 'false' : 'true');
    document.documentElement.style.overflow = open ? 'hidden' : '';
  }
  let lastCount = null;
  function updateBadge() {
    const n = cart.count();
    document.querySelectorAll('[data-bd-badge]').forEach((b) => {
      b.textContent = n > 99 ? '99+' : String(n);
      b.classList.toggle('show', n > 0);
      if (lastCount !== null && n > lastCount) {
        b.classList.remove('bump');
        void b.offsetWidth;
        b.classList.add('bump');
      }
    });
    lastCount = n;
  }

  // ---------- cart drawer ----------
  function ensureDrawer() {
    let drawer = document.querySelector('.bd-drawer');
    if (drawer) return drawer;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="bd-drawer-overlay" data-bd-drawer-close></div>
      <aside class="bd-drawer" role="dialog" aria-modal="true" aria-label="Your cart" aria-hidden="true">
        <div class="bd-drawer-head"><h3>Your Cart</h3><button class="bd-icon-btn" type="button" data-bd-drawer-close aria-label="Close cart">${ICONS.close}</button></div>
        <div class="bd-drawer-body"></div>
        <div class="bd-drawer-foot"></div>
      </aside>`);
    drawer = document.querySelector('.bd-drawer');
    document.addEventListener('bd:cart', () => { if (drawer.classList.contains('open')) renderDrawer(); });
    return drawer;
  }
  function openCart() {
    const drawer = ensureDrawer();
    wireChrome();
    renderDrawer();
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    document.querySelector('.bd-drawer-overlay').classList.add('open');
    document.documentElement.style.overflow = 'hidden';
    setTimeout(() => { const c = drawer.querySelector('[data-bd-drawer-close]'); if (c) c.focus(); }, 50);
  }
  function closeCart() {
    const drawer = document.querySelector('.bd-drawer');
    if (!drawer || !drawer.classList.contains('open')) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    document.querySelector('.bd-drawer-overlay').classList.remove('open');
    document.documentElement.style.overflow = '';
  }
  async function renderDrawer() {
    const drawer = ensureDrawer();
    const body = drawer.querySelector('.bd-drawer-body');
    const foot = drawer.querySelector('.bd-drawer-foot');
    const lines = cart.get();
    if (!lines.length) {
      body.innerHTML = `<div class="bd-drawer-empty">${ICONS.book}<h4>Your cart is empty</h4><p>Find your next favourite story.</p></div>`;
      foot.innerHTML = `<a class="bd-btn bd-btn-dark bd-btn-block" href="/books/">Browse Books</a>`;
      return;
    }
    let list, cfg;
    try { [list, cfg] = await Promise.all([books(), config()]); }
    catch (e) {
      body.innerHTML = `<div class="bd-drawer-empty"><h4>Couldn't load your cart</h4><p>Please check your connection and try again.</p></div>`;
      foot.innerHTML = '';
      return;
    }
    const resolved = [];
    for (const l of lines) {
      const b = list.find((x) => x.id === l.id);
      if (b && !b.coming_soon && b.in_stock) resolved.push({ ...l, book: b });
    }
    if (resolved.length !== lines.length) {
      cart.save(resolved.map(({ id, qty }) => ({ id, qty })));
      return;
    }
    const subtotal = resolved.reduce((s, l) => s + l.book.price_paise * l.qty, 0);
    const shipping = shippingFor(subtotal, cfg);
    body.innerHTML = resolved.map((l) => `
      <div class="bd-line" data-id="${l.id}">
        <a href="${esc(l.book.url)}"><img src="${esc(img(l.book.images[0] || l.book.cover_url, 160))}" alt=""></a>
        <div>
          <a class="bd-line-title" href="${esc(l.book.url)}">${esc(l.book.title)}</a>
          <div class="bd-line-author">by ${esc(l.book.author)}</div>
          ${stepperHtml(l.qty)}
        </div>
        <div><div class="bd-line-price">${money(l.book.price_paise * l.qty)}</div><button class="bd-line-remove" type="button" data-remove>Remove</button></div>
      </div>`).join('');
    const freeAbove = parseInt(cfg.free_shipping_above_paise || 0, 10);
    const note = shipping > 0 && freeAbove > subtotal
      ? `<div class="bd-drawer-note">Add ${money(freeAbove - subtotal)} more for free delivery.</div>` : '';
    foot.innerHTML = `${note}
      <div class="bd-drawer-row"><span>Subtotal</span><span>${money(subtotal)}</span></div>
      <div class="bd-drawer-row"><span>Shipping</span><span>${shipping ? money(shipping) : 'Free'}</span></div>
      <div class="bd-drawer-row total"><span>Total</span><span>${money(subtotal + shipping)}</span></div>
      <a class="bd-btn bd-btn-gold bd-btn-block bd-btn-lg" href="/checkout/">${ICONS.lock} Checkout</a>`;
    body.querySelectorAll('.bd-line').forEach((row) => {
      const id = parseInt(row.dataset.id, 10);
      wireStepper(row, (q) => cart.set(id, q), () => cart.get().find((l) => l.id === id)?.qty || 1);
      row.querySelector('[data-remove]').addEventListener('click', () => cart.remove(id));
    });
  }

  function stepperHtml(qty) {
    return `<div class="bd-stepper" role="group" aria-label="Quantity">
      <button type="button" data-step="-1" aria-label="Decrease quantity"${qty <= 1 ? ' disabled' : ''}>−</button>
      <span aria-live="polite">${qty}</span>
      <button type="button" data-step="1" aria-label="Increase quantity"${qty >= MAX_QTY ? ' disabled' : ''}>+</button></div>`;
  }
  function wireStepper(root, onChange, getQty) {
    root.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
      const q = Math.min(MAX_QTY, Math.max(1, getQty() + parseInt(b.dataset.step, 10)));
      onChange(q);
    }));
  }

  function addToCart(book, qty = 1) {
    if (!book) return;
    const before = cart.get().find((l) => l.id === book.id);
    if (before && before.qty >= MAX_QTY) {
      toast(`You can order up to ${MAX_QTY} copies of a title at once`, { error: true });
      return;
    }
    cart.add(book.id, qty);
    toast(`“${book.title}” added to your cart`, { action: { label: 'View cart', onClick: openCart } });
  }

  function whatsappLink(text) {
    return `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(text)}`;
  }

  window.BD = {
    ICONS, esc, money, img, stars, deliveryBy, deliveryRange, fmtDate, fmtDateTime, fmtDay,
    api, books, config, shippingFor, cart, buyNow, myOrders, toast, header, footer, wireChrome,
    openCart, closeCart, stepperHtml, wireStepper, addToCart, whatsappLink, MAX_QTY, LOGO,
  };
})();
