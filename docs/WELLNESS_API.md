# Wellness and content API

This module implements the article, food/calorie, meal-plan, exercise-plan and personal-record flows from the HealthShop Context Diagram. It does not generate health advice, calorie prescriptions, BMI, face analysis or AI recommendations. Values and schedules are supplied by admins or by the account owner.

All paths below start with `/api/v1`. Public endpoints need no token. Admin endpoints require a server-authenticated `admin` account; `/me` endpoints operate only on the authenticated account. A user ID in a request body is rejected rather than used to choose a target account.

Success responses use `{ "data": ... }`. Paginated lists also include `page: { limit, offset, total }`. Errors use the common API error envelope. Bodies reject unknown fields. Amounts in this module are calories, portions, centimetres, kilograms and minutes; they are not monetary cents.

## Public content — ten endpoints

| Method | Path                      | Parameters / behavior                                                                                                                            |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/articles`               | `q`, `category`, `tag`, `limit`, `offset`; each query word matches across title, subtitle, category, tag and paragraphs; only published articles |
| GET    | `/articles/:id`           | Published article, otherwise a generic 404                                                                                                       |
| GET    | `/articles/filters`       | All nonblank published categories and tags, with counts; independent of the first article page                                                   |
| GET    | `/foods`                  | `q`, `group`, `limit`, `offset`; only active foods                                                                                               |
| GET    | `/foods/:id`              | Active food, otherwise 404                                                                                                                       |
| GET    | `/foods/groups`           | All nonblank groups with active food records and counts; excludes inactive-only groups                                                           |
| GET    | `/meal-templates`         | `limit`, `offset`; only active, nonempty templates whose referenced foods remain active                                                          |
| GET    | `/meal-templates/:id`     | Available meal template, otherwise 404                                                                                                           |
| GET    | `/exercise-templates`     | `limit`, `offset`; active seven-day templates                                                                                                    |
| GET    | `/exercise-templates/:id` | Active exercise template, otherwise 404                                                                                                          |

List limits default to 20 and accept 1–100. Offset accepts 0–100,000. The four content collections have matching list/detail endpoints under `/admin`, including inactive/draft records. Filter-discovery endpoints are public and expose published/active values only; there are no additional admin filter-discovery routes.

Article search treats each whitespace-separated word as a literal, case-insensitive substring and requires all words to match. Words may match different fields. For example, a title containing `Morning` and a tag `routine` match `q=Morning routine`. Percent signs, underscores and backslashes are literal characters, not caller-supplied SQL wildcards. Food search also treats those characters literally.

`GET /articles/filters` returns:

```json
{
  "data": {
    "categories": [{ "value": "ไลฟ์สไตล์", "count": 2 }],
    "tags": [{ "value": "routine", "count": 1 }]
  }
}
```

`GET /foods/groups` returns `{ "data": [{ "value": "อาหารหลัก", "count": 2 }] }`. These counts cover all visible content, not the currently selected page or search query. Both routes accept no query parameters. Empty category/tag/group labels are omitted. Draft-only categories/tags and inactive-only groups are never included.

## Admin content — twenty endpoints

For each collection below, the API implements `GET /admin/{collection}`, `GET /admin/{collection}/:id`, `POST /admin/{collection}`, `PATCH /admin/{collection}/:id` and `DELETE /admin/{collection}/:id`.

| Collection           | Principal fields                                                                | Rules                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `articles`           | `title`, `subtitle`, `category`, `tag`, `time`, `paras`, `imageId`, `published` | Publishing requires at least one nonblank paragraph. Deletion also removes bookmarks.                       |
| `foods`              | `name`, `detail`, `kcal`, `group`, `active`                                     | Calories 0–10,000. A food referenced by a meal template cannot be deleted. Deactivation is supported.       |
| `meal-templates`     | `name`, `description`, `active`, `entries`                                      | Entries contain `foodId`, `meal`, `portions`. Activation requires entries and active referenced foods.      |
| `exercise-templates` | `name`, `description`, `active`, `days`                                         | Exactly seven day arrays. Active templates require an activity. Activity IDs cannot repeat across the week. |

PATCH preserves omitted fields. A partial update does not implicitly reset optional/default-valued fields. The body parser and Fastify validator retain this behavior with AJV defaults disabled.

### Article example

```json
{
  "title": "การบันทึกกิจกรรมประจำวัน",
  "subtitle": "เริ่มจากสิ่งเล็ก ๆ ที่ทำได้",
  "category": "ทั่วไป",
  "tag": "routine",
  "time": "3 นาที",
  "paras": ["ข้อความบทความย่อหน้าแรก", "ข้อความย่อหน้าถัดไป"],
  "imageId": null,
  "published": true
}
```

Upload an image first with `POST /uploads?kind=article` and multipart field `file`. `imageId` must reference an article upload owned by the current admin. The article response exposes `imageUrl: /api/v1/uploads/{id}`. An image attached to a published article is publicly readable through the upload endpoint; unpublished content does not make its image public.

### Food and meal-template examples

```json
{
  "name": "ข้าวและผัก",
  "detail": "1 จาน",
  "kcal": 250,
  "group": "อาหารหลัก",
  "active": true
}
```

Use the returned food UUID in the template:

```json
{
  "name": "ชุดมื้ออาหารตัวอย่าง",
  "description": "ข้อมูลตัวอย่างที่ผู้ดูแลกรอก",
  "active": true,
  "entries": [{ "foodId": "REPLACE_WITH_FOOD_UUID", "meal": "กลางวัน", "portions": 1.5 }]
}
```

Portions accept 0.01–10 with at most two decimal places. Meal templates accept up to 50 entries. Deactivating a referenced food preserves the template but makes it unavailable for new copies. Admins may still edit its name/description or deactivate it; changing entries while active or reactivating it requires active foods. The admin response includes `available` to distinguish the stored active flag from usable content.

### Seven-day exercise-template example

```json
{
  "name": "สัปดาห์ตัวอย่าง",
  "description": "ตารางที่ผู้ดูแลกรอก",
  "active": true,
  "days": [[{ "name": "เดิน", "minutes": 30, "type": "กิจกรรมทั่วไป" }], [], [], [], [], [], []]
}
```

The first day is Monday. Each day accepts at most 30 activities. An activity may supply a unique UUID `id`; otherwise the server creates one. Minutes are whole numbers from 0 through 600. Copies receive independent personal activity IDs.

## Personal records — twenty endpoints

### Bookmarks

| Method | Path                               | Behavior                                                                                                   |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/me/article-bookmarks`            | Paginated published bookmarks belonging to this account; accepts `q`, `category`, `tag`, `limit`, `offset` |
| PUT    | `/me/article-bookmarks/:articleId` | Idempotently bookmark a published article                                                                  |
| DELETE | `/me/article-bookmarks/:articleId` | Idempotently remove the account’s bookmark                                                                 |

