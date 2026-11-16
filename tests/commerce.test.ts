import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from '../src/core/db.js';
import { calculateQuote, salesSummary, thaiDate } from '../src/modules/commerce-domain.js';
import { expireUnpaidOrders } from '../src/modules/commerce-lifecycle.js';
import { createTestApp, createTestDatabase, registerUser, adminUser } from './helpers.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
async function fixture() {
  const t = await createTestApp();
  t.config.allowDevPayments = true;
  const buyer = await registerUser(t.app),
    other = await registerUser(t.app),
    seller = await registerUser(t.app),
    seller2 = await registerUser(t.app),
    admin = await adminUser(t.app, t.db);
  await t.db.query("UPDATE users SET role='seller' WHERE id=ANY($1::uuid[])", [
    [seller.user.id, seller2.user.id],
  ]);
  const category = randomUUID(),
    s1 = randomUUID(),
    s2 = randomUUID(),
    p1 = randomUUID(),
    p2 = randomUUID();
  await t.db.query('INSERT INTO categories(id,name) VALUES($1,$2)', [
    category,
    'Wellness ' + category,
  ]);
  for (const [id, owner, name] of [
    [s1, seller.user.id, 'Bloom'],
    [s2, seller2.user.id, 'Rose'],
  ])
    await t.db.query(
      "INSERT INTO shops(id,owner_id,name,email,description,status,shipping_fee_cents,free_shipping_at_cents) VALUES($1,$2,$3,'store@example.test','Test store','approved',4000,99900)",
      [id, owner, name],
    );
  for (const [id, shop, name, price] of [
    [p1, s1, 'Vitamin', 39000],
    [p2, s2, 'Serum', 69000],
  ])
    await t.db.query(
      'INSERT INTO products(id,shop_id,category_id,name,price_cents,stock,image_index) VALUES($1,$2,$3,$4,$5,10,0)',
      [id, shop, category, name, price],
    );
  const address = await t.app.inject({
    method: 'POST',
    url: '/api/v1/me/addresses',
    headers: auth(buyer.token),
    payload: {
      label: 'Home',
      name: 'Buyer',
      phone: '0800000000',
      address: 'Test address Bangkok',
      isDefault: true,
    },
  });
  assert.equal(address.statusCode, 201, address.body);
  const addressId = address.json().data.id;
  async function cart(productId: string, quantity = 1, token = buyer.token) {
    const r = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/me/cart/' + productId,
      headers: auth(token),
      payload: { quantity },
    });
    assert.equal(r.statusCode, 200, r.body);
  }
  async function checkout(
    payload: Record<string, unknown> = {},
    key = randomUUID(),
    token = buyer.token,
  ) {
    return t.app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      headers: { ...auth(token), 'idempotency-key': key },
      payload: { addressId, paymentMethod: 'development', ...payload },
    });
  }
  async function proof(owner = buyer.user.id) {
    const id = randomUUID();
    await t.db.query(
      "INSERT INTO uploads(id,owner_id,kind,storage_key,mime,size_bytes,sha256) VALUES($1,$2,'proof',$3,'image/png',74,$4)",
      [id, owner, id + '.png', 'a'.repeat(64)],
    );
    return id;
  }
  return {
    ...t,
    buyer,
    other,
    seller,
    seller2,
    admin,
    category,
    s1,
    s2,
    p1,
    p2,
    addressId,
    cart,
    checkout,
    proof,
  };
}

test('integer-satang quote preserves per-shop discounts, caps and shipping', () => {
  const products = [
    {
      id: 'p1',
      shop_id: 's1',
      name: 'One',
      price_cents: 39000,
      quantity: 1,
      image_id: null,
      image_index: 0,
      shipping_fee_cents: 4000,
      free_shipping_at_cents: 99900,
    },
    {
      id: 'p2',
      shop_id: 's2',
      name: 'Two',
      price_cents: 69000,
      quantity: 1,
      image_id: null,
      image_index: 1,
      shipping_fee_cents: 4000,
      free_shipping_at_cents: 99900,
    },
  ];
  const coupon = {
    id: 'c1',
    code: 'BLOOM10',
    shop_id: null,
    active: true,
    archived_at: null,
    starts_at: null,
    ends_at: null,
    percent_basis_points: 1000,
    min_spend_cents: 0,
    max_discount_cents: null,
    usage_limit: null,
    used_count: 0,
  };
  const q = calculateQuote(products, coupon);
  assert.equal(q.totalCents, 105200);
  assert.deepEqual(
    q.groups.map((g) => g.totalCents),
    [39100, 66100],
  );
  const scoped = calculateQuote(products, { ...coupon, shop_id: 's1', max_discount_cents: 1000 });
  assert.equal(scoped.discountCents, 1000);
  assert.equal(scoped.groups[1].discountCents, 0);
  assert.throws(
    () => calculateQuote(products, { ...coupon, min_spend_cents: 100000 }),
    /conditions/,
  );
  assert.throws(
    () => calculateQuote(products, { ...coupon, usage_limit: 1, used_count: 1 }),
    /available/,
  );
  assert.equal(thaiDate(new Date('2026-11-13T17:00:00Z')), '2026-11-14');
  const dateCoupon = { ...coupon, starts_at: '2026-11-14', ends_at: '2026-11-14' };
  assert.equal(
    calculateQuote(products, dateCoupon, new Date('2026-11-14T16:59:59Z')).discountCents,
    10800,
  );
  assert.throws(
    () => calculateQuote(products, dateCoupon, new Date('2026-11-14T17:00:00Z')),
    /available/,
  );
});

test('sales aggregates distinguish collected sales, pending payments and refunds', () => {
  const row = {
    subtotal_cents: 10000,
    discount_cents: 1000,
    shipping_cents: 4000,
    total_cents: 13000,
  };
  const s = salesSummary([
    { ...row, status: 'delivered', payment_status: 'paid' },
    { ...row, status: 'pending', payment_status: 'awaiting_review' },
    { ...row, status: 'cancelled', payment_status: 'refund_pending' },
    { ...row, status: 'cancelled', payment_status: 'refunded' },
  ]);
  assert.deepEqual(s, {
    orderCount: 4,
    paidOrders: 1,
    noChargeOrders: 0,
    netMerchandiseCents: 9000,
    discountCents: 1000,
    shippingCents: 4000,
    collectedCents: 13000,
    pendingPaymentCents: 13000,
    refundPendingCents: 13000,
    refundedCents: 13000,
  });
});

