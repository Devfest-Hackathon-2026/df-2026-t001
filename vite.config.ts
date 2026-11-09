import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  build: {
    rollupOptions: {
      input: {
        leader: 'index.html',
        employee: 'employee.html',
      },
    },
  },
});
