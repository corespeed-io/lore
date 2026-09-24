import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export const SCRAM_ITERATIONS = 4_096;
const SCRAM_SALT_BYTES = 16;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

export interface ScramVerifierOptions {
  /** Test seam; production always uses a fresh random 16-byte salt. */
  salt?: Uint8Array;
  iterations?: number;
}

/**
 * Builds the SCRAM-SHA-256 verifier PostgreSQL stores in pg_authid, so CREATE and
 * ALTER ROLE never carry a cleartext password into server logs or
 * pg_stat_statements. The format is
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>` (RFC 5802, RFC 7677).
 *
 * PostgreSQL normalizes a password with SASLprep before hashing. SASLprep is the
 * identity on printable ASCII, so restricting input to it keeps this verifier
 * byte-identical to the one the server would compute; other passwords are
 * rejected rather than risking a login that silently never matches.
 */
export function scramSha256Verifier(password: string, options: ScramVerifierOptions = {}): string {
  if (!PRINTABLE_ASCII.test(password)) {
    throw new Error("Runtime role passwords must contain only printable ASCII characters");
  }
  const iterations = options.iterations ?? SCRAM_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < SCRAM_ITERATIONS) {
    throw new Error(`SCRAM iterations must be an integer of at least ${SCRAM_ITERATIONS}`);
  }
  const salt = options.salt ?? randomBytes(SCRAM_SALT_BYTES);
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  return `SCRAM-SHA-256$${iterations}:${base64(salt)}$${base64(storedKey)}:${base64(serverKey)}`;
}