test('sales summaries reject amounts that cannot be represented as exact integer satang', () => {
  const row = {
    subtotal_cents: 99_999_999_999_999,
    discount_cents: 0,
    shipping_cents: 0,
    total_cents: 99_999_999_999_999,
  };
  const safe = salesSummary(
    Array.from({ length: 90 }, () => ({ ...row, status: 'paid', payment_status: 'paid' })),
  );
  assert.equal(safe.collectedCents, Number(90n * BigInt(row.total_cents)));
  for (const [status, payment_status] of [
    ['paid', 'paid'],
    ['pending', 'awaiting_review'],
    ['cancelled', 'refund_pending'],
    ['cancelled', 'refunded'],
  ])
    assert.throws(
      () => salesSummary(Array.from({ length: 101 }, () => ({ ...row, status, payment_status }))),
      { status: 422, code: 'REPORT_TOTAL_TOO_LARGE' },
    );
  assert.throws(
    () =>
      salesSummary(
        Array.from({ length: 101 }, () => ({
          ...row,
          discount_cents: row.subtotal_cents,
          total_cents: 0,
          status: 'paid',
          payment_status: 'paid',
          payment_method: 'no_charge',
        })),
      ),
    { status: 422, code: 'REPORT_TOTAL_TOO_LARGE' },
  );
});

test('large financial summaries fail explicitly while exact order CSV remains available', async () => {
  const t = await fixture();
  try {
    await t.cart(t.p1);
    const checkout = await t.checkout();
    assert.equal(checkout.statusCode, 201, checkout.body);
    const order = checkout.json().data.orders[0];
    await t.db.query(
      "INSERT INTO orders(number,checkout_id,buyer_id,shop_id,status,payment_status,payment_method,address_snapshot,subtotal_cents,shipping_cents,discount_cents,total_cents) SELECT 'LARGE-REPORT-'||n,$1,$2,$3,'paid','paid','transfer','{}'::jsonb,$4,0,0,$4 FROM generate_series(1,101) n",
      [order.checkoutId, t.buyer.user.id, t.s1, 99_999_999_999_999],
    );
    for (const [scope, token] of [
      ['admin', t.admin.token],
      ['seller', t.seller.token],
    ]) {
      const summary = await t.app.inject({
        url: '/api/v1/' + scope + '/reports/sales',
        headers: auth(token),
      });
      assert.equal(summary.statusCode, 422, summary.body);
      assert.equal(summary.json().error.code, 'REPORT_TOTAL_TOO_LARGE');
      const exported = await t.app.inject({
        url: '/api/v1/' + scope + '/reports/sales.csv',
        headers: auth(token),
      });
      assert.equal(exported.statusCode, 200, exported.body);
      assert.match(exported.headers['content-type'] ?? '', /text\/csv/);
      assert.equal(
        exported.body.split('\r\n').filter((line) => line.includes('LARGE-REPORT-')).length,
        101,
      );
      assert.match(exported.body, /"99999999999999"/);
    }
    const narrowed = await t.app.inject({
      url: '/api/v1/admin/reports/sales?q=' + order.number,
      headers: auth(t.admin.token),
    });
    assert.equal(narrowed.statusCode, 200, narrowed.body);
    assert.equal(narrowed.json().data.summary.collectedCents, order.totalCents);
  } finally {
    await t.close();
  }
});

test('proof history is paginated for the buyer and admin without exposing it to store sellers', async () => {
  const t = await fixture();
  try {
    await t.cart(t.p1);
    const original = await t.proof();
    const checkout = await t.checkout({ paymentMethod: 'transfer', proofUploadId: original });
    assert.equal(checkout.statusCode, 201, checkout.body);
    const id = checkout.json().data.orders[0].id;
    let response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + id + '/payment-review',
      headers: auth(t.admin.token),
      payload: { decision: 'reject', reason: 'PRIVATE_OLD_PROOF_REASON' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const corrected = await t.proof();
    response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + id + '/payment-proof',
      headers: auth(t.buyer.token),
      payload: { uploadId: corrected },
    });
    assert.equal(response.statusCode, 200, response.body);
    response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + id + '/payment-review',
      headers: auth(t.admin.token),
      payload: { decision: 'approve' },
    });
    assert.equal(response.statusCode, 200, response.body);
    // A seller account retains buyer access when purchasing from another store.
    await t.db.query("UPDATE users SET role='seller' WHERE id=$1", [t.buyer.user.id]);
    response = await t.app.inject({
      url: '/api/v1/orders/' + id + '/payment-proofs?limit=1&offset=0',
      headers: auth(t.buyer.token),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().page, { limit: 1, offset: 0, total: 2 });
    assert.equal(response.json().data[0].uploadId, corrected);
    assert.equal(response.json().data[0].status, 'approved');
    assert.equal(response.json().data[0].reviewerName, t.admin.user.name);
    assert.ok(response.json().data[0].reviewedAt);
    response = await t.app.inject({
      url: '/api/v1/orders/' + id + '/payment-proofs?limit=1&offset=1',
      headers: auth(t.buyer.token),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data[0].uploadId, original);
    assert.equal(response.json().data[0].status, 'rejected');
    assert.equal(response.json().data[0].reason, 'PRIVATE_OLD_PROOF_REASON');
    response = await t.app.inject({
      url: '/api/v1/orders/' + id + '/payment-proofs',
      headers: auth(t.admin.token),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.length, 2);
    assert.doesNotMatch(response.body, new RegExp(t.admin.user.email));
    for (const actor of [t.seller, t.seller2, t.other]) {
      response = await t.app.inject({
        url: '/api/v1/orders/' + id + '/payment-proofs',
        headers: auth(actor.token),
      });
      assert.equal(response.statusCode, 404, response.body);
      assert.doesNotMatch(response.body, /PRIVATE_OLD_PROOF_REASON/);
      assert.equal(response.body.includes(original), false);
      assert.equal(response.body.includes(corrected), false);
    }
    response = await t.app.inject({
      url: '/api/v1/orders/' + id + '/payment-proofs?limit=101',
      headers: auth(t.buyer.token),
    });
    assert.equal(response.statusCode, 400, response.body);
  } finally {
    await t.close();
  }
});

