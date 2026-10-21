// Pure bill-splitting logic. All money is handled in integer paise (1/100 of a rupee)
// so totals always add up exactly — no floating point drift.

/**
 * Split `total` into parts proportional to `weights`, guaranteeing the parts sum to `total`.
 * Uses the largest-remainder method for the leftover paise.
 */
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const parts = raw.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k].i]++;
  return parts;
}

/**
 * Compute who owes what.
 * @param bill   { tax, tip, discount, payerId, extrasMode, headcount } amounts in paise
 * @param items  [{ id, name, price, qty }] price in paise (per unit)
 * @param people [{ id, name }]
 * @param claims [{ itemId, personId, units }]
 *
 * Claiming an item:
 * - qty 1 (one plate): everyone who claims it shares it equally.
 * - qty > 1 (several plates): each person says how many they had (`units`) and pays for those.
 *
 * Tax, service and discount:
 * - 'proportional' (default): shared by how much food each person had, measured against the WHOLE
 *   bill, so the part belonging to unclaimed food stays unassigned instead of landing on whoever
 *   claimed first.
 * - 'equal': split evenly between everyone sharing the bill (`headcount`, or everyone who joined).
 */
function computeSplit(bill, items, people, claims) {
  const byPerson = new Map(people.map((p) => [p.id, { personId: p.id, name: p.name, subtotal: 0, items: [] }]));
  const unclaimed = [];
  let itemsTotal = 0;
  let claimedTotal = 0;

  for (const item of items) {
    const lineTotal = item.price * item.qty;
    itemsTotal += lineTotal;
    // Sort so any extra paise always go to the same people deterministically.
    const mine = claims
      .filter((c) => c.itemId === item.id && byPerson.has(c.personId))
      .sort((a, b) => a.personId - b.personId);

    if (item.qty === 1) {
      if (!mine.length) { unclaimed.push({ itemId: item.id, name: item.name, amount: lineTotal, unitsLeft: 1 }); continue; }
      claimedTotal += lineTotal;
      const shares = allocate(lineTotal, mine.map(() => 1));
      mine.forEach((c, i) => {
        const entry = byPerson.get(c.personId);
        entry.subtotal += shares[i];
        entry.items.push({ itemId: item.id, name: item.name, share: shares[i], splitWith: mine.length, units: 1 });
      });
      continue;
    }

    // Several plates: everyone pays for the number they had.
    let used = 0;
    for (const c of mine) {
      const units = Math.max(0, Math.min(c.units || 1, item.qty - used));
      if (!units) continue;
      used += units;
      const share = units * item.price;
      claimedTotal += share;
      const entry = byPerson.get(c.personId);
      entry.subtotal += share;
      entry.items.push({ itemId: item.id, name: item.name, share, splitWith: 1, units });
    }
    if (used < item.qty) {
      unclaimed.push({ itemId: item.id, name: item.name, amount: (item.qty - used) * item.price, unitsLeft: item.qty - used });
    }
  }

  const persons = [...byPerson.values()];
  const unclaimedFood = itemsTotal - claimedTotal;
  let weights;
  let headcount = persons.length;
  if (bill.extrasMode === 'equal') {
    // Equal shares for everyone at the table. Seats for people who haven't joined yet stay unassigned.
    headcount = Math.max(bill.headcount || 0, persons.length);
    weights = [...persons.map(() => 1), headcount - persons.length];
  } else {
    weights = [...persons.map((p) => p.subtotal), unclaimedFood];
  }
  const taxShares = allocate(bill.tax, weights);
  const tipShares = allocate(bill.tip, weights);
  const discountShares = allocate(bill.discount, weights);

  persons.forEach((p, i) => {
    p.tax = taxShares[i];
    p.tip = tipShares[i];
    p.discount = discountShares[i];
    p.total = p.subtotal + p.tax + p.tip - p.discount;
  });
  const last = weights.length - 1;
  const extrasPending = taxShares[last] + tipShares[last] - discountShares[last];

  const grandTotal = itemsTotal + bill.tax + bill.tip - bill.discount;

  // Settle-up: everyone except the payer owes the payer their total.
  const settlements = persons
    .filter((p) => p.personId !== bill.payerId && p.total > 0)
    .map((p) => ({ fromId: p.personId, from: p.name, toId: bill.payerId, amount: p.total }));

  return {
    itemsTotal,
    claimedTotal,
    grandTotal,
    extrasMode: bill.extrasMode === 'equal' ? 'equal' : 'proportional',
    headcount,
    extrasPending,
    progress: itemsTotal === 0 ? 0 : claimedTotal / itemsTotal,
    unclaimed,
    persons,
    settlements,
  };
}

