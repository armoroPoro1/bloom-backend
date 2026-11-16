import { z } from 'zod';
import type { Actor, Context, Module, Row, Sql } from '../core/contracts.js';
import {
  audit,
  camel,
  csv,
  data,
  fail,
  jsonSchema,
  list,
  notify,
  paramsId,
  parse,
  partialSchema,
} from '../core/http.js';

const text = (max: number) => z.string().trim().max(max);
const cents = z.number().int().min(0).max(100_000_000);
const paging = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
};
const queryText = z.string().trim().max(120).default('');
const boolQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return (
      v.slice(0, 4) !== '0000' && !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === v
    );
  }, 'Invalid calendar date');
const dateFilters = { from: date.optional(), to: date.optional() };
const categoryInput = z
  .object({
    name: text(120).min(1),
    icon: text(40).min(1).default('package'),
    description: text(2000).default(''),
    active: z.boolean().default(true),
  })
  .strict();
const categoryPatch = partialSchema(categoryInput).refine(
  (v) => Object.keys(v).length > 0,
  'At least one field is required',
);
const shopInput = z
  .object({
    name: text(120).min(2),
    email: z.string().trim().email().max(254),
    description: text(4000).min(10),
    shippingFeeCents: cents.default(4000),
    freeShippingAtCents: cents.nullable().default(null),
  })
  .strict();
const shopPatch = partialSchema(shopInput).refine(
  (v) => Object.keys(v).length > 0,
  'At least one field is required',
);
const decisionInput = z
  .object({ decision: z.enum(['approve', 'reject']), reason: text(1000).optional() })
  .strict()
  .refine(
    (v) => v.decision !== 'reject' || Boolean(v.reason?.trim()),
    'Rejection requires a reason',
  );
const shopStatusInput = z
  .object({ status: z.enum(['approved', 'suspended']), reason: text(1000).optional() })
  .strict()
  .refine(
    (v) => v.status !== 'suspended' || Boolean(v.reason?.trim()),
    'Suspension requires a reason',
  );
const productShape = {
  name: text(180).min(1),
  englishName: text(180).default(''),
  description: text(10_000).default(''),
  categoryId: z.string().uuid(),
  priceCents: cents.min(1),
  originalPriceCents: cents.default(0),
  imageId: z.string().uuid().nullable().default(null),
  imageIndex: z.number().int().min(0).max(5).nullable().default(null),
  badge: text(60).default(''),
  stock: z.number().int().min(0).max(1_000_000).default(0),
  active: z.boolean().default(true),
};
const productInput = z.object(productShape).strict();
const adminProductInput = z.object({ ...productShape, shopId: z.string().uuid() }).strict();
const productPatch = partialSchema(productInput).refine(
  (v) => Object.keys(v).length > 0,
  'At least one field is required',
);
const stockInput = z
  .object({
    change: z
      .number()
      .int()
      .min(-1_000_000)
      .max(1_000_000)
      .refine((v) => v !== 0),
    reason: text(1000).min(3),
  })
  .strict();
