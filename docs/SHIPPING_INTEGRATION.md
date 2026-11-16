# ربط شركات التوصيل — المخطط المنفّذ (P1 + P2 + P3 + P4)

الاستراتيجية المزدوجة (الخيار ج): **الربط المباشر API** + **وضع التصدير بالجملة CSV** + **كلاهما**.
يصف هذا المستند ما طُبّق في P1/P2/P3/P4. ما زال لاحقاً: P5 (شارات/تتبّع موسّع)، P6 (استيراد ملفات التتبّع)، ثم مطابقة الوثائق الرسمية وتفعيل الـ API الحي.
P3/P4 يعملان الآن بـ **Mock Fetch** محلي حتمي لأن مفاتيح Sandbox الرسمية غير متوفرة؛ عند وصول المفاتيح والوثائق يكفي تبديل `SHIPPING_MOCK_MODE=false` وضبط عناوين API لكل شركة/بيئة دون إعادة كتابة المحوّلات.

## قرار ملزم
**لا يوجد أي تعديل على جدول `public.orders`.** الجداول الجديدة تحمل `order_id` كـ FOREIGN KEY فقط؛ حالة الطلب تبقى بيد `update_order_status` و`order_status_history`. قراءة الطلبات تتم عبر دوال `SECURITY DEFINER` قرائية فقط، والكتابة محصورة في جداول الشحن الجديدة.

## 1) قاعدة البيانات — `supabase/migrations/202611120015_shipping_integrations.sql`

| الجدول | الدور |
|---|---|
| `shipping_connections` | إعدادات الربط لكل فرع/شركة/بيئة، وفيه `credentials_ciphertext` (مشفّر) و`credentials_hint` (مقنّع) |
| `shipments` | طرد أو دفعة تصدير لكل طلب؛ `status` قانوني، `tracking_number`, `label_url`, `cod_amount`, `idempotency_key` |
| `shipment_events` | أحداث التتبّع/الويبهوك مع `event_key` فريد لمنع التكرار |
| `shipping_export_batches` + `shipping_export_items` | تسجيل دفعات CSV لمنع تصدير الطلب نفسه مرتين |
| `shipping_territories` | ذاكرة مطابقة الولايات/البلديات لكل شركة |

- **RLS مقصود (لا اعتماد على مسح `011`)**: `shipping_connections` بلا أي سياسة لـ `authenticated` ⇒ لا يصل إليه إلا `service_role` ودوال `SECURITY DEFINER`. بقية الجداول: `GRANT SELECT` مع سياسة `tenant_id = current_tenant_id()`، والكتابة من السيرفر فقط.
- القراءة المقنّعة عبر `engine_list_shipping_connections(uuid)` و`engine_list_shipments(uuid)`؛ كلاهما `REVOKE ... FROM anon` و`GRANT EXECUTE TO authenticated`.
- قيود: `UNIQUE(store_id, provider_code, environment)`، فهرس جزئي `shipments_active_per_order` يمنع شحنتين نشطتين، فهرس `shipments_idempotency`، تحقق من `provider_code` بالشكل لا بالتعداد ⇒ إضافة شركة لاحقاً بلا migration.
- `cod_amount = orders.total`، ولا تُضاف رسوم التوصيل مرتين (قاعدة `202611120007`).
- **P3**: `supabase/migrations/202611120016_shipping_order_snapshot.sql` يضيف الدالة القرائية فقط `engine_order_shipping_snapshot(uuid)` (`STABLE SECURITY DEFINER`) كي يقرأ السيرفر لقطة الطلب + `order_items` بعد التحقق من المستأجر والفرع. لا `ALTER/UPDATE/INSERT/DELETE` ولا سياسة ولا ترِغر على `public.orders`.
- **P4**: `supabase/migrations/202611120017_shipping_export_candidates.sql` يضيف:
  - `engine_shipping_export_candidates(uuid, text)`: دالة قرائية فقط (`STABLE SECURITY DEFINER`) تُعيد حتى 500 طلب `delivery` بحالة `confirmed` أو `preparing` للفرع المطلوب، وتستبعد أي طلب له شحنة نشطة (`status NOT IN ('cancelled','failed')`) أو موجود في `shipping_export_items`.
  - `shipping_export_items_order_once`: فهرس فريد `(tenant_id, order_id)` يمنع تصدير الطلب نفسه إلى أي شركة مرة ثانية، حتى مع تزامن طلبين.
  - `shipments_bulk_export_once`: فهرس فريد جزئي يمنع تكرار صف `mode='bulk', status='exported'` لنفس الطلب.
  - `REVOKE ... FROM PUBLIC, anon` و`GRANT EXECUTE TO authenticated` للدالة الجديدة؛ **لا تعديل على `public.orders`**.

