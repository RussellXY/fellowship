import { defineConfig } from 'vite';

export default defineConfig({
  base: '/stream/',   // ⚠️ 很重要，对应 nginx 路径
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  worker: {
    format: 'es'
  },
  optimizeDeps: {
    exclude: [
      '@ffmpeg/ffmpeg',
      '@ffmpeg/util',
      '@ffmpeg/core'
    ]
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8081',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true
      }
    }
  },
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV === 'development')
  }
});