test('public reviews and wishlist saves share product visibility, including out-of-stock listings', async () => {
  const t = await fixture();
  try {
    await t.db.query('INSERT INTO reviews(product_id,user_id,rating,body) VALUES($1,$2,5,$3)', [
      t.p1,
      t.buyer.user.id,
      'VISIBLE_ONLY_WITH_PRODUCT_MARKER',
    ]);
    await t.db.query('UPDATE products SET stock=0 WHERE id=$1', [t.p1]);
    let response = await t.app.inject({ url: '/api/v1/products/' + t.p1 + '/reviews' });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.body, /VISIBLE_ONLY_WITH_PRODUCT_MARKER/);
    response = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/me/wishlist/' + t.p1,
      headers: auth(t.other.token),
    });
    assert.equal(response.statusCode, 200, response.body);
    for (const [hide, restore, id] of [
      [
        'UPDATE products SET active=false WHERE id=$1',
        'UPDATE products SET active=true WHERE id=$1',
        t.p1,
      ],
      [
        'UPDATE products SET archived_at=now() WHERE id=$1',
        'UPDATE products SET archived_at=NULL WHERE id=$1',
        t.p1,
      ],
      [
        'UPDATE categories SET active=false WHERE id=$1',
        'UPDATE categories SET active=true WHERE id=$1',
        t.category,
      ],
      [
        "UPDATE shops SET status='suspended' WHERE id=$1",
        "UPDATE shops SET status='approved' WHERE id=$1",
        t.s1,
      ],
      [
        'UPDATE users SET blocked=true WHERE id=$1',
        'UPDATE users SET blocked=false WHERE id=$1',
        t.seller.user.id,
      ],
    ]) {
      await t.db.query(hide, [id]);
      assert.equal((await t.app.inject({ url: '/api/v1/products/' + t.p1 })).statusCode, 404);
      response = await t.app.inject({ url: '/api/v1/products/' + t.p1 + '/reviews' });
      assert.equal(response.statusCode, 404, response.body);
      assert.doesNotMatch(response.body, /VISIBLE_ONLY_WITH_PRODUCT_MARKER/);
      response = await t.app.inject({
        url: '/api/v1/me/wishlist',
        headers: auth(t.other.token),
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().data.length, 0);
      response = await t.app.inject({
        method: 'DELETE',
        url: '/api/v1/me/wishlist/' + t.p1,
        headers: auth(t.other.token),
      });
      assert.equal(response.statusCode, 200, response.body);
      response = await t.app.inject({
        method: 'PUT',
        url: '/api/v1/me/wishlist/' + t.p1,
        headers: auth(t.other.token),
      });
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(
        (await t.db.one('SELECT count(*) AS total FROM wishlists WHERE user_id=$1', [
          t.other.user.id,
        ]))!.total,
        0,
      );
      response = await t.app.inject({ url: '/api/v1/me/reviews', headers: auth(t.buyer.token) });
      assert.equal(response.statusCode, 200, response.body);
      assert.match(response.body, /VISIBLE_ONLY_WITH_PRODUCT_MARKER/);
      await t.db.query(restore, [id]);
    }
  } finally {
    await t.close();
  }
});

test('reservation expiration honors shutdown between orders without interrupting a claimed transaction', async () => {
  const t = await fixture();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      await t.cart(t.p1);
      const checkout = await t.checkout({ paymentMethod: 'transfer' });
      assert.equal(checkout.statusCode, 201, checkout.body);
      ids.push(checkout.json().data.orders[0].id);
    }
    await t.db.query(
      "UPDATE orders SET payment_due_at=now()-interval '1 minute' WHERE id=ANY($1::uuid[])",
      [ids],
    );
    const alreadyStopped = new AbortController();
    alreadyStopped.abort();
    assert.deepEqual(await expireUnpaidOrders(t, 100, alreadyStopped.signal), {
      expired: 0,
      orderIds: [],
    });
    const controller = new AbortController();
    let transactions = 0;
    const worker: Parameters<typeof expireUnpaidOrders>[0] = {
      ...t,
      db: {
        ...t.db,
        transaction: async (fn) =>
          t.db.transaction(async (tx) => {
            const result = await fn(tx);
            transactions++;
            controller.abort();
            return result;
          }),
      },
    };
    const stopped = await expireUnpaidOrders(worker, 100, controller.signal);
    assert.equal(transactions, 1);
    assert.equal(stopped.expired, 1);
    assert.equal(stopped.orderIds.length, 1);
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [t.p1]))!.stock, 8);
    assert.equal(
      (await t.db.one(
        "SELECT count(*) AS total FROM orders WHERE id=ANY($1::uuid[]) AND status='pending'",
        [ids],
      ))!.total,
      2,
    );
    const resumed = await expireUnpaidOrders(t);
    assert.equal(resumed.expired, 2);
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [t.p1]))!.stock, 10);
    assert.equal(
      (await t.db.one(
        "SELECT count(*) AS total FROM stock_movements WHERE order_id=ANY($1::uuid[]) AND reason='reservation_expired'",
        [ids],
      ))!.total,
      3,
    );
  } finally {
    await t.close();
  }
});

test('atomic multi-store checkout is server-priced, replay-safe and preserves snapshots', async () => {
  const t = await fixture();
  try {
    const promo = randomUUID();
    await t.db.query(
      "INSERT INTO promotions(id,code,title,percent_basis_points,usage_limit) VALUES($1,'BLOOM10','Ten percent',1000,1)",
      [promo],
    );
    await t.cart(t.p1);
    await t.cart(t.p2);
    const quote = await t.app.inject({
      method: 'POST',
      url: '/api/v1/checkout/quote',
      headers: auth(t.buyer.token),
      payload: { couponCode: 'BLOOM10' },
    });
    assert.equal(quote.statusCode, 200, quote.body);
    assert.equal(quote.json().data.totalCents, 105200);
    const bad = await t.checkout({ couponCode: 'BLOOM10', totalCents: 1 });
    assert.equal(bad.statusCode, 400, bad.body);
    const key = randomUUID();
    const sameKeyRequests = await Promise.all([
      t.checkout({ couponCode: 'BLOOM10' }, key),
      t.checkout({ couponCode: 'BLOOM10' }, key),
    ]);
    assert.deepEqual(sameKeyRequests.map((r) => r.statusCode).sort(), [200, 201]);
    const first = sameKeyRequests.find((r) => r.statusCode === 201)!;
    const result = first.json().data;
    assert.equal(result.orders.length, 2);
    assert.equal(result.totalCents, 105200);
    assert.equal(
      sameKeyRequests[0].json().data.checkoutId,
      sameKeyRequests[1].json().data.checkoutId,
    );
    assert.equal(
      (await t.db.one('SELECT used_count FROM promotions WHERE id=$1', [promo]))!.used_count,
      1,
    );
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [t.p1]))!.stock, 9);
    const replay = await t.checkout({ couponCode: 'BLOOM10' }, key);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().data.replayed, true);
    assert.equal(replay.json().data.checkoutId, result.checkoutId);
    t.config.allowDevPayments = false;
    const disabledReplay = await t.checkout({ couponCode: 'BLOOM10' }, key);
    assert.equal(disabledReplay.statusCode, 200, disabledReplay.body);
    assert.equal(disabledReplay.json().data.checkoutId, result.checkoutId);
    t.config.allowDevPayments = true;
    assert.deepEqual(replay.json().data.groups, result.groups);
    for (const field of [
      'subtotalCents',
      'shippingCents',
      'discountCents',
      'totalCents',
      'couponCode',
    ])
      assert.equal(replay.json().data[field], result[field]);
    assert.equal((await t.db.one('SELECT count(*) AS n FROM orders'))!.n, 2);
    const conflict = await t.checkout({ couponCode: 'OTHER' }, key);
    assert.equal(conflict.statusCode, 409, conflict.body);
    await t.db.query("UPDATE products SET name='Changed',price_cents=50000 WHERE id=$1", [t.p1]);
    await t.db.query("UPDATE addresses SET address='Changed address' WHERE id=$1", [t.addressId]);
    const detail = await t.app.inject({
      method: 'GET',
      url: '/api/v1/orders/' + result.orders.find((o: any) => o.shopId === t.s1).id,
      headers: auth(t.buyer.token),
    });
    assert.equal(detail.json().data.items[0].name, 'Vitamin');
    assert.equal(detail.json().data.items[0].unitPriceCents, 39000);
    assert.equal(detail.json().data.addressSnapshot.address, 'Test address Bangkok');
    const fulfilledOrder = result.orders.find((o: any) => o.shopId === t.s1).id;
    const prepare = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + fulfilledOrder + '/prepare',
      headers: auth(t.seller.token),
    });
    assert.equal(prepare.statusCode, 200, prepare.body);
    const afterChanges = await t.checkout({ couponCode: 'BLOOM10' }, key);
    assert.equal(afterChanges.statusCode, 200, afterChanges.body);
    assert.deepEqual(afterChanges.json().data.groups, result.groups);
    assert.equal(afterChanges.json().data.totalCents, result.totalCents);
    assert.equal(
      afterChanges.json().data.orders.find((o: any) => o.id === fulfilledOrder).status,
      'preparing',
    );
    await t.db.query(
      "INSERT INTO settings(key,value) VALUES('site',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [JSON.stringify({ siteTitle: 'Custom Bloom', siteNotice: 'Updated notice' })],
    );
    const receipt = await t.app.inject({
      method: 'GET',
      url: '/api/v1/orders/' + result.orders[0].id + '/receipt',
      headers: auth(t.buyer.token),
    });
    assert.equal(receipt.statusCode, 200, receipt.body);
    assert.equal(receipt.json().data.settings.siteTitle, 'Custom Bloom');
    const foreign = await t.app.inject({
      method: 'GET',
      url: '/api/v1/orders/' + result.orders[0].id,
      headers: auth(t.other.token),
    });
    assert.equal(foreign.statusCode, 404, foreign.body);
    const strangerSeller = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + result.orders.find((o: any) => o.shopId === t.s1).id + '/prepare',
      headers: auth(t.seller2.token),
    });
    assert.equal(strangerSeller.statusCode, 404, strangerSeller.body);
  } finally {
    await t.close();
  }
});

