import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
Deno.serve(async req => {
  const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405)
  try {
    const authorization = req.headers.get('Authorization') || ''
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } })
    const { data: auth, error: authError } = await client.auth.getUser()
    if (authError || !auth.user) return reply({ error: 'يرجى تسجيل الدخول' }, 401)
    const { data: ctx, error: contextError } = await client.rpc('engine_session')
    if (contextError || ctx?.role !== 'owner') return reply({ error: 'للمالك فقط' }, 403)
    const body = await req.json()
    const username = String(body.username || '').trim().toLowerCase()
    const { pin, role, storeId, firstName, lastName, salaryType, salaryAmount, commissionPercentage = 0 } = body
    if (typeof firstName !== 'string' || !firstName.trim() || firstName.trim().length > 100 || typeof lastName !== 'string' || !lastName.trim() || lastName.trim().length > 100 || !['fixed', 'commission', 'fixed_commission', 'daily'].includes(salaryType) || !Number.isSafeInteger(salaryAmount) || salaryAmount < 0 || salaryAmount > 2147483647) return reply({ error: 'بيانات الموارد البشرية غير صالحة' }, 400)
    if (typeof commissionPercentage !== 'number' || !Number.isFinite(commissionPercentage) || commissionPercentage < 0 || commissionPercentage > 100 || Math.abs(commissionPercentage * 100 - Math.round(commissionPercentage * 100)) > 0.000001) return reply({ error: 'نسبة العمولة غير صالحة' }, 400)
    if (!/^[a-z0-9_]{3,40}$/.test(username) || typeof pin !== 'string' || !/^\d{6,12}$/.test(pin) || !['manager', 'employee'].includes(role) || !ctx.stores.some((s: { id: string }) => s.id === storeId)) return reply({ error: 'اسم لاتيني 3–40 حرفاً، PIN من 6–12 رقماً، ودور وفرع صالح مطلوب' }, 400)
    if (ctx.tenant?.is_active === false && ctx.tenant.subscription_end_date && new Date(ctx.tenant.subscription_end_date).getTime() < Date.now()) return reply({ error: 'انتهى الاشتراك' }, 403)
    // Built-in Edge Function secret; never sent to the browser or stored in Git.
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
    const { data, error } = await admin.auth.admin.createUser({ email: `${username}@staff.vetrina.dz`, password: pin, email_confirm: true, app_metadata: { created_by_owner: auth.user.id } })
    if (error || !data.user) return reply({ error: 'تعذر إنشاء الحساب. قد يكون الاسم مستخدماً أو PIN لا يطابق سياسة كلمات المرور.' }, 409)
    const { error: profileError } = await client.rpc('engine_register_employee_hr', { p_auth: data.user.id, p_username: username, p_role: role, p_store: storeId, p_first: firstName.trim(), p_last: lastName.trim(), p_salary_type: salaryType, p_salary_amount: salaryType === 'commission' ? 0 : salaryAmount, p_commission_percentage: ['commission', 'fixed_commission'].includes(salaryType) ? commissionPercentage : 0 })
    if (profileError) {
      const { error: cleanupError } = await admin.auth.admin.deleteUser(data.user.id)
      // Operational breadcrumb only, never log PIN or bearer tokens.
      if (cleanupError) console.error('Employee profile compensation failed', data.user.id)
      return reply({ error: 'تعذر حفظ ملف الموظف. حدّث القائمة قبل إعادة المحاولة.' }, 400)
    }
    return reply({ success: true })
  } catch {
    return reply({ error: 'تعذر إكمال الطلب. حدّث القائمة قبل إعادة المحاولة.' }, 500)
  }
})
