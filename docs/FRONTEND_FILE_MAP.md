# แผนที่ไฟล์ React สำหรับเชื่อม Bloom Node server

เอกสารนี้ระบุจุดแก้ใน **frontend เดิม** เพื่อให้ Claude ลงมือ integrate ตาม `../CLAUDE_INTEGRATION.md` ได้ตรงไฟล์ เป็นแผนงานจากการอ่าน source ไม่ใช่รายงานว่าเชื่อมระบบเสร็จแล้ว

อ้างอิง frontend `bloom-healthshop` commit `563a659eee0e25cdb8b1a21516345b2fcccea05d` และ backend รุ่น **1.2.0** ตรวจเมื่อ 14 พฤศจิกายน 2026 หาก frontend ที่ได้รับเป็นรุ่นใหม่กว่า ให้ตรวจชื่อไฟล์และพฤติกรรมล่าสุดก่อนแก้ โดยรักษางานที่เพิ่มภายหลังไว้

**ZIP นี้บรรจุ Node server และเอกสารส่งต่อ** ส่วน React อยู่ใน `Bloom-Frontend-Claude-Handoff.zip` หรือ repository ของ frontend แยกต่างหาก ต้องมีทั้งสองโครงการก่อนเริ่มเชื่อมหน้าเว็บ ใช้ไฟล์ React เดิมและ assets เดิมเป็นฐาน

รายละเอียด field mapping, payload และข้อจำกัด API อยู่ใน [FRONTEND_INTEGRATION_PLAN.md](FRONTEND_INTEGRATION_PLAN.md), [API_INDEX.md](API_INDEX.md) และคู่มือแต่ละโมดูล เอกสารนี้เน้นว่าแต่ละงานอยู่ตรงไหนใน frontend

## 1. โครงสร้างที่มีอยู่จริง

- React 19 + TypeScript + Vite; dependency ปัจจุบันมี `react`, `react-dom` และ `lucide-react`
- ใช้ Context จาก `StoreProvider`/`useStore` ใน `src/store.tsx`
- ใช้ **hash navigation ที่เขียนเอง** ใน `src/App.tsx` และ `src/buyerNavigation.ts` ไม่มี React Router ใน dependency ปัจจุบัน
- ข้อมูลซื้อขาย/CMS หลักอยู่ใน browser state และ localStorage ผ่าน `src/actions.ts`, `src/domain.ts`, `src/persistence.ts`
- ข้อมูลสุขภาพส่วนตัวมีระบบ localStorage อีกชุดใน `src/Wellness.tsx` และ `src/wellnessState.ts`
- ยังไม่มี HTTP client, query cache library หรือ browser E2E framework ติดตั้งไว้ อย่าเขียนคำสั่งที่สมมติว่ามี Axios, TanStack Query หรือ Playwright แล้ว หากเลือกเพิ่ม ให้บันทึก dependency และคำสั่งติดตั้งในโครงการจริง

## 2. ไฟล์หลักและงานที่ต้องเปลี่ยน

API ในตารางใช้ prefix `/api/v1` เว้นแต่ระบุเป็นอย่างอื่น

