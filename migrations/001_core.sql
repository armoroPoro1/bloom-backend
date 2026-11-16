CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
 email text NOT NULL UNIQUE CHECK(email=lower(email)), phone text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '',
 password_hash text NOT NULL, role text NOT NULL DEFAULT 'user' CHECK(role IN ('user','seller','admin')),
 blocked boolean NOT NULL DEFAULT false, email_verified boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_role_created_idx ON users(role,created_at DESC);
CREATE TABLE sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 access_hash text NOT NULL UNIQUE, refresh_hash text NOT NULL UNIQUE,
 access_expires_at timestamptz NOT NULL, refresh_expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(refresh_expires_at);
CREATE TABLE used_refresh_tokens (hash text PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
CREATE TABLE account_tokens(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash text NOT NULL UNIQUE, purpose text NOT NULL CHECK(purpose IN ('reset','verify')), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX account_tokens_user_idx ON account_tokens(user_id,purpose);
CREATE INDEX account_tokens_expiry_idx ON account_tokens(expires_at);
CREATE TABLE auth_attempts(identifier_hash text PRIMARY KEY,failures integer NOT NULL DEFAULT 0,window_started timestamptz NOT NULL DEFAULT now());
CREATE TABLE uploads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES users(id),kind text NOT NULL CHECK(kind IN ('product','avatar','proof','article')),storage_key text NOT NULL UNIQUE,mime text NOT NULL,size_bytes integer NOT NULL CHECK(size_bytes>0 AND size_bytes<=2097152),sha256 text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX uploads_owner_idx ON uploads(owner_id,created_at DESC);
ALTER TABLE users ADD COLUMN avatar_id uuid REFERENCES uploads(id) ON DELETE SET NULL;
CREATE TABLE audit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid REFERENCES users(id) ON DELETE SET NULL,action text NOT NULL,entity text NOT NULL,entity_id text NOT NULL,detail jsonb NOT NULL DEFAULT '{}',shop_id uuid,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_events_shop_created_idx ON audit_events(shop_id,created_at DESC);
CREATE INDEX audit_events_actor_created_idx ON audit_events(actor_id,created_at DESC);
CREATE TABLE notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,title text NOT NULL,message text NOT NULL,order_id uuid,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX notifications_user_unread_idx ON notifications(user_id,created_at DESC) WHERE read_at IS NULL;
CREATE INDEX notifications_user_created_idx ON notifications(user_id,created_at DESC);
CREATE TABLE settings(key text PRIMARY KEY,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO settings(key,value) VALUES ('site','{"siteTitle":"Bloom","siteNotice":"A LITTLE SELF-CARE, EVERY DAY"}');
CREATE TABLE mail_outbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recipient text NOT NULL,subject text NOT NULL,body text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed')),attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),locked_at timestamptz,sent_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX mail_outbox_pending_idx ON mail_outbox(available_at) WHERE status IN ('pending','failed');
CREATE TABLE page_visits(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES users(id) ON DELETE SET NULL,page text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX page_visits_created_idx ON page_visits(created_at DESC,page);

