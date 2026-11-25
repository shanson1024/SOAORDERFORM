require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');

const { UPLOAD_DIR } = require('./lib/db');
const { config, CATEGORIES, money, productImage } = require('./lib/helpers');
const { fulfillStripeSession } = require('./lib/orders');

const isProd = config.isProd;
if (isProd && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is required in production.');
  process.exit(1);
}

const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.locals.stripe = stripe;

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      formAction: ["'self'", 'https://checkout.stripe.com'],
      upgradeInsecureRequests: isProd ? [] : null,
    },
  },
}));

// Stripe webhook needs the raw body, so it is registered before the body parsers.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Webhook not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send('Invalid signature');
  }
  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      fulfillStripeSession(event.data.object);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handling failed:', err);
    res.status(500).send('Webhook handler error');
  }
});

// Template defaults, so error pages can render even if a later middleware fails.
app.use((req, res, next) => {
  Object.assign(res.locals, { csrf: '', cartCount: 0, money, config, CATEGORIES, productImage,
    flash: null, path: req.path, title: null, isAdmin: false });
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProd ? '7d' : 0 }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: isProd ? '7d' : 0 }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(cookieSession({
  name: 'sj',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  maxAge: 30 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: isProd,
}));

app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(18).toString('base64url');
  const cartCount = (Array.isArray(req.session.cart) ? req.session.cart : []).reduce((n, i) => n + (parseInt(i.q, 10) || 0), 0);
  Object.assign(res.locals, { csrf: req.session.csrf, cartCount, flash: req.session.flash || null, isAdmin: !!req.session.admin });
  delete req.session.flash;
  if (req.method === 'POST') {
    const sent = String(req.query._csrf || (req.body && req.body._csrf) || '');
    const want = req.session.csrf;
    if (sent.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want))) {
      return res.status(403).render('message', { title: 'Session expired', body: 'Please go back, refresh the page and try again.' });
    }
  }
  next();
});

app.use('/', require('./routes/store'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('message', { title: 'Page not found', body: "We couldn't find that page." });
});
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).render('message', { title: 'Something went wrong', body: 'Please try again in a moment.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`${config.storeName} running on http://localhost:${port}`);
  if (!stripe) console.log(isProd ? 'WARNING: STRIPE_SECRET_KEY not set, checkout is disabled.' : 'Stripe not configured: checkout runs in test mode (no real payment).');
  if (!process.env.ADMIN_PASSWORD) console.log('ADMIN_PASSWORD not set: admin login is disabled.');
});
