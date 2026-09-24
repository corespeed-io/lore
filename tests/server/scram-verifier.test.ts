import { createHash, createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { SCRAM_ITERATIONS, scramSha256Verifier } from "../../scripts/database/lib/scram.ts";

const VERIFIER = /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;

function parts(verifier: string) {
  const match = VERIFIER.exec(verifier);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
    throw new Error("Not a SCRAM-SHA-256 verifier");
  }
  return {
    iterations: Number(match[1]),
    salt: Buffer.from(match[2], "base64"),
    storedKey: Buffer.from(match[3], "base64"),
    serverKey: Buffer.from(match[4], "base64"),
  };
}

test("the verifier authenticates the RFC 7677 SCRAM-SHA-256 example exchange", () => {
  // RFC 7677 section 3: user "user", password "pencil". A server holding only
  // this verifier must accept the client's proof and produce the same signature.
  const clientNonce = "rOprNGfwEbeRWgbNEkqO";
  const serverNonce = `${clientNonce}%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0`;
  const salt = "W22ZaJ0SNY7soEsUEjb6gQ==";
  const authMessage = [
    `n=user,r=${clientNonce}`,
    `r=${serverNonce},s=${salt},i=4096`,
    `c=biws,r=${serverNonce}`,
  ].join(",");
  const clientProof = Buffer.from("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=", "base64");

  const verifier = scramSha256Verifier("pencil", { salt: Buffer.from(salt, "base64") });
  const { iterations, storedKey, serverKey } = parts(verifier);

  expect(iterations).toBe(4_096);
  const clientSignature = createHmac("sha256", storedKey).update(authMessage).digest();
  const clientKey = Buffer.from(
    clientProof.map((byte, index) => byte ^ (clientSignature[index] ?? 0)),
  );
  expect(createHash("sha256").update(clientKey).digest().equals(storedKey)).toBe(true);
  expect(createHmac("sha256", serverKey).update(authMessage).digest("base64")).toBe(
    "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
  );
});

test("each verifier gets a fresh 16-byte salt and never embeds the password", () => {
  const password = "correct-horse-battery-staple";
  const first = scramSha256Verifier(password);
  const second = scramSha256Verifier(password);

  expect(first).not.toBe(second);
  expect(parts(first)).toMatchObject({ iterations: SCRAM_ITERATIONS });
  expect(parts(first).salt).toHaveLength(16);
  expect(first).not.toContain(password);
  // The literal is interpolated into CREATE/ALTER ROLE, so it must never need escaping.
  expect(first).not.toMatch(/['\\]/);
});

test("passwords outside printable ASCII are refused instead of risking a SASLprep mismatch", () => {
  for (const password of ["", "tab\tseparated", "naïve-password", "full\u3000width"]) {
    expect(() => scramSha256Verifier(password)).toThrow(/printable ASCII/);
  }
  expect(() => scramSha256Verifier("password", { iterations: 1_000 })).toThrow(/iterations/);
});
