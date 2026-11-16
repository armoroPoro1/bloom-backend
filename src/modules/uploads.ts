import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import type { Module, Actor, Sql } from '../core/contracts.js';
import { data, fail, paramsId, audit } from '../core/http.js';
import { tryDeleteQueuedUpload } from '../core/upload-cleanup.js';
const kinds = z.enum(['product', 'avatar', 'proof', 'article']);
function filename(dir: string, key: string) {
  if (!/^[0-9a-f-]{36}\.webp$/.test(key)) throw new Error('Invalid stored object key');
  return resolve(dir, key);
}
export const registerUploads: Module = async (app, ctx, route) => {
  route(
    'POST',
    '/api/v1/uploads',
    {
      tag: 'Files',
      summary:
        'Upload one image as multipart field file with query kind=product|avatar|proof|article',
      query: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['product', 'avatar', 'proof', 'article'] } },
        required: ['kind'],
        additionalProperties: false,
      },
      rateLimit: 30,
    },
    async (req, reply) => {
      const kind = kinds.parse((req.query as any).kind);
      const actor = req.actor!;
      if (kind === 'article' && actor.role !== 'admin')
        fail(403, 'FORBIDDEN', 'Only administrators upload article images');
      if (kind === 'product' && !['seller', 'admin'].includes(actor.role))
        fail(403, 'FORBIDDEN', 'Only approved sellers and administrators upload product images');
      if (
        kind === 'product' &&
        actor.role === 'seller' &&
        !(await ctx.db.one("SELECT id FROM shops WHERE owner_id=$1 AND status='approved'", [
          actor.id,
        ]))
      )
        fail(403, 'SHOP_NOT_ACTIVE', 'Your shop is not approved');
      let input: Buffer | undefined,
        mimetype = '';
      try {
        for await (const part of req.parts({
          limits: { files: 1, fileSize: 1024 * 1024, fields: 0, parts: 1 },
        })) {
          if (part.type !== 'file' || part.fieldname !== 'file' || input)
            fail(400, 'FILE_REQUIRED', 'Supply exactly one image in field file');
          mimetype = part.mimetype;
          if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimetype))
            fail(400, 'INVALID_IMAGE', 'Only JPEG, PNG, WebP and GIF images are accepted');
          input = await part.toBuffer();
          if (part.file.truncated || input.length > 1024 * 1024)
            fail(413, 'FILE_TOO_LARGE', 'Image must be at most 1 MiB');
        }
      } catch (error: any) {
        if (error.status) throw error;
        if (error.code === 'FST_REQ_FILE_TOO_LARGE')
          fail(413, 'FILE_TOO_LARGE', 'Image must be at most 1 MiB');
        fail(
          400,
          'INVALID_MULTIPART',
          'Supply exactly one image and no additional multipart fields',
        );
      }
      if (!input) fail(400, 'FILE_REQUIRED', 'Supply one image in field file');
      const signatureMatches =
        (mimetype === 'image/png' &&
          input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
        (mimetype === 'image/jpeg' &&
          input.length >= 3 &&
          input[0] === 255 &&
          input[1] === 216 &&
          input[2] === 255) ||
        (mimetype === 'image/webp' &&
          input.subarray(0, 4).toString('ascii') === 'RIFF' &&
          input.subarray(8, 12).toString('ascii') === 'WEBP') ||
        (mimetype === 'image/gif' &&
          ['GIF87a', 'GIF89a'].includes(input.subarray(0, 6).toString('ascii')));
      if (!signatureMatches)
        fail(400, 'INVALID_IMAGE', 'Image signature does not match its declared type');
      let output: Buffer;
      try {
        const decoder = sharp(input, {
          limitInputPixels: 12000000,
          failOn: 'warning',
          animated: false,
        });
        const meta = await decoder.metadata();
        const actual = {
          jpeg: 'image/jpeg',
          png: 'image/png',
          webp: 'image/webp',
          gif: 'image/gif',
        }[meta.format as 'jpeg' | 'png' | 'webp' | 'gif'];
        if (actual !== mimetype || !meta.width || !meta.height || (meta.pages ?? 1) > 1)
          fail(
            400,
            'INVALID_IMAGE',
            'Image type must match its contents; animated images are not supported',
          );
        output = await decoder
          .rotate()
          .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 85 })
          .toBuffer();
      } catch (error: any) {
        if (error.status) throw error;
        fail(400, 'INVALID_IMAGE', 'This file cannot be decoded as a supported image');
      }
      if (output.length > 2 * 1024 * 1024)
        fail(413, 'FILE_TOO_LARGE', 'Processed image exceeds storage limit');
      const id = randomUUID(),
        key = id + '.webp';
      await mkdir(resolve(ctx.config.uploadDir), { recursive: true, mode: 0o700 });
      const path = filename(ctx.config.uploadDir, key);
      await writeFile(path, output, { flag: 'wx', mode: 0o600 });
      try {
        await ctx.db.transaction(async (tx) => {
          await tx.query(
            'INSERT INTO uploads(id,owner_id,kind,storage_key,mime,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              id,
              actor.id,
              kind,
              key,
              'image/webp',
              output.length,
              createHash('sha256').update(output).digest('hex'),
            ],
          );
          await audit(tx, actor, 'file.upload', 'upload', id, { kind, sizeBytes: output.length });
        });
      } catch (error) {
        await unlink(path).catch(() => {});
        throw error;
      }
      reply.code(201);
      return data({
        id,
        kind,
        mime: 'image/webp',
        sizeBytes: output.length,
        url: '/api/v1/uploads/' + id,
      });
    },
  );
  route(
    'GET',
    '/api/v1/uploads/:id',
    { auth: false, tag: 'Files', summary: 'Read an authorized image; proofs stay private' },
    async (req, reply) => {
      const id = paramsId(req);
      const upload = await ctx.db.one('SELECT * FROM uploads WHERE id=$1', [id]);
      if (!upload) fail(404, 'NOT_FOUND', 'File not found');
      const actor = req.actor;
      let allowed = !!actor && (actor.id === upload.owner_id || actor.role === 'admin');
      let isPublic = false;
      if (upload.kind === 'product') {
        isPublic = !!(await ctx.db.one(
          "SELECT p.id FROM products p JOIN shops s ON s.id=p.shop_id JOIN users u ON u.id=s.owner_id JOIN categories c ON c.id=p.category_id WHERE p.image_id=$1 AND p.active=true AND p.archived_at IS NULL AND c.active=true AND s.status='approved' AND u.blocked=false LIMIT 1",
          [id],
        ));
        if (!allowed && actor)
          allowed = !!(await ctx.db.one(
            'SELECT p.id FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.image_id=$1 AND s.owner_id=$2 LIMIT 1',
            [id, actor.id],
          ));
        if (!allowed && actor)
          allowed = !!(await ctx.db.one(
            'SELECT o.id FROM order_items i JOIN orders o ON o.id=i.order_id JOIN shops s ON s.id=o.shop_id WHERE i.image_id=$1 AND (o.buyer_id=$2 OR s.owner_id=$2) LIMIT 1',
            [id, actor.id],
          ));
      }
      if (upload.kind === 'article')
        isPublic = !!(await ctx.db.one(
          'SELECT id FROM articles WHERE image_id=$1 AND published=true LIMIT 1',
          [id],
        ));
      if (!allowed && !isPublic) fail(404, 'NOT_FOUND', 'File not found');
      let content: Buffer;
      try {
        content = await readFile(filename(ctx.config.uploadDir, upload.storage_key));
      } catch {
        fail(404, 'NOT_FOUND', 'File not found');
      }
      reply
        .header('Cache-Control', isPublic ? 'public, max-age=300' : 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', 'inline; filename="' + id + '.webp"')
        .type(upload.mime);
      return content;
    },
  );
  route(
    'DELETE',
    '/api/v1/uploads/:id',
    {
      tag: 'Files',
      summary: 'Delete an unused own upload; referenced assets are protected',
      response: {
        200: {
          description: 'Upload metadata and physical file removed',
          type: 'object',
          required: ['data'],
          properties: {
            data: {
              type: 'object',
              required: ['deleted'],
              properties: { deleted: { type: 'boolean', const: true } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        202: {
          description: 'Upload metadata removed; private physical file deletion queued for retry',
          type: 'object',
          required: ['data'],
          properties: {
            data: {
              type: 'object',
              required: ['deleted', 'fileRemovalPending'],
              properties: {
                deleted: { type: 'boolean', const: true },
                fileRemovalPending: { type: 'boolean', const: true },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const id = paramsId(req);
      await ctx.db.transaction(async (tx) => {
        const u = await tx.one('SELECT * FROM uploads WHERE id=$1 FOR UPDATE', [id]);
        if (!u || (u.owner_id !== req.actor!.id && req.actor!.role !== 'admin'))
          fail(404, 'NOT_FOUND', 'File not found');
        const refs = await tx.one(
          'SELECT (SELECT count(*) FROM products WHERE image_id=$1)+(SELECT count(*) FROM users WHERE avatar_id=$1)+(SELECT count(*) FROM articles WHERE image_id=$1)+(SELECT count(*) FROM order_items WHERE image_id=$1)+(SELECT count(*) FROM orders WHERE proof_upload_id=$1)+(SELECT count(*) FROM order_payment_proofs WHERE upload_id=$1) AS total',
          [id],
        );
        if (Number(refs?.total) > 0)
          fail(409, 'FILE_IN_USE', 'This file is referenced by existing records');
        await tx.query('INSERT INTO upload_deletion_jobs(id,storage_key) VALUES($1,$2)', [
          u.id,
          u.storage_key,
        ]);
        await tx.query('DELETE FROM uploads WHERE id=$1', [id]);
        await audit(tx, req.actor!, 'file.delete', 'upload', id);
      });
      let removed = false;
      try {
        removed = await tryDeleteQueuedUpload(ctx, id);
      } catch {
        // The queue is already committed. An unavailable disk/database must not
        // turn the private physical file into an untracked permanent orphan.
        req.log.warn({ uploadId: id }, 'Upload cleanup deferred');
      }
      if (!removed) {
        reply.code(202);
        return data({ deleted: true, fileRemovalPending: true });
      }
      return data({ deleted: true });
    },
  );
};
