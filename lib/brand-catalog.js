const COMMON = ['Zara', 'H&M', 'LC Waikiki', 'Kiabi', 'DeFacto', 'Gémo', 'صناعة جزائرية', 'خياطة محلية']
export function brandsFor(productType, category = '', saved = []) {
  const sport = /رياضي|سنيكرز|تيشيرت|بولو/.test(category)
  const brands = productType === 'أحذية' || sport
    ? ['Nike', 'Adidas', 'Puma', 'New Balance', 'Reebok', 'Skechers', ...COMMON]
    : productType === 'إكسسوارات'
      ? ['Parfois', 'Mango', 'Casio', 'Fossil', ...COMMON]
      : /سهرة|فساتين|قفاطين/.test(category)
        ? ['Mango', 'Zara', 'H&M', 'خياطة محلية', ...COMMON]
        : COMMON
  return [...new Set([...brands, ...saved].map(cleanBrand).filter(Boolean))].map(value => ({ value, label: value }))
}
export function cleanBrand(value) { return String(value || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) }