/**
 * Best-effort parser for receipt text pasted from a bill / SMS / OCR.
 * Recognises lines like "Paneer Tikka 2 x 180", "2 Cold Coffee 240.00", "Naan ..... 45".
 * Lines mentioning tax/GST/service/tip/discount are pulled out as extras, and the
 * printed subtotal is returned so the app can warn when the items don't add up.
 */
// Lines that end in a number but aren't food: table/bill numbers, card-machine details, contact info…
const NOT_FOOD = new RegExp('\\b(' + [
  'table', 'order\\s*(no|id)', 'bill\\s*no', 'invoice', 'receipt', 'token', 'kot', 'date', 'time', 'gstin', 'fssai',
  'phone', 'ph', 'tel', 'mob(ile)?', 'cashier', 'server', 'steward', 'waiter', 'guests?', 'covers?', 'pax', 'seat', 'emp',
  'batch', 'appr', 'approval', 'auth', 'trace', 'ref', 'rrn', 'tid', 'mid', 'terminal', 'term', 'txn', 'trans(action)?',
  'card', 'visa', 'master(card)?', 'amex', 'rupay', 'maestro', 'debit', 'credit', 'acct', 'account', 'upi', 'chk', 'check',
  'station', 'register', 'store', 'pin', 'zip',
].join('|') + ')\\b');
const LOOKS_LIKE_DATE_OR_TIME = /\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}:\d{2}/;
const MASKED_CARD = /[x*]{3,}\s*\d{2,}/i;
// "x2.0=240.00" (qty 2, line total 240). OCR often turns the "x" into %, ¥ or K, and the "=" into %, :, 4 or 5.
const QTY_EQUALS_TOTAL = /[x×*%¥k]\s*([\dz]{1,2})\s*[.,]\s*0\s*([=%:\-]|[45](?=\d{3}))?\s*(\d[\d,]*[.,]\s?\d{2})\s*$/i;

