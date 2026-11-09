import { NAV_ITEMS } from './navItems'

export default function BottomNav({ active = '/dashboard' }) {
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-white/5 bg-[#161616]/95 backdrop-blur">
      <div className="flex overflow-x-auto">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const isActive = item.href === active
          return (
            <a
              key={item.href}
              href={item.href}
              className={`flex min-w-[72px] flex-1 flex-col items-center py-2 px-1 ${
                isActive ? 'text-gold' : 'text-neutral-500'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span className="mt-1 text-[9px] leading-tight whitespace-nowrap">{item.label}</span>
            </a>
          )
        })}
      </div>
    </nav>
  )
}
