import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Context, Row } from './contracts.js';

async function claimUploadDeletion(ctx: Context, id?: string, signal?: AbortSignal) {
  if (signal?.aborted) return null;
  return ctx.db.transaction(async (tx) => {
    if (signal?.aborted) return null;
    const row = await tx.one(
      `SELECT * FROM upload_deletion_jobs
        WHERE available_at<=now()
        AND (locked_at IS NULL OR locked_at<now()-interval '10 minutes')
        ${id ? 'AND id=$1' : ''}
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      id ? [id] : [],
    );
    if (!row || signal?.aborted) return null;
    return (await tx.one(
      'UPDATE upload_deletion_jobs SET attempts=attempts+1,locked_at=now() WHERE id=$1 RETURNING *',
      [row.id],
    ))!;
  });
}

async function removeClaimedUpload(ctx: Context, job: Row) {
  try {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/.test(job.storage_key)
    )
      throw new Error('Invalid stored object key');
    await unlink(resolve(ctx.config.uploadDir, job.storage_key));
  } catch (error: any) {
    // Missing files are a successful outcome, including after a crash between
    // unlink and acknowledgement. Other failures remain durable and retryable.
    if (error.code !== 'ENOENT') {
      const delay = Math.min(3600, 30 * 2 ** Math.min(Number(job.attempts) - 1, 7));
      const updated = await ctx.db.one(
        `UPDATE upload_deletion_jobs SET locked_at=NULL,
          available_at=now()+($3::integer * interval '1 second')
          WHERE id=$1 AND attempts=$2 AND locked_at IS NOT NULL RETURNING id`,
        [job.id, job.attempts, delay],
      );
      return updated ? ('failed' as const) : ('leaseLost' as const);
    }
  }
  const removed = await ctx.db.one(
    'DELETE FROM upload_deletion_jobs WHERE id=$1 AND attempts=$2 AND locked_at IS NOT NULL RETURNING id',
    [job.id, job.attempts],
  );
  return removed ? ('deleted' as const) : ('leaseLost' as const);
}

/** Try the newly queued upload immediately; durable maintenance handles any retry. */
export async function tryDeleteQueuedUpload(ctx: Context, uploadId: string): Promise<boolean> {
  const job = await claimUploadDeletion(ctx, uploadId);
  if (job) await removeClaimedUpload(ctx, job);
  return !(await ctx.db.one('SELECT id FROM upload_deletion_jobs WHERE id=$1', [uploadId]));
}

export async function processUploadDeletionBatch(
  ctx: Context,
  limit = 50,
  options: { signal?: AbortSignal } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError('Upload cleanup limit must be an integer from 1 to 200');
  const summary = { processed: 0, deleted: 0, failed: 0, leaseLost: 0 };
  for (let index = 0; index < limit; index++) {
    if (options.signal?.aborted) break;
    const job = await claimUploadDeletion(ctx, undefined, options.signal);
    if (!job) break;
    summary.processed++;
    summary[await removeClaimedUpload(ctx, job)]++;
  }
  return summary;
}
