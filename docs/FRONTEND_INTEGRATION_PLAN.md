# React frontend integration handoff — backend 1.2.0

**This is a plan for Claude to implement later. No React files were changed or connected to this backend for this delivery.**

Start the next implementation with [CLAUDE_INTEGRATION.md](../CLAUDE_INTEGRATION.md). Use [FRONTEND_FILE_MAP.md](FRONTEND_FILE_MAP.md) for the verified source locations and [INTEGRATION_ACCEPTANCE.md](INTEGRATION_ACCEPTANCE.md) for planned connected-browser checks. This document remains the detailed API/field mapping. The integration brief fixes initial token storage to memory only, with login after reload/new tab; it does not add cookie authentication.

The current frontend is the existing Bloom React/TypeScript application, source commit `563a659eee0e25cdb8b1a21516345b2fcccea05d`. Its pink theme and the user's written membership/marketplace requirements plus Context Diagram remain the product scope. Keep its working layout, responsive behavior, navigation and dialogs. The theme reference does not add face analysis, AI chat, makeup/fashion recommendations or medical features.

This backend implements the separate HTTP API and database responsibilities. Read the generated `docs/openapi.json` and `docs/API_INDEX.md`, the runtime `/docs`, `COMMERCE_API.md`, `WELLNESS_API.md`, and the main README for the exact backend contract. The current release has 165 operations across 123 paths and 37 application tables in six migrations. `npm run openapi` regenerates both API documents from route registrations; do not edit the endpoint index by hand. This document maps the existing frontend to those APIs without pretending its old local state has already been migrated.

## 1. Replace the data boundary, preserve the interface

| Existing frontend files                                                                             | Current responsibility                                | Integration work                                                                                     |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/types.ts`, `src/contentTypes.ts`                                                               | Browser-local commerce/content contracts              | Define backend DTOs and explicit adapters; handle UUIDs, cents, nullable values and timestamps       |
| `src/store.tsx`, `src/persistence.ts`                                                               | Shared localStorage state and account buckets         | Introduce an authenticated API client/query cache and per-request pending/error/retry state          |
| `src/actions.ts`                                                                                    | Synchronous local mutations and validation            | Replace appropriate actions with awaited API mutations; preserve UI validation as immediate feedback |
| `src/domain.ts`                                                                                     | Local quote, availability, review and migration rules | Use server responses for authoritative amounts/stock/permissions; retain display-only helpers        |
| `src/App.tsx`                                                                                       | Storefront, accounts, addresses, checkout, history    | Connect the endpoint groups below while retaining checkout intent and navigation                     |
| `src/Dashboard.tsx`, `src/ManagementPanels.tsx`, `src/MembersManager.tsx`, `src/OrderInspector.tsx` | Seller/admin screens                                  | Fetch scoped management data and invoke explicit server actions; refetch after changes               |
| `src/managementReports.ts`                                                                          | Local aggregation and CSV                             | Use server report/export responses and preserve precise filter/total labels                          |
| `src/Wellness.tsx`, `src/wellnessState.ts`                                                          | Separate account/week local records                   | Connect personal wellness APIs separately from commerce; preserve historical snapshots               |
| `src/ContentManager.tsx`, `src/contentValidation.ts`                                                | Article/food/template editing                         | Connect individual admin CMS resources; handle reference/activation errors                           |
| `src/imageUpload.ts`, `src/useImageUpload.ts`                                                       | Local file decoding and data URLs                     | Keep client validation/preview, then multipart upload and save the returned upload ID                |
| `src/buyerNavigation.ts`                                                                            | Product/order links and notifications                 | Preserve routes, use backend UUIDs for lookups, and display the separate order number                |

Do not send a full `State` object to the server. There is no API that accepts browser-local user lists, roles, order totals, stock values from checkout or complete application state as authority.

## 2. Base URL, envelopes and request handling

For local development the API defaults to `http://localhost:4000` and resource paths start with `/api/v1`. A future frontend-only `VITE_API_BASE_URL` may contain the public API URL; it is not a secret. Do not put database, SMTP or provider secrets in any `VITE_*` variable.

