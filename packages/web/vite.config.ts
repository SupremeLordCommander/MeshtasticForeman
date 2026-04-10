import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const suppress = (proxy: any) => {
  proxy.on("error", () => {});
  proxy.on("proxyReqWs", (_req: any, _socket: any, _head: any, _opts: any, err: any) => {
    if (err) err.handled = true;
  });
};

export default defineConfig(({ mode }) => {
  // Load root .env so all API_* and FRONTEND_* vars are available
  const env = loadEnv(mode, resolve(__dirname, "../../"), "");

  const apiPort        = env.API_PORT        ?? "3750";
  const apiUri         = env.API_URI         ?? "http://localhost";
  const frontendHost   = env.FRONTEND_HOST   ?? "0.0.0.0";
  const frontendPort   = Number(env.FRONTEND_PORT ?? 5173);

  const apiBase = `${apiUri}:${apiPort}`;
  const wsBase  = apiBase.replace(/^http/, "ws");

  return {
    plugins: [react()],
    server: {
      host: frontendHost,
      port: frontendPort,
      proxy: {
        "/api": {
          target: apiBase,
          configure: suppress,
        },
        "/ws": {
          target: wsBase,
          ws: true,
          configure: suppress,
        },
      },
    },
    envDir: resolve(__dirname, "../../"),
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
