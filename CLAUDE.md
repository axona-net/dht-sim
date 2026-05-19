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
- **`axona` — v1.0 kernel-driven protocol (`@axona/protocol` v1.0.0-rc.0).** Same AxonaPeer + AxonManager as `ngdhtnh1` but imported from the kernel and constructible against `Transport.sim()` instead of the simulator's god's-eye node-map. The kernel's full pub/sub/pull/metrics/direct-messaging surface is verified by `test/smoke_kernel_integration.mjs` (18 assertions). Today's dispatch falls through to `AxonaEngine` for benchmark compatibility; the transport-based engine adapter is a follow-up.

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

### Transport-conformance status (v0.71.0)

All four protocols in the production-comparison set — **NH-1**, **NX-17**,
**K-DHT**, **G-DHT** — are now Transport-conforming. Each consumes only
the 12-method Transport contract and exposes the DHT contract upward
with identical signatures.

| Protocol | Transport-conforming? | Architecture |
|---|---|---|
| **NH-1**   | Yes  | Reference. 15-commit migration cleaned every per-hop routing primitive. |
| **NX-17**  | Yes  | Subclass of NH-1 (v0.71.0). Tuned for wider exploration: MAX_SYNAPTOME=60 vs 50, LOOKAHEAD_ALPHA=7 vs 5, slower ANNEAL_COOLING, larger ANNEAL_LOCAL_SAMPLE. Same API/Transport surface, different routing character. |
| **K-DHT**  | Yes  | Cleaned in v0.3.51 (descriptor FIND_NODE, `_deadPeers` Set, inline latency). Lookup only — no pub/sub. |
| **G-DHT**  | Yes  | Inherits K-DHT's lookup + transport handlers. Lookup only — no pub/sub. |

Earlier neuromorphic variants (NS-1…NS-6, NX-1…NX-15) remain on the legacy
god's-eye path and are kept for ablation / simulator-only study.

When re-running benchmarks after a refactor commit, **K-DHT and G-DHT ms
numbers will shift** from pre-refactor values (the new code uses
`transport.getLatency` per-round, not post-walk pairwise `roundTripLatency`).
Hop counts and success rates are stable across the change.

### Latest benchmark snapshot (25,000 nodes · May 15)

Run via the loop above with
`protocols: ["kademlia", "geob", "ngdhtnx17", "ngdhtnh1"]` and
`tests: ["global", "r500", "r2000", "r5000", "churn"]`.

| Protocol | global ms | r500 ms | r2000 ms | r5000 ms | 5% churn ms | success% |
|---|---|---|---|---|---|---|
| Kademlia | 508.5 | 512.6 | 498.0 | 505.6 | 465.6 | 100% |
| G-DHT    | 282.0 | 153.4 | 176.8 | 208.5 | 278.7 | 100% |
| **NX-17**  | **242.2** | **79.4**  | **106.7** | **145.4** | **234.5** | **100%** |
| NH-1     | 256.1 | 106.9 | 139.0 | 175.4 | 287.7 | 100% |

NX-17 vs Kademlia latency reduction:

| Test | Kademlia | NX-17 | Reduction |
|---|---|---|---|
| Global       | 508.5ms | 242.2ms | **52%** |
| Regional 500km   | 512.6ms |  79.4ms | **85%** |
| Regional 2000km  | 498.0ms | 106.7ms | **79%** |
| Regional 5000km  | 505.6ms | 145.4ms | **71%** |
| 5% churn (global)| 465.6ms | 234.5ms | **50%** |

100% delivery success under all conditions including 5% churn. The
85% latency reduction on local traffic is the standout — that's where
the learned routing locality compounds. Even on worst-case global
lookups, NX-17 is half of Kademlia's wall-clock latency.

When updating these numbers in pitches, docs, or external materials,
**rerun the benchmark** rather than trusting stale percentages.
Hop counts and the resulting latency mix can shift across protocol
revisions even when the architecture is unchanged.

## Files
- `results/benchmark_latest.csv` — latest benchmark result
- `results/benchmark_<ts>.csv` — timestamped archives
- `results/.ready` — JSON flag written on completion, deleted after reading
- `results/research.log` — append-only exploration log
- `src/main.js` — app entry, benchmark logic, sweep integration
- `src/ui/BenchmarkSweep.js` — sweep state machine
- `server.js` — Express server with all endpoints
