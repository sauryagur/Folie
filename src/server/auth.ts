// Bearer-token authentication: opaque 256-bit secrets, stored hashed, bound to agent/execution generations or operator.
// Only SHA-256 hashes are persisted. Comparison is constant-time.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { UnauthorizedError } from "./errors";

export type Principal =
  | { kind: "agent"; name: string; generation: number; executionId: string }
  | { kind: "operator"; name: "operator" };

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generateExecutionId(): string {
  return randomBytes(16).toString("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function extractBearer(header: string | string[] | undefined): string {
  if (!header) throw new UnauthorizedError("missing Authorization header");
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") throw new UnauthorizedError("invalid Authorization header");
  if (!value.startsWith("Bearer ")) throw new UnauthorizedError("Authorization must be Bearer <token>");
  const token = value.slice(7).trim();
  if (!token) throw new UnauthorizedError("missing bearer token");
  return token;
}