## 2) تشفير المفاتيح — `lib/shipping/credentials.js`

- `AES-256-GCM` (iv 12 بايت، tag 16 بايت)، مفتاح 32 بايت من `SHIPPING_MASTER_KEY` بترميز base64 أو hex.
- المغلف `{v, iv, tag, data}` يُخزّن كنص في `credentials_ciphertext`.
- **AAD** = `vetrina:shipping:v1:<tenant>:<store>:<provider>:<env>` عبر `connectionAad()` ⇒ نسخ الصف إلى فرع/بيئة أخرى يفشل فك تشفيره.
- `decryptCredentials()` يفشل مغلقاً عند أي عبث ولا يُسرّب النص المشفّر ولا خطأ crypto.
- `credentialHint()` يُنتج `•••• 4AF2` فقط؛ لا تُعاد المفاتيح للمتصفح أبداً.
- وضع «التصدير بالجملة CSV» لا يحتاج مفاتيح إطلاقاً؛ وضع «الربط المباشر API» أو «كلاهما» يتطلب حقول كل شركة كما هي معرّفة في الـ registry.

## 3) البوابة — Next.js Route Handlers (Node runtime)

| المسار | الوظيفة |
|---|---|
| `GET /api/shipping/connections?storeId=` | قائمة مقنّعة عبر `engine_list_shipping_connections` |
| `POST /api/shipping/connections` | حفظ/تحديث اتصال (تشفير قبل الكتابة) |
| `DELETE /api/shipping/connections` | تعطيل ومسح المفتاح (احتفاظ بسجل التدقيق) |
| `POST /api/shipping/test` | `اختبار الاتصال` عبر `adapter.testConnection()` لكل محوّل، أو `BULK_MODE` لوضع CSV فقط |
| `GET /api/shipping/shipments?storeId=` | شحنات الفرع عبر `engine_list_shipments` |
| `POST /api/shipping/shipments` | **شحن الطلب**: إنشاء الطرد وتسجيله في `shipments` + `shipment_events` |
| `POST /api/shipping/shipments/:id/sync` | سحب الحالة (`getTracking`) وإضافة الأحداث بلا تكرار |
| `GET /api/shipping/shipments/:id/label?storeId=` | رابط الملصق/البوردورو |
| `DELETE /api/shipping/shipments/:id` | إلغاء الطرد وتحديث الشحنة إلى `cancelled` |
| `POST /api/shipping/webhooks/:provider` | ويبهوك موقّع بـ HMAC-SHA256 على **الجسم الخام بالضبط** |
| `POST /api/shipping/exports` | **تصدير الشحنات (CSV)**: قراءة المرشحين عبر RPC، بناء ملف BOM، وتسجيل الدفعة |

سلسلة الصلاحيات في `lib/shipping/index.js`:
`Bearer JWT` → `auth.getUser()` → `engine_session` → دور `owner|manager` → الفرع ضمن `ctx.stores` → `engine_staff(p_store, p_tenant)` (يتحقق أيضاً من الاشتراك) → عميل `service_role` للكتابة.
الاستجابة تُعيد الحقول المقنّعة فقط، و`errorResponse()` لا يُسرّب أخطاء SQL/driver.

