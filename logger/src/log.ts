import { randomUUID } from 'crypto';
import { createLogger, format, transports } from 'winston';
import { getEnvOrDefault } from './utils.js';

/** LOG_LEVEL default. The bot's settings registry declares the same value; a parity test keeps them equal. */
export const DEFAULT_LOG_LEVEL = 'info';

const sessionId = randomUUID().slice(0, 5);

/** An HTTP client error, such as an axios error, carries its request: the config holds the request headers. */
function carriesHttpRequest(value: unknown): value is Record<string, unknown> {
  const config = (value as { config?: unknown } | null)?.config;
  return typeof config === 'object' && config !== null && 'headers' in config;
}

/**
 * Drops the request config, the request and the response from a logged HTTP client error and from its cause. The
 * headers can hold an API key, and the JSON format writes every own property of the error.
 */
export const dropHttpRequestDetails = format((info) => {
  if (carriesHttpRequest(info)) {
    delete info.config;
    delete info.request;
    delete info.response;
  }
  if (carriesHttpRequest(info.cause)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { config, request, response, ...cause } = info.cause;
    info.cause = cause;
  }
  return info;
});

export const logger = createLogger({
  level: getEnvOrDefault('LOG_LEVEL', DEFAULT_LOG_LEVEL),
  // The request details are dropped after splat: splat merges the logged error's own properties into the entry again.
  format: format.combine(format.errors({ stack: true }), format.splat(), dropHttpRequestDetails(), format.json()),
  //  service: 'klend-liquidations-bot', session: sessionId },
  defaultMeta: {},
  transports: [
    process.env.NODE_ENV !== 'production'
      ? new transports.Console({
          format: format.combine(
            format.colorize(),
            format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            format.printf(({ timestamp, level, message, stack, cause, ...meta }) => {
              let msg = addMeta(`[${timestamp}] ${sessionId} ${level}: ${message}`, meta);
              if (stack) {
                msg = `${msg}\n${stack}`;
              }
              let currCause = cause;
              while (currCause) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const { message: causeMessage, stack: causeStack, ...rest } = currCause as any;
                if (causeStack || causeMessage) {
                  const pre = causeMessage ? `Caused by: ${causeMessage}\n` : 'Caused by:';
                  const causeMsg = causeStack ? `${pre} ${causeStack}` : `${pre}`;
                  msg = `${msg}\n${causeMsg}`;
                }
                if (Object.keys(rest).length > 0) {
                  msg = `${msg}\n${JSON.stringify(rest, (key, value) =>
                    typeof value === 'bigint' ? value.toString() : value
                  )}`;
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                currCause = (currCause as any).cause;
              }
              return msg;
            })
          ),
        })
      : new transports.Console(),
  ],
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addMeta(message: string, meta: any) {
  let newMessage = message;
  if (meta) {
    const { logs, ...rest } = meta;
    if (Object.keys(rest).length > 0) {
      try {
        newMessage = `${newMessage} ${JSON.stringify(rest)}`;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e) {
        // ignore
      }
    }
    if (logs) {
      const l = Array.isArray(logs) ? logs : [logs];
      newMessage = `${newMessage}\n${l.map((log: string) => `  ${log}`).join('\n')}`;
    }
  }
  return newMessage;
}
