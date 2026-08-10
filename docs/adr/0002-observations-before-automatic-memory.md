# Record Observations before proposing automatic Memory

Lore represents raw messages, tool results, document fragments, and events as
immutable Observations grouped into Episodes. An Agent is the Actor that records an
Observation, not its generic “Source,” and an Observation is evidence rather than
canonical Memory. Automatic memory systems may derive a human-reviewed Memory
Proposal from visible Observations, but they may not write or silently rewrite
canonical Memory. Observation content is durable by default and disappears only
through an explicit forget operation; any future automatic retention policy must be
an opt-in deployment decision. Temporal facts and supersession remain a separate
later model. A Proposal retains the content-free id of an explicitly forgotten
Observation, and Lore refuses acceptance when any cited raw evidence is unavailable;
forget never becomes silent evidence removal.
