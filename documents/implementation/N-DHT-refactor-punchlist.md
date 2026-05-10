# N-DHT refactor punchlist

*Generated against contracts at `src/contracts/` (sim v0.70.06).*

## 0. Status (sim v0.70.21, refactor commits 1-15 done — sequence complete)

The 15-commit migration is partially complete.  Production target NH-1
is now V1+V2-clean in the routing path (lookup main loop, two-hop
lookahead, candidate enumeration, LEARN side-effects, pub/sub
primitives).

| Commit | Status | Title                                                   |
|--------|--------|---------------------------------------------------------|
| 1      | ✅     | SimulatedNetwork.makeTransport + Transport contract     |
| 2      | ✅     | SimulatorBootstrapService implements BootstrapService   |
| 3      | ✅     | K-DHT lookup converted to await transport.send (V3 fix) |
| 4      | ✅     | NH-1 transport-attached at addNode + onPeerDied        |
| 5      | ✅     | NH-1 _bestByTwoHopAP runs as parallel transport.send    |
| 6      | ✅     | NH-1 _localCandidate via parallel transport.send        |
| 7      | ✅     | NH-1 _findCloserInTwoHops reuses lookahead_probe        |
| 8      | ✅     | NH-1 _addByVitality on the Transport contract           |
| 9      | ✅     | NH-1 LEARN side-effects via transport.notify            |
| 10     | ✅     | NH-1 pub/sub primitives on the Transport contract       |
| 11     | ✅     | NH-1 lookup() recursive forwarding wrap-up              |
| 12     | ✅     | NX-15/NX-17 scope clarification (not migrated)          |
| 13     | ✅     | NX-6 lineage scope clarification (not migrated)         |
| 14     | ✅     | NeuronNode cleanup — `_nodeMapRef` retired              |
| 15     | ✅     | DHT.getMetrics / getSynaptome / onEvent observability   |

Scope decision (commit 12): NX-15, NX-17, and NX-6 are research /
comparison protocols.  They REMAIN on the simulator's god's-eye
`nodeMap.get` path so historical benchmark numbers (v0.66.x and
earlier) reproduce byte-for-byte.  They will not be migrated to the
Transport contract — that work targets NH-1 (the production target)
exclusively.  AxonManager's async-aware refactor (commit 10) is
backward-compatible with NX-15/17's sync primitives, so they keep
working in the simulator without any changes.