Successful resources return:

```json
{ "data": { "id": "UUID", "name": "Example" } }
```

Paginated collections return:

```json
{
  "data": [],
  "page": { "limit": 20, "offset": 0, "total": 0 }
}
```

Some lists intentionally omit `total`; do not assume every collection has the same metadata. See each endpoint. Failed requests return an `error` object with `code`, `message`, optional `details`, and a request ID where applicable.

The frontend API wrapper should:

1. Add `Authorization: Bearer <accessToken>` for protected requests.
2. Parse the envelope, preserve machine-readable error codes/details, and expose a Thai user-facing message.
3. Support cancellation to prevent stale responses from a previous route/account overwriting current state.
4. Distinguish pending, successful, empty, validation failure, access failure and network failure.
5. Await a confirmed response before claiming that data is saved or a payment was verified.
6. Clear account-scoped query caches and pending private image URLs on logout/account change.

An upload deletion may return HTTP 202 with `data.deleted: true` and `data.fileRemovalPending: true`. Treat this as an accepted deletion and remove the old upload ID from unsaved client state. It is already inaccessible through the API; the flag describes deferred physical storage cleanup, not a failed mutation or permission to reuse the file. Do not require HTTP 200 for every successful mutation.

The live Swagger and generated OpenAPI response schemas explicitly describe both HTTP 200 and HTTP 202 for upload deletion. Preserve both variants in a generated or handwritten frontend client.

Configure the backend's `CORS_ORIGINS` with the exact frontend origins used. A port change produces a different origin. The current API uses bearer headers and does not issue browser cookies.

## 3. Identity and session changes

| Existing UI flow             | API                                                                   |
| ---------------------------- | --------------------------------------------------------------------- |
| Register                     | `POST /auth/register` with name, email, password, optional phone      |
| Login                        | `POST /auth/login` with email and password                            |
| Restore current account      | `GET /auth/me` using a valid access token                             |
| Rotate session tokens        | `POST /auth/refresh` with `refreshToken`                              |
| Logout / logout all sessions | `POST /auth/logout`, `POST /auth/logout-all`                          |
| Edit profile                 | `PATCH /me/profile` with name, phone, address and/or owned `avatarId` |
| Change email                 | `POST /me/change-email` with new email and current password           |
| Change password              | `POST /me/change-password` with current/new password                  |
| Forgot/reset password        | `POST /auth/forgot-password`, `POST /auth/reset-password`             |
| Verify/resend email          | `POST /auth/verify-email`, `POST /auth/resend-verification`           |

Registration, login and refresh return `accessToken`, `refreshToken`, `tokenType`, `expiresIn` and a public `user`. Refresh rotation makes the previous refresh token unusable; reuse revokes its session. Implement one in-flight refresh operation shared by concurrent requests. If multiple tabs share tokens, coordinate refresh across tabs or introduce a deliberate browser-session/BFF design.

For a first integration, keeping tokens in memory means a page reload requires signing in again. If persistent browser sessions are desired, design that explicitly. An HttpOnly cookie/BFF approach would require additional endpoints/cookie handling and CSRF decisions; those are not already implemented by this bearer-token API. Do not silently move the old demo password/session state into production localStorage as an authentication solution.

Password/email changes revoke sessions and return `signInRequired: true`; show success and require a fresh login. The current frontend local SHA-256 comparison and demo role-switch controls must no longer determine identity in API mode. Regular/seller/admin roles come from the server, and the server rechecks ownership on each protected operation.

Sensitive account changes recheck the original access token and current account state inside the write transaction after password verification/hashing. Finish an active refresh before starting these requests. If the token was logged out, rotated, expired or revoked while the request was running, `401 INVALID_SESSION` rejects the change; require a fresh sign-in instead of displaying success or blindly replaying the password payload. Preserve the single coordinated refresh flow and account-switch cancellation behavior.

