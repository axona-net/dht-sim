# Protocol-Layer God's-Eye Audit

*v0.3.51 · 2026-05-16 · diagnostic report — no fixes yet*

## Why this audit happened

The integration plan (`documents/implementation/Axona-Integration-Plan-v0.3.51.md`) assumed `NeuromorphicDHTNH1` could be extracted cleanly into `@axona/protocol`. A dependency walk found 24+ `this.nodeMap` sites in NH-1 alone, plus more in the other protocols. The user flagged a sharper question:

> Any action taken on behalf of the middle layer of the protocol must be restricted to what is possible in the real world. Accessing a global `nodeMap` is impossible within the protocol state, though the external simulations must utilize these tools and resources.

So the audit's job is:
1. Classify every `nodeMap`-touching site in the routing/learning/pub-sub code as either **legitimate simulator orchestration** (allowed) or **god's-eye protocol violation** (forbidden).
2. Decide whether historical benchmark numbers are trustworthy.
3. Decide whether the Axona integration plan still stands.

This document answers (1) and (2) honestly. It does not propose fixes — that's the next decision.

---

## 1. The rule the user named

The contract surface is `src/contracts/Transport.js`. The legitimate cross-peer operations are: `send`, `notify`, `getLatency`, `isConnected`, `onPeerDied`. Anything else is god's-eye.

**Allowed for protocol code:**
- Reading the local node's own state (its own synaptome, its own incoming-synapse map, its own `_deadPeers`).
- Calling the four legitimate Transport operations.
- Receiving messages via the `onRequest` / `onNotification` handlers.

**Forbidden for protocol code:**
- `nodeMap.get(otherPeerId).synaptome.values()` — reading another peer's routing table without a wire request.
- `nodeMap.get(otherPeerId).alive` — reading another peer's liveness without going through the heartbeat / `onPeerDied`.
- `nodeMap.get(otherPeerId).highway.values()` — reading another peer's highway tier directly.
- Any synchronous read of another peer's fields by `nodeMap` lookup.

