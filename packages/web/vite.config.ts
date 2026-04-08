import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const suppress = (proxy: any) => {
  proxy.on("error", () => {});
  proxy.on("proxyReqWs", (_req: any, _socket: any, _head: any, _opts: any, err: any) => {
    if (err) err.handled = true;
  });
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3750",
        configure: suppress,
      },
      "/ws": {
        target: "ws://localhost:3750",
        ws: true,
        configure: suppress,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
