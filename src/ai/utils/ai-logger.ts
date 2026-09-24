import type { FastifyBaseLogger } from "fastify";
import { createChildLogger } from "../../utils/logger.js";

function createNoopLogger(): FastifyBaseLogger {
  const noop = () => {};
  const logger = {
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    child: () => logger,
  };
  return logger as unknown as FastifyBaseLogger;
}

/**
 * Returns a lazy logger proxy so modules can be imported before Fastify calls setLogger().
 */
export function aiLog(component: string): FastifyBaseLogger {
  let delegate: FastifyBaseLogger | undefined;

  const resolve = (): FastifyBaseLogger => {
    if (!delegate) {
      try {
        delegate = createChildLogger({ component: `ai:${component}` });
      } catch {
        delegate = createNoopLogger();
      }
    }
    return delegate;
  };

  return new Proxy({} as FastifyBaseLogger, {
    get(_target, prop) {
      const logger = resolve();
      const value = logger[prop as keyof FastifyBaseLogger];
      if (typeof value === "function") {
        return (...args: unknown[]) =>
          (value as (...a: unknown[]) => unknown).apply(logger, args);
      }
      return value;
    },
  });
}
