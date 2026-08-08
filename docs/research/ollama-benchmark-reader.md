# Ollama native benchmark reader contract

Research date: 2026-08-07. Sources are limited to Ollama's official
documentation and the official repository at commit
[`35f71382`](https://github.com/ollama/ollama/tree/35f71382de673228c8b7ae7a9f5b50e0fdbadec5).

## Decision

Use Ollama's native `POST http://127.0.0.1:11434/api/chat` endpoint for a
benchmark-only local reader. Do not route this adapter through
`/v1/chat/completions`: Ollama describes that endpoint as compatibility with
only **parts** of the OpenAI API, and its supported field list omits native
`keep_alive`, `options`, and per-request `num_ctx`. The native endpoint exposes
all three and returns Ollama's prompt/output token counts and timing breakdown
directly. [Native chat API](https://docs.ollama.com/api/chat) and
[OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)

This reader is an evaluation transport, not a production Memory dependency. A
failed or unavailable reader must make the benchmark incomplete; it must not
change Memory writes, retrieval, or RLS behavior.

## Pinned request

Send one non-streaming request per answer:

```http
POST http://127.0.0.1:11434/api/chat
Content-Type: application/json

{
  "model": "<deployment-selected local model>",
  "messages": [
    { "role": "system", "content": "<versioned reader instruction>" },
    {
      "role": "user",
      "content": "<versioned question and retrieved evidence>",
      "images": ["<bare base64 bytes, only for verified image cases>"]
    }
  ],
  "stream": false,
  "think": false,
  "keep_alive": "5m",
  "options": {
    "temperature": 0,
    "seed": 42,
    "num_ctx": 32768,
    "num_predict": 256
  }
}
```

`model` and `messages` are required; `stream` defaults to `true`, so Lore must
set it to `false` to receive one terminal object. Generation controls belong
inside native `options`. Ollama's official reproducible-chat example combines
a fixed `seed` with `temperature: 0`; its model documentation says a fixed seed
generates the same text for the same prompt. `num_ctx` and `num_predict` must be
explicit benchmark configuration rather than host defaults. `think` must also
be explicit because supported reasoning models can return a separate thinking
trace. [Official reproducible chat example](https://github.com/ollama/ollama/blob/35f71382de673228c8b7ae7a9f5b50e0fdbadec5/docs/api.md#chat-request-reproducible-outputs),
[generation option types](https://github.com/ollama/ollama/blob/35f71382de673228c8b7ae7a9f5b50e0fdbadec5/api/types.go#L566-L596),
[parameter semantics](https://docs.ollama.com/modelfile#valid-parameters-and-values),
and [thinking output](https://docs.ollama.com/capabilities/thinking)

Pin and report the exact system prompt, user-prompt template, option values,
and whether thinking is disabled. A seed is useful reproducibility control, but
Lore should not infer bit-for-bit reproducibility across a changed model digest,
Ollama version, prompt template, backend, or hardware; the official guarantee is
only phrased in terms of the same prompt.

## Response and accounting

For `stream: false`, the answer is `message.content`, not a top-level
`response` and not `choices[0]`. A successful terminal response contains:

```json
{
  "model": "<name>",
  "created_at": "<ISO-8601 timestamp>",
  "message": { "role": "assistant", "content": "<answer>" },
  "done": true,
  "done_reason": "stop",
  "total_duration": 0,
  "load_duration": 0,
  "prompt_eval_count": 0,
  "prompt_eval_duration": 0,
  "eval_count": 0,
  "eval_duration": 0
}
```

All durations are nanoseconds. `prompt_eval_count` is the number of input
tokens processed and `eval_count` is the number of generated tokens; native
chat has no OpenAI-style `usage` object. Lore should record both counts, their
sum, all four timing values, `done_reason`, and wall-clock latency. Reject an
HTTP error, malformed object, non-terminal response, missing/non-string
`message.content`, or invalid counts rather than silently scoring an empty
answer. [Chat response schema](https://docs.ollama.com/api/chat#response) and
[usage definitions](https://docs.ollama.com/api/usage)

## Memory residency

`keep_alive` accepts a duration string, seconds, a negative value for indefinite
residency, or `0` to unload after the response. Its request value overrides
`OLLAMA_KEEP_ALIVE`; the server default is five minutes. For Lore's RAM-limited
local benchmark, use a bounded duration during a warm run, report it, then send
`{"model":"...","messages":[],"keep_alive":0}` (or run `ollama stop`) in a
`finally` path. Lore rejects negative/indefinite residency. A cold-latency run
may deliberately use `0`, but must be reported separately because
`load_duration` then contaminates every sample. [Official keep-alive
semantics](https://docs.ollama.com/faq#how-do-i-keep-a-model-loaded-in-memory-or-make-it-unload-immediately)

## Images

Images belong on the relevant native message as `images: string[]`. The raw REST
API expects **bare base64-encoded image bytes**; filesystem paths, URLs, and raw
byte conveniences are SDK behavior, not the REST contract. Only send images
when `/api/show` reports the `vision` capability, and record the image digest and
media type in the benchmark case. [Official vision REST
example](https://docs.ollama.com/capabilities/vision#usage-with-ollamas-api) and
[message type](https://github.com/ollama/ollama/blob/35f71382de673228c8b7ae7a9f5b50e0fdbadec5/api/types.go#L194-L207)

## Reproducible model identity

The chat response's `model` field is only the model name; it does not contain a
weight/manifest digest or the Ollama server version. Before a run, Lore should:

1. record `GET /api/version`;
2. resolve the configured name through `GET /api/tags` and record `digest`,
   `modified_at`, size, family, parameter size, and quantization;
3. call `POST /api/show` and record or hash `template`, `parameters`,
   `capabilities`, and relevant `model_info`;
4. verify the same tag digest again after the run.

This is necessary because Ollama says its API is not strictly versioned and a
name/tag alone is not sufficient benchmark provenance. A local HTTP endpoint
also does not by itself prove local inference: the same API can run Ollama cloud
models, and the native response type can include `remote_model` and
`remote_host`. A strictly local Lore run should require a locally listed model and
loopback endpoint, reject those remote fields, and may start Ollama with cloud
disabled.
[API versioning](https://docs.ollama.com/api/introduction#versioning),
[server version](https://docs.ollama.com/api-reference/get-version),
[model digest](https://docs.ollama.com/api/tags),
[model metadata](https://docs.ollama.com/api-reference/show-model-details), and
[native response identity fields](https://github.com/ollama/ollama/blob/35f71382de673228c8b7ae7a9f5b50e0fdbadec5/api/types.go#L518-L548)

## OpenAI-compatibility caveats

- `/v1/chat/completions` is explicitly partial compatibility. Its public field
  list does not include `keep_alive`, native `options`, or `num_ctx`; Ollama's
  documented workaround for OpenAI clients that need a different context size
  is creating another Modelfile/model name.
- OpenAI controls are top-level (`temperature`, `seed`, `max_tokens`), while the
  native equivalents are `options.temperature`, `options.seed`, and
  `options.num_predict`. The compatibility translator also supplies its own
  defaults when fields are absent, so implicit defaults are not portable.
- Compatibility text is `choices[0].message.content` and usage is
  `usage.prompt_tokens`, `completion_tokens`, and `total_tokens`; Ollama's
  source maps these from native `prompt_eval_count` and `eval_count`.
- The compatibility documentation advertises image URL content, but the current
  official translator rejects `http://` and `https://` images and asks for
  base64 instead. Data URLs for JPEG, PNG, or WebP are accepted there; native
  REST uses bare base64 in `messages[].images`.
- The placeholder API key required by OpenAI SDKs is ignored by local Ollama,
  and an OpenAI-looking alias created with `ollama cp` does not establish model
  identity. Benchmark provenance must still use the Ollama digest above.

[Compatibility fields and model-name guidance](https://docs.ollama.com/api/openai-compatibility),
[context-size limitation](https://docs.ollama.com/api/openai-compatibility#setting-the-context-size),
[request translation](https://github.com/ollama/ollama/blob/35f71382de673228c8b7ae7a9f5b50e0fdbadec5/openai/openai.go#L524-L705),
[usage translation](https://github.com/ollama/ollama/blob/35f71382de673228c8b7ae7a9f5b50e0fdbadec5/openai/openai.go#L240-L246), and
[image decoder](https://github.com/ollama/ollama/blob/35f71382de673228c8b7ae7a9f5b50e0fdbadec5/openai/openai.go#L722-L753)
