# Catalog, seller and member API guide

All paths below are relative to `/api/v1`. This backend is independent of the React application; frontend integration is intentionally left to the next task.

Authenticated requests use `Authorization: Bearer ACCESS_TOKEN`. Get the token from registration/login and rotate it through `/auth/refresh`. A user's role is read from the server for every authenticated request. Ordinary registration cannot request seller/admin privileges.

## Response and money conventions

A single result is returned as `{ "data": ... }`. Paged results return `{ "data": [...], "page": { "limit": 20, "offset": 0, "total": 123 } }`. Errors use `{ "error": { "code": "...", "message": "..." }, "requestId": "..." }` and an appropriate HTTP status.

All price and shipping fields ending in `Cents` are integer **satang**: `9950` means **99.50 baht**. Do not send decimal baht in these fields. IDs are UUID strings returned by the API; replace the placeholders in the examples with actual IDs.

## Seller application and approval

An authenticated customer applies with `POST /me/shop`:

```json
{
  "name": "Rose & Ritual",
  "email": "shop@example.com",
  "description": "Products for everyday health and wellness.",
  "shippingFeeCents": 4000,
  "freeShippingAtCents": 99900
}
```

The result has status `pending`. `GET /me/shop` returns the existing application or shop. Only one shop is permitted per account. `PATCH /me/shop` accepts any nonempty subset of the same fields and does not change approval status.

An admin inspects applications through `GET /admin/shops?status=pending&limit=20&offset=0`, then calls `POST /admin/shops/SHOP_ID/decision`:

```json
{ "decision": "approve" }
```

Approval changes an ordinary account to the seller role. Its customer functions remain available. To reject an application:

```json
{ "decision": "reject", "reason": "Please complete the store description." }
```

A rejected owner can edit the application and call `POST /me/shop/resubmit` without a body. The application returns to `pending`; resubmission does not self-approve it.

Admins suspend/reopen established shops with `PATCH /admin/shops/SHOP_ID/status`:

```json
{ "status": "suspended", "reason": "Administrative review is required." }
```

```json
{ "status": "approved" }
```

This endpoint accepts established `approved`/`suspended` shops. Pending/rejected applications must use the decision workflow. A blocked owner's shop cannot be approved or reopened. Suspended shops remain available to their owner for management and existing-order fulfilment, but their products are excluded from sale and new product creation is blocked.

## Product images

An approved seller or admin uploads a product image first:

```sh
curl -X POST 'http://localhost:4000/api/v1/uploads?kind=product' \
  -H 'Authorization: Bearer ACCESS_TOKEN' \
  -F 'file=@product.png'
```

Use the returned `data.id` as `imageId`. An image must have kind `product` and belong to the account attaching it; the API does not accept another user's image ID or a private payment-proof ID. Existing images can remain unchanged during edits. The upload service validates/normalizes the image and controls its read permissions. See the Files endpoints in OpenAPI for the full upload policy.

## Product creation and editing

An approved seller calls `POST /seller/products`:

```json
{
  "name": "Everyday wellness bottle",
  "englishName": "Wellness bottle",
  "description": "A reusable bottle for everyday routines.",
  "categoryId": "CATEGORY_ID",
  "priceCents": 9950,
  "originalPriceCents": 12900,
  "imageId": "UPLOAD_ID",
  "imageIndex": null,
  "badge": "New",
  "stock": 25,
  "active": true
}
```

`originalPriceCents` may be `0` when no comparison price applies; otherwise it cannot be below the sale price. `imageId` may be null. `imageIndex` is an optional seed-atlas index from 0 through 5; clients rendering the original demo atlas can use it as a fallback.

Seller ownership comes from the authenticated account. A seller must not send `shopId`. Admins use `POST /admin/products` with the same fields plus an explicit `shopId`. Creation requires an approved shop with an unblocked owner and an available category for an active listing.

Use `PATCH /seller/products/PRODUCT_ID` or its admin equivalent to update a nonempty subset of product fields:

```json
{ "priceCents": 10900, "originalPriceCents": 12900, "stock": 30 }
```

A product's shop ownership cannot be changed through this endpoint. Absolute stock changes create a stock movement. Archived listings must be restored before editing. For suspended shops, setting `active` to false remains possible; publishing remains blocked.

### Archive and restore

- `DELETE /seller/products/PRODUCT_ID` archives the listing and sets it inactive. It retains product and order history.
- `POST /seller/products/PRODUCT_ID/restore` restores the listing **as inactive**.
- `PATCH /seller/products/PRODUCT_ID` with `{ "active": true }` explicitly republishes it after eligibility checks.

The equivalent admin endpoints are under `/admin/products`. Seller routes expose only the signed-in account's own store, including when an administrator uses those seller routes; administrators use `/admin/...` for all-store management.

## Stock adjustments and history

For a delta adjustment, call `POST /seller/products/PRODUCT_ID/stock`:

```json
{ "change": -2, "reason": "Two units damaged during handling." }
```

