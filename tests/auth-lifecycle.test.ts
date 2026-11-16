import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, registerUser, bearer, testPassword } from './helpers.js';
import { loadConfig } from '../src/config.js';
import type { Row } from '../src/core/contracts.js';

test('refresh advertises only the remaining absolute session lifetime', async () => {
  const t = await createTestApp();
  try {
    const user = await registerUser(t.app);
    await t.db.query(
      "UPDATE sessions SET refresh_expires_at=now()+interval '65 seconds' WHERE user_id=$1",
      [user.user.id],
    );
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.json().data.expiresIn > 0);
    assert.ok(response.json().data.expiresIn <= 65);
    const session = (await t.db.one(
      'SELECT access_expires_at,refresh_expires_at FROM sessions WHERE user_id=$1',
      [user.user.id],
    ))!;
    assert.ok(
      new Date(session.access_expires_at).getTime() <=
        new Date(session.refresh_expires_at).getTime(),
    );
    assert.equal(
      (
        await t.app.inject({
          url: '/api/v1/auth/me',
          headers: bearer(response.json().data.accessToken),
        })
      ).statusCode,
      200,
    );
  } finally {
    await t.close();
  }
});

test('an in-flight login cannot authenticate with an email changed before session issuance', async () => {
  const t = await createTestApp();
  try {
    const user = await registerUser(t.app);
    const nextEmail = 'changed-before-login@example.test';
    const originalOne = t.db.one.bind(t.db);
    let interleaved = false;
    // Keep real SQL and password verification, but deterministically interleave
    // an email change after the login read and before its session transaction.
    t.db.one = async <T extends Row = Row>(sql: string, params: unknown[] = []) => {
      const result = await originalOne<T>(sql, params);
      if (
        !interleaved &&
        sql === 'SELECT * FROM users WHERE email=$1' &&
        params[0] === user.user.email
      ) {
        interleaved = true;
        await t.db.transaction(async (tx) => {
          await tx.query('UPDATE users SET email=$1,email_verified=false WHERE id=$2', [
            nextEmail,
            user.user.id,
          ]);
          await tx.query('DELETE FROM sessions WHERE user_id=$1', [user.user.id]);
        });
      }
      return result;
    };
    const stale = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.user.email, password: testPassword },
    });
    assert.equal(interleaved, true);
    assert.equal(stale.statusCode, 401, stale.body);
    assert.equal(
      (await t.db.one('SELECT count(*) AS total FROM sessions WHERE user_id=$1', [user.user.id]))!
        .total,
      0,
    );
    const current = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: nextEmail, password: testPassword },
    });
    assert.equal(current.statusCode, 200, current.body);
  } finally {
    await t.close();
  }
});

test('account responses prevent caching and expose browser-readable request and retry headers', async () => {
  const t = await createTestApp();
  try {
    const user = await registerUser(t.app);
    for (const url of ['/api/v1/auth/me', '/api/v1/me/notifications']) {
      const response = await t.app.inject({
        url,
        headers: { ...bearer(user.token), origin: 'http://localhost:5173' },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.ok(response.headers['x-request-id']);
      assert.match(String(response.headers['access-control-expose-headers']), /Retry-After/i);
      assert.match(
        String(response.headers['access-control-expose-headers']),
        /Content-Disposition/i,
      );
    }
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.user.email, password: testPassword },
    });
    assert.equal(login.headers['cache-control'], 'private, no-store');
    const rejected = await t.app.inject({
      url: '/api/v1/me/notifications?unread=wrong',
      headers: bearer(user.token),
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.headers['cache-control'], 'private, no-store');
    const operation = (t.app.swagger() as any).paths['/api/v1/me/notifications'].get;
    assert.ok(operation.parameters.some((parameter: any) => parameter.name === 'unread'));
    assert.ok(operation.parameters.some((parameter: any) => parameter.name === 'limit'));
    const mail = (await t.db.one('SELECT body FROM mail_outbox WHERE recipient=$1', [
      user.user.email,
    ]))!;
    assert.match(mail.body, /24 ชั่วโมง/);
    assert.doesNotMatch(mail.body, /integration|documented API/i);
  } finally {
    await t.close();
  }
});

test('readiness rejects a missing or changed schema while process liveness stays available', async () => {
  const t = await createTestApp();
  try {
    assert.equal((await t.app.inject({ url: '/ready' })).statusCode, 200);
    const migration = (await t.db.one(
      'SELECT name,checksum FROM schema_migrations ORDER BY name LIMIT 1',
    ))!;
    await t.db.query("UPDATE schema_migrations SET checksum='changed' WHERE name=$1", [
      migration.name,
    ]);
    const mismatch = await t.app.inject({ url: '/ready' });
    assert.equal(mismatch.statusCode, 503);
    assert.equal(mismatch.json().error.code, 'NOT_READY');
    assert.equal(JSON.stringify(mismatch.json()).includes(migration.name), false);
    await t.db.query('UPDATE schema_migrations SET checksum=$1 WHERE name=$2', [
      migration.checksum,
      migration.name,
    ]);
    assert.equal((await t.app.inject({ url: '/ready' })).statusCode, 200);
    await t.db.query('DELETE FROM schema_migrations WHERE name=$1', [migration.name]);
    assert.equal((await t.app.inject({ url: '/ready' })).statusCode, 503);
    await t.db.exec('DROP TABLE schema_migrations');
    assert.equal((await t.app.inject({ url: '/ready' })).statusCode, 503);
    assert.equal((await t.app.inject({ url: '/health' })).statusCode, 200);
  } finally {
    await t.close();
  }
});

test('configuration rejects unusable email links, SMTP URLs and payment reservation windows', () => {
  for (const env of [
    { FRONTEND_URL: 'ftp://example.test' },
    { FRONTEND_URL: 'https://example.test/#token=wrong' },
    { PUBLIC_BASE_URL: 'https://user:password@example.test' },
    { SMTP_URL: 'invalid-smtp' },
    { SMTP_URL: 'https://smtp.example.test' },
    { SMTP_URL: 'smtp://mail.example.test/unexpected/path' },
    { PAYMENT_RESERVATION_MINUTES: '4' },
    { PAYMENT_RESERVATION_MINUTES: '10081' },
  ])
    assert.throws(() => loadConfig(env));
  const valid = loadConfig({
    FRONTEND_URL: 'https://example.test/app',
    SMTP_URL: 'smtps://mailer:secret@mail.example.test:465',
    PAYMENT_RESERVATION_MINUTES: '60',
  });
  assert.equal(valid.paymentReservationMinutes, 60);
});
