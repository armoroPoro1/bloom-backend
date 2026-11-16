# งานต่อสำหรับ Claude — เชื่อม React เดิมกับ Bloom Node server

เอกสารหลักสำหรับเริ่มลงมือ integrate โดยอ้างอิง **backend 1.2.0** และหน้าบ้าน Bloom สีชมพูเดิม ปรับปรุงเอกสารวันที่ **14 พฤศจิกายน 2026**

> เป้าหมายของงานต่อ: ให้หน้าบ้านเดิมใช้งาน API และฐานข้อมูลของ Node server จริง ครบลูกค้า ผู้ขาย แอดมิน และ wellness พร้อมทดสอบการใช้งานผ่านเบราว์เซอร์ ส่วน ZIP ฉบับนี้เป็น source ของ Node server พร้อมคำสั่งส่งต่องาน ยังไม่มีการเชื่อม React เกิดขึ้นจากการจัดทำเอกสารนี้

## 1. สิ่งที่ต้องมีและขอบเขตงาน

ต้องมี source สองชุด:

| ชุดงาน    | สิ่งที่ใช้                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Backend  | โฟลเดอร์ที่มีไฟล์นี้, `package.json`, `src/`, `migrations/`, `tests/`                                                                       |
| Frontend | โครงการ React เดิมจาก `Bloom-Frontend-Claude-Handoff.zip` หรือ repository ของผู้ใช้ ซึ่งมี `src/App.tsx`, `src/store.tsx` และ `package.json` |

**ZIP ของ Node server ไม่ได้รวม source React** ให้ค้นหาโครงการหน้าบ้านที่ผู้ใช้ส่งมาใน workspace ก่อนเริ่มแก้ไฟล์ ถ้ายังไม่มีจริง ให้ขอ source หน้าบ้านชุดนั้น โดยทำ backend baseline และตรวจ API ที่ทำได้ไปก่อน อย่าสร้างหน้าบ้านใหม่จากการเดาโครงสร้าง

หน้าบ้านที่ใช้จัดทำ mapping เป็น React + Vite + TypeScript commit `563a659eee0e25cdb8b1a21516345b2fcccea05d` หาก source ที่ได้รับใหม่กว่า ให้ตรวจ diff และยึดไฟล์ล่าสุดของผู้ใช้ ห้าม checkout ทับงานที่ผู้ใช้แก้เพิ่ม

ข้อกำหนด:

- รักษาธีมชมพู assets ข้อความภาษาไทย หน้าเดิม และ responsive behavior
- เชื่อมฟังก์ชันทั้งหมดตามคำอธิบายและ Context Diagram เดิม รวมงานสมาชิก ผู้ขาย แอดมิน และเนื้อหา/บันทึกสุขภาพ
- ผู้ขายยังซื้อสินค้าได้ตามปกติ การเปิดร้านต้องผ่านแอดมินอนุมัติ
- ให้ server เป็นผู้ตัดสิน identity, role, ownership, ราคา สต็อก คูปอง และสถานะคำสั่งซื้อ
- ใช้ backend Fastify/TypeScript เดิม ไม่เปลี่ยน framework, ORM หรือ schema ทั้งชุดเพื่อให้เข้ากับ demo state
- หากพบ API ขาดจริง ให้แก้ backend เท่าที่จำเป็น เพิ่ม regression test และปรับคู่มือ/สัญญาข้อมูลด้วย
- รักษา migrations 001–006 ที่ส่งมานี้ หากต้องเปลี่ยน schema ให้เพิ่ม migration ถัดไป
- การชำระเงินรอบนี้ใช้ flow โอนเงินและแอดมินตรวจหลักฐาน ส่วนขนส่งใช้ข้อมูลที่ร้านกรอก
- งานนี้ไม่กำหนดให้เปิดบริการภายนอก ซื้อบริการ หรือ deploy จริง ใช้ local SQL และ development mail เพื่อทำ integration ให้จบได้
- ไม่เพิ่ม Face Analysis, AI Chat, fashion stylist หรือคำแนะนำวินิจฉัยจากภาพธีม