function parseReceipt(text) {
  const extras = { tax: 0, tip: 0, discount: 0 };
  let subtotal = 0;
  let total = 0;
  // "1,390.00" → 1390, but "90,00" (comma as the decimal point, common in Europe) → 90
  const toPaise = (s) => {
    s = s.replace(/\s/g, '');
    if (/,\d{2}$/.test(s) && !s.includes('.')) s = s.replace(/,(\d{2})$/, '.$1');
    return Math.round(parseFloat(s.replace(/,/g, '')) * 100);
  };

  // Pass 1: clean every line, and note the amount at its end (if any).
  const lines = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine.replace(/[₹$€£]|\brs\.?|\binr\b/gi, ' ').replace(/\s+/g, ' ').trim();
    line = line
      .replace(/(\d)[.,]{2,}\s?(\d)/g, '$1.$2') // doubled punctuation: "780.,00"
      .replace(/(\d[.,]\d)[CcOo](?=\s|$)/g, '$10'); // a final 0 read as C or O: "663.0C"
    // Anything after the last price is noise (the table or wallet behind the bill): "460.00 Stale", "70.00 oy"
    const prices = [...line.matchAll(/\d[\d,]*[.,]\s?\d{2}(?!\d)/g)];
    if (prices.length) {
      const last = prices[prices.length - 1];
      line = line.slice(0, last.index + last[0].length);
    } else {
      line = line.replace(/(\d)(\s+[^\s\d]{1,3})+$/, '$1');
    }
    if (!line) { lines.push({ blank: true }); continue; }

    const qe = line.match(QTY_EQUALS_TOTAL);
    if (qe) {
      const label = line.slice(0, qe.index).trim();
      const qty = +qe[1].replace(/z/gi, '2'); // OCR reads 2 as Z
      lines.push({ raw: line, label, lower: label.toLowerCase(), amount: toPaise(qe[3]), decimal: true, qty });
      continue;
    }
    const money = line.match(/(-?\d[\d,]*(?:[.,]\d{1,2})?)\s*$/);
    if (!money) { lines.push({ raw: line, noAmount: true, text: mainText(rawLine) }); continue; }
    const label = line.slice(0, money.index).replace(/[.\-:=]+\s*$/, '').trim();
    lines.push({ raw: line, label, lower: label.toLowerCase(), amount: toPaise(money[1]), decimal: /[.,]\d{2}$/.test(money[1]), text: mainText(rawLine) });
  }

  // If most amounts on this receipt are written like "14.98", a bare "3483" is an ID, not a price.
  const priced = lines.filter((l) => l.amount !== undefined);
  const decimalCount = priced.filter((l) => l.decimal).length;
  const decimalStyle = decimalCount >= 2 && decimalCount >= priced.length / 2;
  const isQty = (t) => /^\d{1,2}$/.test(t) && +t > 0;

  // Pass 2: sort lines into extras, totals and items.
  const items = [];
  let lastItem = null; // the item on the line just above, in case its name wraps onto this line
  for (const line of lines) {
    const prev = lastItem;
    lastItem = null;
    if (line.blank) continue;
    // A line with no real price may be the second line of the dish above it:
    // "Garlic Roast 2 230.00 460.00" followed by "Masala Dosa" → "Garlic Roast Masala Dosa"
    if (line.noAmount || (decimalStyle && !line.decimal && prev)) {
      const words = cleanName(line.text.replace(/\s\d+$/, ''));
      const letters = (words.match(/[a-z]/gi) || []).length;
      if (prev && letters >= 3 && words.split(' ').length <= 4 && !/[:@#]/.test(line.raw) &&
          !/\b(total|thank|thanks|visit|feedback|scan|please|qty|bill|dine|cashier|table|date|welcome)\b/i.test(words)) {
        prev.name += ' ' + words;
      }
      continue;
    }

    const { raw, label, lower, amount, decimal, qty: fixedQty } = line;
    if (raw.includes('#') || NOT_FOOD.test(lower) || LOOKS_LIKE_DATE_OR_TIME.test(raw) || MASKED_CARD.test(raw)) continue;
    if (/^sub\s*-?\s*total\b/.test(lower)) { subtotal = subtotal || amount; continue; }
    if (/\btotal\s*qty\b/.test(lower)) continue;
    if (/^(grand\s*)?total\b/.test(lower)) { if (/^grand/.test(lower) || !total) total = amount; continue; }
    if (/^(net|amount|bill amount|balance|change|cash|paid|round(ing)?\s*off)\b/.test(lower)) continue;
    if (/(gst|vat|tax)/.test(lower) || (/%/.test(label) && amount > 0 && !/(service|tip|discount|off)/.test(lower))) {
      extras.tax += Math.abs(amount); // "CGST@2.5 2.5%", or OCR's "CEST@2.5 2.5%"
      continue;
    }
    if (/(service|tip|gratuity)/.test(lower)) { extras.tip += Math.abs(amount); continue; }
    if (/(discount|offer|coupon|promo|savings|off\b)/.test(lower) || amount < 0) { extras.discount += Math.abs(amount); continue; }
    if (decimalStyle && !decimal) continue;
    if ((label.match(/[a-z]/gi) || []).length < 3) continue; // an item needs a real name
    if (amount < 50) continue; // free items ("house drink - included") and sizes like "0,25 l" aren't prices

    let item;
    let m;
    if (fixedQty) {
      item = { name: label, qty: fixedQty, price: Math.round(amount / fixedQty) };
    } else if ((m = label.match(/^(.*?)\s*(\d+)\s*[x×*@]\s*$/i)) && m[1]) {
      // "Name 2 x 180" → qty 2, unit price 180
      item = { name: m[1], qty: +m[2], price: amount };
    } else {
      // Column-style bills: "Name  Qty  Rate  Amount" → peel up to 2 more numbers off the end of the label.
      const words = label.split(' ');
      const cols = [];
      while (words.length > 1 && cols.length < 2) {
        const last = words[words.length - 1];
        if (/^\d[\d,]*([.,]\d{1,2})?$/.test(last)) cols.unshift(words.pop());
        else if (cols.length && /^[|lI]$/.test(last)) { words.pop(); cols.unshift('1'); } // OCR often reads a qty of 1 as "|" or "l"
        else break;
      }
      // A lone whole number that can't be a quantity is part of the name ("Pepsi 500 60").
      if (cols.length === 1 && !isQty(cols[0]) && !/[.,]/.test(cols[0])) words.push(cols.pop());

      if (cols.length) {
        const qtyTok = cols.find(isQty);
        const rateTok = cols.find((t) => t !== qtyTok) || null;
        let qty = qtyTok ? +qtyTok : 1;
        let rate = rateTok ? toPaise(rateTok) : null;
        if (rate && !qtyTok) {
          // OCR glued the qty onto the rate ("2 194.00" → "2194.00"): split it if qty × rate = amount.
          const whole = rateTok.split(/[.,]/)[0];
          for (let k = 1; k <= 2 && whole.length - k >= 2; k++) {
            const q = +whole.slice(0, k);
            const r = toPaise(rateTok.slice(k));
            if (q > 0 && q * r === amount) { qty = q; rate = r; break; }
          }
          if (qty === 1 && amount % rate === 0 && amount / rate > 1 && amount / rate <= 20) qty = amount / rate;
        }
        if (words.length > 1 && /^\d$/.test(words[0])) words.shift(); // a stray digit before the name on column bills
        // With a rate column, `amount` is the line total; keep both and reconcile below.
        item = { name: words.join(' '), qty, price: rate ?? Math.round(amount / qty), lineAmount: rate ? amount : null };
      } else if ((m = label.match(/^(\d+)\s*[x×*]?\s+(.+)$/i)) && +m[1] > 0 && +m[1] < 50) {
        // "2 x Name 360" or "2 Name 360" → qty 2, line total 360
        item = { name: m[2], qty: +m[1], price: Math.round(amount / +m[1]) };
      } else {
        item = { name: label, qty: 1, price: amount };
      }
    }
    items.push(item);
    lastItem = item;
  }

  reconcileColumns(items, subtotal || (total ? total - extras.tax - extras.tip + extras.discount : 0));

  for (const it of items) {
    delete it.lineAmount;
    it.name = cleanName(it.name);
    it.name = it.name.charAt(0).toUpperCase() + it.name.slice(1);
  }
  return { items, ...extras, subtotal, total };
}

