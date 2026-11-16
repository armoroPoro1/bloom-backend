import { createHash } from 'node:crypto';
import { fail } from '../core/http.js';

export type QuoteProduct = {
  id: string;
  shop_id: string;
  name: string;
  price_cents: number;
  quantity: number;
  image_id: string | null;
  image_index: number | null;
  shipping_fee_cents: number;
  free_shipping_at_cents: number | null;
};
export type Coupon = {
  id: string;
  code: string;
  shop_id: string | null;
  active: boolean;
  archived_at: unknown;
  starts_at: string | null;
  ends_at: string | null;
  percent_basis_points: number;
  min_spend_cents: number;
  max_discount_cents: number | null;
  usage_limit: number | null;
  used_count: number;
};
export function thaiDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
export function integer(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    fail(422, 'INVALID_MONEY', 'Amounts must be safe non-negative integers');
  return n;
}
export function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function calculateQuote(products: QuoteProduct[], coupon?: Coupon, now = new Date()) {
  const groups = new Map<
    string,
    {
      shopId: string;
      items: {
        productId: string;
        name: string;
        unitPriceCents: number;
        quantity: number;
        imageId: string | null;
        imageIndex: number | null;
      }[];
      subtotalCents: number;
      shippingCents: number;
      discountCents: number;
      totalCents: number;
    }
  >();
  for (const p of products) {
    const quantity = integer(p.quantity),
      price = integer(p.price_cents);
    if (!quantity) fail(422, 'INVALID_QUANTITY', 'Quantity must be positive');
    let g = groups.get(p.shop_id);
    if (!g) {
      g = {
        shopId: p.shop_id,
        items: [],
        subtotalCents: 0,
        shippingCents: 0,
        discountCents: 0,
        totalCents: 0,
      };
      groups.set(p.shop_id, g);
    }
    g.items.push({
      productId: p.id,
      name: p.name,
      unitPriceCents: price,
      quantity,
      imageId: p.image_id,
      imageIndex: p.image_index,
    });
    g.subtotalCents = integer(g.subtotalCents + price * quantity);
  }
  for (const g of groups.values()) {
    const p = products.find((p) => p.shop_id === g.shopId)!;
    g.shippingCents =
      p.free_shipping_at_cents !== null && g.subtotalCents >= integer(p.free_shipping_at_cents)
        ? 0
        : integer(p.shipping_fee_cents);
  }
  if (coupon) {
    const today = thaiDate(now);
    const date = (v: any) =>
      v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
    if (
      !coupon.active ||
      coupon.archived_at ||
      (coupon.starts_at && date(coupon.starts_at) > today) ||
      (coupon.ends_at && date(coupon.ends_at) < today) ||
      (coupon.usage_limit !== null && coupon.used_count >= coupon.usage_limit)
    )
      fail(422, 'COUPON_UNAVAILABLE', 'This promotion is not currently available');
    const applicable = [...groups.values()].filter(
      (g) =>
        (!coupon.shop_id || coupon.shop_id === g.shopId) &&
        g.subtotalCents >= integer(coupon.min_spend_cents),
    );
    if (!applicable.length)
      fail(422, 'COUPON_NOT_APPLICABLE', 'No shop meets the promotion conditions');
    for (const g of applicable) {
      const percentDiscount = Number(
        (BigInt(g.subtotalCents) * BigInt(coupon.percent_basis_points) + 5000n) / 10000n,
      );
      g.discountCents = Math.min(
        g.subtotalCents,
        percentDiscount,
        coupon.max_discount_cents === null
          ? Number.MAX_SAFE_INTEGER
          : integer(coupon.max_discount_cents),
      );
    }
  }
  const values = [...groups.values()];
  for (const g of values)
    g.totalCents = integer(g.subtotalCents + g.shippingCents - g.discountCents);
  const sum = (key: 'subtotalCents' | 'shippingCents' | 'discountCents' | 'totalCents') =>
    integer(values.reduce((s, g) => s + g[key], 0));
  return {
    groups: values,
    subtotalCents: sum('subtotalCents'),
    shippingCents: sum('shippingCents'),
    discountCents: sum('discountCents'),
    totalCents: sum('totalCents'),
    couponCode: coupon?.code ?? null,
  };
}

/** These are order-creation-date summaries, not cashflow, settlement or profit. */
export function salesSummary(orders: Record<string, any>[]) {
  const add = (current: number, amount: number) => {
    const total = current + amount;
    if (!Number.isSafeInteger(total) || total < 0)
      fail(
        422,
        'REPORT_TOTAL_TOO_LARGE',
        'The summary exceeds the exact integer money limit; narrow the report range or export individual orders as CSV',
      );
    return total;
  };
  let netMerchandiseCents = 0,
    shippingCents = 0,
    discountCents = 0,
    collectedCents = 0,
    pendingPaymentCents = 0,
    refundPendingCents = 0,
    refundedCents = 0,
    paidOrders = 0,
    noChargeOrders = 0;
  for (const o of orders) {
    const total = Number(o.total_cents),
      shipping = Number(o.shipping_cents),
      discount = Number(o.discount_cents),
      subtotal = Number(o.subtotal_cents);
    if (o.payment_status === 'paid' && o.status !== 'cancelled') {
      netMerchandiseCents = add(netMerchandiseCents, subtotal - discount);
      shippingCents = add(shippingCents, shipping);
      discountCents = add(discountCents, discount);
      collectedCents = add(collectedCents, total);
      paidOrders++;
      if (o.payment_method === 'no_charge') noChargeOrders++;
    }
    if (
      o.status !== 'cancelled' &&
      ['unpaid', 'awaiting_review', 'rejected'].includes(o.payment_status)
    )
      pendingPaymentCents = add(pendingPaymentCents, total);
    if (o.payment_status === 'refund_pending') refundPendingCents = add(refundPendingCents, total);
    if (o.payment_status === 'refunded') refundedCents = add(refundedCents, total);
  }
  return {
    orderCount: orders.length,
    paidOrders,
    noChargeOrders,
    netMerchandiseCents,
    discountCents,
    shippingCents,
    collectedCents,
    pendingPaymentCents,
    refundPendingCents,
    refundedCents,
  };
}
