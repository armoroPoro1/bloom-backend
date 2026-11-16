import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { Module, Row, Sql } from '../core/contracts.js';
import {
  audit,
  camel,
  data,
  fail,
  jsonSchema,
  list,
  paramsId,
  parse,
  partialSchema,
} from '../core/http.js';

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max);
const portion = z
  .number()
  .finite()
  .min(0.01)
  .max(10)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-7, 'Use at most two decimal places');
export const dateValue = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const date = new Date(`${v}T00:00:00.000Z`);
    return (
      v.slice(0, 4) !== '0000' &&
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === v
    );
  }, 'Use a valid calendar date');
export const weekValue = dateValue.refine(
  (v) =>
    new Date(`${v}T00:00:00Z`).getUTCDay() === 1 &&
    new Date(Date.parse(`${v}T00:00:00Z`) + 6 * 86400000)
      .toISOString()
      .slice(0, 10)
      .match(/^\d{4}-\d{2}-\d{2}$/) !== null,
  'weekStart must be a Monday within the supported calendar range',
);
const pagination = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
};
const articleQuery = z
  .object({
    ...pagination,
    q: optionalText(100).default(''),
    category: optionalText(100).default(''),
    tag: optionalText(100).default(''),
  })
  .strict();
const foodQuery = z
  .object({ ...pagination, q: optionalText(100).default(''), group: optionalText(100).default('') })
  .strict();
const basicQuery = z.object(pagination).strict();
const articleShape = z
  .object({
    title: text(240),
    subtitle: optionalText(500).default(''),
    category: optionalText(100).default(''),
    tag: optionalText(100).default(''),
    time: optionalText(80).default(''),
    paras: z.array(z.string().max(10000)).max(50).default([]),
    imageId: uuid.nullable().default(null),
    published: z.boolean().default(false),
  })
  .strict();
const articlePatch = partialSchema(articleShape);
const foodShape = z
  .object({
    name: text(200),
    detail: text(300),
    kcal: z.number().finite().min(0).max(10000),
    group: optionalText(100).default(''),
    active: z.boolean().default(true),
  })
  .strict();
const foodPatch = partialSchema(foodShape);
const mealTemplateShape = z
  .object({
    name: text(200),
    description: optionalText(2000).default(''),
    active: z.boolean().default(false),
    entries: z
      .array(z.object({ foodId: uuid, meal: text(100), portions: portion }).strict())
      .max(50)
      .default([]),
  })
  .strict();
const mealTemplatePatch = partialSchema(mealTemplateShape);
const activityShape = z
  .object({
    id: uuid.optional(),
    name: text(200),
    minutes: z.number().int().min(0).max(600),
    type: optionalText(100).default(''),
  })
  .strict();
const exerciseTemplateShape = z
  .object({
    name: text(200),
    description: optionalText(2000).default(''),
    active: z.boolean().default(false),
    days: z.array(z.array(activityShape).max(30)).length(7),
  })
  .strict();
const exerciseTemplatePatch = partialSchema(exerciseTemplateShape);
const mealEntryShape = z
  .object({ date: dateValue, foodId: uuid, meal: text(100), portions: portion.default(1) })
  .strict();
