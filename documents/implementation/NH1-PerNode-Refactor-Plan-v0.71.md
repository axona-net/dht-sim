# NH-1 Per-Node Refactor Plan

## Splitting `NeuromorphicDHTNH1` into a contract-conforming peer class and a simulator engine

**Document version:** v0.71.2 (initial)
**Companion to:** `Axona-Integration-Plan-v0.3.51.md`, `Axona-Wire-Protocol-v0.71.md`
**Author:** David A. Smith — YZ.social
**Date:** 2026-05-17
**Status:** plan; execution phases follow this doc.

---

## 1. Goal

Convert `NeuromorphicDHTNH1` from its current shape — **one class, many nodes, simulator-only** — into a clean per-node class that implements the `DHT` contract at `src/contracts/DHT.js`. Production peers instantiate one of these per peer. The simulator gets a separate `NHOneEngine` class that creates and orchestrates many instances.

After this refactor, T1 (extract `@axona/protocol`) becomes mechanical: the per-node class plus its dependencies move into the package, and the Engine stays in `dht-sim`. T4 (synaptome-mesh transition), T5 (bridge embedded peer), and T6 (first real lookup) unblock because the peer can finally instantiate the protocol.

## 2. Non-goals

- **Algorithm change.** Every routing decision the simulator makes today must reproduce within parity-gate tolerance (≤2% on hops, ≤5% on latency) after the refactor.
- **Wire-format change.** The message types and payload shapes documented in the wire spec stay identical.
- **Other protocols.** NX-17 (a subclass of NH-1) automatically benefits via inheritance. K-DHT and G-DHT stay as they are. Legacy NS-/NX-1…NX-15 are not touched.
- **Browser-tab UI changes.** `axona-peer`'s `client.js` stays mostly unchanged until the integration phase. The new `NHOnePeer` class lives next to the legacy multi-node class during the migration.

## 3. The architectural split

```
┌─────────────────────────────────────────────────────────────────────┐
│  src/contracts/DHT.js (canonical per-node contract)                 │
│    start / stop / join(sponsor) / leave                             │
│    lookup(targetKey)                                                │
│    publish(topic, payload) / subscribe / unsubscribe                │
│    getNodeId / getSynaptome / getMetrics / onEvent                  │
└─────────────────────────────────────────────────────────────────────┘
                              ▲ implements
                              │
┌─────────────────────────────────────────────────────────────────────┐
│  NHOnePeer  (this is what production imports)                       │
│  - One synaptome, one incomingSynapses, one temperature             │
│  - Owns a Transport reference (WebRTCTransport in production,       │
│    SimulatedTransport in the simulator)                             │
│  - Registers `lookup_step`, `lookahead_probe`, … handlers           │
│  - All cross-peer access goes through `this._transport`             │
└─────────────────────────────────────────────────────────────────────┘
                              ▲ wrapped by
                              │
┌─────────────────────────────────────────────────────────────────────┐
│  NHOneEngine  (simulator-only orchestrator; stays in dht-sim)       │
│  - Holds `nodeMap: Map<NodeId, NHOnePeer>`                          │
│  - addNode(lat, lng)          → create a new NHOnePeer              │
│  - removeNode(id)             → dispose one NHOnePeer               │
│  - buildRoutingTables({...})  → god's-eye topology                  │
│  - _tickDecay()               → iterate all instances               │
│  - postChurnHeal()            → iterate all alive instances         │
│  - getStats(), snapshotMetrics(), getMetrics(nodeId), …             │
└─────────────────────────────────────────────────────────────────────┘
```

In production, `axona-peer` instantiates one `NHOnePeer` via `new NHOnePeer({ transport, bootstrapService, nodeId, … })`. The peer's lifetime is the browser tab's. No Engine is involved.