**P4 CSV**: `lib/shipping/export.js` يستدعي `engine_shipping_export_candidates` بعميل المستخدم، يتحقق أن الربط `enabled` و`mode ∈ {bulk,both}`، يبني `ShipmentRequest` من اللقطة عبر `lib/shipping/request.js`، ثم `adapter.buildBulkRows()`، ثم **`csvText()` الموجود في `lib/access.js`** (UTF-8 BOM + حماية حقن الصيغ + CRLF) بلا أي مكتبة جديدة. يسجّل `shipping_export_batches` + `shipping_export_items` + صف `shipments` بحالة `exported` و`mode='bulk'`، ويُعيد نص CSV واسم الملف و`batchId`/`fileHash`. المتصفح ينشئ `Blob` ويُنزّل الملف، ثم يعيد تحميل الشحنات فتظهر حالة «تم التصدير» على الطلبات المعنية.

## 4) الواجهة

### إعدادات شركات التوصيل — تبويب `carriers`

`app/dashboard/_screens/settings.js` → تبويب **«ربط شركات التوصيل»** يستضيف `components/dashboard/ShippingSettings.js`:
- ثلاث بطاقات مستقلة: **يليدين (Yalidine)**، **ZR Express (Procolis)**، **ZR Express (المنصة الجديدة)**.
- «تفعيل الربط» لكل شركة/فرع/بيئة، مع ثلاث استراتيجيات صريحة: **«وضع التصدير بالجملة CSV»** · **«الربط المباشر API»** · **«كلاهما»**.
- بيئة `Sandbox | Production`، ولاية الانطلاق، نوع التسليم، حقول المفاتيح `type=password`، «إدخال مفاتيح جديدة»، و`credentials_hint` فقط بعد الحفظ.
- أزرار: **حفظ الإعدادات** · **اختبار الاتصال** · **تعطيل ومسح المفاتيح**.
- لا يوجد `<select>` أصلي: كل القوائم تستخدم حركة **«الدرج المنزلق»**.

### شاشة الطلبات — «شحن الطلب» و«تصدير الشحنات (CSV)»

- **«شحن الطلب»** داخل `OrderCard` (`components/dashboard/ShippingButton.js`) يظهر لطلبات التوصيل بحالة `confirmed`/`preparing` فقط. الزر نفسه درج منزلق: خياراته مشتقة من روابط الشحن **المفعّلة** لهذا الفرع والتي `mode=api|both` وقدرتها `create=true`. لذلك تظهر يليدين وZR Procolis وZR الجديدة تلقائياً حسب الإعدادات، دون أي شرط باسم شركة داخل المكوّن.
- **«تصدير الشحنات (CSV)»** (`components/dashboard/ShippingExportButton.js`) درج منزلق آخر في أعلى شاشة الطلبات. قوالبه مشتقة من الروابط المفعّلة `mode=bulk|both` ذات قدرة `bulkTemplate=true`، وكل خيار يحمل الشركة + الفرع + البيئة لأن التصدير مقصور على فرع واحد. **إصلاح P5:** لم يعد الزر معطّلاً عند غياب الروابط؛ تظهر قوالب يليدين و ZR الثلاثة من `lib/shipping/export-options.js` دائماً مع تلميح إعداد، بينما يظل التنزيل الفعلي مشروطاً برابط مفعّل عبر بوابة `/api/shipping/exports`.
- الملف يحتوي **فقط** طلبات `confirmed` («مؤكد») و`preparing` («قيد التحضير»)، ويستبعد الطلبات المشحونة أو المُصدّرة سابقاً؛ الدفعة تُسجّل لمنع تكرار الطلب نفسه.
- بعد الشحن يظهر رقم التتبّع ورابط الملصق؛ بعد التصدير يظهر عدد الطلبات ورقم الدفعة. **لا تكتب الواجهة في `orders` إطلاقاً**.

**القوائم المنسدلة**: `components/ui/drawerMenu.js` + `app/globals.css` يوفّران `vetrina-drawer-open` (240ms) و`vetrina-drawer-close` (180ms) مع `prefers-reduced-motion`. تستخدمها `CustomSelect`, `SearchableSelect`, `CustomerPicker`, `LowStockBell`, `ShippingSettings`، وقائمتا الشحن/التصدير الجديدتان. القوائم تعمل عبر portal وخلفية داكنة موحّدة، وتُغلق بالنقر الخارجي أو `Escape`.

## 5) المحوّلات والقابلية للتوسّع

