const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const { computeSplit, parseReceipt } = require('./split');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const COLORS = ['#e4572e', '#17bebb', '#ffc914', '#76b041', '#7e5bef', '#ff7aa2', '#2e86ab', '#f18f01', '#3bb273', '#c03221'];
const newId = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const toPaise = (v) => Math.max(0, Math.round(Number(v || 0) * 100));
const clean = (s, max = 60) => String(s || '').trim().slice(0, max);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- live updates (Server-Sent Events) ----------
const listeners = new Map(); // billId -> Set<res>

function broadcast(billId) {
  const subs = listeners.get(billId);
  if (!subs) return;
  const payload = `data: ${JSON.stringify(loadBill(billId))}\n\n`;
  for (const res of subs) res.write(payload);
}

// ---------- data access ----------
function getBillRow(id) {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
  if (!bill) throw new HttpError(404, 'Bill not found');
  return bill;
}

function loadBill(id) {
  const bill = getBillRow(id);
  const items = db.prepare('SELECT id, name, price, qty FROM items WHERE bill_id = ? ORDER BY id').all(id);
  const people = db.prepare('SELECT id, name, color FROM people WHERE bill_id = ? ORDER BY id').all(id);
  const claims = db
    .prepare('SELECT c.item_id AS itemId, c.person_id AS personId FROM claims c JOIN items i ON i.id = c.item_id WHERE i.bill_id = ?')
    .all(id);
  const split = computeSplit(
    { tax: bill.tax, tip: bill.tip, discount: bill.discount, payerId: bill.payer_id },
    items, people, claims,
  );
  return {
    id: bill.id,
    title: bill.title,
    upiId: bill.upi_id,
    tax: bill.tax,
    tip: bill.tip,
    discount: bill.discount,
    payerId: bill.payer_id,
    locked: !!bill.locked,
    createdAt: bill.created_at,
    items, people, claims, split,
  };
}

function requireAdmin(req, bill) {
  if (req.get('x-admin-token') !== bill.admin_token) throw new HttpError(403, 'Only the person who created this bill can do that');
}

function insertItems(billId, items) {
  const stmt = db.prepare('INSERT INTO items (bill_id, name, price, qty) VALUES (?, ?, ?, ?)');
  for (const it of items) {
    const name = clean(it.name);
    const qty = Math.min(99, Math.max(1, parseInt(it.qty, 10) || 1));
    const price = toPaise(it.price);
    if (name && price > 0) stmt.run(billId, name, price, qty);
  }
}

function addPerson(billId, name) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM people WHERE bill_id = ?').get(billId).n;
  if (count >= 30) throw new HttpError(400, 'This bill already has 30 people');
  const existing = db.prepare('SELECT id FROM people WHERE bill_id = ? AND name = ? COLLATE NOCASE').get(billId, name);
  if (existing) return existing.id;
  const r = db.prepare('INSERT INTO people (bill_id, name, color) VALUES (?, ?, ?)').run(billId, name, COLORS[count % COLORS.length]);
  return Number(r.lastInsertRowid);
}

// ---------- routes ----------
const route = (fn) => (req, res) => {
  try { fn(req, res); } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message });
  }
};

// Turn pasted receipt text into items + extras.
app.post('/api/parse-receipt', route((req, res) => {
  const parsed = parseReceipt(clean(req.body.text, 20000));
  res.json({
    items: parsed.items.map((i) => ({ ...i, price: i.price / 100 })),
    tax: parsed.tax / 100, tip: parsed.tip / 100, discount: parsed.discount / 100,
  });
}));

// Create a bill. Returns the admin token, which only the creator keeps.
app.post('/api/bills', route((req, res) => {
  const title = clean(req.body.title) || 'Untitled bill';
  const payerName = clean(req.body.payerName, 30);
  if (!payerName) throw new HttpError(400, 'Tell us who paid');
  if (!Array.isArray(req.body.items) || req.body.items.length === 0) throw new HttpError(400, 'Add at least one item');
  if (req.body.items.length > 200) throw new HttpError(400, 'Too many items');

  const id = newId(6);
  const adminToken = newId(18);
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO bills (id, admin_token, title, upi_id, tax, tip, discount) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, adminToken, title, clean(req.body.upiId, 60) || null, toPaise(req.body.tax), toPaise(req.body.tip), toPaise(req.body.discount));
    insertItems(id, req.body.items);
    const payerId = addPerson(id, payerName);
    db.prepare('UPDATE bills SET payer_id = ? WHERE id = ?').run(payerId, id);
    db.exec('COMMIT');
    res.status(201).json({ id, adminToken, personId: payerId, bill: loadBill(id) });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}));

