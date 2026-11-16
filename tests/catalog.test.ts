import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { adminUser, createTestApp, registerUser } from './helpers.js';

let env: Awaited<ReturnType<typeof createTestApp>>;
let admin: Awaited<ReturnType<typeof adminUser>>;
beforeEach(async () => {
  env = await createTestApp();
  admin = await adminUser(env.app, env.db);
});
afterEach(async () => {
  await env?.close();
});
const call = (
  app: FastifyInstance,
  token: string | undefined,
  method: any,
  url: string,
  payload?: any,
) =>
  app.inject({
    method,
    url,
    ...(token ? { headers: { authorization: 'Bearer ' + token } } : {}),
    ...(payload === undefined ? {} : { payload }),
  });
const body = (response: any) => response.json().data;
async function category(name = 'Care ' + randomUUID()) {
  const r = await call(env.app, admin.token, 'POST', '/api/v1/admin/categories', {
    name,
    icon: 'leaf',
    description: 'Catalog test',
  });
  assert.equal(r.statusCode, 201, r.body);
  return body(r);
}
async function approvedSeller() {
  const user = await registerUser(env.app);
  const application = await call(env.app, user.token, 'POST', '/api/v1/me/shop', {
    name: 'Test shop ' + randomUUID().slice(0, 8),
    email: 'shop@example.com',
    description: 'A complete shop description for a synthetic test.',
  });
  assert.equal(application.statusCode, 201, application.body);
  const shop = body(application);
  const approved = await call(
    env.app,
    admin.token,
    'POST',
    `/api/v1/admin/shops/${shop.id}/decision`,
    { decision: 'approve' },
  );
  assert.equal(approved.statusCode, 200, approved.body);
  return { ...user, shop: body(approved) };
}
async function product(
  seller: Awaited<ReturnType<typeof approvedSeller>>,
  categoryId: string,
  overrides: any = {},
) {
  const r = await call(env.app, seller.token, 'POST', '/api/v1/seller/products', {
    name: 'Wellness product',
    categoryId,
    priceCents: 9950,
    stock: 10,
    ...overrides,
  });
  assert.equal(r.statusCode, 201, r.body);
  return body(r);
}

