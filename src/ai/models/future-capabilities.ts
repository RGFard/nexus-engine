/**
 * Placeholder types for planned capabilities:
 * - Vector/embedding search over schema fields
 * - Multi-domain batch mapping
 * - Autonomous schema evolution proposals
 * - Runtime transformation pipeline registration
 */
export interface EmbeddingSearchOptions {
  topK: number;
  minScore: number;
}

export interface MultiDomainMappingRequest {
  domain: string;
  sourceSchema: Record<string, unknown>;
  targetSchema: Record<string, unknown>;
}