In the simulator, `NHOneEngine` (which replaces today's `NeuromorphicDHTNH1` as the multi-node entry point) creates many `NHOnePeer` instances. Engine drives the simulator's cycle; each `NHOnePeer` runs its own per-node logic.

## 4. Method classification

Every method on today's `NeuromorphicDHTNH1` falls into one of three buckets. The third (hybrid) is the work surface — methods that today take `node` as their first parameter need to be converted to methods on `this`.

### 4.1 Per-node — move to `NHOnePeer`

These methods are already per-node in their semantics; they're just currently parameterized by `node` because the class manages many. Conversion: `methodName(node, ...args)` becomes `methodName(...args)` with `node` → `this`.

| Today (multi-node) | Tomorrow (per-node `NHOnePeer`) |
|---|---|
| `_lookupStep(node, ctx)` | `_lookupStep(ctx)` |
| `_lookupResult(ctx, found)` | `_lookupResult(ctx, found)` (unchanged — already pure) |
| `_bestByTwoHopAP(current, …)` | `_bestByTwoHopAP(candidates, targetKey, currentDist)` |
| `_vitality(node, syn)` | `_vitality(syn)` |
| `_addByVitality(node, newSyn)` | `_addByVitality(newSyn)` |
| `_reinforceWave(source, trace)` | `_reinforceWave(trace)` |
| `_recordTransit(node, originId, nextId)` | `_recordTransit(originId, nextId)` |
| `_tryAnneal(node)` | `_tryAnneal()` |
| `_evictAndReplace(node, deadSyn)` | `_evictAndReplace(deadSyn)` |
| `_localCandidate(node, lo, hi)` | `_localCandidate(lo, hi)` |
| `_bumpLookupStats(node, …)` | `_bumpLookupStats(…)` |
| `_greedyNextHopToward(node, targetId)` | `_greedyNextHopToward(targetId)` |
| `_findCloserInTwoHops(node, targetId)` | `_findCloserInTwoHops(targetId)` |
| `routeMessage(originNode, …)` | `routeMessage(targetId, type, payload, opts)` |
| `_deliverRouted(node, …)` | `_deliverRouted(type, payload, meta)` |
| `sendDirect(fromNode, peerId, type, payload)` | `sendDirect(peerId, type, payload)` |
| `_pickRecruitPeer(node, role, meta, subscriberId)` | `_pickRecruitPeer(role, meta, subscriberId)` |
| `_pickRelayPeer(node, role, subscriberId, forwarderId)` | `_pickRelayPeer(role, subscriberId, forwarderId)` |
| `findKClosest(sourceNode, …)` | `findKClosest(targetId, K, opts)` |
| `axonFor(nodeOrId)` | `axon` (getter — one AxonManager per peer) |
| `onRoutedMessage(node, type, handler)` | `onRoutedMessage(type, handler)` |
| `onDirectMessage(node, type, handler)` | `onDirectMessage(type, handler)` |
| `getNodeId(nodeOrId)` | `getNodeId()` |
| `getSynaptome(nodeOrId)` | `getSynaptome()` |
| `getMetrics(nodeOrId)` | `getMetrics()` |
| `_nodeShim(node)` | not needed — `this` IS the node |
| `onEvent(handler)` | `onEvent(handler)` |
| `_emit(event)` | `_emit(event)` |

### 4.2 Engine-only — stay in `NHOneEngine` (simulator)

These exist because the simulator needs them; production has equivalents that come from outside.

| Method | Reason |
|---|---|
| `constructor(config)` | Engine creates many peers from one config. |
| `addNode(lat, lng)` | Sim node creation. Production: `new NHOnePeer(...)` is called once per browser tab. |
| `removeNode(nodeId)` | Sim node destruction. Production: peer terminates with the tab. |
| `buildRoutingTables({…})` | God's-eye initial topology. Production: each peer calls `join(sponsor)` via BootstrapService. |
| `bootstrapNode(newNode, sorted, k)` | Helper for `buildRoutingTables`. |
| `bootstrapJoin(newNodeId, sponsorId)` | God's-eye stratified bootstrap. Production: `NHOnePeer.join(sponsor)` does the analogous thing through Transport. |
| `_tickDecay()` | Engine cycle — iterates all peers. Engine calls `peer.tickDecay()` on each. |
| `postChurnHeal()` | Engine cycle — iterates all alive peers. |
| `_anyAliveNode()` | Sim-only helper for picking a benchmark source. |
| `_resolveNode(nodeOrId)` | Sim-only; production peer is `this`. |
| `resetAllAxons()` | Sim-only mass reset. |
| `getStats()` | Multi-node aggregate; aggregates per-peer stats. |
| `snapshotMetrics(opts)` | Multi-node snapshot; calls per-peer `getMetrics()`. |
| `_logSynaptomeStats(label)` | Sim-only telemetry. |
| `dispose()` | Sim teardown of all peers. Per-peer `stop()` exists separately. |

### 4.3 New methods on `NHOnePeer` (no analog today)

The DHT contract has lifecycle and per-node operations that NH-1 doesn't implement today. The refactor adds them:

| New method | Purpose |
|---|---|
| `async start()` | Initialize this peer's state, register Transport handlers. Idempotent. |
| `async stop()` | Tear down, close all channels, stop heartbeats. |
| `async join(sponsor)` | Bootstrap from `BootstrapService.bootstrap(sponsor)`. Opens initial channel, runs self-lookup, fills synaptome via stratified bootstrap over Transport. |
| `async leave()` | Graceful shutdown — notify direct peers, close channels. |
| `async lookup(targetKey)` | Per-node lookup. No `sourceId` parameter; the peer IS the source. |
| `async publish(topicName, payload)` | Per-node publish on a topic this peer owns. Delegates to `this.axon`. |
| `async subscribe(publisher, topicName, handler)` | Per-node subscription. Delegates to `this.axon`. |
| `async unsubscribe(sub)` | Cancel subscription. |
| `tickDecay()` | Per-node decay (called by Engine in sim, by a self-scheduled interval in production). |
| `churnHeal()` | Per-node churn-heal (Engine-driven in sim; self-scheduled in production). |

### 4.4 Per-hop request handlers — registered on `this._transport` in `start()`

These currently live in `_registerNH1Handlers(node)`. They move to `NHOnePeer.start()` and bind to `this`:

```
this._transport.onRequest('ping',              ...)
this._transport.onRequest('lookahead_probe',   ...)
this._transport.onRequest('local_probe',       ...)
this._transport.onRequest('find_closest_set',  ...)
this._transport.onRequest('lookup_step',       ...)
this._transport.onRequest('route_msg',         ...)
this._transport.onNotification('reinforce',          ...)
this._transport.onNotification('triadic_introduce',  ...)
this._transport.onNotification('hop_cache',          ...)
this._transport.onNotification('lateral_spread',     ...)
this._transport.onPeerDied(peerId => this._deadPeers.add(peerId))
```

No semantic change — only the surrounding class. Each handler operates on `this.synaptome` / `this.incomingSynapses` / `this._deadPeers` instead of `node.*`.

## 5. Phased execution

The refactor proceeds in five phases. Each phase ends at a verification gate: the 25K-node parity-gate benchmark across the four production protocols (NH-1, NX-17, K-DHT, G-DHT). Numbers must reproduce within ≤2% on hops and ≤5% on latency. The smoke tests in `src/dht/kademlia/smoke_kdht.js` and `src/dht/neuromorphic/smoke_nx17.js` must continue passing.

### Phase 1 — `NHOnePeer` skeleton + co-existence (small)

- Create `src/dht/neuromorphic/NHOnePeer.js` as a per-node class implementing the DHT contract.
- Initially it holds: `nodeId`, `synaptome` Map, `incomingSynapses` Map, `_deadPeers` Set, `transport` reference, AxonManager instance, event listeners.
- No methods yet beyond `constructor`, `start()`, `stop()`, `getNodeId()`, `getSynaptome()`, `getMetrics()` (stubs), `onEvent()`.
- `start()` registers the Transport request/notification handlers as in §4.4 but the handlers delegate to the existing multi-node class for now. This is the bridge during migration.
- Verification: existing 25K parity-gate untouched (we haven't moved any logic yet).
- Effort: ~200 LOC + smoke test that constructs an `NHOnePeer` and calls each lifecycle method.

### Phase 2 — Move read-only operations + observability (medium)

Move methods that don't write any state:

- `_vitality`, `_bestByTwoHopAP`, `_greedyNextHopToward`, `_findCloserInTwoHops`
- `getNodeId`, `getSynaptome`, `getMetrics`
- `onEvent`, `_emit`
- The `lookahead_probe`, `local_probe`, `find_closest_set`, `ping` handlers (they're per-node already)

In the multi-node class, replace each method body with a call to the corresponding `NHOnePeer` method on the appropriate instance.

Verification: parity-gate, smoke tests. Should be exact — read-only operations cannot drift.

Effort: ~400 LOC moved + cross-class delegation wiring.

### Phase 3 — Move write operations (largest)

Move methods that mutate per-node state:

- `_addByVitality`, `_evictAndReplace`
- `_reinforceWave`, `_recordTransit`
- `_tryAnneal`, `_localCandidate`
- `routeMessage`, `_deliverRouted`, `sendDirect`, `findKClosest`
- `_pickRecruitPeer`, `_pickRelayPeer`
- `onRoutedMessage`, `onDirectMessage`
- The `lookup_step`, `route_msg`, `reinforce`, `triadic_introduce`, `hop_cache`, `lateral_spread` handlers

Multi-node class becomes a thin shell over per-peer instances.

Verification: parity-gate is the critical gate here. Subtle ordering / async-microtask differences may surface. If parity drifts, walk back to identify the diverging method.

Effort: ~1000 LOC moved + careful verification.

### Phase 4 — `NHOneEngine` extraction + `lookup(targetKey)` contract method (medium)

- Rename today's `NeuromorphicDHTNH1` class to `NHOneEngine`. Move to `src/simulation/NHOneEngine.js`. It manages many `NHOnePeer` instances.
- Engine's `lookup(sourceId, targetKey)` finds the per-peer instance and calls `peer.lookup(targetKey)` (the new contract method).
- Engine retains `addNode`, `removeNode`, `buildRoutingTables`, `bootstrapJoin`, `_tickDecay`, `postChurnHeal`, `dispose` — these are sim-orchestration.
- `main.js`'s `case 'ngdhtnh1'` continues to instantiate `NHOneEngine` (sim entry point unchanged).
- NX-17's class extends `NHOneEngine` (it's a sim entry point too).

Verification: parity-gate. Same numbers as before — only the class shape changed.

Effort: ~300 LOC of file moves + the `lookup` contract method on `NHOnePeer`.

### Phase 5 — Package extraction (`@axona/protocol`) (small, mechanical)

Move into the new `axona-net/axona-protocol` repo:

- `src/contracts/*` (already vendored to axona-peer; canonicalize here)
- `src/dht/neuromorphic/NHOnePeer.js` (the per-node class)
- `src/dht/neuromorphic/NeuronNode.js` (per-node state holder)
- `src/dht/neuromorphic/Synapse.js`
- `src/dht/neuromorphic/NeuromorphicDHTNX17.js` (subclass of NHOnePeer; revisit so it overrides only what's distinct, see §4.3 of integration plan)
- `src/pubsub/AxonManager.js`
- `src/pubsub/AxonPubSub.js`
- `src/pubsub/post.js`
- Utility helpers: `src/utils/geo.js`, `src/utils/s2.js`

`dht-sim` adds `@axona/protocol` as a file-dep first (`"file:../axona-protocol"`), publishes `@axona/protocol@1.0.0-beta.0` to npm when ready. `axona-peer` swaps its vendored `src/contracts/Transport.js` for `@axona/protocol/contracts`.

Verification: 25K parity-gate after package extraction. If numbers shift, the move dragged an unintended file along.

Effort: ~100 LOC of `package.json` + import-path edits.

### Phase 6 — End-to-end integration in `axona-peer` (separate session)

Out of scope for this refactor; tracked under T4/T5/T6 of the integration plan. With `@axona/protocol` published, `axona-peer/src/client.js` becomes:

```js
import { NHOnePeer } from '@axona/protocol';
const peer = new NHOnePeer({
  transport: new WebRTCTransport({ mesh }),
  nodeId,
});
await peer.start();
await peer.join({ kind: 'rendezvous', url: bridgeUrl, manifestSig });
// peer now operational; UI subscribes via peer.onEvent(...) and peer.getMetrics().
```

## 6. Verification gates

At the end of every phase, all of the following must pass:

| Gate | What | Tolerance |
|---|---|---|
| Smoke: NX-17 | `node src/dht/neuromorphic/smoke_nx17.js` | 100% global success at 200 nodes; API surface identical to NH-1 |
| Smoke: K-DHT/G-DHT | `node src/dht/kademlia/smoke_kdht.js` | 100% global + 100% regional at 200 nodes |
| Parity-gate 25K — global ms | Re-run `protocols: ["kademlia","geob","ngdhtnx17","ngdhtnh1"]` | ≤5% drift on NH-1 and NX-17 vs pre-refactor baseline |
| Parity-gate 25K — global hops | Same run | ≤2% drift |
| Parity-gate 25K — regional ms | Same run | ≤5% drift |
| Parity-gate 25K — churn success% | Same run, with churn test | ≥99% (no regression from 100%) |
| Pub/sub cascade | 2001-node `test_pubsub_cascade.js` | All 13 counter invariants hold |

If any gate fails, the phase is incomplete — walk back to the responsible commit and split into smaller steps.

## 7. Risks and mitigations

- **Phase 3 ordering drift.** The biggest risk. Moving write-operation methods one at a time, with the multi-node class delegating to per-peer instances, can introduce subtle microtask-ordering differences. Mitigation: aggressive parity-gate runs after each method move, not after each phase.

- **Async semantics drift.** Today's NH-1 already `await`s through the routing chain. But some methods (`_addByVitality`, `_localCandidate`) were converted to async during the 15-commit migration and produce `Promise<>`s in places that used to be sync. The per-node refactor doesn't change this surface — but the dual-class period of Phase 3 may have brief windows where one class is sync and the other is async. Mitigation: track every async signature in a checklist; both classes must match at any phase boundary.

- **AxonManager binding.** Today `_axonsByNode` is a `Map<NeuronNode, AxonManager>` indexed by the multi-node owner. Per-peer, each `NHOnePeer` owns one `AxonManager`. The transition during Phase 3 needs both indexing schemes to coexist until AxonManager's references are fully per-peer. Mitigation: make `NHOnePeer.axon` a getter; both indexing schemes resolve to the same AxonManager instance during migration.

- **`getMetrics(nodeOrId)` shape.** Engine's `getMetrics()` returns aggregate stats today; the new per-node `getMetrics()` returns one peer's stats. Engine retains an aggregated version (`Engine.getStats()`); the contract-method `getMetrics()` on `NHOnePeer` is single-peer. Mitigation: update simulator's dashboard reads to use `Engine.getStats()` for aggregates and `peer.getMetrics()` for per-peer drill-down.

- **NX-17 inheritance.** NX-17 currently extends NH-1. After the refactor: `NeuromorphicDHTNX17 extends NHOnePeer` (the per-node form, which is the one the production peer uses). The simulator NX-17 entry point becomes `NHOneEngine` subclassed with NX-17 parameter overrides — separate from the per-peer class. Mitigation: revisit `NeuromorphicDHTNX17.js` in Phase 4 to align with the new layering.

- **The 15-commit migration's god's-eye fixes regress.** Any per-node method moved from the multi-node class must NOT acquire any new `this.nodeMap` reads. Mitigation: a lint check on `NHOnePeer.js` — zero occurrences of `nodeMap` in protocol code. The Engine class is allowed to have them.

## 8. Out of scope (deferred to follow-up work)

- **Production `BootstrapService` implementation.** Today only `SimulatorBootstrapService` exists. The `axona-peer` integration phase will write `BridgeBootstrap` (rendezvous-via-axona-bridge variant) and `QRBootstrap` (QR-code pairing variant). The per-node `join(sponsor)` method handles both via the contract.
- **NH-1 self-scheduled `tickDecay` / `churnHeal`.** Today both are Engine-driven (called from the simulator's main loop). In production, `NHOnePeer` will schedule them itself via `setInterval`. This wiring is part of Phase 6 (integration), not the refactor itself.
- **Heartbeat ownership.** Today `MeshManager` owns the 1 Hz application ping. The wire spec specifies the Transport should own a `ping` request. Migrating that is a separate `axona-peer` change after the per-node NH-1 is in place.

## 9. Done definition

The refactor is complete when:

1. `NHOnePeer` is a stand-alone class implementing the DHT contract; production peers import it.
2. `NHOneEngine` is the simulator's orchestrator; `main.js`'s `case 'ngdhtnh1'` instantiates it; `case 'ngdhtnx17'` instantiates an Engine subclass.
3. The per-node class contains zero `nodeMap` reads. The Engine class contains only Engine-legitimate reads (addNode, removeNode, bootstrapJoin, tickDecay-across-all, etc.).
4. The 25K parity-gate reproduces within tolerance.
5. `@axona/protocol@1.0.0-beta.0` published with `NHOnePeer` + dependencies; `axona-peer` can `import { NHOnePeer } from '@axona/protocol'` and run NH-1.
6. The integration plan's T4, T5, T6 are unblocked.

---

*Plan locked at v0.71.2. Phase-by-phase commits in `dht-sim` reference this doc.*
