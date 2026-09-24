import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, "..", "..");

export async function loadJson(relativePath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(projectRoot, relativePath), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}
