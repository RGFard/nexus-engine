import { buildApp } from "./app.js";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3002);
const logLevel = process.env.LOG_LEVEL ?? "info";

async function main(): Promise<void> {
  const app = await buildApp({ host, port, logLevel });

  try {
    await app.listen({ host, port });
    app.log.info({ host, port }, "Canonical Schema Service started");
    app.log.info(`OpenAPI documentation: http://${host === "0.0.0.0" ? "localhost" : host}:${port}/documentation`);
  } catch (err) {
    app.log.error(err, "Failed to start server");
    process.exit(1);
  }
}

main();
