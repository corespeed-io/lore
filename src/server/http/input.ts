import type { z } from "zod/v4";
import { AccessDeniedError } from "@/server/auth/access";
import type { ActorContext } from "@/server/auth/actor-context";
import { normalizeUuid } from "@/server/auth/request-context";
import type { IdempotencyRequest } from "@/server/http/idempotency";
import { mutationRequestHash } from "@/server/http/idempotency";

export class BadRequestError extends Error {
  readonly status = 400;
}

export async function idempotencyRequest(
  request: Request,
  operation: string,
  payload: unknown,
): Promise<IdempotencyRequest | undefined> {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return undefined;
  if (!/^[\x21-\x7e]{1,128}$/.test(key)) {
    throw new BadRequestError("Idempotency-Key must contain 1 to 128 visible ASCII characters");
  }
  return {
    key,
    operation,
    requestHash: await mutationRequestHash({ operation, payload }),
  };
}

export async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BadRequestError(`${name} is required`);
  }
  const normalized = value.trim();
  if (normalized.includes("\0")) {
    throw new BadRequestError(`${name} contains an invalid null character`);
  }
  if (hasLoneSurrogate(normalized)) {
    throw new BadRequestError(`${name} contains invalid Unicode`);
  }
  if (normalized.length > maximumLength) {
    throw new BadRequestError(`${name} exceeds ${maximumLength} characters`);
  }
  return normalized;
}

export function parseMemoryInput<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  try {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestError(result.error.issues[0]?.message ?? "Invalid Memory input");
    }
    return result.data;
  } catch (error) {
    // Recursive JSON parsing can exhaust the runtime stack before Zod returns an issue.
    if (error instanceof RangeError) throw new BadRequestError("Memory input is too deeply nested");
    throw error;
  }
}

export function requiredRawString(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BadRequestError(`${name} is required`);
  }
  if (value.includes("\0")) {
    throw new BadRequestError(`${name} contains an invalid null character`);
  }
  if (hasLoneSurrogate(value)) {
    throw new BadRequestError(`${name} contains invalid Unicode`);
  }
  if (value.length > maximumLength) {
    throw new BadRequestError(`${name} exceeds ${maximumLength} characters`);
  }
  return value;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new BadRequestError(`${name} must be a positive integer`);
  }
  return parsed;
}

export function optionalTimestamp(value: string | null, name: string): string | undefined {
  if (value === null || value.trim() === "") return undefined;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new BadRequestError(`${name} must be an ISO 8601 timestamp`);
  }
  return timestamp.toISOString();
}

export function queryInteger(
  url: URL,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new BadRequestError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function uuidString(value: unknown, name: string): string {
  const result = requiredString(value, name, 36);
  const normalized = normalizeUuid(result);
  if (!normalized) throw new BadRequestError(`${name} must be a UUID`);
  return normalized;
}

export function uuidArray(value: unknown, name: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new BadRequestError(`${name} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  return value.map((item, index) => uuidString(item, `${name}[${index}]`));
}

export function requireHumanActor(actor: ActorContext): ActorContext {
  if (actor.agentId) throw new AccessDeniedError("This operation requires a User");
  return actor;
}

export class PreconditionRequiredError extends Error {
  readonly status = 428;
}