Remaining V1 sites in NH-1 (after commit 14):
  - `lookup(sourceId, ...)` — local self-resolution: `nodeMap.get(sourceId)`.
    This is unavoidable: a DHT instance must turn its own caller-supplied
    id into the live `NeuronNode` that owns the request.  Conceptually V1
    only, no V2 (no peer state read).
  - `addNode` / `removeNode` (sim Engine API): `nodeMap.set` /
    `nodeMap.delete` are the simulator's "node creation/destruction"
    bookkeeping, not protocol routing.
  - `bootstrapJoin` (sim-only god's-eye join): replaced by the production
    `BootstrapService.bootstrap(sponsor)` flow when the deployment pathway
    lands.  Not a routing-tick concern.
  - `_resolveNode` shim utility (axonFor's hex/Node disambiguation):
    invoked once per AxonManager creation; sim-only.

After commit 14, NH-1's protocol routing layer (lookup, candidate
enumeration, two-hop probes, LEARN side-effects, pub/sub, peer
admission/eviction, churn-heal) is V1/V2/V3-free.  Every cross-peer
read goes through the Transport contract.  The remaining `nodeMap.get`
sites are all sim-only orchestration.

---

## 1. Summary

Per-file violation counts. V1 = `nodeMap.get(peerId)` peer-registry reach. V2 =
cross-peer state read after a V1 reach. V3 = synchronous transport call without
`await`. A single line can carry V1 and V2 at once (the V1 lookup feeds the V2
field read); each is counted separately.

| File                              | LoC   | V1 | V2 | V3 | Notes                                                    |
|-----------------------------------|-------|----|----|----|----------------------------------------------------------|
| `NeuromorphicDHTNH1.js`           | 1522  | 47 | 8  | 0  | Primary target. All cross-peer access is V1+V2.          |
| `NeuronNode.js`                   | 150   | 0  | 1  | 0  | `getRoutingTableEntries` reads `_nodeMapRef`; viz only.  |
| `Synapse.js`                      | 52    | 0  | 0  | 0  | Pure value type.                                         |
| `pubsub/AxonManager.js`           | 1273  | 0  | 0  | 0  | Already conforms — only uses `dht.{routeMessage,sendDirect,findKClosest,...}`. Calls are sync but the contract surface here is the *DHT*, not Transport. |
| `NeuromorphicDHTNX17.js`          | 155   | 2  | 1  | 0  | One V1+V2 site in `_pickRelayPeer`.                      |
| `NeuromorphicDHTNX15.js`          | 668   | 13 | 4  | 0  | NX-17's parent. Same shape as NH-1, smaller surface.     |
| `NeuromorphicDHTNX10.js`          | 124   | 0  | 0  | 0  | Inherits NX-6/NX-15; no overrides that touch transport.  |
| `NeuromorphicDHTNX6.js`           | 1416  | 36 | 6  | 0  | Bigger surface than NH-1 (highway tier doubles loops).   |
| `dht/kademlia/KademliaDHT.js`     | 547   | 0  | 0  | 1  | One synchronous `network.send()` in iterative lookup.    |
| `dht/geographic/GeographicDHT.js` | 423   | 0  | 0  | 0  | Inherits K-DHT lookup verbatim — V3 lives in K-DHT.      |
| **Totals**                        | 6330  | 98 | 20 | 1  | (V1 sites total ≈ 75 unique lines; many co-occur with V2.) |

Estimated lines of code touched by the refactor: **~750–950** (see §9).

The dominant pattern is V1+V2: `peer = this.nodeMap.get(s.peerId); for (const
ps of peer.synaptome.values()) ...`. Eliminating the registry reach also
eliminates the field read in the same edit. Counting them separately is useful
for the production-pathway estimate (each V2 becomes one new RPC type).

`AxonManager.js` is already on the right side of the protocol/transport line.
Its `dht.sendDirect`/`routeMessage` calls are synchronous in the sim but the
contract for the DHT-facing primitives that AxonManager consumes is part of the
protocol layer itself (NH-1 / NX-15 implement them via their nodeMap reach).
The refactor surfaces async at the *boundary* between those primitives and
Transport, not at AxonManager's call sites — i.e. AxonManager keeps its current
shape; the implementations of `routeMessage` etc. become async.

---

## 2. NH-1 routing tick — call site by call site

All references are to `src/dht/neuromorphic/NeuromorphicDHTNH1.js` unless
otherwise stated.

### `lookup` at `NeuromorphicDHTNH1.js:427-555`
**Currently:** Drives a hop loop. At each hop reads `current = nodeMap.get(currentId)`
(L441), enumerates `current.synaptome.values()` (L450) and `incomingSynapses.values()`
(L456) for forward-progress filtering, calls `nodeMap.get(s.peerId)?.alive`
(L452, L458) to filter dead peers, and follows up with calls to
`_evictAndReplace`, `_bestByTwoHopAP`, `_introduce`, `_hopCache`, `_recordTransit`,
`_tryAnneal`, `_reinforceWave` — all of which themselves do further nodeMap reaches.
**Violation:** V1 at L441, L452, L458, L475, L491 (at-target check), L502 (next-id
verify), L527 (`nextNode = nodeMap.get(nextId)` for `_msg`).
**Becomes:** The hop loop runs entirely on this node's own `current` object —
which IS this node when the lookup originates here. Each "next hop" is a
`transport.send(nextId, 'find_node', {target})` if we need the remote to do
one-hop work, or a `transport.notify` if we just want to forward without a
response. The `nodeMap.get(s.peerId)?.alive` filter is replaced by
`transport.isConnected(s.peerId)` (the synapse already encodes the peerId; we
don't need a registry to ask "is it alive?", we ask the channel pool).
Liveness filtering for forwarding becomes implicit — `transport.send` rejects
on a dead channel and `onPeerDied` fires asynchronously to evict the synapse.
**Cost:** sync→async at every hop. Wall-clock-wise, hop count and per-hop RTT
are unchanged (the simulator already injects them); structurally, the inner
loop becomes `for await` over hop responses.

### `_bestByTwoHopAP` at `NeuromorphicDHTNH1.js:561-603`
**Currently:** For each of LOOKAHEAD_ALPHA top-by-AP first-hop candidates, calls
`firstNode = this.nodeMap.get(first.peerId)` (L578) and reads
`firstNode.synaptome.values()` (L586) to compute the best 2-hop candidate from
that peer's view. Filters `nodeMap.get(fs.peerId)?.alive` (L587) on the inner
loop.
**Violation:** V1 at L578, L587 + V2 at L586 (`firstNode.synaptome.values()`).
This is the canonical example the contracts call out.
**Becomes:** Each first-hop probe becomes a single bounded RPC:
`transport.send(first.peerId, 'find_closest', {target, k: 1})`. The remote's
handler runs the inner loop on its own synaptome and returns one
`{peerId, latency, dist}`. The probes for the LOOKAHEAD_ALPHA-sized probe set
fire in parallel via `Promise.allSettled`, exactly the canonical pattern the
contract spec endorses.
**Cost:** sync→async. Adds 1 RTT per hop (the probe set), parallelised across
α. The dead-peer filter on the inner loop is gone — the remote already filters.

### `_evictAndReplace` at `NeuromorphicDHTNH1.js:851-874`
**Currently:** Calls `_localCandidate(node, lo, hi)` (L858), then operates on
the returned NeuronNode object — `node.tryConnect(candidate)` (L860),
`roundTripLatency(node, candidate)` (L867), `clz64(node.id ^ candidate.id)`
(L868). The candidate must be a real NeuronNode for `tryConnect` to be
bilateral.
**Violation:** V1+V2 indirectly via `_localCandidate`. `tryConnect(candidate)`
is structurally a transport-layer concern (it's the simulator's bilateral cap)
that production replaces with `transport.openConnection(candidate.id)`.
**Becomes:** `_localCandidate` returns a `peerId` instead of a NeuronNode (see
next entry). `tryConnect` becomes `await transport.openConnection(peerId)`
which returns `false` if the bilateral cap is exceeded. Latency comes from
`transport.getLatency(peerId)` once the channel completes its first heartbeat.
**Cost:** sync→async. Adds the channel-open cost (bilateral handshake) on
admission only, not per use; that cost is already implicitly paid in the
simulator via `tryConnect`. Latency measurement comes for free from the
heartbeat.

### `_localCandidate` at `NeuromorphicDHTNH1.js:876-901`
**Currently:** For each synapse `syn` in `node.synaptome.values()`, calls
`peer = this.nodeMap.get(syn.peerId)` (L880), then the V2 read
`peer.synaptome.values()` (L886) to collect peers whose stratum falls in
`[lo, hi]`. Returns one randomly. Includes the `_msg(node, peer, 'local_probe')`
counter at L885 — this counter call is not a violation.
**Violation:** V1 at L880, L889 + V2 at L886 (`peer.synaptome.values()`). This
is the dominant V1+V2 site in NH-1 (89% of wire traffic at 25K, per the
constructor comment).
**Becomes:** One RPC per 1-hop peer: `transport.send(peerId, 'sample_synaptome',
{lo, hi, cap: ANNEAL_LOCAL_SAMPLE})`. The remote reads its own synaptome,
filters by stratum range, returns up to `cap` candidate peerIds. Caller picks
one at random. Probes fire in parallel via `Promise.allSettled` over all
synaptome peers; once we accumulate ANNEAL_LOCAL_SAMPLE candidates we can
short-circuit by ignoring late responses.
**Cost:** sync→async. Adds 1 RTT per anneal/replace cycle (parallelised across
synaptome peers). Wire volume is unchanged — the existing `_msg` counter
already accounts for one message per probed peer.

### `_findCloserInTwoHops` at `NeuromorphicDHTNH1.js:1228-1276`
**Currently:** For each synapse in `node.synaptome.values()`, calls
`p1 = this.nodeMap.get(syn.peerId)` (L1258), then runs a 2-hop closest-by-XOR
scan via `for (const syn2 of p1.synaptome.values())` (L1243), filtering
`nodeMap.get(syn2.peerId)?.alive` (L1247). Already restructured (per the L1234
comment) to look like the bounded-RPC pattern but still uses synchronous reads.
**Violation:** V1 at L1247, L1258, L1270 + V2 at L1243 (`p1.synaptome.values()`).
**Becomes:** Already pre-shaped for the conversion. `transport.send(p1.peerId,
'find_closest', {target, k: 1})` per first-hop peer, parallelised via
`Promise.allSettled`. Reduce to the minimum across responses. The
incomingSynapses fallback at L1269 is local — no change.
**Cost:** sync→async. 1 RTT per terminal-globality check (parallelised across
synaptome size).

### `_addByVitality` at `NeuromorphicDHTNH1.js:633-668`
**Currently:** Calls `peer = this.nodeMap?.get(newSyn.peerId)` (L638) to get a
NeuronNode for the bilateral `tryConnect` check. Operates entirely on `node`'s
own state otherwise.
**Violation:** V1 at L638 (peer-registry reach for the bilateral cap test).
**Becomes:** `await transport.openConnection(newSyn.peerId)`. If `false`,
return false (cap exceeded). The synapse is added to local synaptome on
success. No NeuronNode lookup needed.
**Cost:** sync→async. Channel-open cost is paid here (was implicitly paid by
`tryConnect`). Eviction logic (L654-666) is unchanged — pure local state.

### `_reinforceWave` at `NeuromorphicDHTNH1.js:674-689`
**Currently:** For each trace step, calls `node = this.nodeMap.get(fromId)`
(L677) and reinforces the synapse on that node. Also calls
`peer = this.nodeMap.get(synapse.peerId)` (L685) for the `_msg` counter.
**Violation:** V1 at L677, L685.
**Becomes:** This is the trickiest reshape. In production, only the *local*
node can reinforce its own synapse. The reinforcement wave currently mutates
synapses on multiple peers (one per hop on the trace). Production version:
walk the trace backward and `transport.notify(fromId, 'reinforce',
{toPeerId: synapse.peerId})`. Each peer reinforces its own synapse on receipt.
The `_msg` counter goes away — the notify *is* the wire message.
**Cost:** sync→async, but `notify` is fire-and-forget so no RTT. The traffic
counter currently double-counts (counter says one message; the new notify is
one message). Net: unchanged.

### `_recordTransit` at `NeuromorphicDHTNH1.js:695-708`
**Currently:** When the triadic threshold fires, calls
`nodeA = this.nodeMap.get(originId)` (L702) just for the `_msg` counter, then
calls `_introduce(originId, nextId)` which itself does V1 reaches.
**Violation:** V1 at L702 (counter only — easy to drop).
**Becomes:** The introduce call moves to a notify. See `_introduce` below.
**Cost:** No new RTT; the introduction is fire-and-forget.

### `_introduce` at `NeuromorphicDHTNH1.js:710-726`
**Currently:** Calls `nodeA = this.nodeMap.get(aId)` (L711) and
`nodeC = this.nodeMap.get(cId)` (L712). Reads `nodeA.synaptome.has(cId)`
(L714) — but `nodeA` is the local node here (it's the source of the lookup
that recorded the transit), so this is *not* cross-peer. The V2 problem only
arises if `aId !== thisNode.id`. Then computes `roundTripLatency(nodeA, nodeC)`
(L715) and `_addByVitality(nodeA, syn)` (L721) on the source.
**Violation:** V1 at L711, L712. The `nodeA.synaptome.has(cId)` read at L714
is *local* if the introduce fires for our own lookup, *cross-peer* if it fires
because we observed a transit through a different node and are telling that
node about C. In NH-1's actual call graph, `_introduce` is invoked from
`_recordTransit` which runs on the *transit* node, not the source — so `aId`
is the source and the read IS cross-peer.
**Becomes:** One `transport.notify(aId, 'triadic_introduce', {peerId: cId,
latencyHint, stratumHint})`. The recipient runs its own `_addByVitality`
locally. No response needed.
**Cost:** No RTT; fire-and-forget notify. Removes the V1+V2 entirely.

### `_hopCache` at `NeuromorphicDHTNH1.js:732-771`
**Currently:** Recursive helper. Calls `node = this.nodeMap.get(nodeId)`
(L733), `target = this.nodeMap.get(targetId)` (L734), and at depth-0 enumerates
`node.synaptome.values()` (L753) to find regional neighbors, then for each one
calls `peer = this.nodeMap.get(s.peerId)` (L755) to filter alive, and
recursively calls `_hopCache(regional[i].peerId, targetId, 1)` (L767) — which
again does V1 reaches on a different node.
**Violation:** V1 at L733, L734, L755, L765. The depth-0 read of
`node.synaptome.values()` is *local* when the cache fires for our own lookup
(NH-1's call site is `_hopCache(currentId, targetKey)` from the hop body —
`currentId` is the *current hop*, often a remote node). So V2 at L753 too.
**Becomes:** Two distinct mechanisms.
  1. The depth-0 cache write — "current learns about target" — is
     `transport.notify(currentId, 'hop_cache_write', {targetPeerId,
     latencyHint, stratumHint})`. The recipient learns and decides locally
     whether to also lateral-spread (depth-1).
  2. Lateral spread (depth-1) is initiated *by the receiving node* — when its
     `hop_cache_write` handler runs, it picks regional neighbours from its own
     synaptome and notifies each of them. This keeps the recursion entirely
     within nodes, with one notify per edge instead of a tree of nodeMap
     reaches.
**Cost:** No RTT; everything is notify. Removes one V1+V2 layer per recursion
level.

### `postChurnHeal` at `NeuromorphicDHTNH1.js:907-922`
**Currently:** Iterates `this.nodeMap.values()` (L908) and runs
`_evictAndReplace` on every node's dead synapses.
**Violation:** This is enumeration of all peers — a simulator-only concept.
In production, each node detects its own dead synapses via `transport.onPeerDied`.
**Becomes:** Delete entirely. The `onPeerDied` handler installed in the DHT
constructor calls `_evictAndReplace(node, syn)` for the dead synapse. The
"sweep all nodes" call is replaced by the asynchronous arrival of dead-peer
events at each node independently. The simulator's Engine loses the ability
to trigger a global heal explicitly — but that capability *is* the production
behaviour, just decentralised.
**Cost:** Removes ~15 LoC. Adds an `onPeerDied` registration in the DHT
constructor (one line).

### Bootstrap helpers (`buildRoutingTables`, `bootstrapNode`, `bootstrapJoin`)
See §4.

---

## 3. NH-1 pub/sub tick — call site by call site

### `routeMessage` at `NeuromorphicDHTNH1.js:1285-1341`
**Currently:** Sync hop walk. Each hop calls `_greedyNextHopToward(current,
targetId)` (L1308), which itself enumerates `current.synaptome.values()` and
does `nodeMap.get` on each peer (L1198). Terminal-globality check delegates to
`_findCloserInTwoHops` (L1312). Counter via `_msg(current, nextHop, 'route_msg')`
(L1334). The entire walk is synchronous because `current.synaptome` is read
from a NeuronNode object that lives in this process.
**Violation:** No new violations beyond those in `_greedyNextHopToward` and
`_findCloserInTwoHops`. The walk itself is just an `await` away from being
contract-compliant once those helpers are.
**Becomes:** `async` walk. Each hop becomes
`await transport.send(currentId, 'route_step', {targetId, type, payload})`
where the remote runs its own `_greedyNextHopToward` locally and either
consumes the message via the registered handler or returns `{forward:
nextHopId}`. The caller follows the chain.
**Cost:** sync→async. Per-hop RTT was already implicit (the simulator injects
it). Structurally one big change.

### `_greedyNextHopToward` at `NeuromorphicDHTNH1.js:1192-1205`
**Currently:** Enumerates `node.synaptome.values()` and does `nodeMap.get` on
each peer (L1197-1199). Picks the XOR-closest live peer.
**Violation:** V1 at L1198. `node` is local in routeMessage's first call but
becomes "the hop node" as the walk advances — except routeMessage walks
*locally* (in NH-1's nodeMap-mediated world); in production each hop runs the
greedy step *on the remote*. So this function becomes a local-only helper:
each hop's greedy step is done by the hop itself, not by the originator.
**Becomes:** The function stays, runs locally on each hop. The `nodeMap.get`
filter for liveness becomes `transport.isConnected(syn.peerId)`, which is a
synchronous channel-pool read and is fine.
**Cost:** No RTT (already sync). One V1 → one `transport.isConnected` call.

### `sendDirect` at `NeuromorphicDHTNH1.js:1364-1421`
**Currently:** Reads `peer = this.nodeMap.get(...)` (L1365), looks up
`handler = this._directHandlers.get(peer)?.get(type)` (L1372-1373), and
invokes the handler synchronously inside a drain-loop FIFO.
**Violation:** V1 at L1365. The handler invocation is purely local to the
*caller's* process — but in production, sendDirect IS the wire message. So
the entire drain loop only makes sense in the simulator.
**Becomes:** `await transport.send(peerId, type, payload)` (or `notify` if no
response expected). The `_directHandlers` map disappears at the protocol
layer — the handlers move to `transport.onRequest(type, ...)` /
`transport.onNotification(type, ...)`. The whole drain-loop machinery
(L1390-1419) goes away because real transport already serializes per-channel
delivery and the JS event loop handles the recursion that the drain queue
existed to flatten.
**Cost:** sync→async. Removes ~50 LoC of drain-queue scaffolding. Fan-out
through a 3-level axon tree no longer hits a JS stack-frame ceiling (it's now
async by construction).

### `findKClosest` at `NeuromorphicDHTNH1.js:1081-1161`
**Currently:** Iterative K-closest lookup. Seeds with source's synaptome +
incoming (L1106-1112), then queries up to α unvisited peers per round, calling
`_addPeerTopKToCandidates(peer, this._k, ...)` (L1149) which does V2 on each
queried peer.
**Violation:** No direct nodeMap reaches in this method, but V2 lives one
level deep in `_addPeerTopKToCandidates`.
**Becomes:** Each round's α queries fire in parallel via
`Promise.allSettled([transport.send(peerId, 'find_node', {target,
k: this._k}) for peerId in toQuery])`. The remote runs its own top-K from
its own synaptome (the existing `_addPeerTopKToCandidates` logic moves to the
handler side) and returns up to k peerIds. Caller merges into the candidate
pool, re-sorts, picks next α. Standard iterative Kademlia, just spelled with
the contract.
**Cost:** sync→async. Wall-clock unchanged (already paid per-round on the
caller's RTT). One round = one RTT to the slowest of α peers.

### `_addPeerTopKToCandidates` at `NeuromorphicDHTNH1.js:1170-1188`
**Currently:** Reads `peer.synaptome.values()` (L1172), filters
`nodeMap.get(syn.peerId)?.alive` (L1173-1174) on each entry, builds a top-K
heap.
**Violation:** V1 at L1173. V2 at L1172.
**Becomes:** Moves to the handler side as the implementation of the
`'find_node'` request handler (the registered `transport.onRequest` callback).
The handler reads its OWN synaptome (purely local), returns up to k peerIds.
The caller no longer has this method; the data arrives in the response payload.
**Cost:** Function moves location, doesn't grow. RTT cost is captured at
`findKClosest`.

### `_pickRecruitPeer` at `NeuromorphicDHTNH1.js:1431-1470`
**Currently:** Walks `node.synaptome.values()` (L1438), calls
`peer = this.nodeMap.get(syn.peerId)` (L1439) for liveness filtering.
**Violation:** V1 at L1439. The synaptome enumeration here is on `node`,
which is the *local* node (the one that owns the AxonManager). So this is a
purely local read in a parameter-name-misleading sense — it's our own
synaptome. The V1 is just the liveness filter.
**Becomes:** Replace `nodeMap.get(syn.peerId)?.alive` with
`transport.isConnected(syn.peerId)`. No RPC needed; no V2.
**Cost:** Pure mechanical replacement.

### `_pickRelayPeer` at `NeuromorphicDHTNH1.js:1481-1508`
**Currently:** Same shape as `_pickRecruitPeer`. Walks local synaptome,
filters by `nodeMap.get`'s liveness check (L1497).
**Violation:** V1 at L1497.
**Becomes:** Same fix — `transport.isConnected`.
**Cost:** Mechanical.

### AxonManager `dht.routeMessage`/`dht.sendDirect`/`dht.findKClosest` call sites
(`pubsub/AxonManager.js`)
**Currently:** All AxonManager methods that need to talk to other peers go
through the four primitives the DHT injects via `_nodeShim`: `routeMessage`,
`sendDirect`, `onRoutedMessage`, `onDirectMessage`, `findKClosest`. These
methods are synchronous in the simulator because they're implemented over the
nodeMap.
**Violation:** None at AxonManager's surface — the AxonManager → DHT contract
is pre-conformed. The violations all live in the *implementations* of those
methods inside NH-1 (covered above).
**Becomes:** As the NH-1 implementations of those methods become async, every
AxonManager call site becomes `await dht.routeMessage(...)` /
`await dht.sendDirect(...)`. Search-and-replace: every `this.dht.routeMessage`
and `this.dht.sendDirect` and `this.dht.findKClosest` gets `await`. About 30
call sites in AxonManager (subscribe, publish, refresh tick, K-closest paths).
The method signatures of `pubsubPublish`/`pubsubSubscribe`/`pubsubUnsubscribe`
themselves become `async`.
**Cost:** Mechanical. No RTT changes (the underlying message count is
unchanged).

---

## 4. NH-1 supporting layer

### NeuronNode (`NeuronNode.js`)
**Cross-peer state access:**
- `getRoutingTableEntries()` at L134-142 reads `this._nodeMapRef.get(s.peerId)`
  — that's a peer-registry reach. **Used only by the globe visualisation.**
  In production this method should return synapse snapshots (peerId + latency
  + weight), not NeuronNode pointers. The visualiser reshapes to draw arcs
  from snapshots.
- `progressCandidates(targetId)` at L91-101: pure local. No violation.
- `bestByAP(...)` at L116-127: pure local. No violation.
- `addSynapse`, `addIncomingSynapse`, `hasSynapse`, `canPrune`: pure local.

**Refactor:** Drop `_nodeMapRef` from the class. `getRoutingTableEntries`
becomes `getSynaptomeSnapshot()` returning `SynapseSnapshot[]` (matches the
contract's `SynapseSnapshot` typedef). Globe code reshapes accordingly. The
field exists on the class because NH-1's `addNode` and `bootstrapJoin` set it
(L164, L253, L335, L418); those assignments delete.

### Synapse (`Synapse.js`)
No violations. Pure value type. The contract's `SynapseSnapshot` typedef is a
strict subset of Synapse's fields plus `addedBy` (already present as
`_addedBy`). One-line change to expose `addedBy` without the underscore.

### Bootstrap path
**`buildRoutingTables` at NH-1:183-258**
**Currently:** Sorts every node, then for each node, for each XOR-table peer,
calls `node.tryConnect(peer)` (L237) and `peer.addIncomingSynapse(...)` (L245)
+ `_msg(node, peer, 'bootstrap')` (L250). Operates on every node's state in a
single synchronous pass.
**Violation:** This is the simulator's "build the world" entry point. In
production no node has access to all other nodes. The function is called
*by the simulator's Engine* on a single DHT instance representing the whole
network — a sim-only concept that doesn't ship.
**Becomes:** Goes away from the protocol layer. Replaced by per-node `start()`
+ `join(sponsor)` from the DHT contract. The Engine in the simulator builds
the world by creating N DHT instances and calling `join` on each via the
SimulatorEndpoint bootstrap kind.
**Cost:** ~75 LoC deleted from NH-1. Replaced by ~30 LoC of `start()`/`join()`
implementations (mostly delegating to `bootstrapJoin` which already exists in
spirit).

**`bootstrapNode` at NH-1:312-336**
Same situation — operates on the new node's state from "outside". Becomes the
body of `join(sponsor)` minus the `findClosest` walk (which moves to
`bootstrapJoin`).

**`bootstrapJoin` at NH-1:338-421**
**Currently:** Has an inline `findClosest(node, targetId)` helper at
L369-384 that walks `node.synaptome.values()` and `incomingSynapses.values()`
plus `nodeMap.get` on each peer. Then `iterLookup(targetId, startNode,
maxRounds)` at L386-410 runs synchronous iterative lookup that calls
`findClosest(peer, targetId)` — V2 on each peer's synaptome.
**Violation:** V1+V2 throughout the inline `findClosest` (L371, L373, L376,
L377). Same V1+V2 pattern as `_findCloserInTwoHops`.
**Becomes:** Same shape as the production `findKClosest`. The inline
`findClosest` becomes one round of `transport.send(peerId, 'find_node',
{target, k})`. The `iterLookup` body becomes the iterative loop with
`Promise.allSettled` per round. Sponsor connection is opened once via
`transport.openConnection(sponsorId)` (a real production thing — the WebRTC
sponsor handshake).
**Cost:** sync→async. ~10 RTTs per join (matches what the existing
`iterLookup` already simulates as 10 rounds of 3 peers each).

---

## 5. NX-17 / NX-15 / NX-6 / lineage

NX-15 is NX-17's parent; NX-10 inherits from NX-6 and is itself NX-15's
parent (chain is NH-1 standalone vs NX-17 → NX-15 → NX-10 → NX-6 → DHT).

### NX-17 (`NeuromorphicDHTNX17.js`)
The whole file is 155 lines and adds two behavioural lines plus
`_pickRelayPeer`. The `_pickRelayPeer` at L111-143 walks local synaptome and
highway, filters via `this.nodeMap.get(syn.peerId)` (L129, L130) — same
pattern as NH-1's `_pickRelayPeer`. Same fix: replace with
`transport.isConnected`.

Everything else (route walk, lookup, anneal, etc.) is inherited from NX-15.

### NX-15 (`NeuromorphicDHTNX15.js`)
NX-15 is the AxonManager-integrated parent. Violations:

- `findKClosest` at L218 — same as NH-1's `findKClosest`.
- `_addPeerTopKToCandidates` at L323-343 — V2 on `peer.synaptome.values()`
  (L340) and `peer.highway.values()` (L341). Same fix as NH-1; the `highway`
  tier just doubles the data the remote returns in its `find_node` response.
- `_greedyNextHopToward` at L357-378 — same V1 as NH-1.
- `_findCloserInTwoHops` at L398-447 — same V1+V2 as NH-1; with the addition
  of an inner `for (const syn2 of p1.highway.values())` (L419) for the
  highway tier.
- `routeMessage` at L462 — same shape as NH-1.
- `sendDirect` at L554-606 — same drain-queue scaffolding as NH-1; same fix.
- `_pickRecruitPeer` at L622-666 — V1 at L636 (`nodeMap.get` for liveness
  filter on tiers).

**Conclusion:** Same pattern as NH-1's pub/sub layer. Most refactor work for
NX-15 is identical to NH-1's; the highway-tier loop adds a few lines per
function but is a mechanical extension.

### NX-10 (`NeuromorphicDHTNX10.js`)
124 lines. Inherits everything from NX-15/NX-6. No methods that touch
transport are overridden. Zero new violations.

### NX-6 (`NeuromorphicDHTNX6.js`)
1416 lines. NX-6 is the routing-and-anneal core that NX-15 / NX-17 sit on top
of. Violations identical in shape to NH-1's, with a highway tier multiplying
some loops:

- `lookup` at L514-777 — same V1+V2 surface as NH-1's `lookup` (V1 reaches at
  L515, L551, L572, L579, L586, L619, L633, L653, L669, L762, L784, L793).
  Also has the highway-tier dead-peer detection at L580 that NH-1 doesn't
  have. **Same as NH-1's `lookup`.**
- `_synaptomeFindClosest` at L360-383 — used by `bootstrapJoin`. V1+V2 over
  synaptome, highway, and incomingSynapses. **Same as NH-1's
  `findClosest` helper inside `bootstrapJoin`.**
- `bootstrapJoin` at L385 — same shape as NH-1's bootstrapJoin.
- `_bestByTwoHopAP` at L801-882 — adds optional load-balancing peer reach at
  L807 (V1 only, used to read `peer.loadEMA`/`loadLastEpoch` — V2). Otherwise
  **same as NH-1's `_bestByTwoHopAP`** plus the highway-tier inner loop at
  L857-862. The load-balancing mode (off by default) needs an extra RPC field
  in the find_closest response payload.
- `_introduce` at L886-902 — **same as NH-1's `_introduce`** (the function in
  NH-1 was ported from here).
- `_introduceAndSpread` at L906-940 — **same as NH-1's `_hopCache`**. Plus a
  `LATERAL_MAX_DEPTH` recursion bound (NH-1 hardcodes depth ≤ 1).
- `_refreshHighway` at L1008-1048 — V1+V2 over `peer.synaptome.values()` at
  L1015-L1030. This is NH-1-style "ask each 1-hop peer for its peers", but
  for highway-hub selection rather than anneal. **Same fix as
  `_localCandidate`.**
- `_recordTransit` at L1071-1084 — same as NH-1's.
- `_tryAnneal` at L1088-1149 — same as NH-1's `_tryAnneal`. V1 at L1136 to
  free the victim's slot before connecting the candidate.
- `_localCandidate` / `_localCandidateList` at L1161-1197 — **same as NH-1's
  `_localCandidate`**, with the addition that NX-6 returns a list (for
  retries) instead of a single pick.
- `_evictAndReplace` at L1205-1262 — **same as NH-1's `_evictAndReplace`**,
  with retry-on-refusal logic that NH-1 doesn't have. The retry logic
  becomes "iterate the list returned by the new `sample_synaptome` RPC,
  attempting `transport.openConnection` on each until one accepts". Same shape.
- `_tickDecay` at L1279 — iterates `this.nodeMap.values()`. **Same as NH-1's
  `_tickDecay` / `postChurnHeal`**: simulator-only enumeration that goes away.
  Each node decays its own synaptome on its own timer in production.

### Worth flagging in NX-6 that does NOT exist in NH-1
- `_refreshHighway` is a *separate* periodic operation that NH-1 doesn't have
  (NH-1 has no highway tier). One additional V1+V2 call site to fix; same
  pattern as `_localCandidate`.
- `_introduceAndSpread` recursion depth is configurable (`LATERAL_MAX_DEPTH`,
  default 1) — at depth=1 it matches NH-1; deeper recursions are notify-only
  cascades through peer-by-peer. The existing recursion through nodeMap reach
  becomes a cascade of notifies.

---

## 6. K-DHT and G-DHT

### K-DHT (`dht/kademlia/KademliaDHT.js`)
**`lookup` at K-DHT:412-535** — the only V3 site in the entire codebase.

**`network.send` at K-DHT:462**
**Currently:**
```
const { response } = this.network.send(
  source, node.id, 'FIND_NODE', { target: targetKey, geoKey }
);
```
Synchronous in-process call into `SimulatedNetwork.send`. The result is
destructured immediately and used to extend the candidate pool.
**Violation:** V3 — sync transport call.
**Becomes:**
```
const response = await this.transport.send(node.id, 'FIND_NODE',
                                            { target: targetKey, geoKey });
```
The α queries per round are wrapped in `Promise.allSettled`:
```
const results = await Promise.allSettled(
  toQuery.map(node =>
    this.transport.send(node.id, 'FIND_NODE',
                        { target: targetKey, geoKey })
  )
);
const newNodes = results
  .filter(r => r.status === 'fulfilled')
  .flatMap(r => r.value);
```
The `try/catch` around the existing `network.send` (L460-474) — which catches
nodes that churned out mid-lookup — is replaced by `Promise.allSettled`'s
per-promise rejection handling. The dead-peer case is caught by
`onPeerDied` asynchronously, so subsequent rounds don't pick the dead peer.

**Other K-DHT call sites:**
- `addNode` and bookkeeping paths use `this.network.addNode` and
  `this.network.removeNode` — these are simulator-control surface (not part
  of the protocol's wire interface). They go away when the protocol stops
  enumerating nodes.
- `bootstrapJoin` at L328-381 uses `peer.findClosest(...)` (L348, L358). That
  reads the peer's k-buckets directly — V2 in the same sense as the
  neuromorphic V2 sites. Becomes
  `await transport.send(peerId, 'FIND_NODE', {target, k})`. The function
  shape mirrors `iterLookup` in NH-1 / NX-6.
- `KademliaNode.handleMessage` at L218-233 — already a message handler; in
  production it's `transport.onRequest('FIND_NODE', handler)`. One small
  reshape: the `from` parameter comes from the request envelope, not the
  payload.

**Cost:** `lookup` becomes async at the candidate-merge level (the outer
function is already async). One V3 → one `await Promise.allSettled`. Wall
clock per round = max of α RTTs (already the case in the time accounting at
L508-515).

### G-DHT (`dht/geographic/GeographicDHT.js`)
Inherits `lookup` from K-DHT — no override. Therefore the V3 fix in K-DHT
applies to G-DHT for free.

`bootstrapJoin` at G-DHT:191-248 calls `peer.findClosest(targetId, this.k)`
(L226) — same V2 as K-DHT's bootstrapJoin. Same fix.

`buildRoutingTables` is sim-only (whole-world enumeration) — see §4.

---

## 7. Open design questions surfaced by the audit

1. **Two-hop AP scoring: serial vs parallel probes.**
   Confirmed: parallel via `Promise.allSettled` is the canonical pattern and
   matches what the contract spec endorses (lines 134-141 of `Transport.js`).
   `_bestByTwoHopAP` becomes:
   ```
   const probeSet = ranked.slice(0, this.LOOKAHEAD_ALPHA);
   const responses = await Promise.allSettled(
     probeSet.map(s =>
       this.transport.send(s.peerId, 'find_closest', { target, k: 1 })
     )
   );
   ```
   then take the min over fulfilled responses by the AP2 score. Same applies
   to `_findCloserInTwoHops`. **No design decision needed; document the
   pattern in the implementation plan and lock it in.**

2. **Anneal: fire-and-forget background task or await?**
   Probably FAF. Anneal fires probabilistically per hop (`Math.random() <
   current.temperature`), and the lookup that triggers it doesn't need the
   anneal result to proceed. Implementation: the anneal call inside the hop
   loop becomes
   ```
   if (Math.random() < t) this._tryAnneal(current);  // not awaited
   ```
   `_tryAnneal` itself is async (it does `transport.openConnection`), but the
   caller doesn't block on it. **Confirm: are we OK with anneal failures going
   silent?** Yes — they're already silent under bilateral cap (`tryConnect`
   returns false). One question: do we want to surface anneal failures via
   `onEvent` for telemetry? Probably yes; one new `anneal-failed` event type.

3. **`_localCandidate` becomes one RPC per peer. How many RTTs per cycle on
   average?**
   At 25K-node sim, the ANNEAL_LOCAL_SAMPLE=50 cap and ANNEAL_RATE_SCALE=1
   default fire `_localCandidate` ~ once per hop on the warm-temperature
   nodes that have just lost a synapse. Each call probes up to
   `synaptome.size` peers in parallel — roughly cap=50 peers. So one cycle
   triggers ~50 parallel RPCs from one node. Wall-clock = max RTT across
   those 50, which is the slow-tail latency, ~150-200ms on a global p2p
   network. **At the ANNEAL_RATE_SCALE=1.0 default, this could exceed the
   per-cycle bandwidth budget under heavy lookup load.** The existing
   ANNEAL_RATE_SCALE=0.1 ablation already exists for exactly this reason —
   document that production should likely run at scale ≤ 0.1 and add a
   bandwidth-budget telemetry signal.

4. **Does `findKClosest` (used by AxonManager's terminal-globality check)
   stay as iterative lookup, or get a different production-mode path?**
   It stays iterative. The K-closest cache that AxonManager already
   maintains (`_kClosestCache` at AxonManager:121) handles repeated calls
   within an epoch; one full iterative lookup per epoch per topic is fine.
   The terminal-globality check on routeMessage uses `_findCloserInTwoHops`
   (cheap 2-hop probe) rather than a full `findKClosest` — that distinction
   is preserved. **No design change.**

5. **`postChurnHeal` removal — does the simulator need a global heal hook?**
   Currently the Engine calls `postChurnHeal()` after a churn batch to
   synchronously repair the network before the next lookup batch. In
   production this happens asynchronously via `onPeerDied`. The simulator's
   benchmark needs *deterministic* per-cycle heal behaviour to make
   measurements reproducible. **Decision needed:** either (a) the
   SimulatedNetwork transport fires `onPeerDied` synchronously before the
   next lookup tick (matching production semantics, slightly different
   wall-clock distribution), or (b) the simulator keeps a back-channel
   `engine.flushDeadPeers()` that drains pending dead-peer events. (a) is
   cleaner and what the contract spec implies (Transport contract §29: "Peer
   death is asynchronous and arrives via callback").

6. **Sponsor connection and BootstrapService.**
   The contract has `BootstrapService.bootstrap(sponsor) → {sponsorId,
   transport}`. The simulator's implementation just hands back the in-process
   pointer (the existing `network` field from `DHT.constructor`). Production
   does WebSocket signaling + WebRTC offer/answer. **No change needed in the
   protocol; just one new SimulatorBootstrapService class implementing the
   contract.**

7. **The `_msg` traffic counter.**
   NH-1 / NX-6 keep their own counter (`_msg(from, to, type)`) that bumps
   `msgsSent`/`msgsReceived` on each conceptual wire interaction. Once
   transport calls become real, these counters move to `Transport.send` /
   `Transport.notify` and are read via `getMetrics().traffic`. The `_msg`
   helper goes away. **Mostly mechanical, but one per-protocol concern:**
   the existing simulator transport doesn't increment those counters for
   neuromorphic wire activity (per the comment at NH-1:524-526), so once we
   route through `transport.send`/`notify`, the simulator's wire counters
   will start counting too — and the existing `_msg` calls double-count.
   Resolution: delete every `_msg` call when its corresponding nodeMap
   reach is converted to a transport call, in the same commit.

8. **Identity types: BigInt vs hex.**
   NH-1 / NX-15 internally use BigInt for NodeId and convert to hex at the
   AxonManager boundary (`nodeIdToHex`, `topicToBigInt`). The contracts use
   BigInt (`@typedef {bigint} NodeId`). AxonManager's hex usage is a sim
   artifact. **Design question:** do we standardise on BigInt at every layer
   and remove the conversions in `_nodeShim`, or keep AxonManager on hex
   strings? Recommendation: standardise on BigInt, drop the conversions —
   but defer until after the V1/V2/V3 work is done; it's a separate
   mechanical pass.

---

## 8. Refactor sequencing

Each commit must leave the simulator in a working state with all current
benchmarks passing. The dependency graph is roughly:

`SimulatedNetwork → Transport contract` precedes `protocol → transport` calls,
which precede `NeuronNode cleanup` and `Engine sim-only enumerator removal`.
Numbered in the order that minimizes broken-state windows.

1. **`feat: SimulatedNetwork conforms to Transport contract`** — implement the
   abstract methods (`start`, `stop`, `openConnection`, `closeConnection`,
   `isConnected`, `send`, `notify`, `onRequest`, `onNotification`,
   `onPeerDied`, `getLatency`, `getLocalNodeId`) on `SimulatedNetwork`. No
   protocol changes. Add tests verifying each method. Eliminates: 0
   violations (preparatory).

2. **`feat: SimulatorBootstrapService implements BootstrapService`** — new
   class that wraps SimulatedNetwork and returns `{sponsorId, transport}` for
   `kind: 'simulator'` endpoints. Eliminates: 0 violations (preparatory).

3. **`refactor(K-DHT): convert lookup to await transport.send`** — the V3
   fix. K-DHT's `lookup` becomes `Promise.allSettled` over α queries per
   round. `bootstrapJoin` rewires `peer.findClosest` to
   `transport.send(peerId, 'FIND_NODE', ...)`. K-DHT's `handleMessage`
   becomes a `transport.onRequest('FIND_NODE', ...)` registration. G-DHT
   inherits both fixes. Eliminates: V3 in K-DHT/G-DHT (1) + V2 in
   bootstrapJoin (2).

4. **`refactor(NH-1): hop-by-hop liveness via transport.isConnected`** —
   replace every `nodeMap.get(s.peerId)?.alive` filter inside `lookup` /
   `_greedyNextHopToward` / `_pickRecruitPeer` / `_pickRelayPeer` with
   `transport.isConnected(s.peerId)`. No new RPCs. Eliminates: ~15 V1 sites,
   no V2.

5. **`refactor(NH-1): _bestByTwoHopAP via parallel find_closest probes`** —
   convert the two-hop AP lookahead to `Promise.allSettled` + 'find_closest'
   RPC. Add `transport.onRequest('find_closest', ...)` handler that runs the
   inner-AP scoring on the local node. Eliminates: V1 at L578, L587 + V2 at
   L586. (Same shape applies to `_findCloserInTwoHops` — bundle them.)

6. **`refactor(NH-1): _localCandidate via parallel sample_synaptome
   probes`** — convert the synaptome 2-hop scan in `_localCandidate` to
   parallel RPCs. Add `transport.onRequest('sample_synaptome', ...)`
   handler. `_evictAndReplace` and `_tryAnneal` automatically benefit.
   Eliminates: V1 at L880, L889 + V2 at L886 (and the corresponding NX-6
   sites at L1174, L1179, L1182).

7. **`refactor(NH-1): _hopCache and _introduce as transport.notify`** —
   convert hop-cache writes and triadic introductions to fire-and-forget
   notifies. Recursion in `_hopCache` becomes a cascade of notifies (each
   recipient initiates the next level). Add notification handlers:
   `'hop_cache_write'`, `'triadic_introduce'`, `'reinforce'` (for
   `_reinforceWave`). Eliminates: V1 at L677, L685, L702, L711, L712, L733,
   L734, L755, L765 + V2 at L753.

8. **`refactor(NH-1): routeMessage and sendDirect over transport`** —
   `routeMessage` becomes async hop-by-hop walk via 'route_step' RPCs.
   `sendDirect` becomes `transport.send`/`notify` with handler routed via
   `transport.onRequest`/`onNotification`. Drain queue deleted. Eliminates:
   V1 at L1198 (greedy-next-hop in remote walk path), L1365 (sendDirect
   peer lookup), L1372 handler dispatch.

9. **`refactor(NH-1): findKClosest iterative over transport`** —
   `findKClosest` becomes `Promise.allSettled` per round of 'find_node'
   RPCs. `_addPeerTopKToCandidates` moves to the handler side. AxonManager
   call sites become `await this.dht.findKClosest(...)`. Eliminates: V1+V2
   inside `_addPeerTopKToCandidates` (L1172-1174).

10. **`refactor(NH-1): bootstrap via DHT.start/join and BootstrapService`** —
    delete `buildRoutingTables` / `bootstrapNode` (sim-only enumerators).
    Implement `start()` / `join(sponsor)` / `leave()` on the DHT. Move the
    bootstrapJoin loop to use transport-mediated find_node RPCs. Engine
    rewires from `engine.buildRoutingTables(dht)` to
    `await Promise.all(nodes.map(n => n.dht.join(sponsor)))`. Eliminates:
    V1+V2 inside `bootstrapJoin`'s inline `findClosest` / `iterLookup`
    (L371-396).

11. **`refactor(NH-1): postChurnHeal -> transport.onPeerDied`** — delete
    `postChurnHeal`. DHT constructor registers
    `transport.onPeerDied(peerId => this._handlePeerDied(peerId))`, which
    fires `_evictAndReplace` for that peer's synapse. Engine's churn batch
    awaits a barrier ("all dead-peer events drained") before the next
    benchmark tick. Eliminates: V1 at L908, L912, L915, L916.

12. **`refactor(NX-15/NX-17): apply NH-1 changes to lineage`** — repeat
    commits 4-11 for NX-15 (which NX-17 inherits from). NX-17 only needs the
    `_pickRelayPeer` liveness-filter conversion (one V1 at L129-130). NX-10
    has no protocol-level overrides; no work.

13. **`refactor(NX-6): apply NH-1 changes to NX-6`** — same pattern as
    commit 4-11 applied to NX-6's larger surface (including the highway-tier
    inner loops in `_bestByTwoHopAP`, `_findCloserInTwoHops`,
    `_refreshHighway`, `_localCandidate`). The `_refreshHighway` periodic
    is the only fundamentally new call site beyond what NH-1 covers; same
    pattern as `_localCandidate`. Eliminates the bulk of NX-6's V1+V2.

14. **`refactor(NeuronNode): drop _nodeMapRef, expose synaptome
    snapshots`** — remove `_nodeMapRef` field and all assignments
    (`addNode`, `bootstrapJoin`, etc.). `getRoutingTableEntries()` →
    `getSynaptomeSnapshot()` returning `SynapseSnapshot[]` per the contract
    typedef. Globe visualiser updated to consume snapshots. Eliminates: 1
    V2 site (NeuronNode:138).

15. **`feat: DHT.getMetrics / getSynaptome / onEvent observability`** —
    final pass. Implement the read-only telemetry surface from the DHT
    contract on every protocol class. Wire the simulator's per-cycle
    snapshot through `onEvent('cycle-snapshot', ...)` instead of the
    current direct nodeMap walks in `Engine.snapshotTrafficLoad`. Removes
    the last simulator-only nodeMap reaches in `getStats` and `_logSynaptomeStats`.

After commit 15, no `nodeMap.get(peerId)`-style peer-registry reach remains in
protocol code, and the only enumeration of "all nodes" lives in the simulator
Engine — exactly as the contract README describes.

---

## 9. Estimated LoC impact

Rough counts. "Modified" means existing lines edited; "added" means net new
lines; "deleted" means net removed.

| Bucket                                            | Deleted | Added  | Modified |
|---------------------------------------------------|---------|--------|----------|
| NH-1 protocol refactor (commits 4-11)             | ~140    | ~180   | ~210     |
| NX-15 / NX-17 protocol refactor (commit 12)       | ~110    | ~140   | ~150     |
| NX-6 protocol refactor (commit 13)                | ~190    | ~230   | ~270     |
| K-DHT / G-DHT V3 fix + bootstrapJoin (commit 3)   | ~20     | ~40    | ~60      |
| NeuronNode cleanup (commit 14)                    | ~25     | ~30    | ~10      |
| SimulatedNetwork → Transport conformance (1)      | ~30     | ~120   | ~80      |
| BootstrapService impl (2)                         | 0       | ~80    | 0        |
| Engine rewire (`buildRoutingTables` → `join`s, etc.) | ~80   | ~50    | ~40      |
| Observability (`getMetrics`/`getSynaptome`/`onEvent`, commit 15) | 0  | ~150  | ~30      |
| AxonManager `await` mechanical pass (commit 8/9)  | 0       | 0      | ~30      |
| **Totals**                                        | **~595**| **~1020** | **~880** |

New files: `src/contracts/SimulatorBootstrapService.js` (~80 LoC),
plus tests for the new transport conformance (~250 LoC under `test/`).

Net production-code growth: ~+425 LoC (1020 added − 595 deleted), driven by
the explicit `Promise.allSettled` patterns and per-RPC handler registrations.
Modified line count is high (~880) because every protocol method that
previously used `nodeMap.get` now uses `transport.{send,notify,isConnected}`
and gets an `async` keyword.

The end state: protocol code is roughly the same size as today, but every
cross-peer interaction is one of the four contract verbs
(`send` / `notify` / `openConnection` / `isConnected`) and the `nodeMap` field
is gone from every protocol class.