## 2. อ่านไฟล์ตามลำดับ

1. [CLAUDE.md](CLAUDE.md) — ข้อตกลงและโครงสร้าง backend
2. [README.md](README.md) และ [VERIFICATION.md](docs/VERIFICATION.md) — วิธีรันและหลักฐาน baseline
3. [FRONTEND_FILE_MAP.md](docs/FRONTEND_FILE_MAP.md) — จุดแก้ใน source React ที่ตรวจพบจริง
4. [FRONTEND_INTEGRATION_PLAN.md](docs/FRONTEND_INTEGRATION_PLAN.md) — endpoint mapping และการแปลง DTO รายฟิลด์
5. [AUTH_AND_FILES.md](docs/AUTH_AND_FILES.md), [CATALOG_API.md](docs/CATALOG_API.md), [COMMERCE_API.md](docs/COMMERCE_API.md), [WELLNESS_API.md](docs/WELLNESS_API.md)
6. [openapi.json](docs/openapi.json), [API_INDEX.md](docs/API_INDEX.md) และ source handler ของ endpoint ที่กำลังเชื่อม
7. [INTEGRATION_ACCEPTANCE.md](docs/INTEGRATION_ACCEPTANCE.md) — checklist ทดสอบที่ต้องทำหลังเชื่อม

ลำดับความน่าเชื่อถือของข้อมูลเชิงเทคนิค: implementation และ regression tests → generated OpenAPI สำหรับ request schema/route → คู่มือ DTO/flow → demo data หน้าบ้าน หากพบเอกสารไม่ตรง implementation ให้ตรวจและแก้ทั้งคู่ อย่าผ่อน server validation เพื่อรับข้อมูล demo ที่ผิดสัญญา

OpenAPI ไม่ได้ระบุ response DTO ของทุก endpoint อย่างละเอียดเท่ากัน จึงต้องอ่าน module guides, handler และ response ที่เรียกได้จริงร่วมกัน ห้ามถือว่า code generation เพียงอย่างเดียวครอบคลุมทุก response แล้ว

## 3. รัน baseline ก่อนเปลี่ยนโค้ด

### Backend terminal

ใช้ Node.js 24 เพื่อให้ตรงกับสภาพแวดล้อมที่ตรวจไว้ รันจากโฟลเดอร์ backend:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

ผลเดิมของ backend คือ 85 tests ผ่านในโหมด PGlite และ 85 tests ผ่านในโหมด PostgreSQL รายละเอียด driver/ข้อจำกัดอยู่ใน `docs/VERIFICATION.md` นี่คือหลักฐานของ backend ก่อน integrate ไม่ใช่ผลทดสอบ browser ที่เชื่อมแล้ว

สำหรับ local ใหม่ ให้คัดลอก `.env.example` เป็น `.env` เฉพาะเมื่อยังไม่มีไฟล์ ตั้ง `SEED_DEMO_PASSWORD` เป็นรหัสทดสอบที่ผู้พัฒนากำหนดเอง ยาวอย่างน้อย 12 ตัวอักษร แล้วรัน:

```sh
npm run db:migrate
npm run db:seed
npm run dev
```

บัญชี seed ที่มีจริง ได้แก่ `buyer@bloom.example.test`, `seller@bloom.example.test`, `admin@bloom.example.test` และบัญชีร้านอื่นตาม `scripts/seed.ts` ใช้รหัสจาก `SEED_DEMO_PASSWORD` ที่ตั้งเอง ไม่ใช่รหัสสมมติในเอกสาร Seed ไม่รีเซ็ตรหัสบัญชีเดิมที่มีอยู่แล้ว

