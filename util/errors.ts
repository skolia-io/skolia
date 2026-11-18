/** An Error as a plain object, its causes and code included, since JSON turns one into {} */
export function errorFields(value: unknown): unknown {
  if (!(value instanceof Error)) return value;
  const code = (value as { code?: unknown }).code;
  return {
    name: value.name,
    message: value.message,
    ...(code === undefined ? {} : { code }),
    stack: value.stack,
    ...(value.cause === undefined ? {} : { cause: errorFields(value.cause) }),
    ...(value instanceof AggregateError ? { errors: value.errors.map(errorFields) } : {}),
  };
}

/** The error's message and its causes', each left out if the one before already says it:
 * fetch's "fetch failed" becomes "fetch failed: connect ECONNREFUSED 127.0.0.1:443". */
export function describeError(value: unknown): string {
  if (!(value instanceof Error)) return String(value);
  const cause = value.cause === undefined ? "" : describeError(value.cause);
  return cause === "" || value.message.includes(cause) ? value.message : `${value.message}: ${cause}`;
}
