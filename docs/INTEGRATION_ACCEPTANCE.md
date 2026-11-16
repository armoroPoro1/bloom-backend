# เกณฑ์ตรวจรับ React + Node server สำหรับ Claude

เอกสารนี้เป็น **แผนทดสอบหลังทำ integration** ทุกกรณีด้านล่างยังมีสถานะ **รอทดสอบ** การมี checklist หรือผลเทส backend อยู่แล้วไม่ได้แปลว่า React เชื่อมสำเร็จ

ใช้ร่วมกับ [แผนเชื่อมหน้าบ้าน](FRONTEND_INTEGRATION_PLAN.md), [สัญญาสมาชิกและไฟล์](AUTH_AND_FILES.md), [สัญญาซื้อขาย](COMMERCE_API.md), [สัญญาสุขภาพ/CMS](WELLNESS_API.md) และ `openapi.json` ของ Node server รุ่น 1.2.0 ขอบเขตยึดคำอธิบายเดิมและ Context Diagram โดยคงหน้าตาสีชมพูและการใช้งานเดิม

## 1. เตรียมข้อมูลและบันทึก baseline

ก่อนเริ่ม ให้บันทึก commit ของ frontend/backend หรือ checksum ของ ZIP ที่ใช้ พร้อม Node version, คำสั่งติดตั้ง/รัน, database driver, origin ของแต่ละแอป และนโยบาย session แบบ memory-only ที่ใช้ใน integration รอบแรก ข้อมูลอ้างอิงหน้าบ้านเดิมคือ commit `563a659eee0e25cdb8b1a21516345b2fcccea05d` หากไฟล์ที่รับมามีการเปลี่ยนแล้ว ให้ตรวจของจริงและรักษาการเปลี่ยนแปลงนั้น

เตรียมบัญชีทดสอบอย่างน้อยผู้ซื้อ A/B, ผู้ขายร้าน A/B, ผู้สมัครเปิดร้านที่ยังไม่อนุมัติ และแอดมิน ใช้รหัสผ่านที่ผู้รันทดสอบกำหนดเอง และใช้ภาพสินค้าหรือภาพหลักฐานสังเคราะห์ ไม่มีการโอนเงินจริงในการตรวจรับนี้

ใช้ฐานข้อมูลทดสอบแยกจากข้อมูลใช้งานจริง เตรียมสินค้าอย่างน้อยสองร้าน รายการสต็อกน้อย สินค้าหมดสต็อก สินค้าไม่เผยแพร่ หมวดหมู่ปิด ร้านถูกระงับ คูปองระดับร้าน/เว็บไซต์ บทความ draft/published อาหารและ template ที่แก้ย้อนหลังได้ เคสออเดอร์หมดอายุและยอดศูนย์ให้เตรียมด้วย fixture ในฐานทดสอบ ไม่เพิ่ม public endpoint สำหรับปลอมสิทธิ์หรือข้ามกฎระบบ

