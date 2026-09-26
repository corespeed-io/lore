import { mkdir, readFile, writeFile } from "node:fs/promises";
import openapiTS, { astToString } from "openapi-typescript";
import { loreOpenApiDocument } from "../../src/server/openapi/document";

const repositoryUrl = new URL("../../", import.meta.url);
const openApiOutputUrl = new URL("packages/typescript-sdk/src/generated/openapi.ts", repositoryUrl);
const runtimeOutputUrl = new URL("packages/typescript-sdk/src/generated/runtime.ts", repositoryUrl);
const groundingSourceUrl = new URL("src/modules/context/grounding.ts", repositoryUrl);
const groundingOutputUrl = new URL(
  "packages/typescript-sdk/src/generated/grounding.ts",
  repositoryUrl,
);
const cliVersionOutputUrl = new URL("packages/cli/src/generated/version.ts", repositoryUrl);
const mcpVersionOutputUrl = new URL("packages/mcp/src/generated/version.ts", repositoryUrl);

interface PackageManifest {
  version: string;
}

interface JsonSchema {
  const?: unknown;
  enum?: readonly unknown[];
  properties?: Readonly<Record<string, JsonSchema>>;
}

interface OpenApiDocument {
  components: { schemas: Readonly<Record<string, JsonSchema>> };
}

function generatedHeader(source: string): string {
  return `// Generated from ${source}. Do not edit by hand.\n`;
}

async function packageVersion(path: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(new URL(path, repositoryUrl), "utf8"),
  ) as PackageManifest;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new TypeError(`${path} contains an invalid version`);
  }
  return manifest.version;
}

function openApiErrorCodes(document: OpenApiDocument): readonly string[] {
  const errorSchema = document.components.schemas.Error;
  const codes = errorSchema?.properties?.code?.enum;
  if (!codes?.length || codes.some((code) => typeof code !== "string")) {
    throw new TypeError("OpenAPI Error.code must define a non-empty string enum");
  }
  return codes.map((code) => String(code));
}

function memoryContentLimits(document: OpenApiDocument) {
  const limits = document.components.schemas.Capabilities?.properties?.limits?.properties;
  const recommendedCharacters = limits?.memoryContentRecommendedCharacters?.const;
  const maximumCharacters = limits?.memoryContentMaximumCharacters?.const;
  if (
    typeof recommendedCharacters !== "number" ||
    typeof maximumCharacters !== "number" ||
    !Number.isSafeInteger(recommendedCharacters) ||
    !Number.isSafeInteger(maximumCharacters) ||
    recommendedCharacters <= 0 ||
    maximumCharacters < recommendedCharacters
  ) {
    throw new TypeError("OpenAPI Capabilities must define valid Memory content limits");
  }
  return { recommendedCharacters, maximumCharacters };
}

/** The value at a JSON-Pointer-like path; `[name]` selects a parameter by name. */
function at(document: unknown, path: string): unknown {
  let current: unknown = document;
  for (const part of path.split("/").filter(Boolean)) {
    const parameter = /^\[(.+)\]$/.exec(part)?.[1];
    if (parameter !== undefined) {
      current = Array.isArray(current)
        ? current.find((item) => (item as { name?: unknown })?.name === parameter)
        : undefined;
    } else {
      current = (current as Record<string, unknown> | undefined)?.[part.replaceAll("~1", "/")];
    }
  }
  return current;
}

function stringEnum(document: unknown, path: string): readonly string[] {
  const values = at(document, `${path}/enum`);
  if (!Array.isArray(values) || !values.length || values.some((v) => typeof v !== "string")) {
    throw new TypeError(`OpenAPI ${path} must define a non-empty string enum`);
  }
  return values as string[];
}

function integer(document: unknown, path: string): number {
  const value = at(document, path);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`OpenAPI ${path} must be a non-negative integer`);
  }
  return value;
}

function text(document: unknown, path: string): string {
  const value = at(document, path);
  if (typeof value !== "string" || !value) throw new TypeError(`OpenAPI ${path} must be a string`);
  return value;
}
/**
 * One contract value that guards several places in the API. Every path must
 * publish the same value; when one changes alone the generator fails, so a client
 * never checks one endpoint's input against another endpoint's bound.
 */
function same<T>(read: (document: unknown, path: string) => T, document: unknown, paths: string[]) {
  const [first, ...rest] = paths.map((path) => ({ path, value: read(document, path) }));
  if (!first) throw new TypeError("A contract value needs at least one OpenAPI path");
  for (const other of rest) {
    if (other.value !== first.value) {
      throw new TypeError(
        `OpenAPI ${other.path} (${String(other.value)}) differs from ${first.path} (${String(first.value)})`,
      );
    }
  }
  return first.value;
}

/**
 * The published vocabularies, bounds, and patterns clients enforce before a
 * request, read from the canonical document so they can never drift from it.
 */