ถ้าใช้ฐานข้อมูลเดิม ให้สำรองและรัน migration โดยรักษาข้อมูลเดิม การรัน seed ไม่ใช่ขั้นตอนอัปเกรดฐานข้อมูล เมื่อใช้ PGlite ต้องหยุด API ก่อนเปิด process migration/seed/worker แยกที่ใช้ data directory เดียวกัน

### Frontend terminal

รันจากโฟลเดอร์ React เดิม:

```sh
npm ci
npm test
npm run build
npm run dev -- --port 5173 --strictPort
```

ปัจจุบัน frontend มี scripts `dev`, `build`, `test`, `preview` โดย `build` ตรวจ TypeScript ด้วย ยังไม่มี script `typecheck` หรือ `test:e2e` แยก หากเพิ่ม browser runner ให้เพิ่ม dependency/config/script ที่ใช้งานได้จริง

### Environment สำหรับ local integration

Backend `.env`:

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=4000
DATABASE_DRIVER=pglite
PGLITE_DIR=./var/database
PUBLIC_BASE_URL=http://localhost:4000
FRONTEND_URL=http://localhost:5173
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
BACKGROUND_JOBS=true
ALLOW_DEV_PAYMENTS=false
```

Frontend ให้เพิ่ม `.env.example` และค่า local ที่จำเป็นโดยรักษาค่าเดิมที่มีอยู่:

```dotenv
VITE_API_BASE_URL=http://localhost:4000
VITE_DATA_MODE=api
```

ตัวแปร `VITE_*` สองตัวนี้เป็น **สัญญาที่ให้สร้างในงาน integration** ยังไม่มีตัวเชื่อม API ที่อ่านมันในหน้าบ้านเดิม กำหนดให้ base URL เป็น origin ไม่รวม `/api/v1` แล้วให้ client เติม prefix เพียงครั้งเดียว `/health` และ `/ready` อยู่ที่ root ของ server

ตรวจ `http://localhost:4000/health`, `/ready` และ `/docs/` ให้เข้าถึงได้ CORS ต้องตรง frontend origin จริง หากเปลี่ยน port ให้แก้ทั้ง CORS และ `FRONTEND_URL` ห้ามใส่ database/SMTP/provider secrets ในตัวแปร `VITE_*`

## 4. โครงสร้าง client ที่ให้เพิ่ม

เลือกต่อยอดโครงสร้างเดิม ใช้ native `fetch` ได้ ไม่จำเป็นต้องเพิ่ม state library ทั้งชุด ตัวอย่างไฟล์ต่อไปนี้เป็น **ข้อเสนอให้สร้าง** ไม่ใช่ไฟล์ที่มีแล้ว:

