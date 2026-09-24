import type { SchemaRegistryService } from "../../services/schema-registry.service.js";

/**
 * Resolves canonical:// JSON Schema $ref URIs using the loaded schema registry.
 */
export class SchemaRefResolver {
  private readonly byId = new Map<string, Record<string, unknown>>();

  loadFromRegistry(registry: SchemaRegistryService): void {
    this.byId.clear();
    for (const entry of registry.getAllSchemas()) {
      const id = entry.schema.$id as string | undefined;
      if (id) {
        this.byId.set(id, entry.schema);
      }
    }
  }

  resolve(ref: string): Record<string, unknown> | undefined {
    return this.byId.get(ref);
  }

  size(): number {
    return this.byId.size;
  }
}

export const schemaRefResolver = new SchemaRefResolver();
