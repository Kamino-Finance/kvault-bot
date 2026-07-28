import { randomUUID } from 'crypto';
import { createLogger, format, transports } from 'winston';
import { getEnvOrDefault } from './utils.js';

const sessionId = randomUUID().slice(0, 5);
export const logger = createLogger({
  level: getEnvOrDefault('LOG_LEVEL', 'info'),
  format: format.combine(format.errors({ stack: true }), format.splat(), format.json()),
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