test('proof correction, fulfilment, review and moderation enforce transitions and actors', async () => {
  const t = await fixture();
  try {
    await t.cart(t.p1);
    const upload = await t.proof();
    const created = await t.checkout({ paymentMethod: 'transfer', proofUploadId: upload });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().data.orders[0].id;
    let r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + id + '/prepare',
      headers: auth(t.seller.token),
    });
    assert.equal(r.statusCode, 409, r.body);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + id + '/payment-review',
      headers: auth(t.seller.token),
      payload: { decision: 'approve' },
    });
    assert.equal(r.statusCode, 403, r.body);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + id + '/payment-review',
      headers: auth(t.admin.token),
      payload: { decision: 'reject', reason: 'PRIVATE_REVIEW_REASON_MARKER' },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().data.paymentStatus, 'rejected');
    assert.match(r.body, /PRIVATE_REVIEW_REASON_MARKER/);
    const sellerDetail = await t.app.inject({
      method: 'GET',
      url: '/api/v1/orders/' + id,
      headers: auth(t.seller.token),
    });
    assert.equal(sellerDetail.statusCode, 200, sellerDetail.body);
    assert.doesNotMatch(sellerDetail.body, /PRIVATE_REVIEW_REASON_MARKER/);
    assert.equal(sellerDetail.json().data.proofUploadId, undefined);
    const buyerDetail = await t.app.inject({
      method: 'GET',
      url: '/api/v1/orders/' + id,
      headers: auth(t.buyer.token),
    });
    assert.match(buyerDetail.body, /PRIVATE_REVIEW_REASON_MARKER/);
    const foreignProof = await t.proof(t.other.user.id);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + id + '/payment-proof',
      headers: auth(t.buyer.token),
      payload: { uploadId: foreignProof },
    });
    assert.equal(r.statusCode, 422, r.body);
    const corrected = await t.proof();
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + id + '/payment-proof',
      headers: auth(t.buyer.token),
      payload: { uploadId: corrected },
    });
    assert.equal(r.statusCode, 200, r.body);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + id + '/payment-review',
      headers: auth(t.admin.token),
      payload: { decision: 'approve' },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().data.status, 'paid');
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + id + '/prepare',
      headers: auth(t.seller.token),
    });
    assert.equal(r.statusCode, 200, r.body);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + id + '/ship',
      headers: auth(t.seller.token),
      payload: { carrier: 'Test carrier', tracking: 'TEST-001' },
    });
    assert.equal(r.statusCode, 200, r.body);
    const shippedAt = r.json().data.shippedAt;
    const correction = {
      carrier: 'Test carrier',
      tracking: 'TEST-001-CORRECTED',
      reason: 'Correcting a mistyped tracking number',
    };
    r = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/orders/' + id + '/shipment',
      headers: auth(t.seller2.token),
      payload: correction,
    });
    assert.equal(r.statusCode, 404, r.body);
    r = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/orders/' + id + '/shipment',
      headers: auth(t.buyer.token),
      payload: correction,
    });
    assert.equal(r.statusCode, 403, r.body);
    r = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/orders/' + id + '/shipment',
      headers: auth(t.seller.token),
      payload: correction,
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().data.tracking, correction.tracking);
    assert.equal(r.json().data.shippedAt, shippedAt);
    r = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/orders/' + id + '/shipment',
      headers: auth(t.seller.token),
      payload: correction,
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(
      (await t.db.one(
        "SELECT count(*) AS n FROM order_events WHERE order_id=$1 AND detail->>'code'='order.tracking_updated'",
        [id],
      ))!.n,
      1,
    );
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/products/' + t.p1 + '/reviews',
      headers: auth(t.buyer.token),
      payload: { rating: 5, text: 'Great' },
    });
    assert.equal(r.statusCode, 403, r.body);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + id + '/receive',
      headers: auth(t.seller.token),
    });
    assert.equal(r.statusCode, 403, r.body);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + id + '/receive',
      headers: auth(t.buyer.token),
    });
    assert.equal(r.statusCode, 200, r.body);
    r = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/orders/' + id + '/shipment',
      headers: auth(t.seller.token),
      payload: { ...correction, tracking: 'AFTER-DELIVERY' },
    });
    assert.equal(r.statusCode, 409, r.body);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/products/' + t.p1 + '/reviews',
      headers: auth(t.buyer.token),
      payload: { rating: 5, text: 'Great' },
    });
    assert.equal(r.statusCode, 201, r.body);
    const reviewId = r.json().data.id;
    const duplicate = await t.app.inject({
      method: 'POST',
      url: '/api/v1/products/' + t.p1 + '/reviews',
      headers: auth(t.buyer.token),
      payload: { rating: 5, text: 'Again' },
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    r = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/reviews/' + reviewId + '/reply',
      headers: auth(t.seller2.token),
      payload: { text: 'Not mine' },
    });
    assert.equal(r.statusCode, 404, r.body);
    r = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/reviews/' + reviewId + '/reply',
      headers: auth(t.seller.token),
      payload: { text: 'Thank you' },
    });
    assert.equal(r.statusCode, 200, r.body);
    r = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/reviews/' + reviewId + '/moderation',
      headers: auth(t.admin.token),
      payload: { hidden: true, reason: 'Moderation test' },
    });
    assert.equal(r.statusCode, 200, r.body);
    r = await t.app.inject({ method: 'GET', url: '/api/v1/products/' + t.p1 + '/reviews' });
    assert.equal(r.json().data.length, 0);
    assert.equal(
      (await t.db.one('SELECT count(*) AS n FROM order_payment_proofs WHERE order_id=$1', [id]))!.n,
      2,
    );
    const history = await t.db.query('SELECT label,detail FROM order_events WHERE order_id=$1', [
      id,
    ]);
    assert(history.some((x) => x.detail.code === 'payment.rejected'));
    assert(history.some((x) => x.detail.code === 'order.delivered'));
    const adminNotice = await t.db.query(
      'SELECT title FROM notifications WHERE user_id=$1 AND order_id=$2',
      [t.admin.user.id, id],
    );
    assert.equal(adminNotice.length, 2);
  } finally {
    await t.close();
  }
});

