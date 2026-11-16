// Backend and peripheral boundary stubs. The actual three screens and CustomSelect are rendered.
export const hybridUIModules={
 '@/lib/supabase':`export const supabase=new Proxy({}, {get:(_,k)=>globalThis.__hybridUI.supabase[k]})`,
 '@/lib/app-context':`export const getAppContext=async()=>globalThis.__hybridUI.context; export const formatDzd=n=>String(n)+' دج'`,
 '@/lib/sync':`export const cacheCatalog=async(c,p)=>p; export const cachedCatalog=async()=>globalThis.__hybridUI.products; export const syncPending=async()=>{}`,
 '@/lib/audit':`export const logAction=async()=>{}`,
 '@/lib/offers':`export const applyOffers=c=>c; export const lineSubtotal=i=>i.qty*i.price; export const cacheOffers=(t,o)=>o; export const cachedOffers=()=>[]; export const posOffers=()=>[]`,
 '@/lib/mock-catalog':`export const mergeMockProducts=p=>p`,
 '@/lib/push/client':`export const notifyBranchPush=async()=>{}`,
 '@/lib/subcategories':`export const loadCustomSubcategories=async()=>[]; export const saveCustomSubcategory=async()=>null`,
 '@/components/dashboard/DashboardShell':`export default function Shell({children}){return <main>{children}</main>}`,
 '@/components/dashboard/BranchStoreLinks':`export const StorefrontLink=()=>null`,
 '@/components/dashboard/ReceiptPrinter':`export default ()=>null`,
 '@/components/dashboard/MixedPaymentModal':`export default ()=>null`,
 '@/components/store/ProductImage':`export default ()=>null`,
 '@/components/store/StoreTabRail':`export default ()=>null; export const buildStoreTabs=()=>[{key:'all',label:'الكل'}]`,
 '@/components/VoiceInput':`export default ()=>null`,
 'jsbarcode':`export default (svg,code)=>{svg.setAttribute('data-code',code);globalThis.__hybridUI.printed.push(code)}`,
}
