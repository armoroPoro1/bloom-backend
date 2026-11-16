import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, unlink, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Row } from '../src/core/contracts.js';
import { processUploadDeletionBatch } from '../src/core/upload-cleanup.js';
import { createTestApp, registerUser, bearer } from './helpers.js';

async function unusedUpload(t: Awaited<ReturnType<typeof createTestApp>>) {
  const owner = await registerUser(t.app);
  const id = randomUUID();
  const key = id + '.webp';
  const path = join(t.config.uploadDir, key);
  const bytes = Buffer.from('private storage fixture');
  await mkdir(t.config.uploadDir, { recursive: true });
  await writeFile(path, bytes);
  await t.db.query(
    "INSERT INTO uploads(id,owner_id,kind,storage_key,mime,size_bytes,sha256) VALUES($1,$2,'proof',$3,'image/webp',$4,$5)",
    [id, owner.user.id, key, bytes.length, createHash('sha256').update(bytes).digest('hex')],
  );
  return { owner, id, key, path, bytes };
}

test('failed physical deletion is durable, immediately inaccessible and removed by a later retry', async () => {
  const t = await createTestApp();
  try {
    const contract = t.app.swagger().paths?.['/api/v1/uploads/{id}']?.delete?.responses;
    assert.ok(contract?.['200'], 'Immediate deletion must be documented');
    const queued = contract?.['202'] as any;
    assert.deepEqual(
      queued?.content?.['application/json']?.schema?.properties?.data?.required,
      ['deleted', 'fileRemovalPending'],
      'Queued deletion must have the same documented contract as the actual response',
    );
    const upload = await unusedUpload(t);
    // A directory at the object path makes unlink fail on every OS user,
    // including CI running as root; no permission bypass or mock network is used.
    await unlink(upload.path);
    await mkdir(upload.path);
    const response = await t.app.inject({
      method: 'DELETE',
      url: '/api/v1/uploads/' + upload.id,
      headers: bearer(upload.owner.token),
    });
    assert.equal(response.statusCode, 202, response.body);
    assert.deepEqual(response.json().data, { deleted: true, fileRemovalPending: true });
    assert.equal(await t.db.one('SELECT id FROM uploads WHERE id=$1', [upload.id]), undefined);
    assert.equal(
      (
        await t.app.inject({
          url: '/api/v1/uploads/' + upload.id,
          headers: bearer(upload.owner.token),
        })
      ).statusCode,
      404,
    );
    const pending = (await t.db.one('SELECT * FROM upload_deletion_jobs WHERE id=$1', [
      upload.id,
    ]))!;
    assert.equal(pending.attempts, 1);
    assert.equal(pending.locked_at, null);
    assert.equal((await processUploadDeletionBatch(t)).processed, 0);
    await rm(upload.path, { recursive: true });
    await writeFile(upload.path, upload.bytes);
    await t.db.query(
      "UPDATE upload_deletion_jobs SET available_at=now()-interval '1 second' WHERE id=$1",
      [upload.id],
    );
    const cleanup = await processUploadDeletionBatch(t);
    assert.equal(cleanup.deleted, 1);
    assert.equal(cleanup.failed, 0);
    await assert.rejects(access(upload.path), { code: 'ENOENT' });
    assert.equal(
      await t.db.one('SELECT id FROM upload_deletion_jobs WHERE id=$1', [upload.id]),
      undefined,
    );
    assert.equal((await processUploadDeletionBatch(t)).processed, 0);
  } finally {
    await t.close();
  }
});

