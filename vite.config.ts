import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
      output: {
        // Keep bare imports as-is — resolved by import map at runtime
        format: 'es',
        paths: {
          'react': 'react',
          'react-dom': 'react-dom',
          'react-dom/client': 'react-dom/client',
          'react/jsx-runtime': 'react/jsx-runtime',
          'react/jsx-dev-runtime': 'react/jsx-dev-runtime',
        },
      },
    },
  },
});
