import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        admin: path.resolve(import.meta.dirname, "admin.html"),
      },
    },
  },
});