| ไฟล์/ส่วนงาน                                                    | หน้าที่                                                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/api/client.ts`                                           | Base URL, JSON/error envelope, Authorization, abort, status/header handling, single-flight refresh |
| `src/api/contracts.ts`                                        | Request/response DTO ที่ตรงกับ server แยกจาก UI model เดิม                                             |
| `src/api/auth.ts`, `catalog.ts`, `commerce.ts`, `wellness.ts` | ฟังก์ชันเรียก endpoint ตามโดเมนและชนิดข้อมูล                                                              |
| `src/api/mappers.ts`                                          | UUID, เงิน, รูป, order snapshots และ mapping ที่ยังจำเป็นต่อ UI เดิม                                       |
| Auth provider/hooks                                           | สถานะ session, current user, role และการล้างข้อมูลข้ามบัญชี                                              |
| Resource hooks/state                                          | Loading/error/pagination/invalidation แยกตาม resource และเจ้าของข้อมูล                                |

ข้อกำหนดของ client:

- JSON success ใช้ `{ data }`; list บางรายการมี `{ data, page: { limit, offset, total } }` แต่ไม่ใช่ทุก list
- Error เก็บ `error.code`, `message`, `details` และ `requestId` ใช้ข้อความไทยใน UI โดยไม่ทิ้ง machine-readable code
- รองรับ HTTP 200/201/202 ตาม endpoint; CSV และรูปเป็น bytes ไม่ใช่ JSON envelope
- ส่ง multipart `FormData` โดยให้ browser กำหนด boundary เอง
- ใช้ abort และ account/session generation เพื่อไม่ให้ response เก่าทับข้อมูลหน้าหรือบัญชีใหม่
- อ่าน `Retry-After` เมื่อ 429; อย่าทำ refresh loop หรือ retry POST ทุกตัวโดยอัตโนมัติ
- API ขัดข้องต้องแสดง error/retry ห้าม fallback ไปข้อมูล seed หรือ localStorage แล้วแจ้งว่าสำเร็จ
- หลัง mutation ให้ refetch/invalidate resource ที่เกี่ยวข้องตามผล server ไม่แก้หลายสำเนาของ global state แบบเดิมโดยถือว่าถูกต้องแล้ว

## 5. จุดที่ต้องแก้ก่อนเริ่มเชื่อมแต่ละหน้า

### 5.1 เปลี่ยน synchronous actions ให้ครบทั้งผู้เรียก

หน้าบ้านปัจจุบันใช้ `createStoreActions` และหลายฟอร์มเรียก `if (saveX(...))` หรืออ่าน `checkout(...).length` แบบ synchronous การเปลี่ยนเฉพาะ action ให้คืน Promise จะทำให้เงื่อนไขเข้า success ทั้งที่ API ยังไม่ตอบ

- ไล่แก้ทุก call site ให้ `await` ผลจริง ใช้สถานะ pending และ error ที่ชัดเจน
- ปิดปุ่มส่งซ้ำระหว่างงาน และเก็บค่าฟอร์มไว้เมื่อเกิด error
- Toast, ปิด modal, navigate และล้างตะกร้า ทำหลัง operation สำเร็จตาม API เท่านั้น
- เมื่องานล้มเหลว ห้ามมี local order, local stock deduction, coupon use หรือ notification ที่เหมือนสำเร็จค้างอยู่

### 5.2 ถอด demo authority ออกจาก API mode

`state.users`, `state.currentUserId`, local password hashes, role toolbar และ `setRole` ของ demo ไม่ใช่สิทธิ์จริง ให้ใช้ `/auth/me` และผล server ทุกครั้ง ปิดปุ่มสลับเป็น admin/seller และ reset demo ใน API mode

หากยังเก็บ demo mode เพื่ออ้างอิง ให้แยกด้วย configuration อย่างชัดเจน ห้าม API error สลับเข้า demo เอง ห้ามส่งทั้ง `State` ไป backend หรือดาวน์โหลด users/orders ของทุกบัญชีเพื่อเลียนแบบ global state เดิม

### 5.3 แยกข้อมูล local ที่ยังใช้ได้

Guest cart, UI preferences และข้อมูลฟอร์มชั่วคราวสามารถอยู่ใน browser ได้ แต่รายการซื้อ สต็อก คูปอง รีวิว ผู้ใช้ และ wellness ที่ login แล้วต้องมาจาก API เก็บ demo data เดิมแยกไว้และไม่ import อัตโนมัติ Backend ไม่มี endpoint นำเข้า browser state ทั้งก้อน

## 6. สมาชิกและ session

เชื่อม register/login/logout/logout-all/profile/change-password/change-email/forgot-password/reset-password/verify/resend ให้ครบ ไม่จบเฉพาะ login form

- ใช้ opaque bearer tokens ตาม server ห้าม decode เป็น JWT หรือคำนวณ role จาก token
- **ค่าเริ่มต้นของงานนี้ให้ access/refresh token อยู่ใน memory** หน้า reload จึงต้อง login ใหม่ และต้องแสดงพฤติกรรมนี้ตรงตามจริง อย่าคงปุ่ม Remember me ที่ยังไม่ทำงาน
- ใช้ `expiresIn` ประกอบการ refresh และมี refresh Promise เดียวต่อ session ให้คำขอพร้อมกันรอผลชุดเดียวกัน
- Refresh เปลี่ยนทั้ง access และ refresh token เก่าถูกใช้ต่อไม่ได้ เมื่อ refresh ล้มเหลวให้ clear session และพากลับ login
- คำขอที่กลับมา 401 ด้วย access token รุ่นเก่าต้องตรวจ token generation ก่อนตัดสินใจ refresh ซ้ำ จำกัดการ retry เพื่อไม่วนไม่จบ
- แท็บใหม่ใช้ session ของตัวเอง ไม่คัดลอก refresh token ข้ามแท็บเอง หากอนาคตต้องแชร์ session ต้องมีการประสาน refresh ข้ามแท็บก่อน
- หลัง logout/account switch ให้ยกเลิก request ค้าง ล้าง cart/order/profile/health caches และ revoke private object URLs
- เปลี่ยนรหัสผ่าน/อีเมลสำเร็จแล้ว server เพิกถอน session และให้ `signInRequired: true` ให้กลับ login ห้ามเก็บ user เดิมไว้เสมือนยัง login
- รอ refresh ที่กำลังทำให้จบก่อนเริ่มเปลี่ยนข้อมูลสำคัญ หากคำขอนี้ได้ `401 INVALID_SESSION` ให้ login ใหม่ ไม่ replay password payload อัตโนมัติ
- การอนุมัติร้านต้อง refetch `/auth/me` และ `/me/shop` แยกกัน public user DTO ไม่มีข้อมูลร้านครบเหมือน local demo

การทำ persistent login ด้วย HttpOnly cookies/BFF เป็นการเปลี่ยน auth architecture เพิ่มเติม ไม่ใช่สิ่งที่ backend นี้มีอยู่แล้ว หากมี requirement เพิ่มภายหลังให้แยกออกแบบและทดสอบอย่างชัดเจน

### ลิงก์ reset/verify ต้องใช้งานจากอีเมลได้จริง

Backend สร้าง URL ดังนี้:

```text
http://localhost:5173/reset-password#token=<single-use-token>
http://localhost:5173/verify-email#token=<single-use-token>
```

React เดิมใช้ hash navigation ให้ตรวจ `location.pathname` สำหรับสองหน้านี้ **ก่อน**ส่ง hash เข้า parser ของหน้า buyer มิฉะนั้น `#token=...` จะถูกตีความเป็นหน้าปกติและ token อาจหาย

