import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.VITE_API_PROXY || 'http://localhost:8791';
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': target } },
  preview: { port: 4173, proxy: { '/api': target } },
});