An approved seller still uses the ordinary buyer endpoints. After a shop is approved, refetch `/auth/me` and `/me/shop`; the public account DTO is not a replacement for the full shop record. Admin blocking revokes sessions. Do not retain another account's cached carts, orders, profile or health data after a 401/logout.

## 4. DTO differences that must be mapped

| Existing frontend field                           | Backend field / handling                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Product `id`, Shop `id`, Category `id`            | UUIDs; old `p1`, `s1`, category slugs and local `u1` values are not API IDs                                          |
| Product `category`                                | `categoryId` UUID; category names come from the category response                                                    |
| Product `en`                                      | `englishName`                                                                                                        |
| Product `price`, `original` in baht               | `priceCents`, `originalPriceCents` in integer satang; divide by 100 for display                                      |
| Product `image` atlas index                       | `imageIndex` 0–5, nullable                                                                                           |
| Product `customImage` data URL                    | Owned uploaded `imageId` plus read `imageUrl`; do not send data URLs in product JSON                                 |
| Product `reviews` count                           | `reviewCount`; ratings/counts come from visible stored reviews                                                       |
| Shop `shippingFee`, `freeShippingAt`              | `shippingFeeCents`, nullable `freeShippingAtCents`                                                                   |
| Order `id` formerly a `BL-...` label              | UUID `id` for API/navigation; `number` is the displayed `BL-...` reference                                           |
| Order `groupId`                                   | `checkoutId`                                                                                                         |
| Unpaid order countdown                            | Nullable `paymentDueAt` from server; do not invent a local deadline                                                  |
| Payment method                                    | `transfer`, local-only `development`, or server-selected `no_charge` for a zero total                                |
| Order `date`                                      | `createdAt` timestamp                                                                                                |
| Order item `price`                                | `unitPriceCents`; keep the server's order-item snapshot                                                              |
| Order `subtotal`, `shipping`, `discount`, `total` | Corresponding `*Cents` fields                                                                                        |
| Order flat `buyer`/`address`/`phone`              | `addressSnapshot` and server order identity; adapt receipt/shipping display                                          |
| Order `history`                                   | `events`; event `createdAt` and `actorName` replace local labels/timestamps                                          |
| Order `receipt` data URL                          | `proofUploadId`, read through authenticated upload fetch                                                             |
| Earlier rejected/replaced payment proofs          | Paginated `/orders/:id/payment-proofs`; separate proof-record `id`, `uploadId`, status, reason and review timestamps |
| Order `payment: "demo"`                           | `paymentMethod: "development"`, opt-in only outside production                                                       |
| Promotion `minSpend`, `maxDiscount`               | `minSpendCents`, nullable `maxDiscountCents`                                                                         |
| Promotion `percent`                               | Still percentage, e.g. `10` means 10%; do not send database basis points                                             |
| Review `date`, local `userId` actor assignment    | Server `createdAt`; author identity is server-derived                                                                |
| Notification `read`                               | `readAt !== null`; order target is a UUID `orderId`                                                                  |
| Article `image` illustrative keyword              | Nullable upload `imageId`/`imageUrl`; keep an intentional local placeholder when absent                              |
| Food `group`                                      | Still `group`; `kcal` is a number in API food responses                                                              |
| Personal meal snapshots                           | `foodName`, `detail`, `kcalPerPortion`, `portions`, `totalKcal`, `date`                                              |
| Exercise day arrays                               | API week has `{ weekStart, days: [{ date, activities }] }`; activity `type`, `completed`, UUID `id`                  |

Do not coerce a null free-shipping threshold into the old local default of ฿999. In the backend, null means no threshold-based free shipping. Use the server quote to decide the actual shipping amount. The development seed uses ฿40 shipping and a ฿999 threshold for its sample stores.

The API accepts percentage input/output, but stores promotion percentages as integer basis points internally: `10%` becomes `1000`. This is a database detail. The frontend converts monetary fields, not the public percentage field.