อ่าน token จาก fragment ส่งเป็น JSON body ไป endpoint ที่ตรงกัน เก็บไว้ใน memory เฉพาะการทำรายการ ล้าง fragment โดยไม่ทำ token หายก่อนใช้งาน รองรับ token หมดอายุ/ใช้แล้ว/ผิดรูปแบบ ห้าม log token หรือเปลี่ยนเป็น API query parameter เมื่อจัด hosting ให้ SPA fallback รองรับสอง pathname นี้ด้วย

Local mail จะปรากฏใน `var/mail` ตามงานเบื้องหลัง เปิดไฟล์ส่วนตัวนั้นเพื่อทดสอบลิงก์ได้ ไม่ต้องเพิ่ม public endpoint อ่าน mail/token

## 7. ลำดับการเชื่อมฟังก์ชันทั้งหมด

| ลำดับ | งาน                                                           | ผลที่ต้องเห็นก่อนผ่าน                                                                    |
| ---- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1    | Client, DTO, auth, protected views                            | Login ใช้ server; demo role เปลี่ยนสิทธิ์ไม่ได้; refresh/logout/account switch ถูกต้อง       |
| 2    | หน้าแรก สินค้า ร้าน หมวดหมู่ ค้นหา settings บทความสาธารณะ            | โหลดจาก API พร้อม pagination/filter/loading/empty/error                             |
| 3    | โปรไฟล์ ที่อยู่ ใบสมัครร้าน Wishlist ตะกร้า                           | เก็บในฐานข้อมูลแยกบัญชี และ guest cart merge ถูกต้อง                                      |
| 4    | Quote, checkout, proof, order history/tracking/receipt/review | ซื้อหลายร้านด้วยราคาจาก server; retry ไม่สร้างคำสั่งซื้อซ้ำ                                   |
| 5    | Seller Center                                                 | จัดการร้าน/สินค้า/รูป/สต็อก/คำสั่งซื้อ/รีวิว/โปรโมชัน/รายงานเฉพาะร้านตนเอง                       |
| 6    | Admin                                                         | สมาชิก อนุมัติร้าน สินค้า หมวดหมู่ คำสั่งซื้อ หลักฐาน คืนเงิน โปรโมชัน CMS settings audit และ usage |
| 7    | Wellness ส่วนตัวและ CMS                                         | บันทึกอาหาร/ออกกำลัง/profile/bookmark/export/delete ใช้ API; snapshot เดิมยังถูกต้อง       |
| 8    | Browser journeys และ responsive                               | ผ่าน checklist รวม error/concurrency/privacy และทุกขนาดจอที่กำหนด                      |

