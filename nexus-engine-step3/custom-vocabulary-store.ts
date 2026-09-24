// Per-client/tenant custom vocabulary store.
//
// Per-client isolation is a first-class requirement, so it's enforced structurally rather
// than by convention:
//   - Every method is keyed by clientId.
//   - There is deliberately NO "load all" / "list tenants" method on the interface, so no
//     caller can accidentally read across tenants.
//   - The JSON implementation uses one file per client, so a bug in one tenant's blob can
//     never leak into another's.
//
// INTEGRATION POINT: swap JsonFileVocabularyStore for whatever nexus-engine actually
// persists to (Postgres row per (clientId, inputField), Redis hash per client, etc.).
// Keep the interface; the resolver and the /vocabulary/accept handler only depend on it.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { VocabularyEntry } from "./types.js";

export interface CustomVocabularyStore {
  /** This client's learned vocabulary as inputField -> canonicalField. Never reads other clients. */
  load(clientId: string): Promise<Map<string, string>>;
  /** Persist entries for ONE client. Merges with that client's existing vocab only. Returns what is now stored for the accepted keys. */
  accept(clientId: string, entries: VocabularyEntry[]): Promise<VocabularyEntry[]>;
}

/** Simple in-memory store — handy for tests and the demo. */
export class InMemoryVocabularyStore implements CustomVocabularyStore {
  private readonly byClient = new Map<string, Map<string, string>>();

  async load(clientId: string): Promise<Map<string, string>> {
    requireClientId(clientId);
    // Hand back a copy so callers can't mutate the backing store.
    return new Map(this.byClient.get(clientId) ?? new Map());
  }

  async accept(clientId: string, entries: VocabularyEntry[]): Promise<VocabularyEntry[]> {
    requireClientId(clientId);
    const current = this.byClient.get(clientId) ?? new Map<string, string>();
    for (const e of entries) current.set(e.inputField, e.canonicalField);
    this.byClient.set(clientId, current);
    return entries.map((e) => ({ inputField: e.inputField, canonicalField: current.get(e.inputField)! }));
  }
}

/** One JSON file per client under `baseDir`. Filesystem boundary == tenant boundary. */
export class JsonFileVocabularyStore implements CustomVocabularyStore {
  constructor(private readonly baseDir: string) {}

  private fileFor(clientId: string): string {
    // Sanitize so clientId can never escape baseDir or collide via path tricks.
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
    await fs.writeFile(this.fileFor(clientId), JSON.stringify(Object.fromEntries(current), null, 2), "utf8");
    return entries.map((e) => ({ inputField: e.inputField, canonicalField: current.get(e.inputField)! }));
  }
}

function requireClientId(clientId: string): void {
  if (!clientId || typeof clientId !== "string") {
    throw new Error("clientId is required and must be a non-empty string");
  }
}
