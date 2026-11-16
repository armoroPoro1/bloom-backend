import nodemailer from 'nodemailer';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Context } from './contracts.js';
export async function deliverMailBatch(
  ctx: Context,
  limit = 20,
  options: { signal?: AbortSignal } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError('Mail batch limit must be an integer from 1 to 200');
  const { db, config } = ctx;
  const summary = { processed: 0, sent: 0, failed: 0, leaseLost: 0, exhausted: 0 };
  if (options.signal?.aborted) return summary;
  let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
  if (config.smtpUrl) {
    const u = new URL(config.smtpUrl);
    if (!['smtp:', 'smtps:'].includes(u.protocol))
      throw new Error('SMTP_URL must use smtp:// or smtps://');
    transport = nodemailer.createTransport({
      host: u.hostname,
      port: Number(u.port || (u.protocol === 'smtps:' ? 465 : 587)),
      secure: u.protocol === 'smtps:',
      requireTLS: config.nodeEnv === 'production',
      ...(u.username
        ? { auth: { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } }
        : {}),
      connectionTimeout: 10000,
      socketTimeout: 20000,
    });
  } else if (config.nodeEnv === 'production') throw new Error('SMTP is not configured');
  try {
    for (let i = 0; i < limit; i++) {
      if (options.signal?.aborted) break;
      const claim = await db.transaction(async (tx) => {
        if (options.signal?.aborted) return null;
        const row = await tx.one(
          `SELECT * FROM mail_outbox WHERE
            (status IN ('pending','failed') AND attempts<5 AND available_at<=now())
            OR (status='processing' AND (locked_at IS NULL OR locked_at<now()-interval '10 minutes'))
            OR (status IN ('pending','failed') AND attempts>=5 AND (body<>'' OR locked_at IS NOT NULL))
            ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        if (!row || options.signal?.aborted) return null;
        if (Number(row.attempts) >= 5) {
          // A crash on the final attempt must not leave a permanent processing lease
          // or retain the account-action token after the retry budget is exhausted.
          await tx.query(
            "UPDATE mail_outbox SET status='failed',locked_at=NULL,body='' WHERE id=$1",
            [row.id],
          );
          return { exhausted: true as const, mail: row };
        }
        const mail = (await tx.one(
          "UPDATE mail_outbox SET status='processing',locked_at=now(),attempts=attempts+1 WHERE id=$1 RETURNING *",
          [row.id],
        ))!;
        return { exhausted: false as const, mail };
      });
      if (!claim) break;
      summary.processed++;
      if (claim.exhausted) {
        summary.exhausted++;
        continue;
      }
      const { mail } = claim;
      let delivered = false;
      try {
        if (transport)
          await transport.sendMail({
            from: config.mailFrom,
            to: mail.recipient,
            subject: mail.subject,
            text: mail.body,
            messageId: '<' + mail.id + '@bloom-outbox>',
          });
        else {
          await mkdir(resolve(config.mailDir), { recursive: true, mode: 0o700 });
          await writeFile(
            resolve(config.mailDir, mail.id + '.json'),
            JSON.stringify(
              { id: mail.id, to: mail.recipient, subject: mail.subject, body: mail.body },
              null,
              2,
            ),
            { mode: 0o600 },
          );
        }
        delivered = true;
      } catch {
        const delay = Math.min(3600, 30 * 2 ** (Number(mail.attempts) - 1));
        const exhausted = Number(mail.attempts) >= 5;
        const updated = await db.one(
          `UPDATE mail_outbox SET status='failed',locked_at=NULL,available_at=$2,
            body=CASE WHEN $4 THEN '' ELSE body END
            WHERE id=$1 AND status='processing' AND attempts=$3 RETURNING id`,
          [mail.id, new Date(Date.now() + delay * 1000), mail.attempts, exhausted],
        );
        if (updated) {
          summary.failed++;
          if (exhausted) summary.exhausted++;
        } else summary.leaseLost++;
      }
      if (delivered) {
        // attempts is the monotonically increasing claim generation. A delayed
        // worker must never overwrite a later worker's acknowledgement.
        const updated = await db.one(
          "UPDATE mail_outbox SET status='sent',sent_at=now(),locked_at=NULL,body='' WHERE id=$1 AND status='processing' AND attempts=$2 RETURNING id",
          [mail.id, mail.attempts],
        );
        if (updated) summary.sent++;
        else summary.leaseLost++;
      }
    }
  } finally {
    transport?.close();
  }
  return summary;
}