const memberStatusInput = z.object({ blocked: z.boolean(), reason: text(1000).min(3) }).strict();
const settingsInput = z
  .object({
    siteTitle: text(100).min(1).optional(),
    siteNotice: text(500).optional(),
    contactEmail: z.union([z.string().trim().email().max(254), z.literal('')]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
const visitInput = z
  .object({
    page: z.enum([
      'home',
      'shop',
      'wishlist',
      'orders',
      'account',
      'seller',
      'admin',
      'nutrition',
      'exercise',
      'articles',
      'apply',
      'store',
    ]),
  })
  .strict();
const productQuery = z
  .object({
    ...paging,
    q: queryText,
    categoryId: z.string().uuid().optional(),
    shopId: z.string().uuid().optional(),
    minPriceCents: z.coerce.number().int().min(0).max(100_000_000).optional(),
    maxPriceCents: z.coerce.number().int().min(0).max(100_000_000).optional(),
    sort: z.enum(['newest', 'price_asc', 'price_desc', 'rating', 'bestselling']).default('newest'),
    active: boolQuery,
    archived: boolQuery,
  })
  .strict();
const publicProductQuery = productQuery.omit({ active: true, archived: true });
const shopQuery = z.object({ ...paging, q: queryText }).strict();
const managedShopQuery = z
  .object({
    ...paging,
    q: queryText,
    status: z.enum(['pending', 'approved', 'rejected', 'suspended']).optional(),
  })
  .strict();
const usageQuery = z.object(dateFilters).strict();
const memberQuery = z
  .object({
    ...paging,
    q: queryText,
    role: z.enum(['user', 'seller', 'admin']).optional(),
    blocked: boolQuery,
  })
  .strict();
const stockQuery = z
  .object({
    ...paging,
    ...dateFilters,
    productId: z.string().uuid().optional(),
    shopId: z.string().uuid().optional(),
  })
  .strict();
const auditQuery = z
  .object({
    ...paging,
    ...dateFilters,
    action: text(120).optional(),
    entity: text(60).optional(),
    shopId: z.string().uuid().optional(),
  })
  .strict();

function ensureDates(v: { from?: string; to?: string }) {
  if (v.from && v.to && v.from > v.to)
    fail(400, 'INVALID_DATE_RANGE', 'Start date must not follow end date');
}
function dateWhere(
  parts: string[],
  values: unknown[],
  alias: string,
  v: { from?: string; to?: string },
) {
  ensureDates(v);
  if (v.from) {
    values.push(v.from);
    parts.push(
      `${alias}.created_at >= ($${values.length}::date::timestamp AT TIME ZONE 'Asia/Bangkok')`,
    );
  }
  if (v.to) {
    values.push(v.to);
    parts.push(
      `${alias}.created_at < (($${values.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok')`,
    );
  }
}
function append(parts: string[], values: unknown[], expression: string, value: unknown) {
  values.push(value);
  parts.push(expression.replace('?', `$${values.length}`));
}
function searchPattern(value: string) {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}
function imageUrl(row: Row) {
  return { ...row, image_url: row.image_id ? `/api/v1/uploads/${row.image_id}` : null };
}
async function ownShop(sql: Sql, actor: Actor) {
  const shop = await sql.one('SELECT * FROM shops WHERE owner_id=$1', [actor.id]);
  if (!shop) fail(404, 'SHOP_NOT_FOUND', 'Your shop was not found');
  return shop!;
}
async function manageableProduct(sql: Sql, actor: Actor, id: string, lock = false) {
  const product = await sql.one(
    `SELECT p.*,s.owner_id,s.status AS shop_status FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=$1 ${actor.role === 'admin' ? '' : 'AND s.owner_id=$2'} ${lock ? 'FOR UPDATE OF p' : ''}`,
    actor.role === 'admin' ? [id] : [id, actor.id],
  );
  if (!product) fail(404, 'PRODUCT_NOT_FOUND', 'Product was not found');
  return product!;
}
async function validateProductReferences(tx: Sql, actor: Actor, input: Row, existing?: Row) {
  const category = await tx.one('SELECT id,active FROM categories WHERE id=$1', [input.categoryId]);
  if (!category) fail(400, 'CATEGORY_NOT_FOUND', 'Select an existing category');
  if (input.active && !category!.active)
    fail(409, 'CATEGORY_INACTIVE', 'Activate the category before publishing this product');
  if (input.originalPriceCents && input.originalPriceCents < input.priceCents)
    fail(400, 'INVALID_ORIGINAL_PRICE', 'Original price cannot be below sale price');
  if (input.imageId && input.imageId !== existing?.image_id) {
    const upload = await tx.one('SELECT id FROM uploads WHERE id=$1 AND owner_id=$2 AND kind=$3', [
      input.imageId,
      actor.id,
      'product',
    ]);
    if (!upload) fail(400, 'INVALID_PRODUCT_IMAGE', 'Use a product image uploaded by your account');
  }
}
async function movement(tx: Sql, actor: Actor, product: Row, change: number, reason: string) {
  await tx.query(
    'INSERT INTO stock_movements(product_id,shop_id,change,balance,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
    [product.id, product.shop_id, change, product.stock, reason, actor.id],
  );
}
function publicShop(row: Row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    email: row.email,
    status: row.status,
    shipping_fee_cents: row.shipping_fee_cents,
    free_shipping_at_cents: row.free_shipping_at_cents,
    created_at: row.created_at,
  };
}
const publicAvailable = `p.active=true AND p.archived_at IS NULL AND s.status='approved' AND c.active=true AND u.blocked=false`;
const productColumns = `p.*,s.name AS shop_name,c.name AS category_name,
  COALESCE((SELECT ROUND(AVG(r.rating)::numeric,2)::float8 FROM reviews r WHERE r.product_id=p.id AND r.hidden=false),0) AS rating,
  (SELECT COUNT(*)::int FROM reviews r WHERE r.product_id=p.id AND r.hidden=false) AS review_count,
  (SELECT COALESCE(SUM(oi.quantity),0)::bigint FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=p.id AND o.status IN ('paid','preparing','shipped','delivered')) AS sold_count`;
const productJoins =
  'FROM products p JOIN shops s ON s.id=p.shop_id JOIN categories c ON c.id=p.category_id JOIN users u ON u.id=s.owner_id';
const memberColumns =
  'u.id,u.name,u.email,u.phone,u.address,u.role,u.blocked,u.email_verified,u.created_at,u.updated_at';

export const registerCatalog: Module = async (_app, ctx, route) => {
  const { db } = ctx;
  route(
    'GET',
    '/api/v1/categories',
    { auth: false, summary: 'List active product categories', tag: 'Catalog' },
    async () =>
      data(
        camel(
          await db.query(
            'SELECT id,name,icon,description,active FROM categories WHERE active=true ORDER BY name,id',
          ),
        ),
      ),
  );
  route(
    'GET',
    '/api/v1/products',
    {
      auth: false,
      summary: 'Search available products with filters and pagination',
      tag: 'Catalog',
      query: jsonSchema(publicProductQuery),
    },
    async (req) => {
      const q = parse(publicProductQuery, req.query);
      if (
        q.minPriceCents !== undefined &&
        q.maxPriceCents !== undefined &&
        q.minPriceCents > q.maxPriceCents
      )
        fail(400, 'INVALID_PRICE_RANGE', 'Minimum price must not exceed maximum price');
      const parts = [publicAvailable],
        values: unknown[] = [];
      if (q.q) {
        values.push(searchPattern(q.q));
        const parameter = `$${values.length}`;
        parts.push(
          `(p.name ILIKE ${parameter} OR p.english_name ILIKE ${parameter} OR p.description ILIKE ${parameter})`,
        );
      }
      if (q.categoryId) append(parts, values, 'p.category_id=?', q.categoryId);
      if (q.shopId) append(parts, values, 'p.shop_id=?', q.shopId);
      if (q.minPriceCents !== undefined) append(parts, values, 'p.price_cents>=?', q.minPriceCents);
      if (q.maxPriceCents !== undefined) append(parts, values, 'p.price_cents<=?', q.maxPriceCents);
      const where = parts.join(' AND ');
      const total = await db.one(
        `SELECT COUNT(*)::int AS count ${productJoins} WHERE ${where}`,
        values,
      );
      const order = {
        newest: 'p.created_at DESC,p.id',
        price_asc: 'p.price_cents ASC,p.id',
        price_desc: 'p.price_cents DESC,p.id',
        rating: 'rating DESC,p.id',
        bestselling: 'sold_count DESC,p.id',
      }[q.sort];
      const rows = await db.query(
        `SELECT ${productColumns} ${productJoins} WHERE ${where} ORDER BY ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, q.limit, q.offset],
      );
      return list(rows.map(imageUrl), q.limit, q.offset, total!.count);
    },
  );
  route(
    'GET',
    '/api/v1/products/:id',
    { auth: false, summary: 'Read an available product', tag: 'Catalog' },
    async (req) => {
      const row = await db.one(
        `SELECT ${productColumns} ${productJoins} WHERE p.id=$1 AND ${publicAvailable}`,
        [paramsId(req)],
      );
      if (!row) fail(404, 'PRODUCT_NOT_FOUND', 'Product was not found');
      return data(camel(imageUrl(row!)));
    },
  );
  route(
    'GET',
    '/api/v1/shops',
    {
      auth: false,
      summary: 'Search approved public shops',
      tag: 'Catalog',
      query: jsonSchema(shopQuery),
    },
    async (req) => {
      const q = parse(shopQuery, req.query);
      const values = [searchPattern(q.q)];
      const where =
        "s.status='approved' AND u.blocked=false AND (s.name ILIKE $1 OR s.description ILIKE $1)";
      const count = await db.one(
        `SELECT COUNT(*)::int AS count FROM shops s JOIN users u ON u.id=s.owner_id WHERE ${where}`,
        values,
      );
      const rows = await db.query(
        `SELECT s.* FROM shops s JOIN users u ON u.id=s.owner_id WHERE ${where} ORDER BY s.created_at DESC,s.id LIMIT $2 OFFSET $3`,
        [...values, q.limit, q.offset],
      );
      return list(rows.map(publicShop), q.limit, q.offset, count!.count);
    },
  );
  route(
    'GET',
    '/api/v1/shops/:id',
    { auth: false, summary: 'Read a public shop profile', tag: 'Catalog' },
    async (req) => {
      const shop = await db.one(
        "SELECT s.* FROM shops s JOIN users u ON u.id=s.owner_id WHERE s.id=$1 AND s.status='approved' AND u.blocked=false",
        [paramsId(req)],
      );
      if (!shop) fail(404, 'SHOP_NOT_FOUND', 'Shop was not found');
      return data(camel(publicShop(shop!)));
    },
  );
  route(
    'GET',
    '/api/v1/me/shop',
    { summary: 'Read your seller application or shop', tag: 'Seller' },
    async (req) => data(camel(await ownShop(db, req.actor!))),
  );
  route(
    'POST',
    '/api/v1/me/shop',
    { summary: 'Apply to open a shop', tag: 'Seller', body: jsonSchema(shopInput) },
    async (req, reply) => {
      const input = parse(shopInput, req.body),
        actor = req.actor!;
      const shop = await db.transaction(async (tx) => {
        await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [actor.id]);
        if (await tx.one('SELECT id FROM shops WHERE owner_id=$1', [actor.id]))
          fail(409, 'SHOP_EXISTS', 'A shop application already exists; edit or resubmit it');
        const created = await tx.one(
          `INSERT INTO shops(owner_id,name,email,description,shipping_fee_cents,free_shipping_at_cents) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
          [
            actor.id,
            input.name,
            input.email,
            input.description,
            input.shippingFeeCents,
            input.freeShippingAtCents,
          ],
        );
        await audit(
          tx,
          actor,
          'shop.apply',
          'shop',
          created!.id,
          { name: input.name },
          created!.id,
        );
        for (const admin of await tx.query(
          "SELECT id FROM users WHERE role='admin' AND blocked=false",
        ))
          await notify(tx, admin.id, 'New shop application', input.name);
        return created;
      });
      reply.code(201);
      return data(camel(shop));
    },
  );
  route(
    'PATCH',
    '/api/v1/me/shop',
    {
      summary: 'Edit your shop details and shipping settings',
      tag: 'Seller',
      body: jsonSchema(shopPatch),
    },
    async (req) => {
      const input = parse(shopPatch, req.body),
        actor = req.actor!;
      return data(
        camel(
          await db.transaction(async (tx) => {
            const current = await tx.one('SELECT * FROM shops WHERE owner_id=$1 FOR UPDATE', [
              actor.id,
            ]);
            if (!current) fail(404, 'SHOP_NOT_FOUND', 'Your shop was not found');
            const merged = { ...camel(current), ...input };
            const saved = await tx.one(
              'UPDATE shops SET name=$2,email=$3,description=$4,shipping_fee_cents=$5,free_shipping_at_cents=$6,updated_at=now() WHERE id=$1 RETURNING *',
              [
                current!.id,
                merged.name,
                merged.email,
                merged.description,
                merged.shippingFeeCents,
                merged.freeShippingAtCents,
              ],
            );
            await audit(
              tx,
              actor,
              'shop.update',
              'shop',
              current!.id,
              { fields: Object.keys(input) },
              current!.id,
            );
            return saved;
          }),
        ),
      );
    },
  );
  route(
    'POST',
    '/api/v1/me/shop/resubmit',
    { summary: 'Resubmit a rejected shop application', tag: 'Seller' },
    async (req) => {
      return data(
        camel(
          await db.transaction(async (tx) => {
            const current = await tx.one('SELECT * FROM shops WHERE owner_id=$1 FOR UPDATE', [
              req.actor!.id,
            ]);
            if (!current) fail(404, 'SHOP_NOT_FOUND', 'Your shop was not found');
            if (current!.status !== 'rejected')
              fail(409, 'SHOP_NOT_REJECTED', 'Only rejected applications can be resubmitted');
            parse(shopInput, {
              name: current!.name,
              email: current!.email,
              description: current!.description,
              shippingFeeCents: Number(current!.shipping_fee_cents),
              freeShippingAtCents:
                current!.free_shipping_at_cents === null
                  ? null
                  : Number(current!.free_shipping_at_cents),
            });
            const saved = await tx.one(
              "UPDATE shops SET status='pending',review_reason=NULL,updated_at=now() WHERE id=$1 RETURNING *",
              [current!.id],
            );
            await audit(tx, req.actor!, 'shop.resubmit', 'shop', current!.id, {}, current!.id);
            for (const admin of await tx.query(
              "SELECT id FROM users WHERE role='admin' AND blocked=false",
            ))
              await notify(tx, admin.id, 'Shop application resubmitted', current!.name);
            return saved;
          }),
        ),
      );
    },
  );
  route(
    'GET',
    '/api/v1/admin/shops',
    {
      roles: ['admin'],
      summary: 'Search and filter shop applications',
      tag: 'Admin shops',
      query: jsonSchema(managedShopQuery),
    },
    async (req) => {
      const q = parse(managedShopQuery, req.query);
      const parts = ['(s.name ILIKE $1 OR s.email ILIKE $1 OR u.name ILIKE $1)'],
        values: unknown[] = [searchPattern(q.q)];
      if (q.status) append(parts, values, 's.status=?', q.status);
      const where = parts.join(' AND '),
        joins = 'FROM shops s JOIN users u ON u.id=s.owner_id';
      const total = await db.one(`SELECT COUNT(*)::int AS count ${joins} WHERE ${where}`, values);
      return list(
        await db.query(
          `SELECT s.*,u.name AS owner_name,u.blocked AS owner_blocked ${joins} WHERE ${where} ORDER BY s.created_at DESC,s.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, q.limit, q.offset],
        ),
        q.limit,
        q.offset,
        total!.count,
      );
    },
  );
  route(
    'GET',
    '/api/v1/admin/shops/:id',
    { roles: ['admin'], summary: 'Inspect a shop application', tag: 'Admin shops' },
    async (req) => {
      const shop = await db.one(
        'SELECT s.*,u.name AS owner_name,u.blocked AS owner_blocked FROM shops s JOIN users u ON u.id=s.owner_id WHERE s.id=$1',
        [paramsId(req)],
      );
      if (!shop) fail(404, 'SHOP_NOT_FOUND', 'Shop was not found');
      return data(camel(shop));
    },
  );
  route(
    'POST',
    '/api/v1/admin/shops/:id/decision',
    {
      roles: ['admin'],
      summary: 'Approve or reject a pending shop',
      tag: 'Admin shops',
      body: jsonSchema(decisionInput),
    },
    async (req) => {
      const input = parse(decisionInput, req.body),
        id = paramsId(req);
      return data(
        camel(
          await db.transaction(async (tx) => {
            const info = await tx.one('SELECT owner_id FROM shops WHERE id=$1', [id]);
            if (!info) fail(404, 'SHOP_NOT_FOUND', 'Shop was not found');
            const owner = await tx.one('SELECT id,role,blocked FROM users WHERE id=$1 FOR UPDATE', [
              info!.owner_id,
            ]);
            const shop = await tx.one('SELECT * FROM shops WHERE id=$1 FOR UPDATE', [id]);
            if (shop!.status !== 'pending')
              fail(409, 'SHOP_NOT_PENDING', 'Only pending shops can receive this decision');
            if (input.decision === 'approve' && owner!.blocked)
              fail(409, 'OWNER_BLOCKED', 'Reactivate the owner before approving the shop');
            const status = input.decision === 'approve' ? 'approved' : 'rejected';
            const saved = await tx.one(
              'UPDATE shops SET status=$2,review_reason=$3,updated_at=now() WHERE id=$1 RETURNING *',
              [id, status, input.reason || null],
            );
            if (status === 'approved' && owner!.role === 'user')
              await tx.query("UPDATE users SET role='seller',updated_at=now() WHERE id=$1", [
                owner!.id,
              ]);
            await audit(
              tx,
              req.actor!,
              'shop.' + status,
              'shop',
              id,
              { reason: input.reason || null },
              id,
            );
            await notify(
              tx,
              owner!.id,
              status === 'approved' ? 'Shop approved' : 'Shop application rejected',
              input.reason || shop!.name,
            );
            return saved;
          }),
        ),
      );
    },
  );
  route(
    'PATCH',
    '/api/v1/admin/shops/:id/status',
    {
      roles: ['admin'],
      summary: 'Suspend or reactivate an approved shop',
      tag: 'Admin shops',
      body: jsonSchema(shopStatusInput),
    },
    async (req) => {
      const input = parse(shopStatusInput, req.body),
        id = paramsId(req);
      return data(
        camel(
          await db.transaction(async (tx) => {
            const info = await tx.one('SELECT owner_id FROM shops WHERE id=$1', [id]);
            if (!info) fail(404, 'SHOP_NOT_FOUND', 'Shop was not found');
            const owner = await tx.one('SELECT id,blocked FROM users WHERE id=$1 FOR UPDATE', [
              info!.owner_id,
            ]);
            const shop = await tx.one('SELECT * FROM shops WHERE id=$1 FOR UPDATE', [id]);
            if (!['approved', 'suspended'].includes(shop!.status))
              fail(409, 'INVALID_SHOP_STATUS', 'Use the application decision endpoint first');
            if (input.status === 'approved' && owner!.blocked)
              fail(409, 'OWNER_BLOCKED', 'Reactivate the owner before reopening the shop');
            const saved = await tx.one(
              'UPDATE shops SET status=$2,review_reason=$3,updated_at=now() WHERE id=$1 RETURNING *',
              [id, input.status, input.reason || null],
            );
            await audit(
              tx,
              req.actor!,
              'shop.' + input.status,
              'shop',
              id,
              { reason: input.reason || null },
              id,
            );
            await notify(tx, owner!.id, 'Shop status updated', input.reason || input.status);
            return saved;
          }),
        ),
      );
    },
  );

  for (const area of ['seller', 'admin'] as const) {
    const roles = area === 'admin' ? ['admin' as const] : ['seller' as const, 'admin' as const];
    const prefix = '/api/v1/' + area;
    route(
      'GET',
      prefix + '/products',
      {
        roles,
        summary: `List ${area} products including inactive listings`,
        tag: 'Product management',
        query: jsonSchema(productQuery),
      },
      async (req) => {
        const q = parse(productQuery, req.query),
          parts: string[] = [],
          values: unknown[] = [];
        if (
          q.minPriceCents !== undefined &&
          q.maxPriceCents !== undefined &&
          q.minPriceCents > q.maxPriceCents
        )
          fail(400, 'INVALID_PRICE_RANGE', 'Minimum price must not exceed maximum price');
        if (area === 'seller') append(parts, values, 's.owner_id=?', req.actor!.id);
        if (q.q) {
          values.push(searchPattern(q.q));
          parts.push(`(p.name ILIKE $${values.length} OR p.english_name ILIKE $${values.length})`);
        }
        if (q.categoryId) append(parts, values, 'p.category_id=?', q.categoryId);
        if (q.shopId) append(parts, values, 'p.shop_id=?', q.shopId);
        if (q.active !== undefined) append(parts, values, 'p.active=?', q.active);
        if (q.archived !== undefined)
          parts.push(q.archived ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL');
        if (q.minPriceCents !== undefined)
          append(parts, values, 'p.price_cents>=?', q.minPriceCents);
        if (q.maxPriceCents !== undefined)
          append(parts, values, 'p.price_cents<=?', q.maxPriceCents);
        const where = parts.length ? parts.join(' AND ') : 'true';
        const total = await db.one(
          `SELECT COUNT(*)::int AS count ${productJoins} WHERE ${where}`,
          values,
        );
        const order = {
          newest: 'p.created_at DESC,p.id',
          price_asc: 'p.price_cents ASC,p.id',
          price_desc: 'p.price_cents DESC,p.id',
          rating: 'rating DESC,p.id',
          bestselling: 'sold_count DESC,p.id',
        }[q.sort];
        const rows = await db.query(
          `SELECT ${productColumns} ${productJoins} WHERE ${where} ORDER BY ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, q.limit, q.offset],
        );
        return list(rows.map(imageUrl), q.limit, q.offset, total!.count);
      },
    );
    route(
      'GET',
      prefix + '/products/:id',
      { roles, summary: 'Inspect a managed product', tag: 'Product management' },
      async (req) => {
        const actor = area === 'seller' ? { ...req.actor!, role: 'seller' as const } : req.actor!;
        return data(camel(imageUrl(await manageableProduct(db, actor, paramsId(req)))));
      },
    );
    route(
      'POST',
      prefix + '/products',
      {
        roles,
        summary: 'Create a product listing',
        tag: 'Product management',
        body: jsonSchema(area === 'admin' ? adminProductInput : productInput),
      },
      async (req, reply) => {
        const input = parse(area === 'admin' ? adminProductInput : productInput, req.body),
          actor = req.actor!;
        const created = await db.transaction(async (tx) => {
          const shop =
            area === 'admin'
              ? await tx.one('SELECT * FROM shops WHERE id=$1', [(input as Row).shopId])
              : await ownShop(tx, actor);
          if (!shop) fail(404, 'SHOP_NOT_FOUND', 'Shop was not found');
          if (shop!.status !== 'approved')
            fail(409, 'SHOP_NOT_APPROVED', 'Products can be added after shop approval');
          const owner = await tx.one('SELECT blocked FROM users WHERE id=$1', [shop!.owner_id]);
          if (owner!.blocked) fail(409, 'OWNER_BLOCKED', 'The shop owner is blocked');
          await validateProductReferences(tx, actor, input);
          const product = await tx.one(
            `INSERT INTO products(shop_id,category_id,name,english_name,description,price_cents,original_price_cents,image_id,image_index,badge,stock,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [
              shop!.id,
              input.categoryId,
              input.name,
              input.englishName,
              input.description,
              input.priceCents,
              input.originalPriceCents,
              input.imageId,
              input.imageIndex,
              input.badge,
              input.stock,
              input.active,
            ],
          );
          if (input.stock)
            await movement(tx, actor, product!, input.stock, 'Initial product stock');
          await audit(
            tx,
            actor,
            'product.create',
            'product',
            product!.id,
            { name: input.name },
            shop!.id,
          );
          return product!;
        });
        reply.code(201);
        return data(camel(imageUrl(created)));
      },
    );
    route(
      'PATCH',
      prefix + '/products/:id',
      {
        roles,
        summary: 'Edit product fields and stock',
        tag: 'Product management',
        body: jsonSchema(productPatch),
      },
      async (req) => {
        const input = parse(productPatch, req.body),
          id = paramsId(req),
          actor = area === 'seller' ? { ...req.actor!, role: 'seller' as const } : req.actor!;
        const saved = await db.transaction(async (tx) => {
          const previous = await manageableProduct(tx, actor, id, true);
          if (previous.archived_at)
            fail(409, 'PRODUCT_ARCHIVED', 'Restore the archived listing before editing it');
          const merged = { ...camel(previous), ...input };
          if (merged.active && previous.shop_status !== 'approved')
            fail(409, 'SHOP_NOT_APPROVED', 'This shop cannot publish listings');
          await validateProductReferences(tx, actor, merged, previous);
          const product = await tx.one(
            `UPDATE products SET category_id=$2,name=$3,english_name=$4,description=$5,price_cents=$6,original_price_cents=$7,image_id=$8,image_index=$9,badge=$10,stock=$11,active=$12,updated_at=now() WHERE id=$1 RETURNING *`,
            [
              id,
              merged.categoryId,
              merged.name,
              merged.englishName,
              merged.description,
              merged.priceCents,
              merged.originalPriceCents,
              merged.imageId,
              merged.imageIndex,
              merged.badge,
              merged.stock,
              merged.active,
            ],
          );
          if (product!.stock !== previous.stock)
            await movement(
              tx,
              actor,
              product!,
              product!.stock - previous.stock,
              'Stock edited with product',
            );
          await audit(
            tx,
            actor,
            'product.update',
            'product',
            id,
            { fields: Object.keys(input) },
            previous.shop_id,
          );
          return product!;
        });
        return data(camel(imageUrl(saved)));
      },
    );
    route(
      'DELETE',
      prefix + '/products/:id',
      {
        roles,
        summary: 'Archive a listing while preserving order history',
        tag: 'Product management',
      },
      async (req) => {
        const id = paramsId(req),
          actor = area === 'seller' ? { ...req.actor!, role: 'seller' as const } : req.actor!;
        return data(
          camel(
            await db.transaction(async (tx) => {
              const product = await manageableProduct(tx, actor, id, true);
              if (product.archived_at) return product;
              const archived = await tx.one(
                'UPDATE products SET active=false,archived_at=now(),updated_at=now() WHERE id=$1 RETURNING *',
                [id],
              );
              await audit(tx, actor, 'product.archive', 'product', id, {}, product.shop_id);
              return archived;
            }),
          ),
        );
      },
    );
    route(
      'POST',
      prefix + '/products/:id/restore',
      { roles, summary: 'Restore an archived listing as inactive', tag: 'Product management' },
      async (req) => {
        const id = paramsId(req),
          actor = area === 'seller' ? { ...req.actor!, role: 'seller' as const } : req.actor!;
        return data(
          camel(
            await db.transaction(async (tx) => {
              const product = await manageableProduct(tx, actor, id, true);
              if (!product.archived_at) return product;
              const restored = await tx.one(
                'UPDATE products SET active=false,archived_at=NULL,updated_at=now() WHERE id=$1 RETURNING *',
                [id],
              );
              await audit(tx, actor, 'product.restore', 'product', id, {}, product.shop_id);
              return restored;
            }),
          ),
        );
      },
    );
    route(
      'POST',
      prefix + '/products/:id/stock',
      {
        roles,
        summary: 'Apply an audited stock adjustment',
        tag: 'Product management',
        body: jsonSchema(stockInput),
      },
      async (req) => {
        const id = paramsId(req),
          input = parse(stockInput, req.body),
          actor = area === 'seller' ? { ...req.actor!, role: 'seller' as const } : req.actor!;
        return data(
          camel(
            await db.transaction(async (tx) => {
              const product = await manageableProduct(tx, actor, id, true),
                balance = product.stock + input.change;
              if (balance < 0 || (balance > 1_000_000 && input.change > 0))
                fail(
                  409,
                  'INVALID_STOCK_BALANCE',
                  'Stock cannot be negative or increased above one million; restored excess stock may be reduced',
                );
              const updated = await tx.one(
                'UPDATE products SET stock=$2,updated_at=now() WHERE id=$1 RETURNING *',
                [id, balance],
              );
              await movement(tx, actor, updated!, input.change, input.reason);
              await audit(
                tx,
                actor,
                'stock.adjust',
                'product',
                id,
                { change: input.change, balance, reason: input.reason },
                product.shop_id,
              );
              return updated;
            }),
          ),
        );
      },
    );
    for (const exporting of [false, true])
      route(
        'GET',
        prefix + '/stock-movements' + (exporting ? '/export' : ''),
        {
          roles,
          summary: exporting
            ? 'Export filtered stock movements as CSV'
            : 'List filtered stock movements',
          tag: 'Inventory',
          query: jsonSchema(stockQuery),
        },
        async (req, reply) => {
          const q = parse(stockQuery, req.query),
            parts: string[] = [],
            values: unknown[] = [];
          if (area === 'seller') append(parts, values, 's.owner_id=?', req.actor!.id);
          if (q.shopId) append(parts, values, 'm.shop_id=?', q.shopId);
          if (q.productId) append(parts, values, 'm.product_id=?', q.productId);
          dateWhere(parts, values, 'm', q);
          const where = parts.length ? parts.join(' AND ') : 'true',
            joins =
              'FROM stock_movements m JOIN shops s ON s.id=m.shop_id JOIN products p ON p.id=m.product_id';
          const rows = await db.query(
            `SELECT m.*,p.name AS product_name,s.name AS shop_name ${joins} WHERE ${where} ORDER BY m.created_at DESC,m.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
            [...values, q.limit, q.offset],
          );
          if (exporting)
            return reply
              .header('Content-Disposition', 'attachment; filename="stock-movements.csv"')
              .type('text/csv; charset=utf-8')
              .send(csv(rows.map(camel)));
          const total = await db.one(
            `SELECT COUNT(*)::int AS count ${joins} WHERE ${where}`,
            values,
          );
          return list(rows, q.limit, q.offset, total!.count);
        },
      );
  }

  route(
    'GET',
    '/api/v1/admin/categories',
    { roles: ['admin'], summary: 'List all categories with reference counts', tag: 'Categories' },
    async () =>
      data(
        camel(
          await db.query(
            'SELECT c.*,(SELECT COUNT(*)::int FROM products p WHERE p.category_id=c.id) AS product_count FROM categories c ORDER BY c.name,c.id',
          ),
        ),
      ),
  );
  route(
    'POST',
    '/api/v1/admin/categories',
    {
      roles: ['admin'],
      summary: 'Create a product category',
      tag: 'Categories',
      body: jsonSchema(categoryInput),
    },
    async (req, reply) => {
      const input = parse(categoryInput, req.body);
      const created = await db.transaction(async (tx) => {
        const row = await tx.one(
          'INSERT INTO categories(name,icon,description,active) VALUES($1,$2,$3,$4) RETURNING *',
          [input.name, input.icon, input.description, input.active],
        );
        await audit(tx, req.actor!, 'category.create', 'category', row!.id, { name: input.name });
        return row;
      });
      reply.code(201);
      return data(camel(created));
    },
  );
  route(
    'PATCH',
    '/api/v1/admin/categories/:id',
    {
      roles: ['admin'],
      summary: 'Edit category details and visibility',
      tag: 'Categories',
      body: jsonSchema(categoryPatch),
    },
    async (req) => {
      const input = parse(categoryPatch, req.body),
        id = paramsId(req);
      return data(
        camel(
          await db.transaction(async (tx) => {
            const current = await tx.one('SELECT * FROM categories WHERE id=$1 FOR UPDATE', [id]);
            if (!current) fail(404, 'CATEGORY_NOT_FOUND', 'Category was not found');
            const merged = { ...current, ...input };
            const row = await tx.one(
              'UPDATE categories SET name=$2,icon=$3,description=$4,active=$5,updated_at=now() WHERE id=$1 RETURNING *',
              [id, merged.name, merged.icon, merged.description, merged.active],
            );
            await audit(tx, req.actor!, 'category.update', 'category', id, {
              fields: Object.keys(input),
            });
            return row;
          }),
        ),
      );
    },
  );
  route(
    'DELETE',
    '/api/v1/admin/categories/:id',
    { roles: ['admin'], summary: 'Delete an unreferenced category', tag: 'Categories' },
    async (req) => {
      const id = paramsId(req);
      return data(
        await db.transaction(async (tx) => {
          const category = await tx.one('SELECT id FROM categories WHERE id=$1 FOR UPDATE', [id]);
          if (!category) fail(404, 'CATEGORY_NOT_FOUND', 'Category was not found');
          if (await tx.one('SELECT id FROM products WHERE category_id=$1 LIMIT 1', [id]))
            fail(409, 'CATEGORY_IN_USE', 'Products still reference this category; hide it instead');
          await tx.query('DELETE FROM categories WHERE id=$1', [id]);
          await audit(tx, req.actor!, 'category.delete', 'category', id);
          return { deleted: true };
        }),
      );
    },
  );

  for (const exporting of [false, true])
    route(
      'GET',
      '/api/v1/admin/users' + (exporting ? '/export' : ''),
      {
        roles: ['admin'],
        summary: exporting ? 'Export filtered members as CSV' : 'Search members by role and status',
        tag: 'Members',
        query: jsonSchema(memberQuery),
      },
      async (req, reply) => {
        const q = parse(memberQuery, req.query),
          parts = ['(u.name ILIKE $1 OR u.email ILIKE $1 OR u.phone ILIKE $1)'],
          values: unknown[] = [searchPattern(q.q)];
        if (q.role) append(parts, values, 'u.role=?', q.role);
        if (q.blocked !== undefined) append(parts, values, 'u.blocked=?', q.blocked);
        const where = parts.join(' AND ');
        const rows = await db.query(
          `SELECT ${memberColumns},s.id AS shop_id,s.name AS shop_name FROM users u LEFT JOIN shops s ON s.owner_id=u.id WHERE ${where} ORDER BY u.created_at DESC,u.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, q.limit, q.offset],
        );
        if (exporting)
          return reply
            .header('Content-Disposition', 'attachment; filename="members.csv"')
            .type('text/csv; charset=utf-8')
            .send(csv(rows.map(camel)));
        const total = await db.one(
          `SELECT COUNT(*)::int AS count FROM users u WHERE ${where}`,
          values,
        );
        return list(rows, q.limit, q.offset, total!.count);
      },
    );
  route(
    'GET',
    '/api/v1/admin/users/:id',
    { roles: ['admin'], summary: 'Inspect member profile and purchase totals', tag: 'Members' },
    async (req) => {
      const id = paramsId(req),
        user = await db.one(
          `SELECT ${memberColumns},s.id AS shop_id,s.name AS shop_name FROM users u LEFT JOIN shops s ON s.owner_id=u.id WHERE u.id=$1`,
          [id],
        );
      if (!user) fail(404, 'USER_NOT_FOUND', 'Member was not found');
      const purchases = await db.one(
        "SELECT COUNT(*)::int AS order_count,COALESCE(SUM(CASE WHEN payment_status='paid' AND status<>'cancelled' THEN total_cents ELSE 0 END),0)::bigint AS paid_purchase_cents FROM orders WHERE buyer_id=$1",
        [id],
      );
      return data(camel({ ...user, ...purchases }));
    },
  );
  route(
    'PATCH',
    '/api/v1/admin/users/:id/status',
    {
      roles: ['admin'],
      summary: 'Block or reactivate a member and revoke blocked sessions',
      tag: 'Members',
      body: jsonSchema(memberStatusInput),
    },
    async (req) => {
      const input = parse(memberStatusInput, req.body),
        id = paramsId(req),
        actor = req.actor!;
      if (input.blocked && id === actor.id)
        fail(409, 'SELF_BLOCK_NOT_ALLOWED', 'You cannot block your own administrator account');
      return data(
        camel(
          await db.transaction(async (tx) => {
            // Lock administrators in stable order before the target to protect the last active administrator.
            const admins = await tx.query(
              "SELECT id,blocked FROM users WHERE role='admin' ORDER BY id FOR UPDATE",
            );
            const target = await tx.one(
              'SELECT id,role,blocked FROM users WHERE id=$1 FOR UPDATE',
              [id],
            );
            if (!target) fail(404, 'USER_NOT_FOUND', 'Member was not found');
            if (
              input.blocked &&
              target!.role === 'admin' &&
              !target!.blocked &&
              admins.filter((a) => !a.blocked).length <= 1
            )
              fail(409, 'LAST_ADMIN', 'At least one active administrator is required');
            const user = await tx.one(
              'UPDATE users SET blocked=$2,updated_at=now() WHERE id=$1 RETURNING id,name,email,phone,address,role,blocked,email_verified,created_at,updated_at',
              [id, input.blocked],
            );
            if (input.blocked) {
              await tx.query('DELETE FROM sessions WHERE user_id=$1', [id]);
              const shops = await tx.query(
                "UPDATE shops SET status='suspended',review_reason=$2,updated_at=now() WHERE owner_id=$1 AND status='approved' RETURNING id",
                [id, 'Account blocked: ' + input.reason],
              );
              for (const shop of shops)
                await audit(
                  tx,
                  actor,
                  'shop.suspended',
                  'shop',
                  shop.id,
                  { reason: 'Owner account blocked' },
                  shop.id,
                );
            }
            await audit(
              tx,
              actor,
              input.blocked ? 'member.block' : 'member.reactivate',
              'user',
              id,
              { reason: input.reason },
            );
            await notify(
              tx,
              id,
              input.blocked ? 'Account blocked' : 'Account reactivated',
              input.reason,
            );
            return user;
          }),
        ),
      );
    },
  );
  route(
    'GET',
    '/api/v1/admin/audit-events',
    {
      roles: ['admin'],
      summary: 'Read filtered server audit events',
      tag: 'Administration',
      query: jsonSchema(auditQuery),
    },
    async (req) => {
      const q = parse(auditQuery, req.query),
        parts: string[] = [],
        values: unknown[] = [];
      if (q.action) append(parts, values, 'a.action=?', q.action);
      if (q.entity) append(parts, values, 'a.entity=?', q.entity);
      if (q.shopId) append(parts, values, 'a.shop_id=?', q.shopId);
      dateWhere(parts, values, 'a', q);
      const where = parts.length ? parts.join(' AND ') : 'true';
      const rows = await db.query(
        `SELECT a.*,u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE ${where} ORDER BY a.created_at DESC,a.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, q.limit, q.offset],
      );
      const total = await db.one(
        `SELECT COUNT(*)::int AS count FROM audit_events a WHERE ${where}`,
        values,
      );
      return list(rows, q.limit, q.offset, total!.count);
    },
  );
  route(
    'POST',
    '/api/v1/visits',
    {
      auth: false,
      summary: 'Record an anonymous aggregate page view',
      tag: 'Usage',
      body: jsonSchema(visitInput),
      rateLimit: 30,
    },
    async (req, reply) => {
      const input = parse(visitInput, req.body);
      await db.query('INSERT INTO page_visits(page) VALUES($1)', [input.page]);
      reply.code(202);
      return data({ recorded: true });
    },
  );
  route(
    'GET',
    '/api/v1/admin/usage',
    {
      roles: ['admin'],
      summary: 'Summarize recorded page views by Bangkok date',
      tag: 'Administration',
      query: jsonSchema(usageQuery),
    },
    async (req) => {
      const q = parse(usageQuery, req.query),
        parts: string[] = [],
        values: unknown[] = [];
      dateWhere(parts, values, 'v', q);
      const where = parts.length ? parts.join(' AND ') : "v.created_at >= now()-interval '30 days'";
      const rows = await db.query(
        `SELECT (v.created_at AT TIME ZONE 'Asia/Bangkok')::date::text AS day,v.page,COUNT(*)::int AS views FROM page_visits v WHERE ${where} GROUP BY day,v.page ORDER BY day DESC,v.page LIMIT 5001`,
        values,
      );
      if (rows.length > 5000)
        fail(
          422,
          'USAGE_REPORT_TOO_LARGE',
          'The usage report exceeds 5000 day/page groups; select a narrower date range',
          { maxGroups: 5000 },
        );
      return data(camel(rows));
    },
  );
  route(
    'GET',
    '/api/v1/settings',
    { auth: false, summary: 'Read public site settings', tag: 'Site settings' },
    async () => {
      const row = await db.one("SELECT value FROM settings WHERE key='site'");
      return data(
        row?.value ?? {
          siteTitle: 'Bloom',
          siteNotice: 'A LITTLE SELF-CARE, EVERY DAY',
          contactEmail: '',
        },
      );
    },
  );
  route(
    'GET',
    '/api/v1/admin/settings',
    { roles: ['admin'], summary: 'Read editable site settings', tag: 'Site settings' },
    async () => {
      const row = await db.one("SELECT value FROM settings WHERE key='site'");
      return data(
        row?.value ?? {
          siteTitle: 'Bloom',
          siteNotice: 'A LITTLE SELF-CARE, EVERY DAY',
          contactEmail: '',
        },
      );
    },
  );
  route(
    'PATCH',
    '/api/v1/admin/settings',
    {
      roles: ['admin'],
      summary: 'Update public site title, notice and contact',
      tag: 'Site settings',
      body: jsonSchema(settingsInput),
    },
    async (req) => {
      const input = parse(settingsInput, req.body);
      return data(
        await db.transaction(async (tx) => {
          const row = await tx.one(
            `INSERT INTO settings(key,value) VALUES('site',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=settings.value || EXCLUDED.value,updated_at=now() RETURNING value`,
            [JSON.stringify(input)],
          );
          await audit(tx, req.actor!, 'settings.update', 'settings', 'site', {
            fields: Object.keys(input),
          });
          return row!.value;
        }),
      );
    },
  );
};
