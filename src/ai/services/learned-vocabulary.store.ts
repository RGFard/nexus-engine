/**
 * Global learned vocabulary (accept-and-remember loop for AI fallback mappings).
 *
 *   AI fallback mapping ──recordPending──▶ pending_vocabulary
 *                                              │ accept        │ reject
 *                                              ▼               ▼
 *                                       custom_vocabulary   (dropped)
 *
 * custom_vocabulary is ONE flat global list — no clientId, no scoping. It is
 * deliberately separate from the per-client CustomVocabularyStore.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  LearnedVocabularyEntry,
  PendingVocabularyEntry,
  PendingVocabularyInput,
} from "../models/vocabulary.types.js";

export interface LearnedVocabularyStore {
  /** Upsert AI-fallback mappings into pending. Re-sightings bump seenCount/lastSeenAt. */
  recordPending(entries: PendingVocabularyInput[]): Promise<PendingVocabularyEntry[]>;
  listPending(): Promise<PendingVocabularyEntry[]>;
  /** Move a pending entry into custom vocabulary. Returns null if id is unknown. */
  acceptPending(id: string): Promise<LearnedVocabularyEntry | null>;
  /** Drop a pending entry. Returns false if id is unknown. */
  rejectPending(id: string): Promise<boolean>;
  /** Global custom vocabulary, keyed by inputField (source path). */
  loadCustom(): Promise<Map<string, LearnedVocabularyEntry>>;
}

export function pendingId(sourceField: string, targetField: string): string {
  return createHash("sha256").update(`${sourceField}\u0000${targetField}`).digest("hex").slice(0, 12);
}

interface State {
  pending: Map<string, PendingVocabularyEntry>;
  custom: Map<string, LearnedVocabularyEntry>;
}

/**
 * Shared logic over an abstract load/save of the full state. Mutations are
 * serialized through a promise chain so concurrent normalize requests can't
 * interleave read-modify-write cycles.
 */
abstract class BaseLearnedVocabularyStore implements LearnedVocabularyStore {
  private queue: Promise<unknown> = Promise.resolve();

  protected abstract read(): Promise<State>;
  protected abstract write(state: State): Promise<void>;

  private mutate<T>(fn: (state: State) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const state = await this.read();
      const result = fn(state);
      await this.write(state);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  recordPending(entries: PendingVocabularyInput[]): Promise<PendingVocabularyEntry[]> {
    if (entries.length === 0) return Promise.resolve([]);
    return this.mutate((state) => {
      const now = new Date().toISOString();
      return entries.map((e) => {
        const id = pendingId(e.sourceField, e.targetField);
        const existing = state.pending.get(id);
        const next: PendingVocabularyEntry = existing
          ? { ...existing, ...e, id, lastSeenAt: now, seenCount: existing.seenCount + 1 }
          : { ...e, id, firstSeenAt: now, lastSeenAt: now, seenCount: 1 };
        state.pending.set(id, next);
        return next;
      });
    });
  }

  async listPending(): Promise<PendingVocabularyEntry[]> {
    await this.queue;
    const { pending } = await this.read();
    return [...pending.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  acceptPending(id: string): Promise<LearnedVocabularyEntry | null> {
    return this.mutate((state) => {
      const p = state.pending.get(id);
      if (!p) return null;
      const entry: LearnedVocabularyEntry = {
        inputField: p.sourceField,
        canonicalField: p.targetField,
        transformation: p.transformation,
        acceptedAt: new Date().toISOString(),
      };
      state.custom.set(entry.inputField, entry);
      state.pending.delete(id);
      return entry;
    });
  }

  rejectPending(id: string): Promise<boolean> {
    return this.mutate((state) => state.pending.delete(id));
  }

  async loadCustom(): Promise<Map<string, LearnedVocabularyEntry>> {
    await this.queue;
    return new Map((await this.read()).custom);
  }
}

/** In-memory store — used in tests and when LEARNED_VOCAB_DIR is unset. */
export class InMemoryLearnedVocabularyStore extends BaseLearnedVocabularyStore {
  private state: State = { pending: new Map(), custom: new Map() };

  protected async read(): Promise<State> {
    return { pending: new Map(this.state.pending), custom: new Map(this.state.custom) };
  }

  protected async write(state: State): Promise<void> {
    this.state = state;
  }
}

/** pending_vocabulary.json + custom_vocabulary.json under baseDir. */
export class JsonFileLearnedVocabularyStore extends BaseLearnedVocabularyStore {
  constructor(private readonly baseDir: string) {
    super();
  }

  private file(name: "pending_vocabulary" | "custom_vocabulary"): string {
    return path.join(this.baseDir, `${name}.json`);
  }

  private async readArray<T>(file: string): Promise<T[]> {
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as T[];
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Write via temp file + rename so a crash never leaves a half-written file. */
  private async writeArray(file: string, data: unknown[]): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, file);
  }

  protected async read(): Promise<State> {
    const pending = await this.readArray<PendingVocabularyEntry>(this.file("pending_vocabulary"));
    const custom = await this.readArray<LearnedVocabularyEntry>(this.file("custom_vocabulary"));
    return {
      pending: new Map(pending.map((e) => [e.id, e])),
      custom: new Map(custom.map((e) => [e.inputField, e])),
    };
  }

  protected async write(state: State): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await this.writeArray(this.file("pending_vocabulary"), [...state.pending.values()]);
    await this.writeArray(this.file("custom_vocabulary"), [...state.custom.values()]);
  }
}

/** Module-level singleton configured from LEARNED_VOCAB_DIR env var. */
export const learnedVocabularyStore: LearnedVocabularyStore = process.env.LEARNED_VOCAB_DIR
  ? new JsonFileLearnedVocabularyStore(process.env.LEARNED_VOCAB_DIR)
  : new InMemoryLearnedVocabularyStore();
