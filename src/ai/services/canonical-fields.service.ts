/**
 * Derives the set of valid canonical target paths from the schema registry.
 *
 * This is the INTEGRATION POINT the reference implementation pointed to: instead of
 * a hand-written CANONICAL_FIELDS set, we walk every registered schema and collect all
 * leaf field paths. Only the canonical TARGET is validated — input field names are
 * arbitrary by design and are never rejected.
 */

import type { SchemaRegistryService } from "../../services/schema-registry.service.js";
import { semanticMatcherService } from "./semantic-matcher.service.js";

export class CanonicalFieldsService {
  private leafPaths: Set<string> | null = null;

  constructor(private readonly registry: SchemaRegistryService) {}

  /** Build the leaf-path set from the registry. Safe to call multiple times. */
  initialize(): void {
    if (this.leafPaths) return;
    const paths = new Set<string>();
    for (const entry of this.registry.getAllSchemas()) {
      const analysis = semanticMatcherService.analyzeSchema(entry.schema);
      for (const field of analysis.fields) {
        if (field.kind !== "object") {
          paths.add(field.path);
        }
      }
    }
    this.leafPaths = paths;
  }

  /** True iff `path` is a real canonical leaf path (e.g. /packages[]/weight/value). */
  isCanonicalField(path: string): boolean {
    if (!this.leafPaths) throw new Error("CanonicalFieldsService.initialize() not called");
    return this.leafPaths.has(path);
  }

  getAllLeafPaths(): ReadonlySet<string> {
    if (!this.leafPaths) throw new Error("CanonicalFieldsService.initialize() not called");
    return this.leafPaths;
  }
}
