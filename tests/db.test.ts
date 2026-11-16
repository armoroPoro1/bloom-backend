import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createDatabase, migrate } from '../src/core/db.js';
import { createTestApp, registerUser, bearer } from './helpers.js';

test('SQL migration is idempotent, transaction failures roll back, and file database survives reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bloom-persistence-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_DRIVER: 'pglite',
    PGLITE_DIR: join(dir, 'db'),
    LOG_LEVEL: 'silent',
  });
  let db = await createDatabase(config);
  try {
    const first = await migrate(db);
    assert.ok(first.length >= 4);
    await migrate(db);
    assert.equal(
      Number((await db.one('SELECT count(*) AS n FROM schema_migrations'))!.n),
      first.length,
    );
    await db.query("INSERT INTO settings(key,value) VALUES('persistence-test',$1)", [
      JSON.stringify({ hello: 'world' }),
    ]);
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query("UPDATE settings SET value=$1 WHERE key='persistence-test'", [
          JSON.stringify({ hello: 'changed' }),
        ]);
        throw new Error('Force rollback');
      }),
      /Force rollback/,
    );
    assert.equal(
      (await db.one("SELECT value FROM settings WHERE key='persistence-test'"))!.value.hello,
      'world',
    );
    await db.close();
    db = await createDatabase(config);
    assert.equal(
      (await db.one("SELECT value FROM settings WHERE key='persistence-test'"))!.value.hello,
      'world',
    );
    await migrate(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('notifications are scoped to the authenticated user and read operations are idempotent', async () => {
  const t = await createTestApp();
  try {
    const a = await registerUser(t.app),
      b = await registerUser(t.app);
    const n = (await t.db.one(
      "INSERT INTO notifications(user_id,title,message) VALUES($1,'Order update','Your order changed') RETURNING id",
      [a.user.id],
    ))!;
    assert.equal(
      (await t.app.inject({ url: '/api/v1/me/notifications', headers: bearer(a.token) })).json()
        .data.length,
      1,
    );
    assert.equal(
      (await t.app.inject({ url: '/api/v1/me/notifications', headers: bearer(b.token) })).json()
        .data.length,
      0,
    );
    await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me/notifications/' + n.id + '/read',
      headers: bearer(b.token),
    });
    assert.equal(
      (await t.db.one('SELECT read_at FROM notifications WHERE id=$1', [n.id]))!.read_at,
      null,
    );
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await t.app.inject({
            method: 'PATCH',
            url: '/api/v1/me/notifications/' + n.id + '/read',
            headers: bearer(a.token),
          })
        ).statusCode,
        200,
      );
    assert.equal(
      (
        await t.app.inject({
          url: '/api/v1/me/notifications?unread=true',
          headers: bearer(a.token),
        })
      ).json().data.length,
      0,
    );
  } finally {
    await t.close();
  }
});
