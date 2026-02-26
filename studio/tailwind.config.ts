import type { Config } from 'tailwindcss';
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: { DEFAULT: '#1c1c1c', 100: '#2a2a2a', 200: '#333333', 300: '#444444' },
        brand: { DEFAULT: '#3ecf8e', dark: '#2ba873' },
      },
      fontFamily: { mono: ['JetBrains Mono', 'Fira Code', 'monospace'] },
    },
  },
  plugins: [],
} satisfies Config;
