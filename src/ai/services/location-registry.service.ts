/**
 * Location registry: turns a warehouse reference into a full ship-from address.
 *
 * Some sources send only a warehouse ID instead of an origin address (ShipStation API
 * v1 orders carry advancedOptions.warehouseId, v2 shipments may carry warehouse_id).
 * The mapping step stores that ID as extensions.originRef. After mapping, and only when
 * the canonical payload has no origin, the ID is looked up here and the address copied
 * into /origin.
 *
 * The table is a JSON file: { "<warehouseId>": { line1, city, countryCode, ... } }, using
 * the canonical address field names. It is re-read whenever the file changes, so new
 * warehouses can be added without restarting the engine. First release: one flat table
 * for all clients (warehouse IDs are only unique within one ShipStation account, so
 * per-client tables come later).
 */

import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../../utils/paths.js";
import { aiLog } from "../utils/ai-logger.js";

const log = aiLog("location-registry");

export type LocationAddress = Record<string, unknown>;

export type OriginResolution =
  | { status: "not-needed" }
  | { status: "resolved"; ref: string }
  | { status: "not-found"; ref: string };

export const DEFAULT_LOCATIONS_FILE = path.join(projectRoot, "data", "locations", "warehouses.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class LocationRegistry {
  private table: Record<string, LocationAddress> = {};
  private loadedMtimeMs = -1;

  constructor(private readonly filePath: string = process.env.LOCATIONS_FILE ?? DEFAULT_LOCATIONS_FILE) {}

  /** Returns a copy of the address for a warehouse ID, or undefined. */
  lookup(ref: string): LocationAddress | undefined {
    this.reloadIfChanged();
    const entry = this.table[ref.trim()];
    return entry ? structuredClone(entry) : undefined;
  }

  /**
   * Fills /origin from /extensions/originRef when origin is missing. Changes the payload
   * in place. Never overwrites an origin the source already supplied.
   */
  resolveOrigin(payload: Record<string, unknown>): OriginResolution {
    const extensions = payload.extensions;
    const rawRef = isRecord(extensions) ? extensions.originRef : undefined;
    const ref = typeof rawRef === "string" || typeof rawRef === "number" ? String(rawRef).trim() : "";
    // An origin counts only if it has a street. A stray field or two (a state picked up
    // from the wrong address) must not block the lookup.
    const hasOrigin =
      isRecord(payload.origin) && typeof payload.origin.line1 === "string" && payload.origin.line1.trim() !== "";

    if (!ref || hasOrigin) {
      return { status: "not-needed" };
    }

    const address = this.lookup(ref);
    if (!address) {
      log.warn({ originRef: ref, file: this.filePath }, "Warehouse reference not in location table");
      return { status: "not-found", ref };
    }

    payload.origin = address;
    log.info({ originRef: ref }, "Origin address resolved from location table");
    return { status: "resolved", ref };
  }

  private reloadIfChanged(): void {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch {
      if (this.loadedMtimeMs !== -1) log.warn({ file: this.filePath }, "Location table file is gone");
      this.table = {};
      this.loadedMtimeMs = -1;
      return;
    }
    if (mtimeMs === this.loadedMtimeMs) return;

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as unknown;
      if (!isRecord(parsed)) throw new Error("top level must be an object of warehouseId -> address");
      const table: Record<string, LocationAddress> = {};
      for (const [id, address] of Object.entries(parsed)) {
        if (id.startsWith("_")) continue; // allow "_comment" keys
        if (isRecord(address)) table[id.trim()] = address;
      }
      this.table = table;
      this.loadedMtimeMs = mtimeMs;
      log.info({ file: this.filePath, warehouses: Object.keys(table).length }, "Location table loaded");
    } catch (err) {
      // Keep the last good table rather than losing every warehouse over one bad edit.
      log.error({ err, file: this.filePath }, "Location table could not be read, keeping previous version");
      this.loadedMtimeMs = mtimeMs;
    }
  }
}
