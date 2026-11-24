import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  plugins: [viteSingleFile()],
  build: {
    outDir: resolve(__dirname, '../dist/ui'),
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
  },
});
