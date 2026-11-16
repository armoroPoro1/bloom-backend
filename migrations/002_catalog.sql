CREATE TABLE shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL UNIQUE REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  email text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended')),
  review_reason text,
  shipping_fee_cents bigint NOT NULL DEFAULT 4000 CHECK (shipping_fee_cents >= 0),
  free_shipping_at_cents bigint CHECK (free_shipping_at_cents IS NULL OR free_shipping_at_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shops_status_created_idx ON shops (status, created_at DESC);

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  icon text NOT NULL DEFAULT 'package',
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_name_unique_idx ON categories (lower(name));
CREATE INDEX categories_active_name_idx ON categories (active, name);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id),
  category_id uuid NOT NULL REFERENCES categories(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 180),
  english_name text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  price_cents bigint NOT NULL CHECK (price_cents BETWEEN 1 AND 100000000),
  original_price_cents bigint NOT NULL DEFAULT 0 CHECK (original_price_cents >= 0),
  image_id uuid REFERENCES uploads(id),
  image_index integer CHECK (image_index IS NULL OR image_index BETWEEN 0 AND 5),
  badge text NOT NULL DEFAULT '',
  stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (original_price_cents = 0 OR original_price_cents >= price_cents)
);
CREATE INDEX products_shop_created_idx ON products (shop_id, created_at DESC);
CREATE INDEX products_category_price_idx ON products (category_id, price_cents) WHERE active AND archived_at IS NULL;
CREATE INDEX products_public_new_idx ON products (created_at DESC, id) WHERE active AND archived_at IS NULL;
CREATE INDEX products_image_idx ON products (image_id) WHERE image_id IS NOT NULL;

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  shop_id uuid NOT NULL REFERENCES shops(id),
  change integer NOT NULL,
  balance integer NOT NULL CHECK (balance >= 0),
  reason text NOT NULL,
  actor_id uuid REFERENCES users(id),
  order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_shop_created_idx ON stock_movements (shop_id, created_at DESC);
CREATE INDEX stock_movements_product_created_idx ON stock_movements (product_id, created_at DESC);
CREATE INDEX stock_movements_order_idx ON stock_movements (order_id) WHERE order_id IS NOT NULL;

