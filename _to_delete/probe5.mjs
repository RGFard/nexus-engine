import { semanticMatcherService } from "./dist/ai/services/semantic-matcher.service.js";
import { readFileSync } from "fs";

const fedex = JSON.parse(readFileSync("tests/fixtures/fedex-shipment.json", "utf8"));
const target = JSON.parse(readFileSync("src/schemas/shipment/shipment-create-response.schema.json", "utf8"));

const sourceSchema = semanticMatcherService.inferSchemaFromPayload(fedex, "FedEx");
const sourceAnalysis = semanticMatcherService.analyzeSchema(sourceSchema, fedex);
const targetAnalysis = semanticMatcherService.analyzeSchema(target);

const candidates = semanticMatcherService.findCandidateMappings(sourceAnalysis, targetAnalysis);
const tracking = candidates.find(c => c.sourceField.toLowerCase().includes("mastertracking"));
console.log("tracking candidate:", JSON.stringify(tracking, null, 2));
const check = tracking && tracking.targetField.includes("trackingNumber");
console.log("test's .includes('trackingNumber') check passes:", check);