Bookmarks of subsequently unpublished articles are hidden from the member list. A draft article is not revealed through the bookmark API.

Saved-article search uses the same literal multiword matching as public search, combined with this account's bookmarks and the selected category/tag. `page.total` counts only that filtered, visible subset. Query parameters cannot change the owner or make drafts visible.

### Meal diary

| Method | Path                            | Behavior                                                             |
| ------ | ------------------------------- | -------------------------------------------------------------------- |
| GET    | `/me/meal-diary`                | `date=YYYY-MM-DD` or `from` and `to`, plus pagination                |
| GET    | `/me/meal-diary/:id`            | Read an owned diary snapshot                                         |
| POST   | `/me/meal-diary`                | Add an active food as a historical snapshot                          |
| PATCH  | `/me/meal-diary/:id`            | Edit `date`, `meal` and/or `portions`; retain the captured food data |
| DELETE | `/me/meal-diary/:id`            | Delete an owned entry                                                |
| POST   | `/me/meal-diary/apply-template` | Copy template entries into one date with `append` or `replace`       |

Create an entry:

```json
{
  "date": "2026-11-14",
  "foodId": "REPLACE_WITH_FOOD_UUID",
  "meal": "กลางวัน",
  "portions": 1.5
}
```

Copy a template:

```json
{
  "templateId": "REPLACE_WITH_MEAL_TEMPLATE_UUID",
  "date": "2026-11-14",
  "mode": "replace"
}
```

Diary entries capture the food name, serving label and calories per serving at creation. Later catalogue edits do not rewrite those fields. A portion edit recomputes displayed `totalKcal` from the captured value. Deleting an unreferenced catalogue food clears the source `foodId` in diary rows while retaining the snapshots.

