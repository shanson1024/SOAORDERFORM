'use strict';
/* Swaggeroo CRM server: logins, leads and deals API, public order form intake, optional AI drafting. */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROD = process.env.NODE_ENV === 'production';
const SESSION_DAYS = 30;
const DAY = 864e5;

fs.mkdirSync(DATA_DIR, { recursive: true });
if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  console.warn('WARNING: no Railway volume is attached. Records will be lost on the next deploy. Attach a volume mounted at ' + DATA_DIR + '.');
}
const db = new Database(path.join(DATA_DIR, 'swaggeroo.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ---------- schema ---------- */
// Field types: s = short text, t = long text, n = non-negative number, i = pipeline stage (0-5).
const SPEC = {
  leads: { company: 's', contact: 's', email: 's', phone: 's', interest: 's', qty: 'n', budget: 'n', source: 's', status: 's', notes: 't', inHand: 's', createdAt: 'n' },
  deals: { company: 's', contact: 's', email: 's', value: 'n', title: 's', cat: 's', deco: 's', inHand: 's', stage: 'i', stageAt: 'n', notes: 't', leadId: 's', createdAt: 'n' },
};
const snake = k => k.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const sqlType = t => (t === 'n' ? 'REAL' : t === 'i' ? 'INTEGER' : 'TEXT');
for (const [table, spec] of Object.entries(SPEC)) {
  const cols = Object.entries(spec).map(([k, t]) => `${snake(k)} ${sqlType(t)}`).join(', ');
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, ${cols}, updated_at INTEGER)`);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at INTEGER);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
`);

/* ---------- passwords and sessions ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, 'hex');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), want.length);
  return crypto.timingSafeEqual(want, got);
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

function createUser(email, name, password, role) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, email, name, pass_hash, role, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, email.toLowerCase().trim(), String(name || '').slice(0, 120), hashPassword(password), role === 'admin' ? 'admin' : 'member', Date.now());
  return id;
}
if (!db.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (ADMIN_EMAIL && ADMIN_PASSWORD && validEmail(ADMIN_EMAIL) && ADMIN_PASSWORD.length >= 10) {
    createUser(ADMIN_EMAIL, 'Admin', ADMIN_PASSWORD, 'admin');
    console.log(`Created admin account for ${ADMIN_EMAIL}`);
  } else {
    console.warn('No accounts exist. Set ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters) and restart to create the first one.');
  }
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSession(res, token, maxAgeSec) {
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${PROD ? '; Secure' : ''}`);
}
function currentUser(req) {
  const token = cookies(req).sid;
  if (!token) return null;
  const row = db.prepare('SELECT u.id, u.email, u.name, u.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha(token));
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

/* ---------- small in-memory rate limiter ---------- */
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return false; }
  b.n += 1;
  return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 10 * 60 * 1000).unref();

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});
app.use(express.json({ limit: '200kb' }));

// Writes must come from this site: reject a mismatched Origin and non-JSON bodies.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch (e) { /* malformed */ }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-site request refused.' });
  }
  if (req.headers['content-length'] > 0 && !req.is('application/json')) return res.status(415).json({ error: 'Send JSON.' });
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/login', (req, res) => {
  if (limited('login:' + req.ip, 10, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
  const email = String((req.body && req.body.email) || '').toLowerCase().trim();
  const password = String((req.body && req.body.password) || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !checkPassword(password, user.pass_hash)) return res.status(401).json({ error: 'That email and password do not match.' });
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), user.id, Date.now() + SESSION_DAYS * DAY);
  setSession(res, token, SESSION_DAYS * 86400);
  res.json({ ok: true });
});

