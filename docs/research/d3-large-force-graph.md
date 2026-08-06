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

The accepted prototype direction gives the main thread sole authority over the
actively dragged node and runs a moving D3 particle field in the Worker. The full
force set lays out the graph once; interaction then builds a bounded simulation
from real nodes around the drag path with `forceCollide`, velocity, weak anchor
springs, and `forceLink` for graph edges whose two endpoints are both in the active
field. Worker frames carry the locked node id so stale coordinates cannot pull the
pointer-owned node backward. Limiting link attraction to this induced subgraph
preserves connected-node pull without reheating distant nodes.

This followed two rejected experiments: a direct quadtree displacement was fast
but had no inertia, while reheating all 5,000 nodes reproduced the desired particle
motion but made roughly 4,000 nodes visibly tremble. The bounded particle field
kept the same velocity and cooling behavior while a measured drag activated about
524 of 5,000 nodes, produced 55 physics frames, and kept Canvas drawing around
1.6–2.2ms.
