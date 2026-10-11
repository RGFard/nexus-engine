import fs from "node:fs/promises";
import path from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import { createChildLogger } from "../utils/logger.js";
import { targetPlansRoot, targetSchemasRoot } from "../utils/paths.js";
import type { OutboundTargetListItem, SavedOutboundPlan } from "./outbound.types.js";
import { assertUnitPolicy } from "./unit-conversion.js";

const PLAN_SUFFIX = ".plan.json";
const SCHEMA_SUFFIX = ".schema.json";

export interface OutboundTarget {
  system: string;
  schemaName: string;
  plan: SavedOutboundPlan;
  schema: Record<string, unknown>;
  validate: ValidateFunction;
}

function targetKey(system: string, schemaName: string): string {
  return `${system}:${schemaName}`;
}

/**
 * Loads every saved outbound plan and its target schema at startup.
 *
 * A plan lives at  src/target-plans/<system>/<name>.plan.json
 * its schema at    src/target-schemas/<system>/<name>.schema.json
 *
 * Target schemas are deliberately kept out of the canonical schema registry: everything
 * in that registry counts as a valid canonical path for the learned vocabulary.
 */
export class OutboundTargetRegistry {
  private readonly targets = new Map<string, OutboundTarget>();

  constructor(
    private readonly plansRoot = targetPlansRoot,
    private readonly schemasRoot = targetSchemasRoot,
  ) {}

  async initialize(): Promise<void> {
    const log = createChildLogger({ component: "outbound-targets" });
    this.targets.clear();

    const ajv = new Ajv({ allErrors: true, strict: false });
    (addFormatsModule as unknown as (instance: Ajv) => void)(ajv);

    for (const system of await listDirectories(this.plansRoot)) {
      const planFiles = (await fs.readdir(path.join(this.plansRoot, system))).filter((f) =>
        f.endsWith(PLAN_SUFFIX),
      );

      for (const planFile of planFiles) {
        const schemaName = planFile.slice(0, -PLAN_SUFFIX.length);
        const planPath = path.join(this.plansRoot, system, planFile);
        const schemaPath = path.join(this.schemasRoot, system, `${schemaName}${SCHEMA_SUFFIX}`);

        // One broken target must not stop the service: inbound normalization does not
        // depend on any of this. Log it loudly and leave the target unregistered, so a
        // request for it gets a clear 404 instead of a half-working plan.
        try {
          const plan = JSON.parse(await fs.readFile(planPath, "utf-8")) as SavedOutboundPlan;
          const schema = JSON.parse(await fs.readFile(schemaPath, "utf-8")) as Record<string, unknown>;
          assertPlanShape(plan);
          assertUnitPolicy(plan.units);

          this.targets.set(targetKey(system, schemaName), {
            system,
            schemaName,
            plan,
            schema,
            validate: ajv.compile(schema),
          });
          log.info(
            { system, schemaName, planId: plan.planId, mappings: plan.mappings.length },
            "Outbound target loaded",
          );
        } catch (err) {
          log.error({ err, system, schemaName, planPath, schemaPath }, "Outbound target failed to load");
        }
      }
    }
  }

  get(system: string, schemaName: string): OutboundTarget | undefined {
    return this.targets.get(targetKey(system, schemaName));
  }

  list(): OutboundTargetListItem[] {
    return [...this.targets.values()]
      .map(({ system, schemaName, plan }) => ({
        system,
        schemaName,
        planId: plan.planId,
        planVersion: plan.planVersion,
        sourceSchemaId: plan.sourceSchemaId,
        targetSchemaId: plan.targetSchemaId,
        mappingCount: plan.mappings.length,
        parameters: plan.parameters ?? {},
        units: plan.units ?? {},
        knownGaps: plan.knownGaps ?? [],
      }))
      .sort((a, b) => a.system.localeCompare(b.system) || a.schemaName.localeCompare(b.schemaName));
  }
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function assertPlanShape(plan: SavedOutboundPlan): void {
  for (const key of ["planId", "planVersion", "sourceSchemaId", "targetSchemaId"] as const) {
    if (typeof plan[key] !== "string" || plan[key].length === 0) {
      throw new Error(`Plan is missing "${key}"`);
    }
  }
  if (!Array.isArray(plan.mappings) || plan.mappings.length === 0) {
    throw new Error("Plan has no mappings");
  }
  for (const m of plan.mappings) {
    if (typeof m.sourceField !== "string" || typeof m.targetField !== "string" || typeof m.transformation !== "string") {
      throw new Error(`Plan has a malformed mapping: ${JSON.stringify(m)}`);
    }
  }
  for (const [name, param] of Object.entries(plan.parameters ?? {})) {
    if (typeof param?.targetField !== "string" || !param.targetField.startsWith("/") || param.targetField.includes("[]")) {
      throw new Error(`Plan parameter "${name}" needs a targetField that is a single, non-array path`);
    }
  }
}
