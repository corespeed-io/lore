# Use reconstructable, versioned Memory chunks

Lore derives non-overlapping Memory chunks of at most 1,200 Unicode code points.
The chunker preserves every canonical character, prefers paragraph, Markdown,
sentence, line, and whitespace boundaries in that order, and uses a code-point-safe
hard split only as the fallback. Ordered chunks must reconstruct the Memory exactly;
retrieval may explicitly request adjacent chunks instead of storing overlap.

Every derived row records `lore-memory-chunking-v2`. Benchmark reuse validates that
revision as well as exact chunk content. The current pre-launch baseline adopts v2
as a greenfield contract. After launch, a chunking change requires a new revision,
a forward re-chunk/re-embedding migration, and versioned retrieval evaluation; it
must not silently mix derivation behavior under the same revision.