ชื่อ route และ field รายละเอียดอยู่ใน `docs/FRONTEND_INTEGRATION_PLAN.md` และ API guides อย่าสร้าง REST path ตามชื่อปุ่มเอง

### สั่งซื้อและชำระเงิน: เปลี่ยน flow เดิมให้ใช้ server

1. Guest cart เก็บเฉพาะ UUID สินค้าจาก API และจำนวน เมื่อ login ใช้ `/me/cart/merge` และแสดงรายการที่ปรับจำนวน/ไม่รับเข้า ล้าง guest copy หลังยืนยันสำเร็จ
2. อ่านตะกร้า server และเรียก `POST /checkout/quote` ด้วย `couponCode` เพื่อแสดงยอด ไม่มีการส่งยอดเงินคำนวณเองเป็น authority
3. เลือก UUID ที่อยู่ที่บันทึกจริง แล้ว `POST /checkout` ด้วย `addressId`, `couponCode`, `paymentMethod: "transfer"` และ `Idempotency-Key`
4. สร้าง key หนึ่งครั้งต่อการยืนยันรายการและ body ชุดเดิม เก็บ key ระหว่าง retry เมื่อ timeout/response หาย ห้ามสร้าง key ใหม่ทุก retry
5. ใช้ order UUID และ totals ที่ server คืนให้ แสดงเลข `number` เป็นเลขอ้างอิง คำสั่งซื้อหลายร้านมีหลาย order ใน checkout เดียว
6. Upload รูป `kind=proof` แล้วส่ง `POST /orders/:id/payment-proof` ด้วย `{ "uploadId": "UUID" }` ให้ order ที่ต้องชำระ การแนบ proof ID ตอน checkout เป็นทางเลือกที่ API มีอยู่ แต่ไม่ควรบังคับใช้ flow local data URL เดิม
7. Admin ตรวจหลักฐาน ผู้ซื้อเห็นผล/เหตุผลและส่งใหม่ได้ ดูประวัติด้วย `GET /orders/:id/payment-proofs` เฉพาะ buyer/admin
8. Refetch สถานะหลังทุก action และเมื่อเปิดหน้ารายการใหม่ จัด polling/refetch ตามความจำเป็นโดยไม่เกิน rate limit

ประเด็นที่ต้องรองรับ:

