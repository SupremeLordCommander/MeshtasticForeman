import { PGlite } from "@electric-sql/pglite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PGLITE_DIR ?? join(__dirname, "../../../../pglite-data");

// Single PGlite instance for the daemon process.
// PGlite is not thread-safe across processes — one daemon owns the DB.
export const db = new PGlite(DATA_DIR);