function contract(document: unknown) {
  const schemas = "/components/schemas";
  const limits = `${schemas}/Capabilities/properties/limits/properties`;
  const memories = "/paths/~1api~1v1~1memories/get/parameters";
  const context = `${schemas}/RetrieveContextInput/properties`;
  const codeSearch = "/paths/~1api~1v1~1code~1search/get/parameters";
  const codeDependencies = "/paths/~1api~1v1~1code~1dependencies/get/parameters";
  const idempotentWrites = [
    "/paths/~1api~1v1~1memories/post",
    "/paths/~1api~1v1~1memories~1{memoryId}/patch",
    "/paths/~1api~1v1~1memories~1{memoryId}/delete",
    "/paths/~1api~1v1~1episodes/post",
    "/paths/~1api~1v1~1episodes~1{episodeId}/delete",
    "/paths/~1api~1v1~1memory-proposals/post",
  ];
  return {
    vocabularies: {
      memoryScopes: stringEnum(document, `${schemas}/Memory/properties/scope`),
      episodeKinds: stringEnum(document, `${schemas}/Episode/properties/kind`),
      observationKinds: stringEnum(document, `${schemas}/Observation/properties/kind`),
      memoryProposalKinds: stringEnum(document, `${schemas}/MemoryProposal/properties/kind`),
      memoryProposalStatuses: stringEnum(document, `${schemas}/MemoryProposal/properties/status`),
      codeEvidenceRelationships: stringEnum(
        document,
        `${schemas}/MemoryCodeEvidence/properties/relationship`,
      ),
      codeEvidenceValidationStates: stringEnum(
        document,
        `${schemas}/MemoryCodeEvidence/properties/validationState`,
      ),
      codeIndexJobStatuses: stringEnum(document, `${schemas}/CodeIndexJob/properties/status`),
      codeDependencyKinds: stringEnum(document, `${schemas}/CodeDependencyEdge/properties/kind`),
      codeDependencyResolutions: stringEnum(
        document,
        `${schemas}/CodeDependencyEdge/properties/resolution`,
      ),
      codeDependencyDirections: stringEnum(
        document,
        "/paths/~1api~1v1~1code~1dependencies/get/parameters/[direction]/schema",
      ),
      codeSearchChannels: stringEnum(
        document,
        `${schemas}/CodeArtifact/properties/matchedChannels/items`,
      ),
      contextRoutes: stringEnum(document, `${context}/route`),
      contextPlanRoutes: stringEnum(document, `${schemas}/ContextRetrievalPlan/properties/route`),
      contextIntents: stringEnum(document, `${schemas}/ContextRetrievalPlan/properties/intent`),
      contextImpactStates: stringEnum(
        document,
        `${schemas}/ContextualImpactAssessment/properties/state`,
      ),
    },
    limits: {
      memoryMetadataSerializedLength: integer(
        document,
        `${schemas}/Memory/properties/metadata/x-lore-maxSerializedLength`,
      ),
      memorySearchQueryLength: same(integer, document, [
        `${memories}/[q]/schema/maxLength`,
        `${context}/query/maxLength`,
        `${context}/memoryQuery/maxLength`,
      ]),
      memoryListLimit: integer(document, `${memories}/[limit]/schema/maximum`),
      memoryListOffset: integer(document, `${memories}/[offset]/schema/maximum`),
      graphNodes: integer(
        document,
        "/paths/~1api~1v1~1graph/get/parameters/[limit]/schema/maximum",
      ),
      memoryProposalEvidence: integer(document, `${limits}/memoryProposalEvidence/const`),
      memoryProposalList: integer(document, `${limits}/memoryProposalList/const`),
      episodeObservations: integer(document, `${limits}/episodeObservations/const`),
      episodeContentCharacters: integer(document, `${limits}/episodeContentCharacters/const`),
      episodeMetadataCharacters: integer(document, `${limits}/episodeMetadataCharacters/const`),
      observationContentCharacters: integer(
        document,
        `${limits}/observationContentCharacters/const`,
      ),
      observationBatchRead: integer(document, `${limits}/observationBatchRead/const`),
      codeSearchResults: integer(document, `${limits}/codeSearchResults/const`),
      codeDependencyResults: integer(document, `${limits}/codeDependencyResults/const`),
      codeQueryLength: same(integer, document, [
        `${codeSearch}/[q]/schema/maxLength`,
        `${context}/codeQuery/maxLength`,
      ]),
      codeSymbolLength: integer(document, `${codeDependencies}/[symbol]/schema/maxLength`),
      codeSourceRefLength: integer(
        document,
        `${schemas}/EnqueueCodeIndexInput/properties/sourceRef/maxLength`,
      ),
      repositoryKeyLength: same(integer, document, [
        `${context}/repositoryKey/maxLength`,
        `${codeSearch}/[repository_key]/schema/maxLength`,
        `${codeDependencies}/[repository_key]/schema/maxLength`,
        `${schemas}/EnqueueCodeIndexInput/properties/repositoryKey/maxLength`,
        `${schemas}/RevalidateMemoryCodeEvidenceInput/properties/repositoryKey/maxLength`,
      ]),
      repositoryPathLength: same(integer, document, [
        `${context}/pathPrefix/maxLength`,
        `${codeSearch}/[path_prefix]/schema/maxLength`,
        `${codeDependencies}/[path]/schema/maxLength`,
        `${schemas}/MemoryProposalCodeEvidence/properties/citedPath/maxLength`,
      ]),
      contextMemoryLimit: integer(document, `${context}/memoryLimit/maximum`),
      contextMemoryLimitDefault: integer(document, `${context}/memoryLimit/default`),
      contextCodeLimit: integer(document, `${context}/codeLimit/maximum`),
      contextCodeLimitDefault: integer(document, `${context}/codeLimit/default`),
      codeDependencyResultsDefault: integer(
        document,
        "/paths/~1api~1v1~1code~1dependencies/get/parameters/[limit]/schema/default",
      ),
      codeIndexJobList: integer(
        document,
        "/paths/~1api~1v1~1code~1index-jobs/get/parameters/[limit]/schema/maximum",
      ),
      codeIndexJobListDefault: integer(
        document,
        "/paths/~1api~1v1~1code~1index-jobs/get/parameters/[limit]/schema/default",
      ),
      cursorLength: same(integer, document, [
        `${memories}/[cursor]/schema/maxLength`,
        "/paths/~1api~1v1~1evaluations~1suites/get/parameters/[cursor]/schema/maxLength",
      ]),
      idempotencyKeyLength: same(
        integer,
        document,
        idempotentWrites.map(
          (operation) => `${operation}/parameters/[Idempotency-Key]/schema/maxLength`,
        ),
      ),
      workspaceNameLength: integer(
        document,
        "/paths/~1api~1v1~1workspaces/post/requestBody/content/application~1json/schema/properties/name/maxLength",
      ),
    },
    patterns: {
      commitOid: same(text, document, [
        `${context}/commitOid/pattern`,
        `${codeSearch}/[commit_oid]/schema/pattern`,
        `${codeDependencies}/[commit_oid]/schema/pattern`,
        `${schemas}/EnqueueCodeIndexInput/properties/commitOid/pattern`,
        `${schemas}/RevalidateMemoryCodeEvidenceInput/properties/commitOid/pattern`,
      ]),
      idempotencyKey: same(
        text,
        document,
        idempotentWrites.map(
          (operation) => `${operation}/parameters/[Idempotency-Key]/schema/pattern`,
        ),
      ),
    },
  };
}