`lib/shipping/contract.js` (المفردات القانونية) + `lib/shipping/registry.js` (بيانات الشركات، تحقق الحقول، قالب الترويسات، `capabilities`) + `lib/shipping/adapters.js` (سجل المحوّلات السيرفري).
الواجهة والـ Route Handlers لا تعرفان شيئاً عن شركة بعينها: تمرّران `provider_code` فقط. إضافة شركة = ملف محوّل في `lib/shipping/providers/` + سطر في الـ registry + سطر في `adapters.js` + (اختياري) قالب CSV؛ **بلا migration جديدة ولا تفريع في الواجهة**.

المحوّلات الثلاثة تشترك في بنية الأساليب نفسها:
`testConnection`, `createShipment`, `getTracking`, `getLabel`, `cancelShipment`, `pullStatuses`, `syncTerritories`, `mapStatus`, `shipmentStatusFrom` (حيث ينطبق)، `verifyWebhook`, `parseWebhook`, `buildBulkRows`, و`capabilities`.

- `lib/shipping/providers/yalidine.js`: `X-API-ID/X-API-TOKEN`، أسماء الولايات اللاتينية، حمولة الطرد، تحويل الحالات، التتبّع/الملصق/الإلغاء/سحب الحالات/المناطق، توقيع الويبهوك، وقالب CSV الخاص به.
- `lib/shipping/providers/zrexpress.js`: منصّة **Procolis** بترويسات `Authorization: Token …` + `X-Api-Key`، حقول `order_id/client/phone/wilaya_id/cod_amount`، وقالب CSV خاص.
- `lib/shipping/providers/zrexpressnew.js`: المنصّة **الجديدة** بترويسات `X-Api-Key` + `X-Tenant`، حقول `orderId/recipient/territoryId/codAmount`، معرّفات مناطق UUID حتمية، وقالب CSV خاص.
- `lib/shipping/providers/zrCommon.js`: الهيكل المشترك لمنصّتي ZR (دورة الحياة، تحويل الحالات، توقيع الويبهوك، سحب الحالات/المناطق، بناء صفوف CSV). خصوصيات كل منصّة تبقى في ملفها فقط.

`lib/shipping/transport.js` يختار بين `mockFetch` والـ API الحي بمتغيّر واحد، و`lib/shipping/mock.js` يوفّر ثلاثة أصول وهمية منفصلة (`mock.yalidine.local`, `mock.zrexpress.local`, `mock.zrexpressnew.local`) مع بيانات حتمية بلا شبكة وترويسات مختلفة لكل شركة. `SHIPPING_MOCK_MODE=true` على Vercel يُبقي كل ذلك أوفلاين.

> **تحذير توثيقي**: أسماء الحقول والعناوين وتوقيعات الويبهوك في محوّلات ZR ويليدين مبنية على مراجع مجتمعية/SDK وليست معتمدة حيّاً. لا يجوز الادعاء باعتماد API حي قبل الحصول على وثائق Sandbox الرسمية ومفاتيحها ومطابقة القوالب/المناطق/التوقيع معها.

## 6) متغيّرات البيئة (`.env.example`)

`SHIPPING_MASTER_KEY` و`SUPABASE_SERVICE_ROLE_KEY` وأسرار الويبهوك سيرفرية فقط. لا تستخدم `NEXT_PUBLIC_` لها، ولا ترفع قيمها إلى Git. `SHIPPING_MOCK_MODE=true` يُبقي P3/P4 على البيانات الوهمية؛ `false` + المفاتيح المحفوظة + `SHIPPING_<CODE>_<ENV>_BASE_URL` يحول المحوّل نفسه إلى API الشركة. لا توجد عناوين افتراضية آمنة لمنصّتي ZR، لذا يجب ضبطها صراحةً عند توفر الوثائق الرسمية. القيم الحساسة الحالية مضبوطة في Vercel كـ `sensitive` لكل بيئات `production/preview/development`.

## 7) الاختبارات

