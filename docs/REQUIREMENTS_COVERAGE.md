# Requirement coverage — backend 1.2.0

ขอบเขตอ้างอิงคำอธิบายระบบและ Context Diagram ของผู้ใช้ รูปสีชมพูเป็นแนวทางหน้าตาเท่านั้น เอกสารนี้จับคู่กับ API และ source ที่ทำแล้ว โดยยังไม่เชื่อม React และไม่เชื่อมบริการภายนอก

API ด้านล่างใช้ prefix `/api/v1` ยกเว้น `/health` และ `/ready` รายละเอียด payload อยู่ใน `openapi.json` และคู่มือของแต่ละโมดูล

รุ่นนี้มี 165 operations บน 123 paths และ 37 ตาราง application ใน 6 migrations `API_INDEX.md` สร้างจาก OpenAPI โดย `npm run openapi` รายการไฟล์ทดสอบในตารางเป็นจุดตรวจพฤติกรรม; จำนวนและผลการรันจริงของแต่ละ engine ให้ยึด `VERIFICATION.md`

## สมาชิกทั่วไป

| Requirement                  | API / พฤติกรรมที่มี                                                                                                                 | หลักฐานทดสอบ                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| สมัคร เข้าสู่ระบบ ออกจากระบบ     | `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/logout-all`; session ที่เพิกถอนใช้ต่อไม่ได้                                    | `auth.test.ts`, `auth-lifecycle.test.ts`                |
| แก้ข้อมูลส่วนตัว เปลี่ยนรหัสผ่าน      | `/me/profile`, `/me/change-password`, `/me/change-email`; ตรวจ session ปัจจุบันก่อน commit การเปลี่ยนอีเมล/รหัสผ่าน และไม่รับสิทธิ์จาก client | `auth.test.ts`, `auth-races.test.ts`, `uploads.test.ts` |
| ลืมรหัสผ่าน / ยืนยันอีเมล          | คิวอีเมลที่ประมวลผลอัตโนมัติและ token ใช้ครั้งเดียว; มีอายุและเพิกถอน sessions                                                                | `auth.test.ts`, `mail.test.ts`, `background.test.ts`    |
| ดูทุกหมวด ค้นหาและรายละเอียดสินค้า | `/categories`, `/products`, `/products/:id`, `/shops`; แสดงเฉพาะรายการที่เปิดขายได้                                                 | `catalog.test.ts`                                       |
| ตะกร้า ที่อยู่และ Wishlist        | `/me/cart`, `/me/cart/merge`, `/me/addresses`, `/me/wishlist`; ข้อมูลแยกบัญชีและไม่รับการบันทึกสินค้าที่ไม่เป็นสาธารณะ                        | `commerce.test.ts`                                      |
| สั่งซื้อและชำระเงิน               | `/checkout/quote`, `/checkout`, `/orders/:id/payment-proof`; ราคาจริงจาก server, คำสั่งซื้อแยกร้าน, หลักฐานตรวจโดย admin               | `commerce.test.ts`                                      |
| ตรวจประวัติหลักฐานชำระเงิน       | `GET /orders/:id/payment-proofs`; แบ่งหน้าและคงหลักฐานเดิมหลังส่งใหม่ เฉพาะผู้ซื้อ/แอดมิน                                                   | `commerce.test.ts`                                      |
| สถานะ ประวัติและติดตามพัสดุ       | `/me/orders`, `/orders/:id`, `/orders/:id/tracking`, `/orders/:id/receipt`; ข้อมูลย้อนหลังเป็น snapshot                              | `commerce.test.ts`                                      |
| ยกเลิกและยืนยันรับสินค้า           | `/orders/:id/cancel`, `/orders/:id/receive`; คืนสต็อกครั้งเดียวตามสถานะ                                                              | `commerce.test.ts`                                      |
| รีวิวและคะแนน                  | `/products/:id/reviews`, `/me/reviews`; ต้องซื้อและได้รับแล้ว รีวิวสาธารณะต้องอิงสินค้าที่ยังแสดงสาธารณะได้                                     | `commerce.test.ts`                                      |

## สมาชิกผู้ขาย

