import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import nodemailer from 'nodemailer';
import { startBackgroundJobs, type BackgroundEvent } from '../src/core/background.js';
import { createTestApp, registerUser } from './helpers.js';

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'Background work did not complete before the test deadline');
    await delay(25);
  }
}

async function expiredOrder(t: Awaited<ReturnType<typeof createTestApp>>, buyerId: string) {
  const seller = randomUUID(),
    shop = randomUUID(),
    category = randomUUID(),
    product = randomUUID(),
    checkout = randomUUID(),
    order = randomUUID();
  await t.db.query(
    "INSERT INTO users(id,name,email,password_hash,role) VALUES($1,'Worker fixture seller',$2,'unused-fixture-hash','seller')",
    [seller, seller + '@example.test'],
  );
  await t.db.query(
    "INSERT INTO shops(id,owner_id,name,email,description,status) VALUES($1,$2,'Worker shop','shop@example.test','Fixture shop','approved')",
    [shop, seller],
  );
  await t.db.query("INSERT INTO categories(id,name) VALUES($1,'Worker category')", [category]);
  await t.db.query(
    "INSERT INTO products(id,shop_id,category_id,name,price_cents,stock) VALUES($1,$2,$3,'Reserved product',10000,7)",
    [product, shop, category],
  );
  await t.db.query('INSERT INTO checkout_groups(id,buyer_id) VALUES($1,$2)', [checkout, buyerId]);
  await t.db.query(
    "INSERT INTO orders(id,number,checkout_id,buyer_id,shop_id,status,payment_status,payment_method,address_snapshot,subtotal_cents,shipping_cents,discount_cents,total_cents,payment_due_at) VALUES($1,$2,$3,$4,$5,'pending','unpaid','transfer','{}',30000,0,0,30000,now()-interval '1 minute')",
    [order, 'WORKER-' + order, checkout, buyerId, shop],
  );
  await t.db.query(
    "INSERT INTO order_items(order_id,product_id,name,unit_price_cents,quantity) VALUES($1,$2,'Reserved product',10000,3)",
    [order, product],
  );
  return { order, product };
}

test('automatic jobs share the API database and deliver mail, expire stock, remove files and clean retention', async () => {
  const t = await createTestApp({ mailIntervalSeconds: 1, maintenanceIntervalSeconds: 5 });
  let jobs: ReturnType<typeof startBackgroundJobs> | undefined;
  try {
    const buyer = await registerUser(t.app);
    const pendingMail = (await t.db.one("SELECT id FROM mail_outbox WHERE status='pending'"))!;
    const { order, product } = await expiredOrder(t, buyer.user.id);
    await t.db.query("UPDATE account_tokens SET expires_at=now()-interval '1 minute'");
    await t.db.query(
      "INSERT INTO sessions(user_id,access_hash,refresh_hash,access_expires_at,refresh_expires_at) VALUES($1,'expired-access','expired-refresh',now()-interval '2 days',now()-interval '1 day')",
      [buyer.user.id],
    );
    await t.db.query(
      "INSERT INTO mail_outbox(recipient,subject,body,status,sent_at) VALUES('old@example.test','Old sent mail','','sent',now()-interval '31 days')",
    );
    await t.db.query(
      "INSERT INTO auth_attempts(identifier_hash,failures,window_started) VALUES('old-counter',1,now()-interval '2 days')",
    );
    const upload = randomUUID(),
      key = upload + '.webp';
    await mkdir(t.config.uploadDir, { recursive: true });
    await writeFile(join(t.config.uploadDir, key), 'Previously deleted upload fixture');
    await t.db.query('INSERT INTO upload_deletion_jobs(id,storage_key) VALUES($1,$2)', [
      upload,
      key,
    ]);
    const events: BackgroundEvent[] = [];
    jobs = startBackgroundJobs(t, {
      onEvent: (event) => {
        events.push(event);
      },
    });
    await until(() =>
      ['mail', 'maintenance'].every((job) =>
        events.some((event) => event.job === job && event.status === 'completed'),
      ),
    );
    await jobs.stop();
    await jobs.stop();
    assert.equal(
      events.some((event) => event.status === 'failed'),
      false,
      JSON.stringify(events),
    );
    const sent = (await t.db.one('SELECT status,body FROM mail_outbox WHERE id=$1', [
      pendingMail.id,
    ]))!;
    assert.equal(sent.status, 'sent');
    assert.equal(sent.body, '');
    const localMessage = JSON.parse(
      await readFile(join(t.config.mailDir, pendingMail.id + '.json'), 'utf8'),
    );
    assert.equal(localMessage.to, buyer.user.email);
    assert.ok(localMessage.body.includes(t.config.frontendUrl));
    const expired = (await t.db.one('SELECT status,stock_released FROM orders WHERE id=$1', [
      order,
    ]))!;
    assert.equal(expired.status, 'cancelled');
    assert.equal(expired.stock_released, true);
    assert.equal((await t.db.one('SELECT stock FROM products WHERE id=$1', [product]))!.stock, 10);
    assert.equal(Number((await t.db.one('SELECT count(*) AS n FROM upload_deletion_jobs'))!.n), 0);
    await assert.rejects(stat(join(t.config.uploadDir, key)), { code: 'ENOENT' });
    assert.equal(Number((await t.db.one('SELECT count(*) AS n FROM account_tokens'))!.n), 0);
    assert.equal(
      Number(
        (await t.db.one('SELECT count(*) AS n FROM sessions WHERE refresh_expires_at<now()'))!.n,
      ),
      0,
    );
    assert.equal(
      Number(
        (await t.db.one(
          "SELECT count(*) AS n FROM auth_attempts WHERE identifier_hash='old-counter'",
        ))!.n,
      ),
      0,
    );
    assert.equal(
      Number(
        (await t.db.one(
          "SELECT count(*) AS n FROM mail_outbox WHERE recipient='old@example.test'",
        ))!.n,
      ),
      0,
    );
    // Shutdown must leave future work durable for the next process.
    await registerUser(t.app);
    await delay(1100);
    assert.equal(
      Number((await t.db.one("SELECT count(*) AS n FROM mail_outbox WHERE status='pending'"))!.n),
      1,
    );
  } finally {
    await jobs?.stop();
    await t.close();
  }
});