test('cancellation restores stock once and paid cancellation requires a recorded refund', async () => {
  const t = await fixture();
  try {
    await t.cart(t.p1, 2);
    let r = await t.checkout({ paymentMethod: 'transfer' });
    assert.equal(r.statusCode, 201, r.body);
    const id = r.json().data.orders[0].id;
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + id + '/cancel',
      headers: auth(t.buyer.token),
      payload: { reason: 'Changed mind' },
    });
    assert.equal(r.statusCode, 200, r.body);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + id + '/cancel',
      headers: auth(t.buyer.token),
      payload: { reason: 'Retry request' },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [t.p1]))!.stock, 10);
    assert.equal(
      (await t.db.one(
        "SELECT count(*) AS n FROM stock_movements WHERE order_id=$1 AND reason='cancelled'",
        [id],
      ))!.n,
      1,
    );
    await t.cart(t.p1);
    r = await t.checkout();
    assert.equal(r.statusCode, 201, r.body);
    const paidId = r.json().data.orders[0].id;
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + paidId + '/cancel',
      headers: auth(t.buyer.token),
      payload: { reason: 'Buyer paid cancellation' },
    });
    assert.equal(r.statusCode, 409, r.body);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + paidId + '/cancel',
      headers: auth(t.admin.token),
      payload: { reason: 'Admin approved cancellation' },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().data.paymentStatus, 'refund_pending');
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + paidId + '/refund',
      headers: auth(t.admin.token),
      payload: { reference: 'BANK-REF-001', note: 'Bank transfer completed manually' },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().data.paymentStatus, 'refunded');
    const sellerRefund = await t.app.inject({
      method: 'GET',
      url: '/api/v1/orders/' + paidId,
      headers: auth(t.seller.token),
    });
    assert.doesNotMatch(sellerRefund.body, /BANK-REF-001|Bank transfer completed manually/);
    const sellerCsv = await t.app.inject({
      method: 'GET',
      url: '/api/v1/seller/reports/sales.csv',
      headers: auth(t.seller.token),
    });
    assert.doesNotMatch(sellerCsv.body, /BANK-REF-001/);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + paidId + '/refund',
      headers: auth(t.admin.token),
      payload: { reference: 'BANK-REF-002', note: 'Duplicate with new reference' },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [t.p1]))!.stock, 10);
  } finally {
    await t.close();
  }
});

test('concurrent requests cannot oversell or exceed coupon usage, and failures leave cart intact', async () => {
  const t = await fixture();
  try {
    await t.db.query('UPDATE products SET stock=1 WHERE id=$1', [t.p1]);
    await t.cart(t.p1);
    await t.cart(t.p1, 1, t.other.token);
    const a = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/addresses',
      headers: auth(t.other.token),
      payload: {
        label: 'Home',
        name: 'Other',
        phone: '0800000001',
        address: 'Other address Thailand',
      },
    });
    assert.equal(a.statusCode, 201, a.body);
    const results = await Promise.all([
      t.checkout(),
      t.checkout({ addressId: a.json().data.id }, randomUUID(), t.other.token),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [t.p1]))!.stock, 0);
    assert.equal((await t.db.one('SELECT count(*) AS n FROM orders'))!.n, 1);
    assert.equal((await t.db.one('SELECT count(*) AS n FROM cart_items'))!.n, 1);
    await t.db.query('DELETE FROM cart_items');
    await t.cart(t.p2);
    await t.cart(t.p2, 1, t.other.token);
    await t.db.query(
      "INSERT INTO promotions(code,title,percent_basis_points,usage_limit) VALUES('ONCE','One use',1000,1)",
    );
    const couponResults = await Promise.all([
      t.checkout({ couponCode: 'ONCE' }),
      t.checkout({ couponCode: 'ONCE', addressId: a.json().data.id }, randomUUID(), t.other.token),
    ]);
    assert.deepEqual(couponResults.map((r) => r.statusCode).sort(), [201, 422]);
    assert.equal(
      (await t.db.one("SELECT used_count FROM promotions WHERE code='ONCE'"))!.used_count,
      1,
    );
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [t.p2]))!.stock, 9);
  } finally {
    await t.close();
  }
});

