// Default subcategories per main category. Custom ones live in the
// custom_subcategories table and are merged in by lib/subcategories.js.
export const CATEGORY_TREE = {
  'ملابس': ['قميص كلاسيك', 'قميص كاجوال', 'تريكو', 'تي شيرت', 'بولو', 'فيستا / بليزر', 'معطف', 'سورفيتور', 'صدرية'],
  'سراويل': ['جينز سليم', 'جينز واسع', 'سروال شينو', 'سروال كلاسيك', 'سروال قماش', 'سروال رياضي', 'شورت'],
  'أحذية': ['أحذية رياضية', 'أحذية كلاسيك', 'موكاسان', 'بوت', 'صندل'],
  'إكسسوارات': ['حزام', 'محفظة', 'جوارب', 'كاب', 'ساعة', 'نظارات', 'حقيبة', 'عطور'],
  'أطقم رسمية': ['طقم كامل', 'بليزر فقط'],
}

export const MAIN_CATEGORIES = Object.keys(CATEGORY_TREE)

export function subcategoriesFor(category) {
  return CATEGORY_TREE[category] || []
}
