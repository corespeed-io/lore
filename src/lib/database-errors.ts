export function isPostgresAccessDenied(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "42501" ||
    (typeof candidate.message === "string" &&
      /row-level security|permission denied/i.test(candidate.message))
  );
}
