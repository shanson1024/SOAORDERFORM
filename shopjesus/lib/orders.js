const { db, newToken } = require('./db');
const { config, money } = require('./helpers');

let transporter = null;
if (process.env.SMTP_URL) {
  transporter = require('nodemailer').createTransport(process.env.SMTP_URL);
}

async function sendMail(to, subject, text) {
  if (!transporter || !to) return;
  try {
    await transporter.sendMail({ from: process.env.MAIL_FROM || config.contactEmail, to, subject, text });
  } catch (err) {
    console.error('Email failed:', err.message);
  }
}

function getOrder(where, value) {
  const order = db.prepare(`SELECT * FROM orders WHERE ${where} = ?`).get(value);
  if (!order) return null;
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  order.address = order.address ? JSON.parse(order.address) : null;
  return order;
}

/** Creates a pending order from priced cart lines. */
function createPendingOrder(cart) {
  return db.transaction(() => {
    const { lastInsertRowid: id } = db.prepare(
      'INSERT INTO orders (token, subtotal_cents, shipping_cents, total_cents) VALUES (?,?,?,?)'
    ).run(newToken(), cart.subtotal, cart.shipping, cart.total);
    const number = 'SJ-' + (100000 + Number(id));
    db.prepare('UPDATE orders SET number = ? WHERE id = ?').run(number, id);
    const ins = db.prepare(`INSERT INTO order_items
      (order_id, variant_id, product_name, color, size, unit_price_cents, quantity) VALUES (?,?,?,?,?,?,?)`);
    for (const l of cart.lines) ins.run(id, l.variant_id, l.name, l.color, l.size, l.price_cents, l.qty);
    return getOrder('id', id);
  })();
}

/** Marks an order paid and takes stock. Safe to call more than once. Returns true if it changed. */
function markPaid(orderId, details) {
  const changed = db.transaction(() => {
    const res = db.prepare(`UPDATE orders SET status='paid', paid_at=datetime('now'),
        email=?, name=?, address=?, subtotal_cents=?, shipping_cents=?, tax_cents=?, total_cents=?,
        stripe_payment_intent=?
      WHERE id=? AND status='pending'`).run(
      details.email || null, details.name || null, details.address ? JSON.stringify(details.address) : null,
      details.subtotal, details.shipping, details.tax || 0, details.total, details.paymentIntent || null, orderId);
    if (res.changes === 0) return false;
    const dec = db.prepare('UPDATE variants SET stock = MAX(stock - ?, 0) WHERE id = ?');
    for (const it of db.prepare('SELECT variant_id, quantity FROM order_items WHERE order_id = ?').all(orderId)) {
      if (it.variant_id) dec.run(it.quantity, it.variant_id);
    }
    return true;
  })();
  if (changed) {
    const o = getOrder('id', orderId);
    const lines = o.items.map((i) => `  ${i.quantity} x ${i.product_name} (${i.color} / ${i.size}) - ${money(i.unit_price_cents * i.quantity)}`);
    sendMail(o.email, `Your ${config.storeName} order ${o.number}`,
      `Thank you for your order!\n\nOrder ${o.number}\n${lines.join('\n')}\n\nShipping: ${money(o.shipping_cents)}\nTax: ${money(o.tax_cents)}\nTotal: ${money(o.total_cents)}\n\nWe'll email you again when it ships.\n\nQuestions? ${config.contactEmail}`);
    if (process.env.ORDER_NOTIFY_EMAIL) {
      sendMail(process.env.ORDER_NOTIFY_EMAIL, `New order ${o.number} - ${money(o.total_cents)}`, lines.join('\n'));
    }
  }
  return changed;
}

/** Applies a completed Stripe Checkout session to its order. */
function fulfillStripeSession(session) {
  if (session.payment_status !== 'paid') return false;
  const orderId = parseInt(session.metadata && session.metadata.order_id, 10);
  if (!orderId) return false;
  const ship = (session.collected_information && session.collected_information.shipping_details) || session.shipping_details || {};
  const cust = session.customer_details || {};
  const td = session.total_details || {};
  return markPaid(orderId, {
    email: cust.email,
    name: ship.name || cust.name,
    address: ship.address || cust.address,
    subtotal: session.amount_subtotal,
    shipping: td.amount_shipping || 0,
    tax: td.amount_tax || 0,
    total: session.amount_total,
    paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
  });
}

function markShipped(orderId, tracking) {
  const res = db.prepare(`UPDATE orders SET status='shipped', shipped_at=datetime('now'), tracking_number=?
    WHERE id=? AND status IN ('paid','shipped')`).run(tracking || null, orderId);
  if (res.changes) {
    const o = getOrder('id', orderId);
    sendMail(o.email, `Your ${config.storeName} order ${o.number} has shipped`,
      `Good news, your order ${o.number} is on its way.` + (tracking ? `\n\nTracking number: ${tracking}` : '') + `\n\nQuestions? ${config.contactEmail}`);
  }
  return res.changes > 0;
}

module.exports = { getOrder, createPendingOrder, markPaid, fulfillStripeSession, markShipped };