`totalKcal` rounds each entry to two decimal places using decimal half-up rounding. `totalsByDate` sums those rounded entry amounts across the entire filtered date range, independently of list pagination, so daily totals agree with the amounts displayed for the entries. For example, a recorded 0.57 kcal per portion at 0.5 portions produces 0.29 kcal; two 0.005-kcal calculations each display 0.01 and contribute 0.02 together. Exports use the same calculation. This is consistent record arithmetic, not a claim about the precision of nutrition measurements.

A day supports at most 200 diary entries. Applying a template validates all food references before replacing the existing day; validation failure leaves the previous day unchanged. Template deletion preserves copied diary entries.

### Exercise schedule

| Method | Path                                   | Behavior                                                                         |
| ------ | -------------------------------------- | -------------------------------------------------------------------------------- |
| GET    | `/me/exercise-schedule`                | `weekStart=YYYY-MM-DD`, returns seven dates with activity arrays                 |
| GET    | `/me/exercise-schedule/:id`            | Read an owned activity                                                           |
| POST   | `/me/exercise-schedule`                | Create an activity using `date`, `name`, `minutes`, `type`, optional `completed` |
| PATCH  | `/me/exercise-schedule/:id`            | Change the owned activity or mark `completed`                                    |
| DELETE | `/me/exercise-schedule/:id`            | Delete an owned activity                                                         |
| POST   | `/me/exercise-schedule/apply-template` | Copy a template into `weekStart` using `append` or `replace`                     |

```json
{
  "templateId": "REPLACE_WITH_EXERCISE_TEMPLATE_UUID",
  "weekStart": "2026-11-16",
  "mode": "replace"
}
```

`weekStart` must be a Monday. If omitted on GET, it defaults to the current Monday in the Bangkok calendar. Each copied activity captures its own name/minutes/type and starts incomplete. Source-template edits or deletion do not overwrite copied schedules. A day supports at most 100 personal activities.

### Health profile and personal data

| Method | Path                  | Behavior                                                                        |
| ------ | --------------------- | ------------------------------------------------------------------------------- |
| GET    | `/me/health-profile`  | Optional height, weight and self-written goal; blank defaults for a new account |
| PUT    | `/me/health-profile`  | Replace the profile; omitted numeric fields become `null`                       |
| DELETE | `/me/health-profile`  | Remove only this account’s profile                                              |
| GET    | `/me/wellness/export` | Download the account’s profile, diary, schedule and bookmarks as JSON           |
| DELETE | `/me/wellness`        | Delete those personal wellness records; body must be `{ "confirm": true }`      |

```json
{
  "heightCm": 170,
  "weightKg": 60,
  "goal": "บันทึกกิจกรรมของตัวเอง"
}
```

Height and weight may be `null`. Present values must be positive and no more than 300 cm / 1,000 kg respectively. The goal is at most 2,000 characters. These are input bounds, not health recommendations; no derived medical or nutrition score is generated.

Full export accepts up to 10,000 rows of each record type. If a type exceeds that bound, the endpoint returns `413 EXPORT_TOO_LARGE` rather than silently truncating. Use the paginated diary, weekly schedule and bookmark APIs for larger exports. Personal deletion does not delete public CMS content, commerce records or another account’s data.

## Dates, transactions and access boundaries

- Dates must be real `YYYY-MM-DD` calendar dates with a nonzero four-digit year. Impossible dates are rejected before SQL execution.
- Diary ranges are inclusive, chronological and at most 366 days apart. `date` cannot be combined with `from`/`to`.
- Omitted diary dates default to the current Bangkok calendar date. Stored timestamps are separate UTC instants.
- Personal mutations serialize on the owner row. Template application and replacements run within a transaction and lock the source template/food rows.
- A guessed diary/activity UUID from another account returns the same generic 404 as a missing record. Admin roles do not expose another account’s health profile through these routes.
- Admin content mutations produce audit events. Personal export/profile records are not copied into audit details.
- The migration uses relational template-food references and snapshot fields. This package includes no frontend integration or automatic import of previous browser-local wellness records.

## Verification

`tests/wellness.test.ts` exercises administrator permissions, strict dates/unknown fields, article drafts/search/bookmarks, snapshot preservation after food edits/deletion, template availability and transactional replacement, per-week/account exercise isolation, activity completion, health-profile privacy and account-only export/deletion. Additional regression scenarios cover multiword metadata search, literal wildcard characters, owner-scoped saved-article filters, visible filter discovery beyond the first page, and identical fractional-calorie rounding in entries/daily totals/exports.