/* ---------- public order form intake ---------- */
const CATMAP = [['Headwear', 'Headwear'], ['Apparel', 'Apparel'], ['Drinkware', 'Drinkware'], ['Bags', 'Bags'], ['Writing', 'Writing Instruments'], ['Tech', 'Tech'], ['Office', 'Office'], ['Awards', 'Awards'], ['Signage', 'Signage'], ['Trade Show', 'Trade Show'], ['Safety', 'Safety / PPE']];
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
app.post('/api/order-requests', (req, res) => {
  if (limited('order:' + req.ip, 20, 60 * 60 * 1000)) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  const b = req.body || {};
  if (str(b.website, 10)) return res.json({ ok: true }); // honeypot: bots fill this hidden field
  const company = str(b.companyName, 200), contact = str(b.contactName, 200), email = str(b.contactEmail, 200), phone = str(b.contactPhone, 60), inHand = str(b.inHandDate, 10);
  const items = Array.isArray(b.items) ? b.items.slice(0, 25) : [];
  const errors = [];
  if (!company) errors.push('Company name is required.');
  if (!contact) errors.push('Contact name is required.');
  if (!validEmail(email)) errors.push('A valid email is required.');
  if (!phone) errors.push('Phone is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inHand)) errors.push('In-hand date is required.');
  if (!items.length) errors.push('Add at least one product.');
  items.forEach((it, i) => {
    if (!str(it && it.category, 80)) errors.push(`Item ${i + 1}: choose a category.`);
    if (!(parseInt(it && it.quantity, 10) > 0)) errors.push(`Item ${i + 1}: enter a quantity.`);
  });
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const qty = items.reduce((t, it) => t + parseInt(it.quantity, 10), 0);
  const firstCat = str(items[0].category, 80);
  const hit = CATMAP.find(c => firstCat.includes(c[0]));
  const budget = parseFloat((str(b.budget, 60).replace(/,/g, '').match(/\d+(\.\d+)?/) || [0])[0]) || 0;
  const lines = [];
  if (str(b.eventName, 200)) lines.push('Event: ' + str(b.eventName, 200));
  lines.push('In-hand date: ' + inHand);
  if (str(b.budget, 60)) lines.push('Budget: ' + str(b.budget, 60));
  if (str(b.artworkReady, 60)) lines.push('Artwork ready: ' + str(b.artworkReady, 60));
  const ship = [str(b.shippingAddress, 200), str(b.city, 80), str(b.state, 20), str(b.zip, 12)].filter(Boolean).join(', ');
  if (ship) lines.push('Ship to: ' + ship);
  items.forEach((it, i) => {
    const sizes = it.sizes && typeof it.sizes === 'object' ? Object.entries(it.sizes).filter(([, v]) => parseInt(v, 10) > 0).map(([k, v]) => `${str(k, 4)}:${parseInt(v, 10)}`).join(' ') : '';
    lines.push([`Item ${i + 1}: ${parseInt(it.quantity, 10)} × ${str(it.category, 80)}`, str(it.description, 300), str(it.color, 120) && 'Colors: ' + str(it.color, 120), sizes && 'Sizes: ' + sizes,
      str(it.decoration, 60) && 'Decoration: ' + str(it.decoration, 60), str(it.decorationNotes, 300), str(it.targetPrice, 20) && 'Target unit price: ' + str(it.targetPrice, 20)].filter(Boolean).join(' · '));
  });
  if (str(b.notes, 2000)) lines.push('Notes: ' + str(b.notes, 2000));

  insertRow('leads', crypto.randomUUID(), clean('leads', { company, contact, email, phone, interest: hit ? hit[1] : 'Other', qty, budget, source: 'Order form', status: 'New', notes: lines.join('\n'), inHand, createdAt: Date.now() }));
  res.json({ ok: true });
});

/* ---------- everything below needs a signed-in user ---------- */
app.use('/api', (req, res, next) => {
  req.user = currentUser(req);
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
});
const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Only an admin can do that.' }));

app.post('/api/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(cookies(req).sid || ''));
  setSession(res, '', 0);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ user: req.user, ai: !!process.env.ANTHROPIC_API_KEY }));

app.post('/api/password', (req, res) => {
  const cur = String((req.body && req.body.current) || ''), next = String((req.body && req.body.next) || '');
  const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(req.user.id);
  if (!checkPassword(cur, row.pass_hash)) return res.status(400).json({ error: 'Your current password is not right.' });
  if (next.length < 10) return res.status(400).json({ error: 'Use at least 10 characters for the new password.' });
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, sha(cookies(req).sid || ''));
  res.json({ ok: true });
});