`tests/shipping-credentials.test.mjs` (التشفير/العبث/AAD/القناع)، `tests/shipping-registry.test.mjs` (عقد الشركات/القدرات/بناء الفحص)، `tests/shipping-migration.test.mjs` (RLS، عدم لمس `orders`، RPC المقنّعة ولقطات P3/P4)، `tests/shipping-yalidine.test.mjs` (Mock Fetch ليليدين)، `tests/shipping-p3-gateway.test.mjs` (شحن/مزامنة/ويبهوك/إلغاء عبر عميل Supabase وهمي)، `tests/shipping-zr.test.mjs` (محوّلا ZR + قوالبهما + Mock Fetch + توقيع الويبهوك)، `tests/shipping-p4-export.test.mjs` (BOM، الحالات المؤهلة، استبعاد المشحون/المُصدّر، تسجيل الدفعة، منع التكرار)، `tests/shipping-p4-ui.test.mjs` (قوائم «الدرج المنزلق»، اشتقاق الخيارات من الروابط، غياب `<select>`)، و`tests/shipping.integration.sql` لفحص العزل على مشروع Supabase حي.

## 8) حالة التنفيذ

- `202611120015` **مطبّقة فعلياً** على مشروع Supabase المتصل (`Diwanpro's Project`): 6 جداول، RLS مفعّل على 6/6، `shipping_connections` بلا أي سياسة، 5 سياسات قراءة، دالتان مقنّعتان.
- `202611120016` **مطبّقة فعلياً** باسم `shipping_order_snapshot_p3`; فُحصت حيّةً: دالة `engine_order_shipping_snapshot` موجودة و`SECURITY DEFINER`، `anon` لا يملك `EXECUTE` بينما `authenticated`/`service_role` يملكانه، و`public.orders` ما زال بـ **27 عموداً** دون أي تعديل.
- متغيّرات Vercel السيرفرية مضبوطة لكل `production/preview/development`: `SHIPPING_MASTER_KEY` و`SUPABASE_SERVICE_ROLE_KEY` و`SHIPPING_YALIDINE_WEBHOOK_SECRET` كقيم `sensitive`، و`SHIPPING_MOCK_MODE=true`. لا تُعرض القيم في هذا المستند ولا في Git.
- P1/P2/P3: كود، اختبارات، بناء، migration، توثيق، commit/push، ونشر مُتحقّق منه. الاختبارات الكاملة بعد P3 كانت `445/445`، و`next build` نجح مع محاكاة خط Tajawal بسبب حظر Google Fonts في بيئة الاختبار.
- P4: المحوّلان، قالب CSV لكل شركة، واجهة التصدير، RPC المرشحين، تسجيل الدفعات، والاختبارات مضافة في هذا الفرع. migration `202611120017` **مطبّقة فعلياً** باسم `shipping_export_candidates_p4`؛ فُحصت حيّةً: الدالة موجودة و`STABLE SECURITY DEFINER`، `anon_can_execute=false` و`authenticated/service_role=true`، فهرسان فريدان جديدان موجودان، و`public.orders` ما زال بـ **27 عموداً**.
- P4 تحقق محلي: الاختبارات المستهدفة للشحن `40/40`، الاختبارات الكاملة `459/459` (بما فيها تجميع كل migrations عبر `pglast`)، و`next build` نجح مع محاكاة خط Tajawal؛ ظهر المسار `/api/shipping/exports` ضمن مخرجات البناء.
- P4 commit/push: `01364e2` على الفرع `arena/740f973f-vetrina-app` مع `origin` متتبِّع. نشر المعاينة على Vercel للـ commit نفسه `01364e295516fd05bf16246dde1ab3a7c88a8d0d` وصل إلى `READY` (`dpl_FK4Z2R3QTjLogZJQcAaAdTNyu3vV`) على `https://vetrina-app-git-arena-740f973f-vetrina-app-diwanpro.vercel.app`. فرع الإنتاج `main` لم يُلمس.
- **غير مُعتمد حيّاً بعد**: لا توجد مفاتيح/وثائق Sandbox رسمية؛ لذلك يجب مطابقة أسماء الحقول والعناوين والتوقيعات مع الوثائق الرسمية قبل تشغيل `SHIPPING_MOCK_MODE=false` في الإنتاج. استيراد ملفات التتبّع مؤجّل إلى P6، ولم يُجرَ فحص بصري في متصفح حقيقي للقوائم.
