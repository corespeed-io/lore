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
      `${generatedHeader("Lore's canonical OpenAPI document")}export const LORE_ERROR_CODES = ${JSON.stringify(errorCodes, null, 2)} as const;\n\nexport const MEMORY_CONTENT_LIMITS = ${JSON.stringify(memoryContentLimits(document), null, 2)} as const;\n`,
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