test('report filters use inclusive Bangkok dates, export matches scope and development payments can be disabled', async () => {
  const t = await fixture();
  try {
    await t.cart(t.p1);
    t.config.allowDevPayments = false;
    let r = await t.checkout();
    assert.equal(r.statusCode, 422, r.body);
    t.config.allowDevPayments = true;
    r = await t.checkout();
    assert.equal(r.statusCode, 201, r.body);
    const id = r.json().data.orders[0].id;
    await t.db.query("UPDATE orders SET created_at='2026-11-13T17:00:00Z' WHERE id=$1", [id]);
    r = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/reports/sales?dateFrom=2026-11-14&dateTo=2026-11-14',
      headers: auth(t.admin.token),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().data.summary.collectedCents, 43000);
    assert.equal(r.json().data.summary.netMerchandiseCents, 39000);
    r = await t.app.inject({
      method: 'GET',
      url: '/api/v1/seller/reports/sales',
      headers: auth(t.seller2.token),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().data.summary.orderCount, 0);
    r = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/reports/sales.csv?dateFrom=2026-11-14&dateTo=2026-11-14',
      headers: auth(t.admin.token),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.match(r.headers['content-type']!, /text\/csv/);
    assert.match(r.body, /43000/);
    assert.equal(r.body.trim().split('\r\n').length, 2);
    r = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/reports/sales?dateFrom=2026-11-15&dateTo=2026-11-14',
      headers: auth(t.admin.token),
    });
    assert.equal(r.statusCode, 400, r.body);
    r = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/reports/sales?dateFrom=2026-02-30',
      headers: auth(t.admin.token),
    });
    assert.equal(r.statusCode, 400, r.body);
    r = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/reports/sales?dateFrom=0000-01-01',
      headers: auth(t.admin.token),
    });
    assert.equal(r.statusCode, 400, r.body);
  } finally {
    await t.close();
  }
});

test('promotion ownership, address/cart isolation, and suspension availability are enforced', async () => {
  const t = await fixture();
  try {
    let r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/seller/promotions',
      headers: auth(t.seller.token),
      payload: { code: 'OWN10', title: 'Own shop', percent: 10, shopId: t.s2 },
    });
    assert.equal(r.statusCode, 403, r.body);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/seller/promotions',
      headers: auth(t.seller.token),
      payload: { code: 'OWN10', title: 'Own shop', percent: 10 },
    });
    assert.equal(r.statusCode, 201, r.body);
    const promotionId = r.json().data.id;
    for (const percent of [0.29, 10.01]) {
      const decimal = await t.app.inject({
        method: 'POST',
        url: '/api/v1/seller/promotions',
        headers: auth(t.seller.token),
        payload: {
          code: 'decimal_' + Math.round(percent * 100),
          title: 'Decimal percent',
          percent,
        },
      });
      assert.equal(decimal.statusCode, 201, decimal.body);
      assert.equal(decimal.json().data.percent, percent);
      assert.equal(decimal.json().data.active, true);
      assert.match(decimal.json().data.code, /^DECIMAL_/);
    }
    const tooPrecise = await t.app.inject({
      method: 'POST',
      url: '/api/v1/seller/promotions',
      headers: auth(t.seller.token),
      payload: { code: 'DECIMAL_INVALID', title: 'Invalid precision', percent: 0.291 },
    });
    assert.equal(tooPrecise.statusCode, 400, tooPrecise.body);
    r = await t.app.inject({
      method: 'DELETE',
      url: '/api/v1/seller/promotions/' + promotionId,
      headers: auth(t.seller2.token),
    });
    assert.equal(r.statusCode, 404, r.body);
    r = await t.app.inject({
      method: 'DELETE',
      url: '/api/v1/me/addresses/' + t.addressId,
      headers: auth(t.other.token),
    });
    assert.equal(r.statusCode, 404, r.body);
    await t.cart(t.p1);
    r = await t.app.inject({ method: 'GET', url: '/api/v1/me/cart', headers: auth(t.other.token) });
    assert.equal(r.json().data.length, 0);
    await t.app.inject({
      method: 'PUT',
      url: '/api/v1/me/wishlist/' + t.p1,
      headers: auth(t.buyer.token),
    });
    await t.db.query("UPDATE shops SET status='suspended' WHERE id=$1", [t.s1]);
    r = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/wishlist',
      headers: auth(t.buyer.token),
    });
    assert.equal(r.json().data.length, 0);
    r = await t.checkout();
    assert.equal(r.statusCode, 409, r.body);
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [t.p1]))!.stock, 10);
    r = await t.app.inject({ method: 'GET', url: '/api/v1/promotions' });
    assert.equal(r.json().data.length, 0);
  } finally {
    await t.close();
  }
});

test('expired transfer reservations release stock once across workers, while reviewed and paid orders remain reserved', async () => {
  const t = await fixture();
  try {
    t.config.paymentReservationMinutes = 5;
    await t.db.query(
      "INSERT INTO promotions(code,title,percent_basis_points) VALUES('EXPIRE10','Checkout usage retained',1000)",
    );
    await t.cart(t.p1, 2);
    let r = await t.checkout({ paymentMethod: 'transfer', couponCode: 'EXPIRE10' });
    assert.equal(r.statusCode, 201, r.body);
    const unpaid = r.json().data.orders[0];
    assert(Date.parse(unpaid.paymentDueAt) > Date.now() + 4 * 60000);
    await t.cart(t.p1);
    r = await t.checkout({ paymentMethod: 'transfer', proofUploadId: await t.proof() });
    assert.equal(r.statusCode, 201, r.body);
    const reviewing = r.json().data.orders[0];
    assert.equal(reviewing.paymentDueAt, null);
    await t.cart(t.p1);
    r = await t.checkout();
    assert.equal(r.statusCode, 201, r.body);
    const paid = r.json().data.orders[0];
    assert.equal(paid.paymentDueAt, null);
    await t.cart(t.p1);
    r = await t.checkout({ paymentMethod: 'transfer', proofUploadId: await t.proof() });
    assert.equal(r.statusCode, 201, r.body);
    const rejected = r.json().data.orders[0];
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + rejected.id + '/payment-review',
      headers: auth(t.admin.token),
      payload: { decision: 'reject', reason: 'Please correct this proof' },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert(Date.parse(r.json().data.paymentDueAt) > Date.now() + 4 * 60000);
    await t.db.query(
      "UPDATE orders SET payment_due_at=now()-interval '1 second' WHERE id=ANY($1::uuid[])",
      [[unpaid.id, rejected.id]],
    );
    await t.db.query(
      "UPDATE orders SET created_at=now()-interval '3 days' WHERE id=ANY($1::uuid[])",
      [[reviewing.id, paid.id]],
    );
    const runs = await Promise.all([expireUnpaidOrders(t), expireUnpaidOrders(t)]);
    assert.equal(
      runs.reduce((n, x) => n + x.expired, 0),
      2,
    );
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [t.p1]))!.stock, 8);
    assert.equal(
      (await t.db.one(
        "SELECT count(*) AS n FROM stock_movements WHERE reason='reservation_expired'",
      ))!.n,
      2,
    );
    assert.equal(
      (await t.db.one(
        "SELECT count(*) AS n FROM audit_events WHERE action='order.expired' AND actor_id IS NULL",
      ))!.n,
      2,
    );
    assert.equal(
      (await t.db.one('SELECT status FROM orders WHERE id=$1', [reviewing.id]))!.status,
      'pending',
    );
    assert.equal(
      (await t.db.one('SELECT payment_status FROM orders WHERE id=$1', [reviewing.id]))!
        .payment_status,
      'awaiting_review',
    );
    assert.equal(
      (await t.db.one('SELECT status FROM orders WHERE id=$1', [paid.id]))!.status,
      'paid',
    );
    assert.equal(
      (await t.db.one("SELECT used_count FROM promotions WHERE code='EXPIRE10'"))!.used_count,
      1,
    );
    assert.equal((await expireUnpaidOrders(t)).expired, 0);
  } finally {
    await t.close();
  }
});

