'use client'

import { useState, useEffect } from 'react'
import { useDashboardSession } from '@/components/dashboard/SessionProvider'
import { Notice, fieldClass, primaryClass, secondaryClass } from '@/components/dashboard/EngineUI'
import CustomSelect from '@/components/ui/CustomSelect'
import { supabase } from '@/lib/supabase'
import { scopeQuery, csvText } from '@/lib/access'
import { fetchAllRows } from '@/lib/cash'
import { formatDzd } from '@/lib/app-context'

const ROLE_OPTIONS = [
  { label: 'المالك', value: 'owner' },
  { label: 'المدير', value: 'manager' },
  { label: 'الموظف', value: 'employee' },
]

const STATUS_OPTIONS = [
  { label: 'نشط', value: 'active' },
  { label: 'معلّق', value: 'suspended' },
]

export default function UsersPage() {
  const ctx = useDashboardSession()
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('employee')
  const [status, setStatus] = useState('active')
  const [storeId, setStoreId] = useState(ctx?.stores?.[0]?.id || '')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  async function refresh() {
    if (!ctx?.tenantId) return
    setBusy(true); setError('')
    try {
      const query = supabase.from('dashboard_users').select('id, name, email, role, status, store_id, created_at, stores!inner(name)').eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false })
      const data = await fetchAllRows(scopeQuery(query, ctx, 'store_id', 'stores.tenant_id'))
      setRows(data)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  useEffect(() => {
    if (ctx?.tenantId) refresh()
  }, [ctx?.tenantId])

  async function exportData() {
    if (!navigator.onLine) throw new Error('تصدير بيانات المستخدمين يتطلب الاتصال')
    if (ctx.role !== 'owner') throw new Error('غير مصرح بالتصدير')
    const data = await fetchAllRows(scopeQuery(supabase.from('dashboard_users').select('id, name, email, role, status, store_id, created_at, stores!inner(name)').eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false }), ctx))
    download('vetrina-users.csv', csvText([
      { key: 'id', label: 'المعرّف' }, { key: 'name', label: 'الاسم' }, { key: 'email', label: 'البريد الإلكتروني' }, { key: 'role', label: 'الدور' }, { key: 'status', label: 'الحالة' }, { key: 'store_id', label: 'الفرع' }, { key: 'created_at', label: 'تاريخ الإنشاء' },
    ], data))
  }

  function download(name, text, type = 'text/csv;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([text], { type }))
    const link = document.createElement('a'); link.href = url; link.download = name; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function add() {
    if (busy) return
    if (!name || !email || !password) { setError('يرجى تعبئة الاسم والبريد الإلكتروني وكلمة المرور'); return }
    if (password !== confirmPassword) { setError('كلمة المرور وتأكيدها غير متطابقين'); return }
    if (!navigator.onLine) { setError('إضافة مستخدم تتطلب الاتصال'); return }
    if (!['owner', 'manager'].includes(ctx.role)) { setError('غير مصرح بإضافة مستخدمين'); return }
    
    setBusy(true); setError('')
    try {
      const { error: authErr } = await supabase.auth.signUp({
        email, password,
        options: {
          data: {
            full_name: name,
            role,
            status,
            store_id: storeId || null,
            tenant_id: ctx.tenantId,
            created_by: ctx.user.id,
          }
        }
      })
      if (authErr) throw authErr
      await refresh()
      setName(''); setEmail(''); setPassword(''); setConfirmPassword(''); setRole('employee'); setStatus('active'); setStoreId(ctx?.stores?.[0]?.id || '')
      setError('تمت إضافة المستخدم بنجاح')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  async function toggleStatus(id, currentStatus) {
    if (busy) return
    if (!['owner', 'manager'].includes(ctx.role)) { setError('غير مصرح بتغيير الحالة'); return }
    if (!navigator.onLine) { setError('تغيير الحالة يتطلب الاتصال'); return }
    const nextStatus = currentStatus === 'active' ? 'suspended' : 'active'
    setBusy(true); setError('')
    try {
      const { error } = await supabase.from('dashboard_users').update({ status: nextStatus }).eq('id', id).eq('tenant_id', ctx.tenantId)
      if (error) throw error
      await refresh()
      setError(`تم تغيير الحالة إلى ${nextStatus === 'active' ? 'نشط' : 'معلّق'}`)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  return (
    <>
      <div className="mx-auto max-w-5xl space-y-5">
        <h1 className="text-xl text-neutral-100">المستخدمون</h1>
        <Notice error={error} />
        
        {ctx.role !== 'employee' && (
          <section className="rounded-2xl border border-white/10 bg-card p-5">
            <h2 className="mb-3 text-gold">إضافة مستخدم جديد</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="block text-sm text-neutral-300">الاسم
                <input required value={name} onChange={e => setName(e.target.value)} className={`${fieldClass} mt-1`} />
              </label>
              <label className="block text-sm text-neutral-300">البريد الإلكتروني
                <input type="email" required value={email} onChange={e => setEmail(e.target.value)} className={`${fieldClass} mt-1`} />
              </label>
              <label className="block text-sm text-neutral-300">كلمة المرور
                <input type="password" required value={password} onChange={e => setPassword(e.target.value)} className={`${fieldClass} mt-1`} />
              </label>
              <label className="block text-sm text-neutral-300">تأكيد كلمة المرور
                <input type="password" required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className={`${fieldClass} mt-1`} />
              </label>
              <label className="block text-sm text-neutral-300">الدور
                <CustomSelect value={role} onChange={e => setRole(e)} options={ROLE_OPTIONS} className={`${fieldClass} mt-1`} />
              </label>
              <label className="block text-sm text-neutral-300">الحالة
                <CustomSelect value={status} onChange={e => setStatus(e)} options={STATUS_OPTIONS} className={`${fieldClass} mt-1`} />
              </label>
              <label className="block text-sm text-neutral-300">الفرع
                <CustomSelect value={storeId} onChange={e => setStoreId(e)} options={ctx.stores.map(s => ({ label: s.name, value: s.id }))} className={`${fieldClass} mt-1`} />
              </label>
            </div>
            <button disabled={busy} onClick={add} className={primaryClass}>{busy ? 'جاري الإضافة...' : 'إضافة مستخدم'}</button>
          </section>
        )}

        <section className="rounded-2xl border border-white/10 bg-card p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-gold">قائمة المستخدمين · {rows.length}</h2>
            {ctx.role === 'owner' && (
              <button disabled={busy} onClick={() => run(exportData)} className={secondaryClass}>تصدير CSV</button>
            )}
          </div>
          
          {!rows.length ? (
            <p className="text-sm text-neutral-500">لا يوجد مستخدمون مسجلون.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 text-sm text-neutral-400">
                    <th className="py-3 px-4">الاسم</th>
                    <th className="py-3 px-4">البريد الإلكتروني</th>
                    <th className="py-3 px-4">الدور</th>
                    <th className="py-3 px-4">الفرع</th>
                    <th className="py-3 px-4">الحالة</th>
                    <th className="py-3 px-4">تاريخ الإنشاء</th>
                    <th className="py-3 px-4">الإجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.id} className="border-b border-white/5 hover:bg-white/5">
                      <td className="py-3 px-4 text-sm text-neutral-200">{row.name}</td>
                      <td className="py-3 px-4 text-sm text-neutral-300">{row.email}</td>
                      <td className="py-3 px-4 text-sm text-neutral-300">{
                        ROLE_OPTIONS.find(opt => opt.value === row.role)?.label || row.role
                      }</td>
                      <td className="py-3 px-4 text-sm text-neutral-300">{
                        ctx.stores.find(s => s.id === row.store_id)?.name || 'كل الفروع'
                      }</td>
                      <td className="py-3 px-4">
                        <span className={`inline-flex rounded-full px-2 py-1 text-xs ${
                          row.status === 'active' ? 'bg-emerald-950/40 border border-emerald-700/40 text-emerald-300' : 'bg-red-950/40 border border-red-700/40 text-red-300'
                        }`}>
                          {row.status === 'active' ? 'نشط' : 'معلّق'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-xs text-neutral-500">{new Date(row.created_at).toLocaleString('ar-DZ')}</td>
                      <td className="py-3 px-4">
                        {ctx.role !== 'employee' && row.id !== ctx.user.id && (
                          <button disabled={busy} onClick={() => toggleStatus(row.id, row.status)} className={`rounded-lg px-3 py-1.5 text-xs ${
                            row.status === 'active' ? 'border border-red-800/40 text-red-300' : 'border border-emerald-800/40 text-emerald-300'
                          }`}>
                            {row.status === 'active' ? 'تعليق' : 'تنشيط'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  )
}