คำสั่งที่มีอยู่จริงใน Node server:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run openapi
```

การเปิดฐานใหม่และรัน API ให้ทำตาม `README.md`: ตั้ง environment, รัน `npm run db:migrate`, ตั้ง `SEED_DEMO_PASSWORD` ก่อน `npm run db:seed` สำหรับข้อมูลสาธิต แล้ว `npm run dev` การอัปเกรดฐานเดิมใช้ migration และรักษาข้อมูลเดิม เมื่อใช้ PGlite ให้หยุด API ก่อนเปิดคำสั่ง migration/seed เป็นอีกโปรเซสที่ใช้โฟลเดอร์ฐานเดียวกัน

คำสั่งที่มีอยู่จริงใน React frontend เดิม:

```sh
npm ci
npm test
npm run build
npm run dev
```

Frontend เดิมไม่มี script ชื่อ `typecheck` หรือ `test:e2e`; `build` เรียก TypeScript อยู่แล้ว ส่วน `npm test` เดิมเป็น Node tests ของ local/domain logic หากเพิ่ม browser integration tests ให้เพิ่มคำสั่งที่รันได้จริงและระบุวิธีรันไว้ในรายงาน แยกผล local/domain tests ออกจากผล browser ที่เรียก Node API จริงเสมอ

## 2. ระบบเริ่มต้นและขอบเขตข้อมูล

| ID     | กรณีที่ต้องทดสอบ                                  | เกณฑ์ผ่าน                                                                                                    |
| ------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| SET-01 | เปิด frontend และ API จาก environment ที่บันทึกไว้  | `/health` และ `/ready` พร้อมใช้งาน; request ไปยัง API origin ถูกต้อง ไม่มี `/api/v1` ซ้ำ ไม่มี CORS error            |
| SET-02 | เปิดหน้าร้านโดยไม่มีบัญชี                            | สินค้า หมวดหมู่ ร้าน บทความ และตั้งค่าเว็บไซต์มาจาก API; loading/empty/error แยกกันและไม่มีการสร้างคำสั่งซื้อจาก local state |
| SET-03 | หยุด API ขณะใช้งาน                              | แสดง network/server error พร้อม retry ที่เหมาะสม; ไม่สลับไปสร้างบัญชีหรือออเดอร์จำลอง และไม่ประกาศบันทึกสำเร็จ           |
| SET-04 | เปิดเบราว์เซอร์ที่มีข้อมูล localStorage รุ่นเดิม         | ข้อมูลเดิมไม่ถูกส่งเข้า API หรือเขียนทับฐานจริงโดยอัตโนมัติ; legacy IDs, roles และ password hashes ไม่กลายเป็นตัวตนที่เชื่อถือได้ |
| SET-05 | Reload / Back / Forward / เปิดลิงก์สินค้าและออเดอร์ | ใช้ UUID ของ server ในการโหลดข้อมูล รักษาบริบทร้าน/หน้า dashboard และแสดง not found/access failure ถูกต้อง          |
| SET-06 | ทดสอบ role switch และการส่ง request เอง        | API mode ใช้สิทธิ์จาก server; การเปลี่ยนค่าใน browser หรือเรียก URL ของอีก role ไม่ทำให้เข้าถึงข้อมูลได้                    |

## 3. สมาชิก Session และการแยกบัญชี

ค่าเริ่มต้นของงานนี้เก็บทั้ง access token และ refresh token ใน memory ของแท็บเดียว Reload หรือเปิดแท็บใหม่ต้อง login ใหม่ แต่ข้อมูลธุรกิจยังอยู่บน server; ไม่มี Remember me ที่แสร้งว่าสามารถกู้ session ได้ และไม่เก็บ token ใน localStorage/sessionStorage ถ้าภายหลังต้องการ persistent login ให้แยกการออกแบบและทดสอบ โดย cookie/BFF ยังไม่มีใน API ชุดนี้

| ID      | กรณีที่ต้องทดสอบ                                                       | เกณฑ์ผ่าน                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-01 | สมัครบัญชีใหม่ → login → แก้โปรไฟล์ → reload                             | ข้อมูลบันทึกในฐานจริง; reload แล้วต้อง login ใหม่ตาม memory-only policy และอ่านข้อมูลเดิมกลับได้หลัง login โดยไม่มี private state ของ session เก่าค้าง                                                                             |
| AUTH-02 | ส่งข้อมูลผิด รหัสผ่านผิด อีเมลซ้ำ หรือ fields เกิน schema                     | แสดง validation/conflict ตาม API โดยไม่ปิด form หรือสูญค่าที่แก้ได้; ไม่แสดง success toast                                                                                                                                |
| AUTH-03 | หลาย request พบ access token หมดอายุพร้อมกัน                          | ภายใน session เดียวใช้ refresh ที่ประสานกันหนึ่งครั้ง อัปเดต token คู่ใหม่พร้อมกันและไม่เกิด refresh loop; refresh ล้มเหลวต้องจบ session                                                                                           |
| AUTH-04 | สองแท็บทำงานพร้อมกัน                                                  | แต่ละแท็บ login เป็น session อิสระและไม่แชร์ refresh token; logout ของแท็บหนึ่งจบเฉพาะ session นั้น ส่วน logout-all ทำให้ request ถัดไปของทุก session ถูกปฏิเสธ หากออกแบบ shared tokens ภายหลังต้องเพิ่มการประสาน rotation ระหว่างแท็บ |
| AUTH-05 | logout / logout-all → เข้าด้วยอีกบัญชี ขณะมี request หรือภาพส่วนตัวกำลังโหลด | ยกเลิก/ทิ้งผลของ request จากบัญชีเก่า ล้าง private cache และ object URLs; cart, orders, profile, health records ไม่ข้ามบัญชี                                                                                               |
| AUTH-06 | เปลี่ยนอีเมลหรือรหัสผ่านสำเร็จ                                            | จัดการ `signInRequired: true`, ล้าง session และพา login ใหม่; ไม่ใช้ข้อมูล token เก่าต่อ                                                                                                                                 |
| AUTH-07 | เปลี่ยนข้อมูลสำคัญชนกับ refresh/logout/block                             | รอ refresh ที่กำลังทำอยู่ก่อนส่ง; เมื่อได้ `401 INVALID_SESSION` ไม่แสดงสำเร็จและไม่ replay password payload แบบอัตโนมัติ                                                                                                       |
| AUTH-08 | แอดมิน block บัญชีที่กำลังเปิดหลายหน้า                                     | request ถัดไปถูกปฏิเสธและ UI ออกจาก protected state; cache เก่าไม่เปิดทางให้สั่งซื้อหรือแก้ข้อมูล                                                                                                                              |
| AUTH-09 | ลืมรหัสผ่านและยืนยันอีเมลจาก local mail file                             | เปิด `/reset-password#token=...` และ `/verify-email#token=...` ได้จริง แยก pathname จาก hash navigation เดิม; ส่ง token ใน JSON body และจัดการหมดอายุ/ใช้ซ้ำ โดยไม่บันทึก token ลง log                                      |
| AUTH-10 | จำกัดคำขอหรือ CORS origin ไม่ตรง                                      | UI แสดง `429`/retry หรือ configuration failure ตามจริง ไม่ตีความเป็นข้อมูลว่าง; ใช้ `Retry-After` และ request ID ได้เมื่อมี                                                                                                  |

