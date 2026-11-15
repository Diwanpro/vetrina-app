# تقرير «الحزمة الشاملة v3.1» — تقارير المراحل والتقرير النهائي

**الفرع:** `arena/740f973f-vetrina-app`  
**رأس الفرع:** `39eec5e76787cc3f316ff8f009769cb55afcd863` (`39eec5e` — تقرير)  
**commit التنفيذ:** `0df838227cf93d87cfa935d07cf7f0c04b3df3bc` (`0df8382`)  
**الهجرة الحية:** `branch_specialty_themes_and_push_v31` — الإصدار `20261115145524`  
**ملف الهجرة في المستودع:** `supabase/migrations/202611130019_branch_specialty_themes_and_push.sql`  
**نشر الكود:** `dpl_3EVatAcXV25yRU67MDRgwaeBcoWe` — `READY / STAGED`  
**أحدث نشر للفرع (docs):** `dpl_FoRz2utdcAfRxNxTSnwW4JAYfnWt` — `READY / STAGED`

> ملاحظة تنظيمية: نُفّذت المراحل الست دفعة واحدة بعد مزامنة الفرع مع `e6da4a0`، لذلك جُمعت تقاريرها هنا بترتيبها بدل إرسالها متفرقة. كل قسم أدناه هو تقرير مرحلته، ثم يليه التقرير النهائي الموحّد.

---

## تقرير المرحلة 1 — معالجة الانحدارات /Regression Fixes

**الهدف:** ألا تعيد الحزمة الجديدة إنتاج العيوب التي ظهرت في P4/P5.

**ما تحقق:**
- زر تصدير CSV ما زال يفتح **الدرج الداكن المنزلق** نفسه، والقوالب مشتقة من سجل شركات الشحن لا من قوائم hardcoded.
- تفاصيل الطلب ما زالت تعرض **صور المنتجات** بجانب بيانات الزبون (`order_items.image_url`).
- لم يُعد إدخال أي `<select>` أصلي في واجهات لوحة التحكم؛ كل القوائم الجديدة تستخدم `CustomSelect` بحركة «الدرج المنزلق».
- تم إصلاح تعليقين كانا يذكران `<select>` حرفيًا داخل تعليقات الكود حتى يجتازا حارس الانحدار دون تغيير السلوك.

**الاختبارات:** `tests/v31-phase1-regressions.test.mjs` + حارس `grep -R '<select'` على `app/` و`components/` → لا نتائج.

---

## تقرير المرحلة 2 — الأجهزة الطرفية /Peripherals

**الهدف:** بقاء قارئ الباركود والطباعة الحرارية سليمين بعد التوسعة.

**ما تحقق:**
- قارئ **HID / Keyboard-Wedge** يملأ حقل البحث وحقل إضافة المنتج، مع state machine وحدّ الطول وحماية الإدخال.
- الطباعة الحرارية **58mm / 80mm** تعمل عبر المتصفح وWebUSB وWebBluetooth ومسار الوسيط النسبي `/api/printing/relay`، مع الحفاظ على العربية و bytes ESC/POS.
- لم يُلمس `public.orders` ولم تُغيّر مسارات الطباعة.

**الاختبارات:** `tests/v31-phase2-peripherals.test.mjs`.

---

## تقرير المرحلة 3 — «تخصص الفرع» إلزامي وعائد للفرع لا للحساب

**الهدف:** تصحيح قاعدة العمل: **«تخصص الفرع» يخص الفرع**، ويمكن لحساب واحد أن يملك فرعًا رجاليًا وآخر نسائيًا وثالثًا متعددًا.

