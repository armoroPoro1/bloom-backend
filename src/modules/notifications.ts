import { z } from 'zod';
import type { Module } from '../core/contracts.js';
import { data, camel, parse, paramsId, page, list, jsonSchema } from '../core/http.js';
export const registerNotifications: Module = async (app, ctx, route) => {
  const querySchema = z
    .object({
      unread: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    })
    .strict();
  route(
    'GET',
    '/api/v1/me/notifications',
    { tag: 'Notifications', summary: 'List own notifications', query: jsonSchema(querySchema) },
    async (req) => {
      const p = page(req);
      const { unread } = parse(querySchema, req.query);
      const rows = await ctx.db.query(
        'SELECT id,title,message,order_id,read_at,created_at FROM notifications WHERE user_id=$1 AND ($2::boolean=false OR read_at IS NULL) ORDER BY created_at DESC,id LIMIT $3 OFFSET $4',
        [req.actor!.id, unread === 'true', p.limit, p.offset],
      );
      const count = await ctx.db.one(
        'SELECT count(*) AS total FROM notifications WHERE user_id=$1 AND ($2::boolean=false OR read_at IS NULL)',
        [req.actor!.id, unread === 'true'],
      );
      return list(rows, p.limit, p.offset, Number(count!.total));
    },
  );
  route(
    'PATCH',
    '/api/v1/me/notifications/:id/read',
    { tag: 'Notifications', summary: 'Mark an own notification as read' },
    async (req) => {
      const row = await ctx.db.one(
        'UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at',
        [paramsId(req), req.actor!.id],
      );
      return data(row ? camel(row) : { updated: false });
    },
  );
  route(
    'POST',
    '/api/v1/me/notifications/read-all',
    { tag: 'Notifications', summary: 'Mark all own notifications as read' },
    async (req) => {
      await ctx.db.query(
        'UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL',
        [req.actor!.id],
      );
      return data({ updated: true });
    },
  );
};
