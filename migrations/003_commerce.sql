CREATE TABLE addresses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
 label text NOT NULL, name text NOT NULL, phone text NOT NULL, address text NOT NULL,
 is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX addresses_user_idx ON addresses(user_id);
CREATE UNIQUE INDEX addresses_default_idx ON addresses(user_id) WHERE is_default;
CREATE TABLE cart_items (
 user_id uuid NOT NULL REFERENCES users(id), product_id uuid NOT NULL REFERENCES products(id),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 1000), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,product_id)
);
CREATE INDEX cart_product_idx ON cart_items(product_id);
CREATE TABLE wishlists (
 user_id uuid NOT NULL REFERENCES users(id), product_id uuid NOT NULL REFERENCES products(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,product_id)
);
CREATE TABLE promotions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE CHECK(code=upper(code)),
 title text NOT NULL, shop_id uuid REFERENCES shops(id), percent_basis_points integer NOT NULL CHECK(percent_basis_points BETWEEN 1 AND 10000),
 active boolean NOT NULL DEFAULT true, starts_at date, ends_at date,
 min_spend_cents bigint NOT NULL DEFAULT 0 CHECK(min_spend_cents>=0), max_discount_cents bigint CHECK(max_discount_cents>0),
 usage_limit integer CHECK(usage_limit>0), used_count integer NOT NULL DEFAULT 0 CHECK(used_count>=0),
 archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(starts_at IS NULL OR ends_at IS NULL OR starts_at<=ends_at)
);
CREATE INDEX promotions_shop_idx ON promotions(shop_id);
CREATE TABLE checkout_groups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), buyer_id uuid NOT NULL REFERENCES users(id), promotion_id uuid REFERENCES promotions(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE checkout_requests (
 buyer_id uuid NOT NULL REFERENCES users(id), idempotency_key text NOT NULL, request_hash text NOT NULL,
 checkout_id uuid NOT NULL REFERENCES checkout_groups(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(buyer_id,idempotency_key)
);
CREATE TABLE orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number text NOT NULL UNIQUE, checkout_id uuid NOT NULL REFERENCES checkout_groups(id),
 buyer_id uuid NOT NULL REFERENCES users(id), shop_id uuid NOT NULL REFERENCES shops(id),
 status text NOT NULL CHECK(status IN ('pending','paid','preparing','shipped','delivered','cancelled')),
 payment_status text NOT NULL CHECK(payment_status IN ('unpaid','awaiting_review','rejected','paid','refund_pending','refunded')),
 payment_method text NOT NULL CHECK(payment_method IN ('transfer','development')),
 address_snapshot jsonb NOT NULL, subtotal_cents bigint NOT NULL CHECK(subtotal_cents>=0),
 shipping_cents bigint NOT NULL CHECK(shipping_cents>=0), discount_cents bigint NOT NULL CHECK(discount_cents>=0 AND discount_cents<=subtotal_cents),
 total_cents bigint NOT NULL CHECK(total_cents=subtotal_cents+shipping_cents-discount_cents),
 coupon_code text, proof_upload_id uuid REFERENCES uploads(id), payment_note text,
 stock_released boolean NOT NULL DEFAULT false, carrier text, tracking text, shipped_at timestamptz, delivered_at timestamptz,
 refund_reference text, refunded_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_buyer_created_idx ON orders(buyer_id,created_at DESC);
CREATE INDEX orders_shop_created_idx ON orders(shop_id,created_at DESC);
CREATE INDEX orders_status_created_idx ON orders(status,created_at DESC);
CREATE INDEX orders_payment_status_idx ON orders(payment_status);
CREATE INDEX orders_checkout_idx ON orders(checkout_id);
CREATE INDEX orders_proof_idx ON orders(proof_upload_id);
CREATE TABLE order_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id), product_id uuid NOT NULL REFERENCES products(id),
 name text NOT NULL, unit_price_cents bigint NOT NULL CHECK(unit_price_cents>=0), quantity integer NOT NULL CHECK(quantity>0),
 image_id uuid REFERENCES uploads(id), image_index integer, UNIQUE(order_id,product_id)
);
CREATE INDEX order_items_product_idx ON order_items(product_id);
CREATE TABLE order_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id), actor_id uuid REFERENCES users(id),
 status text NOT NULL, label text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events(order_id,created_at);
CREATE TABLE order_payment_proofs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id), upload_id uuid NOT NULL REFERENCES uploads(id),
 status text NOT NULL CHECK(status IN ('submitted','approved','rejected')), reason text,
 reviewer_id uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz
);
CREATE INDEX payment_proofs_order_idx ON order_payment_proofs(order_id,created_at DESC);
CREATE INDEX payment_proofs_upload_idx ON order_payment_proofs(upload_id);
CREATE UNIQUE INDEX payment_proofs_pending_idx ON order_payment_proofs(order_id) WHERE status='submitted';
CREATE TABLE promotion_uses (
 promotion_id uuid NOT NULL REFERENCES promotions(id), checkout_id uuid NOT NULL REFERENCES checkout_groups(id),
 buyer_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(promotion_id,checkout_id)
);
CREATE TABLE reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES products(id), user_id uuid NOT NULL REFERENCES users(id),
 rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5), body text NOT NULL, hidden boolean NOT NULL DEFAULT false,
 moderation_reason text, reply text, replied_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(product_id,user_id)
);
CREATE INDEX reviews_public_product_idx ON reviews(product_id,created_at DESC) WHERE NOT hidden;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movement_order_fk FOREIGN KEY(order_id) REFERENCES orders(id);