**ما تحقق:**
- ثلاث قيم إلزامية: `mens` / `womens` / `mixed` بعنوان عربي «متعدد».
- التصنيفات الذكية تتبع الفرع الحالي؛ `mixed` يوحّد شجرتي الرجالي والنسائي.
- كتالوجات تجريبية نظيفة: **15 رجالي + 10 نسائي + 25 متعدد** بمعرّفات غير مت collision وأسعار نسائية واقعية.
- شاشة التسجيل تطلب «تخصص الفرع الأول» إلزاميًا؛ الإعدادات تعرض «تخصص الفرع» لكل فرع؛ محرر `BranchProfileEditor` يعدّل كل فرع على حدة عبر `engine_list_branch_profiles` / `engine_set_branch_profile`.
- `engine_session()` و`get_store_by_slug()` يعيدان `store_type` و`theme_key` للفرع، فيتغيّر `ctx.storeType` فور تبديل الفرع.
- الهجرة تمنع الالتفاف عبر overloads القديمة: `engine_add_store(text,text)` و`engine_create_trial_tenant(text,text,text)` و`engine_update_store_settings` بـ 12/13/14 وسيطًا مُلغاة من أدوار المتصفح، وoverload ذو 14 وسيطًا محذوف.
- فروع العرض: `seed-branch-2 = mixed/feminine`، `seed-branch-3 = womens/classic`، والفرع الأساسي `mens/classic` ضمن **نفس المستأجر**.
- بيانات `[seed] %` القديمة مخفية (`is_active=false`) لا محذوفة.

**الاختبارات:** `tests/v31-branch-specialty.test.mjs`، `tests/v31-migration.test.mjs`، وتحديث `tests/p5-store-catalog.test.mjs`، `tests/trial.test.mjs`، `tests/delivery-rates.test.mjs`.

---

## تقرير المرحلة 4 — محرك الثيمات /Theme Engine

**الهدف:** واجهة المتجر تتبع تخصص الفرع، مع حرية التاجر في الفرع المتعدد.

**ما تحقق:**
- `lib/store-theme.js` يحلّ الثيم: نسائي → `feminine`، رجالي → `classic`، متعدد → اختيار التاجر `classic`/`feminine`.
- `stores.theme_key` بقيمة افتراضية `classic` و`CHECK` على القيمتين.
- ثيم نسائي فاخر في `app/globals.css`: ألوان ناعمة، بطاقات `sf-card`، وسائط `sf-product-media` أكبر، `sf-hero`، شارات `sf-badge`، رفع عند التحويم، ودعم `prefers-reduced-motion`.
- الإعدادات تُظهر اختيار الثيم **فقط للفرع المتعدد** وترسله في `p_theme_key` إلى RPC ذي 15 وسيطًا.

**الاختبارات:** `tests/v31-theme.test.mjs`.

---

## تقرير المرحلة 5 — PWA قابل للتثبيت لكل فرع

**الهدف:** manifest وservice worker وأيقونة واسم ولون ورابط بدء **خاصّين بالفرع**.

**ما تحقق:**
- `/api/store/[slug]/manifest` يبني الmanifest من `get_store_by_slug()`: الاسم، الشعار، `start_url = /s/<slug>`، الألوان، و`id` خاص بالفرع.
- `/s/[slug]` يعلن metadata وmanifest ديناميكيًا؛ `StorePwa` يضبط رابط الmanifest والأيقونات ويسجّل `/service-worker.js`.
- `public/service-worker.js` هو العامل الكنسي (shell + push) و`public/sw.js` مجرد shim؛ `SessionProvider` يسجّل العامل الكنسي للوحة التحكم.
- `InstallPrompt` يعرض طلب التثبيت الأنيق، ويتعرف على iOS/standalone، دون `<select>` أصلي ولا مفتاح خدمة في المتصفح.
- `public/manifest.json` يبقى خاصًا بلوحة التحكم بـ `id:/dashboard/pos` و`start_url:/dashboard/pos`.
- تحويل مفتاح VAPID العام من base64url إلى `Uint8Array` في `lib/pwa/client.js` من أجل `PushManager.subscribe`.

