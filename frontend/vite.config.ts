import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig(({ mode }) => {
  // Not VITE_-prefixed, so it is never exposed to the browser bundle.
  const relaySecret = loadEnv(mode, process.cwd(), '').PAGA_RELAY_SECRET

  return {
    plugins: [
      tailwindcss(),
      react(),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      allowedHosts: true,
      proxy: {
        // Dev-only Paga relay. Paga's Business API only accepts calls from
        // whitelisted IPs and Convex has none, so convex/pagaApi.ts (with
        // PAGA_RELAY_URL set) sends Business API calls here, through ngrok, and
        // they reach Paga sandbox from this machine's IP. Requests without the
        // shared secret get a 404 and are never forwarded.
        '/paga-relay': {
          target: 'https://beta.mypaga.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/paga-relay/, ''),
          bypass: (req) =>
            relaySecret && req.headers['x-chop-relay-secret'] === relaySecret ? undefined : false,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.removeHeader('x-chop-relay-secret')
              proxyReq.removeHeader('ngrok-skip-browser-warning')
            })
          },
        },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/react-router')) {
              return 'react-vendor'
            }
            if (id.includes('node_modules/framer-motion')) {
              return 'framer'
            }
            if (id.includes('node_modules/recharts')) {
              return 'charts'
            }
            if (id.includes('node_modules/convex') || id.includes('node_modules/@convex-dev')) {
              return 'convex'
            }
          },
        },
      },
    },
  }
})
