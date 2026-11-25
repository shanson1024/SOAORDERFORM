const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { db, slugify, UPLOAD_DIR } = require('../lib/db');
const { config, CATEGORIES, imageUrl } = require('../lib/helpers');
const { getOrder, markShipped } = require('../lib/orders');

const router = express.Router();

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + IMAGE_TYPES[file.mimetype]),
  }),
  limits: { fileSize: 6 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => cb(null, !!IMAGE_TYPES[file.mimetype]),
});

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  next();
});

router.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin Login', error: null });
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: 'Too many login attempts. Try again in 15 minutes.' });

router.post('/login', loginLimiter, (req, res) => {
  const want = process.env.ADMIN_PASSWORD || '';
  const got = String(req.body.password || '');
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  if (want && crypto.timingSafeEqual(a, b)) {
    req.session.admin = true;
    return res.redirect('/admin');
  }
  res.status(401).render('admin/login', { title: 'Admin Login',
    error: want ? 'Incorrect password.' : 'Admin login is disabled until ADMIN_PASSWORD is set.' });
});

router.use((req, res, next) => (req.session.admin ? next() : res.redirect('/admin/login')));

router.post('/logout', (req, res) => { req.session.admin = false; res.redirect('/'); });

// ---- Dashboard ----
router.get('/', (req, res) => {
  const paid = "status IN ('paid','shipped')";
  const stats = {
    toShip: db.prepare("SELECT COUNT(*) n FROM orders WHERE status='paid'").get().n,
    today: db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) c FROM orders WHERE ${paid} AND date(paid_at)=date('now')`).get(),
    month: db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) c FROM orders WHERE ${paid} AND paid_at >= datetime('now','-30 days')`).get(),
    all: db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) c FROM orders WHERE ${paid}`).get(),
  };
  const recent = db.prepare("SELECT * FROM orders WHERE status != 'pending' ORDER BY id DESC LIMIT 8").all();
  const lowStock = db.prepare(`SELECT p.id, p.name, v.color, v.size, v.stock FROM variants v
    JOIN products p ON p.id = v.product_id WHERE p.active = 1 AND v.stock <= 5 ORDER BY v.stock, p.name LIMIT 20`).all();
  res.render('admin/dashboard', { title: 'Dashboard', stats, recent, lowStock });
});

// ---- Orders ----
const STATUSES = ['paid', 'shipped', 'cancelled', 'refunded', 'pending'];

router.get('/orders', (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const orders = status
    ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT 300').all(status)
    : db.prepare("SELECT * FROM orders WHERE status != 'pending' ORDER BY id DESC LIMIT 300").all();
  res.render('admin/orders', { title: 'Orders', orders, status, STATUSES });
});

router.get('/orders/:id', (req, res, next) => {
  const order = getOrder('id', req.params.id);
  if (!order) return next();
  res.render('admin/order', { title: 'Order ' + order.number, order });
});

router.post('/orders/:id', (req, res, next) => {
  const order = getOrder('id', req.params.id);
  if (!order) return next();
  const action = req.body.action;
  if (action === 'ship') {
    markShipped(order.id, String(req.body.tracking_number || '').trim().slice(0, 100));
    req.session.flash = { type: 'ok', text: 'Order marked as shipped.' };
  } else if (action === 'cancel' || action === 'refund') {
    const status = action === 'cancel' ? 'cancelled' : 'refunded';
    const wasCounted = ['paid', 'shipped'].includes(order.status);
    db.transaction(() => {
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
      if (wasCounted && req.body.restock && !config.madeToOrder) {
        const inc = db.prepare('UPDATE variants SET stock = stock + ? WHERE id = ?');
        for (const it of order.items) if (it.variant_id) inc.run(it.quantity, it.variant_id);
      }
    })();
    req.session.flash = { type: 'ok', text: `Order marked as ${status}. Remember to issue the refund in Stripe if money was collected.` };
  } else if (action === 'notes') {
    db.prepare('UPDATE orders SET notes = ? WHERE id = ?').run(String(req.body.notes || '').slice(0, 2000), order.id);
    req.session.flash = { type: 'ok', text: 'Notes saved.' };
  }
  res.redirect('/admin/orders/' + order.id);
});

// ---- Products ----
router.get('/products', (req, res) => {
  const products = db.prepare(`SELECT p.*,
      (SELECT COALESCE(SUM(stock),0) FROM variants v WHERE v.product_id = p.id) total_stock,
      (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id) variant_count
    FROM products p ORDER BY p.active DESC, p.category, p.name`).all();
  res.render('admin/products', { title: 'Products', products });
});

router.get('/products/new', (req, res) => {
  res.render('admin/product-form', { title: 'New Product', product: { active: 1, category: 'tshirts' }, variants: [], colors: [] });
});

router.get('/products/:id', (req, res, next) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return next();
  const variants = db.prepare('SELECT * FROM variants WHERE product_id = ? ORDER BY id').all(product.id);
  const colors = db.prepare(`SELECT v.color, v.color_hex, pi.image FROM variants v
    LEFT JOIN product_images pi ON pi.product_id = v.product_id AND pi.color = v.color
    WHERE v.product_id = ? GROUP BY v.color ORDER BY MIN(v.id)`).all(product.id);
  for (const c of colors) c.url = c.image ? imageUrl(c.image) : null;
  res.render('admin/product-form', { title: 'Edit ' + product.name, product, variants, colors });
});

function uniqueSlug(base, ignoreId) {
  let slug = base, n = 2;
  const q = db.prepare('SELECT id FROM products WHERE slug = ? AND id != ?');
  while (q.get(slug, ignoreId || 0)) slug = `${base}-${n++}`;
  return slug;
}

function saveProduct(req, res, next) {
  const b = req.body;
  const id = req.params.id ? parseInt(req.params.id, 10) : null;
  const existing = id ? db.prepare('SELECT * FROM products WHERE id = ?').get(id) : null;
  if (id && !existing) return next();

  const name = String(b.name || '').trim().slice(0, 120);
  const price = Math.round(parseFloat(b.price) * 100);
  const category = CATEGORIES[b.category] ? b.category : null;
  const files = req.files || [];
  const mainFile = files.find((f) => f.fieldname === 'image');
  const removeFile = (image) => image && !image.startsWith('/') && fs.unlink(path.join(UPLOAD_DIR, path.basename(image)), () => {});
  const discardUpload = () => files.forEach((f) => fs.unlink(f.path, () => {}));
  if (!name || !category || !Number.isFinite(price) || price < 0) {
    discardUpload();
    req.session.flash = { type: 'error', text: 'Name, category and a valid price are required.' };
    return res.redirect(id ? '/admin/products/' + id : '/admin/products/new');
  }

  const fields = {
    name, category, price_cents: price,
    slug: uniqueSlug(slugify(b.slug || name), id),
    description: String(b.description || '').trim().slice(0, 4000),
    design_text: String(b.design_text || '').trim().slice(0, 40),
    featured: b.featured ? 1 : 0,
    active: b.active ? 1 : 0,
    image: mainFile ? mainFile.filename : b.remove_image ? null : existing ? existing.image : null,
  };

  const stale = [];
  const productId = db.transaction(() => {
    let pid = id;
    if (id) {
      db.prepare(`UPDATE products SET name=@name, category=@category, price_cents=@price_cents, slug=@slug,
        description=@description, design_text=@design_text, featured=@featured, active=@active, image=@image WHERE id=@id`)
        .run({ ...fields, id });
    } else {
      pid = Number(db.prepare(`INSERT INTO products (name, category, price_cents, slug, description, design_text, featured, active, image)
        VALUES (@name,@category,@price_cents,@slug,@description,@design_text,@featured,@active,@image)`).run(fields).lastInsertRowid);
    }
    // Existing variants: update stock or delete.
    const setStock = db.prepare('UPDATE variants SET stock = ? WHERE id = ? AND product_id = ?');
    const del = db.prepare('DELETE FROM variants WHERE id = ? AND product_id = ?');
    for (const [vid, stock] of Object.entries(b.stock || {})) {
      if (b.delete && b.delete[vid]) del.run(vid, pid);
      else setStock.run(Math.max(0, parseInt(stock, 10) || 0), vid, pid);
    }
    // New variants: every color x size combination that does not exist yet.
    const colors = String(b.new_colors || '').split('\n').map((line) => {
      const m = line.trim().match(/^(.*?)\s*(#[0-9a-fA-F]{6})?$/);
      return m && m[1] ? [m[1].trim().slice(0, 40), (m[2] || '#151515').toLowerCase()] : null;
    }).filter(Boolean);
    const sizes = String(b.new_sizes || '').split(',').map((s) => s.trim().slice(0, 20)).filter(Boolean);
    const initial = Math.max(0, parseInt(b.new_stock, 10) || 0);
    const ins = db.prepare('INSERT OR IGNORE INTO variants (product_id, color, color_hex, size, stock) VALUES (?,?,?,?,?)');
    for (const [color, hex] of colors) for (const size of sizes) ins.run(pid, color, hex, size, initial);
    // Per-color photos: replace, remove, and clean up photos for colors that no longer exist.
    const getImg = db.prepare('SELECT image FROM product_images WHERE product_id = ? AND color = ?');
    const delImg = db.prepare('DELETE FROM product_images WHERE product_id = ? AND color = ?');
    const putImg = db.prepare('INSERT OR REPLACE INTO product_images (product_id, color, image) VALUES (?,?,?)');
    for (const [i, color] of Object.entries(b.cimg_color || {})) {
      const file = files.find((f) => f.fieldname === 'cimg_' + i);
      const old = getImg.get(pid, color);
      if (file) { putImg.run(pid, color, file.filename); stale.push(old && old.image); }
      else if (b.cimg_remove && b.cimg_remove[i] && old) { delImg.run(pid, color); stale.push(old.image); }
    }
    for (const row of db.prepare(`SELECT color, image FROM product_images WHERE product_id = ?
        AND color NOT IN (SELECT color FROM variants WHERE product_id = ?)`).all(pid, pid)) {
      delImg.run(pid, row.color); stale.push(row.image);
    }
    return pid;
  })();
  stale.forEach(removeFile);

  if (existing && existing.image !== fields.image) removeFile(existing.image);
  req.session.flash = { type: 'ok', text: 'Product saved.' };
  res.redirect('/admin/products/' + productId);
}

router.post('/products/new', upload.any(), saveProduct);
router.post('/products/:id', upload.any(), saveProduct);

module.exports = router;
