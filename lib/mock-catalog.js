// Realistic Algerian demo catalogues (P5).
//
// The old hand-run seed mixed men's and women's products in one list and used
// external Unsplash URLs that cannot render inside the sandboxed preview. This
// module is the single source for clean, local mock data:
//   * men's list: no dresses, handbags, heels or scarves;
//   * women's list: clothing 2500–8000 DZD, shoes 3000–6000 DZD,
//     accessories 1500–4000 DZD, with Arabic descriptions and local pictures.
//
// The mock rows are appended to real database rows, never written to the DB,
// so a live shop keeps its own catalogue. They carry `is_mock` and the public
// storefront marks them as display-only demo pieces.

import { normalizeStoreType, STORE_TYPES } from './store-catalog.js'

const CLOTHING_SIZES = ['S', 'M', 'L', 'XL']
const SHOE_SIZES = ['36', '37', '38', '39', '40']
const ONE_SIZE = ['مقاس واحد']

export const WOMENS_PRICE_RANGES = Object.freeze({
  'ملابس': Object.freeze([2500, 8000]),
  'أحذية': Object.freeze([3000, 6000]),
  'إكسسوارات': Object.freeze([1500, 4000]),
})

const MENS_CATALOG = [
  {
    slug: 'linen-shirt', name: 'قميص كتان صيفي رجالي', description: 'قميص كتان خفيف بقصة مريحة، مناسب لأيام قسنطينة الحارة والمناسبات اليومية.', productType: 'ملابس', category: 'قمصان رجالية', price: 4200, image: '/mock/mens/shirt.jpg', sizes: CLOTHING_SIZES, colors: ['أبيض', 'بيج', 'أزرق فاتح'],
  },
  {
    slug: 'cotton-tshirt', name: 'تيشيرت قطن بيومي', description: 'تيشيرت قطن 100٪ برقبة دائرية وألوان ثابتة، مناسب للعمل والخروجات اليومية.', productType: 'ملابس', category: 'تيشيرتات رجالية', price: 1900, image: '/mock/mens/tshirt.jpg', sizes: CLOTHING_SIZES, colors: ['أبيض', 'أسود', 'كحلي'],
  },
  {
    slug: 'straight-jeans', name: 'جينز مستقيم كلاسيك', description: 'جينز بقصة مستقيمة وقماش متين، متوفّر بالمقاسات الأكثر طلباً في السوق الجزائري.', productType: 'ملابس', category: 'بناطيل رجالية', price: 5600, image: '/mock/mens/jeans.jpg', sizes: ['38', '40', '42', '44'], colors: ['أزرق', 'أسود', 'رمادي'],
  },
  {
    slug: 'evening-jacket', name: 'سترة خفيفة للمساء', description: 'سترة رجالية خفيفة ببطانة ناعمة، اختيار مناسب للسهرات والمناسبات العائلية.', productType: 'ملابس', category: 'جاكيتات رجالية', price: 8200, image: '/mock/mens/jacket.svg', sizes: ['M', 'L', 'XL'], colors: ['كحلي', 'أسود'],
  },
  {
    slug: 'polo', name: 'بولو قطن رجالي', description: 'بولو قطني بياقة مضلّعة، يجمع بين المظهر المرتب والراحة طوال اليوم.', productType: 'ملابس', category: 'بولو رجالي', price: 2900, image: '/mock/mens/polo.svg', sizes: CLOTHING_SIZES, colors: ['زيتي', 'أبيض', 'كحلي'],
  },
  {
    slug: 'white-sneakers', name: 'حذاء رياضي أبيض', description: 'سنيكرز رجالي بنعل مريح ووجه سهل التنظيف، مناسب للمشي اليومي والجامعة.', productType: 'أحذية', category: 'سنيكرز رجالي', price: 7400, image: '/mock/mens/sneakers.svg', sizes: ['40', '41', '42', '43', '44'], colors: ['أبيض', 'أسود'],
  },
  {
    slug: 'classic-shoes', name: 'حذاء جلد كلاسيك', description: 'حذاء جلد طبيعي بقصة كلاسيكية للعمل والأعراس، مع نعل مريح يدوم طويلاً.', productType: 'أحذية', category: 'أحذية كلاسيك', price: 9800, image: '/mock/mens/classic-shoes.svg', sizes: ['40', '41', '42', '43'], colors: ['بني', 'أسود'],
  },
  {
    slug: 'leather-sandals', name: 'صندل جلد صيفي رجالي', description: 'صندل جلد مفتوح بأشرطة متينة، مصنوع للصيف الجزائري والاستخدام اليومي.', productType: 'أحذية', category: 'صنادل رجالية', price: 3900, image: '/mock/mens/sandals-men.svg', sizes: ['39', '40', '41', '42', '43'], colors: ['بني', 'أسود'],
  },
  {
    slug: 'house-slippers', name: 'شبشب منزلي قطني', description: 'شبشب منزلي خفيف ببطانة قطنية ونعل غير قابل للانزلاق.', productType: 'أحذية', category: 'أحذية منزلية', price: 1500, image: '/mock/mens/slippers.svg', sizes: ['40', '41', '42', '43'], colors: ['بيج', 'رمادي'],
  },
  {
    slug: 'leather-belt', name: 'حزام جلد طبيعي', description: 'حزام رجالي من الجلد الطبيعي مع مشبك معدني بسيط يناسب البنطال الرسمي والجينز.', productType: 'إكسسوارات', category: 'أحزمة', price: 2200, image: '/mock/mens/belt.svg', sizes: ['85', '90', '95', '100'], colors: ['بني', 'أسود'],
  },
  {
    slug: 'wallet', name: 'محفظة جلد صغيرة', description: 'محفظة جلد مدمجة بجيوب للبطاقات والأوراق النقدية، هدية عملية ومناسبة.', productType: 'إكسسوارات', category: 'محافظ', price: 3100, image: '/mock/mens/wallet.svg', sizes: ONE_SIZE, colors: ['بني', 'أسود'],
  },
  {
    slug: 'sunglasses', name: 'نظارة شمسية مربعة', description: 'نظارة شمسية بإطار مربع خفيف وعدسات حماية، مناسبة للقيادة والصيف.', productType: 'إكسسوارات', category: 'نظارات', price: 3600, image: '/mock/mens/sunglasses.svg', sizes: ONE_SIZE, colors: ['أسود'],
  },
  {
    slug: 'summer-cap', name: 'طاقية صيفية قطنية', description: 'طاقية قطنية خفيفة بلون صيفي، مريحة للارتداء طوال اليوم.', productType: 'إكسسوارات', category: 'قبعات', price: 1200, image: '/mock/mens/cap.svg', sizes: ONE_SIZE, colors: ['بيج', 'أبيض'],
  },
  {
    slug: 'classic-watch', name: 'ساعة يد كلاسيكية', description: 'ساعة يد بسوار جلدي وميناء واضح، تصميم يومي أنيق دون مبالغة.', productType: 'إكسسوارات', category: 'ساعات', price: 4800, image: '/mock/mens/watch.svg', sizes: ONE_SIZE, colors: ['أسود', 'بني'],
  },
  {
    slug: 'formal-blazer', name: 'بليزر رسمي رجالي', description: 'بليزر بقصة ضيقة مناسبة للأعراس والعمل، مع بطانة داخلية مريحة.', productType: 'ملابس', category: 'أطقم رسمية', price: 9500, image: '/mock/mens/blazer.svg', sizes: ['48', '50', '52', '54'], colors: ['كحلي', 'أسود'],
  },
]

