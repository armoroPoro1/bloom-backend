import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createTestApp } from './helpers.js';

test('trusted proxy configuration accepts explicit peers and rejects broad or ambiguous trust', () => {
  const defaults = loadConfig({ NODE_ENV: 'test' });
  assert.deepEqual(defaults.trustedProxyCidrs, []);
  assert.equal(defaults.backgroundJobs, true);
  assert.equal(defaults.mailIntervalSeconds, 10);
  assert.equal(defaults.maintenanceIntervalSeconds, 60);
  assert.deepEqual(
    loadConfig({ TRUST_PROXY_CIDRS: '127.0.0.1/32, ::1/128, 10.20.0.0/24, 127.0.0.1/32' })
      .trustedProxyCidrs,
    ['127.0.0.1/32', '::1/128', '10.20.0.0/24'],
  );
  for (const value of [
    'true',
    '*',
    '1',
    'localhost',
    '0.0.0.0/0',
    '::/0',
    '127.0.0.1/33',
    '::1/129',
    '127.0.0.1/-1',
    '127.0.0.1/32/1',
  ])
    assert.throws(() => loadConfig({ TRUST_PROXY_CIDRS: value }), /TRUST_PROXY_CIDRS/);
  assert.throws(() => loadConfig({ BACKGROUND_JOBS: 'yes' }));
  assert.throws(() => loadConfig({ MAIL_INTERVAL_SECONDS: '0' }));
  assert.throws(() => loadConfig({ MAINTENANCE_INTERVAL_SECONDS: '4' }));
});

test('default rate limiting ignores forged forwarded addresses', async () => {
  const t = await createTestApp();
  try {
    for (let i = 1; i <= 13; i++) {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '198.51.100.9',
        headers: { 'x-forwarded-for': '203.0.113.' + i },
        payload: {},
      });
      assert.equal(response.statusCode, i <= 12 ? 400 : 429, response.body);
    }
  } finally {
    await t.close();
  }
});

test('only an explicitly trusted direct proxy can supply a rate-limit client address', async () => {
  const t = await createTestApp({ trustedProxyCidrs: ['127.0.0.1/32'] });
  try {
    for (let i = 1; i <= 13; i++) {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.' + i },
        payload: {},
      });
      assert.equal(response.statusCode, 400, response.body);
    }
    for (let i = 1; i <= 13; i++) {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '192.0.2.55' },
        payload: {},
      });
      assert.equal(response.statusCode, i <= 12 ? 400 : 429, response.body);
    }
    for (let i = 1; i <= 13; i++) {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '198.51.100.9',
        headers: { 'x-forwarded-for': '203.0.113.' + (i + 30) },
        payload: {},
      });
      assert.equal(response.statusCode, i <= 12 ? 400 : 429, response.body);
    }
  } finally {
    await t.close();
  }
});
