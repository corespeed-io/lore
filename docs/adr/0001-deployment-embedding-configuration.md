# Use a fixed vector protocol with deployment-selected embedding models

Self-host operators select one embedding provider and model per deployment. Lore v1
fixes the vector protocol at 1024 dimensions and records a preprocessing revision
with every vector. Ollama, Google Gemini, and OpenAI adapters must all satisfy that
contract; an incompatible model fails validation instead of changing the schema.
Changing provider, model, dimension, or preprocessing revision requires an explicit
re-embedding migration and must never mix old and new vector spaces.
