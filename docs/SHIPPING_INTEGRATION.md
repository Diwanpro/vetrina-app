# ربط شركات التوصيل — المخطط المنفّذ (P1 + P2)

الاستراتيجية المزدوجة (الخيار ج): **API مباشر** + **تصدير CSV بالجملة**.
هذا المستند يصف ما طُبّق في P1/P2 فقط؛ P3 (محوّل Yalidine) وP4 (ZR + التصدير) وP5 (الويبهوك/الشارات) وP6 (استيراد التتبّع) لاحقة.

## قرار ملزم
**لا يوجد أي تعديل على جدول `public.orders`.** الجداول الجديدة تحمل `order_id` كـ FOREIGN KEY فقط. حالة الطلب تبقى بيد `update_order_status` و`order_status_history`.

## 1) قاعدة البيانات — `supabase/migrations/202611120015_shipping_integrations.sql`

| الجدول | الدور |
|---|---|
| `shipping_connections` | إعدادات الربط لكل فرع/شركة/بيئة، وفيه `credentials_ciphertext` (مشفّر) و`credentials_hint` (مقنّع) |
| `shipments` | طرد واحد لكل طلب لكل شركة؛ `status` قانوني، `tracking_number`, `label_url`, `cod_amount`, `idempotency_key` |
| `shipment_events` | أحداث التتبّع/الويبهوك مع `event_key` فريد لمنع التكرار |
| `shipping_export_batches` + `shipping_export_items` | تسجيل دفعات CSV لمنع رفع الطلب مرتين |
| `shipping_territories` | ذاكرة مطابقة الولايات/البلديات لكل شركة |

- **RLS مقصود (لا اعتماد على مسح `011`)**: `shipping_connections` بلا أي سياسة لـ `authenticated` ⇒ لا يصل إليه إلا `service_role` ودوال `SECURITY DEFINER`. بقية الجداول: `GRANT SELECT` مع سياسة `tenant_id = current_tenant_id()`، والكتابة من السيرفر فقط.
- القراءة المقنّعة عبر `engine_list_shipping_connections(uuid)` و`engine_list_shipments(uuid)`؛ كلاهما `REVOKE ... FROM anon` و`GRANT EXECUTE TO authenticated`.
- قيود: `UNIQUE(store_id, provider_code, environment)`، فهرس جزئي `shipments_active_per_order` يمنع شحنتين نشطتين، فهرس `shipments_idempotency`، تحقق من `provider_code` بالشكل لا بالتعداد ⇒ إضافة شركة لاحقاً بلا migration.
- `cod_amount = orders.total`، ولا تُضاف رسوم التوصيل مرتين (قاعدة `202611120007`).

## 2) تشفير المفاتيح — `lib/shipping/credentials.js`

- `AES-256-GCM` (iv 12 بايت، tag 16 بايت)، مفتاح 32 بايت من `SHIPPING_MASTER_KEY` بترميز base64 أو hex.
- المغلف `{v, iv, tag, data}` يُخزّن كنص في `credentials_ciphertext`.
- **AAD** = `vetrina:shipping:v1:<tenant>:<store>:<provider>:<env>` عبر `connectionAad()` ⇒ نسخ الصف إلى فرع/بيئة أخرى يفشل فك تشفيره.
- `decryptCredentials()` يفشل مغلقاً عند أي عبث ولا يُسرّب النص المشفّر ولا خطأ crypto.
- `credentialHint()` يُنتج `•••• 4AF2` فقط؛ لا تُعاد المفاتيح للمتصفح أبداً.

## 3) البوابة — Next.js Route Handlers (Node runtime)

| المسار | الوظيفة |
|---|---|
| `GET /api/shipping/connections?storeId=` | قائمة مقنّعة عبر `engine_list_shipping_connections` |
| `POST /api/shipping/connections` | حفظ/تحديث اتصال (تشفير قبل الكتابة) |
| `DELETE /api/shipping/connections` | تعطيل ومسح المفتاح (احتفاظ بسجل التدقيق) |
| `POST /api/shipping/test` | `اختبار الاتصال` |

سلسلة الصلاحيات في `lib/shipping/index.js`:
`Bearer JWT` → `auth.getUser()` → `engine_session` → دور `owner|manager` → الفرع ضمن `ctx.stores` → `engine_staff(p_store, p_tenant)` (يتحقق أيضاً من الاشتراك) → عميل `service_role` للكتابة.
الاستجابة تُعيد الحقول المقنّعة فقط، و`errorResponse()` لا يُسرّب أخطاء SQL/driver.

