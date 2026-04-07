import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // In dev, proxy API and WebSocket calls to the daemon
      "/api": {
        target: "http://localhost:3750",
        configure: (proxy) => {
          proxy.on("error", () => { /* suppress ECONNREFUSED during daemon startup */ });
        },
      },
      "/ws": {
        target: "ws://localhost:3750",
        ws: true,
        configure: (proxy) => {
          proxy.on("error", () => { /* suppress ECONNREFUSED during daemon startup */ });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