// Bills with both a Rate and an Amount column: when qty × rate ≠ amount, one of them was misread
// (or the amount includes tax). Pick, for each such row, the value that makes the items add up to
// the bill's own subtotal. With nothing to check against, trust the rate.
function reconcileColumns(items, target) {
  const unsure = items.filter((it) => it.lineAmount && it.lineAmount !== it.price * it.qty);
  if (!unsure.length || !target) return;
  const sure = items.filter((it) => !unsure.includes(it)).reduce((a, it) => a + it.price * it.qty, 0);
  const n = Math.min(unsure.length, 14);
  let best = 0;
  let bestDiff = Infinity;
  for (let mask = 0; mask < 1 << n; mask++) {
    let sum = sure;
    unsure.forEach((it, i) => { sum += i < n && mask & (1 << i) ? it.lineAmount : it.price * it.qty; });
    const diff = Math.abs(sum - target);
    if (diff < bestDiff) { best = mask; bestDiff = diff; }
  }
  unsure.forEach((it, i) => { if (i < n && best & (1 << i)) it.price = Math.round(it.lineAmount / it.qty); });
}

// The real text on a line, without noise OCR picked up from the table or wallet next to the bill.
// OCR keeps a wide gap between the two ("Masala Dosa          ES REE"), so keep the part with lowercase letters.
function mainText(rawLine) {
  const parts = rawLine.split(/\s{3,}/).map((p) => p.trim()).filter(Boolean);
  return parts.find((p) => /[a-z]{2}/.test(p)) || parts[0] || '';
}

// Tidy OCR noise in a dish name: stray column bars, junk at the start, leftover punctuation.
function cleanName(name) {
  return name.replace(/[|¦_~`]+/g, ' ').replace(/[{[]/g, '(').replace(/[}\]]/g, ')').replace(/\s+/g, ' ')
    .replace(/^([^a-z0-9(]+|[a-z]{1,2}\s(?=[a-z]{3})|[lI1!]{2,}\s)+/i, '') // "Tt din beefeater", ") Czech platter", "lll Chaat"
    .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')')
    .replace(/\b0(?=[A-Z])|(?<=[A-Z])0\b/g, 'O') // "The 0G Cold Coffee" → "The OG Cold Coffee"
    .replace(/^[\s.,:;\-]+|[\s.,:;\-]+$/g, '')
    .trim();
}

module.exports = { allocate, computeSplit, parseReceipt };