const WOMENS_CATALOG = [
  {
    slug: 'summer-dress', name: 'فستان صيفي مطرّز', description: 'فستان صيفي خفيف بتطريز ناعم على الصدر والأكمام، مناسب للخروجات النهارية والمناسبات العائلية.', productType: 'ملابس', category: 'فساتين', price: 6500, image: '/mock/womens/dress.jpg', sizes: CLOTHING_SIZES, colors: ['وردي فاتح', 'بيج', 'أبيض'],
  },
  {
    slug: 'algiers-kaftan', name: 'قفطان جزائري مطرّز', description: 'قفطان جزائري مخملي بتطريز ذهبي مستوحى من المناسبات والأعراس، بقصة مريحة وأنيقة.', productType: 'ملابس', category: 'قفاطين', price: 7800, image: '/mock/womens/kaftan.jpg', sizes: CLOTHING_SIZES, colors: ['كحلي', 'عنابي'],
  },
  {
    slug: 'silk-blouse', name: 'بلوزة حريرية سادة', description: 'بلوزة ناعمة بلون باستيل، قصة واسعة تناسب العمل والسهرة مع تنورة أو بنطال.', productType: 'ملابس', category: 'بلوزات', price: 3200, image: '/mock/womens/blouse.jpg', sizes: CLOTHING_SIZES, colors: ['وردي', 'أبيض', 'أزرق فاتح'],
  },
  {
    slug: 'evening-dress', name: 'فستان سهرة طويل', description: 'فستان سهرة طويل بقصة انسيابية وقماش أخضر زمردي، مناسب للأعراس والحفلات.', productType: 'ملابس', category: 'فساتين سهرة', price: 8000, image: '/mock/womens/evening-dress.svg', sizes: ['S', 'M', 'L'], colors: ['أخضر زمردي', 'أسود'],
  },
  {
    slug: 'beige-heels', name: 'كعب عالي بيج', description: 'حذاء بكعب متوسط ولون بيج يسهل تنسيقه مع القفاطين والفساتين، مع نعل مبطّن.', productType: 'أحذية', category: 'كعب عالي', price: 4800, image: '/mock/womens/heels.jpg', sizes: SHOE_SIZES, colors: ['بيج', 'أسود'],
  },
  {
    slug: 'leather-sandals', name: 'صندل جلد نسائي', description: 'صندل جلد مسطّح بأشرطة مريحة، اختيار عملي للصيف والبحر والمدينة.', productType: 'أحذية', category: 'صنادل', price: 3500, image: '/mock/womens/sandals.jpg', sizes: SHOE_SIZES, colors: ['بني', 'بيج'],
  },
  {
    slug: 'women-sneakers', name: 'حذاء رياضي نسائي', description: 'حذاء رياضي أبيض بلمسات وردية خفيفة ونعل مريح للمشي اليومي والجامعة.', productType: 'أحذية', category: 'أحذية رياضية نسائية', price: 5200, image: '/mock/womens/sneakers.svg', sizes: SHOE_SIZES, colors: ['أبيض', 'وردي'],
  },
  {
    slug: 'camel-handbag', name: 'حقيبة كتف جلدية', description: 'حقيبة كتف بلون الجمل بجلد صناعي متين، تتسع للهاتف والمحفظة ومستحضرات اليوم.', productType: 'إكسسوارات', category: 'حقائب', price: 3900, image: '/mock/womens/handbag.jpg', sizes: ONE_SIZE, colors: ['جملي', 'أسود'],
  },
  {
    slug: 'gold-jewelry', name: 'طقم مجوهرات مذهّب', description: 'طقم مذهّب من عقد وأقراط بتصميم بسيط، مناسب للهدايا والمناسبات الصغيرة.', productType: 'إكسسوارات', category: 'مجوهرات', price: 2600, image: '/mock/womens/jewelry.jpg', sizes: ONE_SIZE, colors: ['ذهبي'],
  },
  {
    slug: 'printed-scarf', name: 'وشاح حرير مطبوع', description: 'وشاح حريري خفيف بطبعة بألوان باستيل، ينسّق مع الفساتين والبلوزات والقفاطين.', productType: 'إكسسوارات', category: 'أوشحة', price: 1800, image: '/mock/womens/scarf.svg', sizes: ONE_SIZE, colors: ['وردي', 'أزرق', 'بيج'],
  },
]