The old frontend sometimes used `0` or an omitted value to mean an unlimited coupon cap/use limit. Send `maxDiscountCents: null` and `usageLimit: null` (or omit them) for that meaning; a numeric zero is not an accepted positive cap/use limit. Convert empty date fields to omitted values or `null`, not an empty date string.

For edited monetary text, validate up to two decimal digits and convert deterministically to integer satang before sending. Do not calculate checkout totals in baht and submit them as authority. Render server cents with the existing Thai currency formatting after division by 100.

Fresh seed products have no fabricated historical reviews or orders. Their rating/count may be zero; show a sensible empty review state instead of copying old demonstration totals into the database.

## 5. Customer endpoint mapping

| Interface feature                      | Actual API group                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Catalog/category/search/filter/sort    | `GET /categories`, `GET /products`, `GET /products/:id`                                                 |
| Public store                           | `GET /shops`, `GET /shops/:id`; products filtered with `shopId`                                         |
| Wishlist                               | `GET /me/wishlist`, `PUT/DELETE /me/wishlist/:productId`                                                |
| Cart                                   | `GET /me/cart`, `PUT /me/cart/:productId` with absolute `quantity`; 0 removes; `DELETE /me/cart` clears |
| Merge guest cart after login           | `POST /me/cart/merge` with `items`                                                                      |
| Address book                           | `GET/POST /me/addresses`, `PUT/DELETE /me/addresses/:id`                                                |
| Quote and checkout                     | `POST /checkout/quote`, `POST /checkout`                                                                |
| Purchase history                       | `GET /me/orders`; filters include query/status/payment/date/shop and pagination                         |
| Order detail / tracking / receipt data | `GET /orders/:id`, `/orders/:id/tracking`, `/orders/:id/receipt`                                        |
| Payment-proof history                  | `GET /orders/:id/payment-proofs`; buyer/admin only, including seller accounts acting as the buyer       |
| Buyer actions                          | `POST /orders/:id/cancel`, `/orders/:id/payment-proof`, `/orders/:id/receive`                           |
| Review eligibility/submission          | `POST /products/:id/reviews`; the server checks delivered purchases                                     |
| Visible/own reviews                    | `GET /products/:id/reviews`, `GET /me/reviews`                                                          |
| Notifications                          | `GET /me/notifications`, `PATCH /me/notifications/:id/read`, `POST /me/notifications/read-all`          |

The server cart quantity endpoint **sets** the value. Convert the existing local “add one” button into a calculated next quantity or refetch after a successful operation; repeating the same PUT must not add units repeatedly.

Public review reads and wishlist saves share public product visibility: an active/unarchived product, active category, approved shop and unblocked owner. A stock balance of zero alone does not hide a product or prevent saving it. Handle HTTP 404 when the product is no longer public; existing wishlist entries may disappear from the list without being deleted. The buyer's own review list and authorized management queues retain history, so do not erase reviews locally when a listing is unavailable.

Keep an unauthenticated guest cart locally if desired. After login, merge it once through the API and clear the guest copy only after a successful response. Merge can report skipped products and clipped quantities; display the adjustment instead of pretending every guest line was accepted.

For checkout, create one `Idempotency-Key` per user-confirmed attempt and retain it across network retries of that exact body. Use the same key to recover the result of a request whose response was lost. Reusing that key with a changed body returns a conflict; generate a new key only for a new deliberate checkout. Server response orders and totals replace local creation of order IDs, stock movements, coupon uses and notifications.

For transfer orders without submitted proof, render the server's `paymentDueAt`. Expiry cancels the order and releases stock once; it does not introduce a new client-controlled payment state. A submitted proof awaiting review has no payment deadline, and rejection creates a fresh deadline. If submitting proof returns `PAYMENT_RESERVATION_EXPIRED`, refetch the order and show the cancellation result; do not create another proof or silently create a new checkout. A zero-total order uses `paymentMethod: no_charge` and is already settled, so hide transfer instructions and proof inputs for that order. A mixed checkout may contain both no-charge and payable store orders.

