# D3 large force graph guidance

Question: what does D3 itself recommend for a force graph around 5,000 nodes and
20,000 links?

## Short answer

D3 does not prescribe a node-count threshold where SVG must become Canvas. It
provides both renderers and keeps layout independent from rendering. For Lore's
30,000 graph primitives, Canvas is therefore an engineering choice based on DOM
cost, not a rule attributed to D3.

The explicit D3 recommendation is narrower: compute **static layouts for large
graphs in a Web Worker** so the UI does not freeze. D3's official worker example
stops the simulation, advances it with manual ticks, reports progress, and sends
the final graph back for Canvas rendering. It does not stream every node position
on every animation frame. [Force simulation docs](https://d3js.org/d3-force/simulation#simulation_tick)
and [official worker example](https://observablehq.com/@d3/force-directed-web-worker)

For interaction on Canvas, use D3's own behaviors:

- `d3-zoom` on the Canvas element; apply its transform to the 2D context (translate
  before scale). D3 explicitly supports HTML, SVG, and Canvas and documents this
  transform sequence. [d3-zoom](https://d3js.org/d3-zoom)
- `d3-drag` on the Canvas element with a custom `subject` accessor. D3 explicitly
  supports Canvas and recommends closest-target lookup for a Canvas subject.
  [d3-drag](https://d3js.org/d3-drag#drag_subject)
- Follow the canonical force-drag lifecycle: on start set `alphaTarget(0.3)` and
  restart, fix `fx`/`fy`; update them during drag; then restore `alphaTarget(0)`
  and clear `fx`/`fy` on release. The current official Canvas example implements
  exactly that lifecycle. [Official Canvas force graph](https://observablehq.com/@d3/force-directed-graph-canvas/2)

## Picking and spatial indexes

The current official Canvas example performs closest-node picking only when a
drag begins, using `d3.least` with a 20 px radius. The drag docs say this lookup
can be accelerated with `quadtree.find`, `simulation.find`, or `delaunay.find`.
[Canvas example](https://observablehq.com/@d3/force-directed-graph-canvas/2) and
[drag subject guidance](https://d3js.org/d3-drag#drag_subject)

These options are not equivalent:

- `simulation.find` is convenient but the current d3-force source scans the whole
  node array; it is not backed by a quadtree.
  [d3-force `simulation.find` source](https://github.com/d3/d3-force/blob/main/src/simulation.js#L116-L132)
- `quadtree.find` is the explicit spatial-index lookup. It is a good option when
  profiling shows drag-start picking is expensive, but a moving layout requires
  keeping or rebuilding the index as coordinates change.
  [d3-quadtree](https://d3js.org/d3-quadtree#quadtree_find)

For 5,000 nodes, the first implementation can use one bounded linear lookup on
drag start, then move to `quadtree.find` only if measurement justifies the index
maintenance. This is a Lore engineering inference, not a D3 threshold.

## Force cost controls

`forceManyBody` already uses a quadtree and Barnes-Hut approximation, with
O(n log n) work per application. D3 exposes `theta` as the accuracy/performance
trade-off and says a finite `distanceMax` improves performance and makes the
layout more local. [Many-body force](https://d3js.org/d3-force/many-body)

`forceCollide` is the correct D3 mechanism for node volume. It treats nodes as
circles and resolves overlap through iterative relaxation. The default is one
iteration; increasing iterations makes collision more rigid but explicitly costs
more runtime. [Collide force](https://d3js.org/d3-force/collide)

## Recommended Lore architecture

This separates D3-backed facts above from our design choice:

1. Render links and nodes on Canvas; retain D3 as the layout and interaction
   toolkit.
2. Use `d3-zoom` and `d3-drag` on the main thread. The dragged node should follow
   the pointer immediately rather than wait for a Worker round trip.
3. Compute the initial settled layout in a Worker with `simulation.stop()` and
   manual `tick()` calls, matching D3's official large-static-graph guidance.
4. Use a bounded subject radius. Start with the official example's drag-start
   linear lookup; add a main-thread quadtree only if it is actually a bottleneck.
5. Keep `forceCollide`, start with one iteration, and tune the radius independently
   from the drawn radius if the desired graph should spread out.
6. Treat live full-graph collision while dragging as a separate product choice.
   D3 documents the canonical main-thread drag lifecycle and a static Worker
   layout, but does not prescribe a low-latency cross-Worker drag protocol. If Lore
   keeps simulation in a Worker during drag, it must own frame throttling,
   transferable coordinate buffers, and dragged-node coordinate authority; that
   protocol is ours, not “the D3-recommended approach.”

## Lore prototype measurements

Local development measurements on the 5,000-node / 20,000-link benchmark exposed
an important distinction between throughput and interaction latency:

- Running 60 full-graph force ticks in the Worker after release kept Canvas fast,
  but withheld collision feedback for about 1.06 seconds.
- Moving a full `forceCollide` tick onto every drag frame removed that wait, but the
  collision pass itself cost about 9.2ms and reduced a 120Hz interaction to roughly
  86 frames per second.
- Keeping the Worker static and using a D3 quadtree to resolve only collisions near
  the dragged node measured about 0.4ms for collision and removed the post-release
  wait (about 0.3ms observed by the drag harness).

These are hardware- and dataset-specific Lore measurements, not thresholds claimed
by D3. The local spatial query proved technically fast, but user testing rejected
it because it removed velocity, inertia, and multi-hop particle motion.

The accepted prototype direction is adaptive. The main thread has sole authority
over the actively dragged node and the initial complete D3 layout is frozen in a
Worker. At every graph size, interaction simulates at most 900 active nodes plus
at most 4,000 real, pinned boundary endpoints and every available incident link
between those nodes. This preserves local collision and link constraints without
paying the many-body cost for every distant particle; far-field charge is
intentionally approximated by omission, with a weak spring toward each particle's
settled coordinate supplying the missing low-frequency field. The common compact
profile uses degree-scaled 4–16px visible nodes, 17–29px collision bodies, link
distance 62 / strength 0.25, charge -100, symmetric radial attraction, velocity
decay 0.4, and drag alpha target 0.3. Worker frames carry the locked node id so
stale coordinates cannot pull the pointer-owned node backward.

The interaction path avoids full-dataset work between frames. A settled uniform
grid replaces an O(nodes) scan when the drag path activates nearby particles, an
incremental incident-link set replaces repeated O(links) influence counts, and
each frame transfers only active node indexes and coordinates. Canvas culls
offscreen geometry and deterministically caps rendered links at 40,000; the
physics graph and rendered graph are therefore deliberately separate budgets.

Cold layout no longer relies on D3's dense default seed followed by 120 fixed
ticks. Nodes start on a deterministic low-discrepancy disk spaced from the largest
collision body, then the complete graph runs at most 48 ticks with alpha decay
adjusted to reach the same terminal range in fewer iterations. The first rejected
warm-start used graph traversal over a Hilbert curve; it was fast but visibly
imprinted the synthetic graph's id adjacency as serpentine bands. The disk seed
preserves the compact field without exposing that ordering artifact. While the
Worker runs, the pre-layout coordinates stay hidden. A node is progressively
revealed only after remaining visually still across consecutive ticks, and a link
appears only when both endpoints are visible. The centered status card uses the real
revealed Memory count to drive its bar without displaying a numeric counter. Each
newly visible node grows from zero to its final radius over a short ease-out
transition, while reduced-motion actors get no growth animation. The final Worker
frame releases any remaining nodes and waits for that last transition before
enabling the settled graph. Once a meaningful first batch is visible, the camera
fits those real positions instead of the hidden fallback coordinates; completion
preserves the Canvas instance and eases that camera into the final fit. Reduced-motion
actors receive both the final radius and camera fit immediately. The loading overlay
blocks pointer input so drag messages cannot queue behind the synchronous cold layout.

This followed two rejected experiments: a direct quadtree displacement was fast
but had no inertia, while reheating all 5,000 nodes reproduced the desired particle
motion but made roughly 4,000 nodes visibly tremble. An early bounded induced
subgraph moved only about 60 nodes with weaker forces; after parameter parity it
still peeled away because 780 boundary-crossing links were absent from a measured
central field. Keeping the complete force graph while pinning distant nodes fixed
that structural mismatch: the same drag released about 477 of 5,000 nodes and
retained 2,302 influencing links, while Canvas drawing stayed around 1.0–1.1ms.
The active-node ceiling is 900. Full-force Worker throughput initially measured
about 23–25 ticks per second. A fixed one-hop boundary halo reached about 45 ticks
per second but was rejected because removing distant charge changed the settled
force balance. Keeping the complete graph, increasing the documented Barnes–Hut
`theta` approximation from 0.9 to 1.4, and driving manual `simulation.tick()` calls
on a fixed 16.7ms Worker interval preserved the shape while reaching 59fps during
drag and 61fps while settling. The same run drew Canvas in 1.0–1.2ms and reduced
the 120-tick initial layout from roughly 2.2s to 1.52s. These are development
machine measurements, not general D3 thresholds. Because the faster scheduler
also applied release forces more often per second, post-release alpha is capped at
0.12 while drag alpha remains 0.3. In a deterministic 180-unit drag, the selected
node moved about 67 units after release instead of roughly 155, while the Worker
held 61.7fps; collision response during the drag is unchanged.

The adaptive path was also measured against a disposable 20,000-node / 80,000-link
API payload. Keeping all 20,000 bodies in the interactive simulation reached only
about 14 physics frames per second. The bounded active field reached about 62fps
with 1,560 simulated nodes, 4,418 exact local links, and 900 coordinate deltas per
frame; Canvas drew the capped 40,000-link view in about 2.9ms. On the same class of
local development run, the final disk-seeded 48-tick cold layout took about 3.7
seconds versus roughly 8.0 seconds for the earlier 120-tick layout. These figures
are local development measurements, not product guarantees.

After unifying the compact layout and bounded interaction path across graph sizes,
a sampled 5,000-node drag simulated 542 nodes and 1,662 incident links at 62fps
with a 1.4ms Canvas draw. A sampled 20,000-node drag simulated 282 nodes and 842
links at 62fps with a 3.1ms draw. The selected field depends on where the drag
starts, so these counts are diagnostics rather than fixed budgets; only the 900
active-node and 4,000-boundary-node ceilings are invariants.
