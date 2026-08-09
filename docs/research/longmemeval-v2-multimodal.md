# LongMemEval-V2 multimodal question support

Research date: 2026-08-07. This note uses only the official LongMemEval-V2 repository and Hugging Face dataset, plus official provider documentation/source. Repository behavior is pinned to [`ef67f10`](https://github.com/xiaowu0162/LongMemEval-V2/commit/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b); dataset assets are pinned to revision [`f152293`](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/tree/f152293e235517d504809563c833d7190b8c713b).

## Finding

The pinned `questions.jsonl` contains 451 cases. Exactly **29** have a non-null `image` field, all are `errors-gotchas`, and all reference a 1280×720 PNG under `question_screenshots/`. Of these, 28 use `llm_gotchas_checker`; `626e401e` uses the deterministic `norm_phrase_set_match`. The remaining text-only profile is therefore 422 cases: 294 deterministic and 128 judge-scored.

Lore can unlock all 29 question-screenshot cases by downloading and verifying only the 29 PNGs: **3,112,508 bytes total** (about 3.0 MiB). The full trajectory screenshot archives are unnecessary while Lore indexes and returns text evidence only. They are required only for multimodal trajectory indexing or image evidence:

| Archive | Bytes | SHA-256 |
| --- | ---: | --- |
| `trajectory_screenshots/enterprise_screenshots_base.tar.gz` | 3,354,163,660 | `5c4a67ae0856aa1ede9b040e7da7c7a2d0b76fdd6344ef87380bcdf9f4b6d7a3` |
| `trajectory_screenshots/web_screenshots.tar.gz` | 2,562,302,847 | `68699c6842412e09a6f89d3c05c5ae8813275918002b52d82dec43ab24dd01fb` |

The archive metadata comes from the [Hugging Face revision API with blob metadata](https://huggingface.co/api/datasets/xiaowu0162/longmemeval-v2/revision/f152293e235517d504809563c833d7190b8c713b?blobs=true). The [repository README](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/README.md#L117-L125) says extracted trajectory screenshots are addressed as `screenshots/<trajectory_id>/<step>.png`; that is distinct from the 29 top-level question screenshots.

The official baseline RAG accepts a `query_image` argument but deliberately ignores it ([source](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/memory_modules/rag.py#L547-L549)). Consequently, sending the screenshot only to the fixed reader is consistent with that baseline, but Lore must report `questionImageSentToRetriever=false` rather than imply multimodal retrieval.

## Exact screenshot-dependent cases

All asset hashes below are present in the dataset's official [`checksums.sha256`](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/blob/f152293e235517d504809563c833d7190b8c713b/checksums.sha256). Each path can be fetched from the pinned revision with `https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/resolve/f152293e235517d504809563c833d7190b8c713b/<path>?download=true`. The byte sizes and dimensions were independently verified after downloading all 29 pinned files.

| ID | Domain | Evaluator | Asset path | Bytes | SHA-256 |
| --- | --- | --- | --- | ---: | --- |
| `18b91103` | enterprise | `llm_gotchas_checker` | `question_screenshots/18b91103.png` | 73,662 | `bbea42dba9cd03527a8a8ddba81f26040a1022866ec93de8f774c55010b6413a` |
| `285db8ec` | enterprise | `llm_gotchas_checker` | `question_screenshots/285db8ec.png` | 83,774 | `cc26abf45342265e012caf3f27040d137f5c459766dfeda29a8745688a79474c` |
| `2f6a21cd` | enterprise | `llm_gotchas_checker` | `question_screenshots/2f6a21cd.png` | 156,140 | `a77eaead88f1224bbb6f5c0ad6cd85b65ed9d608def25b1d2e93caf43cc80a25` |
| `302bf60e` | enterprise | `llm_gotchas_checker` | `question_screenshots/302bf60e.png` | 91,455 | `3676a0004d85cfd55ceebf250af4ad1d178af440373779fd18b4aa86f6601e1e` |
| `48a52262` | enterprise | `llm_gotchas_checker` | `question_screenshots/48a52262.png` | 173,084 | `192b92f176772ceb627dbff6fb99621b12f560e5ed470ad06d8d524dddb1cb25` |
| `4964afed` | enterprise | `llm_gotchas_checker` | `question_screenshots/4964afed.png` | 65,402 | `4c34dd2abc22e9afa87d6bbcf4340ffbce7eea4ec710713056c145b08021ca39` |
| `50d92f55` | enterprise | `llm_gotchas_checker` | `question_screenshots/50d92f55.png` | 63,379 | `d66cad5875db8b052206fa0c75808d97a7c1aa25bc67e04b84481fa180a3de81` |
| `7586cf7c` | enterprise | `llm_gotchas_checker` | `question_screenshots/7586cf7c.png` | 47,480 | `aff0665a68d29a2414d4a12ab21e1905de9a55087f2384f08fc9cf5bae587d47` |
| `8e21c6e5` | enterprise | `llm_gotchas_checker` | `question_screenshots/8e21c6e5.png` | 153,072 | `abaec4759d3b7d463419012bdec1c91daed23268fb9cd0fa77435380b7c69a86` |
| `af2ebaed` | enterprise | `llm_gotchas_checker` | `question_screenshots/af2ebaed.png` | 83,672 | `43b4ef22be21d6869aa3681637ada80f0d8d0ffd6e635d0e58957c099e5f28e9` |
| `c35bfeed` | enterprise | `llm_gotchas_checker` | `question_screenshots/c35bfeed.png` | 69,594 | `1485db143d25d413d903db47c1df0d8262594ee7f6914b77bd55257108ffe6eb` |
| `ce9aa351` | enterprise | `llm_gotchas_checker` | `question_screenshots/ce9aa351.png` | 85,773 | `5c5dfb81edb824964b386e53edd33edcc96dc85aa75e9857e52b63aece1dbd65` |
| `fa504f5e` | enterprise | `llm_gotchas_checker` | `question_screenshots/fa504f5e.png` | 158,287 | `551d6faa51fd82d3ba1529a6cc3944742b9f3318dded3275ba3431eb7c1ab0d8` |
| `fb56a896` | enterprise | `llm_gotchas_checker` | `question_screenshots/fb56a896.png` | 98,990 | `5934817de4e512d38c0421f10c3e68c4d84cad3284e4a733dcbce365971d070c` |
| `0574c69a` | web | `llm_gotchas_checker` | `question_screenshots/0574c69a.png` | 95,229 | `62f19636923def38517feb066afb327338012215eeecde2f63b358aaede11c45` |
| `07a0145f` | web | `llm_gotchas_checker` | `question_screenshots/07a0145f.png` | 109,349 | `029d6dff731620358a2b786804fa7d632b5e9294deeb01c7205898c972556d63` |
| `1d864942` | web | `llm_gotchas_checker` | `question_screenshots/1d864942.png` | 60,185 | `cf1f053f4f0702daefef59a861ac1e771910c8354e059d825ac566103c63f1b4` |
| `1e77eb4b` | web | `llm_gotchas_checker` | `question_screenshots/1e77eb4b.png` | 75,409 | `196b973d7cac067e76cf19f8ddff1cd7602739d4940e974d9154704f5d63eb3d` |
| `2cc1b9ca` | web | `llm_gotchas_checker` | `question_screenshots/2cc1b9ca.png` | 87,001 | `e967d2efa9e9a0b2eca3129da4a9e5293138279165728c6d6935b5a5e3596b6c` |
| `42d13006` | web | `llm_gotchas_checker` | `question_screenshots/42d13006.png` | 441,065 | `e005d86ecc6b595e593b5a88fb89172812d1d5c2d4de932f806ce0b5e3b5d569` |
| `626e401e` | web | `norm_phrase_set_match` | `question_screenshots/626e401e.png` | 140,570 | `fda1f973a575430256888c2177a933eb049f65a4645746699996b1ec9d511d3f` |
| `77258cda` | web | `llm_gotchas_checker` | `question_screenshots/77258cda.png` | 52,022 | `a48baf68f1fac917314904b1f7e129d09ea192ca03c659eebe0d75e2774e84c3` |
| `81180ae9` | web | `llm_gotchas_checker` | `question_screenshots/81180ae9.png` | 73,239 | `eb088d8d7afebb9208a0c0cf9868f183a3d9b16b0c6674a9164b31315edd8a70` |
| `910135bb` | web | `llm_gotchas_checker` | `question_screenshots/910135bb.png` | 80,814 | `fb89c26e0fb7ba7f389ffcd79e541a9b940da14a575bfdeecca919f9635a4a0a` |
| `914ab1d4` | web | `llm_gotchas_checker` | `question_screenshots/914ab1d4.png` | 31,032 | `210883019e0ccb5f3c6cb7de6ef82588c097a05a2f1580afc1f6c21a5b530e75` |
| `b339209c` | web | `llm_gotchas_checker` | `question_screenshots/b339209c.png` | 47,369 | `9767f63510c5175cabcf89a6af498284e318fb990c5c8c24ec7d97572420998e` |
| `ea361b20` | web | `llm_gotchas_checker` | `question_screenshots/ea361b20.png` | 78,087 | `2eb74d20dcd6fe0b253a9c405eef2a079f35b74ca3e68f8626dbae64f0153553` |
| `f2b221fd` | web | `llm_gotchas_checker` | `question_screenshots/f2b221fd.png` | 283,374 | `be85e8d2b5352961620ce63d20a96ab71d495b9a9da73c04a60e6bca644810f4` |
| `fdeddf71` | web | `llm_gotchas_checker` | `question_screenshots/fdeddf71.png` | 53,999 | `e3b4fb256bea33cad6049509a436d93ef4e16eecb58deebfbc275f53b243b154` |

## Official fixed-reader behavior

The paper profile fixes the reader to [`Qwen/Qwen3.5-9B`](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/README.md#L100-L104), served through an OpenAI-compatible Chat endpoint. The checked-in defaults are temperature `0.6`, `top_p=0.95`, `top_k=20`, thinking enabled, a 20,000-token completion cap, a 200,000-token memory-context cap measured with the Qwen3.5 processor, and reader concurrency 16 ([run configuration](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/evaluation/run_eval.py#L64-L89)). Thus “fixed reader” does **not** mean deterministic decoding.

The official reader protocol is:

1. Select the domain-specific system instruction. Both prompts require `UNKNOWN` when memory is insufficient and call out flawed-premise/gotcha questions ([prompt source](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/evaluation/harness.py#L71-L90)).
2. Construct one user content array: `### Memory context:\n`; each ordered text or image evidence item; `\n\n### Question to answer:\n<question>`; then the question screenshot as the **last** content part. Images are MIME-aware base64 data URLs in Chat `image_url` parts ([message construction](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/evaluation/harness.py#L497-L549)).
3. Count and truncate only the ordered memory-context prefix at whole-item boundaries with `AutoProcessor.from_pretrained("Qwen/Qwen3.5-9B")`; the question is not part of that 200k context budget ([truncation](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/evaluation/harness.py#L350-L445)).
4. Call `/v1/chat/completions`, pass `max_tokens`, temperature, `top_p`, and extra `top_k`, then read `choices[0].message.content` and Chat usage counters ([request and parsing](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/evaluation/harness.py#L851-L906)).

Dataset preparation rewrites `{question: string, image: relativePath}` into `{question: {text, image: absolutePath}}` ([loader](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/data/public_data.py#L68-L106)). The harness passes both fields to retrieval, validates returned image paths, and preserves evidence order ([query path](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/evaluation/harness.py#L305-L330), [context validation](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/evaluation/harness.py#L552-L592)).

### Prompt compatibility trap

The checked-in Python source spells the requested wrapper as `\boxed{}` inside an ordinary string literal. At runtime `\b` becomes U+0008 BACKSPACE, so the actual suffix is `\x08oxed{}`, not the intended literal `\boxed{}`. Reproduced prompt fingerprints are:

| Compatibility mode | Web bytes / SHA-256 | Enterprise bytes / SHA-256 |
| --- | --- | --- |
| `official-runtime-bug` | 548 / `c70772c5f4ab1dbdcee28218d5e2b98595a84d64196012cbd00bb9de9e63fd1f` | 393 / `b2d24d41b022824ddea06b61255ead1a9aceae79e4f1658775fddd6d6e66320e` |
| `corrected-v1` (`\\boxed{}` at runtime) | 549 / `2b8c109d7b4041b7a6ae9b8fbaf70b636d419dfe70c02ad96daba738aed5824d` | 394 / `7f5e9779b17215affccfb29cd9fa07ea17dec312b98f25a112ad3a8eefcbf5d3` |

Lore's current reader instructions match the corrected hashes. That is the preferable semantic behavior, but it is not byte-for-byte official. Every result must record one of these compatibility modes and the actual prompt hash.

## Provider request contracts

### vLLM OpenAI-compatible Chat — official parity profile

Use the Chat shape produced by the official harness: text parts plus `{type:"image_url", image_url:{url:"data:image/png;base64,..."}}`. vLLM's official multimodal guide confirms that the OpenAI-compatible server accepts interleaved multimodal Chat parts and data URLs; it requires a vision-language model and a compatible chat template ([v0.26.0 guide](https://docs.vllm.ai/en/v0.26.0/features/multimodal_inputs/), [pinned source example](https://github.com/vllm-project/vllm/blob/568afb3a13806beb53bb2e6bd518269357b237c0/examples/generate/multimodal/openai_chat_completion_client_for_multimodal.py)). Configure `--limit-mm-per-prompt.image 1` for question-image-only Lore, and increase it only if Lore later returns image evidence.

Encode verified local bytes as data URLs rather than allowing reader-time remote or `file://` fetches. This avoids widening vLLM's local-media access and SSRF surface. Pin the vLLM version, model, chat template, and all sampling parameters; vLLM `v0.26.0` source here is pinned to [`568afb3`](https://github.com/vllm-project/vllm/tree/568afb3a13806beb53bb2e6bd518269357b237c0).

### OpenAI Chat and Responses — portability profiles

OpenAI accepts image URLs, base64 data URLs, or file IDs, including multiple images in one request ([Images and vision guide](https://developers.openai.com/api/docs/guides/images-vision)). For Chat, preserve the official ordering with `{type:"text",text}` and `{type:"image_url",image_url:{url:"data:image/png;base64,...",detail:"auto"}}`; parse `choices[0].message.content` and `usage.prompt_tokens/completion_tokens/total_tokens` ([Chat reference](https://developers.openai.com/api/reference/resources/chat)).

For Responses, map the same sequence to `{type:"input_text",text}` and `{type:"input_image",image_url:"data:image/png;base64,...",detail:"auto"}`; set `store:false`, parse `output_text` (or text output items), and record `usage.input_tokens/output_tokens/total_tokens` ([Responses reference](https://developers.openai.com/api/reference/resources/responses)). The official harness omits image detail, equivalent to provider-selected `auto`; changing to `high` or `original` creates a new benchmark protocol revision.

### Google Interactions — portability profile

Google Interactions accepts ordered input parts `{type:"text",text}` and `{type:"image",data:"<raw base64>",mime_type:"image/png",resolution?:"low"|"medium"|"high"|"ultra_high"}`. Send `model`, the domain prompt as `system_instruction`, `store:false`, and `stream:false`; require `status:"completed"`, extract text from `model_output` steps, and record total plus modality-specific token usage ([Interactions API reference](https://ai.google.dev/api/interactions-api-v1), [multimodal migration guide](https://ai.google.dev/gemini-api/docs/migrate-to-interactions)).

The current API reference documents `v1beta`, while the migration guide currently demonstrates `v1beta2`. Pin the exact endpoint revision and contract-test it. The documented Interactions `generation_config` exposes output/thinking controls but not the official Qwen temperature/`top_p`/`top_k` tuple, so this is a separate provider profile—not fixed-reader parity.

## Lore implementation contract

Keep one provider-independent reader interface and make transport adaptation lossless:

```ts
type ReaderImage = {
  base64: string;
  mimeType: "image/png";
  path: string;
  sha256: string;
  width: 1280;
  height: 720;
};

type ReaderRequest = {
  domain: "web" | "enterprise";
  question: string;
  questionImage?: ReaderImage;
  evidence: Array<{ type: "text"; text: string } | ReaderImage>;
  protocolRevision: string;
};

type ReaderResult = {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  imageInputTokens: number | null;
  finishStatus: string;
  providerRequestId: string | null;
  latencyMs: number;
};
```

Recommended safeguards and reporting:

- Fetch assets only from the pinned dataset revision during the explicit fetch step. Verify path, SHA-256, byte count, PNG signature/MIME, and 1280×720 dimensions before admitting them to the local manifest. Reject path traversal and missing/mismatched assets. A 1 MiB per-question-image cap safely covers the official maximum of 441,065 bytes.
- Never download or dereference an asset during a reader request. Read verified local bytes and encode them for the provider.
- Preserve the official content order. Report `questionImageSentToRetriever` and `questionImageSentToReader` separately.
- Record repository commit, dataset revision, asset path/hash/bytes/dimensions, provider/model/API revision, prompt compatibility and hash, decoding/thinking/context settings, image detail/resolution, vLLM version/chat template where applicable, latency, provider request id, and returned usage counters. Judge model and usage remain separate.
- Name the comparable profile `longmemeval-v2-official-qwen-vllm`. OpenAI and Google variants should be explicitly labeled portability/reader ablations rather than official fixed-reader scores.

## Primary dataset references

- [Dataset schema](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/blob/f152293e235517d504809563c833d7190b8c713b/SCHEMA.md)
- [Dataset card](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/blob/f152293e235517d504809563c833d7190b8c713b/DATA_CARD.md)
- [`questions.jsonl` at the pinned revision](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/blob/f152293e235517d504809563c833d7190b8c713b/questions.jsonl)
- [`questions.jsonl` SHA-256 `0a3ae5ebea938c24d7800e1e0b0828e08ae1646f939a53853b2b8cdc08e292b7`, 286,186 bytes](https://huggingface.co/api/datasets/xiaowu0162/longmemeval-v2/revision/f152293e235517d504809563c833d7190b8c713b?blobs=true)
