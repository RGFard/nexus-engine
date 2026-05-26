import type { RegisteredSchema, SchemaListItem } from "../models/schema.types.js";
import { SchemaLoaderService } from "./schema-loader.service.js";

function registryKey(domain: string, name: string, version: string): string {
  return `${domain}:${name}:${version}`;
}

export class SchemaRegistryService {
  private readonly byKey = new Map<string, RegisteredSchema>();
  private readonly byDomainName = new Map<string, RegisteredSchema[]>();
  private loaded = false;

  constructor(private readonly loader = new SchemaLoaderService()) {}

  async initialize(): Promise<void> {
    if (this.loaded) {
      return;
    }

    const schemas = await this.loader.loadAll();

    for (const entry of schemas) {
      const key = registryKey(entry.domain, entry.name, entry.version);
      this.byKey.set(key, entry);

      const domainNameKey = `${entry.domain}:${entry.name}`;
      const versions = this.byDomainName.get(domainNameKey) ?? [];
      versions.push(entry);
      this.byDomainName.set(domainNameKey, versions);
    }

    this.loaded = true;
  }

  list(): SchemaListItem[] {
    return [...this.byKey.values()]
      .map(({ domain, name, version, id, title, description }) => ({
        domain,
        name,
        version,
        id,
        title,
        description,
      }))
      .sort((a, b) =>
        a.domain.localeCompare(b.domain) ||
        a.name.localeCompare(b.name) ||
        a.version.localeCompare(b.version),
      );
  }

  get(domain: string, schemaName: string, version?: string): RegisteredSchema | undefined {
    const domainNameKey = `${domain}:${schemaName}`;
    const versions = this.byDomainName.get(domainNameKey);

    if (!versions?.length) {
      return undefined;
    }

    if (version) {
      return this.byKey.get(registryKey(domain, schemaName, version));
    }

    return [...versions].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  }

  getAllSchemas(): RegisteredSchema[] {
    return [...this.byKey.values()];
  }

  getVersions(domain: string, schemaName: string): string[] {
    const domainNameKey = `${domain}:${schemaName}`;
    return (this.byDomainName.get(domainNameKey) ?? [])
      .map((s) => s.version)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  }
}

export const schemaRegistry = new SchemaRegistryService();
