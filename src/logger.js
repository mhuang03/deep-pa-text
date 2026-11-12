import { inspect } from 'node:util';

const MAX_CAUSE_DEPTH = 3;
const INSPECT_DEPTH = 1;
const REDACTED = '[redacted]';
// Webhook URLs carry their token in the path.
const WEBHOOK_PATH = /(\/webhooks\/\d+\/)[^\s/?"'`)]+/g;

const formatProperties = (error) => {
  const pairs = ['code', 'status'].filter((key) => error[key] !== undefined && error[key] !== null)
    .map((key) => `${key}=${error[key]}`);
  return pairs.length > 0 ? ` [${pairs.join(' ')}]` : '';
};

const describe = (error) => `${error.stack ?? `${error.name}: ${error.message}`}${formatProperties(error)}`;

// Errors are rendered as text so library properties (a request url, headers) are never dumped by the console.
export const formatError = (error) => {
  if (!(error instanceof Error)) return String(error);
  let text = describe(error);
  let cause = error.cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause !== undefined && cause !== null; depth += 1) {
    text += `\n  caused by: ${cause instanceof Error ? describe(cause) : String(cause)}`;
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return text;
};

const buildNeedles = (secrets) => secrets
  .filter((secret) => typeof secret === 'string' && secret !== '')
  .flatMap((secret) => [secret, encodeURIComponent(secret)])
  .filter((needle, index, all) => all.indexOf(needle) === index)
  .sort((a, b) => b.length - a.length);

export const createLogger = (sink = console, { secrets = [] } = {}) => {
  const needles = buildNeedles(secrets);

  const redact = (text) => needles
    .reduce((acc, needle) => acc.split(needle).join(REDACTED), text)
    .replace(WEBHOOK_PATH, `$1${REDACTED}`);

  const render = (arg) => {
    if (typeof arg === 'string') return redact(arg);
    if (arg instanceof Error) return redact(formatError(arg));
    if (arg !== null && (typeof arg === 'object' || typeof arg === 'function')) {
      return redact(inspect(arg, { depth: INSPECT_DEPTH }));
    }
    return arg;
  };

  const forward = (method) => (...args) => sink[method](...args.map(render));

  return { info: forward('log'), warn: forward('warn'), error: forward('error') };
};

export const formatTimestamp = (ms, { locale, timeZone }) =>
  new Date(ms).toLocaleString(locale, { timeZone });
