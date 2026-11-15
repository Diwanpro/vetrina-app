# ربط شركات التوصيل — المخطط المنفّذ (P1 + P2 + P3)

الاستراتيجية المزدوجة (الخيار ج): **API مباشر** + **تصدير CSV بالجملة**.
يصف هذا المستند ما طُبّق في P1/P2/P3. ما زال لاحقاً: P4 (محوّلا ZR + تصدير CSV بـ BOM)، P5 (شارات/تتبّع موسّع)، P6 (استيراد ملفات التتبّع).
P3 يعمل الآن بـ **Mock Fetch** محلي حتمي لأن مفاتيح Sandbox غير متوفرة؛ عند وصول المفاتيح الحقيقية يكفي تبديل `SHIPPING_MOCK_MODE=false` دون إعادة كتابة المحوّل.

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
- **P3**: `supabase/migrations/202611120016_shipping_order_snapshot.sql` يضيف الدالة القرائية فقط `engine_order_shipping_snapshot(uuid)` (`STABLE SECURITY DEFINER`) كي يقرأ السيرفر لقطة الطلب + `order_items` بعد التحقق من المستأجر والفرع. لا `ALTER/UPDATE/INSERT/DELETE` ولا سياسة ولا ترِغر على `public.orders`.

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
| `POST /api/shipping/test` | `اختبار الاتصال` (P3: عبر `adapter.testConnection()` عند توفر محوّل) |
| `GET /api/shipping/shipments?storeId=` | شحنات الفرع عبر `engine_list_shipments` |
| `POST /api/shipping/shipments` | **شحن الطلب**: إنشاء الطرد وتسجيله في `shipments` + `shipment_events` |
| `POST /api/shipping/shipments/:id/sync` | سحب الحالة (`getTracking`) وإضافة الأحداث بلا تكرار |
| `GET /api/shipping/shipments/:id/label?storeId=` | رابط الملصق/البوردورو |
| `DELETE /api/shipping/shipments/:id` | إلغاء الطرد وتحديث الشحنة إلى `cancelled` |
| `POST /api/shipping/webhooks/:provider` | ويبهوك موقّع بـ HMAC-SHA256 على **الجسم الخام بالضبط** |

سلسلة الصلاحيات في `lib/shipping/index.js`:
`Bearer JWT` → `auth.getUser()` → `engine_session` → دور `owner|manager` → الفرع ضمن `ctx.stores` → `engine_staff(p_store, p_tenant)` (يتحقق أيضاً من الاشتراك) → عميل `service_role` للكتابة.
الاستجابة تُعيد الحقول المقنّعة فقط، و`errorResponse()` لا يُسرّب أخطاء SQL/driver.

**اختبار الاتصال**: إن وُجد محوّل (`getAdapter(code).capabilities.test`) يستدعي `adapter.testConnection()`؛ هذا هو مسار Yalidine في P3 ويعمل الآن على المحاكي. للشركات التي بلا محوّل بعد يبقى سلوك P2: تحقق محلي + `GET` اختياري على جذر `SHIPPING_<CODE>_<ENV>_BASE_URL` مع تصنيف `AUTH_FAILED / RATE_LIMITED / NETWORK_ERROR / PROVIDER_ERROR`، أو `mode: 'local'` إن لم يُضبط العنوان.

## 4) الواجهة — تبويب `carriers`

`app/dashboard/_screens/settings.js` → تبويب **«ربط شركات التوصيل»** بجانب «أسعار التوصيل»، يستضيف `components/dashboard/ShippingSettings.js`:
- بطاقة لكل شركة: Yalidine، ZR Express (Procolis)، ZR Express (المنصة الجديدة).
- بيئة `Sandbox | Production`، استراتيجية `api | bulk | both`، ولاية الانطلاق (إلزامية لـ Yalidine)، نوع التسليم، تفعيل/شحن تلقائي.
- حقول المفاتيح `type=password`؛ بعد الحفظ تظهر `credentials_hint` فقط مع خيار «إدخال مفاتيح جديدة».
- أزرار: **حفظ الإعدادات** · **اختبار الاتصال** (يعمل أيضاً بالمفاتيح المحفوظة بعد إعادة التحميل عبر فك التشفير سيرفرياً) · **تعطيل ومسح المفاتيح**.
- الوصول للمالك/المدير فقط، ويتطلب فرعاً محدداً واتصالاً بالإنترنت (نمط `exportData` في نفس الشاشة).

**P3 في شاشة الطلبات**: زر **«شحن الطلب»** داخل `OrderCard` (`components/dashboard/ShippingButton.js`) يظهر لطلبات التوصيل بعد التأكيد/التحضير فقط. يكتشف روابط الشحن المفعّلة من `/api/shipping/connections` ويمرّر `provider_code` + `environment` إلى البوابة؛ عند تعدد الروابط يظهر اختيار عام من `registry.capabilities` لا يحوي شرطاً باسم شركة. بعد النجاح يظهر رقم التتبّع ورابط الملصق، وتُقرأ الشحنات من `/api/shipping/shipments`. **لا يكتب الزر في `orders` إطلاقاً**.

**القوائم المنسدلة**: حُوّلت آخر 5 قوائم `<select>` أصلية (4 في إعدادات الشحن + مقاس الإطلالة) إلى `CustomSelect` / `SearchableSelect`. كل القوائم — بما فيها `CustomerPicker` و`LowStockBell` واختيار شركة الشحن — تعتمد الآن حركة **«الدرج المنزلق»** نفسها في `app/globals.css` (`vetrina-drawer-open` / `vetrina-drawer-close`): تنزل اللائحة من أسفل الزر وتنطوي للخلف عند الإغلاق، مع `prefers-reduced-motion` وخلفية داكنة موحّدة. القوائم تعمل عبر portal لتفادي قصّها داخل الحاويات القابلة للتمرير.

