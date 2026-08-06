# Google Gemini Embeddings API for Lore

Research date: 2026-08-06. Sources are limited to official Google documentation
and API discovery/reference material.

## Decision

Use provider key `google` with the stable model `gemini-embedding-2`. It accepts
text and multimodal input, supports 128–3072 output dimensions, has an 8,192-token
text input limit, and has no announced shutdown date. Google recommends 768,
1536, or 3072 dimensions; Lore's 1024 dimension is nevertheless within the
supported range. [`gemini-embedding-2` model details](https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2)
and [embedding model table](https://ai.google.dev/gemini-api/docs/embeddings#model-versions)

Do not start a new integration on `embedding-2-preview`; its shutdown date is
2026-08-10. `gemini-embedding-001` remains stable until 2028-05-14, but Google
recommends `gemini-embedding-2` as its replacement. Their vector spaces are
incompatible, so changing between them requires re-embedding all stored data.
[Deprecation schedule](https://ai.google.dev/gemini-api/docs/deprecations) and
[migration guidance](https://ai.google.dev/gemini-api/docs/embeddings#migration-from-gemini-embedding-001)

## HTTP contract

Google's guide uses the `v1beta` Developer API endpoints below. The official
Discovery document also exposes the same methods under `v1`; using `v1beta` keeps
Lore aligned with Google's current embedding examples and reference.

```text
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents
```

Send the key in the header, not the URL:

```http
Content-Type: application/json
x-goog-api-key: ${GEMINI_API_KEY}
```

The API's general query parameters include `key`, but the documented header
avoids exposing a credential in URLs, proxy logs, or traces. Google also says new
keys are authorization keys and that Standard keys will be rejected beginning in
September 2026. [Authentication](https://ai.google.dev/api),
[API-key guidance](https://ai.google.dev/gemini-api/docs/api-key), and
[v1 Discovery](https://generativelanguage.googleapis.com/$discovery/rest?version=v1)

For one vector, the current non-deprecated REST shape is:

```json
{
  "model": "models/gemini-embedding-2",
  "content": {
    "parts": [{ "text": "task: search result | query: where is the runbook?" }]
  },
  "embedContentConfig": {
    "outputDimensionality": 1024
  }
}
```

The success response contains `embedding.values` and aggregate usage metadata:

```json
{
  "embedding": { "values": [0.0123, -0.0456] },
  "usageMetadata": { "promptTokenCount": 12, "promptTokenDetails": [] }
}
```

The guide's REST dimension example still uses legacy top-level
`output_dimensionality`, while the current API reference marks the top-level
field deprecated. A new direct REST adapter should use lower-camel-case
`embedContentConfig.outputDimensionality`. SDK configuration names differ:
JavaScript uses `config.outputDimensionality`, while Python uses
`config.output_dimensionality`. [REST request schema](https://ai.google.dev/api/embeddings#method:-models.embedcontent)

Lore's `texts[]` adapter should call the synchronous `batchEmbedContents` method
to preserve one vector per chunk:

```json
{
  "requests": [
    {
      "model": "models/gemini-embedding-2",
      "content": {
        "parts": [{ "text": "title: Runbook | text: deployment procedure" }]
      },
      "embedContentConfig": { "outputDimensionality": 1024 }
    },
    {
      "model": "models/gemini-embedding-2",
      "content": {
        "parts": [{ "text": "title: Incident | text: database outage" }]
      },
      "embedContentConfig": { "outputDimensionality": 1024 }
    }
  ]
}
```

Every nested `model` must equal the path model. The response is
`{ "embeddings": [{ "values": [...] }, ...], "usageMetadata": {...} }`, with
embeddings in request order. Google does not publish a numeric item limit for
this synchronous method, so Lore should conservatively split large input arrays
without claiming an official maximum. Validate the response count, configured
dimension, and finiteness of every value. [Batch request and response schema](https://ai.google.dev/api/embeddings#method:-models.batchembedcontents)

`gemini-embedding-2` aggregates multiple parts supplied to one `embedContent`
request into one vector. Separate `Content` requests, or
`batchEmbedContents`, are required for separate chunk vectors.
[Aggregation behavior](https://ai.google.dev/gemini-api/docs/embeddings#migration-from-gemini-embedding-001)

## Retrieval preprocessing replaces `taskType`

`gemini-embedding-2` does **not** support `taskType`. For text retrieval Google
requires these exact asymmetric prompt formats:

```text
query:    task: search result | query: {content}
document: title: {title} | text: {content}
no title: title: none | text: {content}
```

Question answering, fact checking, and code retrieval replace `search result`
with `question answering`, `fact checking`, or `code retrieval`. Google explicitly
says not to use its symmetric `sentence similarity` task for search. Lore should
therefore version this preprocessing alongside provider and model identity; a
prefix change changes the embedding contract for both indexed Memories and
queries. [Task formats](https://ai.google.dev/gemini-api/docs/embeddings#task-types-with-embeddings-2)

Only the older `gemini-embedding-001` accepts `taskType`, such as
`RETRIEVAL_DOCUMENT` and `RETRIEVAL_QUERY`. Those fields must not be sent to
`gemini-embedding-2`.

## Dimensions and normalization

`gemini-embedding-2` defaults to 3072 dimensions and automatically L2-normalizes
reduced outputs. Neither 1024 nor 1536 needs client-side normalization. The older
`gemini-embedding-001` requires manual normalization for every non-3072 output.
[Smaller-dimension guidance](https://ai.google.dev/gemini-api/docs/embeddings#ensuring-quality-for-smaller-dimensions)

This is model-specific behavior, not an industry-wide dimension rule: 1536 is one
of Google's recommended sizes, while 1024 is a valid supported size. Lore should
still enforce the configured output length and reject non-finite values.

## Limits and failure behavior

- Text input is limited to 8,192 tokens. Lore should continue chunking itself;
  the Developer API does not provide a reliable cross-SDK truncation contract.
- Rate limits vary by project, model, and usage tier, are enforced per project
  rather than per key, and are measured across RPM, TPM, and RPD. Read the active
  values from AI Studio instead of hard-coding quotas.
- For direct REST, use a bounded timeout and bounded exponential backoff with
  jitter for `408`, `429`, and `5xx`. Do not retry `400` or `403`.
- Treat a failed synchronous batch as a failed HTTP request. The documented
  response has no per-item success/error union.

[Model limits](https://ai.google.dev/gemini-api/docs/embeddings#model-versions),
[rate-limit behavior](https://ai.google.dev/gemini-api/docs/rate-limits), and
[retry guidance](https://ai.google.dev/gemini-api/docs/troubleshooting#retry-strategy)

Google separately offers asynchronous `asyncBatchEmbedContent` for offline bulk
work. It targets completion within 24 hours and costs 50% of synchronous
embedding, making it a possible future re-indexing path, not Lore's request-path
adapter. [Batch API](https://ai.google.dev/gemini-api/docs/batch-api) and
[async endpoint](https://ai.google.dev/api/embeddings#method:-models.asyncbatchembedcontent)
