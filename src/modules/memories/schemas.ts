import {
  MEMORY_CONTENT_LIMITS,
  MemoryContentValidationError,
  prepareMemoryContent,
} from "@corespeed/lore-core";
import { z } from "zod/v4";
import {
  JsonValueSchema,
  MemoryMetadataSchema,
  MemoryScopeSchema,
} from "@/server/api/shared-schemas";

// The OSS Memory wire schemas. Each delegates to the engine's input rules.
// Zod string lengths count UTF-16 units. Lore's validator counts Unicode code points
// and checks reconstructable chunk limits; JSON Schema maxLength uses code points.
const MemoryContentSchema = z
  .string({ error: "content is required" })
  .superRefine((content, context) => {
    try {
      prepareMemoryContent(content);
    } catch (error) {
      if (!(error instanceof MemoryContentValidationError)) throw error;
      context.addIssue({ code: "custom", message: error.message });
    }
  })
  .meta({ minLength: 1, maxLength: MEMORY_CONTENT_LIMITS.maximumCharacters });

export const MemorySchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  ownerUserId: z.uuid(),
  createdByAgentId: z.uuid().nullable(),
  scope: MemoryScopeSchema,
  content: MemoryContentSchema,
  metadata: MemoryMetadataSchema,
  version: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

// Preserve the existing HTTP normalization; engine writes retain their exact content.
export const CreateMemoryInputSchema = z.object({
  content: z.string({ error: "content is required" }).trim().pipe(MemoryContentSchema),
  scope: MemoryScopeSchema.meta({ default: "shared" }).optional(),
  metadata: MemoryMetadataSchema.optional(),
});

export const UpdateMemoryInputSchema = CreateMemoryInputSchema.partial()
  .extend({ scope: MemoryScopeSchema.optional() })
  .refine(
    (value) =>
      value.content !== undefined || value.scope !== undefined || value.metadata !== undefined,
    { message: "At least one Memory field is required" },
  )
  .meta({ minProperties: 1 });

export type Memory = z.infer<typeof MemorySchema>;
export type CreateMemoryInput = z.infer<typeof CreateMemoryInputSchema>;
export type UpdateMemoryInput = z.infer<typeof UpdateMemoryInputSchema>;

/** Generate OpenAPI 3.1 components from the same shapes used by the HTTP handlers. */
export function memoryOpenApiSchemas() {
  const registry = z.registry<{ id: string }>();
  registry.add(JsonValueSchema, { id: "JsonValue" });
  registry.add(MemorySchema, { id: "Memory" });
  registry.add(CreateMemoryInputSchema, { id: "CreateMemoryInput" });
  registry.add(UpdateMemoryInputSchema, { id: "UpdateMemoryInput" });

  const { schemas } = z.toJSONSchema(registry, {
    target: "draft-2020-12",
    uri: (id) => `#/components/schemas/${id}`,
    override: ({ zodSchema, jsonSchema }) => {
      // An empty JSON Schema already allows exactly any JSON value. Avoid redundant
      // recursion, which generates a self-referential indexed type in the SDK.
      if (zodSchema === JsonValueSchema) delete jsonSchema.anyOf;
    },
  });
  for (const schema of Object.values(schemas)) {
    delete schema.$schema;
    delete schema.$id;
  }
  return {
    JsonValue: schemas.JsonValue,
    Memory: schemas.Memory,
    CreateMemoryInput: schemas.CreateMemoryInput,
    UpdateMemoryInput: schemas.UpdateMemoryInput,
  };
}
