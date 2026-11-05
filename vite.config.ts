import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  clearScreen: false,
  server: { host: '127.0.0.1' },
});