app.get('/api/users', adminOnly, (req, res) => res.json({ rows: db.prepare('SELECT id, email, name, role FROM users ORDER BY created_at').all() }));
app.post('/api/users', adminOnly, (req, res) => {
  const email = str(req.body && req.body.email, 200).toLowerCase(), password = String((req.body && req.body.password) || '');
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (password.length < 10) return res.status(400).json({ error: 'Use at least 10 characters for the password.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(400).json({ error: 'That email already has an account.' });
  res.json({ id: createUser(email, req.body.name, password, req.body.role) });
});
app.delete('/api/users/:id', adminOnly, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------- leads and deals ---------- */
function clean(table, body, partial) {
  const out = {};
  for (const [k, t] of Object.entries(SPEC[table])) {
    if (partial && !(k in body)) continue;
    const v = body[k];
    if (t === 's') out[k] = str(v, 300);
    else if (t === 't') out[k] = str(v, 8000);
    else if (t === 'i') out[k] = Math.min(5, Math.max(0, parseInt(v, 10) || 0));
    else out[k] = Number.isFinite(+v) && +v > 0 ? +v : 0;
  }
  return out;
}
function insertRow(table, id, data) {
  const keys = Object.keys(SPEC[table]);
  db.prepare(`INSERT OR REPLACE INTO ${table} (id, ${keys.map(snake).join(', ')}, updated_at) VALUES (?, ${keys.map(() => '?').join(', ')}, ?)`)
    .run(id, ...keys.map(k => data[k]), Date.now());
}
function toDoc(table, row) {
  const out = { id: row.id };
  for (const k of Object.keys(SPEC[table])) out[k] = row[snake(k)];
  return out;
}
const validId = id => /^[A-Za-z0-9_-]{1,100}$/.test(id);
/* ---------- AI drafting (only when ANTHROPIC_API_KEY is set) ---------- */
let anthropic = null;
app.post('/api/ai', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI features are not configured.' });
  if (limited('ai:' + req.user.id, 40, 60 * 60 * 1000)) return res.status(429).json({ error: 'Too many requests. Wait a little and try again.' });
  const prompt = String((req.body && req.body.prompt) || '');
  if (!prompt || prompt.length > 60000) return res.status(400).json({ error: 'Bad prompt.' });
  try {
    if (!anthropic) { const Anthropic = require('@anthropic-ai/sdk'); anthropic = new (Anthropic.default || Anthropic)(); }
    const msg = await anthropic.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: 'You write for Swaggeroo, a promotional products and branded merchandise company. Reply in plain text only.',
      messages: [{ role: 'user', content: prompt }],
    });
    if (msg.stop_reason === 'refusal') return res.status(422).json({ error: 'The assistant declined this request.' });
    res.json({ text: msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim() });
  } catch (e) {
    console.error('AI request failed:', e && e.status, e && e.message);
    res.status(e && e.status === 429 ? 429 : 502).json({ error: 'The assistant could not answer right now.' });
  }
});
app.param('table', (req, res, next, table) => (Object.prototype.hasOwnProperty.call(SPEC, table) ? next() : res.status(404).json({ error: 'Not found.' })));

app.get('/api/:table', (req, res) => {
  const t = req.params.table;
  res.json({ rows: db.prepare(`SELECT * FROM ${t} ORDER BY created_at DESC`).all().map(r => toDoc(t, r)) });
});
app.post('/api/:table', (req, res) => {
  const t = req.params.table, data = clean(t, req.body || {});
  if (!data.company) return res.status(400).json({ error: 'Company is required.' });
  if (!data.createdAt) data.createdAt = Date.now();
  const id = crypto.randomUUID();
  insertRow(t, id, data);
  res.json({ id });
});
app.put('/api/:table/:id', (req, res) => {
  const t = req.params.table, data = clean(t, req.body || {});
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Bad id.' });
  if (!data.company) return res.status(400).json({ error: 'Company is required.' });
  insertRow(t, req.params.id, data);
  res.json({ ok: true });
});
app.patch('/api/:table/:id', (req, res) => {
  const t = req.params.table, data = clean(t, req.body || {}, true), keys = Object.keys(data);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to change.' });
  const r = db.prepare(`UPDATE ${t} SET ${keys.map(k => snake(k) + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(k => data[k]), Date.now(), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'That record no longer exists.' });
  res.json({ ok: true });
});
app.delete('/api/:table/:id', (req, res) => {
  db.prepare(`DELETE FROM ${req.params.table} WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

/* ---------- pages ---------- */
const PUB = path.join(__dirname, 'public');
const SHELL = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<style>:root{color-scheme:dark}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body><script src="/adapter.js"></script>';
const crmPage = () => SHELL + fs.readFileSync(path.join(__dirname, 'Swaggeroo_CRM.html'), 'utf8') + '</body></html>';
let crmCache = null;

app.get('/', (req, res) => {
  if (!currentUser(req)) return res.redirect('/login');
  if (!crmCache || !PROD) crmCache = crmPage();
  res.type('html').send(crmCache);
});
app.get('/login', (req, res) => (currentUser(req) ? res.redirect('/') : res.sendFile(path.join(PUB, 'login.html'))));
app.get('/order', (req, res) => res.sendFile(path.join(PUB, 'order.html')));
app.use(express.static(PUB, { index: false, extensions: [] }));
app.use((req, res) => res.status(404).type('text').send('Not found'));

if (require.main === module) app.listen(PORT, () => console.log(`Swaggeroo CRM running on port ${PORT}`));
module.exports = { app, db };
