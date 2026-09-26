import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  publicDir: false,
  build: {
    target: 'esnext',
    outDir: '.local/browser-build',
    emptyOutDir: true,
    lib: { entry: 'src/browser/entry.ts', formats: ['es'], fileName: 'fair-launch-client' },
    rollupOptions: {
      output: { manualChunks: { wasm: ['@midnight-ntwrk/onchain-runtime-v3'] } },
    },
    commonjsOptions: { transformMixedEsModules: true, extensions: ['.js', '.cjs'], ignoreDynamicRequires: true },
  },
  plugins: [
    wasm(),
    {
      name: 'wasm-module-resolver',
      resolveId(source, importer) {
        if (source === '@midnight-ntwrk/onchain-runtime-v3' && importer?.includes('@midnight-ntwrk/compact-runtime')) {
          return { id: source, external: false, moduleSideEffects: true };
        }
        return null;
      },
    },
  ],
  optimizeDeps: {
    esbuildOptions: { target: 'esnext', supported: { 'top-level-await': true }, platform: 'browser', format: 'esm', loader: { '.wasm': 'binary' } },
    include: ['@midnight-ntwrk/compact-runtime'],
    exclude: ['@midnight-ntwrk/onchain-runtime-v3'],
  },
  resolve: { extensions: ['.mjs', '.js', '.ts', '.wasm'], mainFields: ['browser', 'module', 'main'] },
});