test('seller application rejects incomplete data, supports rejection/resubmission and requires admin approval', async () => {
  const user = await registerUser(env.app);
  const incomplete = await call(env.app, user.token, 'POST', '/api/v1/me/shop', {
    name: 'A',
    email: 'bad',
    description: '',
  });
  assert.equal(incomplete.statusCode, 400);
  const applied = await call(env.app, user.token, 'POST', '/api/v1/me/shop', {
    name: 'Initial shop',
    email: 'new@example.com',
    description: 'Complete application description.',
  });
  assert.equal(applied.statusCode, 201, applied.body);
  const id = body(applied).id;
  assert.equal(
    (
      await call(env.app, user.token, 'POST', `/api/v1/admin/shops/${id}/decision`, {
        decision: 'approve',
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call(env.app, admin.token, 'POST', `/api/v1/admin/shops/${id}/decision`, {
        decision: 'reject',
      })
    ).statusCode,
    400,
  );
  const rejected = await call(env.app, admin.token, 'POST', `/api/v1/admin/shops/${id}/decision`, {
    decision: 'reject',
    reason: 'Please complete store details',
  });
  assert.equal(body(rejected).status, 'rejected');
  assert.equal(
    (
      await call(env.app, user.token, 'PATCH', '/api/v1/me/shop', {
        description: 'Updated complete application details.',
      })
    ).statusCode,
    200,
  );
  assert.equal(
    body(await call(env.app, user.token, 'POST', '/api/v1/me/shop/resubmit')).status,
    'pending',
  );
  const approved = await call(env.app, admin.token, 'POST', `/api/v1/admin/shops/${id}/decision`, {
    decision: 'approve',
  });
  assert.equal(body(approved).status, 'approved');
  assert.equal(
    (await env.db.one('SELECT role FROM users WHERE id=$1', [user.user.id]))!.role,
    'seller',
  );
  assert.equal(
    (await call(env.app, user.token, 'POST', '/api/v1/me/shop/resubmit')).statusCode,
    409,
  );
  assert.equal(
    (
      await call(env.app, user.token, 'POST', '/api/v1/me/shop', {
        name: 'Duplicate shop',
        email: 'new@example.com',
        description: 'Another complete shop application.',
      })
    ).statusCode,
    409,
  );
});

test('catalog money and ownership rules reject spoofing and expose only available listings', async () => {
  const cat = await category(),
    seller = await approvedSeller(),
    other = await approvedSeller();
  const item = await product(seller, cat.id);
  const foreign = await call(env.app, other.token, 'PATCH', `/api/v1/seller/products/${item.id}`, {
    priceCents: 1,
  });
  assert.equal(foreign.statusCode, 404);
  assert.equal(
    (
      await call(env.app, seller.token, 'PATCH', `/api/v1/seller/products/${item.id}`, {
        shopId: other.shop.id,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call(env.app, seller.token, 'PATCH', `/api/v1/seller/products/${item.id}`, {
        priceCents: 99.5,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call(env.app, seller.token, 'PATCH', `/api/v1/seller/products/${item.id}`, {
        originalPriceCents: 100,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    body(await call(env.app, undefined, 'GET', `/api/v1/products/${item.id}`)).priceCents,
    9950,
  );
  const filtered = await call(
    env.app,
    undefined,
    'GET',
    `/api/v1/products?q=Wellness&categoryId=${cat.id}&shopId=${seller.shop.id}&minPriceCents=9000&sort=price_asc`,
  );
  assert.equal(filtered.statusCode, 200, filtered.body);
  assert.equal(filtered.json().data.length, 1);
  assert.equal(
    (await call(env.app, undefined, 'GET', '/api/v1/products?minPriceCents=100&maxPriceCents=10'))
      .statusCode,
    400,
  );
});

test('product images must belong to the actor and be product uploads', async () => {
  const cat = await category(),
    seller = await approvedSeller(),
    other = await registerUser(env.app);
  const imageId = randomUUID();
  await env.db.query(
    'INSERT INTO uploads(id,owner_id,kind,storage_key,mime,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [imageId, other.user.id, 'product', 'test-' + imageId, 'image/png', 12, 'a'.repeat(64)],
  );
  const unauthorized = await call(env.app, seller.token, 'POST', '/api/v1/seller/products', {
    name: 'Foreign image',
    categoryId: cat.id,
    priceCents: 100,
    imageId,
  });
  assert.equal(unauthorized.statusCode, 400);
  await env.db.query('UPDATE uploads SET owner_id=$2,kind=$3 WHERE id=$1', [
    imageId,
    seller.user.id,
    'proof',
  ]);
  assert.equal(
    (
      await call(env.app, seller.token, 'POST', '/api/v1/seller/products', {
        name: 'Private proof image',
        categoryId: cat.id,
        priceCents: 100,
        imageId,
      })
    ).statusCode,
    400,
  );
  await env.db.query("UPDATE uploads SET kind='product' WHERE id=$1", [imageId]);
  const item = await product(seller, cat.id, { imageId });
  assert.equal(item.imageUrl, '/api/v1/uploads/' + imageId);
});

test('category hiding and product archive preserve references and require explicit restore publication', async () => {
  const cat = await category(),
    seller = await approvedSeller(),
    item = await product(seller, cat.id);
  assert.equal(
    (await call(env.app, admin.token, 'DELETE', `/api/v1/admin/categories/${cat.id}`)).statusCode,
    409,
  );
  assert.equal(
    (
      await call(env.app, admin.token, 'PATCH', `/api/v1/admin/categories/${cat.id}`, {
        active: false,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await call(env.app, undefined, 'GET', `/api/v1/products/${item.id}`)).statusCode,
    404,
  );
  await call(env.app, admin.token, 'PATCH', `/api/v1/admin/categories/${cat.id}`, { active: true });
  assert.equal(
    (await call(env.app, seller.token, 'DELETE', `/api/v1/seller/products/${item.id}`)).statusCode,
    200,
  );
  const row = await env.db.one('SELECT archived_at,stock FROM products WHERE id=$1', [item.id]);
  assert.ok(row!.archived_at);
  assert.equal(row!.stock, 10);
  assert.equal(
    (
      await call(env.app, seller.token, 'PATCH', `/api/v1/seller/products/${item.id}`, {
        active: true,
      })
    ).statusCode,
    409,
  );
  const restored = await call(
    env.app,
    seller.token,
    'POST',
    `/api/v1/seller/products/${item.id}/restore`,
  );
  assert.equal(body(restored).active, false);
  assert.equal(
    (
      await call(env.app, seller.token, 'PATCH', `/api/v1/seller/products/${item.id}`, {
        active: true,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await call(env.app, undefined, 'GET', `/api/v1/products/${item.id}`)).statusCode,
    200,
  );
});

test('suspension stops new sales and publishing but preserves seller management access', async () => {
  const cat = await category(),
    seller = await approvedSeller(),
    item = await product(seller, cat.id);
  const suspend = await call(
    env.app,
    admin.token,
    'PATCH',
    `/api/v1/admin/shops/${seller.shop.id}/status`,
    { status: 'suspended', reason: 'Administrative review' },
  );
  assert.equal(suspend.statusCode, 200, suspend.body);
  assert.equal(
    (await call(env.app, undefined, 'GET', `/api/v1/shops/${seller.shop.id}`)).statusCode,
    404,
  );
  assert.equal(
    (await call(env.app, undefined, 'GET', `/api/v1/products/${item.id}`)).statusCode,
    404,
  );
  assert.equal(
    (await call(env.app, seller.token, 'GET', '/api/v1/seller/products')).statusCode,
    200,
  );
  assert.equal(
    (
      await call(env.app, seller.token, 'POST', '/api/v1/seller/products', {
        name: 'Not permitted',
        categoryId: cat.id,
        priceCents: 100,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await call(env.app, seller.token, 'PATCH', `/api/v1/seller/products/${item.id}`, {
        active: false,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call(env.app, seller.token, 'PATCH', `/api/v1/seller/products/${item.id}`, {
        active: true,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await call(env.app, admin.token, 'PATCH', `/api/v1/admin/shops/${seller.shop.id}/status`, {
        status: 'approved',
      })
    ).statusCode,
    200,
  );
});

test('concurrent stock decrements cannot produce a negative balance and failed writes add no movement', async () => {
  const cat = await category(),
    seller = await approvedSeller(),
    item = await product(seller, cat.id, { stock: 1 });
  const requests = await Promise.all(
    [1, 2].map(() =>
      call(env.app, seller.token, 'POST', `/api/v1/seller/products/${item.id}/stock`, {
        change: -1,
        reason: 'Test deduction',
      }),
    ),
  );
  assert.deepEqual(requests.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal((await env.db.one('SELECT stock FROM products WHERE id=$1', [item.id]))!.stock, 0);
  const moves = await env.db.query(
    'SELECT change,balance FROM stock_movements WHERE product_id=$1 ORDER BY created_at,id',
    [item.id],
  );
  assert.equal(moves.length, 2);
  assert.equal(
    moves.reduce((sum, m) => sum + m.change, 0),
    0,
  );
});

test('member blocking revokes sessions and suspends the owned shop; activation is explicit', async () => {
  const seller = await approvedSeller();
  const blocked = await call(
    env.app,
    admin.token,
    'PATCH',
    `/api/v1/admin/users/${seller.user.id}/status`,
    { blocked: true, reason: 'Test account review' },
  );
  assert.equal(blocked.statusCode, 200, blocked.body);
  assert.equal(
    (await env.db.one('SELECT COUNT(*)::int AS count FROM sessions WHERE user_id=$1', [
      seller.user.id,
    ]))!.count,
    0,
  );
  assert.equal((await call(env.app, seller.token, 'GET', '/api/v1/me/shop')).statusCode, 401);
  assert.equal(
    (await env.db.one('SELECT status FROM shops WHERE id=$1', [seller.shop.id]))!.status,
    'suspended',
  );
  assert.equal(
    (
      await call(env.app, admin.token, 'PATCH', `/api/v1/admin/shops/${seller.shop.id}/status`, {
        status: 'approved',
      })
    ).statusCode,
    409,
  );
  await call(env.app, admin.token, 'PATCH', `/api/v1/admin/users/${seller.user.id}/status`, {
    blocked: false,
    reason: 'Review completed',
  });
  assert.equal(
    (await env.db.one('SELECT status FROM shops WHERE id=$1', [seller.shop.id]))!.status,
    'suspended',
  );
  assert.equal(
    (
      await call(env.app, admin.token, 'PATCH', `/api/v1/admin/users/${admin.user.id}/status`, {
        blocked: true,
        reason: 'Do not allow self block',
      })
    ).statusCode,
    409,
  );
});

test('member APIs redact secrets, require administrator access, and neutralize CSV formulas', async () => {
  const user = await registerUser(env.app, { name: '=HYPERLINK("https://example.invalid")' });
  const detail = await call(env.app, admin.token, 'GET', `/api/v1/admin/users/${user.user.id}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(body(detail).passwordHash, undefined);
  assert.equal(body(detail).password_hash, undefined);
  assert.equal((await call(env.app, user.token, 'GET', '/api/v1/admin/users')).statusCode, 403);
  const exported = await call(
    env.app,
    admin.token,
    'GET',
    '/api/v1/admin/users/export?q=' + encodeURIComponent(user.user.email),
  );
  assert.equal(exported.statusCode, 200, exported.body);
  assert.ok(exported.body.includes("'=HYPERLINK"));
  assert.ok(!exported.body.includes('passwordHash'));
  const members = await call(
    env.app,
    admin.token,
    'GET',
    '/api/v1/admin/users?role=user&blocked=false',
  );
  assert.equal(members.statusCode, 200);
  assert.ok(
    members
      .json()
      .data.every((u: any) => u.role === 'user' && !u.blocked && !('passwordHash' in u)),
  );
});

test('site settings reject unknown fields and mutations produce audit events; usage dates validate', async () => {
  const saved = await call(env.app, admin.token, 'PATCH', '/api/v1/admin/settings', {
    siteTitle: 'Bloom test',
    siteNotice: 'A verified notice',
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(
    body(await call(env.app, undefined, 'GET', '/api/v1/settings')).siteTitle,
    'Bloom test',
  );
  const contact = await call(env.app, admin.token, 'PATCH', '/api/v1/admin/settings', {
    contactEmail: 'contact@example.test',
  });
  assert.equal(contact.statusCode, 200, contact.body);
  const clearedContact = await call(env.app, admin.token, 'PATCH', '/api/v1/admin/settings', {
    contactEmail: '',
  });
  assert.equal(clearedContact.statusCode, 200, clearedContact.body);
  assert.equal(body(await call(env.app, undefined, 'GET', '/api/v1/settings')).contactEmail, '');
  assert.equal(body(clearedContact).siteTitle, 'Bloom test');
  assert.equal(
    (
      await call(env.app, admin.token, 'PATCH', '/api/v1/admin/settings', {
        contactEmail: 'invalid',
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call(env.app, admin.token, 'PATCH', '/api/v1/admin/settings', {
        smtpPassword: 'not-allowed',
      })
    ).statusCode,
    400,
  );
  const audits = await call(
    env.app,
    admin.token,
    'GET',
    '/api/v1/admin/audit-events?action=settings.update',
  );
  assert.equal(audits.statusCode, 200, audits.body);
  assert.ok(audits.json().data.length >= 1);
  assert.equal(
    (await call(env.app, undefined, 'POST', '/api/v1/visits', { page: 'shop' })).statusCode,
    202,
  );
  assert.equal(
    (await call(env.app, undefined, 'POST', '/api/v1/visits', { page: 'unknown' })).statusCode,
    400,
  );
  assert.equal(
    (await call(env.app, admin.token, 'GET', '/api/v1/admin/usage?from=2026-11-15&to=2026-11-14'))
      .statusCode,
    400,
  );
  assert.equal(
    (await call(env.app, admin.token, 'GET', '/api/v1/admin/usage?from=2026-02-31')).statusCode,
    400,
  );
  assert.equal(
    (await call(env.app, admin.token, 'GET', '/api/v1/admin/usage?from=0000-01-01')).statusCode,
    400,
  );
  assert.equal(
    (await call(env.app, admin.token, 'GET', '/api/v1/admin/audit-events?from=0000-01-01'))
      .statusCode,
    400,
  );
  const usage = await call(env.app, admin.token, 'GET', '/api/v1/admin/usage');
  assert.equal(usage.statusCode, 200, usage.body);
  assert.ok(usage.json().data.some((r: any) => r.page === 'shop' && r.views >= 1));
});

test('partial catalog updates preserve omitted defaults and reject empty patches', async () => {
  const cat = await category();
  const seller = await approvedSeller();
  const imageId = randomUUID();
  await env.db.query(
    'INSERT INTO uploads(id,owner_id,kind,storage_key,mime,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [imageId, seller.user.id, 'product', imageId + '.webp', 'image/webp', 12, 'b'.repeat(64)],
  );
  const item = await product(seller, cat.id, {
    englishName: 'Original English name',
    description: 'Original product description',
    originalPriceCents: 15900,
    imageId,
    imageIndex: 4,
    badge: 'Limited',
    stock: 27,
    active: false,
  });
  const priceOnly = await call(
    env.app,
    seller.token,
    'PATCH',
    `/api/v1/seller/products/${item.id}`,
    {
      priceCents: 10900,
    },
  );
  assert.equal(priceOnly.statusCode, 200, priceOnly.body);
  const unchanged = body(priceOnly);
  for (const key of [
    'englishName',
    'description',
    'originalPriceCents',
    'imageId',
    'imageIndex',
    'badge',
    'stock',
    'active',
  ]) {
    assert.equal(unchanged[key], item[key], key + ' must remain unchanged');
  }
  const cleared = await call(env.app, seller.token, 'PATCH', `/api/v1/seller/products/${item.id}`, {
    imageId: null,
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(body(cleared).imageId, null);
  assert.equal(body(cleared).active, false);
  assert.equal(body(cleared).stock, 27);

  await call(env.app, seller.token, 'PATCH', '/api/v1/me/shop', {
    shippingFeeCents: 5500,
    freeShippingAtCents: 150000,
  });
  const renamedShop = await call(env.app, seller.token, 'PATCH', '/api/v1/me/shop', {
    name: 'Renamed store',
  });
  assert.equal(renamedShop.statusCode, 200, renamedShop.body);
  assert.equal(body(renamedShop).shippingFeeCents, 5500);
  assert.equal(body(renamedShop).freeShippingAtCents, 150000);

  await call(env.app, admin.token, 'PATCH', `/api/v1/admin/categories/${cat.id}`, {
    icon: 'flower',
    description: 'Custom category description',
    active: false,
  });
  const renamedCategory = await call(
    env.app,
    admin.token,
    'PATCH',
    `/api/v1/admin/categories/${cat.id}`,
    {
      name: 'Renamed category ' + randomUUID(),
    },
  );
  assert.equal(renamedCategory.statusCode, 200, renamedCategory.body);
  assert.equal(body(renamedCategory).icon, 'flower');
  assert.equal(body(renamedCategory).description, 'Custom category description');
  assert.equal(body(renamedCategory).active, false);

  for (const [token, path] of [
    [seller.token, `/api/v1/seller/products/${item.id}`],
    [seller.token, '/api/v1/me/shop'],
    [admin.token, `/api/v1/admin/categories/${cat.id}`],
  ]) {
    const response = await call(env.app, token, 'PATCH', path, {});
    assert.equal(response.statusCode, 400, path + ': ' + response.body);
  }
});

test('catalog, shop and member searches treat wildcard characters as literal user text', async () => {
  const cat = await category();
  const seller = await approvedSeller();
  const otherSeller = await approvedSeller();
  const special = 'Literal % _ \\ marker';
  await call(env.app, seller.token, 'PATCH', '/api/v1/me/profile', { name: special });
  await call(env.app, seller.token, 'PATCH', '/api/v1/me/shop', { name: special });
  const item = await product(seller, cat.id, { name: special });
  await product(otherSeller, cat.id, { name: 'Ordinary marker' });
  const routes = [
    { token: undefined, path: '/api/v1/products', id: item.id },
    { token: seller.token, path: '/api/v1/seller/products', id: item.id },
    { token: admin.token, path: '/api/v1/admin/products', id: item.id },
    { token: undefined, path: '/api/v1/shops', id: seller.shop.id },
    { token: admin.token, path: '/api/v1/admin/shops', id: seller.shop.id },
    { token: admin.token, path: '/api/v1/admin/users', id: seller.user.id },
  ];
  for (const query of ['%', '_', '\\']) {
    for (const target of routes) {
      const response = await call(
        env.app,
        target.token,
        'GET',
        target.path + '?q=' + encodeURIComponent(query),
      );
      assert.equal(response.statusCode, 200, target.path + ': ' + response.body);
      assert.equal(response.json().page.total, 1, target.path + ': ' + query);
      assert.deepEqual(
        response.json().data.map((row: any) => row.id),
        [target.id],
      );
    }
  }
});

test('cancellation-restored excess stock can be reduced without allowing further excess increases', async () => {
  const cat = await category();
  const seller = await approvedSeller();
  const buyer = await registerUser(env.app);
  const item = await product(seller, cat.id, { stock: 2 });
  const address = await call(env.app, buyer.token, 'POST', '/api/v1/me/addresses', {
    label: 'Home',
    name: 'Buyer',
    phone: '0800000000',
    address: 'Synthetic shipping address',
  });
  assert.equal(address.statusCode, 201, address.body);
  assert.equal(
    (await call(env.app, buyer.token, 'PUT', '/api/v1/me/cart/' + item.id, { quantity: 2 }))
      .statusCode,
    200,
  );
  const checkout = await env.app.inject({
    method: 'POST',
    url: '/api/v1/checkout',
    headers: { authorization: 'Bearer ' + buyer.token, 'idempotency-key': randomUUID() },
    payload: { addressId: body(address).id, paymentMethod: 'transfer' },
  });
  assert.equal(checkout.statusCode, 201, checkout.body);
  const orderId = body(checkout).orders[0].id;
  const replenished = await call(
    env.app,
    seller.token,
    'PATCH',
    '/api/v1/seller/products/' + item.id,
    {
      stock: 1_000_000,
    },
  );
  assert.equal(replenished.statusCode, 200, replenished.body);
  const cancelled = await call(
    env.app,
    buyer.token,
    'POST',
    '/api/v1/orders/' + orderId + '/cancel',
    {
      reason: 'Cancel the pending test order',
    },
  );
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(
    (await env.db.one('SELECT stock FROM products WHERE id=$1', [item.id]))!.stock,
    1_000_002,
  );
  const adjusted = await call(
    env.app,
    seller.token,
    'POST',
    '/api/v1/seller/products/' + item.id + '/stock',
    {
      change: -1,
      reason: 'Reduce one restored damaged unit',
    },
  );
  assert.equal(adjusted.statusCode, 200, adjusted.body);
  assert.equal(body(adjusted).stock, 1_000_001);
  const countBefore = (await env.db.one(
    'SELECT COUNT(*)::int AS count FROM stock_movements WHERE product_id=$1',
    [item.id],
  ))!.count;
  const increase = await call(
    env.app,
    seller.token,
    'POST',
    '/api/v1/seller/products/' + item.id + '/stock',
    {
      change: 1,
      reason: 'Do not permit an additional excess increase',
    },
  );
  assert.equal(increase.statusCode, 409, increase.body);
  assert.equal(
    (await env.db.one('SELECT stock FROM products WHERE id=$1', [item.id]))!.stock,
    1_000_001,
  );
  assert.equal(
    (await env.db.one('SELECT COUNT(*)::int AS count FROM stock_movements WHERE product_id=$1', [
      item.id,
    ]))!.count,
    countBefore,
  );
});

test('usage reports reject oversized grouped output instead of silently dropping earlier dates', async () => {
  await env.db.query(
    "INSERT INTO page_visits(page,created_at) SELECT 'shop', ('2000-01-01'::date+n)::timestamp AT TIME ZONE 'Asia/Bangkok' FROM generate_series(0,5000) AS series(n)",
  );
  const tooLarge = await call(
    env.app,
    admin.token,
    'GET',
    '/api/v1/admin/usage?from=2000-01-01&to=2030-01-01',
  );
  assert.equal(tooLarge.statusCode, 422, tooLarge.body);
  assert.equal(tooLarge.json().error.code, 'USAGE_REPORT_TOO_LARGE');
  assert.equal(tooLarge.json().error.details.maxGroups, 5000);
  const bounded = await call(
    env.app,
    admin.token,
    'GET',
    '/api/v1/admin/usage?from=2000-01-01&to=2000-01-10',
  );
  assert.equal(bounded.statusCode, 200, bounded.body);
  assert.equal(body(bounded).length, 10);
  assert.equal(body(bounded)[0].day, '2000-01-10');
  assert.equal(body(bounded).at(-1).day, '2000-01-01');
  assert.equal(
    body(bounded).reduce((sum: number, row: any) => sum + row.views, 0),
    10,
  );
});