test('late proof rejection commits expiry before409 and racing proof/maintenance never restores inventory twice', async () => {
  const t = await fixture();
  try {
    await t.cart(t.p1);
    let r = await t.checkout({ paymentMethod: 'transfer' });
    assert.equal(r.statusCode, 201, r.body);
    const first = r.json().data.orders[0].id;
    const proof = await t.proof();
    await t.db.query("UPDATE orders SET payment_due_at=now()-interval '1 second' WHERE id=$1", [
      first,
    ]);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + first + '/payment-proof',
      headers: auth(t.buyer.token),
      payload: { uploadId: proof },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error.code, 'PAYMENT_RESERVATION_EXPIRED');
    assert.equal(
      (await t.db.one('SELECT status FROM orders WHERE id=$1', [first]))!.status,
      'cancelled',
    );
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [t.p1]))!.stock, 10);
    await t.cart(t.p1);
    r = await t.checkout({ paymentMethod: 'transfer' });
    assert.equal(r.statusCode, 201, r.body);
    const second = r.json().data.orders[0].id;
    await t.db.query("UPDATE orders SET payment_due_at=now()-interval '1 second' WHERE id=$1", [
      second,
    ]);
    const [submission] = await Promise.all([
      t.app.inject({
        method: 'POST',
        url: '/api/v1/orders/' + second + '/payment-proof',
        headers: auth(t.buyer.token),
        payload: { uploadId: proof },
      }),
      expireUnpaidOrders(t),
    ]);
    assert.equal(submission.statusCode, 409, submission.body);
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [t.p1]))!.stock, 10);
    assert.equal(
      (await t.db.one(
        "SELECT count(*) AS n FROM stock_movements WHERE order_id=$1 AND reason='reservation_expired'",
        [second],
      ))!.n,
      1,
    );
    assert.equal(
      (await t.db.one('SELECT count(*) AS n FROM order_payment_proofs WHERE order_id=$1', [
        second,
      ]))!.n,
      0,
    );
    await t.cart(t.p1);
    r = await t.checkout({ paymentMethod: 'transfer' });
    assert.equal(r.statusCode, 201, r.body);
    const future = r.json().data.orders[0].id;
    const [accepted] = await Promise.all([
      t.app.inject({
        method: 'POST',
        url: '/api/v1/orders/' + future + '/payment-proof',
        headers: auth(t.buyer.token),
        payload: { uploadId: proof },
      }),
      expireUnpaidOrders(t),
    ]);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().data.paymentDueAt, null);
    assert.equal(accepted.json().data.paymentStatus, 'awaiting_review');
  } finally {
    await t.close();
  }
});

test('zero-balance groups need no payment proof and cancellation creates no fictitious refund', async () => {
  const t = await fixture();
  try {
    t.config.allowDevPayments = false;
    await t.db.query('UPDATE shops SET free_shipping_at_cents=0 WHERE id=$1', [t.s1]);
    await t.db.query(
      "INSERT INTO promotions(code,title,percent_basis_points) VALUES('FREE100','Full discount',10000)",
    );
    await t.cart(t.p1);
    await t.cart(t.p2);
    let r = await t.checkout({ paymentMethod: 'transfer', couponCode: 'FREE100' });
    assert.equal(r.statusCode, 201, r.body);
    const free = r.json().data.orders.find((o: any) => o.shopId === t.s1),
      transfer = r.json().data.orders.find((o: any) => o.shopId === t.s2);
    assert.equal(free.totalCents, 0);
    assert.equal(free.paymentMethod, 'no_charge');
    assert.equal(free.paymentStatus, 'paid');
    assert.equal(free.status, 'paid');
    assert.equal(free.paymentDueAt, null);
    assert.equal(free.proofUploadId, null);
    assert.equal(transfer.totalCents, 4000);
    assert.equal(transfer.paymentMethod, 'transfer');
    assert.equal(transfer.paymentStatus, 'unpaid');
    assert(transfer.paymentDueAt);
    r = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/reports/sales',
      headers: auth(t.admin.token),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().data.summary.noChargeOrders, 1);
    assert.equal(r.json().data.summary.collectedCents, 0);
    assert.equal(r.json().data.summary.pendingPaymentCents, 4000);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/orders/' + free.id + '/cancel',
      headers: auth(t.admin.token),
      payload: { reason: 'Cancel no-charge order' },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().data.paymentStatus, 'unpaid');
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + free.id + '/refund',
      headers: auth(t.admin.token),
      payload: { reference: 'NOT-NEEDED', note: 'There was no payment' },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [t.p1]))!.stock, 10);
    assert.equal(
      (await t.db.one("SELECT used_count FROM promotions WHERE code='FREE100'"))!.used_count,
      1,
    );
  } finally {
    await t.close();
  }
});

test('admin can reconcile late transfer into refund_pending without reviving stock or leaking financial references', async () => {
  const t = await fixture();
  try {
    await t.cart(t.p1);
    let r = await t.checkout({ paymentMethod: 'transfer' });
    assert.equal(r.statusCode, 201, r.body);
    const order = r.json().data.orders[0];
    await t.db.query("UPDATE orders SET payment_due_at=now()-interval '1 second' WHERE id=$1", [
      order.id,
    ]);
    const incoming = {
      reference: 'LATE-PRIVATE-001',
      amountCents: order.totalCents,
      note: 'PRIVATE_BANK_RECONCILIATION_NOTE',
      receivedAt: new Date().toISOString(),
    };
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + order.id + '/late-payment',
      headers: auth(t.admin.token),
      payload: { ...incoming, receivedAt: '0000-01-01T00:00:00Z' },
    });
    assert.equal(r.statusCode, 400, r.body);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + order.id + '/late-payment',
      headers: auth(t.seller.token),
      payload: incoming,
    });
    assert.equal(r.statusCode, 403, r.body);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + order.id + '/late-payment',
      headers: auth(t.admin.token),
      payload: { ...incoming, amountCents: 1 },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [t.p1]))!.stock, 9);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + order.id + '/late-payment',
      headers: auth(t.admin.token),
      payload: incoming,
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().data.status, 'cancelled');
    assert.equal(r.json().data.paymentStatus, 'refund_pending');
    assert.equal(r.json().data.paymentReference, incoming.reference);
    assert.equal(r.json().data.stockReleased, true);
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [t.p1]))!.stock, 10);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + order.id + '/late-payment',
      headers: auth(t.admin.token),
      payload: incoming,
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(
      (await t.db.one(
        "SELECT count(*) AS n FROM order_events WHERE order_id=$1 AND detail->>'code'='payment.late_received'",
        [order.id],
      ))!.n,
      1,
    );
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + order.id + '/late-payment',
      headers: auth(t.admin.token),
      payload: { ...incoming, reference: 'DIFFERENT-REFERENCE' },
    });
    assert.equal(r.statusCode, 409, r.body);
    r = await t.app.inject({
      method: 'GET',
      url: '/api/v1/orders/' + order.id,
      headers: auth(t.seller.token),
    });
    assert.doesNotMatch(r.body, /LATE-PRIVATE-001|PRIVATE_BANK_RECONCILIATION_NOTE/);
    assert.equal(r.json().data.paymentReference, undefined);
    r = await t.app.inject({
      method: 'GET',
      url: '/api/v1/orders/' + order.id,
      headers: auth(t.buyer.token),
    });
    assert.match(r.body, /LATE-PRIVATE-001/);
    r = await t.app.inject({
      method: 'GET',
      url: '/api/v1/seller/reports/sales.csv',
      headers: auth(t.seller.token),
    });
    assert.doesNotMatch(r.body, /LATE-PRIVATE-001/);
    r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/' + order.id + '/refund',
      headers: auth(t.admin.token),
      payload: { reference: 'RETURN-LATE-001', note: 'Recorded actual manual refund' },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().data.paymentStatus, 'refunded');
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [t.p1]))!.stock, 10);
  } finally {
    await t.close();
  }
});

