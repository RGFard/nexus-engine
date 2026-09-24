export type SchemaFieldKind = "primitive" | "object" | "array" | "extension" | "metadata";

/** Flattened field descriptor for semantic analysis */
export interface SchemaFieldDescriptor {
  path: string;
  name: string;
  kind: SchemaFieldKind;
  types: string[];
  description?: string;
  required: boolean;
  parentPath?: string;
  /** True when field lives under an `extensions` object */
  isExtension: boolean;
  /** Schema metadata (title, x-canonical-*, enum values) */
  metadata: Record<string, unknown>;
  /** Example value from sample payload when provided */
  exampleValue?: unknown;
  /** Resolved logistics parent context (origin, destination, package, etc.) */
  parentContext?: string;
}

export interface SchemaAnalysisResult {
  schemaId?: string;
  title?: string;
  version?: string;
  domain?: string;
  fields: SchemaFieldDescriptor[];
}