ลิงก์ recovery ของ backend ใช้ pathname ร่วมกับ fragment token ขณะที่หน้าบ้านเดิมใช้ hash เป็น page route ต้องตรวจการเข้าตรงลิงก์และการ reload ทั้งบน dev server และรูปแบบ hosting ที่เลือก ไม่ปล่อยให้ hash parser ส่งผู้ใช้กลับหน้าหลักและทิ้ง token เงียบ ๆ

## 4. สินค้า ตะกร้า ที่อยู่ และราคา

| ID     | กรณีที่ต้องทดสอบ                                                       | เกณฑ์ผ่าน                                                                                                        |
| ------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| BUY-01 | ค้นหา กรองหมวดหมู่/ร้าน เรียงลำดับ และเปลี่ยนหน้า                           | request ใช้ตัวกรองของ API และ pagination ถูกต้อง; request เก่าที่กลับช้ากว่าไม่เขียนทับหน้าล่าสุด                              |
| BUY-02 | สินค้าถูก archive หมวดหมู่ปิด ร้านระงับ หรือเจ้าของถูก block                  | หน้ารายละเอียด รีวิวสาธารณะ และการเพิ่ม Wishlist ปฏิบัติตาม API; ไม่มี fallback แสดงรายการปิดขายจาก seed                   |
| BUY-03 | สินค้ายังเผยแพร่แต่สต็อกเป็นศูนย์                                           | อ่านรายละเอียด/รีวิวและบันทึก Wishlist ได้ตามสิทธิ์ แต่สั่งซื้อเกินสต็อกไม่ได้; UI ไม่ซ่อนสินค้าด้วยกฎที่ขัดกับ server                     |
| BUY-04 | เพิ่ม/ลด/ลบสินค้าใน cart รวมการกดเร็วซ้ำ                                 | `PUT /me/cart/:productId` ส่งจำนวนใหม่แบบ absolute; UI ตรงกับ server หลังตอบกลับ ไม่มีการเพิ่มจำนวนซ้ำจาก retry          |
| BUY-05 | Guest มี cart → login เข้าบัญชีที่มี cart อยู่                              | merge เพียงครั้งต่อชุดที่ยืนยันแล้ว ล้าง guest copy หลังสำเร็จเท่านั้น; แสดงสินค้าที่ข้ามหรือจำนวนที่ถูกปรับตาม response                 |
| BUY-06 | เพิ่ม แก้ไข เลือก default และลบที่อยู่                                     | ที่อยู่เป็นของบัญชีปัจจุบัน default เปลี่ยนตาม server; checkout ใช้ address UUID และประวัติออเดอร์เก่าไม่เปลี่ยนตามการแก้ที่อยู่        |
| BUY-07 | ราคา/ส่วนลด/ค่าจัดส่งมีทศนิยมสองตำแหน่ง                                   | แปลง baht ↔ integer satang อย่างกำหนดแน่นอน เช่น 390 บาท ↔ `39000`; ราคารวมจาก server ไม่คำนวณซ้ำจนเกิดความคลาดเคลื่อน |
| BUY-08 | ส่งฟรีเป็น `null`, coupon cap/use limit เป็น `null`, PATCH ละบาง field | ไม่แทน null ด้วยค่า demo หรือส่ง 0 ที่ผิดความหมาย; omitted fields ไม่ถูกค่า default ของ form เขียนทับ                       |
| BUY-09 | คูปองร้านเดียว/ทั้งเว็บไซต์ ขั้นต่ำ cap วันเริ่ม/สิ้นสุด                           | quote ที่แสดงตรงผลของ API ต่อร้าน; วันใช้ `YYYY-MM-DD` และ Asia/Bangkok; coupon `percent: 10` หมายถึง 10%             |

