import type { MemoryGraph as EngineGraph } from "@corespeed/lore-core";
import type { MemoryGraph as WireGraph } from "@corespeed/lore-sdk";
import { expectTypeOf, test } from "vitest";

// The OpenAPI Graph schemas are handwritten, so hold them to the engine's shape.
type Keys<T> = keyof T;

test("the Graph wire shape has exactly the engine's fields", () => {
  expectTypeOf<Keys<WireGraph>>().toEqualTypeOf<Keys<EngineGraph>>();
  expectTypeOf<Keys<WireGraph["links"][number]>>().toEqualTypeOf<
    Keys<EngineGraph["links"][number]>
  >();
  expectTypeOf<Keys<WireGraph["nodes"][number]>>().toEqualTypeOf<
    Keys<EngineGraph["nodes"][number]>
  >();
});
