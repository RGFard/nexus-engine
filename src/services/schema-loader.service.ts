import fs from "node:fs/promises";
import path from "node:path";
import type { RegisteredSchema } from "../models/schema.types.js";
import { schemasRoot } from "../utils/paths.js";

const SCHEMA_FILE_SUFFIX = ".schema.json";

function schemaNameFromFile(filename: string): string {
  return filename.replace(/\.schema\.json$/, "");
}

function resolveMeta(
  domainDir: string,
  schema: Record<string, unknown>,
  fileName: string,
): Pick<RegisteredSchema, "domain" | "name" | "version" | "id" | "title" | "description"> {
  const name = schemaNameFromFile(fileName);
  const domain =
    (schema["x-canonical-domain"] as string | undefined) ??
    path.basename(domainDir);
  const version = (schema["x-canonical-version"] as string | undefined) ?? "1.0.0";
  const id = (schema["$id"] as string | undefined) ?? `canonical://${domain}/${name}`;

  return {
    domain,
    name,
    version,
    id,
    title: schema.title as string | undefined,
    description: schema.description as string | undefined,
  };
}

export class SchemaLoaderService {
  async loadAll(): Promise<RegisteredSchema[]> {
    const domains = await this.listDomainDirectories();
    const schemas: RegisteredSchema[] = [];

    for (const domainDir of domains) {
      const domainPath = path.join(schemasRoot, domainDir);
      const entries = await fs.readdir(domainPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(SCHEMA_FILE_SUFFIX)) {
          continue;
        }

        const filePath = path.join(domainPath, entry.name);
        const raw = await fs.readFile(filePath, "utf-8");
        const schema = JSON.parse(raw) as Record<string, unknown>;
        const meta = resolveMeta(domainDir, schema, entry.name);

        schemas.push({
          ...meta,
          filePath,
          schema,
        });
      }
    }

    return schemas;
  }

  private async listDomainDirectories(): Promise<string[]> {
    const entries = await fs.readdir(schemasRoot, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }
}