An admin can record a verified late transfer with `POST /admin/orders/:id/late-payment` using the exact order amount, incoming payment reference and a note. It creates a refund obligation without reopening the cancelled order or reserving stock again. Then use the existing manual refund endpoint after the refund is completed externally. Financial references, receipt times and detailed payment events stay private to buyer/admin. The sales summary adds `noChargeOrders`; CSV includes `paymentMethod`.

Load `/orders/:id/payment-proofs` for a buyer/admin history panel after a proof is submitted, rejected or replaced. It returns newest-first rows with `uploadId`, `status`, `reason`, `createdAt`, `reviewedAt`, `reviewerName` and `page.total`. Use `limit`/`offset` and an authorized image fetch for the selected upload. A seller fulfilling someone else's order receives 404 and must not see this panel; a seller viewing their own purchase has ordinary buyer access. Retain the current order's `proofUploadId` as the current proof reference instead of replacing it with an arbitrary history row.

For a shipped order, its seller or an admin can correct the carrier/tracking using `PATCH /orders/:id/shipment` with a reason. Refetch tracking/history after success. The original shipment event remains in history; editing a form must not overwrite it locally.

The receipt endpoint returns JSON for the existing print UI, not a PDF. It is not a statutory tax invoice. Tracking is seller-recorded; do not describe it as a live courier lookup.

## 6. Seller and admin mapping

| Interface feature                     | Actual API                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Seller application / shop profile     | `GET/POST/PATCH /me/shop`, `POST /me/shop/resubmit`                                                    |
| Shop approvals                        | `GET /admin/shops`, `GET /admin/shops/:id`, `POST /admin/shops/:id/decision`                           |
| Suspension/reactivation               | `PATCH /admin/shops/:id/status`                                                                        |
| Product management                    | `GET/POST /seller/products` or `/admin/products`; detail/PATCH/DELETE on `/:id`                        |
| Restore an archived product           | `POST /seller/products/:id/restore` or corresponding `/admin` route; restored listings start inactive  |
| Stock adjustment                      | `POST /seller/products/:id/stock` or corresponding `/admin` route                                      |
| Stock movement list/export            | `GET /seller/stock-movements` and `/export`, or corresponding `/admin` routes                          |
| Fulfilment queues                     | `GET /seller/orders` or `/admin/orders`; detail remains `/orders/:id`                                  |
| Prepare/ship                          | `POST /orders/:id/prepare`, `/orders/:id/ship`                                                         |
| Review transfer proof                 | `POST /admin/orders/:id/payment-review`                                                                |
| Inspect previous proofs and decisions | `GET /orders/:id/payment-proofs`; admin or buyer, never a seller-only management view                  |
| Record completed manual refund        | `POST /admin/orders/:id/refund`                                                                        |
| Promotions                            | `GET/POST /seller/promotions` or `/admin/promotions`; `PUT/DELETE .../:id`                             |
| Review queues / replies / moderation  | `GET /seller/reviews`, `/admin/reviews`; `PUT /reviews/:id/reply`, `PUT /admin/reviews/:id/moderation` |
| Sales report / export                 | `GET /seller/reports/sales` and `.csv`, or corresponding `/admin` routes                               |
| Members                               | `GET /admin/users`, `/admin/users/:id`, `/admin/users/export`; `PATCH /admin/users/:id/status`         |
| Categories                            | `GET/POST /admin/categories`, `PATCH/DELETE /admin/categories/:id`                                     |
| Site settings                         | `GET /settings`, `GET/PATCH /admin/settings`                                                           |
| Audit and usage                       | `GET /admin/audit-events`, `/admin/usage`; `POST /visits` records an anonymous page view               |

Check `openapi.json` for exact request schemas. Seller product creation derives the store from the actor; admin product creation requires a store UUID. Do not add an arbitrary shop selector to seller API requests or send a modified owner ID.

Product deletion archives the listing and preserves order history. Stock adjustments use `change` plus a reason; stock movement history is returned by the server. Do not append a second local movement after a successful server mutation.