| Requirement                     | API / พฤติกรรมที่มี                                                                                                            | หลักฐานทดสอบ                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| ผู้ใช้ทั่วไปสมัครเปิดร้าน               | `/me/shop`; ตรวจข้อมูลครบถ้วนก่อนส่งคำขอ                                                                                        | `catalog.test.ts`                     |
| ชื่อและรายละเอียดร้าน               | `/me/shop` GET/PATCH; ค่าจัดส่งและเงื่อนไขส่งฟรี                                                                                  | `catalog.test.ts`                     |
| รอ admin อนุมัติ / ส่งใหม่เมื่อถูกปฏิเสธ | `/me/shop/resubmit`; ผู้ขายเข้าถึงงานขายเมื่อมีสิทธิ์ที่ server อนุมัติแล้ว                                                                | `catalog.test.ts`                     |
| เพิ่ม แก้ไข ลบสินค้า                 | `/seller/products`; การลบเป็น archive เพื่อรักษาประวัติ                                                                          | `catalog.test.ts`                     |
| รูป ราคาและจำนวนสินค้า             | `/uploads?kind=product`, `/seller/products/:id/stock`, `/seller/stock-movements`; ตรวจเจ้าของและไม่ให้ stock ติดลบ             | `catalog.test.ts`, `uploads.test.ts`  |
| รายการสั่งซื้อของร้าน                | `/seller/orders`; ไม่เห็นคำสั่งซื้อร้านอื่น                                                                                         | `commerce.test.ts`                    |
| อัปเดตสถานะและพัสดุ                | `/orders/:id/prepare`, `/orders/:id/ship`, `/orders/:id/shipment`; การแก้เลขพัสดุเก็บเหตุผลและประวัติ                             | `commerce.test.ts`                    |
| ยอดขาย รายได้และประวัติขาย         | `/seller/reports/sales`, CSV และ `/seller/orders`; แยกสถานะการเงิน ยอดรวมที่เกิน safe integer ตอบ `422 REPORT_TOTAL_TOO_LARGE` | `commerce.test.ts`                    |
| ใช้งานซื้อสินค้าต่อได้                 | ผู้ขายใช้ buyer endpoints ของบัญชีตนเองได้ตามปกติ                                                                                 | `commerce.test.ts`, `catalog.test.ts` |

## Admin และข้อมูลใน Context Diagram

| Requirement             | API / พฤติกรรมที่มี                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| จัดการสมาชิกและผู้ขาย       | `/admin/users`, `/admin/shops`; บล็อกสมาชิก เพิกถอน sessions ระงับร้านและเปิดคืนอย่างชัดเจน                                      |
| ตรวจและอนุมัติร้าน          | `/admin/shops/:id/decision`, `/admin/shops/:id/status`                                                                  |
| จัดการสินค้าและหมวดหมู่      | `/admin/products`, `/admin/categories`; ป้องกันการลบหมวดที่ยังมีข้อมูลอ้างอิง                                                     |
| ตรวจคำสั่งซื้อและหลักฐานชำระ | `/admin/orders`, payment review และ `/orders/:id/payment-proofs`; หลักฐาน เหตุผลตรวจ และเลขอ้างอิงการเงินจำกัดสิทธิ์ buyer/admin |
| รายงานยอดขายและรายได้    | `/admin/reports/sales`, CSV และตัวกรองช่วงวัน Asia/Bangkok                                                                 |
| โปรโมชั่นร้านค้าและเว็บไซต์   | `/seller/promotions`, `/admin/promotions`; quota/cap/ขั้นต่ำตรวจโดย server                                                 |
| รีวิว                     | `/admin/reviews`, moderation และ seller reply                                                                           |
| จัดการเว็บไซต์และสถิติ       | `/admin/settings`, `/admin/usage`, `/admin/audit-events`; รายงานเกินขอบเขตแจ้งให้ลดช่วงเวลา ไม่ตัดรายการเงียบ ๆ                |
| บทความสุขภาพ             | `/articles`, `/articles/filters`, `/me/article-bookmarks`, `/admin/articles`; ไม่เผย draft ผ่าน public/filter/bookmark    |
| อาหารและแคลอรี           | `/foods`, `/foods/groups`, `/admin/foods`, `/me/meal-diary`; ยอดรวมตรงกับรายการย่อยและเก็บ snapshot                        |
| ตารางอาหาร              | `/meal-templates`, admin templates และ personal template application                                                    |
| ตารางออกกำลังกาย         | `/exercise-templates`, admin templates และ personal week/activity APIs                                                  |
| ข้อมูลสุขภาพส่วนตัว          | health profile, export และ delete เฉพาะเจ้าของ; ไม่มีการเพิ่มการวินิจฉัยหรือ AI จากภาพธีม                                         |

โมดูล catalog, commerce และ wellness มี HTTP tests กับฐานข้อมูล SQL จริง ตรวจรายละเอียดผลการรันและ engine ใน `VERIFICATION.md` รายการ endpoint เต็มอยู่ใน `API_INDEX.md`

## ส่วนที่เติมจากการตรวจรอบ 1.2.0

