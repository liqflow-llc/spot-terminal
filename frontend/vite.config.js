import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
    // @solana/web3.js expects Buffer in the browser.
    plugins: [react(), nodePolyfills({ include: ['buffer'], globals: { Buffer: true } })],
    build: {
        rolldownOptions: {
            output: {
                // Libraries in their own long-cached chunks: a deploy of our code doesn't make
                // returning visitors download React and the Solana libraries again.
                advancedChunks: {
                    groups: [
                        { name: 'react', test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/ },
                        { name: 'solana', test: /node_modules[\\/](@solana|@noble|bn\.js|buffer|bs58|base-x|rpc-websockets|superstruct|borsh|jayson|@wallet-standard)[\\/]/ },
                    ],
                },
            },
        },
    },
    // Pre-bundle the Buffer shim the polyfill plugin injects. Found only once the page loads, it
    // made Vite reload the page on a first `npm run dev` (cutting off a wallet connection).
    optimizeDeps: { include: ['vite-plugin-node-polyfills/shims/buffer'] },
    server: {
        port: 5180,
        proxy: { '/api': { target: 'http://127.0.0.1:3020', changeOrigin: true } },
    },
});
