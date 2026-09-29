import { isPostgresAccessDenied } from "@corespeed/lore-core";
import { AccessDeniedError } from "@/server/errors";

/** Report a statement RLS or a grant refused (SQLSTATE 42501) as `access_denied`. */
export async function refusingDeniedAccess<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (isPostgresAccessDenied(error)) throw new AccessDeniedError("Actor is not authorized");
    throw error;
  }
}
