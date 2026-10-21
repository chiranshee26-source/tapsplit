const test = require('node:test');
const assert = require('node:assert');
process.env.DB_PATH = ':memory:';
const app = require('../server');

test('create → join → claim → summary', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}/api`;
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  const created = await call('POST', '/bills', {
    title: 'Dinner', payerName: 'Aarav', tax: 50, tip: 0, discount: 0,
    items: [{ name: 'Pizza', price: 300, qty: 1 }, { name: 'Chai', price: 50, qty: 2 }],
  });
  assert.strictEqual(created.status, 201);
  const { id, adminToken, personId: aarav, bill } = created.body;
  const [pizza, chai] = bill.items;

  const bea = (await call('POST', `/bills/${id}/people`, { name: 'Bea' })).body.personId;
  await call('POST', `/bills/${id}/claims/toggle`, { itemId: pizza.id, personId: aarav });
  await call('POST', `/bills/${id}/claims/toggle`, { itemId: pizza.id, personId: bea });
  await call('POST', `/bills/${id}/claims/set`, { itemId: chai.id, personId: bea, units: 2 });

  const { body: b } = await call('GET', `/bills/${id}`);
  const beaRow = b.split.persons.find((p) => p.personId === bea);
  // Bea: half pizza (150) + chai (100) = 250 of 400 food → 62.5% of ₹50 tax = 31.25
  assert.strictEqual(beaRow.subtotal, 25000);
  assert.strictEqual(beaRow.total, 25000 + 3125);
  assert.deepStrictEqual(b.split.settlements.map((s) => [s.from, s.amount]), [['Bea', 28125]]);

  // toggling again unclaims
  await call('POST', `/bills/${id}/claims/toggle`, { itemId: chai.id, personId: bea });
  assert.strictEqual((await call('GET', `/bills/${id}`)).body.split.unclaimed.length, 1);

  // multi-plate items: say how many you had, and you can't claim more than are left
  const two = (await call('POST', `/bills/${id}/items`, { name: 'Idli', price: 100, qty: 2 }, { 'x-admin-token': adminToken })).body.items.at(-1);
  assert.strictEqual((await call('POST', `/bills/${id}/claims/set`, { itemId: two.id, personId: bea, units: 1 })).status, 200);
  assert.strictEqual((await call('POST', `/bills/${id}/claims/set`, { itemId: two.id, personId: aarav, units: 2 })).status, 409);
  assert.strictEqual((await call('POST', `/bills/${id}/claims/set`, { itemId: two.id, personId: aarav, units: 1 })).status, 200);
  await call('DELETE', `/bills/${id}/items/${two.id}`, null, { 'x-admin-token': adminToken });

  // marking as paid
  await call('POST', `/bills/${id}/people/${bea}/paid`, { paid: true });
  assert.strictEqual((await call('GET', `/bills/${id}`)).body.people.find((p) => p.id === bea).paid, true);

  // admin-only actions are protected
  assert.strictEqual((await call('PATCH', `/bills/${id}`, { locked: true })).status, 403);
  assert.strictEqual((await call('PATCH', `/bills/${id}`, { locked: true }, { 'x-admin-token': adminToken })).status, 200);
  assert.strictEqual((await call('POST', `/bills/${id}/claims/toggle`, { itemId: chai.id, personId: bea })).status, 409);
  assert.strictEqual((await call('GET', '/bills/nope')).status, 404);
});

test('scan a photo of a receipt (OCR)', async (t) => {
  const fs = require('fs');
  const path = require('path');
  const server = app.listen(0);
  t.after(async () => { server.close(); await require('../ocr').closeOcr(); });
  const res = await fetch(`http://localhost:${server.address().port}/api/scan-receipt`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: fs.readFileSync(path.join(__dirname, 'fixtures', 'receipt-photo.jpg')),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.items.length, 6);
  assert.deepStrictEqual(body.items.find((i) => i.name === 'Cold Coffee'), { name: 'Cold Coffee', qty: 2, price: 180 });
  assert.strictEqual(body.discount, 100);
  assert.strictEqual(body.tax, 69.5);
});