## 5. สั่งซื้อ ชำระเงิน และประวัติ

เส้นทางหลักที่ต้องผ่านใน browser คือ **ผู้ซื้อสร้างออเดอร์สองร้าน → ส่งหลักฐาน → แอดมินปฏิเสธ → ผู้ซื้อส่งใหม่ → แอดมินอนุมัติ → ผู้ขายเตรียม/ส่ง → ผู้ซื้อรับสินค้า → รีวิว** โดยเปิดคนละ browser context สำหรับแต่ละบัญชี

| ID     | กรณีที่ต้องทดสอบ                                          | เกณฑ์ผ่าน                                                                                                             |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| ORD-01 | Checkout cart ที่มีสินค้าสองร้าน                            | ได้ checkout เดียวและออเดอร์แยกร้านตาม server; UUID/เลขแสดงผล `number` ใช้ถูกหน้าที่; สต็อก/คูปองถูกใช้เพียงครั้งเดียว               |
| ORD-02 | กดสั่งซื้อซ้ำหรือ response หายหลัง server commit             | retry body เดิมด้วย `Idempotency-Key` เดิมและได้ checkout เดิม ไม่สร้างคีย์ใหม่เพียงเพราะ network timeout                      |
| ORD-03 | ใช้ key เดิมแต่เปลี่ยน body / บัญชี / ที่อยู่                    | จัดการ conflict ตาม API ไม่ผูกคำสั่งซื้อผิดบัญชี; การทำ checkout ใหม่ต้องเป็นการยืนยันใหม่ของผู้ใช้                                    |
| ORD-04 | สต็อก ราคา ร้าน หรือคูปองเปลี่ยนหลัง quote                   | checkout เชื่อผล server; เมื่อไม่สำเร็จ refetch/ให้ผู้ใช้ทบทวน ไม่ฝืนใช้ยอดหรือ availability จาก quote เก่า                        |
| ORD-05 | ผู้ซื้อสองคนแย่ง stock ที่เหลือน้อย                            | จำนวน order ที่สำเร็จไม่เกิน stock; ผู้แพ้ได้รับข้อความและ cart ที่ตรวจใหม่ ไม่มี local success order                               |
| ORD-06 | โอนเงินแบบยังไม่มีหลักฐาน → ส่งหลักฐานก่อนกำหนด               | เริ่ม `unpaid` พร้อม `paymentDueAt`; ส่งสำเร็จเป็น `awaiting_review` และใช้สถานะจาก server โดยยังไม่แสดงว่าธนาคารยืนยันเงินแล้ว   |
| ORD-07 | ปฏิเสธหลักฐานพร้อมเหตุผล → ส่งใหม่ → อนุมัติ                   | แสดงเหตุผลให้ buyer/admin และ deadline ใหม่; ประวัติหลักฐานเดิมยังอ่านได้ ส่วน seller ที่ไม่ใช่ buyer ไม่เห็นรูป/เหตุผลส่วนตัว           |
| ORD-08 | หลักฐานเป็นของอีกบัญชีหรือไม่ใช่ชนิด proof                     | API ปฏิเสธและ UI คงข้อมูลออเดอร์จริง; ไม่ใช้ data URL หรือ upload ID ที่คัดลอกจากบัญชีอื่น                                         |
| ORD-09 | Reservation หมดอายุระหว่างเปิดหน้า/ส่งหลักฐาน               | Refetch เมื่อได้ `PAYMENT_RESERVATION_EXPIRED`; แสดง cancelled และ stock คืนครั้งเดียว ไม่สร้าง proof หรือ checkout ใหม่เงียบ ๆ |
| ORD-10 | ออเดอร์ awaiting review หรือจ่ายแล้วผ่านเวลาเดิม            | ไม่ถูก client countdown เปลี่ยนเป็น cancelled; การหมดอายุยึด server และสถานะนั้นไม่มี deadline ที่ UI แต่งขึ้น                      |
| ORD-11 | ยอดรวมสุดท้ายเป็นศูนย์ รวม checkout ที่บางร้านยังต้องจ่าย        | รองรับ server-selected `no_charge` ต่อออเดอร์ ไม่ส่งค่านี้เป็นตัวเลือก checkout; ซ่อนขั้นตอนโอน/หลักฐานสำหรับยอดศูนย์                 |
| ORD-12 | Buyer ยกเลิก pending / admin ยกเลิกสถานะที่อนุญาต          | ปุ่มตรงสิทธิ์และสถานะ; cancel ซ้ำไม่คืน stock ซ้ำ; กรณี paid แยก refund obligation และการบันทึกคืนเงินจริงภายนอก                   |
| ORD-13 | Admin บันทึกเงินเข้าหลังยกเลิกและบันทึกคืนเงิน                  | ออเดอร์ยัง cancelled ไม่มีการจอง stock ใหม่; มี reference ตาม schema และ UI ไม่อ้างว่า API โอนเงินจริง                         |
| ORD-14 | เตรียมสินค้า → ship → แก้เลข tracking พร้อมเหตุผล → receive | ใช้ explicit action endpoints; เห็นเหตุการณ์เดิม/ใหม่ใน timeline; buyer กดยืนยันรับตามเงื่อนไขและ seller แก้ของร้านอื่นไม่ได้        |
| ORD-15 | ประวัติ ใบเสร็จ และ notifications หลังแก้สินค้า/ที่อยู่          | แสดง snapshots ของออเดอร์เดิม, ลิงก์ไป order UUID ถูกต้อง, ใบเสร็จพิมพ์จาก JSON; tracking ระบุว่าเป็นข้อมูลที่ร้านบันทึก               |
| ORD-16 | รีวิวก่อนรับสินค้า/หลังรับ/ส่งซ้ำ/ร้านตอบ/แอดมินซ่อน               | Eligibility และ uniqueness ยึด API; rating/count อัปเดตจากผล server และไม่รวมรีวิวที่ถูกซ่อน                                 |