export async function generatedSdkTypes(): Promise<string> {
  const ast = await openapiTS(loreOpenApiDocument() as never, {
    alphabetize: true,
    defaultNonNullable: false,
    immutable: true,
  });
  return `${generatedHeader("Lore's canonical OpenAPI document")}${astToString(ast)}`;
}

async function generatedArtifacts(): Promise<ReadonlyMap<URL, string>> {
  const document = loreOpenApiDocument() as unknown as OpenApiDocument;
  const errorCodes = openApiErrorCodes(document);
  const [openapi, cliVersion, mcpVersion, groundingSource] = await Promise.all([
    generatedSdkTypes(),
    packageVersion("packages/cli/package.json"),
    packageVersion("packages/mcp/package.json"),
    readFile(groundingSourceUrl, "utf8"),
  ]);
  return new Map([
    [openApiOutputUrl, openapi],
    [
      groundingOutputUrl,
      `${generatedHeader("src/modules/context/grounding.ts")}${groundingSource}`,
    ],
    [
      runtimeOutputUrl,
      `${generatedHeader("Lore's canonical OpenAPI document")}export const LORE_ERROR_CODES = ${JSON.stringify(errorCodes, null, 2)} as const;\n\nexport const MEMORY_CONTENT_LIMITS = ${JSON.stringify(memoryContentLimits(document), null, 2)} as const;\n\n/** Published vocabularies, bounds, and patterns; clients never restate them. */\nexport const LORE_CONTRACT = ${JSON.stringify(contract(document), null, 2)} as const;\n`,
    ],
    [
      cliVersionOutputUrl,
      `${generatedHeader("packages/cli/package.json")}export const LORE_CLI_VERSION = ${JSON.stringify(cliVersion)};\n`,
    ],
    [
      mcpVersionOutputUrl,
      `${generatedHeader("packages/mcp/package.json")}export const LORE_MCP_VERSION = ${JSON.stringify(mcpVersion)};\n`,
    ],
  ]);
}

async function main(): Promise<void> {
  const artifacts = await generatedArtifacts();
  if (process.argv.includes("--check")) {
    let stale = false;
    for (const [outputUrl, generated] of artifacts) {
      const current = await readFile(outputUrl, "utf8").catch(() => "");
      if (current !== generated) {
        console.error(`${outputUrl.pathname} is stale; run bun run sdk:generate`);
        stale = true;
      }
    }
    if (stale) {
      process.exitCode = 1;
    }
    return;
  }
  for (const [outputUrl, generated] of artifacts) {
    await mkdir(new URL(".", outputUrl), { recursive: true });
    await writeFile(outputUrl, generated);
  }
}

await main();
