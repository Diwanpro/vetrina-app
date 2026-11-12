-- Repairs delivery_rates written by hand or by an older client.
--
-- create_order looks the fee up as delivery_rates ->> '16', so a row saved as
-- {"9": 400} or {"البليدة": 400} would price nothing and the checkout would
-- silently fall back to zero. The storefront already normalises the same way
-- (lib/delivery.js); this makes the stored data agree with it.
--
-- Whole, non-negative dinars only; anything unrecognisable is dropped rather
-- than guessed. Idempotent: a canonical table is left untouched.
-- Apply after 202611120007.

-- Diacritics, tatweel, and the letter variants people mix up are folded away,
-- so "أدرار" and "ادرار" compare equal, as do "بليدة" and "البليدة".
CREATE OR REPLACE FUNCTION public.engine_normalize_wilaya_text(p_value text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT btrim(regexp_replace(
    translate(regexp_replace(coalesce(p_value, ''), '[\u064B-\u065F\u0670\u06D6-\u06EF]', '', 'g'),
              'أإآٱىةـ', 'اااايه'),
    '[[:space:][:punct:]]', '', 'g'))
$$;

-- '16', '016', '16 - البليدة', 'البليدة', 'بليدة' -> '16'; anything else -> NULL.
CREATE OR REPLACE FUNCTION public.engine_wilaya_code(p_value text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  cleaned text := public.engine_normalize_wilaya_text(p_value);
  digits text;
BEGIN
  IF cleaned = '' THEN RETURN NULL; END IF;

  digits := regexp_replace(cleaned, '[^0-9]', '', 'g');
  IF length(digits) BETWEEN 1 AND 3 AND digits::integer BETWEEN 1 AND 58 THEN
    RETURN lpad(digits::integer::text, 2, '0');
  END IF;

  -- Names, with or without the definite article.
  RETURN (
    SELECT m.code
      FROM (VALUES
    ('01', 'أدرار'),
    ('02', 'الشلف'),
    ('03', 'الأغواط'),
    ('04', 'أم البواقي'),
    ('05', 'باتنة'),
    ('06', 'بجاية'),
    ('07', 'بسكرة'),
    ('08', 'بشار'),
    ('09', 'البليدة'),
    ('10', 'البويرة'),
    ('11', 'تمنراست'),
    ('12', 'تبسة'),
    ('13', 'تلمسان'),
    ('14', 'تيارت'),
    ('15', 'تيزي وزو'),
    ('16', 'الجزائر'),
    ('17', 'الجلفة'),
    ('18', 'جيجل'),
    ('19', 'سطيف'),
    ('20', 'سعيدة'),
    ('21', 'سكيكدة'),
    ('22', 'سيدي بلعباس'),
    ('23', 'عنابة'),
    ('24', 'قالمة'),
    ('25', 'قسنطينة'),
    ('26', 'المدية'),
    ('27', 'مستغانم'),
    ('28', 'المسيلة'),
    ('29', 'معسكر'),
    ('30', 'ورقلة'),
    ('31', 'وهران'),
    ('32', 'البيض'),
    ('33', 'إليزي'),
    ('34', 'برج بوعريريج'),
    ('35', 'بومرداس'),
    ('36', 'الطارف'),
    ('37', 'تندوف'),
    ('38', 'تيسمسيلت'),
    ('39', 'الوادي'),
    ('40', 'خنشلة'),
    ('41', 'سوق أهراس'),
    ('42', 'تيبازة'),
    ('43', 'ميلة'),
    ('44', 'عين الدفلى'),
    ('45', 'النعامة'),
    ('46', 'عين تموشنت'),
    ('47', 'غرداية'),
    ('48', 'غليزان'),
    ('49', 'تيميمون'),
    ('50', 'برج باجي مختار'),
    ('51', 'أولاد جلال'),
    ('52', 'بني عباس'),
    ('53', 'عين صالح'),
    ('54', 'عين قزام'),
    ('55', 'تقرت'),
    ('56', 'جانت'),
    ('57', 'المغير'),
    ('58', 'المنيعة')
      ) m(code, name)
     WHERE regexp_replace(public.engine_normalize_wilaya_text(m.name), '^ال', '')
           = regexp_replace(cleaned, '^ال', '')
     LIMIT 1
  );
END $$;

DO $repair$
DECLARE
  store_row record;
  entry record;
  rebuilt jsonb;
  code text;
  amount integer;
BEGIN
  FOR store_row IN
    SELECT id, delivery_rates FROM public.stores
     WHERE jsonb_typeof(delivery_rates) = 'object'
       AND delivery_rates <> '{}'::jsonb
  LOOP
    rebuilt := '{}'::jsonb;

    -- Two passes: a key that is already the canonical two-digit code wins over
    -- a hand-typed name for the same wilaya, so the outcome does not depend on
    -- the order jsonb happens to iterate in.
    FOR entry IN
      SELECT key, value, (key ~ '^[0-9]{2}$') AS canonical
        FROM jsonb_each(store_row.delivery_rates)
       ORDER BY canonical DESC, key
    LOOP
      code := public.engine_wilaya_code(entry.key);
      amount := CASE
        WHEN jsonb_typeof(entry.value) = 'number' THEN round((entry.value #>> '{}')::numeric)::integer
        WHEN jsonb_typeof(entry.value) = 'string'
          AND regexp_replace(entry.value #>> '{}', '[^0-9]', '', 'g') ~ '^[0-9]{1,7}$'
          THEN regexp_replace(entry.value #>> '{}', '[^0-9]', '', 'g')::integer
        ELSE NULL
      END;

      IF code IS NOT NULL AND amount IS NOT NULL AND amount BETWEEN 0 AND 1000000
         AND NOT (rebuilt ? code) THEN
        rebuilt := rebuilt || jsonb_build_object(code, amount);
      END IF;
    END LOOP;

    IF rebuilt <> store_row.delivery_rates THEN
      UPDATE public.stores SET delivery_rates = rebuilt WHERE id = store_row.id;
    END IF;
  END LOOP;
END $repair$;

REVOKE ALL ON FUNCTION public.engine_normalize_wilaya_text(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.engine_wilaya_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.engine_wilaya_code(text) TO authenticated;