## 6. Seller Center และ Admin

| ID     | กรณีที่ต้องทดสอบ                                              | เกณฑ์ผ่าน                                                                                                      |
| ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| MGT-01 | ผู้ใช้สมัครร้าน → ปฏิเสธพร้อมเหตุผล → แก้ข้อมูล → resubmit → อนุมัติ    | ใช้ flow ของร้านจริง; หลังอนุมัติ refetch `/auth/me` และ `/me/shop`; ผู้ขายยังซื้อของร้านอื่นในบัญชีเดียวได้                    |
| MGT-02 | ผู้สมัคร pending และ seller ร้านถูกระงับเปิด Seller Center       | การเข้าถึง/ปุ่มตามสิทธิ์ server; ร้านระงับไม่รับยอดขายใหม่ แต่ยังจัดการงานเดิมที่ API อนุญาตได้                                  |
| MGT-03 | Seller เพิ่ม/แก้/อัปโหลดรูป/ปรับ stock/archive/restore          | Product UUID และ owner มาจาก server; restore เริ่ม inactive ตามสัญญา; stock movement ไม่ถูกเพิ่มซ้ำใน browser        |
| MGT-04 | Seller A ส่ง product/order/shop UUID ของ Seller B          | แก้หรืออ่านข้อมูลจัดการของอีกคนไม่ได้ แม้ข้ามปุ่มใน UI; buyer-only proof ยังคงเป็นส่วนตัว                                     |
| MGT-05 | Admin จัดการสินค้า หมวดหมู่ สมาชิก ร้าน โปรโมชั่น รีวิว และ settings | บันทึกผ่าน endpoint ตามบทบาทและแสดงค่าที่อ่านกลับ; unknown fields/invalid transitions มีข้อความ; audit เกิดจาก server   |
| MGT-06 | วันที่รายงานวันเดียว/ข้ามวันไทย/ตัวกรองหลายร้าน/ไม่มีข้อมูล            | รายงานใช้วันสร้าง order ตาม Asia/Bangkok และแยกยอดชำระ ส่วนลด จัดส่ง รอชำระ/คืนเงิน; empty ไม่ถูกแสดงเป็น network error |
| MGT-07 | CSV ที่มีภาษาไทย ข้อความขึ้นต้นสูตร และจำนวนเงิน                   | ชื่อไฟล์/ขอบเขต filter ถูกต้อง; ดาวน์โหลดผ่าน API ด้วย authorization และใช้ Content-Disposition เมื่อมี ไม่รวมข้อมูลเกินสิทธิ์  |
| MGT-08 | `REPORT_TOTAL_TOO_LARGE` กับ `REPORT_TOO_LARGE`            | ข้อแรกเสนอกรองแคบลงหรือ CSV รายออเดอร์ที่ไม่เกินขอบเขต; ข้อหลังต้องลดจำนวนแถว ไม่แสดงศูนย์หรือผลรวมที่ตัดทิ้งบางส่วน             |
| MGT-09 | Pagination ของสมาชิก stock และการ export                   | ใช้ pagination/total ที่ endpoint ส่งจริง และไม่เรียก CSV ของหนึ่งหน้าว่า export ทั้งฐานข้อมูล                              |

