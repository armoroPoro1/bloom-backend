import { randomUUID } from 'node:crypto';
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
  page,
  paramsId,
  parse,
} from '../core/http.js';
import {
  calculateQuote,
  integer,
  requestHash,
  salesSummary,
  thaiDate,
  type Coupon,
  type QuoteProduct,
} from './commerce-domain.js';
import {
  recordOrderEvent as event,
  cancelLockedOrder,
  expireLockedOrderIfDue,
  expireUnpaidOrders,
} from './commerce-lifecycle.js';

const uuid = z.string().uuid();
const money = z.number().int().min(0).max(1_000_000_000);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      v.slice(0, 4) !== '0000' &&
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    'Invalid calendar date',
  );
const addressBody = z
  .object({
    label: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(150),
    phone: z.string().trim().min(6).max(30),
    address: z.string().trim().min(5).max(2000),
    isDefault: z.boolean().default(false),
  })
  .strict();
const cartBody = z.object({ quantity: z.number().int().min(0).max(1000) }).strict();
const quoteBody = z.object({ couponCode: z.string().trim().max(40).default('') }).strict();
const checkoutBody = z
  .object({
    addressId: uuid,
    couponCode: z.string().trim().max(40).default(''),
    paymentMethod: z.enum(['transfer', 'development']).default('transfer'),
    proofUploadId: uuid.optional(),
  })
  .strict();
const promotionBody = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_-]{3,40}$/)
      .transform((v) => v.toUpperCase()),
    title: z.string().trim().min(1).max(200),
    shopId: uuid.nullable().optional(),
    percent: z.number().min(0.01).max(100).multipleOf(0.01),
    active: z.boolean().default(true),
    startsAt: day.nullable().optional(),
    endsAt: day.nullable().optional(),
    minSpendCents: money.default(0),
    maxDiscountCents: money.positive().nullable().optional(),
    usageLimit: z.number().int().min(1).max(10000000).nullable().optional(),
  })
  .strict()
  .refine((v) => !v.startsAt || !v.endsAt || v.startsAt <= v.endsAt, {
    message: 'End date must follow start date',
    path: ['endsAt'],
  });
const statuses = ['pending', 'paid', 'preparing', 'shipped', 'delivered', 'cancelled'] as const;
const payStatuses = [
  'unpaid',
  'awaiting_review',
  'rejected',
  'paid',
  'refund_pending',
  'refunded',
] as const;
const orderQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).max(1000000).optional(),
    q: z.string().trim().max(120).optional(),
    status: z.enum(statuses).optional(),
    paymentStatus: z.enum(payStatuses).optional(),
    shopId: uuid.optional(),
    dateFrom: day.optional(),
    dateTo: day.optional(),
    sort: z.enum(['newest', 'oldest']).default('newest'),
  })
  .strict()
  .refine((v) => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo, {
    message: 'Date range is reversed',
    path: ['dateTo'],
  });

async function buyerLock(tx: Sql, id: string) {
  const user = await tx.one('SELECT id,blocked FROM users WHERE id=$1 FOR UPDATE', [id]);
  if (!user || user.blocked)
    fail(403, 'ACCOUNT_UNAVAILABLE', 'This account cannot perform this action');
}
async function ownedShop(tx: Sql, actor: Actor) {
  const shop = await tx.one('SELECT * FROM shops WHERE owner_id=$1', [actor.id]);
  if (!shop) fail(404, 'SHOP_NOT_FOUND', 'Shop not found');
  return shop!;
}
async function ensureProof(tx: Sql, id: string, userId: string) {
  const proof = await tx.one(
    "SELECT id FROM uploads WHERE id=$1 AND owner_id=$2 AND kind='proof'",
    [id, userId],
  );
  if (!proof) fail(422, 'INVALID_PROOF', 'Upload a payment proof belonging to this account');
}
async function ensurePublicProduct(tx: Sql, id: string) {
  const product = await tx.one(
    "SELECT p.id FROM products p JOIN shops s ON s.id=p.shop_id JOIN categories c ON c.id=p.category_id JOIN users u ON u.id=s.owner_id WHERE p.id=$1 AND p.active AND p.archived_at IS NULL AND s.status='approved' AND c.active AND NOT u.blocked",
    [id],
  );
  if (!product) fail(404, 'PRODUCT_NOT_FOUND', 'Product not found');
}
async function orderAccess(tx: Sql, actor: Actor, id: string, lock = false) {
  const order = await tx.one(
    `SELECT o.*,s.owner_id AS shop_owner_id,s.name AS shop_name FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id=$1 ${lock ? 'FOR UPDATE OF o' : ''}`,
    [id],
  );
  if (
    !order ||
    !(
      actor.role === 'admin' ||
      order.buyer_id === actor.id ||
      (actor.role === 'seller' && order.shop_owner_id === actor.id)
    )
  )
    fail(404, 'ORDER_NOT_FOUND', 'Order not found');
  return order!;
}
async function orderDetail(tx: Sql, actor: Actor, id: string) {
  const order = await orderAccess(tx, actor, id);
  delete order.shop_owner_id;
  const items = await tx.query(
    'SELECT id,product_id,name,unit_price_cents,quantity,image_id,image_index FROM order_items WHERE order_id=$1 ORDER BY id',
    [id],
  );
  const events = await tx.query(
    'SELECT e.id,e.status,e.label,e.detail,e.created_at,u.name AS actor_name FROM order_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.order_id=$1 ORDER BY e.created_at,e.id',
    [id],
  );
  if (actor.role === 'seller' && actor.id !== order.buyer_id) {
    delete order.proof_upload_id;
    delete order.payment_note;
    delete order.refund_reference;
    delete order.payment_reference;
    delete order.payment_received_at;
    for (const e of events)
      if (String(e.detail?.code ?? '').startsWith('payment.')) e.detail = { code: e.detail.code };
  }
  return camel({ ...order, items, events });
}
async function cartProducts(tx: Sql, userId: string, lock = false) {
  const cart = await tx.query(
    'SELECT product_id,quantity FROM cart_items WHERE user_id=$1 ORDER BY product_id',
    [userId],
  );
  if (!cart.length) fail(422, 'EMPTY_CART', 'Your cart is empty');
  if (cart.length > 100) fail(422, 'CART_TOO_LARGE', 'A checkout supports at most 100 products');
  const ids = cart.map((i) => i.product_id);
  if (lock) {
    await tx.query('SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
      ids,
    ]);
    await tx.query(
      'SELECT id FROM shops WHERE id IN (SELECT shop_id FROM products WHERE id=ANY($1::uuid[])) ORDER BY id FOR SHARE',
      [ids],
    );
    await tx.query(
      'SELECT id FROM categories WHERE id IN (SELECT category_id FROM products WHERE id=ANY($1::uuid[])) ORDER BY id FOR SHARE',
      [ids],
    );
  }
  const products = await tx.query(
    `SELECT p.*,ci.quantity,s.shipping_fee_cents,s.free_shipping_at_cents,s.status AS shop_status,c.active AS category_active,u.blocked AS seller_blocked
  FROM cart_items ci JOIN products p ON p.id=ci.product_id JOIN shops s ON s.id=p.shop_id JOIN users u ON u.id=s.owner_id JOIN categories c ON c.id=p.category_id WHERE ci.user_id=$1 ORDER BY p.id`,
    [userId],
  );
  for (const p of products)
    if (
      !p.active ||
      p.archived_at ||
      p.shop_status !== 'approved' ||
      !p.category_active ||
      p.seller_blocked ||
      p.stock < p.quantity
    )
      fail(409, 'PRODUCT_UNAVAILABLE', 'A product is unavailable or has insufficient stock', {
        productId: p.id,
      });
  return products as QuoteProduct[];
}
async function couponFor(tx: Sql, code: string, lock = false) {
  if (!code) return undefined;
  const coupon = await tx.one(
    `SELECT * FROM promotions WHERE code=$1 ${lock ? 'FOR UPDATE' : ''}`,
    [code.toUpperCase()],
  );
  if (!coupon) fail(422, 'COUPON_UNAVAILABLE', 'Promotion code not found');
  return coupon as Coupon;
}
function orderFilter(actor: Actor, scope: 'buyer' | 'seller' | 'admin', query: unknown) {
  const q = parse(orderQuery, query ?? {});
  const args: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, value: unknown) => {
    args.push(value);
    where.push(sql.replace('?', `$${args.length}`));
  };
  if (scope === 'buyer') add('o.buyer_id=?', actor.id);
  if (scope === 'seller') add('s.owner_id=?', actor.id);
  if (q.status) add('o.status=?', q.status);
  if (q.paymentStatus) add('o.payment_status=?', q.paymentStatus);
  if (q.shopId) add('o.shop_id=?', q.shopId);
  if (q.dateFrom)
    add("o.created_at >= (?::date::timestamp AT TIME ZONE 'Asia/Bangkok')", q.dateFrom);
  if (q.dateTo)
    add("o.created_at < ((?::date+1)::timestamp AT TIME ZONE 'Asia/Bangkok')", q.dateTo);
  if (q.q) {
    args.push(`%${q.q.replace(/[\\%_]/g, '\\$&')}%`);
    const p = `$${args.length}`;
    where.push(
      `(o.number ILIKE ${p} OR o.tracking ILIKE ${p} OR s.name ILIKE ${p} OR EXISTS(SELECT 1 FROM order_items oi WHERE oi.order_id=o.id AND oi.name ILIKE ${p}))`,
    );
  }
  return {
    q,
    args,
    where: where.length ? 'WHERE ' + where.join(' AND ') : '',
    direction: q.sort === 'oldest' ? 'ASC' : 'DESC',
  };
}
function promoView(p: Row) {
  const r = camel(p);
  r.percent = Number(p.percent_basis_points) / 100;
  delete r.percentBasisPoints;
  return r;
}
async function promotionScope(tx: Sql, actor: Actor, id: string, lock = false) {
  const p = await tx.one(
    `SELECT p.*,s.owner_id AS owner_id FROM promotions p LEFT JOIN shops s ON s.id=p.shop_id WHERE p.id=$1 ${lock ? 'FOR UPDATE OF p' : ''}`,
    [id],
  );
  if (!p || !(actor.role === 'admin' || (actor.role === 'seller' && p.owner_id === actor.id)))
    fail(404, 'PROMOTION_NOT_FOUND', 'Promotion not found');
  return p!;
}

