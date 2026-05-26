/**
 * Extension point for future AI-assisted field mapping between carrier payloads
 * and canonical schemas. Implementations can be registered at runtime without
 * changing core validation or registry logic.
 */
export interface AiMappingContext {
  sourceSystem: string;
  targetDomain: string;
  targetSchemaName: string;
  sourcePayload: unknown;
}

export interface AiMappingResult {
  mappedPayload: unknown;
  confidence?: number;
  notes?: string[];
}

export interface AiMappingProvider {
  readonly name: string;
  map(context: AiMappingContext): Promise<AiMappingResult>;
}

export class AiMappingRegistry {
  private readonly providers = new Map<string, AiMappingProvider>();

  register(provider: AiMappingProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): AiMappingProvider | undefined {
    return this.providers.get(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }
}

export const aiMappingRegistry = new AiMappingRegistry();
