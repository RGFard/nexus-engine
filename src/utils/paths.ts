import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Project root (parent of `src`) */
export const projectRoot = path.resolve(__dirname, "..", "..");

/** Directory containing JSON Schema files */
export const schemasRoot = path.join(projectRoot, "src", "schemas");
