import { LORE_CONTRACT } from "@corespeed/lore-sdk";
import { expect, test } from "vitest";
import { loreOpenApiDocument } from "@/server/openapi/document";
import { clientContract } from "../../tools/sdk-codegen/contract";

type Node = Record<string, unknown>;

/**
 * Give one code-search parameter its own schema. Endpoints may share a schema
 * object, so an in-place edit would change every endpoint at once.
 */
function editCodeSearchParameter(document: Node, name: string, edit: (schema: Node) => void) {
  const paths = document.paths as Record<string, { get: { parameters: Node[] } } | undefined>;
  const operation = paths["/api/v1/code/search"];
  if (!operation) throw new Error("missing /api/v1/code/search");
  const parameter = operation.get.parameters.find((item) => item.name === name);
  if (!parameter) throw new Error(`missing ${name}`);
  const schema = { ...(parameter.schema as Node) };
  edit(schema);
  parameter.schema = schema;
}

test("the SDK's LORE_CONTRACT is what the generator reads from the OpenAPI document", () => {
  expect(clientContract(loreOpenApiDocument())).toEqual(LORE_CONTRACT);
});

test("a bound two endpoints share must agree, or generation fails", () => {
  const document = structuredClone(loreOpenApiDocument()) as unknown as Node;
  editCodeSearchParameter(document, "q", (schema) => {
    schema.maxLength = 4000;
  });
  expect(() => clientContract(document)).toThrow(
    "OpenAPI /components/schemas/RetrieveContextInput/properties/codeQuery/maxLength (2000) differs from /paths/~1api~1v1~1code~1search/get/parameters/[q]/schema/maxLength (4000)",
  );
});

test("a bound that an endpoint stops publishing fails generation", () => {
  const document = structuredClone(loreOpenApiDocument()) as unknown as Node;
  editCodeSearchParameter(document, "path_prefix", (schema) => {
    delete schema.maxLength;
  });
  expect(() => clientContract(document)).toThrow(
    "OpenAPI /paths/~1api~1v1~1code~1search/get/parameters/[path_prefix]/schema/maxLength must be a non-negative integer",
  );
});

/** Give one schema property its own copy, so a shared schema object stays unchanged. */
function editSchemaProperty(
  document: Node,
  schemaName: string,
  property: string,
  edit: (schema: Node) => void,
) {
  const schemas = (document.components as { schemas: Record<string, { properties: Node }> })
    .schemas;
  const properties = schemas[schemaName]?.properties;
  if (!properties) throw new Error(`missing ${schemaName}`);
  const schema = { ...(properties[property] as Node) };
  edit(schema);
  properties[property] = schema;
}

test("a Link weight bound the write and the archive disagree on fails generation", () => {
  const document = structuredClone(loreOpenApiDocument()) as unknown as Node;
  editSchemaProperty(document, "WorkspaceArchiveLink", "weight", (schema) => {
    schema.maximum = 2;
  });
  expect(() => clientContract(document)).toThrow(
    "OpenAPI /components/schemas/WorkspaceArchiveLink/properties/weight/maximum (2) differs from /components/schemas/PutMemoryLinkInput/properties/weight/maximum (1)",
  );
});

test("a Link weight bound that is not a finite number fails generation", () => {
  const document = structuredClone(loreOpenApiDocument()) as unknown as Node;
  editSchemaProperty(document, "MemoryLink", "weight", (schema) => {
    schema.minimum = "0";
  });
  expect(() => clientContract(document)).toThrow(
    "OpenAPI /components/schemas/MemoryLink/properties/weight/minimum must be a finite number",
  );
});

test("the default Link kind the write and the delete publish must agree", () => {
  const document = structuredClone(loreOpenApiDocument()) as unknown as Node;
  const operation = (document.paths as Record<string, Record<string, { parameters: Node[] }>>)[
    "/api/v1/memories/{memoryId}/links/{targetMemoryId}"
  ];
  if (!operation?.delete) throw new Error("missing the Memory Link delete");
  operation.delete.parameters = operation.delete.parameters.map((parameter) =>
    parameter.name === "kind"
      ? { ...parameter, schema: { ...(parameter.schema as Node), default: "cites" } }
      : parameter,
  );
  expect(() => clientContract(document)).toThrow(
    "OpenAPI /paths/~1api~1v1~1memories~1{memoryId}~1links~1{targetMemoryId}/delete/parameters/[kind]/schema/default (cites) differs from /paths/~1api~1v1~1memories~1{memoryId}~1links~1{targetMemoryId}/put/parameters/[kind]/schema/default (related)",
  );
});
