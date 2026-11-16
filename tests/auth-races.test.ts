import test from 'node:test';
import assert from 'node:assert/strict';
import type { Row } from '../src/core/contracts.js';
import { createTestApp, registerUser, bearer, testPassword } from './helpers.js';

test('an in-flight email change cannot overwrite a newer identity that revoked its session', async () => {
  const t = await createTestApp();
  const originalOne = t.db.one.bind(t.db);
  try {
    const user = await registerUser(t.app);
    let interleaved = false;
    t.db.one = async <T extends Row = Row>(sql: string, params: unknown[] = []) => {
      const row = await originalOne<T>(sql, params);
      if (!interleaved && sql === 'SELECT * FROM users WHERE id=$1' && params[0] === user.user.id) {
        interleaved = true;
        const newer = await t.app.inject({
          method: 'POST',
          url: '/api/v1/me/change-email',
          headers: bearer(user.token),
          payload: { email: 'newer-identity@example.test', currentPassword: testPassword },
        });
        assert.equal(newer.statusCode, 200, newer.body);
      }
      return row;
    };
    const stale = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/change-email',
      headers: bearer(user.token),
      payload: { email: 'stale-identity@example.test', currentPassword: testPassword },
    });
    assert.equal(stale.statusCode, 401, stale.body);
    assert.equal(stale.json().error.code, 'INVALID_SESSION');
    assert.equal(
      (await originalOne('SELECT email FROM users WHERE id=$1', [user.user.id]))!.email,
      'newer-identity@example.test',
    );
    assert.equal(
      (await originalOne(
        "SELECT count(*) AS total FROM audit_events WHERE action='account.email_changed' AND entity_id=$1",
        [user.user.id],
      ))!.total,
      1,
    );
  } finally {
    t.db.one = originalOne;
    await t.close();
  }
});

test('password changes recheck logout and blocked state after expensive password work', async () => {
  const t = await createTestApp();
  const originalOne = t.db.one.bind(t.db);
  try {
    for (const scenario of ['logout', 'blocked'] as const) {
      const user = await registerUser(t.app);
      const originalHash = (await originalOne('SELECT password_hash FROM users WHERE id=$1', [
        user.user.id,
      ]))!.password_hash;
      let interleaved = false;
      t.db.one = async <T extends Row = Row>(sql: string, params: unknown[] = []) => {
        const row = await originalOne<T>(sql, params);
        if (
          !interleaved &&
          sql === 'SELECT password_hash,email FROM users WHERE id=$1' &&
          params[0] === user.user.id
        ) {
          interleaved = true;
          if (scenario === 'logout') {
            const logout = await t.app.inject({
              method: 'POST',
              url: '/api/v1/auth/logout-all',
              headers: bearer(user.token),
            });
            assert.equal(logout.statusCode, 200, logout.body);
          } else await t.db.query('UPDATE users SET blocked=true WHERE id=$1', [user.user.id]);
        }
        return row;
      };
      const stale = await t.app.inject({
        method: 'POST',
        url: '/api/v1/me/change-password',
        headers: bearer(user.token),
        payload: { currentPassword: testPassword, newPassword: 'Should-not-commit-1234' },
      });
      assert.equal(stale.statusCode, 401, scenario + ': ' + stale.body);
      assert.equal(
        (await originalOne('SELECT password_hash FROM users WHERE id=$1', [user.user.id]))!
          .password_hash,
        originalHash,
      );
      assert.equal(
        (await originalOne(
          "SELECT count(*) AS total FROM audit_events WHERE action='account.password_changed' AND entity_id=$1",
          [user.user.id],
        ))!.total,
        0,
      );
      t.db.one = originalOne;
    }
  } finally {
    t.db.one = originalOne;
    await t.close();
  }
});

test('a rotated access token cannot finish an already-started sensitive password change', async () => {
  const t = await createTestApp();
  const originalOne = t.db.one.bind(t.db);
  try {
    const user = await registerUser(t.app);
    let currentToken = '';
    let interleaved = false;
    t.db.one = async <T extends Row = Row>(sql: string, params: unknown[] = []) => {
      const row = await originalOne<T>(sql, params);
      if (
        !interleaved &&
        sql === 'SELECT password_hash,email FROM users WHERE id=$1' &&
        params[0] === user.user.id
      ) {
        interleaved = true;
        const refresh = await t.app.inject({
          method: 'POST',
          url: '/api/v1/auth/refresh',
          payload: { refreshToken: user.refreshToken },
        });
        assert.equal(refresh.statusCode, 200, refresh.body);
        currentToken = refresh.json().data.accessToken;
      }
      return row;
    };
    const stale = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/change-password',
      headers: bearer(user.token),
      payload: { currentPassword: testPassword, newPassword: 'Should-not-commit-1234' },
    });
    assert.equal(stale.statusCode, 401, stale.body);
    assert.equal(
      (await t.app.inject({ url: '/api/v1/auth/me', headers: bearer(currentToken) })).statusCode,
      200,
    );
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.user.email, password: testPassword },
    });
    assert.equal(login.statusCode, 200, login.body);
  } finally {
    t.db.one = originalOne;
    await t.close();
  }
});
