const { db } = require('./db');

const config = {
  storeName: 'ShopJesus.com',
  contactEmail: process.env.CONTACT_EMAIL || 'support@shopjesus.com',
  shippingFlatCents: parseInt(process.env.SHIPPING_FLAT_CENTS || '595', 10),
  freeShippingThresholdCents: parseInt(process.env.FREE_SHIPPING_THRESHOLD_CENTS || '7500', 10),
  shipCountries: (process.env.SHIP_COUNTRIES || 'US').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  stripeTax: process.env.STRIPE_TAX === 'true',
  isProd: process.env.NODE_ENV === 'production',
  // Made to order: nothing sells out and stock is not tracked. Set MADE_TO_ORDER=false to track inventory.
  madeToOrder: process.env.MADE_TO_ORDER !== 'false',
};

/** SQL expression for a variant's available quantity. */
const STOCK = config.madeToOrder ? '9999' : 'v.stock';

const CATEGORIES = { tshirts: 'T-Shirts', hoodies: 'Hoodies', hats: 'Hats', polos: 'Polos', buttondowns: 'Button-Downs' };
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', 'One Size'];

function money(cents) {
  return '$' + (cents / 100).toFixed(2);
}

function shippingFor(subtotalCents) {
  if (subtotalCents <= 0) return 0;
  return subtotalCents >= config.freeShippingThresholdCents ? 0 : config.shippingFlatCents;
}

function sortSizes(a, b) {
  const ia = SIZE_ORDER.indexOf(a), ib = SIZE_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
}

/** Stored images are either a site path (bundled photos) or a filename in the uploads folder. */
function imageUrl(image) {
  return image.startsWith('/') ? image : '/uploads/' + image;
}

const colorImageQ = db.prepare('SELECT image FROM product_images WHERE product_id = ? AND color = ?');
const firstImageQ = db.prepare(`SELECT pi.image, pi.color FROM product_images pi
  LEFT JOIN variants v ON v.product_id = pi.product_id AND v.color = pi.color
  WHERE pi.product_id = ? ORDER BY v.id LIMIT 1`);

/** Best image for a product: the photo for that color, else the general photo, else another color's photo, else a drawn mock-up. */
function productImage(p, hex, color) {
  const pid = p.product_id || p.id;
  const byColor = color && colorImageQ.get(pid, color);
  if (byColor) return imageUrl(byColor.image);
  if (p.image) return imageUrl(p.image);
  const any = firstImageQ.get(pid);
  if (any) return imageUrl(any.image);
  return `/img/p/${p.slug}.svg` + (hex ? '?c=' + encodeURIComponent(hex.replace('#', '')) : '');
}

/** Cart lives in the session cookie as [{v: variantId, q: qty}]. Returns priced lines from the DB. */
function loadCart(req) {
  const raw = Array.isArray(req.session.cart) ? req.session.cart : [];
  const q = db.prepare(`SELECT v.id variant_id, v.color, v.color_hex, v.size, ${STOCK} stock,
      p.id product_id, p.slug, p.name, p.price_cents, p.image, p.category
    FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ? AND p.active = 1`);
  const lines = [];
  const notices = [];
  for (const item of raw) {
    const row = q.get(item.v);
    if (!row) continue;
    let qty = Math.max(1, Math.min(parseInt(item.q, 10) || 1, 20));
    if (row.stock <= 0) {
      notices.push(`${row.name} (${row.color} / ${row.size}) is sold out and was removed from your cart.`);
      continue;
    }
    if (qty > row.stock) {
      qty = row.stock;
      notices.push(`Only ${row.stock} left of ${row.name} (${row.color} / ${row.size}); quantity updated.`);
    }
    lines.push({ ...row, qty, line_cents: qty * row.price_cents, img: productImage(row, row.color_hex, row.color) });
  }
  req.session.cart = lines.map((l) => ({ v: l.variant_id, q: l.qty }));
  const subtotal = lines.reduce((s, l) => s + l.line_cents, 0);
  const shipping = shippingFor(subtotal);
  return { lines, notices, subtotal, shipping, total: subtotal + shipping, count: lines.reduce((s, l) => s + l.qty, 0) };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isLight(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

function shade(hex, amt) {
  const n = parseInt(hex.replace('#', ''), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v + amt))).toString(16).padStart(2, '0');
  return '#' + f((n >> 16) & 255) + f((n >> 8) & 255) + f(n & 255);
}

