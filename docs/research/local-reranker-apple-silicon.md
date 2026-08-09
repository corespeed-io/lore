# Local reranking on Apple Silicon

> The local numeric ablations below predate Lore's generation-scoped benchmark
> validator. They remain historical research observations, not current release
> claims; rerun the pinned profiles before using their thresholds operationally.

**Decision (2026-08-07):** use a local, quantized
[`Qwen/Qwen3-Reranker-0.6B`](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B)
with **llama.cpp** for Lore's first real local reranker benchmark. It is the
lowest-risk route because llama.cpp's own converter recognizes Qwen3 rerankers,
emits a `RANK` pooling GGUF with the correct yes/no classification head, and its
server exposes the exact `/v1/rerank` shape that Lore's current `vllm` adapter
validates. Do not download the model merely to enable this documentation; make
the download an explicit operator/benchmark action.

This is a local quality experiment, not a new required runtime dependency or a
claim that a local 0.6B model is the best reranker at every workload.

## What is actually available

`Qwen3-Reranker-0.6B` is an Apache-2.0, 0.6B-parameter, 32k-context,
100+-language cross-encoder reranker. Its publisher documents the scoring
operation: compare the final-token logits for `yes` and `no`, then turn those
two values into a probability. It also documents `CrossEncoder` and raw
Transformers use. [Qwen's model card](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B)
is the canonical source for this model and prompt convention.

The memory-specialized option is less straightforward. The public
[`MemReranker-4B` card](https://huggingface.co/IAAR-Shanghai/MemReranker-4B)
states that a 0.6B and a 4B family exists, and offers both through Memos' hosted
API, but its current public Hugging Face organization listing exposes only the
4B checkpoint. A request for `IAAR-Shanghai/MemReranker-0.6B` is not publicly
downloadable as of this note. Therefore **do not represent MemReranker-0.6B as
a locally reproducible checkpoint** until IAAR publishes it or grants access.
The hosted Memos adapter remains the appropriate way to test that model now.

## Recommendation A — llama.cpp, direct `/v1/rerank` compatibility

This is the recommended first local benchmark route.

The current llama.cpp Qwen converter explicitly detects `Qwen3-Reranker`,
extracts the `yes`/`no` classifier rows, writes `RANK` pooling metadata, and
stores a rerank chat template. Its graph applies softmax for Qwen3 rank pooling,
so the first classifier output is a normalized relevance probability. The server
documents a reranking endpoint and aliases `/rerank`, `/v1/rerank`, and
`/v1/reranking`; its source confirms the endpoint checks for rank pooling and
returns the model's rank score. See the official
[Qwen conversion implementation](https://github.com/ggml-org/llama.cpp/blob/master/conversion/qwen.py),
[rank pooling graph](https://github.com/ggml-org/llama.cpp/blob/master/src/llama-graph.cpp),
and [server API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

### Operator recipe (not run by Lore)

```bash
# 1. Explicitly fetch the Apache-2.0 Qwen checkpoint, then convert it to GGUF.
#    The converter has native Qwen3 reranker handling; keep the original
#    tokenizer/README alongside the checkpoint so detection and metadata work.
python convert_hf_to_gguf.py /path/to/Qwen3-Reranker-0.6B \
  --outtype f16 --outfile qwen3-reranker-0.6b-f16.gguf

# 2. Quantize the converted GGUF. Q8_0 is the fidelity-first local baseline;
#    Q4_0 is the RAM-constrained ablation. Benchmark both before choosing.
./build/bin/llama-quantize qwen3-reranker-0.6b-f16.gguf \
  qwen3-reranker-0.6b-q8_0.gguf Q8_0

# 3. Serve one short-context reranking worker. The server documentation says
#    reranking needs embedding/rank pooling; --reranking enables its endpoint.
./build/bin/llama-server -m qwen3-reranker-0.6b-q8_0.gguf \
  --embedding --pooling rank --reranking --ctx-size 512 --parallel 1
```

The request matches the API Lore already uses:

```http
POST http://127.0.0.1:8080/v1/rerank
Content-Type: application/json

{
  "model": "qwen3-reranker-0.6b-q8_0",
  "query": "What did the user decide about the database?",
  "documents": ["...", "..."],
  "top_n": 50
}
```

The response is an object with `model`, `usage.prompt_tokens`,
`usage.total_tokens`, and sorted `results`. Each result has its original
`index` and a normalized `relevance_score`; `top_n` defaults to all documents.
That is sufficient for Lore's existing strict parser, which requires every
candidate index exactly once and each score to be finite and in `[0, 1]`.

### Important instruction caveat

llama.cpp's converter currently writes Qwen's fixed built-in instruction,
`Given a web search query, retrieve relevant passages that answer the query`,
into the GGUF rerank template. Its rerank handler consumes `query`,
`documents`, and `top_n`; it does **not** use Lore's `chat_template_kwargs`
instruction override. Sending the current Lore vLLM request will work because
the required fields and response shape match, but its recorded Lore instruction
would be misleading.

Lore now has a small explicit `llamacpp` adapter rather than silently aliasing it
to `vllm`:

- POST only `model`, `query`, `documents`, and `top_n` to `/v1/rerank`.
- Pin the model revision, GGUF quantization, llama.cpp version, and the fixed
  Qwen template in benchmark metadata.
- Report the fixed template as the reranker instruction; do not accept an
  environment instruction that the server cannot apply.

That avoids configuration drift while retaining the same RLS-first candidate
selection and Lore's fail-open score validation.

### Memory and storage budget

The publisher's unquantized `model.safetensors` artifact is exactly
**1,191,588,280 bytes (1.11 GiB)**; tokenizer files add about 15 MiB. This is
the minimum download for a local conversion. No official Qwen GGUF quantized
artifact is published, so precise Q4/Q8 sizes cannot be promised in advance.
For planning only, 0.6B parameters occupy a theoretical **~559 MiB at 8-bit**
and **~279 MiB at 4-bit** before quantization metadata, unquantized tensors,
runtime buffers, and the KV cache. Measure peak unified-memory use after
conversion; a GGUF file size is not a process-RSS guarantee.

## Recommendation B — vLLM-Metal `/score` (promising, experimental)

vLLM now documents experimental Apple-Silicon GPU inference through its
community-maintained [vLLM-Metal plugin](https://github.com/vllm-project/vllm-metal).
Its own support matrix marks Qwen3-Reranker as supported under
`runner="pooling"` / `classify`, and its pooling guide gives an Apple-Silicon
server command for an 8-bit MLX checkpoint:

```bash
VLLM_ENABLE_V1_MULTIPROCESSING=0 \
VLLM_METAL_USE_PAGED_ATTENTION=1 \
VLLM_METAL_MEMORY_FRACTION=auto \
vllm serve mku64/Qwen3-Reranker-0.6B-mlx-8Bit \
  --revision ba80418a47fa1c4368a6c2287b0e449904063576 \
  --runner pooling --max-model-len 512 \
  --hf-overrides '{
    "architectures": ["Qwen3ForSequenceClassification"],
    "classifier_from_token": ["no", "yes"],
    "is_original_qwen3_reranker": true
  }'
```

The official plugin code computes `sigmoid(logit_yes - logit_no)` by default,
so its normal `classify` output is in `[0,1]`. Its documentation validates the
path through `LLM.score` and `/score`, not an Apple-Silicon `/rerank` smoke
test. The portable request is therefore:

```http
POST http://127.0.0.1:8000/score
Content-Type: application/json

{
  "queries": "What did the user decide about the database?",
  "documents": ["...", "..."]
}
```

The upstream vLLM score protocol accepts query/document pairs and returns one
indexed score per pair. Do **not** assume `/v1/rerank` is supported by the Metal
build merely because upstream CUDA vLLM documents it. Lore now has a `vllm-score`
adapter that uses the plugin's documented pairwise `text_1`/`text_2` arrays, reads
`data[index].score`, validates exact cardinality, unique indexes, and normalized
finite scores, then sorts locally. It is attractive for native Metal execution,
but should be admitted to benchmark results only after the documented
Apple-Silicon smoke test and a Lore RLS benchmark pass.

vLLM-Metal's reference checkpoint is an 8-bit derivative of the Apache-2.0
Qwen base. A 0.6B-parameter model has a theoretical **~559 MiB** 8-bit weight
payload before tokenizer files, quantization metadata, runtime buffers, and the
KV cache. The plugin documentation does not publish a peak unified-memory
measurement or an official Qwen-owned MLX quantized artifact, so treat that
number as a planning floor rather than a download or RSS guarantee.

## Transformers on MPS — valid fallback, not the first server choice

Yes: the official Qwen card demonstrates `sentence_transformers.CrossEncoder`
for this exact model, and Sentence Transformers explicitly accepts `device="mps"`.
PyTorch's [MPS backend](https://pytorch.org/docs/stable/notes/mps.html) supports
moving an ordinary module and tensors to Apple Metal. A one-process benchmark
can therefore run:

```python
import torch
from sentence_transformers import CrossEncoder

model = CrossEncoder(
    "Qwen/Qwen3-Reranker-0.6B",
    device="mps",
    model_kwargs={"torch_dtype": torch.float16},
    max_length=512,
)
scores = model.predict(pairs, activation_fn=torch.nn.Sigmoid())
```

This uses the model publisher's supported CrossEncoder path and produces
probabilities rather than raw logit differences. It needs a small local Python
HTTP wrapper to become a Lore provider; Sentence Transformers does not itself
ship an OpenAI/Cohere-style rerank server. For tight-memory machines, keep
batch size and `max_length` low and use PyTorch's documented MPS high-watermark
controls instead of disabling safety limits. This is a useful correctness
oracle against the llama.cpp conversion, but has more operational surface than
the llama.cpp server.

## MLX-LM and Ollama

Plain [MLX-LM](https://github.com/ml-explore/mlx-lm) is a strong Apple-Silicon
generation/quantization runtime, but its documented server only exposes text
completion and chat-completion routes. Its Qwen3 model class can execute the
forward pass, so a custom Python implementation could reproduce Qwen's
yes/no-logit scorer, but it would still require prompt formatting, batching,
sigmoid normalization, and an HTTP adapter. Prefer vLLM-Metal's already-tested
Qwen3 classification path if choosing MLX.

Ollama is **not** a real local reranker option today. Its official API exposes
generate, chat, embeddings, model management, and related routes, but no
rerank/score endpoint or per-pair classifier score contract. Prompting an
Ollama text model to emit a JSON relevance label is a generative heuristic, not
the Qwen cross-encoder's calibrated yes/no score, and does not meet Lore's
strict reranker contract. Do not add an Ollama reranking provider without an
official scoring API.

## Lore measurement on Apple M4 Pro

On 2026-08-07, Lore ran the first 100 questions from the MemoryAgentBench
Accurate RULER row against llama.cpp `10280 (61881b1f7)` on an Apple M4 Pro with 24 GB
unified memory. The tested artifact was the 639,153,184-byte ggml-org Q8 GGUF,
SHA-256 `22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48`.
The authoritative rerank variant made 100 live provider calls with zero benchmark
cache hits and passed the RLS isolation gate.

The authoritative run uses Lore's document-aware diagnostic revision:
`memoryagentbench-document-aware-lore-chunking-v2-1200-characters`. It preserves
all 1,200 RULER `Document N` boundaries before length chunking, producing 1,332
evidence Memories. This removed false anchors formed by the end of one document
and the beginning of the next. Literal anchors also combine query overlap,
accepted-reference specificity, and answer/query proximity. The earlier
cross-document runs are superseded and must not be used as quality evidence.

The final run used Qwen3-Embedding 0.6B's official query instruction under the
experimental `lore-embedding-v3` profile, which also included structured list
chunking, plus query-specificity weighting in Lore's relaxed English lexical path.
The release protocol ships the query transform alone as `lore-embedding-v2` and
defers structured chunking until canonical chunks have a safe migration path. With
cosine-distance threshold `0.6`, the
20-candidate pool reached Recall@20 `1.00`; the normal hybrid top ten also had
Recall@10 `1.00`, Recall@1 `0.72`, MRR `0.8299`, and nDCG@10 `0.8724` at an
average 113 ms. Qwen reranking with candidate limit 20 and first-stage/reranker
weight `0.75` reached Recall@1 `0.89`, Recall@10 `1.00`, MRR `0.9375`, and
nDCG@10 `0.9533`. It passed every RLS tripwire, averaged 1,156 ms, and had a
1,734 ms p95. Use candidate limit 20 and weight `0.75` as this local model's
measured starting point, not as an uncalibrated default for larger or hosted
rerankers.

A balanced 12-question LongMemEval-s smoke (two cases from each of six question
types, 573 session Memories across 12 isolated Workspaces) reached reranked
Recall@1 `0.6806`, Recall@10 `0.9792`, MRR `0.9444`, and nDCG@10 `0.9558`.
One deterministic second-hop feedback query raised Recall@10 to `1.00` and
nDCG@10 to `0.9661`, but increased average end-to-end latency from 1,534 ms to
2,187 ms. Keep feedback as an evaluated quality mode rather than enabling it
unconditionally.

The Conflict workload produced the opposite reranker result. Lore now audits the
exact answer fact inside returned evidence, not merely the containing Memory id.
With the experimental v3 structured list chunking, bounded whole-small-Memory evidence, threshold
`0.6`, one feedback query, recency weight `0.6`, five top chunks, and two adjacent
chunks, the two-source/200-question run reached evidence Recall@1 `0.285`,
Recall@10 `0.800`, and MRR `0.4370` at 178 ms average latency. Adding the same
Qwen3 0.6B reranker at 20 candidates with first-stage/reranker weight `0.75`
reduced those metrics to Recall@1 `0.250`, Recall@10 `0.755`, and MRR `0.3948`,
while average search latency rose to 1,529 ms. That first measurement sent the
expanded reader evidence to the cross-encoder. Lore now sends only the best
authorized chunk plus configured neighbors: reranker input fell from 2,507,822 to
747,160 characters and latency fell to 930 ms, but Conflict quality fell further
to Recall@1 `0.210`, Recall@10 `0.720`, and MRR `0.3686`. Compact scoring remains
the correct bounded production contract for cohesive Memories; this benchmark's
artificial 16-unrelated-fact batching is handled by wider reader evidence, not by
silently inflating every reranker request. Neither rerank mode is admitted for the
Conflict profile. The corpus needs distinct facts, graph-like hops, and temporal
ordering more than generic query/passage similarity, so reranking remains a
deployment-level, benchmark-calibrated stage rather than a universal quality
switch.

Without a model reranker, recency reciprocal-rank fusion at weight `0.6` raised
the same two-source Conflict run to Recall@10 `0.805` and MRR `0.4343`. On the
harder four-source/400-question slice it improved Recall@10 from `0.465` to `0.630`
and MRR from `0.2813` to `0.3215`, with zero RLS tripwire failures. These are
parent-Memory anchor diagnostics, not generated-answer scores, and they originally
overstated answerable evidence after structured chunking. The benchmark now reports
the exact answer fact's evidence rank separately. With threshold `0.6`, one feedback
query, recency weight `0.6`, five top chunks, and two adjacent chunks, the audited
two-source run reached parent-Memory Recall@10 `0.800` but exact answer-evidence
Recall@10 `0.635` and evidence MRR `0.3697` at 179 ms average latency. Lore now
returns a whole small Memory when the explicit evidence budget can cover every
chunk, closing that gap without crossing the Memory/RLS boundary: exact evidence
Recall@10 rose to `0.800` and MRR to `0.4370`, equal to the audited parent-Memory
metrics, with 178 ms average latency. The result rejects a single global rerank
recipe, but it is still a retrieval-only diagnostic and does not support an
end-answer SOTA claim.

An iterative second feedback hop increased exact evidence Recall@10 only to `0.640`
and multi-hop-source Recall@10 from `0.440` to `0.450`, while average latency rose to
269 ms and evidence MRR fell to `0.3618`. Lore supports the bounded chain, but depth
one is the measured local Pareto point for this configuration.

The server RSS after load was about 1,600,720 KiB with
`--parallel 1 --ctx-size 8192`. A controlled pre-v2 run repeated the same
requests with `--parallel 4`, keeping the total context budget constant at 2,048
tokens per slot. RSS rose only to about 1,665,952 KiB, but single-request
latency did not improve. The handler launched four initial document tasks, yet
this Metal run did not translate that scheduling into lower individual-query
latency. Keep one slot on a RAM-sensitive single-user deployment; measure four
slots only for concurrent-request throughput.

These are retrieval-only diagnostics, not the official generated-answer score.
The result JSON is gitignored under `evaluation/results/`.

## Benchmark admission checklist

1. Run a two-document smoke test with an obviously relevant and irrelevant
   passage; persist the model ID, revision/GGUF SHA, quantization, runtime
   version, `max_length`, and output shape.
2. Verify every score is finite in `[0,1]`, all input indexes are returned once,
   and a forced provider error falls back to Lore's deterministic first-stage
   ranking.
3. Run the synthetic retrieval suite and a full MemoryAgentBench retrieval-only
   run with the same candidate limit, measuring quality, p50/p95 latency,
   provider request/input sizes, and the RLS hard gate.
4. Compare Q8_0 vs Q4_0 only on the same corpus/configuration. Choose the
   Pareto point; do not choose a quantization based on model-file size alone.

## Primary sources

- [Qwen3-Reranker-0.6B model card and reference scoring code](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B)
- [IAAR MemReranker-4B model card](https://huggingface.co/IAAR-Shanghai/MemReranker-4B)
- [llama.cpp server reranking documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [llama.cpp Qwen conversion source](https://github.com/ggml-org/llama.cpp/blob/master/conversion/qwen.py)
- [llama.cpp rank-pooling source](https://github.com/ggml-org/llama.cpp/blob/master/src/llama-graph.cpp)
- [vLLM scoring and reranking documentation](https://docs.vllm.ai/en/latest/models/pooling_models/scoring/)
- [vLLM-Metal Qwen3 pooling documentation](https://github.com/vllm-project/vllm-metal/blob/main/docs/text_embedding_pooling.md)
- [vLLM-Metal supported-model matrix](https://github.com/vllm-project/vllm-metal/blob/main/docs/supported_models.md)
- [MLX-LM source and server contract](https://github.com/ml-explore/mlx-lm)
- [Ollama API reference source](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [PyTorch MPS backend documentation](https://pytorch.org/docs/stable/notes/mps.html)
