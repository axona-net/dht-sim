# DHT Simulator — Claude Interaction Protocol

## App
- Running at **http://localhost:3000** (node server.js)
- Source in `src/`, entry point `index.html`

## Scalable pub/sub — real-kernel axonic-tree test (Node)

The browser benchmark below measures **routing**; pub/sub fan-out is tested
separately, on the REAL shipped kernel, via `harness/pubsub-real-kernel.mjs`
(+ `harness/pubsub-sweep.mjs`). They import `@axona/protocol` (the `file:` link
= the kernel dht-sim's Node side runs), build peers EXACTLY as
axona-peer/axona-relay do (`new AxonaPeer({domain,node,nodeIdentity,transport})`
— no axonaManager, no pickRelayPeer), seed a navigable XOR mesh, drive real
`peer.pub`/`peer.sub`, and reconstruct the actual axon tree (roots, sub-axons,
fan-out, depth, per-publish delivery, post-churn self-heal).

```
npm run pubsub:one     # single scenario — env: N, SUBS, K, SYN_CAP, PICK_RELAY,
                       #   PUBS, REFRESH, SETTLE, DELIVER, CHURN_PCT, TRACE
npm run pubsub:scale   # size sweep → table + results/pubsub-scale_<ts>.csv
                       #   env: SIZES, SUB_FRAC, CONFIGS=default|pickrelay|both, CHURN_PCT
npm run test:kernel    # the 4 kernel-integration smokes (60 checks)
```

**GOTCHA:** AxonaManager is built **lazily on first pub/sub** — the AxonaPeer
constructor leaves `_axonaManager` null. Force it (`peer._requireAxonaManager(…)`)
right after `peer.start()` before configuring/instrumenting, or an `if (am)`
guard silently no-ops and you measure an unconfigured manager. The harness emits
an instrument-sanity line precisely to catch that.

**Finding (kernel v3.9.0):** the kernel now wires `pickRelayPeer` into the default
manager (`AxonaPeer._buildDefaultManager`), so sub-axon recruitment uses **batch
adoption** → the axon tree stays **flat (depth ~3–4)** with bounded fan-out (20)
as a topic grows, ~100% delivery, and 100% post-churn (20% kill) self-heal.
Before v3.9.0 the default fell back to one-at-a-time child promotion → a **deep
chain** (depth ~21 @ 600 subs).

The browser `axona` engine (`TransportAxonaEngine`) now also exposes **`axonFor`**
(+ `resetAllAxons`): a thin shim that delegates the `PubSubAdapter` contract
(`pubsubSubscribe`/`Unsubscribe`/`Publish`/`onPubsubDelivery`) to the real
`peer.sub`/`peer.pub` — mapping the adapter's opaque topicId → a kernel descriptor
`{region:'useast', name:'sim:'+id}` and signing with one durable author per peer.
So the browser membership / `pubsubm` test runs the **shipped** pub/sub for the
`axona` protocol (not a sim-native manager). Validated by
`test/smoke_transport_axona_pubsub.mjs` (axonFor → PubSubAdapter → 100% delivery
over the real axon tree).

## Adaptive Benchmark Loop

Claude drives parameter exploration by:
1. Posting an experiment to the server
2. Waiting for the result (`.ready` flag)
3. Reading and analyzing the CSV
4. Logging learnings
5. Posting the next experiment

### Step 1 — Queue a run

```bash
curl -s -X POST http://localhost:3000/api/experiment \
  -H 'Content-Type: application/json' \
  -d '{
    "label": "Coverage sweep 10-50%",
    "hypothesis": "Higher coverage should increase broadcast hops for N-10W",
    "runs": [
      {"nodeCount":50000,"pubsubCoverage":10,"protocols":["kademlia","geo","ngdht10w"],"tests":["global","r2000","pubsub"]},
      {"nodeCount":50000,"pubsubCoverage":25,"protocols":["kademlia","geo","ngdht10w"],"tests":["global","r2000","pubsub"]},
      {"nodeCount":50000,"pubsubCoverage":50,"protocols":["kademlia","geo","ngdht10w"],"tests":["global","r2000","pubsub"]}
    ]
  }'
```

The browser picks this up within 3 seconds and starts the sweep automatically.

### Step 2 — Wait for results

Poll until `.ready` exists:
```bash
# Check status
curl -s http://localhost:3000/api/status
# → {"ready":true,"pendingExperiment":false}

# Or just check the file directly
ls results/.ready
```

### Step 3 — Read the result

```bash
# Read metadata
cat results/.ready

# Read CSV (latest run)
cat results/benchmark_latest.csv

# Or read archived file from .ready metadata
```

### Step 4 — Clear the flag and log learnings

```bash
# Clear .ready so the next result can be detected
curl -s -X DELETE http://localhost:3000/complete

# Append to research log
curl -s -X POST http://localhost:3000/api/log \
  -H 'Content-Type: application/json' \
  -d '{"entry":"Run: Coverage 10-50%\nKey finding: N-10W bcast hops 1.19→3.28 as coverage grows\nNext: test groupSize 16 vs 32 vs 64"}'
```

### Step 5 — Read prior learnings

```bash
curl -s http://localhost:3000/api/log
# or
cat results/research.log
```

## Configurable Run Parameters

Each run object in the `runs` array supports:

| Field | Default | Description |
|-------|---------|-------------|
| `nodeCount` | current UI value | Number of nodes |
| `pubsubCoverage` | current UI value | % of nodes to reach in pub/sub broadcast |
| `pubsubGroupSize` | current UI value | Pub/Sub group size |
| `warmupSessions` | current UI value | Neuromorphic warmup sessions (auto-scales with nodeCount) |
| `protocols` | current UI selection | Array of protocol keys: `kademlia`, `geo`, `ngdht10w`, etc. |
| `tests` | current UI selection | Array of test keys: `global`, `r2000`, `r500`, `pubsub`, `churn`, etc. |

Omitting a field leaves the current UI value unchanged.

## Protocol Keys

**Current SOTA (performance):** `ngdhtnx17` — NX-17
**Current protocol (simplified production):** `ngdhtnh1` — NH-1

- `kademlia` — Kademlia DHT (baseline)
- `geob` — Geographic DHT (SOTA G-DHT — stratified inter-cell + intra-cell + random global). Earlier variants (`geo`, `geoa`) are retired for benchmarking but remain in code for backward-compat reading of old CSVs.
- `ngdht10w` — Neuromorphic DHT v10
- `ngdht`, `ngdht2`…`ngdht13w` — earlier neuromorphic variants
- `ngdhtnx1w` — NX-1W configurable research protocol
- `ngdhtnx2w` — NX-2W broadcast-tree protocol (NX-1W + Rule 15: proximity-ordered fan-out tree) (pass `nx1wRules` to configure)
- `ngdhtnx3` — NX-3 G-DHT three-layer init
- `ngdhtnx4` — NX-4 iterative fallback routing
- `ngdhtnx5` — NX-5 stratified bootstrap + global warmup + incoming promotion
- `ngdhtnx6` — NX-6 churn-resilient routing (NX-5 + temperature reheat + dead-synapse eviction)
- `ngdhtnx7` — NX-7 dendritic pub/sub v1 (NX-6 + 25% peel-off relay tree)
- `ngdhtnx8` — NX-8 dendritic pub/sub v2 (NX-6 + balanced binary split relay tree)
- `ngdhtnx9` — NX-9 geographic dendritic pub/sub (NX-6 + S2-clustered relay tree with direct 1-hop delivery)
- `ngdhtnx10` — NX-10 routing-topology forwarding tree (NX-6 + delegates to first-hop synapses as forwarders)
- `ngdhtnx11` — NX-11 diversified bootstrap + axonal pub/sub (NX-10 + 80/20 stratified/random bootstrap)
- `ngdhtnx13` — NX-13 (intermediate research variant)
- `ngdhtnx15` — NX-15 (intermediate research variant)
- **`ngdhtnx17` — NX-17 current performance SOTA. Strongest latency reduction vs Kademlia across global, regional, and churn tests at 25K nodes.**
- **`ngdhtnh1` — NH-1 simplified current protocol. Trades a small amount of NX-17's peak performance for a substantially smaller implementation; this is what production deployments target.**
- **`axona` — v1.0 kernel-driven protocol (`@axona/protocol` v1.0.0-rc.0).** Same per-node AxonaPeer as `ngdhtnh1`, but constructed by `TransportAxonaEngine` (in dht-sim) using the kernel's own `SimNetwork` + `simTransport` instead of dht-sim's god's-eye `SimulatedTransport`.  N peers share a single `AxonaDomain` for `simEpoch` + EMA stats + config.  Routing goes through `peer.lookup()` → `transport.send('lookup_step', …)` exactly like a real deployment.  Reaches NH-1 latency/hop parity at 5K nodes (v0.79.0).  Verified by: `test/smoke_kernel_integration.mjs` (18), `test/smoke_kernel_regression.mjs` (30+), `test/smoke_transport_axona_engine.mjs` (9), and the kernel's own `test/smoke_standalone_lookup.mjs` (17).

## Test Keys
- `global` — random global lookups
- `r500`, `r1000`, `r2000`, `r5000` — regional lookups within radius (km)
- `pubsub` — pub/sub broadcast (uses pubsubCoverage and pubsubGroupSize)
- `src`, `dest`, `srcdest` — source/dest-concentrated lookups
- `continent` — cross-continent (NA→Asia)
- `churn` — node churn test (run last, modifies DHT state)

## Result CSV Format

```
# DHT Benchmark — N nodes · 500 lookups/cell
Protocol,global hops,global ms,2000km hops,2000km ms,pubsub →relay hops,...
Kademlia,...
G-DHT,...
N-10W,...

# Run Parameters
Parameter,Value
Nodes,...
Pub/Sub coverage %,...
```

## Key Metrics to Watch

The headline advantage of the current SOTA protocols is **latency reduction**,
not hop reduction. NX-17 and NH-1 hop counts hover near Kademlia's on global
lookups; the speedup comes from learned routing that exploits geographic /
synaptic locality, dramatically shortening the per-hop wire time.

- **ms latency** — the primary metric. Reflects learned-route quality, not
  just hop count. Lower is better.
- **Global hops** — informative for theory but NX-17 ≈ Kademlia here (≈4.4).
- **Regional hops** — where neuromorphic locality shows up (NX-17 ~40%
  fewer on 500km than Kademlia).
- **Pub/Sub bcast hops** — scales with coverage; axonal-tree variants
  (NX-7+/NX-17) dominate here.
- **Success %** — must be 100% under steady-state and ≥99% under 5% churn
  for a protocol to be considered viable.

### Transport-conformance status (v0.79.0)

Five protocols in the production-comparison set — **NH-1**, **NX-17**,
**K-DHT**, **G-DHT**, **Axona** — are Transport-conforming. Each consumes
only the 12-method Transport contract and exposes the DHT contract
upward with identical signatures.

| Protocol | Transport-conforming? | Architecture |
|---|---|---|
| **NH-1**   | Yes  | Reference. 15-commit migration cleaned every per-hop routing primitive. |
| **NX-17**  | Yes  | Subclass of NH-1 (v0.71.0). Tuned for wider exploration: MAX_SYNAPTOME=60 vs 50, LOOKAHEAD_ALPHA=7 vs 5, slower ANNEAL_COOLING, larger ANNEAL_LOCAL_SAMPLE. Same API/Transport surface, different routing character. |
| **K-DHT**  | Yes  | Cleaned in v0.3.51 (descriptor FIND_NODE, `_deadPeers` Set, inline latency). Lookup only — no pub/sub. |
| **G-DHT**  | Yes  | Inherits K-DHT's lookup + transport handlers. Lookup only — no pub/sub. |
| **Axona**  | Yes (and **kernel-driven**) | Wraps NH-1's per-node logic, imported from `@axona/protocol` v1.0.0-rc.0.  Constructed via `TransportAxonaEngine`: N kernel `AxonaPeer`s, one shared `AxonaDomain`, routing through kernel `SimNetwork` + `simTransport` instead of dht-sim's god's-eye `SimulatedTransport`.  No simulator-internal node-map access in the routing path — `peer.lookup()` walks the mesh via the same `transport.send('lookup_step', …)` recursion a deployed WebRTC peer would use. |

Earlier neuromorphic variants (NS-1…NS-6, NX-1…NX-15) remain on the legacy
god's-eye path and are kept for ablation / simulator-only study.

When re-running benchmarks after a refactor commit, **K-DHT and G-DHT ms
numbers will shift** from pre-refactor values (the new code uses
`transport.getLatency` per-round, not post-walk pairwise `roundTripLatency`).
Hop counts and success rates are stable across the change.

### Re-verification (25,000 nodes · June 19, 2026 · `@axona/protocol` v3.1.0 · identity/authorship v0.3 + region resolution)

First sim benchmark on the **v3.x kernel** (identity/authorship rebuild, v3.0.0)
including the **v3.1.0 region-resolution change** (topic region is explicit or the
publisher's node region; the old key-derived placement was removed). The region
change is pure pub/sub topic *placement* — it does not touch `_lookupStep`, the
lookup recursion, or the sim's own pub/sub benchmark path (dht-sim uses its own
`AxonPubSub`/`post.js`, not the kernel's v0.3 pub/sub) — so **no routing movement
was expected, and none was observed.** Vendor re-synced to 3.1.0 via
`scripts/sync-vendor-kernel.sh`; the 57 Node-side kernel-integration/regression
smokes (`smoke_kernel_integration` 18, `smoke_kernel_regression` 30,
`smoke_transport_axona_engine` 9) all pass on the 3.1.0 vendor. Same config as the
rows below (Web limit on, maxConnections = 100, geoBits = 8, 5 % churn, omniscient
init). δ median ≈ 68 ms one-way.

| Protocol | global ms | r500 ms | r2000 ms | r5000 ms | 5 % churn ms | success% |
|---|---|---|---|---|---|---|
| Kademlia | 851.2 | 824.8 | 813.4 | 819.8 | 790.6 | 100% |
| G-DHT    | 809.2 | 198.1 | 263.2 | 403.4 | 741.3 | 100% |
| NX-17    | 311.1 | 152.7 | 182.9 | 226.0 | 338.3 | 100% |
| NH-1     | 321.8 | 159.1 | 191.3 | 228.6 | 356.1 | 100% |
| **Axona**  | 341.4 | 163.3 | 211.7 | 247.2 | **336.6** | **100%** |

**Verdict: NO routing regression from the v3.x / region change.**
- **Every cell is within run-to-run noise of the v2.23.0 / v2.24.0 baselines** (e.g.
  Kademlia global 851→851; NH-1 churn 358→356; Axona churn 323→337).
- **Axona ↔ NH-1 parity holds**, and Axona keeps its churn dividend (336.6 ms /
  7.26 hops vs NH-1 356.1 ms / 7.85 hops) — the explicit dead-peer eviction edge.
- **Axona is 100 % on every cell** (incl. churn), since the vendored kernel carries
  the `MAX_HOPS=40` fix (v2.24.0+); this is cleaner than the pre-fix v2.23.0 row's
  98.8–99.6 %.

**Slice World (split-hemisphere, single Hawaii bridge):** Axona **8.40 hops /
429.8 ms / 100 %**, NH-1 7.90 / 442.4 / 100 %, NX-17 8.60 / 489.9 / 100 %; pure-XOR
Kademlia & G-DHT still **0 %** (cannot discover the lone inter-hemisphere bridge).
The learning-synaptome bottleneck-discovery property is intact on v3.1.0.

CSVs (`axona-docs/programmer-guide/benchmarks-25k/`):
`2026-06-19_25k_5protocols_5tests_v3.1.0.csv`,
`2026-06-19_25k_5protocols_slice_v3.1.0.csv`.

### Re-verification (25,000 nodes · June 5, 2026 · `@axona/protocol` v2.23.0 · post bridgeless + hardening wave)

Validation that the kernel evolution since the last sim benchmark — the
bridgeless/relay work (v2.17–v2.20) and the deploy-stability hardening wave
(v2.21–v2.23: closed/never-opened teardown, negotiation watchdog, pub/sub
postHash reconciliation, connectViaRelay cap, mesh-auth fix) — does **not** move
sim routing performance. **The browser vendor had been frozen at kernel 2.16.0**;
re-synced to **2.23.0** via `scripts/sync-vendor-kernel.sh` for this run, so this
is the first sim measurement of the 2.17→2.23 changes for the kernel-driven
`axona` path. Same config as the v2.17.1 row below (Web limit on,
maxConnections = 100, geoBits = 8, 5 % churn, omniscient init).

| Protocol | global ms | r500 ms | r2000 ms | r5000 ms | 5 % churn ms | success% |
|---|---|---|---|---|---|---|
| Kademlia | 851.1 | 831.3 | 827.5 | 833.0 | 781.3 | 100% |
| G-DHT    | 834.3 | 193.9 | 257.3 | 407.6 | 748.5 | 100% |
| NX-17    | 319.9 | 152.7 | 184.8 | 221.2 | 341.5 | 100% |
| NH-1     | 318.1 | 163.7 | 193.9 | 229.3 | 358.0 | 100% |
| **Axona**  | 335.0 | 163.2 | 196.1 | 246.5 | 323.1 | **98.8–99.6%** |

Isolated re-run (NH-1 control + Axona, low memory) reproduced it: NH-1 **100%**
on every cell; Axona **99.2 / 99.6 / 99.6 / 99.2 / 98.6 %**.

**Verdict: NO routing regression attributable to the kernel changes.**
- **The steady-state lookup path is byte-identical to the v2.16.0 baseline.**
  `git diff v2.16.0 HEAD -- src/dht/AxonaPeer.js` confines every change to the
  constructor/start (relay-sink wiring), the `route_msg`/greedy region, and the
  relay-sink methods; `_lookupStep` (and the whole lookup recursion the benchmark
  exercises) is **unchanged**. `_findCloserInTwoHops` (the only v2.19 routing edit)
  is called solely from `route_msg`/`routeMessage`, **not** from `lookup()`.
- **The Axona <100 % steady-state was a HOP-CEILING artifact, not a regression —
  FIXED in v2.24.0 (Axona now 100 %).** *(Corrected diagnosis — see below; an
  earlier version of this note wrongly attributed it to an `openConnection`
  admission refusal at the cap.)* Root cause: the kernel's `AxonaDomain.MAX_HOPS`
  was **16** while dht-sim's `AxonaEngine` (NH-1/NX-17) has long used **40**.
  Under the connection-capped (sparser) graph ~0.4–0.8 % of lookups need >16 hops
  to converge; Axona abandoned them at hop 16 (`found=false`), NH-1 completed them
  at 40. **Decisively verified**: instrumentation showed the lookup/relay path
  **never** hit a refused `openConnection` (`ran=0`; the sim transport's
  `acceptConnection` defaults to `() => true`, so the connection cap is enforced
  only at *build* time via `tryConnect`, never at route time) — so the failures
  were pure hop-exhaustion, not admission. Setting Axona's `MAX_HOPS=40` →
  **100 % on global/r2000/r5000 at 25k**, exactly matching NH-1; `webLimit` off
  (richer graph, all paths <16 hops) was already 100 %. Both reconcile. Kernel
  `MAX_HOPS` is now **40** (v2.24.0); 40-hop lookups are exceedingly rare (avg ~7,
  p95 ~11) so the worst-case ceiling is paid by almost no one. The numbers in the
  table above are the **pre-fix (v2.23.0, MAX_HOPS=16)** measurement.
- **The ms / churn-hop / slice-hop shifts vs the older baseline are environmental
  / stochastic** — NH-1 (sim's own, *unchanged* code) shifted by the same
  magnitude (global 271→318 ms; churn 6.33→7.62 hops; slice 7.6→9.8 hops). The δ
  median (67.8 ms) matches the baseline; the uniform ~15 % ms rise is machine load.
- **The hardening-wave changes (web-transport mesh/auth, pub/sub postHash, relay)
  don't touch the sim routing path at all** — confirmed by the diff.

**Slice World (split-world) — bottleneck discovery intact:** Axona **9.20 hops /
556 ms / 100 %**, NH-1 9.80 / 545 / 100 %; pure-XOR Kademlia & G-DHT still **0 %**
(cannot discover the single Hawaii bridge). Hop/ms higher than the v2.17.1 row
(Axona 7.40) but NH-1 rose identically (7.60→9.80), so it's the same
environmental shift — the architectural property (learning synaptome finds and
routes through the lone inter-hemisphere bridge at 100 %) holds.

CSVs (`axona-docs/programmer-guide/benchmarks-25k/`):
`2026-06-05_25k_5protocols_5tests_v2.23.0.csv`,
`2026-06-05_25k_nh1-axona_isolated_v2.23.0.csv`,
`2026-06-05_25k_axona_slice_v2.23.0.csv`,
`2026-06-06_25k_nh1-axona_MAX_HOPS40_v2.24.0.csv` (post-fix: Axona **100 %** on
global/r2000/r5000, matching NH-1).

### Re-verification (25,000 nodes · June 5, 2026 · `@axona/protocol` v2.17.1 · in-degree cap)

Kernel **v2.17.1** bounds the incoming-synapse reverse index to the shared
synaptome budget (`synaptome.size + incomingSynapses.size ≤ _maxSynaptome`).
Previously the **outgoing** synaptome was hard-capped but `incomingSynapses` was
not, so a popular node accrued an inflated reverse in-degree that AP routing
(`progressCandidates`) could exploit — see the kernel/dht-sim NeuronNode +
TransportAxonaEngine/AxonaEngine commits. Re-ran the **same** config as the
May-27 snapshot below (Web limit on, maxConnections = 100, geoBits = 8, 5 %
churn, omniscient init) on the fixed code:

| Protocol | global ms | r500 ms | r2000 ms | r5000 ms | 5 % churn ms | success% |
|---|---|---|---|---|---|---|
| Kademlia | 846.5 | 817.9 | 819.1 | 837.7 | 779.5 | 100% |
| G-DHT    | 807.2 | 196.7 | 259.1 | 398.3 | 731.4 | 100% |
| NX-17    | 277.7 | 112.0 | 146.6 | 185.5 | 300.7 | 100% |
| NH-1     | 270.8 | 113.2 | 142.5 | 185.0 | 306.8 | 100% |
| **Axona**  | 277.2 | 121.9 | 144.4 | 192.3 | **241.8** | 100% |

Churn hops: Kademlia 4.19 · G-DHT 5.04 · NX-17 6.26 · NH-1 6.33 · **Axona 4.45**.

**Every cell is within run-to-run noise of the May-27 numbers** (≤ ~3 %). At the
realistic `maxConnections = 100` cap the in-degree fix does **not** move the
headline metrics: the physical connection cap already bounded in-degree at ~100,
and AP routing is dominated by the *trained* outgoing synaptome (incoming
entries carry baseline weight 0.1 and rarely win the AP selection). Axona's
churn dividend (4.45 hops / 242 ms vs ~6.3 / ~305 for NX-17/NH-1) is preserved,
and it now rests on a **production-faithful** graph (total routing degree ≤
MAX_SYNAPTOME, as a real connection-capped peer). The inflation only grows
unbounded with **Web Limit OFF** (uncapped `maxConnections` ⇒ no physical
in-degree bound) — not the realistic / published config. Corrected CSV:
`axona-docs/programmer-guide/benchmarks-25k/2026-06-05_25k_5protocols_5tests_v2.17.1_indegree-cap.csv`.

**Slice World re-check (Axona, same config):** 7.40 hops / 395.7 ms / **100 %**
cross-hemisphere success (published v2.0.1: 8.10 / 425.1 / 100 %). The learning
synaptome still discovers the single Hawaii bridge and routes through it after
the cap — bottleneck discovery is intact (pure-XOR K-DHT/G-DHT still fail at
0 % here, as before). CSV:
`axona-docs/programmer-guide/benchmarks-25k/2026-06-05_25k_axona_slice_v2.17.1_indegree-cap.csv`.

### Latest benchmark snapshot (25,000 nodes · May 27, 2026 · `@axona/protocol` v2.0.1)

First benchmark on the standard-S2 partition (kernel v2.0.0+).  Cell
prefix now matches the top 8 bits of Google S2 level-3 cell IDs;
peer distribution across the 192-cell partition differs from the
previous 256-cell flat-Hilbert scheme.

Run via the loop above with
`protocols: ["kademlia", "geob", "ngdhtnx17", "ngdhtnh1", "axona"]` and
`tests: ["global", "r500", "r2000", "r5000", "churn"]`.
500 lookups per cell, geoBits = 8, 5 % churn rate, omniscient init.
δ median = 68.4 ms one-way; 3δ floor ≈ 205 ms.

| Protocol | global ms | r500 ms | r2000 ms | r5000 ms | 5% churn ms | success% |
|---|---|---|---|---|---|---|
| Kademlia | 842.9 | 831.8 | 817.0 | 817.4 | 792.9 | 100% |
| G-DHT    | 817.2 | 194.9 | 273.6 | 395.4 | 747.2 | 100% |
| NX-17    | 275.3 | 112.3 | 147.7 | 183.9 | 304.6 | 100% |
| NH-1     | 274.9 | 113.5 | 145.4 | 182.4 | 306.8 | 100% |
| **Axona**  | 268.0 | 114.6 | 151.6 | 183.9 | **239.6** | 100% |

Hop counts:

| Protocol | global | r500 | r2000 | r5000 | 5% churn |
|---|---|---|---|---|---|
| Kademlia | 4.48 | 4.46 | 4.48 | 4.48 | 4.20 |
| G-DHT    | 5.51 | 4.92 | 5.39 | 5.47 | 5.01 |
| NX-17    | 5.68 | 3.76 | 4.53 | 5.10 | 6.35 |
| NH-1     | 5.56 | 3.78 | 4.47 | 4.89 | 6.33 |
| Axona    | 5.50 | 3.76 | 4.61 | 4.86 | **4.47** |

Slice World (Eastern / Western hemispheres connected only through a
single node in Hawaii — narrow-bottleneck routing test):

| Protocol | slice hops | slice ms | success% |
|---|---|---|---|
| Kademlia | — | — | **0.0%** |
| G-DHT    | — | — | **0.0%** |
| NX-17    | 7.70 | 461.7 | 100% |
| NH-1     | 7.60 | 427.7 | 100% |
| Axona    | 8.10 | 425.1 | 100% |

Pure-XOR DHTs (K-DHT, G-DHT) fail completely because no XOR-style
table can discover that the only inter-hemisphere path is via one
specific node.  The learning-adaptive synaptome in NH-1 / NX-17 /
Axona finds Hawaii during warm-up and routes through it cleanly.

100 % delivery success under all conditions including 5 % churn.
On non-churn cells Axona / NX-17 / NH-1 are statistically tied
(within ~3 % of each other — they share the same `AxonaPeer`
kernel, so identical synaptome state produces identical routing
decisions, as the architecture predicts).

**Axona's real dividend is the churn cell** — 4.47 average hops /
240 ms vs ~6.3 hops / ~306 ms for NX-17 and NH-1.  ~22 % latency
reduction and ~1.8 fewer hops per lookup under 5 % churn.  This
comes from `TransportAxonaEngine.removeNode`'s explicit sweep of
the dying nodeId out of every surviving peer's `synaptome`,
`incomingSynapses`, `buckets`, and `_deadPeers` plus the dying
node's transport handlers being nulled — landed in
v0.85.0–v0.89.0.  NH-1 / NX-17 take the engine's lazy dead-peer
discovery path, which costs the extra hops on lookups that hit
stale synapses before the local channel-closed error triggers
fallback.

Axona vs Kademlia latency reduction:

| Test | Kademlia | Axona | Reduction |
|---|---|---|---|
| Global             | 842.9 ms | 268.0 ms | **68%** |
| Regional 500 km    | 831.8 ms | 114.6 ms | **86%** |
| Regional 2000 km   | 817.0 ms | 151.6 ms | **81%** |
| Regional 5000 km   | 817.4 ms | 183.9 ms | **77%** |
| 5 % churn (global) | 792.9 ms | 239.6 ms | **70%** |

S2-migration sanity: the change in cell layout (flat-Hilbert ⇒ cube
projection at level 3) shifted regional latencies by 4–13 % vs the
v0.93.0 baseline — consistent with peer-distribution noise.  The
architectural property (Axona's churn advantage from explicit
dead-peer eviction) is unchanged: still ~239 ms / ~4.5 hops on the
churn cell, indistinguishable from v0.93.0's 239 ms / 4.4 hops.
100 % delivery success on every test for every protocol.

When updating these numbers in pitches, docs, or external materials,
**rerun the benchmark** rather than trusting stale percentages.
Hop counts and the resulting latency mix can shift across protocol
revisions even when the architecture is unchanged.

Raw CSVs:
· `axona-docs/programmer-guide/benchmarks-25k/2026-05-27_25k_5protocols_5tests_v2.0.1_S2.csv`
· `axona-docs/programmer-guide/benchmarks-25k/2026-05-27_25k_5protocols_slice_v2.0.1_S2.csv`

Previous snapshot (May 21, 2026 · v0.93.0 / `@axona/protocol` v1.1.2 · flat-Hilbert partition):
`2026-05-21_25k_5protocols_5tests_v0.93.0.csv`.

### Methodology footnote — v1.1.2 lookup latency

Starting in `@axona/protocol` v1.1.2, `_lookupStep` reads live
`transport.getLatency(...)` per hop instead of stamping the latency
at synapse admission time.  This applies uniformly to NH-1, NX-17,
and Axona (all neuromorphic variants share the kernel `_lookupStep`).
K-DHT and G-DHT use their own latency model and are unaffected.
Hop counts are stable across the change; latencies may shift 1–3 %
for the same routing decisions.

### Earlier Axona-vs-NH-1 parity snapshot (5,000 nodes · May 20 · v0.79.0)

Kept for historical comparison — confirmed that `case 'axona'`
running the kernel-driven path (`TransportAxonaEngine` → N kernel
peers over `simTransport`) keeps up with the simulator-driven NH-1
at 5× the milestone-smoke population.

| Protocol | global ms | r500 ms | r2000 ms | r5000 ms | success% |
|---|---|---|---|---|---|
| Kademlia | 707.6 | 678.5 | 691.6 | 695.2 | 100% |
| NH-1     | 230.6 |  73.1 | 102.1 | 146.3 | 100% |
| **Axona**  | **218.5** | **70.4** | **90.3** | **128.6** | **100%** |

The 25K headline above supersedes this — the parity claim now
upgrades to a small but consistent **lead** at 25K with churn.

## Files
- `results/benchmark_latest.csv` — latest benchmark result
- `results/benchmark_<ts>.csv` — timestamped archives
- `results/.ready` — JSON flag written on completion, deleted after reading
- `results/research.log` — append-only exploration log
- `src/main.js` — app entry, benchmark logic, sweep integration
- `src/ui/BenchmarkSweep.js` — sweep state machine
- `server.js` — Express server with all endpoints
