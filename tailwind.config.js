/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,jsx}',
    './components/**/*.{js,jsx}',
    './lib/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Phase 1: Tailwind names are bound to the CSS variables in
        // app/globals.css so the palette has a single source of truth.
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        surface: 'var(--surface)',
        card: 'var(--card)',
        // RGB channels so opacity modifiers (bg-gold/15, border-gold/30, …)
        // still generate. A bare var() colour cannot carry an alpha modifier.
        gold: 'rgb(var(--gold-rgb) / <alpha-value>)',
        border: 'var(--border)',
      },
      fontFamily: {
        tajawal: ['var(--font-tajawal)', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
