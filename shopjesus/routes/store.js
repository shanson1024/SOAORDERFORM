const express = require('express');
const { db } = require('../lib/db');
const { config, CATEGORIES, loadCart, productSvg, productImage, colorImageQ, firstImageQ, sortSizes, money } = require('../lib/helpers');
const { getOrder, createPendingOrder, markPaid, fulfillStripeSession } = require('../lib/orders');

const router = express.Router();

const LIST_SQL = `SELECT p.*,
    (SELECT COALESCE(SUM(stock),0) FROM variants v WHERE v.product_id = p.id) total_stock,
    (SELECT color_hex FROM variants v WHERE v.product_id = p.id ORDER BY v.id LIMIT 1) first_hex
  FROM products p WHERE p.active = 1`;

function colorsFor(products) {
  const q = db.prepare('SELECT DISTINCT color, color_hex FROM variants WHERE product_id = ? ORDER BY id');
  for (const p of products) p.colors = q.all(p.id);
  return products;
}

router.get('/', (req, res) => {
  const featured = colorsFor(db.prepare(LIST_SQL + ' AND p.featured = 1 ORDER BY p.id LIMIT 8').all());
  const first = db.prepare(LIST_SQL + ' AND p.category = ? ORDER BY p.featured DESC, p.id LIMIT 1');
  const cats = Object.entries(CATEGORIES).map(([key, label]) => {
    const p = first.get(key);
    return p && { key, label, img: productImage(p, p.first_hex) };
  }).filter(Boolean);
  res.render('home', { featured, cats });
});

router.get('/shop', (req, res) => {
  const category = CATEGORIES[req.query.category] ? req.query.category : null;
  const sort = { 'price-asc': 'p.price_cents ASC', 'price-desc': 'p.price_cents DESC', newest: 'p.id DESC' }[req.query.sort] || 'p.featured DESC, p.id';
  const products = colorsFor(category
    ? db.prepare(LIST_SQL + ` AND p.category = ? ORDER BY ${sort}`).all(category)
    : db.prepare(LIST_SQL + ` ORDER BY ${sort}`).all());
  res.render('shop', { products, category, sort: req.query.sort || '', title: category ? CATEGORIES[category] : 'Shop All' });
});

router.get('/product/:slug', (req, res, next) => {
  const product = db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!product) return next();
  const variants = db.prepare('SELECT id, color, color_hex, size, stock FROM variants WHERE product_id = ? ORDER BY id').all(product.id);
  const colors = [];
  for (const v of variants) if (!colors.find((c) => c.color === v.color)) colors.push({ color: v.color, hex: v.color_hex });
  const sizes = [...new Set(variants.map((v) => v.size))].sort(sortSizes);
  const firstInStock = variants.find((v) => v.stock > 0);
  const colorImages = {};
  // If a color has no photo of its own, another color's photo is shown; say so on the page.
  const fallback = product.image ? null : firstImageQ.get(product.id);
  const shownIn = {};
  for (const c of colors) {
    colorImages[c.color] = productImage(product, c.hex, c.color);
    if (fallback && !colorImageQ.get(product.id, c.color)) shownIn[c.color] = fallback.color;
  }
  const related = colorsFor(db.prepare(LIST_SQL + ' AND p.category = ? AND p.id != ? ORDER BY p.id LIMIT 4').all(product.category, product.id));
  res.render('product', { product, variants, colors, sizes, firstInStock, related, colorImages, shownIn, title: product.name });
});

// Placeholder artwork until real photos are uploaded.
router.get('/img/p/:slug.svg', (req, res, next) => {
  const p = db.prepare(`SELECT p.category, p.design_text,
      (SELECT color_hex FROM variants v WHERE v.product_id = p.id ORDER BY v.id LIMIT 1) hex
    FROM products p WHERE slug = ?`).get(req.params.slug);
  if (!p) return next();
  const c = /^[0-9a-f]{6}$/i.test(req.query.c || '') ? '#' + req.query.c : p.hex || '#151515';
  res.set('Cache-Control', 'public, max-age=3600').type('image/svg+xml').send(productSvg(p.category, c, p.design_text));
});

// ---- Cart ----
router.get('/cart', (req, res) => {
  res.render('cart', { cart: loadCart(req), title: 'Your Cart' });
});

router.post('/cart/add', (req, res) => {
  const product = db.prepare('SELECT id, slug, name FROM products WHERE id = ? AND active = 1').get(req.body.product_id);
  if (!product) return res.redirect('/shop');
  const v = db.prepare('SELECT id, stock FROM variants WHERE product_id = ? AND color = ? AND size = ?')
    .get(product.id, String(req.body.color || ''), String(req.body.size || ''));
  const back = '/product/' + product.slug;
  if (!v) { req.session.flash = { type: 'error', text: 'Please choose a color and size.' }; return res.redirect(back); }
  if (v.stock <= 0) { req.session.flash = { type: 'error', text: 'Sorry, that option is sold out.' }; return res.redirect(back); }
  const qty = Math.max(1, Math.min(parseInt(req.body.qty, 10) || 1, 20));
  const cart = Array.isArray(req.session.cart) ? req.session.cart : [];
  const existing = cart.find((i) => i.v === v.id);
  if (existing) existing.q = Math.min(existing.q + qty, v.stock, 20);
  else if (cart.length < 40) cart.push({ v: v.id, q: Math.min(qty, v.stock) });
  req.session.cart = cart;
  req.session.flash = { type: 'ok', text: `${product.name} added to your cart.` };
  res.redirect('/cart');
});

