/**
 * The join every exact-revision read starts from: a Code Repository, one of its
 * exact revisions, and that revision's Index Generations, as `repository`,
 * `revision`, and `generation`. RLS applies to each table.
 */
export const REVISION_GENERATION_SOURCE = `code_repositories repository
  JOIN code_revisions revision
    ON revision.workspace_id = repository.workspace_id
   AND revision.repository_id = repository.id
  JOIN code_index_generations generation
    ON generation.workspace_id = revision.workspace_id
   AND generation.repository_id = revision.repository_id
   AND generation.revision_id = revision.id`;

/**
 * The one generation an exact-revision read may use: the active generation of the
 * repository key at the full commit OID, in the caller's Workspace. The arguments
 * are the caller's SQL parameter placeholders, never values.
 */
export function activeGenerationOf(placeholders: {
  workspaceId: string;
  repositoryKey: string;
  commitOid: string;
}): string {
  return `repository.workspace_id = ${placeholders.workspaceId}
    AND repository.repository_key = ${placeholders.repositoryKey}
    AND revision.commit_oid = ${placeholders.commitOid}
    AND generation.status = 'active'`;
}
