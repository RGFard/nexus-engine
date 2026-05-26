import type { FastifyBaseLogger } from "fastify";

let rootLogger: FastifyBaseLogger | null = null;

export function setLogger(logger: FastifyBaseLogger): void {
  rootLogger = logger;
}

export function getLogger(): FastifyBaseLogger {
  if (!rootLogger) {
    throw new Error("Logger not initialized. Start the application first.");
  }
  return rootLogger;
}

export function createChildLogger(bindings: Record<string, unknown>): FastifyBaseLogger {
  return getLogger().child(bindings);
}