test('cleanup recovers a crash after unlink through an expired lease and ENOENT acknowledgement', async () => {
  const t = await createTestApp();
  const originalOne = t.db.one.bind(t.db);
  try {
    const upload = await unusedUpload(t);
    let crashed = false;
    t.db.one = async <T extends Row = Row>(sql: string, params: unknown[] = []) => {
      if (!crashed && sql.startsWith('DELETE FROM upload_deletion_jobs')) {
        crashed = true;
        throw new Error('Simulated process failure after physical removal');
      }
      return originalOne<T>(sql, params);
    };
    const response = await t.app.inject({
      method: 'DELETE',
      url: '/api/v1/uploads/' + upload.id,
      headers: bearer(upload.owner.token),
    });
    assert.equal(response.statusCode, 202, response.body);
    await assert.rejects(access(upload.path), { code: 'ENOENT' });
    const pending = (await originalOne('SELECT * FROM upload_deletion_jobs WHERE id=$1', [
      upload.id,
    ]))!;
    assert.equal(pending.attempts, 1);
    assert.ok(pending.locked_at);
    t.db.one = originalOne;
    await t.db.query(
      "UPDATE upload_deletion_jobs SET locked_at=now()-interval '11 minutes' WHERE id=$1",
      [upload.id],
    );
    assert.equal((await processUploadDeletionBatch(t)).deleted, 1);
    assert.equal(
      await originalOne('SELECT id FROM upload_deletion_jobs WHERE id=$1', [upload.id]),
      undefined,
    );
  } finally {
    t.db.one = originalOne;
    await t.close();
  }
});

test('a stale cleanup acknowledgement cannot delete a newer worker retry record', async () => {
  const t = await createTestApp();
  const originalOne = t.db.one.bind(t.db);
  let release!: () => void;
  let first: ReturnType<typeof processUploadDeletionBatch> | undefined;
  try {
    const upload = await unusedUpload(t);
    await t.db.transaction(async (tx) => {
      await tx.query('INSERT INTO upload_deletion_jobs(id,storage_key) VALUES($1,$2)', [
        upload.id,
        upload.key,
      ]);
      await tx.query('DELETE FROM uploads WHERE id=$1', [upload.id]);
    });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    t.db.one = async <T extends Row = Row>(sql: string, params: unknown[] = []) => {
      if (!held && sql.startsWith('DELETE FROM upload_deletion_jobs')) {
        held = true;
        entered();
        await resume;
      }
      return originalOne<T>(sql, params);
    };
    first = processUploadDeletionBatch(t, 1);
    await waiting;
    await mkdir(upload.path);
    await t.db.query(
      "UPDATE upload_deletion_jobs SET locked_at=now()-interval '11 minutes' WHERE id=$1",
      [upload.id],
    );
    const newer = await processUploadDeletionBatch(t, 1);
    assert.equal(newer.failed, 1);
    const latest = (await originalOne('SELECT * FROM upload_deletion_jobs WHERE id=$1', [
      upload.id,
    ]))!;
    assert.equal(latest.attempts, 2);
    release();
    const stale = await first;
    assert.equal(stale.leaseLost, 1);
    assert.equal(stale.deleted, 0);
    const preserved = (await originalOne('SELECT * FROM upload_deletion_jobs WHERE id=$1', [
      upload.id,
    ]))!;
    assert.equal(preserved.attempts, 2);
    assert.equal(
      new Date(preserved.available_at).toISOString(),
      new Date(latest.available_at).toISOString(),
    );
  } finally {
    release?.();
    if (first) await first;
    t.db.one = originalOne;
    await t.close();
  }
});

test('cleanup keeps retrying with a capped delay and shutdown does not claim a new job', async () => {
  const t = await createTestApp();
  try {
    const upload = await unusedUpload(t);
    await unlink(upload.path);
    await mkdir(upload.path);
    await t.db.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO upload_deletion_jobs(id,storage_key,attempts) VALUES($1,$2,100)',
        [upload.id, upload.key],
      );
      await tx.query('DELETE FROM uploads WHERE id=$1', [upload.id]);
    });
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      (await processUploadDeletionBatch(t, 50, { signal: controller.signal })).processed,
      0,
    );
    const before = Date.now();
    assert.equal((await processUploadDeletionBatch(t)).failed, 1);
    const row = (await t.db.one('SELECT * FROM upload_deletion_jobs WHERE id=$1', [upload.id]))!;
    assert.equal(row.attempts, 101);
    assert.equal(row.locked_at, null);
    assert.ok(new Date(row.available_at).getTime() >= before + 3599000);
    assert.ok(new Date(row.available_at).getTime() <= Date.now() + 3601000);
  } finally {
    await t.close();
  }
});