| ไฟล์ / จุดที่มีอยู่จริง                                                                                                                                             | หน้าที่เดิม                                                                                                   | งาน integration ที่ต้องทำ                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.tsx`                                                                                                                                              | ประกอบ `React.StrictMode`, `ErrorBoundary`, `StoreProvider`, `App`                                        | ติดตั้ง provider สำหรับ session/ข้อมูล API ตามโครงสร้างที่เลือก ให้ boot/loading/error ชัดเจน และไม่ยิง mutation ซ้ำจาก effect ภายใต้ StrictMode                                                                  |
| `src/store.tsx`: `StoreProvider`, `useStore`                                                                                                                | โหลด local state, หา user จาก `currentUserId`, สร้าง actions และเขียน state ทั้งชุดกลับ localStorage            | แยก current server user, public queries และข้อมูลส่วนตัวของบัญชีออกจาก demo state โหลด `/auth/me` และ `/me/shop` ตามสิทธิ์ ยกเลิก request/ล้างข้อมูลส่วนตัวเมื่อเปลี่ยนบัญชี                                           |
| `src/persistence.ts`: `loadLocalState`, `persistLocalState`                                                                                                 | เก็บ `bloom-healthshop-demo-v2` และอ่านรุ่น `v1` เป็น fallback                                                 | เก็บได้เฉพาะข้อมูลที่ตั้งใจให้ local เช่น guest cart/การตั้งค่าหน้าจอ รักษาข้อมูลเก่าไว้สำหรับการสำรอง แต่อย่านำ local users/roles/orders ไปเป็นความจริงของ API และอย่าโหลด seed แทน server error                          |
| `src/actions.ts`: `createStoreActions`                                                                                                                      | ใช้ local state ตรวจสิทธิ์และทำ mutation ซื้อขาย/สมาชิก/CMS                                                      | เปลี่ยน action ที่เกี่ยวกับ server เป็น async API calls หรือแยก service ตามโมดูล ปรับทุก call site ให้ `await` ผลจริง ไม่ส่ง State ทั้งก้อนไป server                                                                 |
| `src/domain.ts`                                                                                                                                             | `actorOf`, `normalizeState`, `calculateCart`, `switchAccount`, `recalculateReviews`, `allowedTransitions` | รักษา helper ที่ใช้จัดรูปแบบ/แสดงผลได้ แต่ให้ตัวตน ราคา ยอด checkout สต็อก คะแนนรวม และสถานะที่เปลี่ยนได้มาจาก server อย่าใช้ `normalizeState` เติมข้อมูลสาธิตเมื่อ API ว่างหรือล้มเหลว                                      |
| `src/types.ts`, `src/contentTypes.ts`                                                                                                                       | Model สำหรับ local demo; เงินเป็นบาท, order ID เป็นเลขแสดงผล, มี `passwordHash` และ `demoRole`                 | เพิ่ม DTO จาก server และตัวแปลงสำหรับ UI แยก UUID `id` จาก `number`, integer `*Cents` จากราคาที่แสดง, `imageId` จาก preview และ payment/fulfilment states ห้ามส่งหรือรับ `passwordHash` เป็น public user DTO |
| `src/App.tsx`: `App`, `Home`, `Shop`, `Storefront`, `ProductDetail`                                                                                         | เลือกหน้าและกรอง products/shops/categories/reviews จาก `state`                                              | ต่อ public catalog/settings/shop/review APIs พร้อม pagination, query/filter/sort และโหลด detail ตาม UUID โดยตรงเมื่อเปิด deep link รายการที่ไม่มีในหน้าปัจจุบันอาจยังมีอยู่บน server                               |
| `src/App.tsx`: `Auth`, `Account`, `ApplyShop`                                                                                                               | Login/register, profile/password/address และสมัครร้านผ่าน local actions                                      | ต่อ auth/profile/address/shop APIs เพิ่ม UI ที่ backend รองรับแต่ยังไม่มี เช่น forgot/reset/verify/change-email โหลดสถานะสมัครร้านและใช้ PATCH + resubmit สำหรับคำขอที่ต้องแก้แล้วส่งใหม่                               |
| `src/App.tsx`: `Cart`, `Checkout`, `ProofUpload`                                                                                                            | คำนวณ quote และสร้าง order ในเบราว์เซอร์; proof เป็น data URL                                                 | ต่อ cart/guest merge/address/quote/idempotent checkout แยกสร้าง order ออกจากส่งหลักฐานของแต่ละ order ใช้ upload UUID และผลจาก server รองรับ `no_charge`                                                  |
| `src/App.tsx`: `Orders`, `Notifications`                                                                                                                    | กรอง order/notifications ใน state และเรียก `updateOrder`                                                   | ต่อ `/me/orders`, order detail/tracking/receipt/proof history และ notifications เรียก action endpoints ชัดเจนและ refetch หลังสำเร็จ                                                                    |
| `src/Dashboard.tsx`: `Dashboard`, `ProductEditor`, `SalesChart`                                                                                             | Seller/admin overview และสินค้า/คำสั่งซื้อจาก shared state                                                      | โหลด `/seller/...` หรือ `/admin/...` ตาม session และหน้าแสดงผล แยก seller scope ให้ชัด ใช้ `/me/shop` แทนสมมติว่า user DTO มี `shopId` ทุกกรณี                                                              |
| `src/ManagementPanels.tsx`: `CategoryManager`, `PromotionsManager`, `ReviewsManager`, `ShopsManager`, `InventoryManager`, `UsageManager`, `SettingsManager` | แก้ local collection และทำ CSV บางส่วนใน browser                                                            | เชื่อม API ราย resource รวมเหตุผลการปฏิเสธ/ระงับ/ซ่อนรีวิว การปรับ stock ใช้ endpoint stock พร้อมเหตุผล ข้อมูล usage/audit/settings ใช้ server                                                                   |
| `src/MembersManager.tsx`                                                                                                                                    | อ่าน `state.users` และเปลี่ยน blocked ผ่าน `setUserBlocked`                                                   | ใช้ `/admin/users`, detail/export และ status mutation สมาชิกทั่วไปต้องไม่โหลดรายการผู้ใช้ทั้งหมด                                                                                                             |
| `src/OrderInspector.tsx`                                                                                                                                    | `updateOrder`, `rejectPayment`, `completeRefund` และรูป proof จาก local order                              | ใช้ prepare/ship/shipment/cancel/receive และ admin payment-review/refund/late-payment ตามสิทธิ์ seller-only view ไม่รับรูปหรือเหตุผลหลักฐานส่วนตัวของผู้ซื้อคนอื่น                                                  |
| `src/managementReports.ts`                                                                                                                                  | `summarizeSales`, `filterManagementOrders`, `salesByShop`, `csvText`, `readManagementRoute`               | รักษา route helper/การแสดงผลที่ยังเหมาะสม แต่ยอดขายและ CSV จริงต้องมาจาก `/seller/reports/sales` หรือ `/admin/reports/sales` และ `.csv` ไม่รวมเฉพาะ order หน้าที่โหลดอยู่                                       |
| `src/ContentManager.tsx`, `src/contentValidation.ts`                                                                                                        | แก้ `ContentData` ทั้งก้อนผ่าน `saveContent`                                                                   | แยก request ของ articles/foods/meal-templates/exercise-templates ต่อ `/admin/...` แต่ละ resource รวม publish/active/reference errors ไม่มี endpoint รับ `ContentData` ทั้งชุด                             |
| `src/Wellness.tsx`, `src/wellnessState.ts`                                                                                                                  | สมุดอาหาร กิจกรรม completion bookmarks และโปรไฟล์สุขภาพ เก็บ local แยกบัญชี/สัปดาห์                                | ต่อ personal wellness APIs แยกจาก commerce ใช้วันที่จริง snapshot/calorie totals และ completion จาก server พร้อมแยกบัญชีและยกเลิก request เก่า                                                               |
| `src/imageUpload.ts`, `src/useImageUpload.ts`, `src/components.tsx`                                                                                         | ตรวจไฟล์และอ่านเป็น data URL; `ProductImage` ใช้ atlas หรือ custom image                                       | เก็บการตรวจ/preview ไว้ แล้วส่ง `File` เป็น multipart เพื่อได้ upload UUID ปรับ renderer รองรับ URL และ private Blob/object URL รวม cleanup เมื่อปิดหน้า/เปลี่ยนบัญชี                                               |
| `src/buyerNavigation.ts`                                                                                                                                    | `buyerPageFromHash`, `buyerHashWith`, `buyerHashQuery`, `notificationDestination`, `filterBuyerOrders`    | รักษา Back/Forward และ query ของหน้า เปลี่ยน record references เป็น UUID โหลดข้อมูลตาม URL และใช้ตัวกรอง server สำหรับประวัติที่แบ่งหน้า                                                                          |
| `src/data.ts`, `src/contentSeed.ts`                                                                                                                         | Seed records, labels และ display helpers                                                                  | แยก labels/formatters/visual fallbacks ออกจากข้อมูลสาธิต API mode ต้องไม่สร้าง demo users/orders หรือปลอม rating เมื่อฐานข้อมูลยังว่าง                                                                         |

## 3. จุดที่ต้องแก้ก่อนเปลี่ยน actions เป็น async

หลายฟอร์มใช้ผล synchronous เช่น `if (saveProduct(...)) setEdit(null)` หรือ `if (resubmitPayment(...)) setProof(undefined)` การเปลี่ยน action ให้คืน Promise อย่างเดียวจะทำให้เงื่อนไขเป็นจริงทันที แม้ server ยังไม่ตอบหรือปฏิเสธคำขอ

ตรวจ call site ใน `App.tsx`, `Dashboard.tsx`, `ManagementPanels.tsx`, `MembersManager.tsx`, `OrderInspector.tsx` และ `ContentManager.tsx` ให้ครบ:

1. ใช้ async handler และ `await` mutation
2. มีสถานะ pending แยกสำหรับรายการ/ฟอร์มนั้น ป้องกันกดซ้ำ
3. ปิด modal, ล้าง draft หรือแจ้งว่าสำเร็จหลัง server ยืนยัน
4. คง draft เมื่อ validation/network failure และแสดง error ที่สัมพันธ์กับ field
5. หลังสำเร็จใช้ server DTO หรือ refetch ข้อมูลที่เกี่ยวข้อง ไม่เพิ่ม stock movements/notifications/audit events ซ้ำใน browser

`Checkout` เดิมเรียก `checkout(...)` แล้วตรวจ `result.length` โดยไม่ await และบังคับแนบ proof ก่อนสร้าง local order ต้องเปลี่ยน flow นี้โดยตรง ไม่เพียงเปลี่ยนชื่อ action เป็น `fetch`

## 4. Navigation และลิงก์บัญชีจากอีเมล

Route ปัจจุบันเป็น hash เช่น:

```text
#shop?product=<product-uuid>
#store?shop=<shop-uuid>&product=<product-uuid>
#orders?order=<order-uuid>
#seller?view=orders&order=<order-uuid>
#admin?view=members
#articles?article=<article-uuid>
```

ค่า `<...-uuid>` ในตัวอย่างคือ placeholder ต้องใช้ ID ที่ API ส่งกลับ ไม่ใช่ค่า seed เช่น `p1`, `s1` หรือเลขแสดงผลคำสั่งซื้อ `BL-...`

`src/App.tsx` ใช้ `pageList`, `location.hash`, `hashchange`, `authIntent` และ `history.replaceState` ส่วน Dashboard ใช้ `readManagementRoute` ให้รักษาการกลับไปยัง checkout/หน้าที่ตั้งใจหลัง login และการเปิด order จาก notification ใน role ที่ถูกต้อง

**ลิงก์ที่ Node server สร้างไม่ได้เป็น hash route แบบข้างต้น:**

```text
<FRONTEND_URL>/reset-password#token=<single-use-token>
<FRONTEND_URL>/verify-email#token=<single-use-token>
```

เพิ่มการตรวจ `location.pathname` สำหรับสองหน้านี้ก่อนเรียก parser ของหน้า shopping ปกติ อ่าน `token` จาก URL fragment และเก็บใน memory ของ flow นั้น แล้วลบ token ออกจาก address bar ด้วย `history.replaceState` หลังอ่านสำเร็จ ห้าม log หรือส่ง token ไป analytics และไม่เติม token ลง image/API query string เรียก reset/verify ด้วย JSON body ตาม OpenAPI

ต้องทดสอบเปิดลิงก์โดยตรงและ refresh ใน deployment ที่ใช้จริง โดย web host ต้องคืน SPA entry ให้ `/reset-password` และ `/verify-email` ด้วย รองรับ token หมดอายุ/ใช้แล้ว/ไม่ครบ และอย่า consume token ซ้ำจาก React StrictMode หรือการ render ซ้ำ

## 5. แยกข้อมูลจริงออกจาก demo authority

`createStoreActions` มี `setRole`, `resetDemo` และการหา actor จาก local users ขณะที่ `App` มีปุ่มทดลอง seller/admin เมื่อเข้าหน้าจัดการไม่ได้ สิ่งเหล่านี้ต้องไม่เป็นช่องเปลี่ยนสิทธิ์ใน API mode ให้ใช้ login และ server role แสดง login-required/forbidden/pending-approval ตามจริง

Frontend user DTO ไม่จำเป็นต้องมี `shopId` แบบ demo ให้โหลด `/me/shop` เพื่อหาสถานะและ UUID ของร้าน ผู้ขายยังต้องซื้อสินค้าผ่าน buyer APIs ได้ และร้าน suspended ยังมีสิทธิ์จัดการงานที่ server อนุญาต อย่าใช้ปุ่มสลับ role เพื่อทำเงื่อนไขนี้

อย่าคัดลอก users, password hashes, orders, stock, promotions usage หรือข้อมูลสุขภาพจาก localStorage เข้า database อัตโนมัติ การเชื่อม API ไม่ได้เป็นการอนุมัติย้าย demo records เป็นข้อมูลจริง รักษาข้อมูล browser เดิมไว้และเสนอ flow สำรอง/ย้ายข้อมูลแยกเมื่อมีความต้องการชัดเจน

## 6. Wellness เป็นอีกเส้นทางหนึ่งของข้อมูล

การเปลี่ยน `StoreProvider` อย่างเดียวไม่ทำให้ Wellness เชื่อม API เพราะ `useSaved` ใน `Wellness.tsx` ยังอ่าน/เขียนผ่าน `wellnessKey(...)`:

| ข้อมูลเดิม                                                | API ที่ต้องเชื่อม                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `diary` ตามวัน พร้อม `snapshotFood`                      | `/me/meal-diary`, `/me/meal-diary/apply-template`                                                     |
| `activities` และ `done` แยกสัปดาห์ พร้อม `copyActivities` | `/me/exercise-schedule`, `/me/exercise-schedule/apply-template`                                       |
| `bookmarks`                                            | `/me/article-bookmarks` และ resource `/:id`                                                           |
| `profile`                                              | `/me/health-profile`                                                                                  |
| Public foods/articles/templates                        | `/foods`, `/foods/groups`, `/articles`, `/articles/filters`, `/meal-templates`, `/exercise-templates` |

ใน API mode ใช้ `date`/`weekStart` ที่ผู้ใช้เลือกอย่างชัดเจน ให้ `weekStart` เป็นวันจันทร์ และรักษา calendar date โดยไม่เลื่อนวันจากการแปลง UTC อ่าน `totalKcal`/daily totals จาก server และคง snapshot ของรายการเก่าเมื่อ admin แก้ข้อมูลอาหาร/template

Template application เป็น server mutation หนึ่งครั้ง หลังสำเร็จ refetch วัน/สัปดาห์นั้นและไม่เรียก local `copyActivities` หรือ `snapshotFood` เพื่อเพิ่มรายการซ้ำ `completed` อยู่กับ activity ที่คัดลอกมา ไม่ใช้ ID ของ template เป็น personal activity ID

## 7. รูปภาพและงานแสดงผลที่ควรรักษาไว้

- `useImageUpload` เดิมมี `busy`, `error`, `fileName` และ sequence guard กันผลอ่านไฟล์เก่าทับไฟล์ใหม่ รักษาพฤติกรรมนี้และขยายให้ครอบคลุม network upload/cancellation
- การแก้ `onReady(dataUrl)` ให้ใช้ server upload ต้องรักษา `File` หรือส่ง multipart จากไฟล์ที่เลือก ห้ามส่ง data URL ไปยัง `imageId`
- `ProofUpload` และ `OrderInspector` ต้องแสดง private proof ผ่าน authenticated Blob fetch ส่วนรูปสินค้าสาธารณะใช้ URL ได้ตามสิทธิ์ server
- การลบ upload ทั้ง HTTP 200 และ 202 ถือว่าลบ metadata แล้ว ให้เอา ID ออกจาก draft โดยไม่แนบกลับอีก
- เก็บ `public/images/hero-wellness.png`, `public/images/products-atlas.png` และ fonts ใน `public/fonts/` รูป atlas 0–5 ยังใช้เป็น visual fallback ได้เมื่อ server ไม่มีรูป
- รักษา CSS เดิม `styles.css`, `dashboard.css`, `wellness.css`, `buyer-upgrades.css`, `content-manager.css` และ responsive layout ทดสอบ modal, table, forms, keyboard และ error/loading states ทุกขนาดหน้าจอหลังเชื่อมข้อมูล

## 8. โครงสร้างไฟล์เพิ่มที่เสนอ

ชื่อเหล่านี้เป็น **ข้อเสนอสำหรับงาน integration** ไม่ใช่ไฟล์ที่มีแล้วใน frontend และเปลี่ยนชื่อให้เข้ากับโครงสร้างที่ตรวจพบได้:

| ไฟล์ / กลุ่มที่เสนอ                                                                               | หน้าที่                                                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/api/client.ts`                                                                          | Base URL, bearer, JSON/Blob/CSV handling, ApiError, AbortSignal และกติกา retry   |
| `src/api/dto.ts`                                                                             | ชนิด request/response ตาม API จริง แยกจาก local demo models                       |
| `src/api/auth.ts`, `catalog.ts`, `commerce.ts`, `management.ts`, `wellness.ts`, `uploads.ts` | API calls ตามโมดูล ไม่ส่ง state ก้อนเดียว                                            |
| `src/auth/session.tsx`                                                                       | Current user, token lifecycle, single-flight refresh และ account-change cleanup |
| `src/api/mappers.ts`                                                                         | แปลง DTO เป็น view models ที่ UI เดิมต้องการ โดยรักษา UUID/satang/snapshot            |
| `src/auth/AccountActionPage.tsx`                                                             | Pathname routes สำหรับ reset-password/verify-email และ single-use token flow     |

