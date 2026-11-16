-- Append-only lifecycle upgrade. Existing checkout/order monetary snapshots are preserved.
ALTER TABLE orders ADD COLUMN payment_due_at timestamptz;
ALTER TABLE orders ADD COLUMN payment_reference text CHECK(payment_reference IS NULL OR length(payment_reference) BETWEEN 3 AND 200);
ALTER TABLE orders ADD COLUMN payment_received_at timestamptz;
ALTER TABLE orders DROP CONSTRAINT orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK(payment_method IN ('transfer','development','no_charge'));
ALTER TABLE orders ADD CONSTRAINT orders_no_charge_total_check CHECK(payment_method<>'no_charge' OR total_cents=0);

-- Historical zero-balance orders require no transfer or proof. Record the migration explicitly.
WITH converted AS (
 UPDATE orders SET status='paid',payment_status='paid',payment_method='no_charge',proof_upload_id=NULL,payment_note=NULL,updated_at=now()
 WHERE status='pending' AND total_cents=0
 RETURNING id,number,buyer_id,shop_id
), events AS (
 INSERT INTO order_events(order_id,actor_id,status,label,detail)
 SELECT id,NULL,'paid','คำสั่งซื้อนี้ไม่มียอดที่ต้องชำระ','{"code":"payment.no_charge","source":"migration_005"}'::jsonb FROM converted
 RETURNING order_id
), audits AS (
 INSERT INTO audit_events(actor_id,action,entity,entity_id,detail,shop_id)
 SELECT NULL,'payment.no_charge','order',id::text,'{"source":"migration_005"}'::jsonb,shop_id FROM converted
 RETURNING entity_id
)
INSERT INTO notifications(user_id,title,message,order_id)
SELECT buyer_id,'คำสั่งซื้อนี้ไม่มียอดที่ต้องชำระ',number,id FROM converted;

-- Legacy transfer reservations receive a deterministic 24-hour window. Recent rejected
-- proofs use their last rejection time; old abandoned reservations become immediately due.
UPDATE orders o SET payment_due_at = (
 CASE WHEN o.payment_status='rejected' THEN
   COALESCE((SELECT max(p.reviewed_at) FROM order_payment_proofs p WHERE p.order_id=o.id AND p.status='rejected'),o.created_at)
 ELSE o.created_at END
) + interval '24 hours'
WHERE o.status='pending' AND o.payment_method='transfer' AND o.payment_status IN ('unpaid','rejected');

ALTER TABLE orders ADD CONSTRAINT orders_payment_deadline_state_check CHECK(
 payment_due_at IS NULL OR (status='pending' AND payment_method='transfer' AND payment_status IN ('unpaid','rejected'))
);
CREATE INDEX orders_payment_due_idx ON orders(payment_due_at,id)
 WHERE status='pending' AND payment_method='transfer' AND payment_status IN ('unpaid','rejected');
