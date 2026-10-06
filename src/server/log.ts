import pino from 'pino';

const globalForLog = globalThis as unknown as { __tmLogger?: pino.Logger };

export function logger(): pino.Logger {
  if (!globalForLog.__tmLogger) {
    globalForLog.__tmLogger = pino({
      level: process.env.LOG_LEVEL || 'info',
      base: { app: 'dependency-time-machine' },
    });
  }
  return globalForLog.__tmLogger;
}

export function childLogger(bindings: Record<string, unknown>): pino.Logger {
  return logger().child(bindings);
}
