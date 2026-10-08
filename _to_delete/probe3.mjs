import { semanticMatcherService } from "./dist/ai/services/semantic-matcher.service.js";
import { readFileSync } from "fs";

const ups = JSON.parse(readFileSync("tests/fixtures/ups-shipment.json", "utf8"));
const target = JSON.parse(readFileSync("src/schemas/shipment/shipment-create-response.schema.json", "utf8"));

const sourceSchema = semanticMatcherService.inferSchemaFromPayload(ups, "UPS");
const sourceAnalysis = semanticMatcherService.analyzeSchema(sourceSchema, ups);
const targetAnalysis = semanticMatcherService.analyzeSchema(target);

const shipField = sourceAnalysis.fields.find(f => f.name.toLowerCase().includes("shipmentidentification"));
console.log("source field:", JSON.stringify(shipField, null, 2));

const trackTargets = targetAnalysis.fields.filter(f => f.path.toLowerCase().includes("trackingnumber"));
console.log("target fields matching trackingNumber:", JSON.stringify(trackTargets, null, 2));

const candidates = semanticMatcherService.findCandidateMappings(sourceAnalysis, targetAnalysis);
const tracking = candidates.find(c => c.sourceField.toLowerCase().includes("shipmentidentification"));
console.log("candidate for shipmentidentification source:", JSON.stringify(tracking, null, 2));

const toTrackTarget = candidates.filter(c => c.targetField.toLowerCase().includes("trackingnumber"));
console.log("candidates targeting trackingNumber:", JSON.stringify(toTrackTarget, null, 2));