/** Placeholder product artwork, used until a real photo is uploaded in the admin. */
function productSvg(category, hex, text) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) hex = '#151515';
  const light = isLight(hex);
  const ink = light ? '#151515' : '#ffffff';
  const edge = shade(hex, light ? -45 : 40);
  const dark = shade(hex, light ? -22 : -14);
  const words = String(text || '').toUpperCase().split(/\s+/).filter(Boolean);
  const lines = [];
  for (const w of words) {
    if (lines.length && (lines[lines.length - 1] + ' ' + w).length <= 9) lines[lines.length - 1] += ' ' + w;
    else lines.push(w);
  }
  const textBlock = (cx, cy, size) => {
    const longest = Math.max(1, ...lines.map((l) => l.length));
    const fs = Math.min(size, 150 / (longest * 0.74));
    const start = cy - ((lines.length - 1) * fs * 1.1) / 2;
    return lines.map((l, i) =>
      `<text x="${cx}" y="${start + i * fs * 1.1}" text-anchor="middle" dominant-baseline="middle" font-family="Arial Black, Arial, Helvetica, sans-serif" font-weight="900" font-style="italic" font-size="${fs.toFixed(1)}" fill="${ink}">${esc(l)}</text>`).join('');
  };
  let art;
  if (category === 'hats') {
    art = `<path d="M92 236 Q88 112 200 110 Q312 112 308 236 Z" fill="${hex}" stroke="${edge}" stroke-width="3"/>
      <path d="M200 110 Q178 170 180 236 M200 110 Q222 170 220 236" fill="none" stroke="${edge}" stroke-width="2" opacity=".6"/>
      <path d="M90 234 Q200 206 310 234 Q372 248 384 284 Q290 256 90 258 Z" fill="${dark}" stroke="${edge}" stroke-width="3"/>
      <circle cx="200" cy="110" r="7" fill="${dark}" stroke="${edge}" stroke-width="2"/>${textBlock(200, 180, 26)}`;
  } else if (category === 'hoodies') {
    art = `<path d="M135 82 L90 102 L44 302 L90 314 L115 196 L115 356 L285 356 L285 196 L310 314 L356 302 L310 102 L265 82 Q200 134 135 82 Z" fill="${hex}" stroke="${edge}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M135 82 Q200 6 265 82 Q200 132 135 82 Z" fill="${dark}" stroke="${edge}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M152 282 L248 282 L262 338 L138 338 Z" fill="none" stroke="${edge}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M186 118 L182 168 M214 118 L218 168" stroke="${edge}" stroke-width="3" stroke-linecap="round"/>${textBlock(200, 222, 30)}`;
  } else if (category === 'polos') {
    art = `<path d="M140 62 L100 76 L40 132 L76 182 L110 156 L110 344 L290 344 L290 156 L324 182 L360 132 L300 76 L260 62 L200 86 Z" fill="${hex}" stroke="${edge}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M186 80 L186 150 L214 150 L214 80" fill="${dark}" stroke="${edge}" stroke-width="2"/>
      <path d="M140 62 L164 46 L200 84 L176 112 Z M260 62 L236 46 L200 84 L224 112 Z" fill="${dark}" stroke="${edge}" stroke-width="3" stroke-linejoin="round"/>
      <circle cx="200" cy="108" r="3" fill="${edge}"/><circle cx="200" cy="128" r="3" fill="${edge}"/>${textBlock(254, 150, 13)}`;
  } else if (category === 'buttondowns') {
    art = `<path d="M140 66 L92 86 L46 300 L88 312 L114 196 L114 352 L286 352 L286 196 L312 312 L354 300 L308 86 L260 66 L200 90 Z" fill="${hex}" stroke="${edge}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M200 90 L200 352" stroke="${edge}" stroke-width="3"/>
      <path d="M140 66 L166 48 L200 88 L174 118 Z M260 66 L234 48 L200 88 L226 118 Z" fill="${dark}" stroke="${edge}" stroke-width="3" stroke-linejoin="round"/>
      ${[130, 170, 210, 250, 290, 330].map((y) => `<circle cx="207" cy="${y}" r="3" fill="${edge}"/>`).join('')}
      <path d="M46 300 L88 312 L84 330 L42 318 Z" fill="${dark}" stroke="${edge}" stroke-width="2"/><path d="M354 300 L312 312 L316 330 L358 318 Z" fill="${dark}" stroke="${edge}" stroke-width="2"/>${textBlock(254, 160, 12)}`;
  } else {
    art = `<path d="M140 62 L100 76 L40 132 L76 182 L110 156 L110 344 L290 344 L290 156 L324 182 L360 132 L300 76 L260 62 Q200 104 140 62 Z" fill="${hex}" stroke="${edge}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M140 62 Q200 112 260 62" fill="none" stroke="${edge}" stroke-width="6" stroke-linecap="round"/>${textBlock(200, 200, 34)}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img"><rect width="400" height="400" fill="#efefed"/>${art}</svg>`;
}

module.exports = { config, STOCK, CATEGORIES, money, shippingFor, sortSizes, productImage, imageUrl, colorImageQ, firstImageQ, loadCart, productSvg, esc };
