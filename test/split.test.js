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
    { id: 10, name: 'Pizza', price: 30000, qty: 1 }, // one plate shared by 1 & 2
    { id: 11, name: 'Chai', price: 5000, qty: 2 },   // two cups, Chen had both
    { id: 12, name: 'Fries', price: 10000, qty: 1 }, // unclaimed
  ];
  const claims = [{ itemId: 10, personId: 1 }, { itemId: 10, personId: 2 }, { itemId: 11, personId: 3, units: 2 }];
  const r = computeSplit({ tax: 2500, tip: 1000, discount: 500, payerId: 1 }, items, people, claims);
  const by = Object.fromEntries(r.persons.map((p) => [p.name, p]));
  assert.strictEqual(by.Aarav.subtotal, 15000);
  assert.strictEqual(by.Chen.subtotal, 10000);
  assert.strictEqual(r.unclaimed.length, 1);
  assert.strictEqual(r.claimedTotal, 40000);
  // Extras are shared against the whole bill: the unclaimed fries' part waits, nobody gets it yet.
  const sum = (k) => r.persons.reduce((a, p) => a + p[k], 0);
  assert.strictEqual(by.Aarav.tax, 750); // 150 / 500 of ₹25
  assert.strictEqual(sum('tax') + sum('tip') - sum('discount') + r.extrasPending, 2500 + 1000 - 500);
  // payer is not in the settle-up list
  assert.deepStrictEqual(r.settlements.map((s) => s.from).sort(), ['Bea', 'Chen']);
});

test('several plates: each person pays for the number they had', () => {
  const people = [{ id: 1, name: 'Me' }, { id: 2, name: 'Friend' }];
  const items = [{ id: 1, name: 'Crispy Idli Sticks', price: 19400, qty: 2 }];
  // Only I have claimed so far: I pay for 1 plate, the other plate is still unclaimed.
  let r = computeSplit({ tax: 0, tip: 0, discount: 0, payerId: 1 }, items, people, [{ itemId: 1, personId: 1, units: 1 }]);
  assert.strictEqual(r.persons[0].subtotal, 19400);
  assert.deepStrictEqual(r.unclaimed.map((u) => [u.unitsLeft, u.amount]), [[1, 19400]]);
  // My friend claims the other plate.
  r = computeSplit({ tax: 0, tip: 0, discount: 0, payerId: 1 }, items, people, [
    { itemId: 1, personId: 1, units: 1 }, { itemId: 1, personId: 2, units: 1 }]);
  assert.deepStrictEqual(r.persons.map((p) => p.subtotal), [19400, 19400]);
  assert.strictEqual(r.unclaimed.length, 0);
});

test('tax is not dumped on the first person to claim', () => {
  const people = [{ id: 1, name: 'Me' }, { id: 2, name: 'Friend' }];
  const items = [{ id: 1, name: 'Idli', price: 38800, qty: 1 }, { id: 2, name: 'Rest of the bill', price: 415500, qty: 1 }];
  const r = computeSplit({ tax: 22716, tip: 0, discount: 0, payerId: 1 }, items, people, [{ itemId: 1, personId: 1 }]);
  assert.strictEqual(r.persons[0].tax, 1940); // 388 / 4543 of ₹227.16 = ₹19.40, not all ₹227.16
  assert.strictEqual(r.extrasPending, 22716 - 1940);
});

test('equal mode splits tax & service evenly between everyone sharing the bill', () => {
  const people = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
  const items = [{ id: 1, name: 'Thali', price: 30000, qty: 1 }, { id: 2, name: 'Tea', price: 3000, qty: 1 }];
  const claims = [{ itemId: 1, personId: 1 }, { itemId: 2, personId: 2 }];
  const bill = { tax: 1200, tip: 600, discount: 0, payerId: 1, extrasMode: 'equal', headcount: 3 };
  const r = computeSplit(bill, items, people, claims);
  // 3 people are sharing, 2 have joined: each pays a third, the third seat's share waits.
  assert.deepStrictEqual(r.persons.map((p) => p.tax + p.tip), [600, 600]);
  assert.strictEqual(r.extrasPending, 600);
  assert.strictEqual(r.headcount, 3);
});