**الاختبارات:** `tests/v31-pwa.test.mjs`.

---

## تقرير المرحلة 6 — إشعارات Web Push محصورة بالفرع

**الهدف:** عند إضافة منتج أو عرض جديد، يصل إشعار تلقائي **لمتابعي ذلك الفرع فقط**.

**ما تحقق:**
- جدول `public.push_subscriptions` جديد: `store_id` إلزامي يربط كل اشتراك بفرع، RLS مفعّل **بلا أي policy**، و`REVOKE ALL ... FROM PUBLIC, anon, authenticated` مع `GRANT ALL ... TO service_role` فقط.
- مفاتيح VAPID في متغير Vercel الحسّاس `PUSH_VAPID_CONFIG` (المعرّف `Q0rNmac1fp0SmqUw`) بصيغة base64-of-JSON؛ `.env.example` يوثّق التوليد ويمنع `NEXT_PUBLIC_` للمفتاح الخاص. لا سر مُcommit.
- `/api/push/public-key` يعيد **المفتاح العام فقط**؛ `/subscribe` و`/unsubscribe` يتحققان من الرابط والمفاتيح ويحفظان/يحذفان عبر service_role؛ لا يصل المتصفح مباشرة إلى الجدول.
- `/api/push/dispatch` يتحقق من JWT ثم `engine_session()` ثم `engine_staff()` ويقبل فقط `store_id` ضمن فروع الجلسة؛ يجلب اشتراكات `.eq('store_id', storeId)`، يبني رسالة باسم المتجر وعنوان جذّاب ورابط مباشر `/s/<slug>`، يرسل عبر `web-push`، ويحذف اشتراكات `404/410`.
- `app/dashboard/_screens/products.js` و`offers.js` يستدعيان `notifyBranchPush` بعد نجاح الحفظ فقط.
- `lib/push/sender.js` يستورد `web-push` كـ namespace لتفادي تحذير «no default export» في Next.js.

**الاختبارات:** `tests/v31-push.test.mjs`.

---

## التقرير النهائي الموحّد

### 1) التحقق المحلي

| البند | النتيجة |
|---|---|
| `PYTHON=.venv/bin/python node --test tests/*.test.mjs` | **503 / 503 ناجح، 0 فشل، 0 تخطٍ** |
| `NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/vetrina-font-mock.js npm run build` | compiled successfully في 5.9s، بلا تحذيرات، مع مسارات `/api/push/*` و`/api/store/[slug]/manifest` |
| `git diff --check` | نظيف |
| `<select>` أصلي في `app/` و`components/` | صفر |
| أسرار VAPID في المستودع | صفر؛ المفتاح الخاص في Vercel فقط |

> بناء Vercel نفسه: `✓ Compiled successfully in 10.9s` بلا تحذيرات، و`PUSH_VAPID_CONFIG` موجود في بيئة البناء.

### 2) التحقق الحي على Supabase — المشروع `scfwdjbgwlaptbnjkofk`

طُبّقت الهجرة بعد التحقق من بصمة الحمولة `md5 = 329ccc22898ba9374c5ebfa529053adb`، ثم حُذف جدول المساعدة المؤقت `_v31_migration_chunks`.

| الفحص | القيمة |
|---|---|
| `public.orders` | **27 عمودًا — لم يُكتب أو يُعدّل أو يُحذف منه أي صف/عمود** |
| `stores.theme_key` / قيد `store_type` / قيد `theme_key` | `1 / 1 / 1` |
| `push_subscriptions` | موجود، RLS=`true`، policies=`0`، service_role=`true`، anon SELECT=`false` |
| `engine_update_store_settings` | 15 وسيطًا = `1`، 14 وسيطًا = `0`، القديمة بلا صلاحية متصفح |
| `engine_add_store` / `engine_create_trial_tenant` | 3 وسيطًا / 4 وسيطًا = `1 / 1`، والقديمة بلا صلاحية متصفح |
| `engine_list_branch_profiles` + `engine_set_branch_profile` | `2`، `SECURITY DEFINER`، `authenticated` فقط |
| `engine_session()` / `get_store_by_slug()` | يحتويان `themeKey`/`theme_key` و`store_type`؛ `anon` مخوّل للقراءة العامة فقط |
| `get_store_by_slug('seed-branch-2')` | `store_type=mixed`، `theme_key=feminine` |
| فروع العرض | `seed-branch-2 = mixed/feminine`، `seed-branch-3 = womens/classic` |
| منتجات `[seed] %` النشطة | `0` |
| سجل الهجرة / جدول المساعدة | `1 / 0` |