## 5) القابلية للتوسّع

`lib/shipping/contract.js` (المفردات القانونية) + `lib/shipping/registry.js` (بيانات الشركات، تحقق الحقول، قالب الترويسات، `capabilities`) + `lib/shipping/adapters.js` (سجل المحوّلات السيرفري).
الواجهة والـ Route Handlers لا تعرفان شيئاً عن شركة بعينها: تمرّران `provider_code` فقط. إضافة شركة = ملف محوّل في `lib/shipping/providers/` + سطر في الـ registry + سطر في `adapters.js` + (اختياري) قالب CSV؛ **بلا migration جديدة ولا تفريع في الواجهة**.

محوّل P3 `lib/shipping/providers/yalidine.js` يعزل كل خصوصيات يليدين: `X-API-ID/X-API-TOKEN`، أسماء الولايات اللاتينية، بناء حمولة الطرد، تحويل الحالات، التتبّع/الملصق/الإلغاء/سحب الحالات/المناطق، وتوقيع الويبهوك. `lib/shipping/transport.js` يختار بين `mockFetch` والـ API الحي بمتغيّر واحد، و`lib/shipping/mock.js` يوفّر بيانات وهمية حتمية بلا شبكة. منصتا ZR (`zrexpress` Procolis و`zrexpressnew`) بقيتا في الـ registry كما طُلب؛ محوّلاهما في P4.

## 6) متغيّرات البيئة (`.env.example`)

`SHIPPING_MASTER_KEY` و`SUPABASE_SERVICE_ROLE_KEY` و`SHIPPING_YALIDINE_WEBHOOK_SECRET` سيرفرية فقط. لا تستخدم `NEXT_PUBLIC_` لها، ولا ترفع قيمها إلى Git. `SHIPPING_MOCK_MODE=true` يُبقي P3 على البيانات الوهمية؛ `false` + المفاتيح المحفوظة + `SHIPPING_<CODE>_<ENV>_BASE_URL` الاختياري يحوّل المحوّل نفسه إلى API الشركة. القيم الحساسة مضبوطة بالفعل في Vercel كـ `sensitive` لكل بيئات `production/preview/development`.

## 7) الاختبارات

`tests/shipping-credentials.test.mjs` (التشفير/العبث/AAD/القناع)، `tests/shipping-registry.test.mjs` (عقد الشركات/قدرات P3/بناء الفحص)، `tests/shipping-migration.test.mjs` (RLS، عدم لمس `orders`، RPC المقنّعة ولقطة P3)، `tests/shipping-yalidine.test.mjs` (Mock Fetch كاملاً + الحالات + الويبهوك + تصنيف أخطاء HTTP)، `tests/shipping-p3-gateway.test.mjs` (شحن/مزامنة/ويبهوك/إلغاء عبر عميل Supabase وهمي مع تأكيد عدم كتابة `orders`)، و`tests/shipping.integration.sql` لفحص العزل على مشروع Supabase حي.

## 8) حالة التنفيذ (P1/P2/P3)

- `202611120015` **مطبّقة فعلياً** على مشروع Supabase المتصل (`Diwanpro's Project`): 6 جداول، RLS مفعّل على 6/6، `shipping_connections` بلا أي سياسة، 5 سياسات قراءة، دالتان مقنّعتان.
- `202611120016` **مطبّقة فعلياً** باسم `shipping_order_snapshot_p3`; فُحصت حيّةً: دالة `engine_order_shipping_snapshot` موجودة و`SECURITY DEFINER`، `anon` لا يملك `EXECUTE` بينما `authenticated`/`service_role` يملكانه، و`public.orders` ما زال بـ **27 عموداً** دون أي تعديل.
- متغيّرات Vercel السيرفرية مضبوطة لكل `production/preview/development`: `SHIPPING_MASTER_KEY` و`SUPABASE_SERVICE_ROLE_KEY` و`SHIPPING_YALIDINE_WEBHOOK_SECRET` كقيم `sensitive`، و`SHIPPING_MOCK_MODE=true`. لا تُعرض القيم في هذا المستند ولا في Git.
- `next build` نجح بعد P3 (مع محاكاة خط Tajawal بسبب حظر الشبكة عن Google Fonts في بيئة الاختبار)؛ كل مسارات `/api/shipping/*` و`/dashboard/orders` و`/dashboard/settings` ظهرت في مخرجات البناء.
- الاختبارات الكاملة `445/445` خضراء بعد P3، ومنها اختبارا `shipping-yalidine` و`shipping-p3-gateway`؛ تجميع كل migrations عبر `pglast` نجح أيضاً.
- ZR Express بمنصّتيه (`zrexpress` Procolis و`zrexpressnew`) بقي كما هو في الـ registry، بلا محوّل حي بعد. تصدير CSV بـ UTF-8 BOM عبر `csvText()` واستيراد ملفات التتبّع مؤجّلان إلى P4/P6 حسب الموافقة.
- **غير مُعتمد حيّاً بعد**: لا توجد مفاتيح Sandbox رسمية، لذلك أسماء الحقول/العناوين/التوقيع في محوّل Yalidine مبنية على مراجع مجتمعية ويجب مطابقتها مع وثائق الشركة الرسمية قبل تشغيل `SHIPPING_MOCK_MODE=false` في الإنتاج.
