import type { Context } from './contracts.js';
import { expireUnpaidOrders } from '../modules/commerce-lifecycle.js';
import { processUploadDeletionBatch } from './upload-cleanup.js';

/** Shared by the API's background runner and the one-shot maintenance command. */
export async function runMaintenance(ctx: Context, options: { signal?: AbortSignal } = {}) {
  const orders = await expireUnpaidOrders(ctx, 100, options.signal);
  if (options.signal?.aborted)
    return {
      expiredUnpaidOrders: orders.expired,
      uploadCleanup: null,
      authenticationCleanup: 'skipped',
      sentMailMetadataCleanup: 'skipped',
    };
  const uploadCleanup = await processUploadDeletionBatch(ctx, 50, options);
  if (options.signal?.aborted)
    return {
      expiredUnpaidOrders: orders.expired,
      uploadCleanup,
      authenticationCleanup: 'skipped',
      sentMailMetadataCleanup: 'skipped',
    };
  await ctx.db.transaction(async (tx) => {
    await tx.query('DELETE FROM sessions WHERE refresh_expires_at<now()');
    await tx.query('DELETE FROM account_tokens WHERE expires_at<now()');
    await tx.query('DELETE FROM used_refresh_tokens WHERE expires_at<now()');
    await tx.query("DELETE FROM auth_attempts WHERE window_started<now()-interval '1 day'");
    await tx.query(
      "DELETE FROM mail_outbox WHERE status='sent' AND sent_at<now()-interval '30 days'",
    );
  });
  return {
    expiredUnpaidOrders: orders.expired,
    uploadCleanup,
    authenticationCleanup: 'complete',
    sentMailMetadataCleanup: 'complete',
  };
}
