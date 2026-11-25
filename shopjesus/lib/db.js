const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'shop.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  design_text TEXT NOT NULL DEFAULT '',
  image TEXT,
  featured INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color TEXT NOT NULL,
  color_hex TEXT NOT NULL DEFAULT '#111111',
  size TEXT NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  UNIQUE (product_id, color, size)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT UNIQUE,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','shipped','cancelled','refunded')),
  email TEXT,
  name TEXT,
  address TEXT,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  stripe_session_id TEXT,
  stripe_payment_intent TEXT,
  tracking_number TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT,
  shipped_at TEXT
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id INTEGER,
  product_name TEXT NOT NULL,
  color TEXT NOT NULL,
  size TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
`);

const SIZES = ['S', 'M', 'L', 'XL', '2XL'];
const C = {
  black: ['Black', '#151515'],
  white: ['White', '#f4f4f2'],
  red: ['Red', '#c8102e'],
  sand: ['Sand', '#d6c7a9'],
  navy: ['Navy', '#1e2a44'],
  heather: ['Heather Grey', '#9a9a9a'],
};

function seed() {
  if (db.prepare('SELECT COUNT(*) n FROM products').get().n > 0) return;
  const items = [
    ['Faith Over Fear Tee', 'tshirts', 1999, 'FAITH OVER FEAR', 1, [C.black, C.white, C.red],
      'Soft, heavyweight cotton tee with a bold front print. A daily reminder of 2 Timothy 1:7.'],
    ['Saved By Grace Tee', 'tshirts', 1999, 'SAVED BY GRACE', 1, [C.white, C.sand, C.navy],
      'Classic-fit crew neck tee. Ephesians 2:8 on your chest, comfort all day.'],
    ['John 3:16 Tee', 'tshirts', 1999, 'JOHN 3:16', 0, [C.black, C.heather, C.red],
      'The verse that says it all. Pre-shrunk cotton, true to size.'],
    ['Walk By Faith Hoodie', 'hoodies', 2999, 'WALK BY FAITH', 1, [C.black, C.heather, C.navy],
      'Midweight fleece pullover hoodie with front pouch pocket. 2 Corinthians 5:7.'],
    ['He Is Risen Hoodie', 'hoodies', 2999, 'HE IS RISEN', 1, [C.black, C.red, C.sand],
      'Warm brushed-fleece hoodie with a statement print. Built for cold mornings and bold faith.'],
    ['Jesus Saves Dad Hat', 'hats', 2499, 'JESUS SAVES', 1, [C.black, C.white, C.red],
      'Unstructured six-panel cap with embroidered front and adjustable strap.'],
    ['Blessed Snapback', 'hats', 2499, 'BLESSED', 1, [C.black, C.navy],
      'Structured flat-brim snapback with raised embroidery.'],
    ['Faith Polo', 'polos', 2999, 'FAITH', 1, [C.black, C.white, C.navy],
      'Breathable pique polo with embroidered left chest. Sunday service to the golf course.'],
    ['Blessed Polo', 'polos', 2999, 'BLESSED', 0, [C.red, C.black, C.heather],
      'Classic-fit polo with a three-button placket and embroidered left chest.'],
    ['Grace Button-Down Shirt', 'buttondowns', 3999, 'GRACE', 1, [C.white, C.navy, C.black],
      'Crisp long-sleeve button-down with embroidered left chest. Dress it up or down.'],
    ['Redeemed Button-Down Shirt', 'buttondowns', 3999, 'REDEEMED', 0, [C.white, C.sand],
      'Easy-care long-sleeve button-down shirt with a tailored fit.'],
  ];
  const insP = db.prepare(`INSERT INTO products (slug,name,description,category,price_cents,design_text,featured)
    VALUES (?,?,?,?,?,?,?)`);
  const insV = db.prepare('INSERT INTO variants (product_id,color,color_hex,size,stock) VALUES (?,?,?,?,?)');
  db.transaction(() => {
    for (const [name, cat, price, text, featured, colors, desc] of items) {
      const { lastInsertRowid: pid } = insP.run(slugify(name), name, desc, cat, price, text, featured);
      for (const [color, hex] of colors) {
        for (const size of cat === 'hats' ? ['One Size'] : SIZES) insV.run(pid, color, hex, size, 25);
      }
    }
  })();
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'product';
}

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

seed();

module.exports = { db, slugify, newToken, DATA_DIR, UPLOAD_DIR, SIZES };
