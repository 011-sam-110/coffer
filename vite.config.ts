/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

const host = process.env.TAURI_DEV_HOST;
const root = import.meta.dirname;

// Two pages, one build: index.html is the main window (label "main"),
// quick.html is the Quick Access popup (label "quick").
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],

  // Keep Rust errors visible and use the fixed port Tauri expects.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/.shots/**"] },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        quick: resolve(root, "quick.html"),
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