| พฤติกรรมที่เติม/แก้                                                                     | Source / API                                                                                     | จุดตรวจพฤติกรรม                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| อีเมลและ maintenance อัตโนมัติ ใช้ฐานเดียวกับ API และใช้ได้ใน local PGlite                  | `core/background.ts`, `core/maintenance.ts`; ค่าเริ่มต้นเปิด รอบอีเมล 10 วินาที/maintenance 60 วินาที      | `background.test.ts`                        |
| ไม่เปิดงานซ้อน ตรวจ readiness ก่อนทำงาน และหยุดรับงานพร้อมรอรายการปัจจุบันเมื่อปิด server       | `server.ts`, `core/background.ts`; SIGINT/SIGTERM drain                                          | `background.test.ts`                        |
| ป้องกัน worker เก่าเขียนทับผลใหม่ และไม่ส่งครั้งที่หกหลัง mail lease ครั้งที่ห้าหมดอายุ               | `core/mail.ts`; claim generation, terminal failed และล้างเนื้อหาอีเมล                                | `mail.test.ts`                              |
| ป้องกันการเปลี่ยนอีเมล/รหัสผ่านจาก request ที่ token ถูก logout/rotate/revoke ระหว่างดำเนินการ | `modules/auth.ts`; ตรวจ token และ identity ภายใน write transaction                               | `auth-races.test.ts`                        |
| ลบ metadata/สร้างคิว/audit พร้อมกัน แล้ว retry ลบไฟล์ได้ข้าม restart                       | migration 006, `core/upload-cleanup.ts`, `DELETE /uploads/:id`; 200 หรือ 202 `fileRemovalPending` | `upload-cleanup.test.ts`, `uploads.test.ts` |
| ดูประวัติหลักฐานเดิมและผลตรวจอย่างแบ่งหน้า โดย seller ของร้านไม่เห็นข้อมูลการเงินลูกค้า            | `GET /orders/:id/payment-proofs`; seller ที่เป็น buyer ของ order ยังเข้าถึงได้                          | `commerce.test.ts`                          |
| กติการีวิวสาธารณะ/Wishlist ตรงกับ product detail โดย stock ศูนย์ยังเปิดดูได้                 | `modules/commerce.ts`; สินค้า draft/archive หมวดปิด ร้านระงับหรือเจ้าของถูกบล็อกตอบ 404                   | `commerce.test.ts`                          |
| ไม่คืนยอดรายงานที่ปัดผิดเพราะจำนวนเกิน safe integer                                       | `commerce-domain.ts`; `422 REPORT_TOTAL_TOO_LARGE` พร้อมทางเลือก CSV ราย order ภายใน limit เดิม     | `commerce.test.ts`                          |
| ตั้ง proxy ที่เชื่อถือด้วย IP/CIDR ชัดเจน ค่าเริ่มต้นไม่เชื่อ forwarded headers                    | `TRUST_PROXY_CIDRS`; ไม่รับ wildcard, `/0`, hostname หรือ hop count                                 | `proxy.test.ts`                             |

Fixture อัปเกรดฐานข้อมูลเดิมที่มีข้อมูลเลือก PostgreSQL เมื่อกำหนด `TEST_DATABASE_URL` เช่นเดียวกับ API fixtures แล้ว ส่วน test ที่ตรวจ PGlite โดยเฉพาะยังใช้ PGlite ดูผลจริงใน `VERIFICATION.md` การอัปเกรดจาก 1.1.0 ใช้ migration 006 และจาก 1.0.0 ใช้ 005+006 ผ่าน `npm run db:migrate` โดยไม่ reset/seed ทับ และไม่แก้ migrations 001–005

## ส่วนที่เติมจากการตรวจรอบ 1.1.0

- กำหนดอายุการจอง stock ของคำสั่งซื้อที่ยังไม่ส่งหลักฐาน และคืน stock อัตโนมัติอย่างปลอดภัยเมื่อหมดเวลา
- รองรับยอดชำระ 0 โดยไม่เรียกให้ผู้ใช้โอนเงิน; ไม่สร้างภาระคืนเงินจากยอดศูนย์
- แก้พัสดุที่ส่งแล้วพร้อม audit; บันทึกการตรวจพบเงินโอนหลังยกเลิกเพื่อเข้าสู่ขั้นคืนเงินโดยไม่เปิด order กลับ
- ค้นหาสินค้า ร้าน สมาชิกและบทความด้วยตัวอักษรพิเศษตามจริง; ตัวกรองบทความ/อาหารครอบคลุมข้อมูลทุกหน้า
- เพิ่มการค้นหาในบทความที่บันทึกไว้ และทำให้แคลอรีรวม/รายการ/การส่งออกใช้หลักการปัดเลขเดียวกัน
- ป้องกันการใช้ email เก่าระหว่าง login ที่กำลังทำงาน, กำหนดอายุ access token ไม่เกิน session, และป้องกัน cache ของข้อมูลบัญชี/ส่วนตัว
- ตรวจ migration ก่อนรายงาน readiness และให้เจ้าของร้านดูรูป draft ที่ admin ใส่ให้ได้โดยไม่เปิดไฟล์สู่สาธารณะ

## ขั้นที่ยังอยู่นอกงานส่งมอบนี้

React integration, live payment gateway/bank verification, live courier tracking, external SMTP account configuration, hosted PostgreSQL, object storage, DNS/TLS and deployment. คู่มือและจุดเชื่อมต่อเตรียมไว้แล้ว แต่ไม่มีการอ้างว่าบริการเหล่านี้เชื่อมและทดสอบสำเร็จ

ไม่มี social login, face analysis, AI chat, fashion หรือ medical recommendation ใน requirement ที่ตกลง จึงไม่เพิ่มฟังก์ชันจากรูปธีมเข้าไปในระบบ
