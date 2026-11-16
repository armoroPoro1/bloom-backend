import type { Actor, Context, Row, Sql } from '../core/contracts.js';
import { audit, fail, notify } from '../core/http.js';

/** Caller owns any required order row lock. System events use a NULL actor, never impersonate a customer. */
export async function recordOrderEvent(
  tx: Sql,
  actor: Actor | null,
  order: Row,
  code: string,
  detail: Row = {},
) {
  const titles: Record<string, string> = {
    'order.created': 'สร้างคำสั่งซื้อแล้ว',
    'order.cancelled': 'ยกเลิกคำสั่งซื้อแล้ว',
    'order.expired': 'หมดเวลาส่งหลักฐานชำระเงินและคืนสต็อกแล้ว',
    'payment.proof_submitted': 'ส่งหลักฐานชำระเงินแล้ว',
    'payment.approved': 'ยืนยันการชำระเงินแล้ว',
    'payment.rejected': 'กรุณาแก้ไขหลักฐานชำระเงิน',
    'payment.manual_refund_recorded': 'บันทึกการคืนเงินแล้ว',
    'payment.late_received': 'บันทึกเงินโอนหลังยกเลิกคำสั่งซื้อและรอคืนเงิน',
    'order.preparing': 'ร้านค้ากำลังเตรียมสินค้า',
    'order.shipped': 'จัดส่งสินค้าแล้ว',
    'order.tracking_updated': 'แก้ไขข้อมูลติดตามพัสดุแล้ว',
    'order.delivered': 'ยืนยันการรับสินค้าแล้ว',
  };
  const title = titles[code] ?? code;
  await tx.query(
    'INSERT INTO order_events(order_id,actor_id,status,label,detail) VALUES($1,$2,$3,$4,$5)',
    [order.id, actor?.id ?? null, order.status, title, JSON.stringify({ ...detail, code })],
  );
  await notify(tx, order.buyer_id, title, order.number, order.id);
  const shop = await tx.one('SELECT owner_id FROM shops WHERE id=$1', [order.shop_id]);
  if (shop && shop.owner_id !== order.buyer_id)
    await notify(tx, shop.owner_id, title, order.number, order.id);
  if (
    order.payment_status === 'awaiting_review' &&
    ['order.created', 'payment.proof_submitted'].includes(code)
  ) {
    const admins = await tx.query("SELECT id FROM users WHERE role='admin' AND NOT blocked");
    for (const admin of admins)
      await notify(tx, admin.id, 'มีหลักฐานชำระเงินรอตรวจสอบ', order.number, order.id);
  }
  if (actor) await audit(tx, actor, code, 'order', order.id, detail, order.shop_id);
  else
    await tx.query(
      'INSERT INTO audit_events(actor_id,action,entity,entity_id,detail,shop_id) VALUES(NULL,$1,$2,$3,$4,$5)',
      [code, 'order', order.id, JSON.stringify({ ...detail, source: 'system' }), order.shop_id],
    );
}

/** The order must already be locked. Caller checks action eligibility/ownership. */
export async function cancelLockedOrder(
  tx: Sql,
  actor: Actor | null,
  order: Row,
  code = 'order.cancelled',
  detail: Row = {},
) {
  if (order.status === 'cancelled') return order;
  if (!order.stock_released) {
    const items = await tx.query(
      'SELECT product_id,quantity FROM order_items WHERE order_id=$1 ORDER BY product_id',
      [order.id],
    );
    for (const item of items) {
      const product = await tx.one(
        'UPDATE products SET stock=stock+$1,updated_at=now() WHERE id=$2 RETURNING stock',
        [item.quantity, item.product_id],
      );
      if (!product) fail(409, 'ORDER_INVENTORY_MISSING', 'Order inventory cannot be restored');
      await tx.query(
        'INSERT INTO stock_movements(product_id,shop_id,change,balance,reason,actor_id,order_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          item.product_id,
          order.shop_id,
          item.quantity,
          product.stock,
          code === 'order.expired' ? 'reservation_expired' : 'cancelled',
          actor?.id ?? null,
          order.id,
        ],
      );
    }
  }
  const paymentStatus =
    order.payment_status === 'paid' && Number(order.total_cents) > 0 ? 'refund_pending' : 'unpaid';
  const updated = await tx.one(
    "UPDATE orders SET status='cancelled',payment_status=$1,stock_released=true,payment_due_at=NULL,updated_at=now() WHERE id=$2 RETURNING *",
    [paymentStatus, order.id],
  );
  await recordOrderEvent(tx, actor, updated!, code, detail);
  return updated!;
}

/** Returns the cancelled order only when an already-locked reservation was due. */
export async function expireLockedOrderIfDue(tx: Sql, order: Row): Promise<Row | undefined> {
  if (
    order.status !== 'pending' ||
    order.payment_method !== 'transfer' ||
    !['unpaid', 'rejected'].includes(order.payment_status)
  )
    return undefined;
  const due = await tx.one('SELECT id FROM orders WHERE id=$1 AND payment_due_at<=now()', [
    order.id,
  ]);
  if (!due) return undefined;
  return cancelLockedOrder(tx, null, order, 'order.expired', {
    paymentDueAt: order.payment_due_at,
  });
}

/** Each order is a short independent transaction; workers/proof submission serialize on the order row. */
export async function expireUnpaidOrders(
  ctx: Context,
  limit = 100,
  signal?: AbortSignal,
): Promise<{ expired: number; orderIds: string[] }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Expiration batch limit must be between 1 and 1000');
  if (signal?.aborted) return { expired: 0, orderIds: [] };
  const candidates = await ctx.db.query(
    "SELECT id FROM orders WHERE status='pending' AND payment_method='transfer' AND payment_status IN ('unpaid','rejected') AND payment_due_at<=now() ORDER BY payment_due_at,id LIMIT $1",
    [limit],
  );
  const orderIds: string[] = [];
  for (const candidate of candidates) {
    // Finish a claimed order atomically, then honor shutdown before claiming another.
    if (signal?.aborted) break;
    const expired = await ctx.db.transaction(async (tx) => {
      const order = await tx.one(
        "SELECT * FROM orders WHERE id=$1 AND status='pending' AND payment_method='transfer' AND payment_status IN ('unpaid','rejected') AND payment_due_at<=now() FOR UPDATE SKIP LOCKED",
        [candidate.id],
      );
      if (!order) return false;
      await cancelLockedOrder(tx, null, order, 'order.expired', {
        paymentDueAt: order.payment_due_at,
      });
      return true;
    });
    if (expired) orderIds.push(candidate.id);
  }
  return { expired: orderIds.length, orderIds };
}
