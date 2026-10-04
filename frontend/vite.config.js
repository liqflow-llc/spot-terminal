import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
    // @solana/web3.js expects Buffer in the browser.
    plugins: [react(), nodePolyfills({ include: ['buffer'], globals: { Buffer: true } })],
    server: {
        port: 5180,
        proxy: { '/api': { target: 'http://127.0.0.1:3020', changeOrigin: true } },
    },
});