const mealEntryPatch = z
  .object({ date: dateValue.optional(), meal: text(100).optional(), portions: portion.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide a change');
const applyMealShape = z
  .object({
    templateId: uuid,
    date: dateValue,
    mode: z.enum(['append', 'replace']).default('append'),
  })
  .strict();
const exerciseEntryShape = z
  .object({
    date: dateValue,
    name: text(200),
    minutes: z.number().int().min(0).max(600),
    type: optionalText(100).default(''),
    completed: z.boolean().default(false),
  })
  .strict();
const exerciseEntryPatch = partialSchema(exerciseEntryShape).refine(
  (v) => Object.keys(v).length > 0,
  'Provide a change',
);
const applyExerciseShape = z
  .object({
    templateId: uuid,
    weekStart: weekValue,
    mode: z.enum(['append', 'replace']).default('replace'),
  })
  .strict();
const healthShape = z
  .object({
    heightCm: z.number().finite().positive().max(300).nullable().optional(),
    weightKg: z.number().finite().positive().max(1000).nullable().optional(),
    goal: optionalText(2000).default(''),
  })
  .strict();
const deleteWellnessShape = z.object({ confirm: z.literal(true) }).strict();
const dateRangeShape = z
  .object({
    ...pagination,
    date: dateValue.optional(),
    from: dateValue.optional(),
    to: dateValue.optional(),
  })
  .strict();
const weekQuery = z.object({ weekStart: weekValue.optional() }).strict();

function required<T>(row: T | undefined): T {
  if (!row) fail(404, 'NOT_FOUND', 'Resource not found');
  return row as T;
}
function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
function today() {
  return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
}
function thisMonday() {
  const date = today();
  return addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
}
function article(row: Row) {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    category: row.category,
    tag: row.tag,
    time: row.reading_time,
    paras: row.paragraphs,
    imageId: row.image_id,
    imageUrl: row.image_id ? `/api/v1/uploads/${row.image_id}` : null,
    published: row.published,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function food(row: Row) {
  return {
    id: row.id,
    name: row.name,
    detail: row.detail,
    kcal: Number(row.kcal),
    group: row.group_name,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mealEntry(row: Row) {
  // Both stored numbers have two decimal places. Round the integer product once,
  // half up, instead of multiplying binary floats (e.g. 0.57 × 0.5).
  const kcalHundredths = Math.round(Number(row.kcal_per_portion) * 100);
  const portionHundredths = Math.round(Number(row.portions) * 100);
  const totalHundredths = Math.floor((kcalHundredths * portionHundredths + 50) / 100);
  return {
    id: row.id,
    date: row.date ?? String(row.entry_date).slice(0, 10),
    meal: row.meal,
    foodId: row.food_id,
    foodName: row.food_name,
    detail: row.portion_label,
    kcalPerPortion: Number(row.kcal_per_portion),
    portions: Number(row.portions),
    totalKcal: totalHundredths / 100,
    templateId: row.template_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function exerciseEntry(row: Row) {
  return {
    id: row.id,
    date: row.date ?? String(row.entry_date).slice(0, 10),
    name: row.name,
    minutes: row.minutes,
    type: row.activity_type,
    completed: row.completed,
    templateId: row.template_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
async function lockOwner(tx: Sql, userId: string) {
  await tx.one('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
}
async function validateImage(tx: Sql, imageId: string | null, userId: string) {
  if (
    imageId &&
    !(await tx.one("SELECT id FROM uploads WHERE id=$1 AND owner_id=$2 AND kind='article'", [
      imageId,
      userId,
    ]))
  )
    fail(422, 'INVALID_IMAGE', 'Choose an article image uploaded by this account');
}
function validateArticle(value: z.infer<typeof articleShape>) {
  if (value.published && !value.paras.some((p) => p.trim()))
    fail(422, 'EMPTY_ARTICLE', 'Published articles require content');
}
function validateExercise(value: z.infer<typeof exerciseTemplateShape>) {
  const activities = value.days.flat();
  if (value.active && !activities.length)
    fail(422, 'EMPTY_TEMPLATE', 'An active exercise template needs an activity');
  const ids = activities.map((a) => a.id).filter(Boolean);
  if (new Set(ids).size !== ids.length)
    fail(422, 'DUPLICATE_ACTIVITY', 'Activity IDs must be unique across the week');
  return value.days.map((day) => day.map((a) => ({ ...a, id: a.id ?? randomUUID() })));
}
function mealTemplateDto(row: Row, entries: Row[]) {
  return {
    ...camel(row),
    entries: entries.map((e) => ({
      foodId: e.food_id,
      meal: e.meal,
      portions: Number(e.portions),
    })),
    available: row.active && entries.length > 0 && entries.every((e) => e.food_active),
  };
}
async function mealTemplate(tx: Sql, row: Row) {
  const entries = await tx.query(
    'SELECT e.food_id,e.meal,e.portions,f.active AS food_active FROM meal_template_entries e JOIN foods f ON f.id=e.food_id WHERE e.template_id=$1 ORDER BY e.position',
    [row.id],
  );
  return mealTemplateDto(row, entries);
}
async function validateMealFoods(tx: Sql, value: z.infer<typeof mealTemplateShape>) {
  if (value.active && !value.entries.length)
    fail(422, 'EMPTY_TEMPLATE', 'An active meal template needs a food entry');
  const ids = [...new Set(value.entries.map((e) => e.foodId))].sort();
  if (!ids.length) return;
  const found = await tx.query(
    'SELECT id,active FROM foods WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
    [ids],
  );
  if (found.length !== ids.length)
    fail(422, 'INVALID_FOOD', 'A template refers to an unknown food');
  if (value.active && found.some((f) => !f.active))
    fail(
      422,
      'INACTIVE_FOOD',
      'Activate referenced foods before activating or changing this template',
    );
}
async function replaceMealTemplateEntries(
  tx: Sql,
  id: string,
  entries: z.infer<typeof mealTemplateShape>['entries'],
) {
  await tx.query('DELETE FROM meal_template_entries WHERE template_id=$1', [id]);
  for (const [position, item] of entries.entries())
    await tx.query(
      'INSERT INTO meal_template_entries(template_id,food_id,meal,portions,position) VALUES($1,$2,$3,$4,$5)',
      [id, item.foodId, item.meal, item.portions, position],
    );
}
function range(request: FastifyRequest) {
  const q = parse(dateRangeShape, request.query);
  if (q.date && (q.from || q.to)) fail(422, 'INVALID_DATE_RANGE', 'Use date or from/to, not both');
  const from = q.date ?? q.from ?? today();
  const to = q.date ?? q.to ?? from;
  if (from > to || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 366 * 86400000)
    fail(422, 'INVALID_DATE_RANGE', 'Use a date range of at most 366 days in chronological order');
  return { ...q, from, to };
}

function literalPattern(value: string) {
  return '%' + value.replace(/[\\%_]/g, '\\$&') + '%';
}

/** One predicate for public/admin search and account-owned bookmark search. */
function articleFilter(q: z.infer<typeof articleQuery>, includeDrafts: boolean, ownerId?: string) {
  const values: unknown[] = [includeDrafts, q.category, q.tag];
  const parts = ['($1::boolean OR a.published)', "($2='' OR a.category=$2)", "($3='' OR a.tag=$3)"];
  if (ownerId) {
    values.push(ownerId);
    parts.push(`b.user_id=$${values.length}`);
  }
  const searchable =
    "concat_ws(' ',a.title,a.subtitle,a.category,a.tag,(SELECT string_agg(value,' ') FROM jsonb_array_elements_text(a.paragraphs)))";
  for (const word of q.q.split(/\s+/).filter(Boolean)) {
    values.push(literalPattern(word));
    parts.push(`${searchable} ILIKE $${values.length}`);
  }
  return { values, where: 'WHERE ' + parts.join(' AND ') };
}

export const registerWellness: Module = async (_app, ctx, route) => {
  const db = ctx.db;
  const publicOptions = (summary: string) => ({ auth: false, summary, tag: 'Wellness content' });
  const adminOptions = (summary: string, schema?: z.ZodType) => ({
    roles: ['admin'] as ['admin'],
    summary,
    tag: 'Content administration',
    ...(schema ? { body: jsonSchema(schema) } : {}),
  });
  const memberOptions = (summary: string, schema?: z.ZodType) => ({
    summary,
    tag: 'Personal wellness',
    ...(schema ? { body: jsonSchema(schema) } : {}),
  });

  route(
    'GET',
    '/api/v1/articles/filters',
    {
      ...publicOptions('Discover categories and tags across all published articles'),
      query: jsonSchema(z.object({}).strict()),
    },
    async () => {
      const facets = await db.query(`
      SELECT 'category' AS kind,category AS value,count(*)::int AS count
      FROM articles WHERE published AND category<>'' GROUP BY category
      UNION ALL
      SELECT 'tag' AS kind,tag AS value,count(*)::int AS count
      FROM articles WHERE published AND tag<>'' GROUP BY tag
      ORDER BY kind,value`);
      const entries = (kind: string) =>
        facets
          .filter((row) => row.kind === kind)
          .map((row) => ({ value: row.value, count: Number(row.count) }));
      return data({ categories: entries('category'), tags: entries('tag') });
    },
  );
  route(
    'GET',
    '/api/v1/foods/groups',
    {
      ...publicOptions('Discover groups across all active food records'),
      query: jsonSchema(z.object({}).strict()),
    },
    async () =>
      data(
        (
          await db.query(
            "SELECT group_name AS value,count(*)::int AS count FROM foods WHERE active AND group_name<>'' GROUP BY group_name ORDER BY group_name",
          )
        ).map((row) => ({ value: row.value, count: Number(row.count) })),
      ),
  );

  for (const isAdmin of [false, true]) {
    const prefix = isAdmin ? '/api/v1/admin' : '/api/v1';
    route(
      'GET',
      `${prefix}/articles`,
      {
        ...(isAdmin
          ? adminOptions('List all article drafts and published articles')
          : publicOptions('Search published articles')),
        query: jsonSchema(articleQuery),
      },
      async (req) => {
        const q = parse(articleQuery, req.query);
        const { values, where } = articleFilter(q, isAdmin);
        const rows = await db.query(
          `SELECT a.* FROM articles a ${where} ORDER BY a.created_at DESC,a.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, q.limit, q.offset],
        );
        const count = await db.one(`SELECT count(*) AS total FROM articles a ${where}`, values);
        return list(rows.map(article), q.limit, q.offset, Number(count!.total));
      },
    );
    route(
      'GET',
      `${prefix}/articles/:id`,
      isAdmin
        ? adminOptions('Read an article including drafts')
        : publicOptions('Read a published article'),
      async (req) => {
        return data(
          article(
            required(
              await db.one('SELECT * FROM articles WHERE id=$1 AND ($2::boolean OR published)', [
                paramsId(req),
                isAdmin,
              ]),
            ),
          ),
        );
      },
    );
    route(
      'GET',
      `${prefix}/foods`,
      {
        ...(isAdmin
          ? adminOptions('List foods including inactive records')
          : publicOptions('Search active foods and calories')),
        query: jsonSchema(foodQuery),
      },
      async (req) => {
        const q = parse(foodQuery, req.query);
        const values = [isAdmin, q.q ? literalPattern(q.q) : '', q.group];
        const where =
          "WHERE ($1::boolean OR active) AND ($2='' OR name ILIKE $2 OR detail ILIKE $2) AND ($3='' OR group_name=$3)";
        const rows = await db.query(
          `SELECT * FROM foods ${where} ORDER BY name,id LIMIT $4 OFFSET $5`,
          [...values, q.limit, q.offset],
        );
        return list(
          rows.map(food),
          q.limit,
          q.offset,
          Number((await db.one(`SELECT count(*) total FROM foods ${where}`, values))!.total),
        );
      },
    );
    route(
      'GET',
      `${prefix}/foods/:id`,
      isAdmin
        ? adminOptions('Read a food including inactive records')
        : publicOptions('Read an active food'),
      async (req) =>
        data(
          food(
            required(
              await db.one('SELECT * FROM foods WHERE id=$1 AND ($2::boolean OR active)', [
                paramsId(req),
                isAdmin,
              ]),
            ),
          ),
        ),
    );
    route(
      'GET',
      `${prefix}/meal-templates`,
      {
        ...(isAdmin
          ? adminOptions('List meal templates and current availability')
          : publicOptions('List available meal templates')),
        query: jsonSchema(basicQuery),
      },
      async (req) => {
        const q = parse(basicQuery, req.query);
        const where =
          'WHERE ($1::boolean OR (active AND EXISTS(SELECT 1 FROM meal_template_entries e WHERE e.template_id=t.id) AND NOT EXISTS(SELECT 1 FROM meal_template_entries e JOIN foods f ON f.id=e.food_id WHERE e.template_id=t.id AND NOT f.active)))';
        const rows = await db.query(
          `SELECT t.* FROM meal_templates t ${where} ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`,
          [isAdmin, q.limit, q.offset],
        );
        const entries = rows.length
          ? await db.query(
              'SELECT e.template_id,e.food_id,e.meal,e.portions,f.active AS food_active FROM meal_template_entries e JOIN foods f ON f.id=e.food_id WHERE e.template_id=ANY($1::uuid[]) ORDER BY e.template_id,e.position',
              [rows.map((row) => row.id)],
            )
          : [];
        const byTemplate = new Map<string, Row[]>();
        for (const entry of entries)
          byTemplate.set(entry.template_id, [...(byTemplate.get(entry.template_id) ?? []), entry]);
        const result = rows.map((row) => mealTemplateDto(row, byTemplate.get(row.id) ?? []));
        return list(
          result,
          q.limit,
          q.offset,
          Number(
            (await db.one(`SELECT count(*) total FROM meal_templates t ${where}`, [isAdmin]))!
              .total,
          ),
        );
      },
    );
    route(
      'GET',
      `${prefix}/meal-templates/:id`,
      isAdmin
        ? adminOptions('Read a meal template')
        : publicOptions('Read an available meal template'),
      async (req) => {
        const result = await mealTemplate(
          db,
          required(await db.one('SELECT * FROM meal_templates WHERE id=$1', [paramsId(req)])),
        );
        if (!isAdmin && !result.available) fail(404, 'NOT_FOUND', 'Resource not found');
        return data(result);
      },
    );
    route(
      'GET',
      `${prefix}/exercise-templates`,
      {
        ...(isAdmin
          ? adminOptions('List exercise templates including inactive templates')
          : publicOptions('List active seven-day exercise templates')),
        query: jsonSchema(basicQuery),
      },
      async (req) => {
        const q = parse(basicQuery, req.query);
        const rows = await db.query(
          'SELECT * FROM exercise_templates WHERE ($1::boolean OR active) ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',
          [isAdmin, q.limit, q.offset],
        );
        return list(
          rows,
          q.limit,
          q.offset,
          Number(
            (await db.one(
              'SELECT count(*) total FROM exercise_templates WHERE ($1::boolean OR active)',
              [isAdmin],
            ))!.total,
          ),
        );
      },
    );
    route(
      'GET',
      `${prefix}/exercise-templates/:id`,
      isAdmin
        ? adminOptions('Read an exercise template')
        : publicOptions('Read an active exercise template'),
      async (req) =>
        data(
          camel(
            required(
              await db.one(
                'SELECT * FROM exercise_templates WHERE id=$1 AND ($2::boolean OR active)',
                [paramsId(req), isAdmin],
              ),
            ),
          ),
        ),
    );
  }

  route(
    'POST',
    '/api/v1/admin/articles',
    adminOptions('Create an article draft or publish an article', articleShape),
    async (req, reply) => {
      const value = parse(articleShape, req.body);
      validateArticle(value);
      const saved = await db.transaction(async (tx) => {
        await validateImage(tx, value.imageId, req.actor!.id);
        const row = required(
          await tx.one(
            'INSERT INTO articles(title,subtitle,category,tag,reading_time,paragraphs,image_id,published) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *',
            [
              value.title,
              value.subtitle,
              value.category,
              value.tag,
              value.time,
              JSON.stringify(value.paras),
              value.imageId,
              value.published,
            ],
          ),
        );
        await audit(tx, req.actor!, 'article.create', 'article', row.id, {
          published: value.published,
        });
        return row;
      });
      reply.code(201);
      return data(article(saved));
    },
  );
  route(
    'PATCH',
    '/api/v1/admin/articles/:id',
    adminOptions('Edit, publish or unpublish an article', articlePatch),
    async (req) => {
      const patch = parse(articlePatch, req.body);
      const saved = await db.transaction(async (tx) => {
        const old = required(
          await tx.one('SELECT * FROM articles WHERE id=$1 FOR UPDATE', [paramsId(req)]),
        );
        const base = {
          title: old.title,
          subtitle: old.subtitle,
          category: old.category,
          tag: old.tag,
          time: old.reading_time,
          paras: old.paragraphs,
          imageId: old.image_id,
          published: old.published,
        };
        const value = parse(articleShape, { ...base, ...patch });
        validateArticle(value);
        if (patch.imageId !== undefined) await validateImage(tx, value.imageId, req.actor!.id);
        const row = required(
          await tx.one(
            'UPDATE articles SET title=$2,subtitle=$3,category=$4,tag=$5,reading_time=$6,paragraphs=$7::jsonb,image_id=$8,published=$9,updated_at=now() WHERE id=$1 RETURNING *',
            [
              old.id,
              value.title,
              value.subtitle,
              value.category,
              value.tag,
              value.time,
              JSON.stringify(value.paras),
              value.imageId,
              value.published,
            ],
          ),
        );
        await audit(tx, req.actor!, 'article.update', 'article', row.id, {
          published: value.published,
        });
        return row;
      });
      return data(article(saved));
    },
  );
  route(
    'DELETE',
    '/api/v1/admin/articles/:id',
    adminOptions('Delete an article and its bookmarks'),
    async (req) =>
      db.transaction(async (tx) => {
        const row = required(
          await tx.one('DELETE FROM articles WHERE id=$1 RETURNING id', [paramsId(req)]),
        );
        await audit(tx, req.actor!, 'article.delete', 'article', row.id);
        return data({ deleted: true });
      }),
  );

  route(
    'GET',
    '/api/v1/me/article-bookmarks',
    {
      ...memberOptions('List this account’s published article bookmarks'),
      query: jsonSchema(articleQuery),
    },
    async (req) => {
      const q = parse(articleQuery, req.query);
      const { values, where } = articleFilter(q, false, req.actor!.id);
      const rows = await db.query(
        `SELECT a.* FROM article_bookmarks b JOIN articles a ON a.id=b.article_id ${where} ORDER BY b.created_at DESC,a.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, q.limit, q.offset],
      );
      const count = await db.one(
        `SELECT count(*) total FROM article_bookmarks b JOIN articles a ON a.id=b.article_id ${where}`,
        values,
      );
      return list(rows.map(article), q.limit, q.offset, Number(count!.total));
    },
  );
  route(
    'PUT',
    '/api/v1/me/article-bookmarks/:id',
    memberOptions('Bookmark a published article'),
    async (req) =>
      db.transaction(async (tx) => {
        await lockOwner(tx, req.actor!.id);
        const id = paramsId(req);
        required(await tx.one('SELECT id FROM articles WHERE id=$1 AND published FOR SHARE', [id]));
        await tx.query(
          'INSERT INTO article_bookmarks(user_id,article_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [req.actor!.id, id],
        );
        return data({ articleId: id, bookmarked: true });
      }),
  );
  route(
    'DELETE',
    '/api/v1/me/article-bookmarks/:id',
    memberOptions('Remove this account’s article bookmark'),
    async (req) =>
      db.transaction(async (tx) => {
        await lockOwner(tx, req.actor!.id);
        const id = paramsId(req);
        await tx.query('DELETE FROM article_bookmarks WHERE user_id=$1 AND article_id=$2', [
          req.actor!.id,
          id,
        ]);
        return data({ articleId: id, bookmarked: false });
      }),
  );

  route(
    'POST',
    '/api/v1/admin/foods',
    adminOptions('Create a food and calorie record', foodShape),
    async (req, reply) => {
      const value = parse(foodShape, req.body);
      const saved = await db.transaction(async (tx) => {
        const row = required(
          await tx.one(
            'INSERT INTO foods(name,detail,kcal,group_name,active) VALUES($1,$2,$3,$4,$5) RETURNING *',
            [value.name, value.detail, value.kcal, value.group, value.active],
          ),
        );
        await audit(tx, req.actor!, 'food.create', 'food', row.id);
        return row;
      });
      reply.code(201);
      return data(food(saved));
    },
  );
  route(
    'PATCH',
    '/api/v1/admin/foods/:id',
    adminOptions('Edit or deactivate a food without rewriting meal history', foodPatch),
    async (req) => {
      const patch = parse(foodPatch, req.body);
      return data(
        food(
          await db.transaction(async (tx) => {
            const old = required(
              await tx.one('SELECT * FROM foods WHERE id=$1 FOR UPDATE', [paramsId(req)]),
            );
            const value = parse(foodShape, {
              name: old.name,
              detail: old.detail,
              kcal: Number(old.kcal),
              group: old.group_name,
              active: old.active,
              ...patch,
            });
            const saved = required(
              await tx.one(
                'UPDATE foods SET name=$2,detail=$3,kcal=$4,group_name=$5,active=$6,updated_at=now() WHERE id=$1 RETURNING *',
                [old.id, value.name, value.detail, value.kcal, value.group, value.active],
              ),
            );
            await audit(tx, req.actor!, 'food.update', 'food', old.id, { active: value.active });
            return saved;
          }),
        ),
      );
    },
  );
  route(
    'DELETE',
    '/api/v1/admin/foods/:id',
    adminOptions('Delete an unreferenced food; preserve diary snapshots'),
    async (req) =>
      db.transaction(async (tx) => {
        const id = paramsId(req);
        required(await tx.one('SELECT id FROM foods WHERE id=$1 FOR UPDATE', [id]));
        if (await tx.one('SELECT id FROM meal_template_entries WHERE food_id=$1 LIMIT 1', [id]))
          fail(409, 'FOOD_REFERENCED', 'Remove this food from meal templates or deactivate it');
        await tx.query('DELETE FROM foods WHERE id=$1', [id]);
        await audit(tx, req.actor!, 'food.delete', 'food', id);
        return data({ deleted: true });
      }),
  );

  route(
    'POST',
    '/api/v1/admin/meal-templates',
    adminOptions('Create a meal template with validated food references', mealTemplateShape),
    async (req, reply) => {
      const value = parse(mealTemplateShape, req.body);
      const saved = await db.transaction(async (tx) => {
        await validateMealFoods(tx, value);
        const row = required(
          await tx.one(
            'INSERT INTO meal_templates(name,description,active) VALUES($1,$2,$3) RETURNING *',
            [value.name, value.description, value.active],
          ),
        );
        await replaceMealTemplateEntries(tx, row.id, value.entries);
        await audit(tx, req.actor!, 'meal-template.create', 'meal-template', row.id);
        return mealTemplate(tx, row);
      });
      reply.code(201);
      return data(saved);
    },
  );
  route(
    'PATCH',
    '/api/v1/admin/meal-templates/:id',
    adminOptions('Edit or activate a meal template', mealTemplatePatch),
    async (req) => {
      const patch = parse(mealTemplatePatch, req.body);
      return data(
        await db.transaction(async (tx) => {
          const old = required(
            await tx.one('SELECT * FROM meal_templates WHERE id=$1 FOR UPDATE', [paramsId(req)]),
          );
          const prior = await mealTemplate(tx, old);
          const value = parse(mealTemplateShape, {
            name: old.name,
            description: old.description,
            active: old.active,
            entries: prior.entries,
            ...patch,
          });
          // Metadata-only edits preserve an active template temporarily made unavailable by food deactivation.
          if (patch.entries !== undefined || (!old.active && value.active))
            await validateMealFoods(tx, value);
          else if (value.active && !value.entries.length)
            fail(422, 'EMPTY_TEMPLATE', 'An active meal template needs a food entry');
          const row = required(
            await tx.one(
              'UPDATE meal_templates SET name=$2,description=$3,active=$4,updated_at=now() WHERE id=$1 RETURNING *',
              [old.id, value.name, value.description, value.active],
            ),
          );
          if (patch.entries !== undefined)
            await replaceMealTemplateEntries(tx, old.id, value.entries);
          await audit(tx, req.actor!, 'meal-template.update', 'meal-template', old.id);
          return mealTemplate(tx, row);
        }),
      );
    },
  );
  route(
    'DELETE',
    '/api/v1/admin/meal-templates/:id',
    adminOptions('Delete a meal template without deleting copied diary entries'),
    async (req) =>
      db.transaction(async (tx) => {
        const row = required(
          await tx.one('DELETE FROM meal_templates WHERE id=$1 RETURNING id', [paramsId(req)]),
        );
        await audit(tx, req.actor!, 'meal-template.delete', 'meal-template', row.id);
        return data({ deleted: true });
      }),
  );

  route(
    'POST',
    '/api/v1/admin/exercise-templates',
    adminOptions('Create a seven-day exercise template', exerciseTemplateShape),
    async (req, reply) => {
      const value = parse(exerciseTemplateShape, req.body);
      const days = validateExercise(value);
      const saved = await db.transaction(async (tx) => {
        const row = required(
          await tx.one(
            'INSERT INTO exercise_templates(name,description,active,days) VALUES($1,$2,$3,$4::jsonb) RETURNING *',
            [value.name, value.description, value.active, JSON.stringify(days)],
          ),
        );
        await audit(tx, req.actor!, 'exercise-template.create', 'exercise-template', row.id);
        return row;
      });
      reply.code(201);
      return data(camel(saved));
    },
  );
  route(
    'PATCH',
    '/api/v1/admin/exercise-templates/:id',
    adminOptions(
      'Edit an exercise template without rewriting copied schedules',
      exerciseTemplatePatch,
    ),
    async (req) => {
      const patch = parse(exerciseTemplatePatch, req.body);
      return data(
        camel(
          await db.transaction(async (tx) => {
            const old = required(
              await tx.one('SELECT * FROM exercise_templates WHERE id=$1 FOR UPDATE', [
                paramsId(req),
              ]),
            );
            const value = parse(exerciseTemplateShape, {
              name: old.name,
              description: old.description,
              active: old.active,
              days: old.days,
              ...patch,
            });
            const days = validateExercise(value);
            const row = required(
              await tx.one(
                'UPDATE exercise_templates SET name=$2,description=$3,active=$4,days=$5::jsonb,updated_at=now() WHERE id=$1 RETURNING *',
                [old.id, value.name, value.description, value.active, JSON.stringify(days)],
              ),
            );
            await audit(tx, req.actor!, 'exercise-template.update', 'exercise-template', old.id);
            return row;
          }),
        ),
      );
    },
  );
  route(
    'DELETE',
    '/api/v1/admin/exercise-templates/:id',
    adminOptions('Delete a template without deleting copied exercise entries'),
    async (req) =>
      db.transaction(async (tx) => {
        const row = required(
          await tx.one('DELETE FROM exercise_templates WHERE id=$1 RETURNING id', [paramsId(req)]),
        );
        await audit(tx, req.actor!, 'exercise-template.delete', 'exercise-template', row.id);
        return data({ deleted: true });
      }),
  );

  route(
    'GET',
    '/api/v1/me/meal-diary',
    {
      ...memberOptions('Read this account’s meal snapshots and daily calorie totals'),
      query: jsonSchema(dateRangeShape),
    },
    async (req) => {
      const q = range(req);
      const rows = await db.query(
        'SELECT *,entry_date::text AS date FROM meal_entries WHERE user_id=$1 AND entry_date BETWEEN $2::date AND $3::date ORDER BY entry_date,created_at,id LIMIT $4 OFFSET $5',
        [req.actor!.id, q.from, q.to, q.limit, q.offset],
      );
      const count = await db.one(
        'SELECT count(*) total FROM meal_entries WHERE user_id=$1 AND entry_date BETWEEN $2::date AND $3::date',
        [req.actor!.id, q.from, q.to],
      );
      const totals = await db.query(
        'SELECT entry_date::text AS date,sum(round(kcal_per_portion*portions,2)) AS kcal FROM meal_entries WHERE user_id=$1 AND entry_date BETWEEN $2::date AND $3::date GROUP BY entry_date ORDER BY entry_date',
        [req.actor!.id, q.from, q.to],
      );
      return {
        ...list(rows.map(mealEntry), q.limit, q.offset, Number(count!.total)),
        totalsByDate: totals.map((t) => ({ date: t.date, kcal: Number(t.kcal) })),
      };
    },
  );
  route(
    'GET',
    '/api/v1/me/meal-diary/:id',
    memberOptions('Read one owned historical meal entry'),
    async (req) =>
      data(
        mealEntry(
          required(
            await db.one(
              'SELECT *,entry_date::text AS date FROM meal_entries WHERE id=$1 AND user_id=$2',
              [paramsId(req), req.actor!.id],
            ),
          ),
        ),
      ),
  );
  route(
    'POST',
    '/api/v1/me/meal-diary',
    memberOptions(
      'Log a food with an immutable name, portion and calorie snapshot',
      mealEntryShape,
    ),
    async (req, reply) => {
      const value = parse(mealEntryShape, req.body);
      const saved = await db.transaction(async (tx) => {
        await lockOwner(tx, req.actor!.id);
        const f = required(
          await tx.one('SELECT * FROM foods WHERE id=$1 AND active FOR SHARE', [value.foodId]),
        );
        const count = await tx.one(
          'SELECT count(*) total FROM meal_entries WHERE user_id=$1 AND entry_date=$2::date',
          [req.actor!.id, value.date],
        );
        if (Number(count!.total) >= 200)
          fail(409, 'DAY_LIMIT', 'A day supports at most 200 meal entries');
        return required(
          await tx.one(
            'INSERT INTO meal_entries(user_id,entry_date,meal,food_id,food_name,portion_label,kcal_per_portion,portions) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *,entry_date::text AS date',
            [req.actor!.id, value.date, value.meal, f.id, f.name, f.detail, f.kcal, value.portions],
          ),
        );
      });
      reply.code(201);
      return data(mealEntry(saved));
    },
  );
  route(
    'PATCH',
    '/api/v1/me/meal-diary/:id',
    memberOptions(
      'Edit date, meal or portions while retaining the historical food snapshot',
      mealEntryPatch,
    ),
    async (req) => {
      const patch = parse(mealEntryPatch, req.body);
      const saved = await db.transaction(async (tx) => {
        await lockOwner(tx, req.actor!.id);
        const old = required(
          await tx.one(
            'SELECT *,entry_date::text AS date FROM meal_entries WHERE id=$1 AND user_id=$2 FOR UPDATE',
            [paramsId(req), req.actor!.id],
          ),
        );
        if (
          patch.date &&
          patch.date !== old.date &&
          Number(
            (await tx.one(
              'SELECT count(*) total FROM meal_entries WHERE user_id=$1 AND entry_date=$2::date',
              [req.actor!.id, patch.date],
            ))!.total,
          ) >= 200
        )
          fail(409, 'DAY_LIMIT', 'A day supports at most 200 meal entries');
        return required(
          await tx.one(
            'UPDATE meal_entries SET entry_date=$3,meal=$4,portions=$5,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *,entry_date::text AS date',
            [
              old.id,
              req.actor!.id,
              patch.date ?? old.date,
              patch.meal ?? old.meal,
              patch.portions ?? Number(old.portions),
            ],
          ),
        );
      });
      return data(mealEntry(saved));
    },
  );
  route(
    'DELETE',
    '/api/v1/me/meal-diary/:id',
    memberOptions('Delete one of this account’s meal entries'),
    async (req) =>
      db.transaction(async (tx) => {
        await lockOwner(tx, req.actor!.id);
        required(
          await tx.one('DELETE FROM meal_entries WHERE id=$1 AND user_id=$2 RETURNING id', [
            paramsId(req),
            req.actor!.id,
          ]),
        );
        return data({ deleted: true });
      }),
  );
  route(
    'POST',
    '/api/v1/me/meal-diary/apply-template',
    memberOptions('Append or replace one day with copied meal-template snapshots', applyMealShape),
    async (req, reply) => {
      const value = parse(applyMealShape, req.body);
      const saved = await db.transaction(async (tx) => {
        await lockOwner(tx, req.actor!.id);
        required(
          await tx.one('SELECT id FROM meal_templates WHERE id=$1 AND active FOR SHARE', [
            value.templateId,
          ]),
        );
        const entries = await tx.query(
          'SELECT e.*,f.name,f.detail,f.kcal,f.active FROM meal_template_entries e JOIN foods f ON f.id=e.food_id WHERE e.template_id=$1 ORDER BY f.id,e.position FOR SHARE OF f',
          [value.templateId],
        );
        if (!entries.length || entries.some((e) => !e.active))
          fail(409, 'TEMPLATE_UNAVAILABLE', 'This template contains unavailable food');
        const current = Number(
          (await tx.one(
            'SELECT count(*) total FROM meal_entries WHERE user_id=$1 AND entry_date=$2::date',
            [req.actor!.id, value.date],
          ))!.total,
        );
        if ((value.mode === 'append' ? current : 0) + entries.length > 200)
          fail(409, 'DAY_LIMIT', 'A day supports at most 200 meal entries');
        if (value.mode === 'replace')
          await tx.query('DELETE FROM meal_entries WHERE user_id=$1 AND entry_date=$2::date', [
            req.actor!.id,
            value.date,
          ]);
        const result = [];
        for (const entry of entries.sort((a, b) => a.position - b.position))
          result.push(
            required(
              await tx.one(
                'INSERT INTO meal_entries(user_id,entry_date,meal,food_id,food_name,portion_label,kcal_per_portion,portions,template_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *,entry_date::text AS date',
                [
                  req.actor!.id,
                  value.date,
                  entry.meal,
                  entry.food_id,
                  entry.name,
                  entry.detail,
                  entry.kcal,
                  entry.portions,
                  value.templateId,
                ],
              ),
            ),
          );
        return result;
      });
      reply.code(201);
      return data(saved.map(mealEntry));
    },
  );

  route(
    'GET',
    '/api/v1/me/exercise-schedule',
    {
      ...memberOptions('Read this account’s seven-day exercise schedule'),
      query: jsonSchema(weekQuery),
    },
    async (req) => {
      const q = parse(weekQuery, req.query);
      const weekStart = q.weekStart ?? thisMonday();
      const rows = await db.query(
        'SELECT *,entry_date::text AS date FROM exercise_entries WHERE user_id=$1 AND entry_date BETWEEN $2::date AND $3::date ORDER BY entry_date,created_at,id',
        [req.actor!.id, weekStart, addDays(weekStart, 6)],
      );
      return data({
        weekStart,
        days: Array.from({ length: 7 }, (_, i) => {
          const date = addDays(weekStart, i);
          return { date, activities: rows.filter((r) => r.date === date).map(exerciseEntry) };
        }),
      });
    },
  );
  route(
    'GET',
    '/api/v1/me/exercise-schedule/:id',
    memberOptions('Read one owned personal exercise activity'),
    async (req) =>
      data(
        exerciseEntry(
          required(
            await db.one(
              'SELECT *,entry_date::text AS date FROM exercise_entries WHERE id=$1 AND user_id=$2',
              [paramsId(req), req.actor!.id],
            ),
          ),
        ),
      ),
  );
  route(
    'POST',
    '/api/v1/me/exercise-schedule',
    memberOptions('Add a personal exercise activity', exerciseEntryShape),
    async (req, reply) => {
      const value = parse(exerciseEntryShape, req.body);
      const saved = await db.transaction(async (tx) => {
        await lockOwner(tx, req.actor!.id);
        if (
          Number(
            (await tx.one(
              'SELECT count(*) total FROM exercise_entries WHERE user_id=$1 AND entry_date=$2::date',
              [req.actor!.id, value.date],
            ))!.total,
          ) >= 100
        )
          fail(409, 'DAY_LIMIT', 'A day supports at most 100 activities');
        return required(
          await tx.one(
            'INSERT INTO exercise_entries(user_id,entry_date,name,minutes,activity_type,completed) VALUES($1,$2,$3,$4,$5,$6) RETURNING *,entry_date::text AS date',
            [req.actor!.id, value.date, value.name, value.minutes, value.type, value.completed],
          ),
        );
      });
      reply.code(201);
      return data(exerciseEntry(saved));
    },
  );
  route(
    'PATCH',
    '/api/v1/me/exercise-schedule/:id',
    memberOptions('Edit or complete an owned exercise activity', exerciseEntryPatch),
    async (req) => {
      const patch = parse(exerciseEntryPatch, req.body);
      const saved = await db.transaction(async (tx) => {
        await lockOwner(tx, req.actor!.id);
        const old = required(
          await tx.one(
            'SELECT *,entry_date::text AS date FROM exercise_entries WHERE id=$1 AND user_id=$2 FOR UPDATE',
            [paramsId(req), req.actor!.id],
          ),
        );
        if (
          patch.date &&
          patch.date !== old.date &&
          Number(
            (await tx.one(
              'SELECT count(*) total FROM exercise_entries WHERE user_id=$1 AND entry_date=$2::date',
              [req.actor!.id, patch.date],
            ))!.total,
          ) >= 100
        )
          fail(409, 'DAY_LIMIT', 'A day supports at most 100 activities');
        return required(
          await tx.one(
            'UPDATE exercise_entries SET entry_date=$3,name=$4,minutes=$5,activity_type=$6,completed=$7,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *,entry_date::text AS date',
            [
              old.id,
              req.actor!.id,
              patch.date ?? old.date,
              patch.name ?? old.name,
              patch.minutes ?? old.minutes,
              patch.type ?? old.activity_type,
              patch.completed ?? old.completed,
            ],
          ),
        );
      });
      return data(exerciseEntry(saved));
    },
  );
  route(
    'DELETE',
    '/api/v1/me/exercise-schedule/:id',
    memberOptions('Delete an owned exercise activity'),
    async (req) =>
      db.transaction(async (tx) => {
        await lockOwner(tx, req.actor!.id);
        required(
          await tx.one('DELETE FROM exercise_entries WHERE id=$1 AND user_id=$2 RETURNING id', [
            paramsId(req),
            req.actor!.id,
          ]),
        );
        return data({ deleted: true });
      }),
  );
  route(
    'POST',
    '/api/v1/me/exercise-schedule/apply-template',
    memberOptions('Copy a seven-day template into this account’s schedule', applyExerciseShape),
    async (req, reply) => {
      const value = parse(applyExerciseShape, req.body);
      const saved = await db.transaction(async (tx) => {
        await lockOwner(tx, req.actor!.id);
        const template = required(
          await tx.one('SELECT * FROM exercise_templates WHERE id=$1 AND active FOR SHARE', [
            value.templateId,
          ]),
        );
        const days = template.days as z.infer<typeof activityShape>[][];
        if (value.mode === 'replace')
          await tx.query(
            'DELETE FROM exercise_entries WHERE user_id=$1 AND entry_date BETWEEN $2::date AND $3::date',
            [req.actor!.id, value.weekStart, addDays(value.weekStart, 6)],
          );
        const result = [];
        for (let i = 0; i < 7; i++) {
          const date = addDays(value.weekStart, i);
          const current = Number(
            (await tx.one(
              'SELECT count(*) total FROM exercise_entries WHERE user_id=$1 AND entry_date=$2::date',
              [req.actor!.id, date],
            ))!.total,
          );
          if (current + days[i].length > 100)
            fail(409, 'DAY_LIMIT', 'A day supports at most 100 activities');
          for (const activity of days[i])
            result.push(
              required(
                await tx.one(
                  'INSERT INTO exercise_entries(user_id,entry_date,name,minutes,activity_type,template_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *,entry_date::text AS date',
                  [
                    req.actor!.id,
                    date,
                    activity.name,
                    activity.minutes,
                    activity.type,
                    value.templateId,
                  ],
                ),
              ),
            );
        }
        return result;
      });
      reply.code(201);
      return data(saved.map(exerciseEntry));
    },
  );

  route(
    'GET',
    '/api/v1/me/health-profile',
    memberOptions('Read optional self-entered health profile fields'),
    async (req) => {
      const row = await db.one(
        'SELECT height_cm,weight_kg,goal,updated_at FROM health_profiles WHERE user_id=$1',
        [req.actor!.id],
      );
      return data(
        row
          ? {
              heightCm: row.height_cm === null ? null : Number(row.height_cm),
              weightKg: row.weight_kg === null ? null : Number(row.weight_kg),
              goal: row.goal,
              updatedAt: row.updated_at,
            }
          : { heightCm: null, weightKg: null, goal: '' },
      );
    },
  );
  route(
    'PUT',
    '/api/v1/me/health-profile',
    memberOptions(
      'Replace optional self-entered health profile; no medical calculations',
      healthShape,
    ),
    async (req) => {
      const value = parse(healthShape, req.body);
      const row = await db.transaction(async (tx) => {
        await lockOwner(tx, req.actor!.id);
        return required(
          await tx.one(
            'INSERT INTO health_profiles(user_id,height_cm,weight_kg,goal) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET height_cm=EXCLUDED.height_cm,weight_kg=EXCLUDED.weight_kg,goal=EXCLUDED.goal,updated_at=now() RETURNING height_cm,weight_kg,goal,updated_at',
            [req.actor!.id, value.heightCm ?? null, value.weightKg ?? null, value.goal],
          ),
        );
      });
      return data({
        heightCm: row.height_cm === null ? null : Number(row.height_cm),
        weightKg: row.weight_kg === null ? null : Number(row.weight_kg),
        goal: row.goal,
        updatedAt: row.updated_at,
      });
    },
  );
  route(
    'DELETE',
    '/api/v1/me/health-profile',
    memberOptions('Delete this account’s optional health profile'),
    async (req) =>
      db.transaction(async (tx) => {
        await lockOwner(tx, req.actor!.id);
        await tx.query('DELETE FROM health_profiles WHERE user_id=$1', [req.actor!.id]);
        return data({ deleted: true });
      }),
  );
  route(
    'GET',
    '/api/v1/me/wellness/export',
    memberOptions('Export only this account’s personal wellness records'),
    async (req, reply) => {
      const bundle = await db.transaction(async (tx) => {
        await lockOwner(tx, req.actor!.id);
        const meals = await tx.query(
          'SELECT *,entry_date::text AS date FROM meal_entries WHERE user_id=$1 ORDER BY entry_date,created_at LIMIT 10001',
          [req.actor!.id],
        );
        const activities = await tx.query(
          'SELECT *,entry_date::text AS date FROM exercise_entries WHERE user_id=$1 ORDER BY entry_date,created_at LIMIT 10001',
          [req.actor!.id],
        );
        const profile = await tx.one(
          'SELECT height_cm,weight_kg,goal,updated_at FROM health_profiles WHERE user_id=$1',
          [req.actor!.id],
        );
        const bookmarks = await tx.query(
          'SELECT article_id,created_at FROM article_bookmarks WHERE user_id=$1 LIMIT 10001',
          [req.actor!.id],
        );
        if (meals.length > 10000 || activities.length > 10000 || bookmarks.length > 10000)
          fail(
            413,
            'EXPORT_TOO_LARGE',
            'Use the paginated diary, weekly schedule and bookmark APIs to export more than 10,000 records per type',
          );
        return {
          exportedAt: new Date().toISOString(),
          profile: profile
            ? {
                heightCm: profile.height_cm === null ? null : Number(profile.height_cm),
                weightKg: profile.weight_kg === null ? null : Number(profile.weight_kg),
                goal: profile.goal,
                updatedAt: profile.updated_at,
              }
            : null,
          meals: meals.map(mealEntry),
          activities: activities.map(exerciseEntry),
          bookmarks: camel(bookmarks),
        };
      });
      reply.header('content-disposition', 'attachment; filename="bloom-wellness-export.json"');
      return data(bundle);
    },
  );
  route(
    'DELETE',
    '/api/v1/me/wellness',
    memberOptions(
      'Delete this account’s personal wellness records and bookmarks',
      deleteWellnessShape,
    ),
    async (req) => {
      parse(deleteWellnessShape, req.body);
      return db.transaction(async (tx) => {
        await lockOwner(tx, req.actor!.id);
        for (const table of [
          'meal_entries',
          'exercise_entries',
          'health_profiles',
          'article_bookmarks',
        ])
          await tx.query(`DELETE FROM ${table} WHERE user_id=$1`, [req.actor!.id]);
        await audit(tx, req.actor!, 'wellness.delete-personal-records', 'user', req.actor!.id);
        return data({ deleted: true });
      });
    },
  );
};
