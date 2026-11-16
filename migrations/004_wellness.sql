CREATE TABLE articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  subtitle text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  tag text NOT NULL DEFAULT '',
  reading_time text NOT NULL DEFAULT '',
  paragraphs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(paragraphs) = 'array'),
  image_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX articles_public_idx ON articles (published, created_at DESC);
CREATE INDEX articles_category_idx ON articles (category, published);

CREATE TABLE article_bookmarks (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, article_id)
);
CREATE INDEX article_bookmarks_article_idx ON article_bookmarks(article_id);

CREATE TABLE foods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  detail text NOT NULL CHECK (length(detail) BETWEEN 1 AND 300),
  kcal numeric(10,2) NOT NULL CHECK (kcal >= 0 AND kcal <= 10000),
  group_name text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX foods_active_group_idx ON foods(active, group_name);

CREATE TABLE meal_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE meal_template_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES meal_templates(id) ON DELETE CASCADE,
  food_id uuid NOT NULL REFERENCES foods(id) ON DELETE RESTRICT,
  meal text NOT NULL CHECK (length(meal) BETWEEN 1 AND 100),
  portions numeric(6,2) NOT NULL CHECK (portions > 0 AND portions <= 10),
  position integer NOT NULL CHECK (position >= 0),
  UNIQUE (template_id, position)
);
CREATE INDEX meal_template_food_idx ON meal_template_entries(food_id);

CREATE TABLE exercise_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT false,
  days jsonb NOT NULL CHECK (jsonb_typeof(days) = 'array' AND jsonb_array_length(days) = 7),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exercise_templates_active_idx ON exercise_templates(active, created_at DESC);

CREATE TABLE meal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date date NOT NULL,
  meal text NOT NULL CHECK (length(meal) BETWEEN 1 AND 100),
  food_id uuid REFERENCES foods(id) ON DELETE SET NULL,
  food_name text NOT NULL,
  portion_label text NOT NULL,
  kcal_per_portion numeric(10,2) NOT NULL CHECK (kcal_per_portion >= 0 AND kcal_per_portion <= 10000),
  portions numeric(6,2) NOT NULL CHECK (portions > 0 AND portions <= 10),
  template_id uuid REFERENCES meal_templates(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meal_entries_owner_date_idx ON meal_entries(user_id, entry_date, created_at);
CREATE INDEX meal_entries_food_idx ON meal_entries(food_id);
CREATE INDEX meal_entries_template_idx ON meal_entries(template_id);

CREATE TABLE exercise_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date date NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  minutes integer NOT NULL CHECK (minutes BETWEEN 0 AND 600),
  activity_type text NOT NULL DEFAULT '',
  completed boolean NOT NULL DEFAULT false,
  template_id uuid REFERENCES exercise_templates(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exercise_entries_owner_date_idx ON exercise_entries(user_id, entry_date, created_at);
CREATE INDEX exercise_entries_template_idx ON exercise_entries(template_id);

CREATE TABLE health_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  height_cm numeric(6,2) CHECK (height_cm > 0 AND height_cm <= 300),
  weight_kg numeric(7,2) CHECK (weight_kg > 0 AND weight_kg <= 1000),
  goal text NOT NULL DEFAULT '' CHECK (length(goal) <= 2000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