test('BACKGROUND_JOBS=false leaves queued work untouched for an external worker', async () => {
  const t = await createTestApp({ backgroundJobs: false, mailIntervalSeconds: 1 });
  let jobs: ReturnType<typeof startBackgroundJobs> | undefined;
  try {
    await registerUser(t.app);
    const events: BackgroundEvent[] = [];
    jobs = startBackgroundJobs(t, {
      onEvent: (event) => {
        events.push(event);
      },
    });
    await delay(1100);
    assert.deepEqual(events, []);
    assert.equal((await t.db.one('SELECT status,attempts FROM mail_outbox'))!.status, 'pending');
    assert.equal((await t.db.one('SELECT attempts FROM mail_outbox'))!.attempts, 0);
  } finally {
    await jobs?.stop();
    await t.close();
  }
});

test('background jobs wait for matching migration checksums and recover on the next tick', async () => {
  const t = await createTestApp({ mailIntervalSeconds: 1, maintenanceIntervalSeconds: 5 });
  let jobs: ReturnType<typeof startBackgroundJobs> | undefined;
  try {
    await registerUser(t.app);
    const migration = (await t.db.one(
      'SELECT * FROM schema_migrations ORDER BY name DESC LIMIT 1',
    ))!;
    await t.db.query("UPDATE schema_migrations SET checksum='mismatch' WHERE name=$1", [
      migration.name,
    ]);
    const events: BackgroundEvent[] = [];
    jobs = startBackgroundJobs(t, {
      onEvent: (event) => {
        events.push(event);
      },
    });
    await until(() =>
      ['mail', 'maintenance'].every((job) =>
        events.some((event) => event.job === job && event.status === 'not_ready'),
      ),
    );
    assert.equal((await t.db.one('SELECT status FROM mail_outbox'))!.status, 'pending');
    await t.db.query('UPDATE schema_migrations SET checksum=$1 WHERE name=$2', [
      migration.checksum,
      migration.name,
    ]);
    await until(() => events.some((event) => event.job === 'mail' && event.status === 'completed'));
    assert.equal((await t.db.one('SELECT status FROM mail_outbox'))!.status, 'sent');
  } finally {
    await jobs?.stop();
    await t.close();
  }
});

test('slow background delivery cannot overlap and shutdown waits for the claimed delivery', async (testContext) => {
  const t = await createTestApp({ mailIntervalSeconds: 1, maintenanceIntervalSeconds: 5 });
  let jobs: ReturnType<typeof startBackgroundJobs> | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sends = 0,
    closed = 0;
  testContext.mock.method(nodemailer, 'createTransport', () => ({
    async sendMail() {
      sends++;
      await gate;
    },
    close() {
      closed++;
    },
  }));
  try {
    await registerUser(t.app);
    await registerUser(t.app);
    jobs = startBackgroundJobs({ ...t, config: { ...t.config, smtpUrl: 'smtp://localhost' } });
    await until(() => sends === 1);
    await delay(1100);
    assert.equal(sends, 1);
    let stopped = false;
    const stopping = jobs.stop().then(() => {
      stopped = true;
    });
    await delay(25);
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(sends, 1);
    assert.equal(closed, 1);
    assert.equal(
      Number((await t.db.one("SELECT count(*) AS n FROM mail_outbox WHERE status='sent'"))!.n),
      1,
    );
    assert.equal(
      Number((await t.db.one("SELECT count(*) AS n FROM mail_outbox WHERE status='pending'"))!.n),
      1,
    );
  } finally {
    release();
    await jobs?.stop();
    await t.close();
  }
});
