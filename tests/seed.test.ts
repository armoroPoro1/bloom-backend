import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, bearer } from './helpers.js';
import { seedDevelopment, seedId, runSeed } from '../scripts/seed.js';

test('development seed is idempotent, preserves edited records and passwords, and supports real login', async () => {
  const t = await createTestApp();
  try {
    const first = await seedDevelopment(t.db, 'Seed-only-test-password-123');
    assert.equal(first.created.users, 7);
    assert.equal(first.created.products, 12);
    const id = seedId(1, 1);
    const before = (await t.db.one('SELECT password_hash FROM users WHERE id=$1', [id]))!
      .password_hash;
    await t.db.query('UPDATE users SET name=$1 WHERE id=$2', ['Edited customer', id]);
    await t.db.query('UPDATE products SET price_cents=12345,stock=7 WHERE id=$1', [seedId(4, 1)]);
    const second = await seedDevelopment(t.db, 'Different-seed-password-456');
    assert.deepEqual(second.created, {});
    const user = (await t.db.one('SELECT name,password_hash FROM users WHERE id=$1', [id]))!;
    assert.equal(user.name, 'Edited customer');
    assert.equal(user.password_hash, before);
    const product = (await t.db.one('SELECT price_cents,stock FROM products WHERE id=$1', [
      seedId(4, 1),
    ]))!;
    assert.equal(product.price_cents, 12345);
    assert.equal(product.stock, 7);
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'buyer@bloom.example.test', password: 'Seed-only-test-password-123' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const token = login.json().data.accessToken;
    assert.equal(
      (await t.app.inject({ url: '/api/v1/me/addresses', headers: bearer(token) })).json().data
        .length,
      1,
    );
    const catalog = await t.app.inject({ url: '/api/v1/products' });
    assert.equal(catalog.statusCode, 200, catalog.body);
    assert.equal(catalog.json().data.length, 12);
    const admin = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin@bloom.example.test', password: 'Seed-only-test-password-123' },
    });
    assert.equal(admin.json().data.user.role, 'admin');
  } finally {
    await t.close();
  }
});

test('demo seed refuses production and missing or short passwords before database access', async () => {
  await assert.rejects(
    runSeed({ NODE_ENV: 'production', SEED_DEMO_PASSWORD: 'A-valid-long-password' }),
    /disabled in production/,
  );
  await assert.rejects(runSeed({ NODE_ENV: 'test', SEED_DEMO_PASSWORD: 'short' }));
  await assert.rejects(runSeed({ NODE_ENV: 'test' }));
});
