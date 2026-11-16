import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createTestApp, registerUser, adminUser, bearer, testPassword } from './helpers.js';
import { deliverMailBatch } from '../src/core/mail.js';
import { loadConfig } from '../src/config.js';

test('registration persists salted passwords, denies privilege injection and duplicate accounts', async () => {
  const t = await createTestApp();
  try {
    const invalid = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: 'Intruder',
        email: 'intruder@example.test',
        password: testPassword,
        role: 'admin',
      },
    });
    assert.equal(invalid.statusCode, 400);
    const a = await registerUser(t.app, { email: 'Alice@Example.Test' });
    assert.equal(a.user.email, 'alice@example.test');
    assert.equal(a.user.role, 'user');
    assert.equal('passwordHash' in a.user, false);
    const row = await t.db.one('SELECT password_hash FROM users WHERE id=$1', [a.user.id]);
    assert.match(row!.password_hash, /^scrypt\$65536\$8\$1\$/);
    assert.equal(row!.password_hash.includes(testPassword), false);
    const dup = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { name: 'Other', email: 'ALICE@example.test', password: testPassword },
    });
    assert.equal(dup.statusCode, 409);
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: a.user.email, password: 'wrong-password' },
    });
    assert.equal(bad.statusCode, 401);
    const unknown = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'missing@example.test', password: 'wrong-password' },
    });
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(unknown.json().error, bad.json().error);
  } finally {
    await t.close();
  }
});

test('access sessions are hashed, rotate refresh tokens, and revoke a reused refresh session', async () => {
  const t = await createTestApp();
  try {
    const a = await registerUser(t.app);
    const stored = (await t.db.one('SELECT * FROM sessions WHERE user_id=$1', [a.user.id]))!;
    assert.notEqual(stored.access_hash, a.token);
    assert.notEqual(stored.refresh_hash, a.refreshToken);
    const refreshed = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: a.refreshToken },
    });
    assert.equal(refreshed.statusCode, 200);
    const b = refreshed.json().data;
    assert.notEqual(b.accessToken, a.token);
    assert.equal(
      (await t.app.inject({ url: '/api/v1/auth/me', headers: bearer(a.token) })).statusCode,
      401,
    );
    assert.equal(
      (await t.app.inject({ url: '/api/v1/auth/me', headers: bearer(b.accessToken) })).statusCode,
      200,
    );
    const reuse = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: a.refreshToken },
    });
    assert.equal(reuse.statusCode, 401);
    assert.equal(
      (await t.app.inject({ url: '/api/v1/auth/me', headers: bearer(b.accessToken) })).statusCode,
      401,
    );
  } finally {
    await t.close();
  }
});

test('profile patch preserves omitted fields and password change revokes every session', async () => {
  const t = await createTestApp();
  try {
    const a = await registerUser(t.app, { name: 'Original Name', phone: '0812345678' });
    const second = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: a.user.email, password: testPassword },
    });
    const b = second.json().data;
    const edit = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me/profile',
      headers: bearer(a.token),
      payload: { address: 'Shipping address' },
    });
    assert.equal(edit.statusCode, 200);
    assert.equal(edit.json().data.name, 'Original Name');
    assert.equal(edit.json().data.phone, '0812345678');
    const inject = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me/profile',
      headers: bearer(a.token),
      payload: { role: 'admin' },
    });
    assert.equal(inject.statusCode, 400);
    const change = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/change-password',
      headers: bearer(a.token),
      payload: { currentPassword: testPassword, newPassword: 'Changed-Password-1234' },
    });
    assert.equal(change.statusCode, 200);
    for (const tok of [a.token, b.accessToken])
      assert.equal(
        (await t.app.inject({ url: '/api/v1/auth/me', headers: bearer(tok) })).statusCode,
        401,
      );
    assert.equal(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: a.user.email, password: testPassword },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: a.user.email, password: 'Changed-Password-1234' },
        })
      ).statusCode,
      200,
    );
  } finally {
    await t.close();
  }
});

test('forgot-password does not reveal accounts; reset token is single-use and revokes sessions', async () => {
  const t = await createTestApp();
  try {
    const a = await registerUser(t.app);
    const yes = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: a.user.email },
    });
    const no = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: 'unknown@example.test' },
    });
    assert.deepEqual(yes.json().data, no.json().data);
    assert.equal(JSON.stringify(yes.json()).includes('token='), false);
    const mail = (await t.db.one(
      "SELECT body FROM mail_outbox WHERE recipient=$1 AND subject LIKE '%reset%'",
      [a.user.email],
    ))!;
    const tok = /token=([A-Za-z0-9_-]+)/.exec(mail.body)![1];
    const reset = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token: tok, newPassword: 'Reset-Password-1234' },
    });
    assert.equal(reset.statusCode, 200);
    assert.equal(
      (await t.app.inject({ url: '/api/v1/auth/me', headers: bearer(a.token) })).statusCode,
      401,
    );
    assert.equal(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/v1/auth/reset-password',
          payload: { token: tok, newPassword: 'Another-Password-1234' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: a.user.email, password: 'Reset-Password-1234' },
        })
      ).statusCode,
      200,
    );
  } finally {
    await t.close();
  }
});

