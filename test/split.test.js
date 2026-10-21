const test = require('node:test');
const assert = require('node:assert');
const { allocate, computeSplit, parseReceipt } = require('../split');

test('allocate always sums to the total', () => {
  assert.deepStrictEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepStrictEqual(allocate(0, [5, 5]), [0, 0]);
  assert.deepStrictEqual(allocate(50, [0, 0]), [0, 0]);
  for (let i = 0; i < 200; i++) {
    const w = Array.from({ length: 1 + (i % 7) }, (_, k) => (k * 37 + i) % 900);
    const t = i * 13;
    const parts = allocate(t, w);
    if (w.some((x) => x > 0)) assert.strictEqual(parts.reduce((a, b) => a + b, 0), t);
  }
});

test('shared items, proportional tax/tip/discount, exact totals', () => {
  const people = [{ id: 1, name: 'Aarav' }, { id: 2, name: 'Bea' }, { id: 3, name: 'Chen' }];
  const items = [
    { id: 10, name: 'Pizza', price: 30000, qty: 1 }, // shared by 1 & 2
    { id: 11, name: 'Chai', price: 5000, qty: 2 },   // Chen alone
    { id: 12, name: 'Fries', price: 10000, qty: 1 }, // unclaimed
  ];
  const claims = [{ itemId: 10, personId: 1 }, { itemId: 10, personId: 2 }, { itemId: 11, personId: 3 }];
  const r = computeSplit({ tax: 2500, tip: 1000, discount: 500, payerId: 1 }, items, people, claims);
  const by = Object.fromEntries(r.persons.map((p) => [p.name, p]));
  assert.strictEqual(by.Aarav.subtotal, 15000);
  assert.strictEqual(by.Chen.subtotal, 10000);
  assert.strictEqual(r.unclaimed.length, 1);
  assert.strictEqual(r.claimedTotal, 40000);
  // extras fully distributed across claimers
  const sum = (k) => r.persons.reduce((a, p) => a + p[k], 0);
  assert.strictEqual(sum('tax'), 2500);
  assert.strictEqual(sum('tip'), 1000);
  assert.strictEqual(sum('discount'), 500);
  // payer is not in the settle-up list
  assert.deepStrictEqual(r.settlements.map((s) => s.from).sort(), ['Bea', 'Chen']);
});

test('fully claimed bill: everyone’s totals equal the grand total', () => {
  const people = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];
  const items = [{ id: 1, name: 'X', price: 10001, qty: 1 }, { id: 2, name: 'Y', price: 333, qty: 3 }];
  const claims = [1, 2, 3].flatMap((p) => [{ itemId: 1, personId: p }]).concat([{ itemId: 2, personId: 2 }]);
  const r = computeSplit({ tax: 777, tip: 101, discount: 50, payerId: 1 }, items, people, claims);
  assert.strictEqual(r.persons.reduce((a, p) => a + p.total, 0), r.grandTotal);
  assert.strictEqual(r.progress, 1);
});

test('parseReceipt reads items, quantities and extras', () => {
  const r = parseReceipt(`CAFE BLUE TOKAI - Table 7
Bill No: 4521  Guests 3
Paneer Tikka 1 x 280.00
Butter Naan   4 x 45
2 Cold Coffee  360.00
Dal ..... 260
Sub Total 1390
CGST 2.5% 34.75
SGST 2.5% 34.75
Service Charge 69.50
Discount -139
Grand Total 1399`);
  assert.deepStrictEqual(r.items, [
    { name: 'Paneer Tikka', qty: 1, price: 28000 },
    { name: 'Butter Naan', qty: 4, price: 4500 },
    { name: 'Cold Coffee', qty: 2, price: 18000 },
    { name: 'Dal', qty: 1, price: 26000 },
  ]);
  assert.strictEqual(r.tax, 6950);
  assert.strictEqual(r.tip, 6950);
  assert.strictEqual(r.discount, 13900);
});

test('parseReceipt skips card-machine lines and returns the subtotal', () => {
  // OCR output of a real-style US card receipt
  const r = parseReceipt(`HARBOR LANE CAFE
3941 GREEN OAKS BLVD
CHICAGO, IL
SALE
11/20/2019     11:05 AM
BATCH #:01A2A
APPR #:34362
TRACE # 8
VISA 3483
1 Tacos Del Mal Shrimp      $14.98
1 Especial Salad Chicken $12.50
1 Fountain Beverage       $1.99
SUBTOTAL:    $29.47
TAX:         $1.92
TOTAL:       $31.39
TIP:
APPROVED
CARD XXXX XXXX 1234`);
  assert.deepStrictEqual(r.items.map((i) => i.name), ['Tacos Del Mal Shrimp', 'Especial Salad Chicken', 'Fountain Beverage']);
  assert.strictEqual(r.subtotal, 2947);
  assert.strictEqual(r.items.reduce((a, i) => a + i.price * i.qty, 0), r.subtotal);
  assert.strictEqual(r.tax, 192);
});

test('parseReceipt keeps dishes whose names contain everyday words', () => {
  const r = parseReceipt(`Pan Pizza 299
Reg Fries 99
Side Order of Fries 120
Order No 4411`);
  assert.deepStrictEqual(r.items.map((i) => i.name), ['Pan Pizza', 'Reg Fries', 'Side Order of Fries']);
});
