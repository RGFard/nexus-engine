export interface CanonicalSchemaMeta {
  domain: string;
  name: string;
  version: string;
  id: string;
  title?: string;
  description?: string;
}

export interface RegisteredSchema extends CanonicalSchemaMeta {
  filePath: string;
  schema: Record<string, unknown>;
}

export interface SchemaListItem {
  domain: string;
  name: string;
  version: string;
  id: string;
  title?: string;
  description?: string;
}

export interface ValidateSchemaRequest {
  domain: string;
  schemaName: string;
  version?: string;
  data: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors?: Array<{
    instancePath: string;
    schemaPath: string;
    keyword: string;
    message?: string;
    params?: Record<string, unknown>;
  }>;
}
