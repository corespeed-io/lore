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
