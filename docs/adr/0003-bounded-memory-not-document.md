# Keep canonical Memory bounded and route documents to Observation evidence

Lore limits one canonical Memory to 32,000 Unicode characters and 64 derived
chunks, with 8,000 characters as the recommended target. These limits apply to
direct writes, Proposals, and imports. Larger raw documents belong in bounded
`document_fragment` Observations inside a document Episode and may be cited as
evidence for a human-reviewed Memory Proposal.

Lore does not automatically split a long document into multiple Memories because
doing so would invent canonical knowledge boundaries. This decision keeps Memory
writes and retrieval context bounded while preserving the distinction between
canonical knowledge and raw evidence.
