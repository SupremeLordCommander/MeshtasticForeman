import { PGlite } from "@electric-sql/pglite";
import { parentPort, workerData } from "node:worker_threads";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

if (!parentPort) throw new Error("Must be run as a worker thread");

const port = parentPort;

mkdirSync(workerData.dataDir, { recursive: true });

// Remove stale postmaster.pid left by a previous unclean shutdown.
// Without this PGlite's embedded Postgres aborts with a WASM RuntimeError.
const pidFile = join(workerData.dataDir, "postmaster.pid");
if (existsSync(pidFile)) rmSync(pidFile);

const db = new PGlite(workerData.dataDir);

port.on("message", async (msg: { id: string; type: "query" | "exec" | "close"; sql?: string; params?: unknown[] }) => {
  const { id, type, sql, params } = msg;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any = null;
    if (type === "query") {
      result = await db.query(sql!, params);
    } else if (type === "exec") {
      await db.exec(sql!);
    } else if (type === "close") {
      await db.close();
    }
    port.postMessage({ id, result });
  } catch (err: unknown) {
    const e = err as { message?: string; code?: string };
    port.postMessage({ id, error: { message: e.message, code: e.code } });
  }
});

db.waitReady
  .then(() => port.postMessage({ type: "ready" }))
  .catch((err) => {
    port.postMessage({ type: "init-error", error: String(err) });
    process.exit(1);
  });