## 7. บทความ อาหาร ตาราง และข้อมูลสุขภาพ

| ID     | กรณีที่ต้องทดสอบ                                            | เกณฑ์ผ่าน                                                                                                               |
| ------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| CMS-01 | Admin สร้าง/แก้/publish/unpublish บทความ                  | Public route เห็นเฉพาะ published; ภาพบทความสัมพันธ์กับ upload ID ที่ถูกต้อง; draft ไม่หลุดผ่าน search/filter/bookmark             |
| CMS-02 | ค้นหาหลายคำและตัวอักษร `%`, `_`, backslash พร้อมกรอง/แบ่งหน้า | ตรง semantics ของ API ไม่กรองเฉพาะหน้าที่โหลดมาอีกชั้น; filter options จาก endpoints `/articles/filters` และ `/foods/groups` |
| CMS-03 | Bookmark บทความด้วยบัญชี A/B และเลิกเผยแพร่บทความ            | แยกบัญชีและแสดงเฉพาะ published ตาม server; page.total สอดคล้องตัวกรอง                                                     |
| CMS-04 | Admin จัดการ food, meal template, exercise template      | ส่ง resource/payload ที่ตรง schema; validation และรายการอ้างอิงถูกแสดง ไม่ใช้การบันทึก content ทั้งก้อนแทน API                     |
| WEL-01 | บันทึกอาหารหลายมื้อและ portions แบบทศนิยม → แก้ food ต้นฉบับ    | รายการย้อนหลังรักษาชื่อ/ปริมาณ/แคลอรี snapshot; ใช้ totalKcal/totalsByDate จาก server ไม่รวมเฉพาะหน้าปัจจุบัน                      |
| WEL-02 | Apply meal/exercise template แบบ append/replace         | ทำ mutation ครั้งเดียวแล้ว refetch ไม่ copy ซ้ำใน local state; รูปแบบ replace สอดคล้องวัน/สัปดาห์ที่เลือก                           |
| WEL-03 | ตารางออกกำลังข้ามวัน/สัปดาห์และ completion                   | ส่ง date และ Monday weekStart ถูกต้อง; completion ผูกกิจกรรมส่วนตัว ไม่แก้ต้นฉบับ template                                       |
| WEL-04 | โปรไฟล์สุขภาพ optional/blank/invalid number               | แปลง blank เป็น null/omitted ตามสัญญา; PUT เป็นข้อมูลโปรไฟล์ที่ตั้งใจส่งครบ ไม่มีการเพิ่มการวินิจฉัยหรือคำแนะนำ AI                       |
| WEL-05 | Export/delete personal wellness และสลับบัญชี               | อ่าน/ลบเฉพาะบัญชีปัจจุบัน ไม่ลบ public CMS หรือข้อมูลของอีกคน; refresh แล้วข้อมูลที่ลบไม่กลับจาก localStorage                           |
| WEL-06 | ข้อมูลสุขภาพเดิมใน browser                                  | รักษาข้อมูลเดิมไว้จนมี flow import ที่ออกแบบและอนุญาตชัดเจน ไม่อ้างว่าข้อมูลย้ายสำเร็จจากการสร้างหน้า UI                                 |

