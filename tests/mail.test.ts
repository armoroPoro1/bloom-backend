import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { deliverMailBatch } from '../src/core/mail.js';
import { createTestApp, registerUser } from './helpers.js';

test('an expired final mail lease becomes exhausted instead of remaining processing forever', async () => {
  const t = await createTestApp();
  try {
    await registerUser(t.app);
    await t.db.query(
      "UPDATE mail_outbox SET status='processing',attempts=5,locked_at=now()-interval '11 minutes'",
    );
    const result = await deliverMailBatch(t);
    assert.equal(result.sent, 0);
    assert.equal(result.exhausted, 1);
    const row = (await t.db.one('SELECT * FROM mail_outbox'))!;
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 5);
    assert.equal(row.locked_at, null);
    assert.equal(row.body, '');
    assert.equal((await deliverMailBatch(t)).processed, 0);

    // Existing exhausted rows from the earlier release also lose retained tokens.
    await t.db.query("UPDATE mail_outbox SET body='legacy private action token'");
    assert.equal((await deliverMailBatch(t)).exhausted, 1);
    assert.equal((await t.db.one('SELECT body FROM mail_outbox'))!.body, '');
  } finally {
    await t.close();
  }
});

test('a worker that loses its lease cannot overwrite a newer delivery outcome', async (testContext) => {
  const t = await createTestApp();
  try {
    await registerUser(t.app);
    const ctx = { ...t, config: { ...t.config, smtpUrl: 'smtp://localhost' } };
    for (const oldFails of [true, false]) {
      await t.db.query(
        "UPDATE mail_outbox SET status='pending',attempts=0,locked_at=NULL,sent_at=NULL,available_at=now(),body='private action token'",
      );
      let releaseFirst!: () => void;
      let rejectFirst!: (error: Error) => void;
      let reportStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        reportStarted = resolve;
      });
      let sends = 0;
      let closed = 0;
      const transportMock = testContext.mock.method(nodemailer, 'createTransport', () => ({
        async sendMail() {
          sends++;
          if (sends === 1) {
            reportStarted();
            await new Promise<void>((resolve, reject) => {
              releaseFirst = resolve;
              rejectFirst = reject;
            });
          } else if (!oldFails) throw new Error('Simulated new-worker delivery failure');
        },
        close() {
          closed++;
        },
      }));
      const first = deliverMailBatch(ctx, 1);
      try {
        await started;
        await t.db.query("UPDATE mail_outbox SET locked_at=now()-interval '11 minutes'");
        const newer = await deliverMailBatch(ctx, 1);
        assert.equal(newer[oldFails ? 'sent' : 'failed'], 1);
        if (oldFails) rejectFirst(new Error('Simulated delayed old-worker failure'));
        else releaseFirst();
        const older = await first;
        assert.equal(older.leaseLost, 1);
        assert.equal(older.sent, 0);
        assert.equal(older.failed, 0);
        const row = (await t.db.one('SELECT * FROM mail_outbox'))!;
        assert.equal(row.attempts, 2);
        assert.equal(row.status, oldFails ? 'sent' : 'failed');
        assert.equal(row.body, oldFails ? '' : 'private action token');
        assert.equal(closed, 2);
      } finally {
        releaseFirst?.();
        await first;
        transportMock.mock.restore();
      }
    }
  } finally {
    await t.close();
  }
});

test('mail delivery failure uses backoff and five attempts then removes retained token content', async (testContext) => {
  const t = await createTestApp();
  let sends = 0;
  testContext.mock.method(nodemailer, 'createTransport', () => ({
    async sendMail() {
      sends++;
      throw new Error('Simulated delivery failure');
    },
    close() {},
  }));
  try {
    await registerUser(t.app);
    const ctx = { ...t, config: { ...t.config, smtpUrl: 'smtp://localhost' } };
    const before = Date.now();
    const first = await deliverMailBatch(ctx);
    assert.equal(first.failed, 1);
    const afterFirst = (await t.db.one('SELECT * FROM mail_outbox'))!;
    assert.equal(afterFirst.attempts, 1);
    assert.ok(new Date(afterFirst.available_at).getTime() >= before + 29000);
    assert.ok(new Date(afterFirst.available_at).getTime() <= Date.now() + 31000);
    assert.notEqual(afterFirst.body, '');
    assert.equal((await deliverMailBatch(ctx)).processed, 0);
    for (let attempt = 2; attempt <= 5; attempt++) {
      await t.db.query("UPDATE mail_outbox SET available_at=now()-interval '1 second'");
      const result = await deliverMailBatch(ctx);
      assert.equal(result.failed, 1);
      assert.equal(result.exhausted, attempt === 5 ? 1 : 0);
    }
    const exhausted = (await t.db.one('SELECT * FROM mail_outbox'))!;
    assert.equal(exhausted.status, 'failed');
    assert.equal(exhausted.attempts, 5);
    assert.equal(exhausted.body, '');
    await t.db.query("UPDATE mail_outbox SET available_at=now()-interval '1 second'");
    assert.equal((await deliverMailBatch(ctx)).processed, 0);
    assert.equal(sends, 5);
  } finally {
    await t.close();
  }
});

test('mail shutdown lets the claimed delivery settle and stops before claiming the next message', async (testContext) => {
  const t = await createTestApp();
  const controller = new AbortController();
  let sends = 0;
  let closed = 0;
  testContext.mock.method(nodemailer, 'createTransport', () => ({
    async sendMail() {
      sends++;
      controller.abort();
    },
    close() {
      closed++;
    },
  }));
  try {
    await registerUser(t.app);
    await registerUser(t.app);
    const ctx = { ...t, config: { ...t.config, smtpUrl: 'smtp://localhost' } };
    const result = await deliverMailBatch(ctx, 20, { signal: controller.signal });
    assert.equal(result.processed, 1);
    assert.equal(result.sent, 1);
    assert.equal(sends, 1);
    assert.equal(closed, 1);
    assert.equal(
      (await t.db.one("SELECT count(*) AS total FROM mail_outbox WHERE status='pending'"))!.total,
      1,
    );
    assert.equal((await deliverMailBatch(ctx, 20, { signal: controller.signal })).processed, 0);
    assert.equal(sends, 1);
  } finally {
    await t.close();
  }
});

test('mail transport closes when the database cannot claim a message', async (testContext) => {
  const t = await createTestApp();
  let closed = 0;
  testContext.mock.method(nodemailer, 'createTransport', () => ({
    async sendMail() {
      throw new Error('Must not send');
    },
    close() {
      closed++;
    },
  }));
  try {
    const ctx = {
      ...t,
      db: {
        ...t.db,
        async transaction() {
          throw new Error('Simulated database outage');
        },
      },
      config: { ...t.config, smtpUrl: 'smtp://localhost' },
    };
    await assert.rejects(deliverMailBatch(ctx), /Simulated database outage/);
    assert.equal(closed, 1);
  } finally {
    await t.close();
  }
});