**Always allowed (simulator orchestration):**
- The Engine creating / destroying nodes (`addNode`, `removeNode`).
- The benchmark harness iterating `nodeMap.values()` to inject churn, gather stats, render the globe, draw dashboards.
- A protocol method *exposed to the simulator* that touches `nodeMap` only when the simulator orchestrates it (e.g., `_tickDecay` called from the Engine's main loop, `postChurnHeal` called once per churn round).
- Self-resolution: `this.nodeMap.get(myOwnId)` to obtain a reference to the local NeuronNode. Production replaces this with the DHT instance owning its own state directly.

Categories used below: **A** = sim orchestration (allowed). **B** = self-resolution (allowed). **C** = god's-eye violation (forbidden).

---

## 2. Headline result

| Protocol | Category A | Category B | Category C | Notes |
|---|---|---|---|---|
| **NH-1** | 23 | 0 | **0** | Clean. The "15-commit migration" landed. All cross-peer access via Transport. |
| **NX-17** | 0 | 0 | **2** | Inherits NX-15 / NX-10 / NX-6 routing. Two C sites of its own in `_pickRelayPeer`. |
| **NX-15** | 1 | 2 | **14** | Routing, learning, anneal all god's-eye. |
| **NX-10** | 0 | 0 | **2** | Pub/sub via `RoutingTree` is fully god's-eye. Lookup inherits NX-6. |
| **NX-6 (lineage parent)** | ~5 | ~2 | **~25** | Highest-volume violation in the codebase. Per-hop reads of another peer's synaptome. |
| **RoutingTree** (NX-10+ pub/sub) | 0 | 0 | **13** | Synchronous tree walks reading every parent / child / sub. |
| **Kademlia** | 7 | 1 | **3** | Geo-mode XOR scoring reads `s2Cell` per candidate. Lookup rehydrates ids to read `.lat` / `.lng`. |
| **G-DHT** (geob, geoa) | inherits Kademlia | | | Inherits the three Kademlia C sites verbatim. |
| **AxonManager** | 0 | 0 | **0** | Clean. Takes an injected DHT; all cross-peer access through the DHT interface. |
| **AxonPubSub** | 0 | 0 | **0** | Clean. Takes an injected AxonManager. |
| **post.js**, **Synapse.js**, **NeuronNode.js** | 0 | 0 | **0** | Pure data / hashing modules. |

**The "15-commit migration" the architecture doc described landed on NH-1 only.** NX-17, NX-15, NX-10, NX-6, Kademlia, and G-DHT all retain real Category C violations. The architecture doc and CLAUDE.md both overstate the migration's scope.

---

## 3. The highest-impact violations

### 3.1 NX-6 `_bestByTwoHopAP` — synchronous read of another peer's synaptome

```js
// src/dht/neuromorphic/NeuromorphicDHTNX6.js:864-882
const firstNode = this.nodeMap.get(firstSyn.peerId);
if (!firstNode?.alive) continue;

this._msg(current, firstNode, 'lookahead_probe');   // counter only

const fwdCands = [];
for (const fs of firstNode.synaptome.values()) {     // ← god's-eye read
  if ((fs.peerId ^ targetKey) < firstDist &&
      this.nodeMap.get(fs.peerId)?.alive)             // ← another god's-eye
    fwdCands.push(fs);
}
```

The function charges a message counter for the probe (`_msg(..., 'lookahead_probe')`) but **does not actually wait for any wire round-trip**. It synchronously reads `firstNode.synaptome.values()` and immediately scores. This is the routing primitive every NX-6/NX-10/NX-15/NX-17 lookup uses to pick its next hop.

NH-1's analogous code at `NeuromorphicDHTNH1.js:1027–1034`:

```js
const settled = await Promise.allSettled(
  probeSet.map(first =>
    current.transport.send(first.peerId, 'lookahead_probe', {
      target:   targetKey,
      fromDist: first.peerId ^ targetKey,
    })
  )
);
```

The shape is correct: a real wire RPC per probe, parallelized with `allSettled`. **In production this will pay real RTT.** In the simulator it does not (see §4 below).

### 3.2 NX-6 lookup main loop — per-hop reads of next-peer state

```js
// NeuromorphicDHTNX6.js:571, 592, 599, 606
let current = this.nodeMap.get(currentId);          // every hop
// later in the loop:
for (const s of current.synaptome.values()) {
  if (this.nodeMap.get(s.peerId)?.alive) ...        // every candidate
}
```

Every hop in NX-17's measured benchmark fires these reads. They produce the same routing decision as the wire-mediated version would, but the simulator never pays the wire cost.

### 3.3 RoutingTree (NX-10 pub/sub) — tree traversal as synchronous reads

```js
// RoutingTree.js:153, 172, 229, ... (13 sites)
const child = this.dht.nodeMap.get(childId);
if (child.alive) { child.handleMessage(...); }
```

Every NX-10 / NX-15 / NX-17 pub/sub broadcast walks the axonal tree as `nodeMap.get` reads. The simulator doesn't model per-hop latency for tree traversal at all — the broadcast completes in zero simulated time.

### 3.4 Kademlia geo-mode XOR scoring

```js
// src/dht/kademlia/KademliaDHT.js:451
const xorTo = useGeo
  ? id => { const n = this.nodeMap.get(id); return n ? (n.s2Cell ^ geoKey) >>> 0 : 0xffffffff; }
  : id => id ^ targetKey;
```

In the simulator, Kademlia in geo-mode can score any peer by reading its `s2Cell` field directly. In production, peers would need to include their `s2Cell` in `FIND_NODE` response payloads (a 1-byte field — trivial — but currently unimplemented).

---

## 4. The simulator transport doesn't model RTT — and that's structural

Spot-checking the audit surfaced a finding that **changes the diagnosis on latency comparisons**:

```js
// src/dht/SimulatedTransport.js:97 — send() implementation
this._bumpCounters(fromNode, toNode, type);
return await handler(this._localNodeId, payload);
```

No `setTimeout(latency)`, no artificial delay. The receiver's handler runs synchronously inside the caller's `await`. The simulator's `Transport.send()` resolves in roughly zero wall time.

Where then does NH-1's measured latency come from? `NeuromorphicDHTNH1.js:914`:

```js
ctx.totalTimeMs += nextSyn.latency;
```

NH-1 accumulates `nextSyn.latency` once per **hop transition** (per successful `lookup_step`). That's identical to what NX-6 does (`NeuromorphicDHTNX6.js:714`: `totalTimeMs += nextSyn.latency`).

So:
- **Both NH-1 and NX-17 measure latency the same way: one hop's `.latency` per successful next-hop.**
- **Neither pays simulated wire RTT for `lookahead_probe` two-hop probes.** The simulator's `send` is instant.
- **Neither pays simulated wire RTT for pub/sub tree traversal hops.**

The latency under-counting is therefore **symmetric across protocols.** Comparative benchmark claims (NH-1 vs NX-17 vs Kademlia) are made on equally-undercounted measurements; the relative ordering survives, but the absolute milliseconds will go UP in production for every protocol that uses two-hop probes or pub/sub trees.

---

## 5. What this means for historical benchmark validity

### 5.1 What transfers

**Hop counts.** Greedy XOR routing makes the same next-hop decision whether the receiver answers via wire or the source reads `peer.synaptome` directly — both arrive at the identical greedy minimum. NX-17's r500 hop advantage over Kademlia, NH-1's near-parity with NX-17 on hops, K-DHT's 4.4-hop global average — all real properties of the protocols.

**Success rates.** Same argument. Determined by topology and routing decisions, not by transport semantics. The 100% delivery under 5% churn for NH-1 is sound.

**Pub/sub delivery counts.** Counter invariants in the cascade test (1000 + 50×20 = 2000 reach) depend on AxonManager's per-relay accounting. AxonManager is clean; the counters transfer.

**Slice World partition recovery.** The bridge-seed-crystal dynamic is a routing-decision property. Transfers.

### 5.2 What does NOT transfer

**Absolute latency milliseconds, for every protocol.** The simulator under-counts wire RTT in two ways:
1. Two-hop lookahead probes are free.
2. Pub/sub tree traversal hops are free.

In production, both will pay real WebRTC RTT (≈10–100 ms per probe depending on geography). The May-15 benchmark snapshot in CLAUDE.md (NH-1 at 256 ms global, NX-17 at 242 ms) will both be higher in production, possibly by 50–150 ms.

**Comparative latency claims using NX-17 as a comparison point.** NX-17 is not deployable as-is — it reads peer state synchronously, which the Transport contract forbids. Either (a) we retire NX-17 from production comparison and treat it as a research upper bound, or (b) we refactor NX-17 onto the Transport contract and re-run the benchmark. Today's table reports a number that can never be measured against real wire.

**Pub/sub broadcast latency for NX-10 / NX-15 / NX-17.** The synchronous RoutingTree walk means broadcast completes in zero simulated time. In production, every level of the tree pays per-hop notify RTT.

### 5.3 The most important corollary

**NH-1 is the only protocol whose simulator numbers actually represent what production will measure** — modulo the universal two-hop-probe undercount that affects all routing benchmarks.

Everything else in the comparison tables is a research upper bound: "what this protocol could do if it had god's-eye view of the network." Useful for understanding the design space; not predictive of a deployed system.

---

## 6. Concrete claims I am now retracting or qualifying

From the architecture doc, CLAUDE.md, and the integration plan, the following statements were either wrong or overstated:

| Document | Claim | Reality |
|---|---|---|
| Architecture doc §4.4 | "After the 15-commit migration the only `nodeMap.get(peerId)` sites in the protocol code are sim-only orchestration" | True **for NH-1 only.** False for NX-17, NX-15, NX-10, NX-6, Kademlia, G-DHT. |
| Architecture doc §4.1 | "Years of N-DHT benchmark numbers in the simulator transfer directly: the protocol's hop counts, latency distributions, and pub/sub coverage are the same code path in production" | Hop counts transfer. Latency does not (universal undercount). Pub/sub coverage transfers for NH-1; pub/sub latency does not for any protocol. |
| Architecture doc §6 | "The parity-gate benchmark at 25K nodes (post-refactor v0.70.22 vs pre-refactor v0.70.04 reference) confirmed every protocol within the 10% target band" | The parity gate measured **simulator-internal consistency**, not production-faithfulness. NX-17 within 0.2% of its prior-version self does not imply NX-17 within 0.2% of production. |
| CLAUDE.md table | "NX-17 = 242 ms global, NH-1 = 256 ms global at 25K nodes" | The numbers are correct as simulator outputs but not predictive of production. NH-1 256 ms is the closer-to-production figure; NX-17 242 ms is unattainable without architectural surgery NX-17 hasn't had. |
| Integration plan §1 | "Code shared via `@axona/protocol` — NeuromorphicDHTNH1, NeuronNode, Synapse extracted." | NH-1 still extends the simulator's `src/dht/DHT.js` base class (which manages `nodeMap` and imports `SimulatedNetwork`). NH-1 cannot extract cleanly without first decoupling from that base class. Per-node-NH-1 refactor is its own work item. |
| Integration plan §2.2 | "If a file only depends on contracts and other `@axona/protocol` files, it moves." | The clean modules that pass this filter today: contracts (DHT, Transport, BootstrapService, types), post.js, Synapse.js, AxonManager (after replacing the `MockDHTNode` JSDoc), AxonPubSub. **Not** NH-1 itself. |

---

## 7. What we know is still solid

- **NH-1's protocol architecture.** It is the deployment-ready protocol. The integration plan's choice to ship NH-1 (not NX-17) is correct.
- **AxonManager and AxonPubSub.** Per-node clean. The five-verb API (publish/subscribe/pull/reshare/metrics) transfers to production end-to-end on top of NH-1.
- **The Transport contract.** The 12 methods are correctly sized and the SimulatedTransport correctly conforms (modulo the latency-modeling gap noted in §4).
- **Hop counts and success rates** for every protocol in the comparison table.
- **The Slice World partition test.** Bridge-seed-crystal recovery is a routing-decision property, not a latency one.
- **The bandwidth-distribution analysis** in the whitepaper. Message counters (`_msg`) are accurate per-protocol; the Gini analysis stands. (Notably, NH-1 broadcasts load to ~zero hot nodes at 50K, while K-DHT produces 56 hot nodes and G-DHT 62 — this is a real protocol property.)

---

## 8. Decisions this audit forces

These are decisions for the user; this doc does not pick them.

1. **CLAUDE.md benchmark table.** Either annotate it with the new understanding (NX-17 = research upper bound; NH-1 = production-faithful) or remove NX-17 from the comparison.
2. **Architecture doc §4.4 and §6.** Correct the migration-scope claim explicitly.
3. **Integration plan T1 scope.** Choose one of:
   - **T1-scoped**: extract only the clean modules (contracts, post.js, Synapse.js, AxonManager, AxonPubSub, utils) today. Defer NH-1 extraction to a separate per-node refactor.
   - **T0-refactor**: do the NH-1 per-node refactor first as M0, then extract.
   - **T1-full**: move NH-1 with its simulator base class (i.e., ship the multi-node-collapse class to production with a one-node instance). Awkward, but works.
4. **NX-17 going forward.** Either refactor NX-17 onto the Transport contract (substantial work, but lets the comparison be real), or retire it from production messaging while keeping it as a research artifact for the simulator.
5. **The latency-undercount in the simulator transport.** Should `SimulatedTransport.send` delay responses by `roundTripLatency(...)` so simulator latencies actually approximate production? This would re-baseline every benchmark — but make the numbers production-faithful.

---

## 9. Confidence

- The audit's site classifications were spot-checked against the source: NH-1 line 464 (Category A, inside `removeNode`), NX-6 lines 860–882 (Category C, synchronous `firstNode.synaptome` read), NX-17 lines 135–150 (Category C, `_pickRelayPeer` walks `nodeMap`), Kademlia line 451 (Category C, geo-mode `s2Cell` read). All confirmed.
- The latency-model correction in §4 was verified by reading `SimulatedTransport.send` (no `setTimeout`, no delay) and confirming NH-1's `ctx.totalTimeMs += nextSyn.latency` accumulation is hop-based, identical in shape to NX-6's.
- The AxonManager/AxonPubSub cleanliness was verified directly (zero `nodeMap` references in either file).
- The picture of which simulator code paths *should* legitimately touch `nodeMap` (Engine bookkeeping, churn injection, telemetry, the god's-eye stratified bootstrap that production replaces with BootstrapService) is consistent with the user's rule and with the architecture doc's intent — even though the doc overstated how completely the migration delivered on that intent.

---

*This document is a diagnostic, not a fix. The next iteration decides which corrective path to take.*
