/**
 * Per-client custom vocabulary store.
 *
 * Per-client isolation is enforced structurally:
 *   - Every method is keyed on clientId.
 *   - No "list all clients" or cross-client read path exists on the interface.
 *   - JsonFileVocabularyStore uses one file per client so a bug in one blob
 *     cannot leak into another's.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { VocabularyEntry } from "../models/vocabulary.types.js";

export interface CustomVocabularyStore {
  /** Load THIS client's learned vocabulary only. Returns inputField → canonicalField. */
  load(clientId: string): Promise<Map<string, string>>;
  /** Persist entries for ONE client. Merges with that client's existing vocab only. */
  accept(clientId: string, entries: VocabularyEntry[]): Promise<VocabularyEntry[]>;
}

function requireClientId(clientId: string): void {
  if (!clientId || typeof clientId !== "string") {
    throw new Error("clientId is required and must be a non-empty string");
  }
}

/** In-memory store — used in tests and when VOCAB_DIR is unset. */
export class InMemoryVocabularyStore implements CustomVocabularyStore {
  private readonly byClient = new Map<string, Map<string, string>>();

  async load(clientId: string): Promise<Map<string, string>> {
    requireClientId(clientId);
    return new Map(this.byClient.get(clientId) ?? new Map());
  }

  async accept(clientId: string, entries: VocabularyEntry[]): Promise<VocabularyEntry[]> {
    requireClientId(clientId);
    const current = this.byClient.get(clientId) ?? new Map<string, string>();
    for (const e of entries) current.set(e.inputField, e.canonicalField);
    this.byClient.set(clientId, current);
    return entries.map((e) => ({
      inputField: e.inputField,
      canonicalField: current.get(e.inputField)!,
    }));
  }
}

/** One JSON file per client under baseDir. Filesystem boundary == tenant boundary. */
export class JsonFileVocabularyStore implements CustomVocabularyStore {
  constructor(private readonly baseDir: string) {}

  private fileFor(clientId: string): string {
    // Sanitize so clientId can never escape baseDir via path tricks.
    const safe = clientId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.baseDir, `${safe}.json`);
  }

  async load(clientId: string): Promise<Map<string, string>> {
    requireClientId(clientId);
    try {
      const raw = await fs.readFile(this.fileFor(clientId), "utf8");
      const obj = JSON.parse(raw) as Record<string, string>;
      return new Map(Object.entries(obj));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw err;
    }
  }

  async accept(clientId: string, entries: VocabularyEntry[]): Promise<VocabularyEntry[]> {
    requireClientId(clientId);
    const current = await this.load(clientId);
    for (const e of entries) current.set(e.inputField, e.canonicalField);
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(
      this.fileFor(clientId),
      JSON.stringify(Object.fromEntries(current), null, 2),
      "utf8",
    );
    return entries.map((e) => ({
      inputField: e.inputField,
      canonicalField: current.get(e.inputField)!,
    }));
  }
}

/** Module-level singleton configured from VOCAB_DIR env var. */
export const vocabularyStore: CustomVocabularyStore = process.env.VOCAB_DIR
  ? new JsonFileVocabularyStore(process.env.VOCAB_DIR)
  : new InMemoryVocabularyStore();