test('email verification and change-email require the right token/password and invalidate old identity sessions', async () => {
  const t = await createTestApp();
  try {
    const a = await registerUser(t.app);
    let mail = (await t.db.one(
      "SELECT body FROM mail_outbox WHERE recipient=$1 AND subject LIKE '%verify%'",
      [a.user.email],
    ))!;
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.body)![1];
    assert.equal(
      (await t.app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { token } }))
        .statusCode,
      200,
    );
    assert.equal(
      (await t.app.inject({ url: '/api/v1/auth/me', headers: bearer(a.token) })).json().data
        .emailVerified,
      true,
    );
    const denied = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/change-email',
      headers: bearer(a.token),
      payload: { email: 'new@example.test', currentPassword: 'wrong-password' },
    });
    assert.equal(denied.statusCode, 400);
    const changed = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/change-email',
      headers: bearer(a.token),
      payload: { email: 'new@example.test', currentPassword: testPassword },
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(
      (await t.app.inject({ url: '/api/v1/auth/me', headers: bearer(a.token) })).statusCode,
      401,
    );
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'new@example.test', password: testPassword },
    });
    assert.equal(login.statusCode, 200);
    assert.equal(login.json().data.user.emailVerified, false);
  } finally {
    await t.close();
  }
});

test('logout, blocked accounts and expired access tokens cannot call protected routes', async () => {
  const t = await createTestApp();
  try {
    const a = await registerUser(t.app);
    assert.equal(
      (await t.app.inject({ url: '/api/v1/admin/users', headers: bearer(a.token) })).statusCode,
      403,
    );
    await t.db.query('UPDATE users SET blocked=true WHERE id=$1', [a.user.id]);
    assert.equal(
      (await t.app.inject({ url: '/api/v1/auth/me', headers: bearer(a.token) })).statusCode,
      401,
    );
    await t.db.query('UPDATE users SET blocked=false WHERE id=$1', [a.user.id]);
    await t.db.query(
      "UPDATE sessions SET access_expires_at=now()-interval '1 second' WHERE user_id=$1",
      [a.user.id],
    );
    assert.equal(
      (await t.app.inject({ url: '/api/v1/auth/me', headers: bearer(a.token) })).statusCode,
      401,
    );
    const fresh = (
      await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: a.refreshToken },
      })
    ).json().data;
    assert.equal(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/v1/auth/logout',
          headers: bearer(fresh.accessToken),
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await t.app.inject({ url: '/api/v1/auth/me', headers: bearer(fresh.accessToken) }))
        .statusCode,
      401,
    );
  } finally {
    await t.close();
  }
});

test('local mail worker writes development mail, marks delivery and removes queued secret content', async () => {
  const t = await createTestApp();
  try {
    const a = await registerUser(t.app);
    const result = await deliverMailBatch(t);
    assert.equal(result.sent, 1);
    const files = await readdir(t.config.mailDir);
    assert.equal(files.length, 1);
    const message = JSON.parse(await readFile(t.config.mailDir + '/' + files[0], 'utf8'));
    assert.equal(message.to, a.user.email);
    assert.match(message.body, /#token=/);
    const record = (await t.db.one('SELECT status,body FROM mail_outbox'))!;
    assert.equal(record.status, 'sent');
    assert.equal(record.body, '');
    assert.equal((await deliverMailBatch(t)).processed, 0);
  } finally {
    await t.close();
  }
});

test('readiness and OpenAPI expose implemented contracts without enabling untrusted CORS', async () => {
  const t = await createTestApp();
  try {
    const a = await registerUser(t.app);
    const health = await t.app.inject({ url: '/ready' });
    assert.equal(health.statusCode, 200);
    const spec = t.app.swagger() as any;
    assert.equal(spec.openapi, '3.1.0');
    assert.ok(spec.paths['/api/v1/auth/register'].post.requestBody);
    assert.ok(
      spec.paths['/api/v1/checkout'].post.parameters.some((p: any) => p.name === 'idempotency-key'),
    );
    assert.equal(
      (await t.db.one('SELECT name FROM users WHERE id=$1', [a.user.id]))!.name,
      a.user.name,
    );
    assert.equal((await t.app.inject({ url: '/docs/' })).statusCode, 200);
    const noCors = await t.app.inject({
      url: '/health',
      headers: { origin: 'https://untrusted.example' },
    });
    assert.equal(noCors.headers['access-control-allow-origin'], undefined);
  } finally {
    await t.close();
  }
});

test('production configuration rejects local DB, insecure URLs and development money actions', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /PostgreSQL/);
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://user:pass@localhost/db',
        ALLOW_DEV_PAYMENTS: 'true',
      }),
    /Development payments/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://user:pass@localhost/db',
      }),
    /HTTPS/,
  );
});

test('refresh preserves absolute expiry and expired replay tombstones cannot revoke an active session', async () => {
  const t = await createTestApp();
  try {
    const a = await registerUser(t.app);
    const before = (await t.db.one('SELECT refresh_expires_at FROM sessions WHERE user_id=$1', [
      a.user.id,
    ]))!.refresh_expires_at;
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: a.refreshToken },
    });
    assert.equal(r.statusCode, 200);
    const next = r.json().data;
    const after = (await t.db.one('SELECT refresh_expires_at FROM sessions WHERE user_id=$1', [
      a.user.id,
    ]))!.refresh_expires_at;
    assert.equal(new Date(after).toISOString(), new Date(before).toISOString());
    await t.db.query("UPDATE used_refresh_tokens SET expires_at=now()-interval '1 second'");
    assert.equal(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/v1/auth/refresh',
          payload: { refreshToken: a.refreshToken },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await t.app.inject({ url: '/api/v1/auth/me', headers: bearer(next.accessToken) }))
        .statusCode,
      200,
    );
  } finally {
    await t.close();
  }
});

test('authentication rate limits return 429 with retry guidance instead of an internal error', async () => {
  const t = await createTestApp();
  try {
    for (let index = 0; index < 5; index++) {
      const allowed = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        payload: { email: 'unknown-limit@example.test' },
      });
      assert.equal(allowed.statusCode, 200, allowed.body);
    }
    const limited = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: 'unknown-limit@example.test' },
    });
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.json().error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers['retry-after']) > 0);
  } finally {
    await t.close();
  }
});