export const registerCommerce: Module = async (_app, ctx, route) => {
  const { db, config } = ctx;

  route(
    'GET',
    '/api/v1/me/addresses',
    { summary: 'List account shipping addresses', tag: 'Addresses' },
    async (req) =>
      data(
        camel(
          await db.query(
            'SELECT * FROM addresses WHERE user_id=$1 ORDER BY is_default DESC,created_at',
            [req.actor!.id],
          ),
        ),
      ),
  );
  route(
    'POST',
    '/api/v1/me/addresses',
    { summary: 'Create a shipping address', tag: 'Addresses', body: jsonSchema(addressBody) },
    async (req, reply) => {
      const b = parse(addressBody, req.body);
      const a = req.actor!;
      const row = await db.transaction(async (tx) => {
        await buyerLock(tx, a.id);
        const existing = await tx.query('SELECT id FROM addresses WHERE user_id=$1', [a.id]);
        if (existing.length >= 20) fail(422, 'ADDRESS_LIMIT', 'At most 20 addresses are allowed');
        const def = b.isDefault || !existing.length;
        if (def) await tx.query('UPDATE addresses SET is_default=false WHERE user_id=$1', [a.id]);
        return tx.one(
          'INSERT INTO addresses(user_id,label,name,phone,address,is_default) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
          [a.id, b.label, b.name, b.phone, b.address, def],
        );
      });
      reply.code(201);
      return data(camel(row));
    },
  );
  route(
    'PUT',
    '/api/v1/me/addresses/:id',
    {
      summary: 'Update an owned shipping address',
      tag: 'Addresses',
      body: jsonSchema(addressBody),
    },
    async (req) => {
      const id = paramsId(req);
      const b = parse(addressBody, req.body);
      return data(
        camel(
          await db.transaction(async (tx) => {
            await buyerLock(tx, req.actor!.id);
            const existing = await tx.one('SELECT * FROM addresses WHERE id=$1 AND user_id=$2', [
              id,
              req.actor!.id,
            ]);
            if (!existing) fail(404, 'ADDRESS_NOT_FOUND', 'Address not found');
            if (b.isDefault)
              await tx.query('UPDATE addresses SET is_default=false WHERE user_id=$1', [
                req.actor!.id,
              ]);
            return tx.one(
              'UPDATE addresses SET label=$1,name=$2,phone=$3,address=$4,is_default=$5,updated_at=now() WHERE id=$6 RETURNING *',
              [b.label, b.name, b.phone, b.address, b.isDefault || existing!.is_default, id],
            );
          }),
        ),
      );
    },
  );
  route(
    'DELETE',
    '/api/v1/me/addresses/:id',
    { summary: 'Remove an owned address; order snapshots are preserved', tag: 'Addresses' },
    async (req) => {
      const id = paramsId(req);
      await db.transaction(async (tx) => {
        await buyerLock(tx, req.actor!.id);
        const row = await tx.one('DELETE FROM addresses WHERE id=$1 AND user_id=$2 RETURNING *', [
          id,
          req.actor!.id,
        ]);
        if (!row) fail(404, 'ADDRESS_NOT_FOUND', 'Address not found');
        if (row!.is_default)
          await tx.query(
            'UPDATE addresses SET is_default=true WHERE id=(SELECT id FROM addresses WHERE user_id=$1 ORDER BY created_at LIMIT 1)',
            [req.actor!.id],
          );
      });
      return data({ deleted: true });
    },
  );

  route(
    'GET',
    '/api/v1/me/cart',
    { summary: 'List cart with current availability', tag: 'Cart' },
    async (req) =>
      data(
        camel(
          await db.query(
            `SELECT ci.product_id,ci.quantity,p.name,p.price_cents,p.stock,p.image_id,p.image_index,p.shop_id,
 (p.active AND p.archived_at IS NULL AND s.status='approved' AND c.active AND NOT u.blocked) AS available
 FROM cart_items ci JOIN products p ON p.id=ci.product_id JOIN shops s ON s.id=p.shop_id JOIN categories c ON c.id=p.category_id JOIN users u ON u.id=s.owner_id WHERE ci.user_id=$1 ORDER BY ci.updated_at`,
            [req.actor!.id],
          ),
        ),
      ),
  );
  route(
    'PUT',
    '/api/v1/me/cart/:id',
    { summary: 'Set quantity; zero removes a cart item', tag: 'Cart', body: jsonSchema(cartBody) },
    async (req) => {
      const id = paramsId(req),
        b = parse(cartBody, req.body),
        a = req.actor!;
      await db.transaction(async (tx) => {
        await buyerLock(tx, a.id);
        if (!b.quantity) {
          await tx.query('DELETE FROM cart_items WHERE user_id=$1 AND product_id=$2', [a.id, id]);
          return;
        }
        const p = await tx.one(
          `SELECT p.*,s.status,c.active AS category_active,u.blocked FROM products p JOIN shops s ON s.id=p.shop_id JOIN categories c ON c.id=p.category_id JOIN users u ON u.id=s.owner_id WHERE p.id=$1`,
          [id],
        );
        if (
          !p ||
          !p.active ||
          p.archived_at ||
          p.status !== 'approved' ||
          !p.category_active ||
          p.blocked ||
          p.stock < b.quantity
        )
          fail(409, 'PRODUCT_UNAVAILABLE', 'Product or quantity unavailable');
        const count = await tx.one('SELECT count(*) AS total FROM cart_items WHERE user_id=$1', [
          a.id,
        ]);
        const has = await tx.one(
          'SELECT product_id FROM cart_items WHERE user_id=$1 AND product_id=$2',
          [a.id, id],
        );
        if (Number(count?.total) >= 100 && !has)
          fail(422, 'CART_TOO_LARGE', 'At most 100 products per cart');
        await tx.query(
          'INSERT INTO cart_items(user_id,product_id,quantity) VALUES($1,$2,$3) ON CONFLICT(user_id,product_id) DO UPDATE SET quantity=excluded.quantity,updated_at=now()',
          [a.id, id, b.quantity],
        );
      });
      return data({ productId: id, quantity: b.quantity });
    },
  );
  route(
    'DELETE',
    '/api/v1/me/cart',
    { summary: 'Clear the account cart', tag: 'Cart' },
    async (req) => {
      await db.transaction(async (tx) => {
        await buyerLock(tx, req.actor!.id);
        await tx.query('DELETE FROM cart_items WHERE user_id=$1', [req.actor!.id]);
      });
      return data({ cleared: true });
    },
  );
  const mergeBody = z
    .object({
      items: z
        .array(z.object({ productId: uuid, quantity: z.number().int().min(1).max(1000) }).strict())
        .max(100),
    })
    .strict();
  route(
    'POST',
    '/api/v1/me/cart/merge',
    {
      summary: 'Merge guest cart after login, clipping to available stock',
      tag: 'Cart',
      body: jsonSchema(mergeBody),
    },
    async (req) => {
      const b = parse(mergeBody, req.body),
        a = req.actor!;
      return data(
        await db.transaction(async (tx) => {
          await buyerLock(tx, a.id);
          const items = new Map<string, number>();
          for (const item of b.items)
            items.set(item.productId, (items.get(item.productId) ?? 0) + item.quantity);
          const skipped: string[] = [];
          const existing = await tx.query(
            'SELECT product_id,quantity FROM cart_items WHERE user_id=$1',
            [a.id],
          );
          const ids = new Set(existing.map((i) => i.product_id));
          for (const [id, quantity] of [...items].sort(([a], [b]) => a.localeCompare(b))) {
            const p = await tx.one(
              `SELECT p.*,s.status,c.active AS category_active,u.blocked FROM products p JOIN shops s ON s.id=p.shop_id JOIN categories c ON c.id=p.category_id JOIN users u ON u.id=s.owner_id WHERE p.id=$1`,
              [id],
            );
            if (
              !p ||
              !p.active ||
              p.archived_at ||
              p.status !== 'approved' ||
              !p.category_active ||
              p.blocked ||
              p.stock < 1 ||
              (!ids.has(id) && ids.size >= 100)
            ) {
              skipped.push(id);
              continue;
            }
            const q = Math.min(
              1000,
              p.stock,
              quantity + Number(existing.find((i) => i.product_id === id)?.quantity ?? 0),
            );
            await tx.query(
              'INSERT INTO cart_items(user_id,product_id,quantity) VALUES($1,$2,$3) ON CONFLICT(user_id,product_id) DO UPDATE SET quantity=excluded.quantity,updated_at=now()',
              [a.id, id, q],
            );
            ids.add(id);
          }
          return { merged: true, skippedProductIds: skipped };
        }),
      );
    },
  );

  route(
    'GET',
    '/api/v1/me/wishlist',
    { summary: 'List available saved products', tag: 'Wishlist' },
    async (req) => {
      const p = page(req);
      const rows = await db.query(
        `SELECT p.id AS product_id,p.name,p.price_cents,p.image_id,p.image_index,p.stock,p.shop_id,w.created_at FROM wishlists w JOIN products p ON p.id=w.product_id JOIN shops s ON s.id=p.shop_id JOIN categories c ON c.id=p.category_id JOIN users u ON u.id=s.owner_id WHERE w.user_id=$1 AND p.active AND p.archived_at IS NULL AND s.status='approved' AND c.active AND NOT u.blocked ORDER BY w.created_at DESC LIMIT $2 OFFSET $3`,
        [req.actor!.id, p.limit, p.offset],
      );
      return list(rows, p.limit, p.offset);
    },
  );
  route(
    'PUT',
    '/api/v1/me/wishlist/:id',
    { summary: 'Save a product', tag: 'Wishlist' },
    async (req) => {
      const id = paramsId(req);
      await db.transaction(async (tx) => {
        await ensurePublicProduct(tx, id);
        await tx.query(
          'INSERT INTO wishlists(user_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [req.actor!.id, id],
        );
      });
      return data({ saved: true });
    },
  );
  route(
    'DELETE',
    '/api/v1/me/wishlist/:id',
    { summary: 'Remove a saved product', tag: 'Wishlist' },
    async (req) => {
      await db.query('DELETE FROM wishlists WHERE user_id=$1 AND product_id=$2', [
        req.actor!.id,
        paramsId(req),
      ]);
      return data({ saved: false });
    },
  );

  route(
    'POST',
    '/api/v1/checkout/quote',
    {
      summary: 'Recalculate price, shipping and coupon on the server',
      tag: 'Checkout',
      body: jsonSchema(quoteBody),
    },
    async (req) => {
      const b = parse(quoteBody, req.body);
      await expireUnpaidOrders(ctx);
      return data(
        await db.transaction(async (tx) =>
          calculateQuote(await cartProducts(tx, req.actor!.id), await couponFor(tx, b.couponCode)),
        ),
      );
    },
  );
  route(
    'POST',
    '/api/v1/checkout',
    {
      summary: 'Atomic checkout; requires Idempotency-Key header',
      tag: 'Checkout',
      body: jsonSchema(checkoutBody),
      rateLimit: 30,
    },
    async (req, reply) => {
      const b = parse(checkoutBody, req.body),
        a = req.actor!;
      const key = parse(z.string().trim().min(8).max(128), req.headers['idempotency-key']);
      const hash = requestHash(b);
      await expireUnpaidOrders(ctx);
      const result = await db.transaction(async (tx) => {
        await buyerLock(tx, a.id);
        const previous = await tx.one(
          'SELECT * FROM checkout_requests WHERE buyer_id=$1 AND idempotency_key=$2',
          [a.id, key],
        );
        if (previous) {
          if (previous.request_hash !== hash)
            fail(409, 'IDEMPOTENCY_CONFLICT', 'This key was already used for a different request');
          const ids = await tx.query(
            'SELECT o.id FROM orders o WHERE o.checkout_id=$1 ORDER BY (SELECT min(i.product_id::text) FROM order_items i WHERE i.order_id=o.id),o.id',
            [previous.checkout_id],
          );
          const orders = await Promise.all(ids.map((o) => orderDetail(tx, a, o.id)));
          // Reconstruct the original quote from immutable order/item snapshots, not the current catalogue.
          const groups = orders.map((order) => ({
            shopId: order.shopId,
            items: [...order.items]
              .sort((left, right) => left.productId.localeCompare(right.productId))
              .map((item) => ({
                productId: item.productId,
                name: item.name,
                unitPriceCents: item.unitPriceCents,
                quantity: item.quantity,
                imageId: item.imageId,
                imageIndex: item.imageIndex,
              })),
            subtotalCents: order.subtotalCents,
            shippingCents: order.shippingCents,
            discountCents: order.discountCents,
            totalCents: order.totalCents,
          }));
          const sum = (field: 'subtotalCents' | 'shippingCents' | 'discountCents' | 'totalCents') =>
            integer(groups.reduce((total, group) => total + group[field], 0));
          return {
            checkoutId: previous.checkout_id,
            replayed: true,
            groups,
            subtotalCents: sum('subtotalCents'),
            shippingCents: sum('shippingCents'),
            discountCents: sum('discountCents'),
            totalCents: sum('totalCents'),
            couponCode: b.couponCode.toUpperCase() || null,
            orders,
          };
        }
        if (b.paymentMethod === 'development' && !config.allowDevPayments)
          fail(422, 'PAYMENT_METHOD_DISABLED', 'Development payments are disabled');
        const address = await tx.one(
          'SELECT label,name,phone,address FROM addresses WHERE id=$1 AND user_id=$2',
          [b.addressId, a.id],
        );
        if (!address) fail(422, 'ADDRESS_NOT_FOUND', 'Choose an address belonging to this account');
        if (b.proofUploadId) await ensureProof(tx, b.proofUploadId, a.id);
        if (b.proofUploadId && b.paymentMethod !== 'transfer')
          fail(422, 'INVALID_PROOF', 'Proof is only accepted for transfer payments');
        const products = await cartProducts(tx, a.id, true),
          coupon = await couponFor(tx, b.couponCode, true),
          quote = calculateQuote(products, coupon);
        const checkoutId = randomUUID();
        await tx.query('INSERT INTO checkout_groups(id,buyer_id,promotion_id) VALUES($1,$2,$3)', [
          checkoutId,
          a.id,
          coupon?.id ?? null,
        ]);
        const ids: string[] = [];
        for (const g of quote.groups) {
          const id = randomUUID(),
            number =
              'BL-' + Date.now().toString(36).toUpperCase() + '-' + id.slice(0, 8).toUpperCase();
          const method = g.totalCents === 0 ? 'no_charge' : b.paymentMethod;
          const status = method === 'development' || method === 'no_charge' ? 'paid' : 'pending',
            paymentStatus =
              method === 'development' || method === 'no_charge'
                ? 'paid'
                : b.proofUploadId
                  ? 'awaiting_review'
                  : 'unpaid';
          const order = await tx.one(
            "INSERT INTO orders(id,number,checkout_id,buyer_id,shop_id,status,payment_status,payment_method,address_snapshot,subtotal_cents,shipping_cents,discount_cents,total_cents,coupon_code,proof_upload_id,payment_due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CASE WHEN $7='unpaid' THEN now()+($16::integer*interval '1 minute') ELSE NULL END) RETURNING *",
            [
              id,
              number,
              checkoutId,
              a.id,
              g.shopId,
              status,
              paymentStatus,
              method,
              JSON.stringify(address),
              g.subtotalCents,
              g.shippingCents,
              g.discountCents,
              g.totalCents,
              g.discountCents ? coupon?.code : null,
              method === 'transfer' ? (b.proofUploadId ?? null) : null,
              config.paymentReservationMinutes,
            ],
          );
          for (const item of g.items) {
            await tx.query(
              'INSERT INTO order_items(order_id,product_id,name,unit_price_cents,quantity,image_id,image_index) VALUES($1,$2,$3,$4,$5,$6,$7)',
              [
                id,
                item.productId,
                item.name,
                item.unitPriceCents,
                item.quantity,
                item.imageId,
                item.imageIndex,
              ],
            );
            const p = await tx.one(
              'UPDATE products SET stock=stock-$1,updated_at=now() WHERE id=$2 AND stock >= $1 RETURNING stock',
              [item.quantity, item.productId],
            );
            if (!p) fail(409, 'INSUFFICIENT_STOCK', 'Stock changed during checkout');
            await tx.query(
              'INSERT INTO stock_movements(product_id,shop_id,change,balance,reason,actor_id,order_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
              [item.productId, g.shopId, -item.quantity, p!.stock, 'checkout', a.id, id],
            );
          }
          if (method === 'transfer' && b.proofUploadId)
            await tx.query(
              "INSERT INTO order_payment_proofs(order_id,upload_id,status) VALUES($1,$2,'submitted')",
              [id, b.proofUploadId],
            );
          await event(tx, a, order!, 'order.created', { paymentMethod: method });
          ids.push(id);
        }
        if (coupon) {
          await tx.query(
            'UPDATE promotions SET used_count=used_count+1,updated_at=now() WHERE id=$1',
            [coupon.id],
          );
          await tx.query(
            'INSERT INTO promotion_uses(promotion_id,checkout_id,buyer_id) VALUES($1,$2,$3)',
            [coupon.id, checkoutId, a.id],
          );
        }
        await tx.query('DELETE FROM cart_items WHERE user_id=$1', [a.id]);
        await tx.query(
          'INSERT INTO checkout_requests(buyer_id,idempotency_key,request_hash,checkout_id) VALUES($1,$2,$3,$4)',
          [a.id, key, hash, checkoutId],
        );
        return {
          checkoutId,
          replayed: false,
          ...quote,
          orders: await Promise.all(ids.map((id) => orderDetail(tx, a, id))),
        };
      });
      reply.code(result.replayed ? 200 : 201);
      return data(result);
    },
  );

  for (const scope of ['buyer', 'seller', 'admin'] as const) {
    const path = scope === 'buyer' ? 'me' : scope;
    const roles =
      scope === 'buyer' ? undefined : scope === 'seller' ? ['seller' as const] : ['admin' as const];
    route(
      'GET',
      `/api/v1/${path}/orders`,
      {
        roles,
        summary: `List ${scope} orders with search and date filters`,
        tag: 'Orders',
        query: jsonSchema(orderQuery),
      },
      async (req) => {
        const f = orderFilter(req.actor!, scope, req.query);
        const p = page(req);
        const count = await db.one(
          `SELECT count(*) AS total FROM orders o JOIN shops s ON s.id=o.shop_id ${f.where}`,
          f.args,
        );
        const rows = await db.query(
          `SELECT o.id,o.number,o.checkout_id,o.shop_id,s.name AS shop_name,o.status,o.payment_status,o.payment_method,o.payment_due_at,o.subtotal_cents,o.discount_cents,o.shipping_cents,o.total_cents,o.tracking,o.carrier,o.created_at,o.updated_at FROM orders o JOIN shops s ON s.id=o.shop_id ${f.where} ORDER BY o.created_at ${f.direction},o.id LIMIT $${f.args.length + 1} OFFSET $${f.args.length + 2}`,
          [...f.args, p.limit, p.offset],
        );
        return list(rows, p.limit, p.offset, Number(count?.total ?? 0));
      },
    );
  }
  route(
    'GET',
    '/api/v1/orders/:id',
    { summary: 'Owned order details and timestamped history', tag: 'Orders' },
    async (req) => data(await orderDetail(db, req.actor!, paramsId(req))),
  );
  const proofHistoryQuery = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).max(100000).optional(),
    })
    .strict();
  route(
    'GET',
    '/api/v1/orders/:id/payment-proofs',
    {
      summary: 'Buyer/admin reads the complete submitted proof and review history',
      tag: 'Payments',
      query: jsonSchema(proofHistoryQuery),
    },
    async (req) => {
      const id = paramsId(req),
        a = req.actor!,
        p = page(req);
      return db.transaction(async (tx) => {
        const order = await orderAccess(tx, a, id);
        if (a.role !== 'admin' && order.buyer_id !== a.id)
          fail(404, 'ORDER_NOT_FOUND', 'Order not found');
        const count = await tx.one(
          'SELECT count(*) AS total FROM order_payment_proofs WHERE order_id=$1',
          [id],
        );
        const rows = await tx.query(
          'SELECT p.id,p.order_id,p.upload_id,p.status,p.reason,p.created_at,p.reviewed_at,u.name AS reviewer_name FROM order_payment_proofs p LEFT JOIN users u ON u.id=p.reviewer_id WHERE p.order_id=$1 ORDER BY p.created_at DESC,p.id DESC LIMIT $2 OFFSET $3',
          [id, p.limit, p.offset],
        );
        return list(rows, p.limit, p.offset, Number(count?.total ?? 0));
      });
    },
  );
  route(
    'GET',
    '/api/v1/orders/:id/tracking',
    { summary: 'Read seller-recorded tracking and shipment events', tag: 'Orders' },
    async (req) => {
      const o = await orderAccess(db, req.actor!, paramsId(req));
      return data(
        camel({
          order_id: o.id,
          number: o.number,
          status: o.status,
          carrier: o.carrier,
          tracking: o.tracking,
          shipped_at: o.shipped_at,
          delivered_at: o.delivered_at,
          source: 'seller-recorded',
          events: await db.query(
            'SELECT status,label,created_at FROM order_events WHERE order_id=$1 ORDER BY created_at,id',
            [o.id],
          ),
        }),
      );
    },
  );
  route(
    'GET',
    '/api/v1/orders/:id/receipt',
    { summary: 'Receipt data from immutable order snapshots', tag: 'Orders' },
    async (req) => {
      const order = await orderDetail(db, req.actor!, paramsId(req));
      const settings = await db.one("SELECT value FROM settings WHERE key='site'");
      return data({
        order,
        settings: settings?.value ?? {
          siteTitle: 'Bloom',
          siteNotice: 'A LITTLE SELF-CARE, EVERY DAY',
          contactEmail: '',
        },
        documentType: 'order-receipt',
        taxInvoice: false,
      });
    },
  );
  const reasonBody = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
  route(
    'POST',
    '/api/v1/orders/:id/cancel',
    {
      summary: 'Cancel an eligible order once and restore stock once',
      tag: 'Orders',
      body: jsonSchema(reasonBody),
    },
    async (req) => {
      const b = parse(reasonBody, req.body),
        a = req.actor!,
        id = paramsId(req);
      return data(
        await db.transaction(async (tx) => {
          const o = await orderAccess(tx, a, id, true);
          if (a.role !== 'admin' && o.buyer_id !== a.id)
            fail(403, 'FORBIDDEN', 'Only the buyer or admin may cancel');
          if (o.status === 'cancelled') return orderDetail(tx, a, id);
          if (
            a.role === 'admin'
              ? !['pending', 'paid', 'preparing'].includes(o.status)
              : o.status !== 'pending'
          )
            fail(409, 'INVALID_TRANSITION', 'This order cannot be cancelled');
          await cancelLockedOrder(tx, a, o, 'order.cancelled', { reason: b.reason });
          return orderDetail(tx, a, id);
        }),
      );
    },
  );
  const proofBody = z.object({ uploadId: uuid }).strict();
  route(
    'POST',
    '/api/v1/orders/:id/payment-proof',
    {
      summary: 'Submit or replace a rejected transfer proof',
      tag: 'Payments',
      body: jsonSchema(proofBody),
    },
    async (req) => {
      const b = parse(proofBody, req.body),
        a = req.actor!,
        id = paramsId(req);
      const outcome = await db.transaction(async (tx) => {
        const o = await orderAccess(tx, a, id, true);
        if (o.buyer_id !== a.id) fail(403, 'FORBIDDEN', 'Only the buyer can submit proof');
        if (await expireLockedOrderIfDue(tx, o)) return { expired: true as const };
        if (
          o.status !== 'pending' ||
          o.payment_method !== 'transfer' ||
          !['unpaid', 'rejected'].includes(o.payment_status)
        )
          fail(409, 'INVALID_TRANSITION', 'Proof cannot be submitted in this state');
        await ensureProof(tx, b.uploadId, a.id);
        await tx.query(
          "INSERT INTO order_payment_proofs(order_id,upload_id,status) VALUES($1,$2,'submitted')",
          [id, b.uploadId],
        );
        const updated = await tx.one(
          "UPDATE orders SET proof_upload_id=$1,payment_status='awaiting_review',payment_note=NULL,payment_due_at=NULL,updated_at=now() WHERE id=$2 RETURNING *",
          [b.uploadId, id],
        );
        await event(tx, a, updated!, 'payment.proof_submitted');
        return { expired: false as const, order: await orderDetail(tx, a, id) };
      });
      if (outcome.expired)
        fail(
          409,
          'PAYMENT_RESERVATION_EXPIRED',
          'The payment window expired. The order was cancelled and stock released; contact support if money was already transferred.',
        );
      return data(outcome.order);
    },
  );
  const reviewProofBody = z
    .object({
      decision: z.enum(['approve', 'reject']),
      reason: z.string().trim().max(1000).optional(),
    })
    .strict()
    .refine((v) => v.decision !== 'reject' || (!!v.reason && v.reason.length >= 3), {
      message: 'Rejection requires a reason',
      path: ['reason'],
    });
  route(
    'POST',
    '/api/v1/admin/orders/:id/payment-review',
    {
      roles: ['admin'],
      summary: 'Manually verify or reject the current transfer proof',
      tag: 'Payments',
      body: jsonSchema(reviewProofBody),
    },
    async (req) => {
      const b = parse(reviewProofBody, req.body),
        a = req.actor!,
        id = paramsId(req);
      return data(
        await db.transaction(async (tx) => {
          const o = await orderAccess(tx, a, id, true);
          if (
            o.status !== 'pending' ||
            o.payment_status !== 'awaiting_review' ||
            !o.proof_upload_id
          )
            fail(409, 'INVALID_TRANSITION', 'No proof is awaiting review');
          const approved = b.decision === 'approve';
          await tx.query(
            "UPDATE order_payment_proofs SET status=$1,reason=$2,reviewer_id=$3,reviewed_at=now() WHERE order_id=$4 AND status='submitted'",
            [approved ? 'approved' : 'rejected', b.reason ?? null, a.id, id],
          );
          const updated = await tx.one(
            "UPDATE orders SET status=$1,payment_status=$2,payment_note=$3,payment_due_at=CASE WHEN $2='rejected' THEN now()+($5::integer*interval '1 minute') ELSE NULL END,updated_at=now() WHERE id=$4 RETURNING *",
            [
              approved ? 'paid' : 'pending',
              approved ? 'paid' : 'rejected',
              approved ? null : b.reason,
              id,
              config.paymentReservationMinutes,
            ],
          );
          await event(tx, a, updated!, approved ? 'payment.approved' : 'payment.rejected', {
            reason: b.reason ?? null,
            method: 'manual_transfer_review',
          });
          return orderDetail(tx, a, id);
        }),
      );
    },
  );
  const latePaymentBody = z
    .object({
      reference: z.string().trim().min(3).max(200),
      amountCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      receivedAt: z
        .string()
        .datetime({ offset: true })
        .refine(
          (value) => !value.startsWith('0000') && Number.isFinite(Date.parse(value)),
          'Invalid received timestamp',
        )
        .optional(),
      note: z.string().trim().min(3).max(1000),
      proofUploadId: uuid.optional(),
    })
    .strict();
  route(
    'POST',
    '/api/v1/admin/orders/:id/late-payment',
    {
      roles: ['admin'],
      summary: 'Record a verified transfer on a cancelled order and create a refund obligation',
      tag: 'Payments',
      body: jsonSchema(latePaymentBody),
    },
    async (req) => {
      const b = parse(latePaymentBody, req.body),
        a = req.actor!,
        id = paramsId(req);
      if (b.receivedAt && Date.parse(b.receivedAt) > Date.now() + 300000)
        fail(422, 'INVALID_RECEIVED_DATE', 'A transfer cannot be recorded in the future');
      return data(
        await db.transaction(async (tx) => {
          let order = await orderAccess(tx, a, id, true);
          order = (await expireLockedOrderIfDue(tx, order)) ?? order;
          if (
            order.status !== 'cancelled' ||
            order.payment_method !== 'transfer' ||
            Number(order.total_cents) !== b.amountCents
          )
            fail(
              409,
              'INVALID_LATE_PAYMENT',
              'Record the exact positive transfer amount for a cancelled transfer order',
            );
          if (order.payment_reference) {
            if (order.payment_reference !== b.reference)
              fail(
                409,
                'PAYMENT_ALREADY_RECORDED',
                'A different incoming payment reference is already recorded',
              );
            if (['refund_pending', 'refunded'].includes(order.payment_status))
              return orderDetail(tx, a, id);
          }
          if (order.payment_status !== 'unpaid')
            fail(
              409,
              'INVALID_TRANSITION',
              'This order already has a recorded payment or refund obligation',
            );
          if (b.proofUploadId) {
            await ensureProof(tx, b.proofUploadId, order.buyer_id);
            await tx.query(
              "INSERT INTO order_payment_proofs(order_id,upload_id,status,reason,reviewer_id,reviewed_at) VALUES($1,$2,'approved',$3,$4,now())",
              [id, b.proofUploadId, 'Verified transfer after cancellation', a.id],
            );
          }
          const updated = await tx.one(
            "UPDATE orders SET payment_status='refund_pending',payment_reference=$1,payment_received_at=coalesce($2::timestamptz,now()),proof_upload_id=coalesce($3::uuid,proof_upload_id),payment_due_at=NULL,updated_at=now() WHERE id=$4 RETURNING *",
            [b.reference, b.receivedAt ?? null, b.proofUploadId ?? null, id],
          );
          await event(tx, a, updated!, 'payment.late_received', {
            reference: b.reference,
            amountCents: b.amountCents,
            receivedAt: updated!.payment_received_at,
            note: b.note,
          });
          return orderDetail(tx, a, id);
        }),
      );
    },
  );
  const refundBody = z
    .object({
      reference: z.string().trim().min(3).max(200),
      note: z.string().trim().min(3).max(1000),
    })
    .strict();
  route(
    'POST',
    '/api/v1/admin/orders/:id/refund',
    {
      roles: ['admin'],
      summary: 'Record a manually completed refund; does not move money',
      tag: 'Payments',
      body: jsonSchema(refundBody),
    },
    async (req) => {
      const b = parse(refundBody, req.body),
        a = req.actor!,
        id = paramsId(req);
      return data(
        await db.transaction(async (tx) => {
          const o = await orderAccess(tx, a, id, true);
          if (o.payment_status === 'refunded') {
            if (o.refund_reference !== b.reference)
              fail(
                409,
                'REFUND_ALREADY_RECORDED',
                'A different refund reference is already recorded',
              );
            return orderDetail(tx, a, id);
          }
          if (o.status !== 'cancelled' || o.payment_status !== 'refund_pending')
            fail(409, 'INVALID_TRANSITION', 'No refund is pending');
          const updated = await tx.one(
            "UPDATE orders SET payment_status='refunded',refund_reference=$1,refunded_at=now(),updated_at=now() WHERE id=$2 RETURNING *",
            [b.reference, id],
          );
          await event(tx, a, updated!, 'payment.manual_refund_recorded', {
            reference: b.reference,
            note: b.note,
          });
          return orderDetail(tx, a, id);
        }),
      );
    },
  );
  route(
    'POST',
    '/api/v1/orders/:id/prepare',
    { roles: ['seller', 'admin'], summary: 'Start preparing a paid order', tag: 'Fulfilment' },
    async (req) => {
      const a = req.actor!,
        id = paramsId(req);
      return data(
        await db.transaction(async (tx) => {
          const o = await orderAccess(tx, a, id, true);
          if (a.role === 'seller' && o.shop_owner_id !== a.id)
            fail(404, 'ORDER_NOT_FOUND', 'Order not found');
          if (o.status === 'preparing') return orderDetail(tx, a, id);
          if (o.status !== 'paid' || o.payment_status !== 'paid')
            fail(409, 'INVALID_TRANSITION', 'Only paid orders can be prepared');
          const updated = await tx.one(
            "UPDATE orders SET status='preparing',updated_at=now() WHERE id=$1 RETURNING *",
            [id],
          );
          await event(tx, a, updated!, 'order.preparing');
          return orderDetail(tx, a, id);
        }),
      );
    },
  );
  const shipBody = z
    .object({
      carrier: z.string().trim().min(2).max(100),
      tracking: z.string().trim().min(3).max(150),
    })
    .strict();
  route(
    'POST',
    '/api/v1/orders/:id/ship',
    {
      roles: ['seller', 'admin'],
      summary: 'Ship a prepared order with carrier and tracking reference',
      tag: 'Fulfilment',
      body: jsonSchema(shipBody),
    },
    async (req) => {
      const b = parse(shipBody, req.body),
        a = req.actor!,
        id = paramsId(req);
      return data(
        await db.transaction(async (tx) => {
          const o = await orderAccess(tx, a, id, true);
          if (a.role === 'seller' && o.shop_owner_id !== a.id)
            fail(404, 'ORDER_NOT_FOUND', 'Order not found');
          if (o.status === 'shipped' && o.carrier === b.carrier && o.tracking === b.tracking)
            return orderDetail(tx, a, id);
          if (o.status !== 'preparing' || o.payment_status !== 'paid')
            fail(409, 'INVALID_TRANSITION', 'Only prepared paid orders can be shipped');
          const updated = await tx.one(
            "UPDATE orders SET status='shipped',carrier=$1,tracking=$2,shipped_at=now(),updated_at=now() WHERE id=$3 RETURNING *",
            [b.carrier, b.tracking, id],
          );
          await event(tx, a, updated!, 'order.shipped', {
            carrier: b.carrier,
            tracking: b.tracking,
          });
          return orderDetail(tx, a, id);
        }),
      );
    },
  );
  route(
    'POST',
    '/api/v1/orders/:id/receive',
    { summary: 'Buyer confirms delivery', tag: 'Fulfilment' },
    async (req) => {
      const a = req.actor!,
        id = paramsId(req);
      return data(
        await db.transaction(async (tx) => {
          const o = await orderAccess(tx, a, id, true);
          if (a.id !== o.buyer_id) fail(403, 'FORBIDDEN', 'Only the buyer may confirm receipt');
          if (o.status === 'delivered') return orderDetail(tx, a, id);
          if (o.status !== 'shipped')
            fail(409, 'INVALID_TRANSITION', 'The order must be shipped first');
          const updated = await tx.one(
            "UPDATE orders SET status='delivered',delivered_at=now(),updated_at=now() WHERE id=$1 RETURNING *",
            [id],
          );
          await event(tx, a, updated!, 'order.delivered');
          return orderDetail(tx, a, id);
        }),
      );
    },
  );
  const shipmentCorrectionBody = shipBody
    .extend({ reason: z.string().trim().min(3).max(1000) })
    .strict();
  route(
    'PATCH',
    '/api/v1/orders/:id/shipment',
    {
      roles: ['seller', 'admin'],
      summary: 'Correct a shipped order carrier/reference with a retained audit reason',
      tag: 'Fulfilment',
      body: jsonSchema(shipmentCorrectionBody),
    },
    async (req) => {
      const b = parse(shipmentCorrectionBody, req.body),
        a = req.actor!,
        id = paramsId(req);
      return data(
        await db.transaction(async (tx) => {
          const order = await orderAccess(tx, a, id, true);
          if (a.role === 'seller' && order.shop_owner_id !== a.id)
            fail(404, 'ORDER_NOT_FOUND', 'Order not found');
          if (order.status !== 'shipped' || order.payment_status !== 'paid')
            fail(
              409,
              'INVALID_TRANSITION',
              'Tracking can only be corrected while the order is shipped',
            );
          if (order.carrier === b.carrier && order.tracking === b.tracking)
            return orderDetail(tx, a, id);
          const updated = await tx.one(
            'UPDATE orders SET carrier=$1,tracking=$2,updated_at=now() WHERE id=$3 RETURNING *',
            [b.carrier, b.tracking, id],
          );
          await event(tx, a, updated!, 'order.tracking_updated', {
            previousCarrier: order.carrier,
            previousTracking: order.tracking,
            carrier: b.carrier,
            tracking: b.tracking,
            reason: b.reason,
          });
          return orderDetail(tx, a, id);
        }),
      );
    },
  );

  route(
    'GET',
    '/api/v1/promotions',
    { auth: false, summary: 'List active current promotions', tag: 'Promotions' },
    async (req) => {
      const p = page(req);
      const rows = await db.query(
        `SELECT p.* FROM promotions p LEFT JOIN shops s ON s.id=p.shop_id LEFT JOIN users u ON u.id=s.owner_id WHERE p.active AND p.archived_at IS NULL AND (p.starts_at IS NULL OR p.starts_at<=$1::date) AND (p.ends_at IS NULL OR p.ends_at>=$1::date) AND (p.usage_limit IS NULL OR p.used_count<p.usage_limit) AND (p.shop_id IS NULL OR (s.status='approved' AND NOT u.blocked)) ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
        [thaiDate(), p.limit, p.offset],
      );
      return { data: rows.map(promoView), page: p };
    },
  );
  for (const role of ['seller', 'admin'] as const) {
    route(
      'GET',
      `/api/v1/${role}/promotions`,
      { roles: [role], summary: `List ${role} promotions`, tag: 'Promotions' },
      async (req) => {
        const p = page(req);
        const rows =
          role === 'admin'
            ? await db.query(
                'SELECT * FROM promotions ORDER BY created_at DESC LIMIT $1 OFFSET $2',
                [p.limit, p.offset],
              )
            : await db.query(
                'SELECT p.* FROM promotions p JOIN shops s ON s.id=p.shop_id WHERE s.owner_id=$1 ORDER BY p.created_at DESC LIMIT $2 OFFSET $3',
                [req.actor!.id, p.limit, p.offset],
              );
        return { data: rows.map(promoView), page: p };
      },
    );
    route(
      'POST',
      `/api/v1/${role}/promotions`,
      {
        roles: [role],
        summary: 'Create a scoped promotion',
        tag: 'Promotions',
        body: jsonSchema(promotionBody),
      },
      async (req, reply) => {
        const b = parse(promotionBody, req.body),
          a = req.actor!;
        const result = await db.transaction(async (tx) => {
          let shopId = b.shopId ?? null;
          if (a.role === 'seller') {
            const s = await ownedShop(tx, a);
            if (s.status !== 'approved')
              fail(403, 'SHOP_NOT_APPROVED', 'Only approved shops can create promotions');
            if (b.shopId && b.shopId !== s.id)
              fail(403, 'FORBIDDEN', 'Cannot create another shop promotion');
            shopId = s.id;
          }
          if (shopId) {
            const s = await tx.one(
              "SELECT s.id FROM shops s JOIN users u ON u.id=s.owner_id WHERE s.id=$1 AND s.status='approved' AND NOT u.blocked",
              [shopId],
            );
            if (!s) fail(422, 'SHOP_NOT_APPROVED', 'Choose an approved shop');
          }
          const row = await tx.one(
            'INSERT INTO promotions(code,title,shop_id,percent_basis_points,active,starts_at,ends_at,min_spend_cents,max_discount_cents,usage_limit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
            [
              b.code,
              b.title,
              shopId,
              Math.round(b.percent * 100),
              b.active,
              b.startsAt ?? null,
              b.endsAt ?? null,
              b.minSpendCents,
              b.maxDiscountCents ?? null,
              b.usageLimit ?? null,
            ],
          );
          await audit(tx, a, 'promotion.created', 'promotion', row!.id, {}, shopId ?? undefined);
          return promoView(row!);
        });
        reply.code(201);
        return data(result);
      },
    );
    route(
      'PUT',
      `/api/v1/${role}/promotions/:id`,
      {
        roles: [role],
        summary: 'Update an owned promotion without changing its store',
        tag: 'Promotions',
        body: jsonSchema(promotionBody),
      },
      async (req) => {
        const b = parse(promotionBody, req.body),
          a = req.actor!,
          id = paramsId(req);
        return data(
          await db.transaction(async (tx) => {
            const p = await promotionScope(tx, a, id, true);
            if (b.shopId !== undefined && b.shopId !== p.shop_id)
              fail(422, 'IMMUTABLE_SHOP', 'Promotion ownership cannot change');
            if (p.archived_at)
              fail(409, 'PROMOTION_ARCHIVED', 'Archived promotions cannot be reactivated');
            if (b.usageLimit && b.usageLimit < p.used_count)
              fail(422, 'INVALID_USAGE_LIMIT', 'Usage limit cannot be below existing usage');
            if (p.shop_id && b.active) {
              const s = await tx.one(
                "SELECT s.id FROM shops s JOIN users u ON u.id=s.owner_id WHERE s.id=$1 AND s.status='approved' AND NOT u.blocked",
                [p.shop_id],
              );
              if (!s) fail(403, 'SHOP_NOT_APPROVED', 'This shop cannot activate promotions');
            }
            const row = await tx.one(
              'UPDATE promotions SET code=$1,title=$2,percent_basis_points=$3,active=$4,starts_at=$5,ends_at=$6,min_spend_cents=$7,max_discount_cents=$8,usage_limit=$9,updated_at=now() WHERE id=$10 RETURNING *',
              [
                b.code,
                b.title,
                Math.round(b.percent * 100),
                b.active,
                b.startsAt ?? null,
                b.endsAt ?? null,
                b.minSpendCents,
                b.maxDiscountCents ?? null,
                b.usageLimit ?? null,
                id,
              ],
            );
            await audit(tx, a, 'promotion.updated', 'promotion', id, {}, p.shop_id ?? undefined);
            return promoView(row!);
          }),
        );
      },
    );
    route(
      'DELETE',
      `/api/v1/${role}/promotions/:id`,
      {
        roles: [role],
        summary: 'Archive a promotion while retaining usage history',
        tag: 'Promotions',
      },
      async (req) => {
        const a = req.actor!,
          id = paramsId(req);
        await db.transaction(async (tx) => {
          const p = await promotionScope(tx, a, id, true);
          await tx.query(
            'UPDATE promotions SET active=false,archived_at=coalesce(archived_at,now()),updated_at=now() WHERE id=$1',
            [id],
          );
          await audit(tx, a, 'promotion.archived', 'promotion', id, {}, p.shop_id ?? undefined);
        });
        return data({ archived: true });
      },
    );
  }

  const reviewBody = z
    .object({ rating: z.number().int().min(1).max(5), text: z.string().trim().min(1).max(3000) })
    .strict();
  route(
    'GET',
    '/api/v1/products/:id/reviews',
    { auth: false, summary: 'Read visible product reviews', tag: 'Reviews' },
    async (req) => {
      const id = paramsId(req),
        p = page(req);
      return db.transaction(async (tx) => {
        await ensurePublicProduct(tx, id);
        const rows = await tx.query(
          'SELECT r.id,r.product_id,r.rating,r.body AS text,r.reply,r.replied_at,r.created_at,u.name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.product_id=$1 AND NOT r.hidden ORDER BY r.created_at DESC,r.id DESC LIMIT $2 OFFSET $3',
          [id, p.limit, p.offset],
        );
        return list(rows, p.limit, p.offset);
      });
    },
  );
  route(
    'POST',
    '/api/v1/products/:id/reviews',
    {
      summary: 'Review a purchased delivered product once',
      tag: 'Reviews',
      body: jsonSchema(reviewBody),
    },
    async (req, reply) => {
      const id = paramsId(req),
        a = req.actor!,
        b = parse(reviewBody, req.body);
      const row = await db.transaction(async (tx) => {
        await buyerLock(tx, a.id);
        const delivered = await tx.one(
          "SELECT oi.id FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=$1 AND o.buyer_id=$2 AND o.status='delivered' LIMIT 1",
          [id, a.id],
        );
        if (!delivered) fail(403, 'REVIEW_NOT_ELIGIBLE', 'A delivered purchase is required');
        const exists = await tx.one('SELECT id FROM reviews WHERE product_id=$1 AND user_id=$2', [
          id,
          a.id,
        ]);
        if (exists) fail(409, 'REVIEW_EXISTS', 'This product has already been reviewed');
        const r = await tx.one(
          'INSERT INTO reviews(product_id,user_id,rating,body) VALUES($1,$2,$3,$4) RETURNING id,product_id,rating,body AS text,created_at',
          [id, a.id, b.rating, b.text],
        );
        await audit(tx, a, 'review.created', 'review', r!.id);
        return r;
      });
      reply.code(201);
      return data(camel(row));
    },
  );
  route(
    'GET',
    '/api/v1/me/reviews',
    { summary: 'List the account reviews', tag: 'Reviews' },
    async (req) => {
      const p = page(req);
      return list(
        await db.query(
          'SELECT r.id,r.product_id,p.name AS product_name,r.rating,r.body AS text,r.hidden,r.moderation_reason,r.reply,r.created_at FROM reviews r JOIN products p ON p.id=r.product_id WHERE r.user_id=$1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3',
          [req.actor!.id, p.limit, p.offset],
        ),
        p.limit,
        p.offset,
      );
    },
  );
  for (const role of ['seller', 'admin'] as const)
    route(
      'GET',
      `/api/v1/${role}/reviews`,
      { roles: [role], summary: `List ${role} review management queue`, tag: 'Reviews' },
      async (req) => {
        const p = page(req);
        const rows =
          role === 'admin'
            ? await db.query(
                'SELECT r.*,p.name AS product_name,s.name AS shop_name,u.name AS user_name FROM reviews r JOIN products p ON p.id=r.product_id JOIN shops s ON s.id=p.shop_id JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT $1 OFFSET $2',
                [p.limit, p.offset],
              )
            : await db.query(
                'SELECT r.*,p.name AS product_name,u.name AS user_name FROM reviews r JOIN products p ON p.id=r.product_id JOIN shops s ON s.id=p.shop_id JOIN users u ON u.id=r.user_id WHERE s.owner_id=$1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3',
                [req.actor!.id, p.limit, p.offset],
              );
        return list(rows, p.limit, p.offset);
      },
    );
  const replyBody = z.object({ text: z.string().trim().min(1).max(3000) }).strict();
  route(
    'PUT',
    '/api/v1/reviews/:id/reply',
    {
      roles: ['seller', 'admin'],
      summary: 'Reply to a store review',
      tag: 'Reviews',
      body: jsonSchema(replyBody),
    },
    async (req) => {
      const id = paramsId(req),
        a = req.actor!,
        b = parse(replyBody, req.body);
      return data(
        camel(
          await db.transaction(async (tx) => {
            const r = await tx.one(
              'SELECT r.*,s.owner_id,p.shop_id FROM reviews r JOIN products p ON p.id=r.product_id JOIN shops s ON s.id=p.shop_id WHERE r.id=$1 FOR UPDATE OF r',
              [id],
            );
            if (!r || (a.role !== 'admin' && r.owner_id !== a.id))
              fail(404, 'REVIEW_NOT_FOUND', 'Review not found');
            const updated = await tx.one(
              'UPDATE reviews SET reply=$1,replied_at=now(),updated_at=now() WHERE id=$2 RETURNING *',
              [b.text, id],
            );
            await audit(tx, a, 'review.replied', 'review', id, {}, r!.shop_id);
            return updated;
          }),
        ),
      );
    },
  );
  const moderationBody = z
    .object({ hidden: z.boolean(), reason: z.string().trim().min(3).max(1000) })
    .strict();
  route(
    'PUT',
    '/api/v1/admin/reviews/:id/moderation',
    {
      roles: ['admin'],
      summary: 'Moderate a review with an audit reason',
      tag: 'Reviews',
      body: jsonSchema(moderationBody),
    },
    async (req) => {
      const id = paramsId(req),
        a = req.actor!,
        b = parse(moderationBody, req.body);
      return data(
        camel(
          await db.transaction(async (tx) => {
            const r = await tx.one(
              'UPDATE reviews SET hidden=$1,moderation_reason=$2,updated_at=now() WHERE id=$3 RETURNING *',
              [b.hidden, b.reason, id],
            );
            if (!r) fail(404, 'REVIEW_NOT_FOUND', 'Review not found');
            await audit(tx, a, 'review.moderated', 'review', id, {
              hidden: b.hidden,
              reason: b.reason,
            });
            return r;
          }),
        ),
      );
    },
  );

  for (const role of ['seller', 'admin'] as const) {
    for (const format of ['json', 'csv'] as const)
      route(
        'GET',
        `/api/v1/${role}/reports/sales${format === 'csv' ? '.csv' : ''}`,
        {
          roles: [role],
          summary: `${format === 'csv' ? 'Export' : 'Summarize'} sales by Bangkok order creation dates`,
          tag: 'Reports',
          query: jsonSchema(orderQuery),
        },
        async (req, reply) => {
          const f = orderFilter(req.actor!, role, req.query);
          const rows = await db.query(
            `SELECT o.*,s.name AS shop_name FROM orders o JOIN shops s ON s.id=o.shop_id ${f.where} ORDER BY o.created_at ${f.direction},o.id LIMIT 10001`,
            f.args,
          );
          if (rows.length > 10000)
            fail(422, 'REPORT_TOO_LARGE', 'Narrow the report date range to 10,000 orders or fewer');
          if (format === 'csv') {
            reply.header('Content-Type', 'text/csv; charset=utf-8');
            reply.header('Content-Disposition', 'attachment; filename="bloom-sales.csv"');
            return csv(
              rows.map((o) => ({
                orderNumber: o.number,
                createdAt: new Date(o.created_at).toISOString(),
                shop: o.shop_name,
                status: o.status,
                paymentMethod: o.payment_method,
                paymentStatus: o.payment_status,
                subtotalCents: o.subtotal_cents,
                discountCents: o.discount_cents,
                netMerchandiseCents: Number(o.subtotal_cents) - Number(o.discount_cents),
                shippingCents: o.shipping_cents,
                totalCents: o.total_cents,
                recipient: o.address_snapshot.name,
                phone: o.address_snapshot.phone,
                address: o.address_snapshot.address,
                carrier: o.carrier ?? '',
                tracking: o.tracking ?? '',
                refundReference: role === 'admin' ? (o.refund_reference ?? '') : '',
                paymentReference: role === 'admin' ? (o.payment_reference ?? '') : '',
                paymentReceivedAt:
                  role === 'admin' && o.payment_received_at
                    ? new Date(o.payment_received_at).toISOString()
                    : '',
              })),
            );
          }
          const shopIds = [...new Set(rows.map((r) => r.shop_id))];
          return data({
            basis: 'order-created-at',
            timeZone: 'Asia/Bangkok',
            currency: 'THB',
            moneyUnit: 'satang',
            summary: salesSummary(rows),
            shops: shopIds.map((id) => ({
              shopId: id,
              shopName: rows.find((r) => r.shop_id === id)!.shop_name,
              ...salesSummary(rows.filter((r) => r.shop_id === id)),
            })),
          });
        },
      );
  }
};