Positive values replenish stock. Zero adjustments and negative resulting balances are rejected. Manual increases cannot raise stock above one million. Cancellation can restore previously reserved units after replenishment and temporarily bring the stored balance above that input cap; negative adjustments can reduce such a balance in small steps without requiring an immediate reduction below the cap. The product row is locked, and stock, movement and audit records commit together. A failed adjustment does not create a movement.

Read history with:

```text
GET /seller/stock-movements?productId=PRODUCT_ID&from=2026-11-01&to=2026-11-30&limit=100&offset=0
GET /seller/stock-movements/export?productId=PRODUCT_ID&limit=100&offset=0
```

Admin equivalents use `/admin/stock-movements` and optionally filter by `shopId`. Date filters are inclusive Bangkok calendar dates. The export returns a CSV attachment for the requested page. Numeric negative adjustments remain numbers; text that could be interpreted as spreadsheet formulas is neutralized.

## Public catalog

```text
GET /categories
GET /products?q=bottle&categoryId=CATEGORY_ID&shopId=SHOP_ID&minPriceCents=5000&maxPriceCents=20000&sort=price_asc&limit=20&offset=0
GET /products/PRODUCT_ID
GET /shops?q=Rose&limit=20&offset=0
GET /shops/SHOP_ID
```

Sort choices are `newest`, `price_asc`, `price_desc`, `rating`, and `bestselling`. Public product results require an active, unarchived listing, an active category, an approved shop and an unblocked shop owner. Out-of-stock products can still be browsed; checkout independently validates stock. Public rating/count values exclude moderated reviews.

The `q` parameter is case-insensitive literal text, not a SQL search pattern. Percent signs, underscores and backslashes match those actual characters. This behavior applies consistently to public and management product/shop searches and admin member search/export.

Product results include `shopName`, `categoryName`, `rating`, `reviewCount`, `soldCount`, and `imageUrl` in addition to product fields. `imageUrl` is relative to the API origin. Resolve it against the backend base URL when the frontend runs on another origin.

Management searches use `/seller/products` or `/admin/products`. They additionally accept `active=true|false` and `archived=true|false` to inspect nonpublic records. Omitting these filters includes both states. Public search deliberately rejects management-only filters.

## Categories

Admins use `GET /admin/categories` and `POST /admin/categories`:

```json
{
  "name": "Wellness essentials",
  "icon": "leaf",
  "description": "Everyday essentials",
  "active": true
}
```

`PATCH /admin/categories/CATEGORY_ID` accepts a nonempty subset of those fields. `DELETE` succeeds only when no product references the category, including archived products. Hide a referenced category with `{ "active": false }` to remove its products from the public catalog without destroying their history. Category names are unique without case distinction.

## Member administration

```text
GET /admin/users?q=example&role=seller&blocked=false&limit=20&offset=0
GET /admin/users/USER_ID
GET /admin/users/export?role=seller&limit=100&offset=0
```

These endpoints return profile and management information, never password hashes or session tokens. Member detail adds order count and paid purchase totals. CSV export uses the same filters and requested page as the member list.

To block an account, call `PATCH /admin/users/USER_ID/status`:

```json
{ "blocked": true, "reason": "Account access is under review." }
```

Blocking revokes all sessions and suspends the account's approved shop. Self-blocking and operations that remove the last active administrator are refused. Account reactivation uses the same endpoint with `blocked: false` and a reason. It does not restore old sessions or automatically reopen a suspended shop; shop reactivation remains an explicit admin action.

## Site settings, audit and usage

- `GET /settings` returns public site settings.
- `GET /admin/settings` returns the editable settings.
- `PATCH /admin/settings` accepts only `siteTitle`, `siteNotice`, and `contactEmail`. Send `contactEmail: ""` to clear a previously configured public contact address; nonempty values must remain valid email addresses.
- `GET /admin/audit-events` accepts `action`, `entity`, `shopId`, `from`, `to`, `limit`, and `offset`.
- `POST /visits` with `{ "page": "shop" }` records an anonymous page-view event.
- `GET /admin/usage?from=2026-11-01&to=2026-11-30` groups recorded views by page and Bangkok date. With no dates it returns the recent 30-day window. This is a count of submitted page views, not verified unique visitors. A response contains at most 5,000 day/page groups. A larger result returns `422 USAGE_REPORT_TOO_LARGE` with `maxGroups: 5000`; narrow the date range rather than treating a silently truncated result as complete. Returned `day` values use `YYYY-MM-DD` strings.

## Pagination and errors

Catalog/member/stock/audit lists default to `limit=20`, `offset=0`. Maximum limit is 100; maximum offset is 100000. Pass query booleans as `true` or `false`. Supported filters are validated and unknown filters are rejected on those search endpoints. When combining CSV pages, retain a single header row and continue offsets until the corresponding list's `page.total` is reached; each CSV response contains its own header.

Common outcomes: `400` invalid fields, money/date ranges or unknown input; `401` missing/invalid session; `403` wrong role; `404` unavailable or other-owner resources; `409` uniqueness/reference/state/stock conflicts; `422` a usage report that needs a narrower range; `429` rate limiting. A backend error response does not imply a successful mutation. Re-read the resource when resolving a concurrency conflict.
