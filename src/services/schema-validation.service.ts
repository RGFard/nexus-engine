import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type { RegisteredSchema, ValidationResult } from "../models/schema.types.js";
import type { SchemaRegistryService } from "./schema-registry.service.js";

type ValidationError = NonNullable<ValidationResult["errors"]>[number];

export class SchemaValidationService {
  private ajv: Ajv | null = null;
  private compiled = new Map<string, ValidateFunction>();

  constructor(private readonly registry: SchemaRegistryService) {}

  async initialize(): Promise<void> {
    this.ajv = new Ajv({
      allErrors: true,
      strict: false,
      validateSchema: false,
    });
    const addFormats = addFormatsModule as unknown as (instance: Ajv) => void;
    addFormats(this.ajv);

    const schemas = this.registry.getAllSchemas();
    for (const entry of schemas) {
      const id = entry.schema["$id"] as string | undefined;
      if (id) {
        this.ajv.addSchema(entry.schema, id);
      } else {
        this.ajv.addSchema(entry.schema);
      }
    }
  }

  validate(
    domain: string,
    schemaName: string,
    data: unknown,
    version?: string,
  ): ValidationResult {
    if (!this.ajv) {
      throw new Error("Validation service not initialized");
    }

    const registered = this.registry.get(domain, schemaName, version);
    if (!registered) {
      return {
        valid: false,
        errors: [
          {
            instancePath: "",
            schemaPath: "",
            keyword: "schema",
            message: `Schema not found: ${domain}/${schemaName}${version ? `@${version}` : ""}`,
          },
        ],
      };
    }

    const validateFn = this.getOrCompileValidator(registered);
    const valid = validateFn(data);

    if (valid) {
      return { valid: true };
    }

    return {
      valid: false,
      errors: (validateFn.errors ?? []).map(formatAjvError),
    };
  }

  private getOrCompileValidator(entry: RegisteredSchema): ValidateFunction {
    const key = `${entry.domain}:${entry.name}:${entry.version}`;
    const cached = this.compiled.get(key);
    if (cached) {
      return cached;
    }

    if (!this.ajv) {
      throw new Error("Validation service not initialized");
    }

    const id = entry.schema["$id"] as string | undefined;
    const fn = id ? this.ajv.getSchema(id) : this.ajv.compile(entry.schema);

    if (!fn) {
      throw new Error(`Failed to compile schema: ${entry.domain}/${entry.name}@${entry.version}`);
    }

    this.compiled.set(key, fn);
    return fn;
  }
}

function formatAjvError(error: ErrorObject): ValidationError {
  return {
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message,
    params: error.params as Record<string, unknown>,
  };
}