Keep explicit buttons for the permitted order transitions. The backend does not accept an arbitrary status-edit operation. Buyers cancel pending orders; admins can cancel eligible unshipped paid/preparing orders and record a separate refund. An API refund record does not initiate a bank transfer. The current application has no selected payment gateway or courier integration.

Sales reports use Bangkok **order creation dates** and separate paid merchandise, discounts, shipping, pending payment and refund amounts. They aggregate the filtered result up to the documented 10,000-order bound. Member/stock CSV exports use their list pagination parameters; do not label an exported page as the entire database. Narrow filters or fetch the desired pages explicitly.

If a sales summary returns `422 REPORT_TOTAL_TOO_LARGE`, its monetary sum exceeds the safe integer range. Offer narrower filters or the corresponding order-level `.csv` export within the existing 10,000-order limit. Do not show zero, a rounded number or a silently truncated partial total. The distinct `REPORT_TOO_LARGE` error means the row limit itself was exceeded and requires narrower filters for either format.

## 7. Upload integration

1. Keep the existing 1 MB client check and image preview for immediate feedback.
2. Send one multipart field `file` to `POST /uploads?kind=product|avatar|proof|article` with authorization.
3. Wait for the server response. Save the returned upload UUID in the relevant product/profile/order/article action.
4. Retain the previous saved image if reading/uploading fails. Revoke temporary object URLs when replaced or closed.
5. If abandoning an uploaded image, `DELETE /uploads/:id` deletes an unused owned upload. HTTP 200 means immediate physical cleanup; HTTP 202 with `fileRemovalPending: true` means metadata deletion is committed and durable cleanup is pending. Both remove access to that upload ID. Referenced images are protected with HTTP 409; do not discard an image still saved on a resource when that request fails.

Resolve returned `/api/v1/uploads/{id}` paths against the API origin, not against the frontend origin. Public product/published-article images can use a direct image URL. Payment proofs and other private images require an authorized fetch; a plain `<img src>` cannot attach a bearer header. Fetch them as a Blob and use a temporary object URL. Never place tokens in image query strings.

Payment-proof access belongs to the buyer/uploader and admins. A seller fulfilling another buyer's order must not receive or display that buyer's private proof image; seller order detail omits the proof reference and payment-review note.

The backend performs independent image validation and stores normalized image bytes on its configured upload volume. The existing product atlas remains a frontend asset; seeded `imageIndex` values refer to that original 0–5 atlas, and the backend ZIP does not need to duplicate its UI images.

## 8. Wellness and CMS integration

Use the exact endpoint/payload examples in `WELLNESS_API.md`. Public content, admin editing and personal records are separate API groups; replacing only the shared commerce store will leave old wellness localStorage code active unless it is migrated separately.

- Load article filter choices from `GET /articles/filters`, which returns `data.categories` and `data.tags` as `{ value, count }` arrays across all published articles. Do not derive available choices only from the first paginated article response. Draft-only values are excluded; counts describe all published content, not the current search result.
- Article `q` search requires every whitespace-separated word to match somewhere across title, subtitle, category, tag or paragraph text. Words may match different fields, and `%`, `_` and backslashes are literal characters. Use the same semantics when describing search in the UI; do not apply a conflicting client-only phrase filter after the server response.
- Article bookmarks move to `GET /me/article-bookmarks`, with `q`, `category`, `tag`, `limit` and `offset`. The server combines those filters with the current account's bookmarks and published visibility. Use its filtered `page.total` for pagination; do not download one bookmark page and treat client-filtered rows as the complete result.
- Food catalogue values come from `/foods`. Load group choices from `GET /foods/groups`, which returns `data: [{ value, count }]` across all active foods, including groups outside the first food page. Inactive-only groups are excluded. A logged meal displays its captured name/portion/calorie fields even if the catalogue changes or the food is removed.
- Diary GET accepts a selected date or bounded inclusive range. Each entry's `totalKcal` uses decimal half-up rounding to two places, and `totalsByDate` sums those rounded entries across the full range, independently of pagination. Render these server values instead of recalculating with binary floats or summing only the loaded page. Exports use the same rounding, so entry display, daily totals and exported values agree.
- Template application is an API mutation with `append` or `replace`. Refetch the chosen day/week after success. Do not perform an additional client-side copy after the server has copied it.
- Personal exercise records use actual calendar dates and UUIDs; completion is attached to the copied activity, not the source template activity.
- Send the chosen `YYYY-MM-DD` date and Monday `weekStart` explicitly. Avoid converting a calendar date through UTC in a way that shifts the selected day. Backend defaults use Bangkok, while the old UI defaults used the browser's timezone.
- The health profile accepts numeric values, `null` or omitted optional fields, plus a self-written goal. Convert blank numeric inputs to `null`; do not send empty strings. The profile `PUT` submits the intended complete profile, and omitted numeric fields become `null`. Keep the interface free of new medical or AI calculations.
- Existing local browser records are not automatically uploaded or imported by this backend. Preserve them until an explicit migration/import flow is designed; this package does not claim such an import endpoint exists.