เริ่มจาก fetch wrapper และ provider ที่เข้าใจง่ายได้ ไม่จำเป็นต้องเปลี่ยน framework หรือเพิ่ม library หลายชุดเพื่อใช้ API เลือกวิธีเก็บ session และพฤติกรรมหลัง reload ให้ชัดเจนตามเอกสาร integration หลักก่อนลงมือ

## 9. คำสั่งและขอบเขตของเทสเดิม

รันในโฟลเดอร์ **frontend**:

```sh
npm ci
npm test
npm run build
npm run dev -- --port 5173 --strictPort
```

`npm run build` เดิมคือ `tsc -b && vite build`; frontend ยังไม่มี `typecheck` script แยก ค่า port ที่ใช้ต้องตรงกับ backend `CORS_ORIGINS` และ `FRONTEND_URL`

`npm test` ใช้ Node test runner กับ `tests/*.test.mjs` ได้แก่ `frontend`, `buyer`, `domain`, `management`, `wellness` บางชุด bundle TypeScript helpers ด้วย esbuild แล้วทดสอบ local domain/actions/storage/navigation จึง **ไม่ได้พิสูจน์ว่า React render, browser fetch, CORS, session refresh หรือ end-to-end checkout เชื่อม Node สำเร็จแล้ว**

รักษา/ปรับเทสเดิมที่ยังตรงกับพฤติกรรมและเพิ่มเทส adapter/async error/token coordination รวม browser integration ตาม [INTEGRATION_ACCEPTANCE.md](INTEGRATION_ACCEPTANCE.md) แยกผลเทส local helpers, backend และ connected-browser ให้ชัดเจนในรายงานส่งมอบ