router.post('/cart/update', (req, res) => {
  const id = parseInt(req.body.variant_id, 10);
  const qty = parseInt(req.body.qty, 10) || 0;
  let cart = Array.isArray(req.session.cart) ? req.session.cart : [];
  if (qty <= 0 || req.body.remove) cart = cart.filter((i) => i.v !== id);
  else for (const i of cart) if (i.v === id) i.q = Math.min(qty, 20);
  req.session.cart = cart;
  res.redirect('/cart');
});

// ---- Checkout ----
function baseUrl(req) {
  return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

router.post('/checkout', async (req, res, next) => {
  try {
    const cart = loadCart(req);
    if (!cart.lines.length || cart.notices.length) return res.redirect('/cart');
    const stripe = req.app.locals.stripe;

    if (!stripe) {
      if (config.isProd) {
        req.session.flash = { type: 'error', text: 'Checkout is temporarily unavailable. Please try again soon.' };
        return res.redirect('/cart');
      }
      return res.render('checkout-test', { cart, title: 'Checkout (test mode)' });
    }

    const order = createPendingOrder(cart);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      client_reference_id: order.number,
      metadata: { order_id: String(order.id) },
      line_items: cart.lines.map((l) => ({
        quantity: l.qty,
        price_data: {
          currency: 'usd',
          unit_amount: l.price_cents,
          product_data: { name: `${l.name} (${l.color} / ${l.size})` },
        },
      })),
      shipping_address_collection: { allowed_countries: config.shipCountries },
      shipping_options: [{
        shipping_rate_data: {
          type: 'fixed_amount',
          display_name: cart.shipping === 0 ? 'Free standard shipping' : 'Standard shipping',
          fixed_amount: { amount: cart.shipping, currency: 'usd' },
          delivery_estimate: { minimum: { unit: 'business_day', value: 3 }, maximum: { unit: 'business_day', value: 7 } },
        },
      }],
      automatic_tax: { enabled: config.stripeTax },
      success_url: `${baseUrl(req)}/order/${order.number}?t=${order.token}&paid=1`,
      cancel_url: `${baseUrl(req)}/cart`,
    });
    db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, order.id);
    res.redirect(303, session.url);
  } catch (err) {
    next(err);
  }
});

// Test-mode checkout: only available outside production when Stripe is not configured.
router.post('/checkout/test', (req, res) => {
  if (req.app.locals.stripe || config.isProd) return res.redirect('/cart');
  const cart = loadCart(req);
  if (!cart.lines.length) return res.redirect('/cart');
  const b = req.body;
  const order = createPendingOrder(cart);
  markPaid(order.id, {
    email: String(b.email || '').slice(0, 200), name: String(b.name || '').slice(0, 200),
    address: { line1: b.line1, line2: b.line2, city: b.city, state: b.state, postal_code: b.postal_code, country: 'US' },
    subtotal: cart.subtotal, shipping: cart.shipping, tax: 0, total: cart.total,
  });
  res.redirect(`/order/${order.number}?t=${order.token}&paid=1`);
});

router.get('/order/:number', async (req, res, next) => {
  try {
    let order = getOrder('number', req.params.number);
    if (!order || order.token !== req.query.t) return next();
    // The webhook normally marks the order paid; this covers the case where the customer lands first.
    const stripe = req.app.locals.stripe;
    if (order.status === 'pending' && stripe && order.stripe_session_id) {
      const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
      if (fulfillStripeSession(session)) order = getOrder('id', order.id);
    }
    if (req.query.paid && order.status !== 'pending') req.session.cart = [];
    res.locals.cartCount = req.query.paid && order.status !== 'pending' ? 0 : res.locals.cartCount;
    res.render('order', { order, title: 'Order ' + order.number });
  } catch (err) {
    next(err);
  }
});

// ---- Info pages ----
const PAGES = {
  about: ['About Us', [
    'ShopJesus.com makes apparel for people who want to wear their faith out loud. Every tee, hoodie and hat is designed to start a conversation and point back to Him.',
    'We are a small team that cares about quality prints, comfortable fits and treating customers the way we would want to be treated.',
  ]],
  shipping: ['Shipping & Returns', [
    `Orders ship within 2-3 business days. Standard shipping is ${money(config.shippingFlatCents)}, and free on orders over ${money(config.freeShippingThresholdCents)}.`,
    'You will receive an email with tracking as soon as your order ships.',
    'Not happy with your order? Unworn, unwashed items can be returned within 30 days of delivery for a refund or exchange. Email us to start a return.',
  ]],
  contact: ['Contact', [
    `Questions about an order, sizing or anything else? Email us at ${config.contactEmail} and we will get back to you within one business day.`,
  ]],
  privacy: ['Privacy Policy', [
    'We collect only the information needed to process and ship your order: your name, email address and shipping address. Payments are processed securely by Stripe; we never see or store your card number.',
    'We do not sell your personal information. We use a single cookie to keep track of your cart.',
    `To request a copy or deletion of your data, email ${config.contactEmail}.`,
  ]],
  terms: ['Terms of Service', [
    'By placing an order you agree to pay the total shown at checkout. Prices are in US dollars. We may cancel and refund any order we are unable to fulfill.',
    'All designs and content on this site are the property of ShopJesus.com.',
  ]],
};

router.get(Object.keys(PAGES).map((p) => '/' + p), (req, res) => {
  const [title, paragraphs] = PAGES[req.path.replace(/\//g, '')];
  res.render('page', { title, paragraphs });
});

module.exports = router;