test('lifecycle migration backfills legacy deadlines and upgrades zero-balance orders without rewriting price snapshots', async (testContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'bloom-commerce-upgrade-'));
  let fixture: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  try {
    for (const file of ['001_core.sql', '002_catalog.sql', '003_commerce.sql', '004_wellness.sql'])
      await copyFile(resolve('migrations', file), join(directory, file));
    fixture = await createTestDatabase({ migrationDirectory: directory });
    const { db } = fixture;
    assert.equal(db.driver, process.env.TEST_DATABASE_URL ? 'postgres' : 'pglite');
    testContext.diagnostic('Populated 001–004 to 006 migration upgrade driver: ' + db.driver);
    assert.equal((await db.one('SELECT count(*) AS n FROM schema_migrations'))!.n, 4);
    const buyer = randomUUID(),
      seller = randomUUID(),
      shop = randomUUID(),
      category = randomUUID(),
      product = randomUUID();
    for (const [id, email, role] of [
      [buyer, 'legacy-buyer@example.test', 'user'],
      [seller, 'legacy-seller@example.test', 'seller'],
    ])
      await db.query('INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)', [
        id,
        'Legacy fixture',
        email,
        'unused-fixture-password',
        role,
      ]);
    await db.query(
      "INSERT INTO shops(id,owner_id,name,email,description,status) VALUES($1,$2,'Legacy Store','store@example.test','Legacy','approved')",
      [shop, seller],
    );
    await db.query("INSERT INTO categories(id,name) VALUES($1,'Legacy Category')", [category]);
    await db.query(
      "INSERT INTO products(id,shop_id,category_id,name,price_cents,stock) VALUES($1,$2,$3,'Historical product',10000,7)",
      [product, shop, category],
    );
    async function legacy(paymentStatus: string, total = 10000) {
      const checkout = randomUUID(),
        id = randomUUID();
      await db.query('INSERT INTO checkout_groups(id,buyer_id) VALUES($1,$2)', [checkout, buyer]);
      const order = await db.one(
        "INSERT INTO orders(id,number,checkout_id,buyer_id,shop_id,status,payment_status,payment_method,address_snapshot,subtotal_cents,shipping_cents,discount_cents,total_cents,created_at) VALUES($1,$2,$3,$4,$5,'pending',$6,'transfer','{}',10000,0,$7,$8,now()-interval '2 days') RETURNING *",
        [id, 'LEGACY-' + id, checkout, buyer, shop, paymentStatus, 10000 - total, total],
      );
      await db.query(
        "INSERT INTO order_items(order_id,product_id,name,unit_price_cents,quantity) VALUES($1,$2,'Original product snapshot',10000,1)",
        [id, product],
      );
      return order!;
    }
    const unpaid = await legacy('unpaid'),
      rejected = await legacy('rejected'),
      zero = await legacy('unpaid', 0),
      proof = randomUUID();
    await db.query(
      "INSERT INTO uploads(id,owner_id,kind,storage_key,mime,size_bytes,sha256) VALUES($1,$2,'proof',$3,'image/png',74,$4)",
      [proof, buyer, proof + '.png', 'a'.repeat(64)],
    );
    const rejectedProof = await db.one(
      "INSERT INTO order_payment_proofs(order_id,upload_id,status,reason,reviewed_at) VALUES($1,$2,'rejected','Old rejection',now()-interval '30 minutes') RETURNING *",
      [rejected.id, proof],
    );
    for (const file of ['005_commerce_lifecycle.sql', '006_upload_cleanup.sql'])
      await copyFile(resolve('migrations', file), join(directory, file));
    await migrate(db, directory);
    assert.equal((await db.one('SELECT count(*) AS n FROM schema_migrations'))!.n, 6);
    assert.equal((await db.one('SELECT count(*) AS n FROM upload_deletion_jobs'))!.n, 0);
    const a = await db.one('SELECT * FROM orders WHERE id=$1', [unpaid.id]),
      b = await db.one('SELECT * FROM orders WHERE id=$1', [rejected.id]),
      c = await db.one('SELECT * FROM orders WHERE id=$1', [zero.id]);
    assert.equal(
      new Date(a!.payment_due_at).getTime() - new Date(unpaid.created_at).getTime(),
      24 * 3600000,
    );
    assert(Date.parse(a!.payment_due_at) < Date.now());
    assert.equal(
      new Date(b!.payment_due_at).getTime() - new Date(rejectedProof!.reviewed_at).getTime(),
      24 * 3600000,
    );
    assert(Date.parse(b!.payment_due_at) > Date.now());
    assert.equal(c!.payment_method, 'no_charge');
    assert.equal(c!.status, 'paid');
    assert.equal(c!.payment_due_at, null);
    assert.equal(c!.total_cents, 0);
    assert.equal(
      (await db.one('SELECT name,unit_price_cents FROM order_items WHERE order_id=$1', [zero.id]))!
        .name,
      'Original product snapshot',
    );
    await migrate(db, directory);
    assert.equal(
      (await db.one(
        "SELECT count(*) AS n FROM order_events WHERE order_id=$1 AND detail->>'source'='migration_005'",
        [zero.id],
      ))!.n,
      1,
    );
  } finally {
    try {
      await fixture?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