- Cart PUT เป็นการ **ตั้งจำนวนรวม** ไม่ใช่เพิ่มจำนวนซ้ำตามจำนวนครั้งที่ส่ง
- Guest-cart merge เป็น POST ที่เพิ่มข้อมูลเข้าตะกร้า และไม่มี checkout idempotency contract ถ้าผลตอบกลับหายให้ refetch ตรวจตะกร้าก่อนจัดการต่อ ห้าม replay merge อัตโนมัติจนจำนวนเพิ่มซ้ำ
- `paymentDueAt` มาจาก server ออเดอร์ที่หมดเวลาถูกยกเลิกและคืนสต็อกครั้งเดียว ถ้าได้ `PAYMENT_RESERVATION_EXPIRED` ให้ refetch แล้วแสดงผลจริง
- คำสั่งซื้อรอตรวจหลักฐานไม่ถูกหมดอายุแบบ unpaid หลักฐานที่ถูกปฏิเสธจะได้ deadline ใหม่
- `no_charge` เป็นค่าที่ server เลือกเมื่อยอดสุดท้ายเป็นศูนย์ ห้ามส่งค่านี้เป็น checkout input หรือบังคับแนบหลักฐานให้ออเดอร์นั้น
- แยก `paymentStatus` และ `status` ของ fulfilment ไม่ตั้ง paid ใน browser เอง
- Prepare/ship/receive/cancel/shipment correction ใช้ action endpoint ที่มี ไม่เปิด dropdown เปลี่ยน status อิสระ
- Late transfer และ refund เป็นการบันทึกโดย admin ตามเงื่อนไข ไม่ใช่การโอนเงินจริงจาก API
- Review ต้องซื้อและรับสินค้าแล้ว ใช้ server eligibility/error ไม่ปลดสิทธิ์ด้วย client-only flags

### ข้อมูลและไฟล์

- เงิน API ใช้สตางค์จำนวนเต็ม `*Cents`; แสดงบาทหลังหาร 100 และแปลง input ทศนิยมอย่างแน่นอนก่อนส่ง
- IDs ทุก resource เป็น UUID ใช้ `number` แสดงหมายเลขออเดอร์ อย่าใช้ demo IDs หรือหมายเลขแสดงผลเป็น API ID
- `freeShippingAtCents: null` หมายถึงไม่มีเกณฑ์ส่งฟรี ไม่ใช่เติมค่า demo 999 บาท
- PATCH ส่งเฉพาะ field ที่แก้ อย่ากรอก default ให้ field ที่ผู้ใช้ไม่ได้เปลี่ยน
- Upload ส่ง file bytes แบบ multipart แล้วบันทึก upload ID; data URL ใช้เป็น preview ชั่วคราวเท่านั้น
- รูปสาธารณะใช้ URL ได้ รูปส่วนตัว fetch พร้อม Authorization → Blob → object URL และ revoke เมื่อเลิกใช้
- DELETE upload ทั้ง 200/202 หมายถึงเอา upload ID ออกจากการใช้งานแล้ว `fileRemovalPending` บอกการทำความสะอาดไฟล์ใน server ไม่ใช่ให้ client สั่งลบซ้ำไม่สิ้นสุด
- เก็บ product atlas ของหน้าบ้านไว้สำหรับ `imageIndex` ที่ seed ส่งมา ไม่สร้างรูปหลักฐานหรือรูปสินค้าใหม่เพื่อแทนข้อผิดพลาดโหลดรูป

### รายงานและ wellness

