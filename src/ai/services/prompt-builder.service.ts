import fs from "node:fs/promises";
import path from "node:path";
import type { CandidateMapping } from "../models/mapping.types.js";
import type { SchemaAnalysisResult } from "../models/schema-field.types.js";
import { projectRoot } from "../../utils/paths.js";
import { aiLog } from "../utils/ai-logger.js";

const log = aiLog("prompt-builder");

const promptsDir = path.join(projectRoot, "src", "ai", "prompts");

const PROMPT_FILES = {
  schemaUnderstanding: "schema-understanding.prompt.md",
  canonicalNormalization: "canonical-normalization.prompt.md",
  semanticFieldMatching: "semantic-field-matching.prompt.md",
  transformationGeneration: "transformation-generation.prompt.md",
} as const;

export interface MappingPromptInput {
  sourceAnalysis: SchemaAnalysisResult;
  targetAnalysis: SchemaAnalysisResult;
  candidates: CandidateMapping[];
  sourceExamplePayload?: Record<string, unknown>;
  targetExamplePayload?: Record<string, unknown>;
}

export class PromptBuilderService {
  private templateCache = new Map<string, string>();

  async buildMappingPrompt(input: MappingPromptInput): Promise<{
    systemPrompt: string;
    userPrompt: string;
  }> {
    const [schemaUnderstanding, canonicalNormalization, semanticMatching, transformationGen] =
      await Promise.all([
        this.loadTemplate(PROMPT_FILES.schemaUnderstanding),
        this.loadTemplate(PROMPT_FILES.canonicalNormalization),
        this.loadTemplate(PROMPT_FILES.semanticFieldMatching),
        this.loadTemplate(PROMPT_FILES.transformationGeneration),
      ]);

    const systemPrompt = [
      "# Role",
      "You are an enterprise integration architect generating JSON field mapping plans between schemas.",
      "",
      schemaUnderstanding,
      "",
      canonicalNormalization,
      "",
      semanticMatching,
      "",
      transformationGen,
    ].join("\n");

    const userPrompt = this.buildUserPrompt(input);

    log.info(
      {
        systemPromptLength: systemPrompt.length,
        userPromptLength: userPrompt.length,
        candidateCount: input.candidates.length,
      },
      "Mapping prompt built",
    );

    return { systemPrompt, userPrompt };
  }

  private buildUserPrompt(input: MappingPromptInput): string {
    const sections: string[] = [
      "## Source schema",
      "```json",
      JSON.stringify(this.summarizeSchemaForPrompt(input.sourceAnalysis), null, 2),
      "```",
      "",
      "## Target schema",
      "```json",
      JSON.stringify(this.summarizeSchemaForPrompt(input.targetAnalysis), null, 2),
      "```",
      "",
      "## Source fields (flattened)",
      "```json",
      JSON.stringify(input.sourceAnalysis.fields.map(fieldLine), null, 2),
      "```",
      "",
      "## Target fields (flattened)",
      "```json",
      JSON.stringify(input.targetAnalysis.fields.map(fieldLine), null, 2),
      "```",
      "",
      "## Pre-computed semantic candidates",
      "```json",
      JSON.stringify(input.candidates, null, 2),
      "```",
    ];

    if (input.sourceExamplePayload) {
      sections.push(
        "",
        "## Source example payload",
        "```json",
        JSON.stringify(input.sourceExamplePayload, null, 2),
        "```",
      );
    }

    if (input.targetExamplePayload) {
      sections.push(
        "",
        "## Target example payload",
        "```json",
        JSON.stringify(input.targetExamplePayload, null, 2),
        "```",
      );
    }

    sections.push(
      "",
      "## Task",
      "Generate the complete mapping plan JSON. Map nested paths and arrays correctly.",
      "Route carrier-specific fields to extensions when appropriate.",
      "Include reasoning for each mapping.",
      "CRITICAL: Only use target field paths from the target fields list above.",
      "Never map the same source field to more than one target field.",
      "Each source field gets exactly one best-match target.",
    );

    return sections.join("\n");
  }

  private summarizeSchemaForPrompt(analysis: SchemaAnalysisResult): Record<string, unknown> {
    return {
      $id: analysis.schemaId,
      title: analysis.title,
      version: analysis.version,
      domain: analysis.domain,
      fieldCount: analysis.fields.length,
      requiredFields: analysis.fields.filter((f) => f.required).map((f) => f.path),
      extensionFields: analysis.fields.filter((f) => f.isExtension).map((f) => f.path),
    };
  }

  private async loadTemplate(filename: string): Promise<string> {
    const cached = this.templateCache.get(filename);
    if (cached) {
      return cached;
    }
    const content = await fs.readFile(path.join(promptsDir, filename), "utf-8");
    this.templateCache.set(filename, content);
    return content;
  }
}

function fieldLine(f: {
  path: string;
  name: string;
  kind: string;
  types: string[];
  required: boolean;
  description?: string;
  isExtension: boolean;
  exampleValue?: unknown;
}): Record<string, unknown> {
  return {
    path: f.path,
    name: f.name,
    kind: f.kind,
    types: f.types,
    required: f.required,
    isExtension: f.isExtension,
    ...(f.description ? { description: f.description } : {}),
    ...(f.exampleValue !== undefined ? { example: f.exampleValue } : {}),
  };
}

export const promptBuilderService = new PromptBuilderService();
