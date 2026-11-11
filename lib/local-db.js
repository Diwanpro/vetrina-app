const DB_NAME = 'vetrina-offline-v1'
let opening
export function openLocalDb() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('التخزين المحلي غير متاح. اسمح بـ IndexedDB لاستخدام نقطة البيع.'))
  if (!opening) opening = new Promise((resolve, reject) => {
    let blocked = false
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('kv', { keyPath: 'key' })
      db.createObjectStore('outbox', { keyPath: 'local_id' })
    }
    request.onsuccess = () => { if (blocked) { request.result.close(); return }; request.result.onversionchange = () => { request.result.close(); opening = null }; resolve(request.result) }
    request.onerror = () => { opening = null; reject(request.error) }
    request.onblocked = () => { blocked = true; opening = null; reject(new Error('أغلق تبويبات Vetrina القديمة لتحديث التخزين المحلي.')) }
  })
  return opening
}
export function localRequest(request) {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
}
export function transactionDone(transaction) {
  return new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error || new Error('تعذر حفظ البيانات المحلية')) })
}
export async function localGet(key) {
  const db = await openLocalDb()
  return (await localRequest(db.transaction('kv').objectStore('kv').get(key)))?.value
}
export async function localSet(key, value) {
  const db = await openLocalDb()
  const tx = db.transaction('kv', 'readwrite'); const done = transactionDone(tx)
  tx.objectStore('kv').put({ key, value }); await done
}
export async function localRows() {
  const db = await openLocalDb()
  return localRequest(db.transaction('outbox').objectStore('outbox').getAll())
}
export async function localPut(row) {
  const db = await openLocalDb()
  const tx = db.transaction('outbox', 'readwrite'); const done = transactionDone(tx)
  tx.objectStore('outbox').put(row); await done
}
export function catalogKey(ctx) { return `catalog:${ctx.user.id}:${ctx.tenantId}:${ctx.storeId}` }
export function belongsTo(row, ctx) {
  return row.auth_id === ctx.user.id && row.staff_id === ctx.staffId && row.tenant_id === ctx.tenantId && (ctx.allBranches ? ctx.storeIds.includes(row.store_id) : row.store_id === ctx.storeId)
}
export async function pendingRows(ctx) {
  return (await localRows()).filter(row => belongsTo(row, ctx) && row.status !== 'synced')
}
// Read stock, reserve it, and store the receipt in ONE local transaction. Two
// tabs cannot both spend the same cached stock. Failure never clears the cart.
export async function persistLocalSale(ctx, cart, payment, split = null) {
  if (!ctx.storeId || !ctx.staffId || !ctx.user?.id || ctx.locked) throw new Error('اختر فرعاً وحساباً نشطاً للبيع')
  if (!['cash', 'check', 'ccp'].includes(payment) || !cart.length || cart.length > 200) throw new Error('طريقة الدفع أو عدد بنود الفاتورة غير صالح')
  const db = await openLocalDb()
  const tx = db.transaction(['kv', 'outbox'], 'readwrite'); const done = transactionDone(tx)
  try {
    const kv = tx.objectStore('kv')
    const key = catalogKey(ctx)
    const cached = await localRequest(kv.get(key))
    if (!cached?.value) throw new Error('حمّل كتالوج هذا الفرع أثناء الاتصال أولاً')
    const products = structuredClone(cached.value)
    const ids = new Set()
    for (const item of cart) {
      if (ids.has(item.variantId)) throw new Error('مقاس مكرر في السلة')
      ids.add(item.variantId)
      const variant = products.flatMap(product => product.product_variants || []).find(variant => variant.id === item.variantId)
      const stock = variant?.inventory?.find(stock => stock.store_id === ctx.storeId)
      if (!stock || !Number.isSafeInteger(item.qty) || item.qty <= 0 || Number(stock.quantity) < item.qty) throw new Error(`المخزون المحلي غير كافٍ: ${item.name}`)
      if (!Number.isSafeInteger(item.originalPrice) || item.originalPrice < 0 || item.originalPrice > 2147483647 || !Number.isSafeInteger(item.price) || item.price < Number(variant.min_price || 0)) throw new Error('لا يمكن البيع بأقل من السعر الأدنى')
      stock.quantity = Number(stock.quantity) - item.qty
    }
    if (split) {
      // The remainder must reconcile to the ticket before it leaves the device.
      if (!Number.isSafeInteger(split.cash) || split.cash < 0) throw new Error('المبلغ النقدي غير صالح')
      if (!Number.isSafeInteger(split.amount) || split.amount <= 0) throw new Error('المبلغ المتبقي غير صالح')
      if (!['credit', 'check', 'ccp'].includes(split.method)) throw new Error('طريقة تسديد المتبقي غير صالحة')
      if (split.method === 'credit' && !String(split.customer_name || '').trim()) throw new Error('اسم الزبون مطلوب')
      if (split.method !== 'credit' && !String(split.receipt_url || '').trim()) throw new Error('أرفق صورة الشيك أو الوصل')
    }
    const row = {
      local_id: crypto.randomUUID(), kind: 'sale', status: 'pending', auth_id: ctx.user.id,
      tenant_id: ctx.tenantId, staff_id: ctx.staffId, store_id: ctx.storeId,
      created_at: new Date().toISOString(), payment_method: payment,
      items: cart.map(item => ({ variant_id: item.variantId, quantity: item.qty, final_price: item.price, original_price: item.originalPrice, name: item.name || '', color: item.color || '', size: item.size || '' })),
      total_amount: cart.reduce((sum, item) => sum + item.price * item.qty, 0),
      split: split || null,
    }
    if (!row.items.length || !Number.isSafeInteger(row.total_amount) || row.total_amount > 2147483647) throw new Error('مبلغ الفاتورة غير صالح')
    if (row.split && row.split.cash + row.split.amount !== row.total_amount) throw new Error('المدفوع نقداً والمتبقي لا يساويان إجمالي الفاتورة')
    kv.put({ key, value: products }); tx.objectStore('outbox').add(row)
    await done
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('vetrina:outbox'))
    return row
  } catch (err) { try { tx.abort() } catch {} await done.catch(() => {}); throw err }
}

export async function saveCatalog(ctx, products) {
  const db = await openLocalDb()
  const tx = db.transaction(['kv', 'outbox'], 'readwrite'); const done = transactionDone(tx)
  try {
    const rows = (await localRequest(tx.objectStore('outbox').getAll())).filter(row => row.kind === 'sale' && row.status !== 'synced' && belongsTo(row, ctx))
    const copy = structuredClone(products)
    for (const row of rows) for (const item of row.items) {
      const variant = copy.flatMap(product => product.product_variants || []).find(variant => variant.id === item.variant_id)
      const stock = variant?.inventory?.find(stock => stock.store_id === row.store_id)
      if (stock) stock.quantity = Math.max(0, Number(stock.quantity) - item.quantity)
    }
    tx.objectStore('kv').put({ key: catalogKey(ctx), value: copy }); await done
    return copy
  } catch (err) { try { tx.abort() } catch {} await done.catch(() => {}); throw err }
}
