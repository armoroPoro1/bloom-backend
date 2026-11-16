import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createTestApp, registerUser, adminUser } from './helpers.js';

const headers = (token: string) => ({ authorization: `Bearer ${token}` });
async function call(
  app: FastifyInstance,
  token: string,
  method: any,
  url: string,
  payload?: unknown,
) {
  const response = await app.inject({
    method,
    url,
    headers: headers(token),
    ...(payload === undefined ? {} : { payload: payload as any }),
  });
  return { status: response.statusCode, body: response.json() };
}
async function makeFood(
  app: FastifyInstance,
  token: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await call(app, token, 'POST', '/api/v1/admin/foods', {
    name: 'ข้าวและผัก',
    detail: '1 จาน',
    kcal: 250,
    group: 'อาหารหลัก',
    active: true,
    ...overrides,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}
const assertValidation = (status: number) =>
  assert.ok(status === 400 || status === 422, `Expected validation failure, received ${status}`);

test('wellness CMS requires admin and rejects invalid calendar dates and ownership fields', async () => {
  const h = await createTestApp();
  try {
    const user = await registerUser(h.app);
    const admin = await adminUser(h.app, h.db);
    const forbidden = await call(h.app, user.token, 'POST', '/api/v1/admin/foods', {
      name: 'test',
      detail: 'unit',
      kcal: 100,
    });
    assert.equal(forbidden.status, 403);
    const f = await makeFood(h.app, admin.token);
    assertValidation(
      (
        await call(h.app, user.token, 'POST', '/api/v1/me/meal-diary', {
          date: '2026-02-30',
          foodId: f.id,
          meal: 'breakfast',
          portions: 1,
        })
      ).status,
    );
    assertValidation(
      (
        await call(h.app, user.token, 'POST', '/api/v1/me/meal-diary', {
          date: '0000-01-01',
          foodId: f.id,
          meal: 'breakfast',
          portions: 1,
        })
      ).status,
    );
    assertValidation(
      (
        await call(h.app, user.token, 'POST', '/api/v1/me/meal-diary', {
          date: '2026-11-14',
          foodId: f.id,
          meal: 'breakfast',
          portions: 1,
          userId: admin.user.id,
        })
      ).status,
    );
    assertValidation(
      (await call(h.app, user.token, 'GET', '/api/v1/me/meal-diary?from=2026-11-15&to=2026-11-14'))
        .status,
    );
    assertValidation(
      (await call(h.app, user.token, 'GET', '/api/v1/me/exercise-schedule?weekStart=2026-11-14'))
        .status,
    );
    assert.equal(
      (await call(h.app, user.token, 'GET', '/api/v1/me/meal-diary?date=2026-11-14')).body.data
        .length,
      0,
    );
  } finally {
    await h.close();
  }
});

test('article publication, search, bookmarks and draft visibility stay consistent across accounts', async () => {
  const h = await createTestApp();
  try {
    const admin = await adminUser(h.app, h.db),
      a = await registerUser(h.app),
      b = await registerUser(h.app);
    const draft = await call(h.app, admin.token, 'POST', '/api/v1/admin/articles', {
      title: 'การดูแลตัวเอง',
      category: 'ทั่วไป',
      tag: 'routine',
    });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const id = draft.body.data.id;
    assert.equal((await h.app.inject({ url: `/api/v1/articles/${id}` })).statusCode, 404);
    assert.equal(
      (await call(h.app, a.token, 'PUT', `/api/v1/me/article-bookmarks/${id}`)).status,
      404,
    );
    const emptyPublish = await call(h.app, admin.token, 'PATCH', `/api/v1/admin/articles/${id}`, {
      published: true,
    });
    assert.equal(emptyPublish.status, 422);
    const published = await call(h.app, admin.token, 'PATCH', `/api/v1/admin/articles/${id}`, {
      published: true,
      paras: ['บันทึกกิจกรรมของตัวเองอย่างสม่ำเสมอ'],
    });
    assert.equal(published.status, 200);
    const renamed = await call(h.app, admin.token, 'PATCH', `/api/v1/admin/articles/${id}`, {
      title: 'การดูแลตัวเองที่แก้ชื่อ',
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data.published, true);
    assert.equal(renamed.body.data.category, 'ทั่วไป');
    assert.equal(renamed.body.data.tag, 'routine');
    assert.deepEqual(renamed.body.data.paras, ['บันทึกกิจกรรมของตัวเองอย่างสม่ำเสมอ']);
    const search = await h.app.inject({
      url:
        '/api/v1/articles?q=' +
        encodeURIComponent('กิจกรรม') +
        '&category=' +
        encodeURIComponent('ทั่วไป') +
        '&tag=routine',
    });
    assert.equal(search.statusCode, 200);
    assert.equal(search.json().data.length, 1);
    assert.equal(
      (await call(h.app, a.token, 'PUT', `/api/v1/me/article-bookmarks/${id}`)).status,
      200,
    );
    assert.equal(
      (await call(h.app, a.token, 'PUT', `/api/v1/me/article-bookmarks/${id}`)).status,
      200,
    );
    assert.equal(
      (await call(h.app, a.token, 'GET', '/api/v1/me/article-bookmarks')).body.data.length,
      1,
    );
    assert.equal(
      (await call(h.app, b.token, 'GET', '/api/v1/me/article-bookmarks')).body.data.length,
      0,
    );
    await call(h.app, admin.token, 'PATCH', `/api/v1/admin/articles/${id}`, { published: false });
    assert.equal(
      (await call(h.app, a.token, 'GET', '/api/v1/me/article-bookmarks')).body.data.length,
      0,
    );
    assert.equal((await h.app.inject({ url: `/api/v1/articles/${id}` })).statusCode, 404);
  } finally {
    await h.close();
  }
});

test('meal history retains food snapshots through catalogue edits/deletion and protects account ownership', async () => {
  const h = await createTestApp();
  try {
    const admin = await adminUser(h.app, h.db),
      a = await registerUser(h.app),
      b = await registerUser(h.app);
    const f = await makeFood(h.app, admin.token);
    const logged = await call(h.app, a.token, 'POST', '/api/v1/me/meal-diary', {
      date: '2026-11-14',
      foodId: f.id,
      meal: 'กลางวัน',
      portions: 1.5,
    });
    assert.equal(logged.status, 201, JSON.stringify(logged.body));
    const id = logged.body.data.id;
    assert.equal(logged.body.data.totalKcal, 375);
    await call(h.app, admin.token, 'PATCH', `/api/v1/admin/foods/${f.id}`, {
      name: 'ชื่อใหม่',
      detail: 'ถ้วยใหม่',
      kcal: 400,
    });
    const updated = await call(h.app, a.token, 'PATCH', `/api/v1/me/meal-diary/${id}`, {
      portions: 2,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.kcalPerPortion, 250);
    assert.equal(updated.body.data.foodName, 'ข้าวและผัก');
    assert.equal(updated.body.data.totalKcal, 500);
    assert.equal(
      (await call(h.app, b.token, 'PATCH', `/api/v1/me/meal-diary/${id}`, { portions: 3 })).status,
      404,
    );
    assert.equal((await call(h.app, b.token, 'DELETE', `/api/v1/me/meal-diary/${id}`)).status, 404);
    assert.equal(
      (await call(h.app, admin.token, 'DELETE', `/api/v1/admin/foods/${f.id}`)).status,
      200,
    );
    const history = await call(h.app, a.token, 'GET', '/api/v1/me/meal-diary?date=2026-11-14');
    assert.equal(history.body.data[0].foodId, null);
    assert.equal(history.body.data[0].foodName, 'ข้าวและผัก');
    assert.equal(history.body.totalsByDate[0].kcal, 500);
    assert.equal(
      (await call(h.app, b.token, 'GET', '/api/v1/me/meal-diary?date=2026-11-14')).body.data.length,
      0,
    );
  } finally {
    await h.close();
  }
});

test('meal template activation and copying validate live food references without rewriting old entries', async () => {
  const h = await createTestApp();
  try {
    const admin = await adminUser(h.app, h.db),
      user = await registerUser(h.app);
    const f = await makeFood(h.app, admin.token);
    const bad = await call(h.app, admin.token, 'POST', '/api/v1/admin/meal-templates', {
      name: 'bad',
      active: true,
      entries: [],
    });
    assert.equal(bad.status, 422);
    const result = await call(h.app, admin.token, 'POST', '/api/v1/admin/meal-templates', {
      name: 'มื้อประจำวัน',
      active: true,
      entries: [{ foodId: f.id, meal: 'กลางวัน', portions: 1 }],
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const id = result.body.data.id;
    assert.equal(
      (await call(h.app, admin.token, 'DELETE', `/api/v1/admin/foods/${f.id}`)).status,
      409,
    );
    const first = await call(h.app, user.token, 'POST', '/api/v1/me/meal-diary/apply-template', {
      templateId: id,
      date: '2026-11-14',
      mode: 'replace',
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data[0].totalKcal, 250);
    await call(h.app, admin.token, 'PATCH', `/api/v1/admin/foods/${f.id}`, {
      active: false,
      kcal: 400,
    });
    const renamedFood = await call(h.app, admin.token, 'PATCH', `/api/v1/admin/foods/${f.id}`, {
      name: 'ชื่ออาหารที่แก้ไขขณะปิดใช้งาน',
    });
    assert.equal(renamedFood.status, 200);
    assert.equal(renamedFood.body.data.active, false);
    assert.equal(renamedFood.body.data.group, 'อาหารหลัก');
    assert.equal((await h.app.inject({ url: '/api/v1/meal-templates' })).json().data.length, 0);
    const failedReplace = await call(
      h.app,
      user.token,
      'POST',
      '/api/v1/me/meal-diary/apply-template',
      { templateId: id, date: '2026-11-14', mode: 'replace' },
    );
    assert.equal(failedReplace.status, 409);
    assert.equal(
      (await call(h.app, user.token, 'GET', '/api/v1/me/meal-diary?date=2026-11-14')).body.data[0]
        .totalKcal,
      250,
    );
    const renamedTemplate = await call(
      h.app,
      admin.token,
      'PATCH',
      `/api/v1/admin/meal-templates/${id}`,
      {
        name: 'ชื่อที่แก้ไข',
      },
    );
    assert.equal(renamedTemplate.status, 200);
    assert.equal(renamedTemplate.body.data.active, true);
    assert.equal(renamedTemplate.body.data.entries.length, 1);
    assert.equal(renamedTemplate.body.data.available, false);
    assert.equal(
      (
        await call(h.app, admin.token, 'PATCH', `/api/v1/admin/meal-templates/${id}`, {
          entries: [{ foodId: f.id, meal: 'เย็น', portions: 2 }],
        })
      ).status,
      422,
    );
    await call(h.app, admin.token, 'PATCH', `/api/v1/admin/foods/${f.id}`, { active: true });
    const again = await call(h.app, user.token, 'POST', '/api/v1/me/meal-diary/apply-template', {
      templateId: id,
      date: '2026-11-15',
      mode: 'append',
    });
    assert.equal(again.status, 201);
    assert.equal(again.body.data[0].totalKcal, 400);
    await call(h.app, admin.token, 'DELETE', `/api/v1/admin/meal-templates/${id}`);
    const previous = await call(
      h.app,
      user.token,
      'GET',
      '/api/v1/me/meal-diary?from=2026-11-14&to=2026-11-15',
    );
    assert.equal(previous.body.data.length, 2);
    assert.deepEqual(
      previous.body.data.map((e: any) => e.totalKcal),
      [250, 400],
    );
    assert.equal(previous.body.data[0].templateId, null);
  } finally {
    await h.close();
  }
});

test('exercise templates create independent per-account week snapshots and completion records', async () => {
  const h = await createTestApp();
  try {
    const admin = await adminUser(h.app, h.db),
      a = await registerUser(h.app),
      b = await registerUser(h.app);
    const days = Array.from({ length: 7 }, (_, i) =>
      i === 0 ? [{ name: 'เดิน', minutes: 30, type: 'เดิน' }] : [],
    );
    const template = await call(h.app, admin.token, 'POST', '/api/v1/admin/exercise-templates', {
      name: 'สัปดาห์ตัวอย่าง',
      active: true,
      days,
    });
    assert.equal(template.status, 201, JSON.stringify(template.body));
    const tid = template.body.data.id;
    const applied = await call(
      h.app,
      a.token,
      'POST',
      '/api/v1/me/exercise-schedule/apply-template',
      { templateId: tid, weekStart: '2026-11-16' },
    );
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    const activityId = applied.body.data[0].id;
    const nextDays = Array.from({ length: 7 }, (_, i) =>
      i === 0 ? [{ name: 'ชื่อใหม่', minutes: 90, type: 'อื่น' }] : [],
    );
    const changedTemplate = await call(
      h.app,
      admin.token,
      'PATCH',
      `/api/v1/admin/exercise-templates/${tid}`,
      {
        days: nextDays,
      },
    );
    assert.equal(changedTemplate.status, 200);
    assert.equal(changedTemplate.body.data.active, true);
    assert.equal(
      (
        await call(h.app, b.token, 'PATCH', `/api/v1/me/exercise-schedule/${activityId}`, {
          completed: true,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call(h.app, a.token, 'PATCH', `/api/v1/me/exercise-schedule/${activityId}`, {
          completed: true,
        })
      ).status,
      200,
    );
    const schedule = await call(
      h.app,
      a.token,
      'GET',
      '/api/v1/me/exercise-schedule?weekStart=2026-11-16',
    );
    assert.equal(schedule.body.data.days.length, 7);
    assert.equal(schedule.body.data.days[0].activities[0].name, 'เดิน');
    assert.equal(schedule.body.data.days[0].activities[0].minutes, 30);
    assert.equal(schedule.body.data.days[0].activities[0].type, 'เดิน');
    assert.equal(schedule.body.data.days[0].activities[0].completed, true);
    const editedActivity = await call(
      h.app,
      a.token,
      'PATCH',
      `/api/v1/me/exercise-schedule/${activityId}`,
      {
        name: 'เดินที่ปรับเอง',
      },
    );
    assert.equal(editedActivity.status, 200);
    assert.equal(editedActivity.body.data.completed, true);
    assert.equal(editedActivity.body.data.type, 'เดิน');
    assert.equal(
      (await call(h.app, b.token, 'GET', '/api/v1/me/exercise-schedule?weekStart=2026-11-16')).body
        .data.days[0].activities.length,
      0,
    );
    assert.equal(
      (await call(h.app, a.token, 'GET', '/api/v1/me/exercise-schedule?weekStart=2026-11-23')).body
        .data.days[0].activities.length,
      0,
    );
    await call(h.app, admin.token, 'DELETE', `/api/v1/admin/exercise-templates/${tid}`);
    assert.equal(
      (await call(h.app, a.token, 'GET', '/api/v1/me/exercise-schedule?weekStart=2026-11-16')).body
        .data.days[0].activities[0].templateId,
      null,
    );
  } finally {
    await h.close();
  }
});

test('exercise content rejects duplicate activity IDs, missing days and empty active plans', async () => {
  const h = await createTestApp();
  try {
    const admin = await adminUser(h.app, h.db),
      id = randomUUID();
    const empty = Array.from({ length: 7 }, () => []);
    assert.equal(
      (
        await call(h.app, admin.token, 'POST', '/api/v1/admin/exercise-templates', {
          name: 'empty',
          active: true,
          days: empty,
        })
      ).status,
      422,
    );
    assertValidation(
      (
        await call(h.app, admin.token, 'POST', '/api/v1/admin/exercise-templates', {
          name: 'bad',
          days: [[]],
        })
      ).status,
    );
    const duplicate = Array.from({ length: 7 }, (_, i) =>
      i < 2 ? [{ id, name: 'walk', minutes: 30 }] : [],
    );
    assert.equal(
      (
        await call(h.app, admin.token, 'POST', '/api/v1/admin/exercise-templates', {
          name: 'duplicate',
          active: true,
          days: duplicate,
        })
      ).status,
      422,
    );
  } finally {
    await h.close();
  }
});

test('personal health export and deletion stay private and do not delete public content or another account', async () => {
  const h = await createTestApp();
  try {
    const admin = await adminUser(h.app, h.db),
      a = await registerUser(h.app),
      b = await registerUser(h.app);
    const initial = await call(h.app, a.token, 'GET', '/api/v1/me/health-profile');
    assert.deepEqual(initial.body.data, { heightCm: null, weightKg: null, goal: '' });
    assertValidation(
      (await call(h.app, a.token, 'PUT', '/api/v1/me/health-profile', { heightCm: -1 })).status,
    );
    assertValidation(
      (
        await call(h.app, a.token, 'PUT', '/api/v1/me/health-profile', {
          heightCm: 170,
          userId: b.user.id,
        })
      ).status,
    );
    await call(h.app, a.token, 'PUT', '/api/v1/me/health-profile', {
      heightCm: 170,
      weightKg: 60,
      goal: 'บันทึกกิจกรรมส่วนตัว',
    });
    await call(h.app, b.token, 'PUT', '/api/v1/me/health-profile', {
      heightCm: 180,
      goal: 'อีกบัญชี',
    });
    const f = await makeFood(h.app, admin.token);
    await call(h.app, a.token, 'POST', '/api/v1/me/meal-diary', {
      date: '2026-11-14',
      foodId: f.id,
      meal: 'กลางวัน',
      portions: 1,
    });
    const exported = await call(h.app, a.token, 'GET', '/api/v1/me/wellness/export');
    assert.equal(exported.body.data.profile.heightCm, 170);
    assert.equal(exported.body.data.meals.length, 1);
    assert.equal(exported.body.data.profile.goal, 'บันทึกกิจกรรมส่วนตัว');
    assertValidation(
      (await call(h.app, a.token, 'DELETE', '/api/v1/me/wellness', { confirm: false })).status,
    );
    assert.equal(
      (await call(h.app, a.token, 'DELETE', '/api/v1/me/wellness', { confirm: true })).status,
      200,
    );
    assert.equal(
      (await call(h.app, a.token, 'GET', '/api/v1/me/wellness/export')).body.data.meals.length,
      0,
    );
    assert.equal(
      (await call(h.app, a.token, 'GET', '/api/v1/me/health-profile')).body.data.heightCm,
      null,
    );
    assert.equal(
      (await call(h.app, b.token, 'GET', '/api/v1/me/health-profile')).body.data.heightCm,
      180,
    );
    assert.equal((await h.app.inject({ url: '/api/v1/foods' })).json().data.length, 1);
  } finally {
    await h.close();
  }
});

test('article search and saved filters match all literal words across metadata without leaking drafts or other bookmarks', async () => {
  const h = await createTestApp();
  try {
    const admin = await adminUser(h.app, h.db);
    const a = await registerUser(h.app);
    const b = await registerUser(h.app);
    const create = async (input: Record<string, unknown>) => {
      const r = await call(h.app, admin.token, 'POST', '/api/v1/admin/articles', {
        title: 'Article',
        paras: ['A body paragraph'],
        published: true,
        ...input,
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.data;
    };
    const morning = await create({
      title: 'Morning notes',
      category: 'อาหาร',
      tag: 'routine',
      paras: ['A daily journal'],
    });
    const literal = await create({
      title: 'Save 10%_today',
      category: 'ไลฟ์สไตล์',
      tag: 'special',
      paras: ['Literal search example'],
    });
    const other = await create({
      title: 'Evening walk',
      category: 'ไลฟ์สไตล์',
      tag: 'movement',
      paras: ['Another journal'],
    });
    await create({
      title: 'Secret unpublished draft',
      category: 'draft-category',
      tag: 'draft-tag',
      published: false,
    });
    await call(h.app, a.token, 'PUT', `/api/v1/me/article-bookmarks/${morning.id}`);
    await call(h.app, a.token, 'PUT', `/api/v1/me/article-bookmarks/${literal.id}`);
    await call(h.app, b.token, 'PUT', `/api/v1/me/article-bookmarks/${other.id}`);
    const search = async (path: string, query: Record<string, string>, token?: string) => {
      const response = await h.app.inject({
        url: path + '?' + new URLSearchParams(query).toString(),
        ...(token ? { headers: headers(token) } : {}),
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const combined = await search('/api/v1/articles', { q: 'Morning routine อาหาร' });
    assert.deepEqual(
      combined.data.map((r: any) => r.id),
      [morning.id],
    );
    const wildcard = await search('/api/v1/articles', { q: '%_' });
    assert.deepEqual(
      wildcard.data.map((r: any) => r.id),
      [literal.id],
    );
    const saved = await search(
      '/api/v1/me/article-bookmarks',
      { q: 'Morning routine', category: 'อาหาร', tag: 'routine', limit: '1' },
      a.token,
    );
    assert.equal(saved.page.total, 1);
    assert.deepEqual(
      saved.data.map((r: any) => r.id),
      [morning.id],
    );
    assert.equal(
      (await search('/api/v1/me/article-bookmarks', { q: 'movement' }, a.token)).page.total,
      0,
    );
    assert.equal(
      (await search('/api/v1/me/article-bookmarks', { q: 'Morning' }, b.token)).page.total,
      0,
    );
    const facets = await h.app.inject({ url: '/api/v1/articles/filters' });
    assert.equal(facets.statusCode, 200, facets.body);
    assert.deepEqual(
      new Set(facets.json().data.categories.map((r: any) => r.value)),
      new Set(['อาหาร', 'ไลฟ์สไตล์']),
    );
    assert.equal(facets.json().data.categories.find((r: any) => r.value === 'ไลฟ์สไตล์').count, 2);
    assert.deepEqual(
      new Set(facets.json().data.tags.map((r: any) => r.value)),
      new Set(['routine', 'special', 'movement']),
    );
    await call(h.app, admin.token, 'PATCH', `/api/v1/admin/articles/${morning.id}`, {
      published: false,
    });
    assert.equal(
      (await search('/api/v1/me/article-bookmarks', { q: 'routine' }, a.token)).page.total,
      0,
    );
    const refreshed = await h.app.inject({ url: '/api/v1/articles/filters' });
    assert.equal(
      refreshed.json().data.categories.some((r: any) => r.value === 'อาหาร'),
      false,
    );
  } finally {
    await h.close();
  }
});

test('food group discovery covers all active records beyond one page and hides inactive-only groups', async () => {
  const h = await createTestApp();
  try {
    const admin = await adminUser(h.app, h.db);
    await makeFood(h.app, admin.token, { name: 'First food', group: 'อาหารหลัก' });
    const snack = await makeFood(h.app, admin.token, { name: 'Second food', group: 'ของว่าง' });
    await makeFood(h.app, admin.token, {
      name: 'Hidden food',
      group: 'inactive-only',
      active: false,
    });
    const page = await h.app.inject({ url: '/api/v1/foods?limit=1' });
    assert.equal(page.json().data.length, 1);
    const groups = await h.app.inject({ url: '/api/v1/foods/groups' });
    assert.equal(groups.statusCode, 200, groups.body);
    assert.deepEqual(
      new Set(groups.json().data.map((r: any) => r.value)),
      new Set(['อาหารหลัก', 'ของว่าง']),
    );
    assert.equal(
      groups.json().data.every((r: any) => r.count === 1),
      true,
    );
    await call(h.app, admin.token, 'PATCH', `/api/v1/admin/foods/${snack.id}`, { active: false });
    const after = await h.app.inject({ url: '/api/v1/foods/groups' });
    assert.deepEqual(after.json().data, [{ value: 'อาหารหลัก', count: 1 }]);
  } finally {
    await h.close();
  }
});

test('fractional meal calories use the same decimal rounding in entries, daily totals and exports', async () => {
  const h = await createTestApp();
  try {
    const admin = await adminUser(h.app, h.db);
    const user = await registerUser(h.app);
    const f = await makeFood(h.app, admin.token, { kcal: 0.05 });
    const g = await makeFood(h.app, admin.token, { name: 'Fractional record', kcal: 0.57 });
    for (let i = 0; i < 2; i++) {
      const logged = await call(h.app, user.token, 'POST', '/api/v1/me/meal-diary', {
        date: '2026-11-14',
        foodId: f.id,
        meal: 'ตัวอย่าง',
        portions: 0.1,
      });
      assert.equal(logged.status, 201);
      assert.equal(logged.body.data.totalKcal, 0.01);
    }
    const half = await call(h.app, user.token, 'POST', '/api/v1/me/meal-diary', {
      date: '2026-11-14',
      foodId: g.id,
      meal: 'ตัวอย่าง',
      portions: 0.5,
    });
    assert.equal(half.status, 201);
    assert.equal(half.body.data.totalKcal, 0.29);
    const day = await call(
      h.app,
      user.token,
      'GET',
      '/api/v1/me/meal-diary?date=2026-11-14&limit=1',
    );
    assert.equal(day.body.data.length, 1);
    assert.equal(day.body.page.total, 3);
    assert.equal(day.body.totalsByDate[0].kcal, 0.31);
    const exported = await call(h.app, user.token, 'GET', '/api/v1/me/wellness/export');
    assert.deepEqual(
      exported.body.data.meals.map((m: any) => m.totalKcal).sort((a: number, b: number) => a - b),
      [0.01, 0.01, 0.29],
    );
  } finally {
    await h.close();
  }
});