export const MOCK_CATALOGS = Object.freeze({
  [STORE_TYPES.MENS]: Object.freeze(MENS_CATALOG),
  [STORE_TYPES.WOMENS]: Object.freeze(WOMENS_CATALOG),
})

export function mockCatalogFor(storeType) {
  return MOCK_CATALOGS[normalizeStoreType(storeType)] || []
}

function mockId(storeType, slug) {
  return `mock-${normalizeStoreType(storeType)}-${slug}`
}

function mockBarcode(storeType, productIndex, variantIndex) {
  const prefix = normalizeStoreType(storeType) === STORE_TYPES.WOMENS ? 'MOCKW' : 'MOCKM'
  return `${prefix}${String(productIndex + 1).padStart(2, '0')}${String(variantIndex + 1).padStart(2, '0')}`
}

function variantsFor(storeType, product, productIndex) {
  return product.sizes.flatMap((size, sizeIndex) => product.colors.map((color, colorIndex) => ({
    id: `${mockId(storeType, product.slug)}-v${sizeIndex}-${colorIndex}`,
    size,
    color,
    barcode: mockBarcode(storeType, productIndex, sizeIndex * product.colors.length + colorIndex),
    min_price: Math.round(product.price * 0.55),
    available: 6 + ((productIndex + sizeIndex + colorIndex) % 5),
  })))
}

/** Shape consumed by the dashboard Products screen and the POS catalogue. */
export function mockDashboardProducts(storeType, storeId = null) {
  const type = normalizeStoreType(storeType)
  const branch = storeId || 'local-store'
  return MOCK_CATALOGS[type].map((product, index) => ({
    id: mockId(type, product.slug),
    name: product.name,
    description: product.description,
    category: product.productType,
    subcategory: product.category,
    base_price: product.price,
    images: [product.image],
    image_url: product.image,
    external_video_url: null,
    is_active: true,
    is_mock: true,
    product_variants: variantsFor(type, product, index).map(variant => ({
      ...variant,
      inventory: [{ store_id: branch, quantity: variant.available }],
    })),
  }))
}

/** Shape consumed by get_store_products()/normalizeProducts() in the storefront. */
export function mockStorefrontProducts(storeType) {
  const type = normalizeStoreType(storeType)
  return MOCK_CATALOGS[type].map((product, index) => ({
    id: mockId(type, product.slug),
    name: product.name,
    description: product.description,
    category: product.productType,
    subcategory: product.category,
    base_price: product.price,
    images: [product.image],
    image_url: product.image,
    external_video_url: null,
    is_active: true,
    is_mock: true,
    offers: [],
    variants: variantsFor(type, product, index).map(({ min_price, ...variant }) => variant),
  }))
}

export function mockProductsFor(storeType, shape = 'dashboard', storeId = null) {
  return shape === 'storefront' ? mockStorefrontProducts(storeType) : mockDashboardProducts(storeType, storeId)
}

/**
 * Appends demo rows to a real catalogue without duplicating IDs. A women's
 * store automatically gets the women's mock list; a men's store gets the clean
 * men's list. Real merchant products always stay first.
 */
export function mergeMockProducts(rows, storeType, storeId = null, shape = 'dashboard') {
  const real = Array.isArray(rows) ? rows : []
  const seen = new Set(real.map(row => row?.id))
  const demo = mockProductsFor(storeType, shape, storeId).filter(row => !seen.has(row.id))
  return [...real, ...demo]
}