- รายงานใช้ยอด server และตัวกรองวันที่ Asia/Bangkok ห้ามรวมเฉพาะหน้า pagination แล้วแสดงเป็นยอดทั้งหมด
- รองรับ CSV download และ `Content-Disposition`; เมื่อเจอ `REPORT_TOO_LARGE` ให้ลดช่วง/ตัวกรอง และเมื่อเจอ `REPORT_TOTAL_TOO_LARGE` ให้ลดขอบเขตหรือใช้ CSV ราย order ภายในขีดจำกัดที่มี
- Wellness มี state/localStorage แยกจาก commerce ต้องเชื่อม `Wellness.tsx` และ `wellnessState.ts` ด้วย ไม่จบแค่ StoreProvider
- ใช้ชื่ออาหาร แคลอรี และ exercise snapshot ที่ server บันทึกไว้ อย่าย้อนคำนวณประวัติด้วย catalog ปัจจุบัน
- ส่งวันที่ `YYYY-MM-DD` และ weekStart ตาม contract หลีกเลี่ยงการแปลง UTC จนวันเปลี่ยน
- ใช้ filter-discovery endpoints และ server totals สำหรับบทความ/อาหาร/diary ไม่สร้างค่าจากหน้าแรกของผลลัพธ์เท่านั้น
- ข้อมูลสุขภาพส่วนตัว bookmark export และ delete ต้องเป็นของบัญชีปัจจุบันเท่านั้น

## 8. ทดสอบและเงื่อนไขส่งมอบ

ดำเนินงานตาม [INTEGRATION_ACCEPTANCE.md](docs/INTEGRATION_ACCEPTANCE.md) พร้อมหลักฐานจาก server ที่กำลังรันจริง Existing frontend tests เป็น domain/local-state tests จึงใช้แทน browser integration ไม่ได้

ให้เพิ่ม tests ที่จับความเสี่ยงจริง เช่น refresh พร้อมกัน, async form failure, DTO เงิน, idempotency retry, private image, data isolation และ browser journeys อย่าเปลี่ยน assertion ให้ผ่านด้วยการย้ายปัญหากลับไป mock/local state

Responsive อย่างน้อย 360/390/430 px, tablet 768/820/1024 px และ desktop 1280/1440 px ตรวจหน้าร้าน product modal cart checkout account seller/admin tables และ wellness ทั้งข้อมูลปกติ ข้อความไทยยาว loading/error/empty

หลังแก้เสร็จรัน backend typecheck/test/build และ frontend test/build รวม browser test script ที่เพิ่มเอง หากแตะ API/schema ให้ regenerate OpenAPI และทดสอบ PostgreSQL ตามความเสี่ยงด้วย

ส่งมอบ:

- Source frontend ที่เชื่อมแล้ว และ backend หากมีการแก้จริง พร้อม lockfile/environment ตัวอย่าง ไม่มี credentials จริง
- README วิธีเปิดสองบริการ ค่าที่ต้องตั้ง และ token/reload behavior ที่เลือกใช้
- `docs/INTEGRATION_REPORT.md` ระบุฟังก์ชันที่ต่อแล้ว ไฟล์ที่เปลี่ยน คำสั่งที่รัน ผลที่เห็น และสิ่งที่ยังติดข้อจำกัดจริง
- หลักฐาน browser journeys/responsive ที่ไม่เปิดเผย password/token/ข้อมูลส่วนตัว
- รายการเปลี่ยน API/migration หากมี และวิธีอัปเกรดฐานข้อมูลเดิม

งานถือว่าครบเมื่อผู้ใช้ทำ flow ลูกค้า ผู้ขาย แอดมิน และ wellness จาก UI ได้จริง ข้อมูลอยู่ในฐานข้อมูล server และอ่านกลับได้หลังเริ่ม process ใหม่ สิทธิ์/ราคา/สต็อกยึด server ไม่มีปุ่มที่ยังทำเพียง local mutation ใน API mode และไม่มีการอ้างว่าบริการภายนอกหรือ deployment สำเร็จทั้งที่ยังไม่ได้เชื่อม

ให้เริ่มจากสำรวจ source และ baseline แล้วลงมือทำตามลำดับด้านบนจนจบ ใช้ดุลยพินิจแก้รายละเอียด implementation ที่จำเป็น ไม่หยุดเพียงเขียนแผน และถามผู้ใช้เฉพาะเมื่อขาด source/ข้อมูลที่จำเป็นจริงและไม่มีใน workspace
