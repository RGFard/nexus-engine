import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Project root (parent of `src`) */
export const projectRoot = path.resolve(__dirname, "..", "..");

/** Directory containing JSON Schema files */
export const schemasRoot = path.join(projectRoot, "src", "schemas");

/** JSON Schemas of outbound target systems (not canonical, so not loaded by the registry) */
export const targetSchemasRoot = path.join(projectRoot, "src", "target-schemas");

/** Saved canonical -> target mapping plans, one folder per target system */
export const targetPlansRoot = path.join(projectRoot, "src", "target-plans");
