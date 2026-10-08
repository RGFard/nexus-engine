import { semanticMatcherService } from "./dist/ai/services/semantic-matcher.service.js";
import { computeSemanticSimilarity } from "./dist/ai/utils/semantic-scoring.js";
import { resolveConceptId, conceptForCanonicalPath } from "./dist/ai/utils/semantic-scoring.js";
import { readFileSync } from "fs";

const ups = JSON.parse(readFileSync("tests/fixtures/ups-shipment.json", "utf8"));
const target = JSON.parse(readFileSync("src/schemas/shipment/shipment-create-response.schema.json", "utf8"));

const sourceSchema = semanticMatcherService.inferSchemaFromPayload(ups, "UPS");
const sourceAnalysis = semanticMatcherService.analyzeSchema(sourceSchema, ups);
const targetAnalysis = semanticMatcherService.analyzeSchema(target);

const sf = sourceAnalysis.fields.find(f => f.name === "ShipmentIdentificationNumber");
const tf = targetAnalysis.fields.find(f => f.path === "/trackingNumber");

console.log("sf concept:", resolveConceptId(sf));
console.log("tf concept via path:", conceptForCanonicalPath(tf.path));

const breakdown = computeSemanticSimilarity(sf, tf);
console.log("breakdown:", JSON.stringify(breakdown, null, 2));