## 8. รูปภาพและการตอบกลับที่ไม่ใช่ 200

| ID      | กรณีที่ต้องทดสอบ                                   | เกณฑ์ผ่าน                                                                                                                            |
| ------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| FILE-01 | Upload product/avatar/proof/article            | ส่ง FormData ที่มี `file` หนึ่ง field และ `kind` ใน query; ไม่ตั้ง multipart Content-Type เองจน boundary หาย; รอ upload ID ก่อนบันทึก resource |
| FILE-02 | ไฟล์เกิน 1 MiB ไฟล์ผิดชนิด/เสีย หรือหลายไฟล์           | แสดง error จาก API เก็บภาพเดิมของ resource ไว้ และไม่ใช้ preview ที่ยังไม่บันทึกเป็นภาพสำเร็จ                                                   |
| FILE-03 | ภาพ product public / proof private / avatar    | Resolve relative URL กับ API origin; private images fetch ด้วย Authorization แล้วสร้าง object URL ไม่มี token ใน URL                     |
| FILE-04 | เปิด proof ด้วย buyer/admin/seller-only/อีก buyer | สิทธิ์ตรง server; seller-only และอีก buyer ไม่เห็นภาพเก่าจาก cache หลังการสลับบัญชี                                                           |
| FILE-05 | ลบ upload ที่ไม่ได้ใช้ได้ `200` หรือ `202`            | ทั้งสองเป็น deletion ที่รับแล้ว; นำ upload ID ออกจาก draft state และไม่ reattach; `fileRemovalPending` ไม่ถูกตีความว่าบันทึกล้มเหลว               |
| FILE-06 | ลบภาพที่มี reference ได้ `409 FILE_IN_USE`         | รักษาความสัมพันธ์/ภาพที่บันทึกอยู่ แสดงเหตุผลและไม่หลอกว่าลบแล้ว; historical order/proof references ได้รับการรักษา                                  |
| FILE-07 | เปลี่ยนรูป ปิด modal logout และ unmount            | revoke object URL และทิ้งผล fetch ที่หมดอายุ; ภาพส่วนตัวของบัญชีเก่าไม่ค้างใน DOM/cache                                                        |

เคส 202 สามารถใช้ fixture หรือ fault injection ใน test environment ที่ควบคุมได้ ห้ามทำให้พื้นที่ไฟล์ใช้งานจริงเสียหายเพื่อสร้างเคสทดสอบ

## 9. Responsive, navigation และสถานะ UI

ตรวจ browser ที่ viewport อย่างน้อย **360×800, 390×844, 430×932, 768×1024, 820×1180, 1024×768, 1280×800 และ 1440×900** ตัวเลขนี้เป็นเป้าหมายตรวจรับ integration และไม่ใช่คำกล่าวว่าผ่านแล้ว

หน้าที่ต้องตรวจ ได้แก่ หน้าร้าน/ค้นหา รายละเอียดสินค้า cart checkout login/register account/addresses order history/detail/proof Seller Center ตารางสินค้า/ออเดอร์ Admin/CMS และหน้าอาหาร/ออกกำลัง

