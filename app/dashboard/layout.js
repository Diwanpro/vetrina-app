import SessionProvider from '@/components/dashboard/SessionProvider'
export default function DashboardLayout({ children }) {
  return <SessionProvider>{children}</SessionProvider>
}