app.get('/api/bills/:id', route((req, res) => res.json(loadBill(req.params.id))));

// Live stream of bill updates.
app.get('/api/bills/:id/events', route((req, res) => {
  const bill = loadBill(req.params.id);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(bill)}\n\n`);
  if (!listeners.has(bill.id)) listeners.set(bill.id, new Set());
  listeners.get(bill.id).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    listeners.get(bill.id)?.delete(res);
  });
}));

// Join a bill as a person (or rejoin with the same name).
app.post('/api/bills/:id/people', route((req, res) => {
  const bill = getBillRow(req.params.id);
  if (bill.locked) throw new HttpError(409, 'This bill is locked');
  const name = clean(req.body.name, 30);
  if (!name) throw new HttpError(400, 'Enter your name');
  const personId = addPerson(bill.id, name);
  broadcast(bill.id);
  res.status(201).json({ personId });
}));

// Tap an item: claim it if you haven't, unclaim it if you have.
app.post('/api/bills/:id/claims/toggle', route((req, res) => {
  const bill = getBillRow(req.params.id);
  if (bill.locked) throw new HttpError(409, 'This bill is locked');
  const itemId = Number(req.body.itemId);
  const personId = Number(req.body.personId);
  const item = db.prepare('SELECT id FROM items WHERE id = ? AND bill_id = ?').get(itemId, bill.id);
  const person = db.prepare('SELECT id FROM people WHERE id = ? AND bill_id = ?').get(personId, bill.id);
  if (!item || !person) throw new HttpError(400, 'Unknown item or person');

  const exists = db.prepare('SELECT 1 FROM claims WHERE item_id = ? AND person_id = ?').get(itemId, personId);
  if (exists) db.prepare('DELETE FROM claims WHERE item_id = ? AND person_id = ?').run(itemId, personId);
  else db.prepare('INSERT INTO claims (item_id, person_id) VALUES (?, ?)').run(itemId, personId);
  broadcast(bill.id);
  res.json({ claimed: !exists });
}));

// Creator-only: edit tax/tip/discount/UPI, lock or unlock the bill.
app.patch('/api/bills/:id', route((req, res) => {
  const bill = getBillRow(req.params.id);
  requireAdmin(req, bill);
  const b = req.body;
  db.prepare('UPDATE bills SET title = ?, upi_id = ?, tax = ?, tip = ?, discount = ?, locked = ? WHERE id = ?').run(
    b.title !== undefined ? clean(b.title) || bill.title : bill.title,
    b.upiId !== undefined ? clean(b.upiId, 60) || null : bill.upi_id,
    b.tax !== undefined ? toPaise(b.tax) : bill.tax,
    b.tip !== undefined ? toPaise(b.tip) : bill.tip,
    b.discount !== undefined ? toPaise(b.discount) : bill.discount,
    b.locked !== undefined ? (b.locked ? 1 : 0) : bill.locked,
    bill.id,
  );
  broadcast(bill.id);
  res.json(loadBill(bill.id));
}));

// Creator-only: add or remove items after creation.
app.post('/api/bills/:id/items', route((req, res) => {
  const bill = getBillRow(req.params.id);
  requireAdmin(req, bill);
  insertItems(bill.id, [req.body]);
  broadcast(bill.id);
  res.status(201).json(loadBill(bill.id));
}));

app.delete('/api/bills/:id/items/:itemId', route((req, res) => {
  const bill = getBillRow(req.params.id);
  requireAdmin(req, bill);
  db.prepare('DELETE FROM items WHERE id = ? AND bill_id = ?').run(Number(req.params.itemId), bill.id);
  broadcast(bill.id);
  res.json(loadBill(bill.id));
}));

// Single-page app: any other route serves index.html.
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`TapSplit running at http://localhost:${port}`));
}

module.exports = app;