### 3) النشر

- **commit التنفيذ:** `0df8382` — 51 ملفًا، `2678+/143-`، دُفع إلى `arena/740f973f-vetrina-app`.
- **commit التقرير:** `39eec5e` — `docs/V31_REPORT_AR.md` فقط، وهو رأس الفرع الحالي.
- **Vercel للكود:** `dpl_3EVatAcXV25yRU67MDRgwaeBcoWe` — `READY / STAGED`، `timeToReady = 36798ms`، `https://vetrina-6ry89xwxh-diwanpro.vercel.app`.
- **أحدث نشر للفرع:** `dpl_FoRz2utdcAfRxNxTSnwW4JAYfnWt` — `READY / STAGED`، `timeToReady = 32487ms`، `https://vetrina-3112p1noz-diwanpro.vercel.app`.
- **رابط الفرع الثابت (يُحدَّث تلقائيًا لأحدث نشر):** `https://vetrina-app-git-arena-740f973f-vetrina-app-diwanpro.vercel.app`
- كلا النشرين يحملان `PUSH_VAPID_CONFIG` في بيئة البناء؛ `main` untouched.

### 4) القيود الصريحة المتبقية

1. **لم يُجرَ اختبار يدوي على جهاز حقيقي** لتثبيت PWA أو إنشاء اشتراك Push أو استقبال إشعار فعلي؛ التحقق بنيوي/وحدات/حيّ لقاعدة البيانات فقط.
2. **لا يوجد فحص بصري آلي في متصفح حقيقي** للثيم النسائي أو لدرج التثبيت.
3. **`SHIPPING_MOCK_MODE=true` لا يزال إلزاميًا**: لا توجد مفاتيح أو وثائق Sandbox رسمية لشركات الشحن، ولا اعتماد حيّ لأي API شحن. قوالب/مناطق Yalidine وZR غير رسمية ومشتقة من Community/SDK.
4. **استيراد التتبّع P6 مؤجل** كما تقرر سابقًا.
5. `public.orders` ظلّ للقراءة فقط ضمن هذه الحزمة (27 عمودًا).

### 5) أهم الملفات

- `lib/store-catalog.js`، `lib/store-theme.js`، `lib/mock-catalog.js`، `lib/app-context.js`، `lib/trial.js`
- `app/signup/page.js`، `app/dashboard/_screens/settings.js`، `components/dashboard/BranchProfileEditor.js`
- `supabase/migrations/202611130019_branch_specialty_themes_and_push.sql`، `supabase/seed_data.sql`، `supabase/schema/columns.tsv`
- `components/store/{Storefront,StoreHeader,StorePwa,InstallPrompt,PushOptIn}.js`، `app/globals.css`
- `lib/pwa/*`، `app/api/store/[slug]/manifest/route.js`، `app/s/[slug]/page.js`، `public/service-worker.js`، `public/sw.js`، `public/manifest.json`
- `lib/push/*`، `app/api/push/*`، `app/dashboard/_screens/{products,offers}.js`
- `package.json` / `package-lock.json` (`web-push@4.0.0`)، `.env.example`
- `tests/v31-*.test.mjs` (7 ملفات) + تحديث 3 اختبارات قديمة.