test('fully claimed bill: everyone’s totals equal the grand total', () => {
  const people = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];
  const items = [{ id: 1, name: 'X', price: 10001, qty: 1 }, { id: 2, name: 'Y', price: 333, qty: 3 }];
  const claims = [1, 2, 3].flatMap((p) => [{ itemId: 1, personId: p }]).concat([{ itemId: 2, personId: 2, units: 3 }]);
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
Pepsi 500 60
Order No 4411`);
  assert.deepStrictEqual(r.items.map((i) => i.name), ['Pan Pizza', 'Reg Fries', 'Side Order of Fries', 'Pepsi 500']);
  assert.strictEqual(r.items[3].price, 6000);
});

test('parseReceipt handles Qty / Rate / Amount columns', () => {
  const bill = (subtotal) => `Item              Qty   Rate    Amount
Tandoori chicken    1   295.00  309.75
Lasoon| Dal Tadka   1   275.00  288.75
BIRYANI             2   375.00  787.50
Butter Naan         | 45.00 47.25
${subtotal}
CGST 2.5%                    28.50
SGST 2.5%                    28.50
Grand Total                1197.00`;
  // Tax listed separately: the subtotal matches the Rate column, so rates are used.
  let r = parseReceipt(bill('Sub Total                  1140.00'));
  assert.deepStrictEqual(r.items, [
    { name: 'Tandoori chicken', qty: 1, price: 29500 },
    { name: 'Lasoon Dal Tadka', qty: 1, price: 27500 },
    { name: 'BIRYANI', qty: 2, price: 37500 },
    { name: 'Butter Naan', qty: 1, price: 4500 },
  ]);
  // Subtotal matches the Amount column (tax folded in): amounts are used instead.
  r = parseReceipt(bill('Sub Total                  1433.25'));
  assert.deepStrictEqual(r.items.map((i) => i.price), [30975, 28875, 39375, 4725]);
  // No subtotal printed: fall back to the rate.
  r = parseReceipt(bill(''));
  assert.strictEqual(r.items[0].price, 29500);
});

test('parseReceipt reads "x2.0=240.00" quantities, comma decimals and common OCR slips', () => {
  const r = parseReceipt(`Table:44.0
Jameson 4 cl                 95.00
pepsi 0,25 l             x2.0=240.00
seven up 0,25 l           X2.0%140,00   "
potato soup in bread bowl %4..0=600.00
chicken broth                 90,00
beef ribs roasted with be %2.0=780.,00
czech variety platter        490.00   oy
bacon dumpling              X2.05140.00
house drink-included in m    x7.0=0.00
TOTAL                      6690.00`);
  assert.deepStrictEqual(r.items, [
    { name: 'Jameson 4 cl', qty: 1, price: 9500 },
    { name: 'Pepsi 0,25 l', qty: 2, price: 12000 },
    { name: 'Seven up 0,25 l', qty: 2, price: 7000 },
    { name: 'Potato soup in bread bowl', qty: 4, price: 15000 },
    { name: 'Chicken broth', qty: 1, price: 9000 },
    { name: 'Beef ribs roasted with be', qty: 2, price: 39000 },
    { name: 'Czech variety platter', qty: 1, price: 49000 },
    { name: 'Bacon dumpling', qty: 2, price: 7000 },
  ]);
  assert.strictEqual(r.total, 669000);
});

test('parseReceipt copes with background noise, wrapped names and misread digits (real OCR output)', () => {
  // Tesseract's output for a phone photo of a café bill held in a leather folder
  const r = parseReceipt(`Poller Bl No. 5376          s sie
rleny [dll Sticks 2194.00 388.00     SoA
in      alm vada Dahl 3 221,00 663.0C      18 Sey
lll Chaat                              GEE
ll Garlic Roast     2 230.00 460.00      Stale
Masala Dosa                      ES REE
;   Ghee Podi Masale 3 230.00 690.00      2h
Dosa                                 2
The 0G Cold      3 194,00 582.00          ;
Coffee
Kokum Cooler {    1 158.00 158.00
3        Real Fruit )
Total Qty: 23 —UR4543.00
z                 CEST@2.5 2.5% 113.58
SGST@2.5 2.5% 113.58
Round off         -0.1€
Grand Total 4770.00
Thanks For Visit Again`);
  assert.deepStrictEqual(r.items, [
    { name: 'Rleny (dll Sticks', qty: 2, price: 19400 },
    { name: 'Alm vada Dahl Chaat', qty: 3, price: 22100 },
    { name: 'Garlic Roast Masala Dosa', qty: 2, price: 23000 },
    { name: 'Ghee Podi Masale Dosa', qty: 3, price: 23000 },
    { name: 'The OG Cold Coffee', qty: 3, price: 19400 },
    { name: 'Kokum Cooler (Real Fruit)', qty: 1, price: 15800 },
  ]);
  assert.strictEqual(r.tax, 22716);
  assert.strictEqual(r.total, 477000);
});
