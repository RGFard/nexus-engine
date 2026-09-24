export interface AiConfig {
  anthropicApiKey?: string;
  anthropicModel: string;
  anthropicMaxTokens: number;
  mappingEnabled: boolean;
  /** Invoke Anthropic when heuristic average confidence is below this (0–1) */
  aiFallbackThreshold: number;
  /** Enable AI fallback for low-confidence or unmapped required fields */
  aiFallbackEnabled: boolean;
  /**
   * Candidates strictly below this score are withheld from auto-apply and placed
   * in `lowConfidenceMappings` for human review instead.
   * Env: MAPPING_AUTO_APPLY_THRESHOLD (0–1, default 0.45)
   */
  autoApplyThreshold: number;
}

export function loadAiConfig(): AiConfig {
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicModel:
      process.env.ANTHROPIC_MODEL ??
      process.env.ANTHROPIC_TEXT_MODEL ??
      "claude-sonnet-4-20250514",
    anthropicMaxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS ?? 4096),
    mappingEnabled: process.env.AI_MAPPING_ENABLED !== "false",
    aiFallbackThreshold: Number(process.env.AI_FALLBACK_THRESHOLD ?? 0.75),
    aiFallbackEnabled: process.env.AI_FALLBACK_ENABLED !== "false",
    autoApplyThreshold: Number(process.env.MAPPING_AUTO_APPLY_THRESHOLD ?? 0.45),
  };
}
