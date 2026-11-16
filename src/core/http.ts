import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { Actor, Sql, Row } from './contracts.js';
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function fail(status: number, code: string, message: string, details?: unknown): never {
  throw new ApiError(status, code, message, details);
}
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  return schema.parse(value);
}
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
    unrepresentable: 'any',
    override: (ctx) => {
      // URL query parameters are strings on the wire. Describe numeric coercions
      // explicitly so both OpenAPI and the query-only normalizer retain bounds.
      if (ctx.zodSchema instanceof z.ZodNumber && ctx.zodSchema.def.coerce) {
        Object.assign(
          ctx.jsonSchema,
          z.toJSONSchema(ctx.zodSchema, { target: 'draft-7', io: 'output' }),
        );
        delete (ctx.jsonSchema as Record<string, unknown>).$schema;
      }
    },
  }) as Record<string, unknown>;
}
export function partialSchema<T extends Record<string, z.ZodType>>(schema: z.ZodObject<T>) {
  const fields = {} as { [K in keyof T]: z.ZodOptional<T[K]> };
  for (const key of Object.keys(schema.shape) as (keyof T)[]) {
    let field: z.ZodType = schema.shape[key];
    while (field instanceof z.ZodDefault) field = field.removeDefault() as z.ZodType;
    fields[key] = field.optional() as unknown as z.ZodOptional<T[typeof key]>;
  }
  return z.object(fields).strict();
}
export function paramsId(request: FastifyRequest, key = 'id'): string {
  return z
    .string()
    .uuid()
    .parse((request.params as Record<string, unknown>)[key]);
}
export function page(request: FastifyRequest) {
  const q = request.query as Record<string, unknown>;
  return z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    })
    .parse(q);
}
export function camel<T = any>(value: any): T {
  if (value instanceof Date) return value.toISOString() as T;
  if (typeof value === 'bigint') return Number(value) as T;
  if (Array.isArray(value)) return value.map((v) => camel(v)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
        camel(v),
      ]),
    ) as T;
  return value as T;
}
export const data = <T>(value: T) => ({ data: value });
export function list(rows: unknown[], limit: number, offset: number, total?: number) {
  return { data: camel(rows), page: { limit, offset, ...(total === undefined ? {} : { total }) } };
}
export async function audit(
  tx: Sql,
  actor: Actor,
  action: string,
  entity: string,
  entityId: string,
  detail: Row = {},
  shopId?: string,
) {
  await tx.query(
    'INSERT INTO audit_events(id,actor_id,action,entity,entity_id,detail,shop_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), actor.id, action, entity, entityId, JSON.stringify(detail), shopId ?? null],
  );
}
export async function notify(
  tx: Sql,
  userId: string,
  title: string,
  message: string,
  orderId?: string,
) {
  await tx.query(
    'INSERT INTO notifications(id,user_id,title,message,order_id) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), userId, title, message, orderId ?? null],
  );
}
export function csv(rows: Record<string, unknown>[]) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    if (typeof v === 'string' && /^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  return (
    '\uFEFF' +
    [
      headers.map(cell).join(','),
      ...rows.map((r) => headers.map((h) => cell(r[h])).join(',')),
    ].join('\r\n') +
    '\r\n'
  );
}
export const uuid = z.string().uuid();
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !v.startsWith('0000') &&
      !Number.isNaN(Date.parse(v)) &&
      new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v,
    'Invalid calendar date',
  );
