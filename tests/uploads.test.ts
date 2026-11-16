import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createTestApp, registerUser, adminUser, bearer } from './helpers.js';
async function png() {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#eaa3bd' } })
    .png()
    .toBuffer();
}
function multipart(buffer: Buffer, mime = 'image/png', name = 'file', extra?: Buffer) {
  const boundary = 'bloom-' + randomUUID();
  const parts = [
    Buffer.from(
      '--' +
        boundary +
        '\r\nContent-Disposition: form-data; name="' +
        name +
        '"; filename="proof.png"\r\nContent-Type: ' +
        mime +
        '\r\n\r\n',
    ),
    buffer,
    Buffer.from('\r\n'),
  ];
  if (extra)
    parts.push(
      Buffer.from(
        '--' +
          boundary +
          '\r\nContent-Disposition: form-data; name="second"; filename="other.png"\r\nContent-Type: image/png\r\n\r\n',
      ),
      extra,
      Buffer.from('\r\n'),
    );
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': 'multipart/form-data; boundary=' + boundary },
  };
}

test('server decodes/re-encodes images and keeps payment proof private to owner/admin', async () => {
  const t = await createTestApp();
  try {
    const owner = await registerUser(t.app),
      stranger = await registerUser(t.app),
      admin = await adminUser(t.app, t.db);
    const form = multipart(await png());
    const up = await t.app.inject({
      method: 'POST',
      url: '/api/v1/uploads?kind=proof',
      headers: { ...form.headers, ...bearer(owner.token) },
      payload: form.payload,
    });
    assert.equal(up.statusCode, 201, up.body);
    const id = up.json().data.id;
    assert.equal(up.json().data.mime, 'image/webp');
    assert.equal('storageKey' in up.json().data, false);
    for (const headers of [{}, bearer(stranger.token)])
      assert.equal((await t.app.inject({ url: '/api/v1/uploads/' + id, headers })).statusCode, 404);
    for (const token of [owner.token, admin.token]) {
      const read = await t.app.inject({ url: '/api/v1/uploads/' + id, headers: bearer(token) });
      assert.equal(read.statusCode, 200, read.body);
      assert.match(read.headers['content-type']!, /image\/webp/);
      assert.equal(read.headers['cache-control'], 'private, no-store');
      const meta = await sharp(read.rawPayload).metadata();
      assert.equal(meta.width, 8);
    }
    assert.equal(
      (
        await t.app.inject({
          method: 'DELETE',
          url: '/api/v1/uploads/' + id,
          headers: bearer(stranger.token),
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await t.app.inject({
          method: 'DELETE',
          url: '/api/v1/uploads/' + id,
          headers: bearer(owner.token),
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await t.app.inject({ url: '/api/v1/uploads/' + id, headers: bearer(owner.token) }))
        .statusCode,
      404,
    );
  } finally {
    await t.close();
  }
});

test('invalid images, oversized files, wrong kinds and multiple files are rejected without retained uploads', async () => {
  const t = await createTestApp();
  try {
    const user = await registerUser(t.app);
    const inject = async (form: ReturnType<typeof multipart>, kind = 'proof', token = user.token) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/uploads?kind=' + kind,
        headers: { ...form.headers, ...bearer(token) },
        payload: form.payload,
      });
    assert.equal((await inject(multipart(Buffer.from('not an image')))).statusCode, 400);
    assert.equal((await inject(multipart(await png(), 'image/jpeg'))).statusCode, 400);
    assert.equal((await inject(multipart(Buffer.alloc(1024 * 1024 + 1, 0)))).statusCode, 413);
    assert.equal((await inject(multipart(await png()), 'product')).statusCode, 403);
    assert.equal((await inject(multipart(await png()), 'article')).statusCode, 403);
    const multi = await inject(multipart(await png(), 'image/png', 'file', await png()));
    assert.equal(multi.statusCode, 400, multi.body);
    assert.equal((await t.db.one('SELECT count(*) AS total FROM uploads'))!.total, 0);
  } finally {
    await t.close();
  }
});

test('product files become public only when linked to available listings; referenced deletion is denied', async () => {
  const t = await createTestApp();
  try {
    const admin = await adminUser(t.app, t.db);
    const form = multipart(await png());
    const up = await t.app.inject({
      method: 'POST',
      url: '/api/v1/uploads?kind=product',
      headers: { ...form.headers, ...bearer(admin.token) },
      payload: form.payload,
    });
    assert.equal(up.statusCode, 201, up.body);
    const id = up.json().data.id;
    assert.equal((await t.app.inject({ url: '/api/v1/uploads/' + id })).statusCode, 404);
    const s = randomUUID(),
      c = randomUUID(),
      p = randomUUID();
    await t.db.query(
      "INSERT INTO shops(id,owner_id,name,email,description,status) VALUES($1,$2,'Photo Store','photo@example.test','Test store','approved')",
      [s, admin.user.id],
    );
    await t.db.query("INSERT INTO categories(id,name) VALUES($1,'Photo category')", [c]);
    await t.db.query(
      "INSERT INTO products(id,shop_id,category_id,name,price_cents,stock,image_id) VALUES($1,$2,$3,'Product',1000,1,$4)",
      [p, s, c, id],
    );
    assert.equal((await t.app.inject({ url: '/api/v1/uploads/' + id })).statusCode, 200);
    assert.equal(
      (
        await t.app.inject({
          method: 'DELETE',
          url: '/api/v1/uploads/' + id,
          headers: bearer(admin.token),
        })
      ).statusCode,
      409,
    );
    await t.db.query('UPDATE categories SET active=false WHERE id=$1', [c]);
    assert.equal((await t.app.inject({ url: '/api/v1/uploads/' + id })).statusCode, 404);
    await t.db.query('UPDATE categories SET active=true WHERE id=$1', [c]);
    await t.db.query("UPDATE shops SET status='suspended' WHERE id=$1", [s]);
    assert.equal((await t.app.inject({ url: '/api/v1/uploads/' + id })).statusCode, 404);
  } finally {
    await t.close();
  }
});

test('avatar attachment enforces ownership and server responds with nosniff', async () => {
  const t = await createTestApp();
  try {
    const a = await registerUser(t.app),
      b = await registerUser(t.app);
    const form = multipart(await png());
    const up = await t.app.inject({
      method: 'POST',
      url: '/api/v1/uploads?kind=avatar',
      headers: { ...form.headers, ...bearer(a.token) },
      payload: form.payload,
    });
    assert.equal(up.statusCode, 201, up.body);
    const id = up.json().data.id;
    assert.equal(
      (
        await t.app.inject({
          method: 'PATCH',
          url: '/api/v1/me/profile',
          headers: bearer(b.token),
          payload: { avatarId: id },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await t.app.inject({
          method: 'PATCH',
          url: '/api/v1/me/profile',
          headers: bearer(a.token),
          payload: { avatarId: id },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await t.app.inject({
          method: 'DELETE',
          url: '/api/v1/uploads/' + id,
          headers: bearer(a.token),
        })
      ).statusCode,
      409,
    );
    const read = await t.app.inject({ url: '/api/v1/uploads/' + id, headers: bearer(a.token) });
    assert.equal(read.headers['x-content-type-options'], 'nosniff');
  } finally {
    await t.close();
  }
});

test('store owners can read admin-assigned draft images without exposing them to other accounts', async () => {
  const t = await createTestApp();
  try {
    const admin = await adminUser(t.app, t.db);
    const seller = await registerUser(t.app);
    const stranger = await registerUser(t.app);
    const form = multipart(await png());
    const uploaded = await t.app.inject({
      method: 'POST',
      url: '/api/v1/uploads?kind=product',
      headers: { ...form.headers, ...bearer(admin.token) },
      payload: form.payload,
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const imageId = uploaded.json().data.id;
    const shop = (await t.db.one(
      "INSERT INTO shops(owner_id,name,email,description,status) VALUES($1,'Managed shop','store@example.test','Test shop','approved') RETURNING id",
      [seller.user.id],
    ))!;
    await t.db.query("UPDATE users SET role='seller' WHERE id=$1", [seller.user.id]);
    const category = (await t.db.one(
      "INSERT INTO categories(name) VALUES('Draft category') RETURNING id",
    ))!;
    const product = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      headers: bearer(admin.token),
      payload: {
        shopId: shop.id,
        categoryId: category.id,
        name: 'Private draft',
        priceCents: 5000,
        stock: 3,
        imageId,
        active: false,
      },
    });
    assert.equal(product.statusCode, 201, product.body);
    const own = await t.app.inject({
      url: '/api/v1/uploads/' + imageId,
      headers: bearer(seller.token),
    });
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(own.headers['cache-control'], 'private, no-store');
    for (const headers of [{}, bearer(stranger.token)])
      assert.equal(
        (await t.app.inject({ url: '/api/v1/uploads/' + imageId, headers })).statusCode,
        404,
      );
    await t.db.query("UPDATE shops SET status='suspended' WHERE id=$1", [shop.id]);
    assert.equal(
      (await t.app.inject({ url: '/api/v1/uploads/' + imageId, headers: bearer(seller.token) }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await t.app.inject({
          method: 'DELETE',
          url: '/api/v1/uploads/' + imageId,
          headers: bearer(seller.token),
        })
      ).statusCode,
      404,
    );
  } finally {
    await t.close();
  }
});
