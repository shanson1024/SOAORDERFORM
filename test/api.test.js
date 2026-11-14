'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swaggeroo-test-'));
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.ADMIN_PASSWORD = 'correct-horse-battery';
delete process.env.ANTHROPIC_API_KEY;
const { app, db } = require('../server');

let server, base, cookie = '';
const req = async (method, url, body, opts = {}) => {
  const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(opts.cookie === false ? {} : { Cookie: opts.cookie || cookie }), ...(opts.headers || {}) };
  const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) };
};
const order = extra => ({ companyName: 'Acme', contactName: 'Jo', contactEmail: 'jo@example.com', contactPhone: '555', inHandDate: '2027-03-01', budget: '$2,500 - $4,000',
  items: [{ category: 'Drinkware - Mugs/Tumblers', quantity: '250', decoration: 'Laser Engrave' }, { category: 'Apparel - Polos', quantity: '100', sizes: { M: '60', L: '40' } }], ...extra });

before(async () => { server = app.listen(0); base = 'http://127.0.0.1:' + server.address().port; });
after(() => { server.close(); db.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

test('data and the CRM page need a login', async () => {
  assert.strictEqual((await req('GET', '/api/leads', null, { cookie: false })).status, 401);
  assert.strictEqual((await req('POST', '/api/leads', { company: 'X' }, { cookie: false })).status, 401);
  const page = await req('GET', '/', null, { cookie: false });
  assert.strictEqual(page.status, 302);
  assert.strictEqual(page.headers.get('location'), '/login');
});

test('login rejects a wrong password and accepts the right one', async () => {
  assert.strictEqual((await req('POST', '/api/login', { email: 'admin@example.com', password: 'nope' }, { cookie: false })).status, 401);
  const ok = await req('POST', '/api/login', { email: 'ADMIN@example.com', password: 'correct-horse-battery' }, { cookie: false });
  assert.strictEqual(ok.status, 200);
  cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.strictEqual((await req('GET', '/api/me')).json.user.role, 'admin');
});

test('leads and deals: create, list, update, delete', async () => {
  const { json: { id } } = await req('POST', '/api/leads', { company: 'Blue Ridge', qty: '600', budget: 4000, source: 'Referral', bogus: 'dropped' });
  let rows = (await req('GET', '/api/leads')).json.rows;
  assert.deepStrictEqual([rows.length, rows[0].company, rows[0].qty, rows[0].bogus], [1, 'Blue Ridge', 600, undefined]);
  assert.strictEqual((await req('POST', '/api/leads', { contact: 'no company' })).status, 400);

  const deal = (await req('POST', '/api/deals', { company: 'Blue Ridge', title: 'Tumblers', value: 8700, stage: 1 })).json.id;
  assert.strictEqual((await req('PATCH', '/api/deals/' + deal, { stage: 99 })).status, 200);
  rows = (await req('GET', '/api/deals')).json.rows;
  assert.deepStrictEqual([rows[0].stage, rows[0].value, rows[0].title], [5, 8700, 'Tumblers']);
  assert.strictEqual((await req('PATCH', '/api/deals/missing', { stage: 1 })).status, 404);

  await req('DELETE', '/api/leads/' + id);
  assert.strictEqual((await req('GET', '/api/leads')).json.rows.length, 0);
  assert.strictEqual((await req('GET', '/api/users; DROP TABLE leads')).status, 404);
});

test('the public order form creates a lead without a login', async () => {
  const r = await req('POST', '/api/order-requests', order(), { cookie: false });
  assert.strictEqual(r.status, 200);
  const lead = (await req('GET', '/api/leads')).json.rows[0];
  assert.deepStrictEqual([lead.company, lead.source, lead.status, lead.qty, lead.budget, lead.interest, lead.inHand], ['Acme', 'Order form', 'New', 350, 2500, 'Drinkware', '2027-03-01']);
  assert.match(lead.notes, /Item 2: 100 × Apparel - Polos · Sizes: M:60 L:40/);
});

test('the order form rejects incomplete requests and drops bot submissions', async () => {
  const bad = await req('POST', '/api/order-requests', order({ contactEmail: 'nope', items: [] }), { cookie: false });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.json.errors.length, 2);
  assert.strictEqual((await req('POST', '/api/order-requests', order({ website: 'spam' }), { cookie: false })).status, 200);
  assert.strictEqual((await req('GET', '/api/leads')).json.rows.length, 1);
});

test('writes from another site are refused', async () => {
  const r = await req('POST', '/api/leads', { company: 'Evil' }, { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(r.status, 403);
});

test('admins manage the team; members cannot', async () => {
  assert.strictEqual((await req('POST', '/api/users', { email: 'sam@example.com', name: 'Sam', password: 'short' })).status, 400);
  const { json: { id } } = await req('POST', '/api/users', { email: 'sam@example.com', name: 'Sam', password: 'long-enough-password' });
  const login = await req('POST', '/api/login', { email: 'sam@example.com', password: 'long-enough-password' }, { cookie: false });
  const sam = login.headers.get('set-cookie').split(';')[0];
  assert.strictEqual((await req('GET', '/api/leads', null, { cookie: sam })).status, 200);
  assert.strictEqual((await req('GET', '/api/users', null, { cookie: sam })).status, 403);
  assert.strictEqual((await req('DELETE', '/api/users/' + id)).status, 200);
  assert.strictEqual((await req('GET', '/api/leads', null, { cookie: sam })).status, 401);
});

test('AI is off without a key, and sign-out ends the session', async () => {
  assert.strictEqual((await req('GET', '/api/me')).json.ai, false);
  assert.strictEqual((await req('POST', '/api/ai', { prompt: 'hi' })).status, 503);
  assert.strictEqual((await req('POST', '/api/logout')).status, 200);
  assert.strictEqual((await req('GET', '/api/leads')).status, 401);
});