- [ ] ไม่มี horizontal overflow ของทั้งหน้า; ตารางกว้างเลื่อนเฉพาะกรอบที่กำหนดได้และยังอ่านชื่อ/ปุ่ม action ได้
- [ ] Header, mobile menu, filters, pagination, modal/drawer และปุ่มปิดใช้งานได้ตามขนาดจอ
- [ ] Keyboard เปิด form บนมือถือแล้วปุ่มยืนยัน/ข้อความผิดพลาดยังเข้าถึงได้; modal เลื่อนได้เมื่อเนื้อหายาว
- [ ] Loading ไม่แสดงเป็น empty; ปุ่ม mutation ระหว่างส่งป้องกันกดซ้ำโดยไม่ทำให้ระบบค้างหลัง error
- [ ] Form validation แสดงตำแหน่งผิดและรักษาข้อมูลที่ผู้ใช้กรอก; retry ไม่ส่งซ้ำเกินเงื่อนไข idempotency
- [ ] Keyboard focus, Tab, Enter, Escape และ focus หลังปิด dialog ยังทำงาน; error/status ที่สำคัญอ่านได้ด้วย assistive technology
- [ ] Back/Forward และ deep links ไม่เปลี่ยนไปยังรายการผิดหลัง UUID mapping; notification ไปยัง order/view ที่ตรง role
- [ ] Receipt/CSV/export มีปุ่มที่ใช้ได้บนจอเล็กและแสดงขอบเขตข้อมูลตรงกับ server
- [ ] ไม่มี uncaught error, warning ที่บ่งบอก state update หลัง logout หรือ request loop ใน browser console
- [ ] ตรวจทั้งรายการมีข้อมูล ว่าง โหลดช้า สิทธิ์หมดอายุ และ network failure โดยยังรักษาธีมชมพูเดิม

## 10. หลักฐานและ Definition of Done

ให้ Claude สร้าง `docs/INTEGRATION_REPORT.md` หลังลงมือจริง โดยแยก **ผ่าน / ไม่ผ่าน / ยังไม่ได้ทดสอบ / ถูกบล็อกเพราะขาดข้อมูล** สำหรับแต่ละ ID ห้ามเติมว่า “ผ่าน” จากการอ่านโค้ดหรือจากผล backend suite เดิม

รายงานต้องมี:

1. Source commit/checksum ของทั้งสองฝั่ง, วันที่ตรวจ, runtime, driver, origins และคำสั่งที่ใช้รันจริง
2. ผลคำสั่ง backend/frontend และตำแหน่ง log พร้อมข้อจำกัด เช่นใช้ PGlite หรือ PostgreSQL และ mock เฉพาะอะไร
3. ผล connected browser journeys แยกจาก unit tests; ระบุบัญชีเป็น role/ชื่อสมมติ ขนาด viewport และขั้นตอนที่ทำซ้ำได้
4. หลักฐาน API/ข้อมูลที่ยืนยันว่า mutation บันทึกจริง เช่น UUID/สถานะที่อ่านกลับ การ reload และการเห็นผลจากอีกบัญชีที่มีสิทธิ์ โดยตัด token/password/private proof content ออกจากรายงาน
5. จุดเปลี่ยนจาก localStorage เป็น server, นโยบาย token/reload/multi-tab, สิ่งที่ยังเก็บ local ได้ และวิธีจัดการข้อมูลเดิม
6. บั๊กที่พบและแก้พร้อม regression ที่เกี่ยวข้อง รวมทั้งรายการที่ยังไม่ผ่านและวิธีทำซ้ำ
7. วิธีติดตั้ง/รันสองแอปและ configuration ที่ต้องตั้งจริง; ไม่มี credentials, `.env` จริง, local database หรือ private uploads ในไฟล์ส่งมอบ

งาน integration ผ่านเมื่อ flows ตามขอบเขตใช้งานกับ API/ฐานจริงได้ครบ, ข้อมูลแยกบัญชีถูกต้อง, ไม่มีการใช้ demo state เป็น authority, private files/เงิน/สต็อกตรง server, responsive ผ่านตาม viewport ที่ระบุ และมีหลักฐานการตรวจที่ผู้อื่นทำซ้ำได้

การเรียก endpoint สำเร็จเพียงหนึ่งรายการ การผ่าน `npm run build` หรือการมี screenshots ของหน้าเว็บอย่างเดียวไม่เพียงพอสำหรับยืนยัน integration ทั้งระบบ ส่วน payment gateway, courier, SMTP account จริง และ deployment ให้ระบุผลตามที่เชื่อมและทดสอบจริงเท่านั้น; manual proof review และ local mail files ไม่ใช่การยืนยันการโอนเงินหรือการส่งอีเมลภายนอก