**اختبار الاتصال في P2**: يتحقق محلياً من صحة الحقول، ثم — إن ضُبط `SHIPPING_<CODE>_<ENV>_BASE_URL` — يُجري `GET` على جذر العنوان بترويسات الشركة مع مهلة 8 ثوانٍ، ويصنّف `AUTH_FAILED / RATE_LIMITED / NETWORK_ERROR / PROVIDER_ERROR`. إن لم يُضبط العنوان يُعيد نتيجة `mode: 'local'` برسالة صريحة. في P3 يستبدل `adapter.testConnection()` هذا الفحص بنقطة الـ API الرسمية بعد فتح Sandbox.

## 4) الواجهة — تبويب `carriers`

`app/dashboard/_screens/settings.js` → تبويب **«ربط شركات التوصيل»** بجانب «أسعار التوصيل»، يستضيف `components/dashboard/ShippingSettings.js`:
- بطاقة لكل شركة: Yalidine، ZR Express (Procolis)، ZR Express (المنصة الجديدة).
- بيئة `Sandbox | Production`، استراتيجية `api | bulk | both`، ولاية الانطلاق (إلزامية لـ Yalidine)، نوع التسليم، تفعيل/شحن تلقائي.
- حقول المفاتيح `type=password`؛ بعد الحفظ تظهر `credentials_hint` فقط مع خيار «إدخال مفاتيح جديدة».
- أزرار: **حفظ الإعدادات** · **اختبار الاتصال** (يعمل أيضاً بالمفاتيح المحفوظة بعد إعادة التحميل عبر فك التشفير سيرفرياً) · **تعطيل ومسح المفاتيح**.
- الوصول للمالك/المدير فقط، ويتطلب فرعاً محدداً واتصالاً بالإنترنت (نمط `exportData` في نفس الشاشة).

## 5) القابلية للتوسّع

`lib/shipping/contract.js` (المفردات القانونية) + `lib/shipping/registry.js` (بيانات الشركات، تحقق الحقول، قالب الترويسات، `capabilities`).
الواجهة والـ Route Handlers لا تعرفان شيئاً عن شركة بعينها: تمرّران `provider_code` فقط. إضافة شركة = ملف محوّل في `lib/shipping/providers/` + سطر في الـ registry + (اختياري) قالب CSV؛ **بلا migration جديدة**.

## 6) متغيّرات البيئة (`.env.example`)

`SHIPPING_MASTER_KEY` و`SUPABASE_SERVICE_ROLE_KEY` سيرفرية فقط. لا تستخدم `NEXT_PUBLIC_` لهما، ولا ترفع قيمهما إلى Git. عناوين `SHIPPING_<CODE>_<ENV>_BASE_URL` اختيارية لمرحلة P2.

## 7) الاختبارات

`tests/shipping-credentials.test.mjs` (التشفير/العبث/AAD/القناع)، `tests/shipping-registry.test.mjs` (عقد الشركات/بناء الفحص)، `tests/shipping-migration.test.mjs` (RLS، عدم لمس `orders`، RPC المقنّعة)، و`tests/shipping.integration.sql` لفحص العزل على مشروع Supabase حي.

## 8) حالة التنفيذ (P1/P2)

- الـ migration `202611120015` **مطبّقة فعلياً** على مشروع Supabase المتصل (`Diwanpro's Project`) عبر `create_migration`، وفُحصت حيّةً: 6 جداول، RLS مفعّل على 6/6، `shipping_connections` بلا أي سياسة، 5 سياسات قراءة، دالتان مقنّعتان، و`orders` ما زال بـ 27 عموداً دون تغيير.
- `next build` نجح (مع محاكاة خط Tajawal بسبب حظر الشبكة عن Google Fonts في بيئة الاختبار)، وكل اختبارات `node --test` خضراء بعد `npm install`.
- **قبل P3** يجب ضبط `SHIPPING_MASTER_KEY` و`SUPABASE_SERVICE_ROLE_KEY` كمتغيّرات سيرفرية في بيئة النشر (Vercel) — لم تُضبط هنا حتى لا يُنشأ سرّ دون موافقة صريحة. عناوين `SHIPPING_<CODE>_<ENV>_BASE_URL` اختيارية.
