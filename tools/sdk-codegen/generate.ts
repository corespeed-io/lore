import { mkdir, readFile, writeFile } from "node:fs/promises";
import openapiTS, { astToString } from "openapi-typescript";
import { loreOpenApiDocument } from "../../src/lib/openapi";

const repositoryUrl = new URL("../../", import.meta.url);
const openApiOutputUrl = new URL("packages/typescript-sdk/src/generated/openapi.ts", repositoryUrl);
const runtimeOutputUrl = new URL("packages/typescript-sdk/src/generated/runtime.ts", repositoryUrl);
const cliVersionOutputUrl = new URL("packages/cli/src/generated/version.ts", repositoryUrl);
const mcpVersionOutputUrl = new URL("packages/mcp/src/generated/version.ts", repositoryUrl);
const pythonContractOutputUrl = new URL(
  "packages/python-sdk/src/corespeed_lore/generated_contract.py",
  repositoryUrl,
);

interface PackageManifest {
  version: string;
}

interface JsonSchema {
  $ref?: string;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: readonly JsonSchema[];
  const?: unknown;
  enum?: readonly unknown[];
  items?: JsonSchema;
  oneOf?: readonly JsonSchema[];
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  type?: string;
}

interface OpenApiDocument {
  components: { schemas: Readonly<Record<string, JsonSchema>> };
  info: { version: string };
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

function pythonType(schema: JsonSchema): string {
  if (schema.$ref) return schema.$ref.split("/").at(-1) ?? "Any";
  if (schema.const !== undefined) return `Literal[${JSON.stringify(schema.const)}]`;
  if (schema.enum?.length) {
    return `Literal[${schema.enum.map((value) => JSON.stringify(value)).join(", ")}]`;
  }
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives?.length) {
    const rendered = [...new Set(alternatives.map(pythonType))];
    return rendered.length === 1 ? rendered[0] : `Union[${rendered.join(", ")}]`;
  }
  if (schema.type === "array") return `list[${pythonType(schema.items ?? {})}]`;
  if (schema.type === "object") {
    const valueType =
      typeof schema.additionalProperties === "object"
        ? pythonType(schema.additionalProperties)
        : "Any";
    return `dict[str, ${valueType}]`;
  }
  if (schema.type === "string") return "str";
  if (schema.type === "integer") return "int";
  if (schema.type === "number") return "float";
  if (schema.type === "boolean") return "bool";
  if (schema.type === "null") return "None";
  return "Any";
}

function generatedPythonContract(document: OpenApiDocument, errorCodes: readonly string[]): string {
  const schemas = document.components.schemas;
  const definitions = Object.entries(schemas)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, schema]) => {
      if (schema.type !== "object" || !schema.properties) {
        return `${name}: TypeAlias = ${pythonType(schema)}`;
      }
      const required = new Set(schema.required ?? []);
      const fields = Object.entries(schema.properties).map(([field, fieldSchema]) => {
        const annotation = pythonType(fieldSchema);
        return `    ${field}: ${required.has(field) ? annotation : `NotRequired[${annotation}]`}`;
      });
      return `class ${name}(TypedDict):\n${fields.length ? fields.join("\n") : "    pass"}`;
    });
  return `# Generated from Lore's canonical OpenAPI document. Do not edit by hand.
from __future__ import annotations

from typing import Any, Final, Literal, TypedDict, Union

try:
    from typing import NotRequired, TypeAlias
except ImportError:  # Python 3.9
    from typing_extensions import NotRequired, TypeAlias

LORE_API_VERSION: Final[str] = ${JSON.stringify(document.info.version)}
LORE_ERROR_CODES: Final[frozenset[str]] = frozenset(${JSON.stringify(errorCodes)})

${definitions.join("\n\n")}
`;
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
  const [openapi, cliVersion, mcpVersion] = await Promise.all([
    generatedSdkTypes(),
    packageVersion("packages/cli/package.json"),
    packageVersion("packages/mcp/package.json"),
  ]);
  return new Map([
    [openApiOutputUrl, openapi],
    [
      runtimeOutputUrl,
      `${generatedHeader("Lore's canonical OpenAPI document")}export const LORE_ERROR_CODES = ${JSON.stringify(errorCodes, null, 2)} as const;\n`,
    ],
    [
      cliVersionOutputUrl,
      `${generatedHeader("packages/cli/package.json")}export const LORE_CLI_VERSION = ${JSON.stringify(cliVersion)};\n`,
    ],
    [
      mcpVersionOutputUrl,
      `${generatedHeader("packages/mcp/package.json")}export const LORE_MCP_VERSION = ${JSON.stringify(mcpVersion)};\n`,
    ],
    [pythonContractOutputUrl, generatedPythonContract(document, errorCodes)],
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
