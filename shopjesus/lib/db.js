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
CREATE TABLE IF NOT EXISTS product_images (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color TEXT NOT NULL,
  image TEXT NOT NULL,
  PRIMARY KEY (product_id, color)
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

const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];
const BLACK = '#151515';
const WHITE = '#f4f4f2';

// Starting catalog: [name, category, price, featured, description, black photo, white photo].
// Every item comes in Black and White. Edit everything in the admin afterwards.
function seed() {
  if (db.prepare('SELECT COUNT(*) n FROM products').get().n > 0) return;
  const items = [
    ['ShopJesus Logo Tee', 'tshirts', 1999, 1,
      'Classic crew neck tee with the ShopJesus.com logo printed big across the chest.', 'tee-black', 'tee-white'],
    ['Jesus Is My Homeboy Tee', 'tshirts', 1999, 1,
      'Crew neck tee with a bold brush-script "Jesus Is My Homeboy" print.', 'homeboy-tee-black', null],
    ['Jesus Was A Gym Rat Tee', 'tshirts', 1999, 1,
      'Crew neck tee with a varsity-style "Jesus Was A Gym Rat" print, barbell and crown of thorns.', 'gym-rat-tee-black', null],
    ['ShopJesus Logo Hoodie', 'hoodies', 2999, 1,
      'Pullover fleece hoodie with front pouch pocket, drawstring hood and a large ShopJesus.com logo.', 'hoodie-black', 'hoodie-white'],
    ['Jesus Is My Homeboy Hoodie', 'hoodies', 2999, 1,
      'Pullover fleece hoodie with front pouch pocket and a bold "Jesus Is My Homeboy" print.', 'homeboy-hoodie-black', null],
    ['Jesus Was A Gym Rat Hoodie', 'hoodies', 2999, 0,
      'Pullover fleece hoodie with front pouch pocket and a varsity-style "Jesus Was A Gym Rat" print.', 'gym-rat-hoodie-black', null],
    ['ShopJesus Logo Hat', 'hats', 2499, 1,
      'Structured cap with raised embroidered ShopJesus.com logo, red under-brim trim and adjustable fit.', 'hat-black', 'hat-white'],
    ['ShopJesus Classic Polo', 'polos', 2999, 1,
      'Breathable three-button polo with the ShopJesus.com logo embroidered on the left chest.', 'polo-black', null],
    ['ShopJesus Red Trim Polo', 'polos', 2999, 0,
      'Three-button polo with red collar trim and the ShopJesus.com logo embroidered on the left chest.', 'polo-red-trim-black', null],
    ['ShopJesus Two-Pocket Work Shirt', 'buttondowns', 3999, 1,
      'Short-sleeve button-up work shirt with two flap chest pockets and embroidered ShopJesus.com logo.', 'work-shirt-black', null],
    ['ShopJesus Oxford Button-Down', 'buttondowns', 3999, 0,
      'Short-sleeve button-down collar shirt with chest pocket and embroidered ShopJesus.com logo.', 'oxford-black', null],
  ];
  const insP = db.prepare('INSERT INTO products (slug,name,description,category,price_cents,featured) VALUES (?,?,?,?,?,?)');
  const insV = db.prepare('INSERT INTO variants (product_id,color,color_hex,size,stock) VALUES (?,?,?,?,?)');
  const insI = db.prepare('INSERT INTO product_images (product_id,color,image) VALUES (?,?,?)');
  db.transaction(() => {
    for (const [name, cat, price, featured, desc, blackImg, whiteImg] of items) {
      const { lastInsertRowid: pid } = insP.run(slugify(name), name, desc, cat, price, featured);
      for (const [color, hex, img] of [['Black', BLACK, blackImg], ['White', WHITE, whiteImg]]) {
        if (img) insI.run(pid, color, `/img/products/${img}.jpg`);
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
