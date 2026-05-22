# DHT Simulator — Claude Interaction Protocol

## App
- Running at **http://localhost:3000** (node server.js)
- Source in `src/`, entry point `index.html`

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

### Latest benchmark snapshot (25,000 nodes · May 21, 2026 · v0.93.0 / `@axona/protocol` v1.1.2)

Run via the loop above with
`protocols: ["kademlia", "geob", "ngdhtnx17", "ngdhtnh1", "axona"]` and
`tests: ["global", "r500", "r2000", "r5000", "churn"]`.
500 lookups per cell, geoBits = 8, 5 % churn rate, omniscient init.
δ median = 67.8 ms one-way; 3δ floor ≈ 204 ms.

| Protocol | global ms | r500 ms | r2000 ms | r5000 ms | 5% churn ms | success% |
|---|---|---|---|---|---|---|
| Kademlia | 841.7 | 842.7 | 843.5 | 812.7 | 762.4 | 100% |
| G-DHT    | 825.9 | 176.9 | 249.0 | 386.5 | 767.2 | 100% |
| NX-17    | 265.0 | 105.1 | 131.4 | 169.6 | 290.7 | 100% |
| NH-1     | 260.2 | 102.7 | 134.3 | 175.4 | 292.9 | 100% |
| **Axona**  | 271.6 | 107.2 | 134.3 | 176.4 | **239.0** | 100% |

Hop counts:

| Protocol | global | r500 | r2000 | r5000 | 5% churn |
|---|---|---|---|---|---|
| Kademlia | 4.46 | 4.49 | 4.54 | 4.43 | 4.12 |
| G-DHT    | 5.58 | 4.89 | 5.31 | 5.40 | 5.10 |
| NX-17    | 5.49 | 3.66 | 4.21 | 4.71 | 6.19 |
| NH-1     | 5.36 | 3.54 | 4.23 | 4.84 | 6.06 |
| Axona    | 5.49 | 3.68 | 4.27 | 4.91 | **4.38** |

100 % delivery success under all conditions including 5 % churn.
On non-churn cells Axona / NX-17 / NH-1 are statistically tied
(within ~3 % of each other — they share the same `AxonaPeer`
kernel, so identical synaptome state produces identical routing
decisions, as the architecture predicts).

**Axona's real dividend is the churn cell** — 4.38 average hops /
239 ms vs ~6.1 hops / ~292 ms for NX-17 and NH-1.  ~28 % latency
reduction and ~1.7 fewer hops per lookup under 5 % churn.  This
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
| Global             | 841.7 ms | 271.6 ms | **68%** |
| Regional 500 km    | 842.7 ms | 107.2 ms | **87%** |
| Regional 2000 km   | 843.5 ms | 134.3 ms | **84%** |
| Regional 5000 km   | 812.7 ms | 176.4 ms | **78%** |
| 5 % churn (global) | 762.4 ms | 239.0 ms | **69%** |

When updating these numbers in pitches, docs, or external materials,
**rerun the benchmark** rather than trusting stale percentages.
Hop counts and the resulting latency mix can shift across protocol
revisions even when the architecture is unchanged.

**v0.93.0 methodology correction.** The May 21 v0.91.0 numbers
that briefly suggested Axona led on every cell were inflated by a
missing `super.buildRoutingTables()` call in
`TransportAxonaEngine` — per-NeuronNode `maxConnections` was
never set, so the bilateral `tryConnect` cap gate became a no-op
during bootstrap and Axona admitted every offered candidate.
Resulting synaptome was ~50 % larger than NH-1's at the same
nominal `maxConnections=100`, with some popular nodes absorbing
~650 incoming synapses.  v0.93.0 calls super at the top, the cap
bites uniformly, the regional gap disappears, the churn-cell gap
remains.

Raw CSV: `axona-docs/programmer-guide/benchmarks-25k/2026-05-21_25k_5protocols_5tests_v0.93.0.csv`.

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
