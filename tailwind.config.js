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
        gold: 'var(--gold)',
        border: 'var(--border)',
      },
      fontFamily: {
        tajawal: ['var(--font-tajawal)', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
