'use client'

import { useEffect, useState } from 'react'
import DashboardShell from '@/components/dashboard/DashboardShell'
import { useDashboardSession } from '@/components/dashboard/SessionProvider'
import { Notice, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import { AssetPreview } from './StorefrontImageField'
import { storefrontContentBranch } from '@/lib/access'
import { signContentPreviews, PREVIEW_SECONDS } from '@/lib/dashboard-storefront-content'

const EMPTY = []

// Only sign the current page. Renew before expiry and when a background tab returns.
function useContentPreviews(rows, tenantId, storeId) {
  const [urls, setUrls] = useState({})
  useEffect(() => {
    setUrls({})
    if (!rows.length) return
    let request = 0
    async function renew() {
      const current = ++request
      let next = {}
      try { next = await signContentPreviews(rows, tenantId, storeId) } catch { /* keep the list usable */ }
      if (current === request) setUrls(next)
    }
    const visible = () => { if (!document.hidden) renew() }
    renew()
    const timer = window.setInterval(visible, (PREVIEW_SECONDS - 60) * 1000)
    document.addEventListener('visibilitychange', visible)
    return () => { ++request; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [rows, tenantId, storeId])
  return urls
}

function BranchContent({ tenantId, storeId, storeName, collection, idPrefix, title, description, Editor }) {
  const { loadPage, noun, plural, label } = collection
  const headingId = `${idPrefix}-list-heading`
  const [page, setPage] = useState(0)
  const [revision, setRevision] = useState(0)
  const [list, setList] = useState(null)
  const [editor, setEditor] = useState(null)
  const [success, setSuccess] = useState('')
  const refresh = () => setRevision(value => value + 1)
  useEffect(() => {
    let live = true
    setList(null)
    loadPage(tenantId, storeId, page).then(result => { if (live) setList(result) }, () => {
      if (live) setList({ error: `تعذر تحميل ${plural} الفرع. تحقق من الاتصال ثم أعد المحاولة.` })
    })
    return () => { live = false }
  }, [tenantId, storeId, page, revision, loadPage, plural])
  const rows = list?.rows || EMPTY
  const previews = useContentPreviews(rows, tenantId, storeId)
  function open(original) { setSuccess(''); setEditor({ original }) }
  function saved() {
    setSuccess(editor.original ? `تم تحديث ${label}.` : `تمت إضافة ${label}.`)
    if (!editor.original) setPage(0)
    setEditor(null); refresh()
  }
  return <div className="mx-auto max-w-4xl space-y-5">
    <nav aria-label="مسار الصفحة" className="flex items-center gap-2 text-xs text-neutral-400"><a href="/dashboard/settings" className="text-gold underline-offset-4 hover:underline">الإعدادات</a><span aria-hidden="true">/</span> المتجر الإلكتروني</nav>
    <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-gold/20 bg-card p-5">
      <div><p className="mb-2 text-xs text-gold">الفرع: {storeName}</p><h1 className="text-2xl font-bold">{title}</h1>
        <p className="mt-1 text-sm text-neutral-400">{description}</p></div>
      <button type="button" onClick={() => open(null)} className={`${primaryClass} inline-flex min-h-11 items-center gap-2`}><span aria-hidden="true">＋</span>إضافة {noun} جديد</button>
    </header>
    <Notice error={list?.error} success={success} />
    <section aria-labelledby={headingId} className="rounded-2xl border border-white/10 bg-card p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-3"><div><h2 id={headingId} className="font-medium">{plural} الفرع</h2>
        <p className="mt-1 text-xs text-neutral-400">حسب الترتيب، من الأصغر إلى الأكبر.</p></div>
        <button type="button" disabled={!list} onClick={refresh} className={`${secondaryClass} min-h-11`}>تحديث القائمة</button>
      </div>
      {!list ? <p role="status" className="py-8 text-center text-sm text-neutral-400">{`جاري تحميل ال${plural}…`}</p>
        : list.error ? null : !rows.length ? <div className="rounded-xl border border-dashed border-white/15 py-8 text-center">
          <p className="text-sm">{page ? `لا توجد ${plural} أخرى.` : `لا توجد ${plural} لهذا الفرع بعد.`}</p>
          {!page && <p className="mt-1 text-xs text-neutral-400">ابدأ بإضافة صورة وعنوان لأول {noun}.</p>}
        </div> : <ul className="divide-y divide-white/10">{rows.map(row => <li key={row.id} className="flex flex-wrap items-center gap-3 py-3 sm:gap-4">
          <div className="flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-black/30 sm:h-16 sm:w-32">
            <AssetPreview src={previews[row.image_url]} alt={`صورة ${row.title}`} empty={row.image_url ? 'لا تتوفر معاينة' : 'بدون صورة'} />
          </div>
          <div className="min-w-32 flex-1"><h3 className="break-words text-sm font-medium">{row.title}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs"><span className={`rounded-full px-2 py-0.5 ${row.status === 'published' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-white/10 text-neutral-300'}`}>{row.status === 'published' ? 'منشور' : 'مسودة'}</span>
              <span className="text-neutral-400">الترتيب: {row.sort_order}</span></div>
          </div>
          <button type="button" aria-label={`تعديل ${noun} ${row.title}`} onClick={() => open(row)} className={`${secondaryClass} min-h-11`}>تعديل</button>
        </li>)}</ul>}
      {list && (page > 0 || list.hasNext) && <nav aria-label={`صفحات ال${plural}`} className="mt-3 flex items-center justify-between gap-3 border-t border-white/10 pt-3 text-xs">
        <button type="button" disabled={!page} onClick={() => setPage(value => value - 1)} className={secondaryClass}>السابق</button>
        <span>صفحة {page + 1}</span><button type="button" disabled={!list.hasNext} onClick={() => setPage(value => value + 1)} className={secondaryClass}>التالي</button>
      </nav>}
    </section>
    {editor && <Editor tenantId={tenantId} storeId={storeId} original={editor.original} signedUrl={previews[editor.original?.image_url]}
      onClose={needsRefresh => { setEditor(null); if (needsRefresh) refresh() }} onSaved={saved} />}
  </div>
}

export default function StorefrontContentManager({ collection, idPrefix, title, description, Editor }) {
  const ctx = useDashboardSession(), branch = storefrontContentBranch(ctx)
  const management = `إدارة ال${collection.plural}`
  return <DashboardShell active="/dashboard/settings">
    {!branch ? <Notice error={`${management} تتطلب حساب مالك أو مدير وفرعاً محدداً من فروعه.`} />
      : ctx.offline ? <Notice error={`تحتاج ${management} إلى اتصال بالإنترنت.`} />
      : <BranchContent key={`${idPrefix}:${ctx.user.id}:${ctx.role}:${ctx.tenantId}:${branch.id}`} tenantId={ctx.tenantId} storeId={branch.id}
          storeName={branch.name} collection={collection} idPrefix={idPrefix} title={title} description={description} Editor={Editor} />}
  </DashboardShell>
}
