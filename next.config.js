/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['.monkeycode-ai.live', '*.e2b.app'],
  // The sidebar collapsed into seven grouped destinations. These keep old links
  // and bookmarks working, landing the user on the right tab.
  async redirects() {
    return [
      { source: '/dashboard/sales', destination: '/dashboard/operations?tab=sales', permanent: true },
      { source: '/dashboard/collections', destination: '/dashboard/operations?tab=collections', permanent: true },
      { source: '/dashboard/expenses', destination: '/dashboard/operations?tab=expenses', permanent: true },
      { source: '/dashboard/credits', destination: '/dashboard/customers-credit?tab=credits', permanent: true },
      { source: '/dashboard/customers', destination: '/dashboard/customers-credit?tab=customers', permanent: true },
      { source: '/dashboard/products', destination: '/dashboard/stock?tab=products', permanent: true },
      { source: '/dashboard/inventory', destination: '/dashboard/stock?tab=inventory', permanent: true },
      { source: '/dashboard/transfers', destination: '/dashboard/stock?tab=transfers', permanent: true },
      { source: '/dashboard/suppliers', destination: '/dashboard/stock?tab=suppliers', permanent: true },
      { source: '/dashboard/purchases', destination: '/dashboard/stock?tab=purchases', permanent: true },
      { source: '/dashboard/accounting', destination: '/dashboard/management?tab=accounting', permanent: true },
      { source: '/dashboard/users', destination: '/dashboard/management?tab=employees', permanent: true },
    ]
  },
}

module.exports = nextConfig