## 9. Suggested integration sequence and checks

1. Establish DTOs/API wrapper, error envelope handling and authentication; retain current checkout return intent.
2. Connect public catalogue and settings, then account/profile/address/shop application.
3. Connect wishlist/cart and server quote. Verify quantity changes and guest merge before enabling checkout.
4. Connect idempotent checkout, proof upload/review, order history and explicit fulfilment actions.
5. Connect seller/admin products, stock, promotions, reviews, members, reports and CMS.
6. Connect personal wellness storage and bookmarks; preserve date/account separation and snapshots.
7. Remove demo-role authority and local-generated order/payment state from API mode. Keep any optional demo mode visibly separate in configuration.
8. Run backend tests and the existing frontend tests, then exercise the combined flow in a browser at the existing phone/tablet/desktop widths.

Acceptance should include two distinct buyer accounts, two different stores, a rejected seller application, a blocked account, foreign-resource UUIDs, an unavailable product at checkout, repeated checkout submission, wrong/old refresh tokens, a rejected/resubmitted proof, cancellation with exactly one restock, a refund record, delivered-purchase review eligibility, private proof access, edited food/template snapshots, and an account switch with no stale private records.

Also exercise a private paginated proof history, seller-as-buyer access, a product becoming unavailable while reviews/Wishlist are open, an out-of-stock public listing, deferred HTTP 202 upload deletion, oversized-summary CSV fallback, and an account change whose originating session is revoked while it is running.

Neither this plan nor the backend tests establish that React integration has been completed. Record the actual combined browser results after Claude implements that next step.

## 10. Runtime and database setup for the next phase

Existing data upgrades through `npm run db:migrate`: 1.1.0 adds migration 006 and 1.0.0 adds 005+006. Preserve migrations 001–005 and existing data; do not reset or reseed to integrate the frontend. Stop the same-directory PGlite API before running a separate migration/worker command.

API startup enables `BACKGROUND_JOBS=true` by default. Mail and maintenance share the API's database handle, including in PGlite mode, and run immediately plus at configured intervals: `MAIL_INTERVAL_SECONDS=10` (1–3600), `MAINTENANCE_INTERVAL_SECONDS=60` (5–3600). Each job is nonoverlapping and guarded by migration readiness; SIGINT/SIGTERM stops new claims and drains current work. Development mail is delivered locally without configuring an external provider. If in-process jobs are disabled, arrange separate scheduled workers with the database constraints in OPERATIONS.md.

Configure actual ingress with exact CORS origins and explicit `TRUST_PROXY_CIDRS` for trusted direct proxies only. The proxy must replace client-supplied forwarding headers. The default empty allowlist trusts none, and the current rate-limit counters remain per process.

`TEST_DATABASE_URL` selects native PostgreSQL for API fixtures and the populated legacy-upgrade fixture. PGlite-specific persistence tests remain separate. Read VERIFICATION.md for exact results, engines and limits; no test count in an earlier handoff is evidence for this release or for future React integration.
