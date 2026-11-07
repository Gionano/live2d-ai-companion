const clockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jakarta', hourCycle: 'h23',
  hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
});

export function formatLogTime(date = new Date()) {
  return clockFormatter.format(date) + ' WIB';
}

// Keep format substitutions, object arguments and the original console untouched.
export function createTimestampedLogger(target = globalThis.console, now = () => new Date()) {
  const result = Object.create(target);
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    result[level] = (...args) => {
      const timestamp = '[' + formatLogTime(now()) + ']';
      if (typeof args[0] === 'string') target[level](timestamp + ' ' + args[0], ...args.slice(1));
      else target[level](timestamp, ...args);
    };
  }
  return result;
}

export const logger = createTimestampedLogger();
