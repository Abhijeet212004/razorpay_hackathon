/**
 * JSON Canonicalization Scheme (RFC 8785). Applied before every hash and signature so
 * two processes that agree on a value agree on its bytes: keys sorted by UTF-16 code
 * unit, no insignificant whitespace.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export class CanonicalisationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalisationError";
  }
}

function canonicaliseString(value: string): string {
  return JSON.stringify(value);
}

/** Safe integers only, so a float cannot enter a hash as a rounded value. */
function canonicaliseNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalisationError(`non-finite number in canonical payload: ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalisationError(
      `only safe integers may be canonicalised, received ${value}. ` +
        "Money is BIGINT paise and must be carried as a string.",
    );
  }
  return String(value);
}

export function canonicalise(value: JsonValue): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicaliseNumber(value);
    case "string":
      return canonicaliseString(value);
    case "object":
      break;
    default:
      throw new CanonicalisationError(`unsupported type in canonical payload: ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const members = keys.map((key) => {
    const member = value[key];
    if (member === undefined) {
      throw new CanonicalisationError(`undefined value at key ${JSON.stringify(key)}`);
    }
    return `${canonicaliseString(key)}:${canonicalise(member)}`;
  });
  return `{${members.join(",")}}`;
}

export function canonicalBytes(value: JsonValue): Buffer {
  return Buffer.from(canonicalise(value), "utf8");
}
