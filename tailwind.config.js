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
        gold: '#D4AF37',
        surface: '#121212',
        card: '#1A1A1A',
      },
      fontFamily: {
        tajawal: ['var(--font-tajawal)', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
