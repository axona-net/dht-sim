# Axona Integration Plan

## Bringing the NH-1 protocol into `axona-peer` and `axona-bridge`

**Document version:** v0.3.51
**Companion to:** N-DHT Whitepaper v0.3.51 · N-DHT Architecture v0.3.51
**Author:** David A. Smith — YZ.social
**Date:** 2026-05-16

---

## 0. Where this plan starts

Three repos exist today, in three states.

| Repo | Today | Phase 3 target |
|---|---|---|
| **`dht-sim`** | Simulator + canonical home of NH-1, AxonManager, AxonPubSub, the three contracts (`DHT`, `Transport`, `BootstrapService`), the simulator's `SimulatedTransport`, the `SimulatorBootstrapService`. Runs entirely in one browser tab. | Unchanged as a research artifact. Donates its pure-JS protocol modules to the new shared package below. |
| **`axona-peer`** | Phase 2: WebSocket to bridge, then full-mesh WebRTC `RTCPeerConnection` + `RTCDataChannel` to every announced peer, 1 Hz ping/pong over the data channel. ~1.3 KLOC across `client.js` + `mesh.js` + `qr.js`. Speaks no DHT protocol. Version `0.3.0`. | Phase 3: implements the `Transport` contract on top of `mesh.js`'s WebRTC machinery, instantiates `NeuromorphicDHTNH1` against it, runs the routing protocol with a synaptome-sized routing table. Drops the full-mesh assumption. |
| **`axona-bridge`** | Phase 2: WebSocket signaling broker (`welcome`, `peer-list`, `peer-joined`, `peer-left`, opaque `signal` relay) plus HMAC-signed short-lived TURN credentials. ~400 LOC in `server.js`. Speaks no DHT protocol. Version `0.4.0`. | Phase 3: continues all of the above, **and** runs an internal server-class `axona-peer` instance that joins the DHT as a *highway node* (synaptome cap 256, marked transit-hub). The bridge becomes a real participant — the first sponsor every browser peer talks to, and a persistent transit point that keeps cold-start latency low. |

A fourth repo is created by this plan: **`@axona/protocol`**, a published npm package carrying the pure-JS protocol kernel that both `dht-sim` and `axona-peer` consume.

---

## 1. Architecture decisions (already taken)

These are the four choices that gate the rest of the plan; the answers below are the ones we took on 2026-05-16. Subsequent sections assume them.

| Decision | Choice | Why |
|---|---|---|
| **Bridge role** | Highway node — bridge runs its own `axona-peer` instance with server-class settings (`maxConnections: 256`, `highwayPct: 100`). | The bridge is already always-on infrastructure; making it a DHT participant gives every new peer a guaranteed-live, well-connected sponsor and an explicit transit hub that keeps long-haul latency down without changing the protocol. |
| **Code sharing** | Published npm package `@axona/protocol`. Pure-JS modules with zero non-protocol dependencies. | Two-source-of-truth via file copy is a maintenance trap. A submodule works but tools (lint, types, tests) need to be wired in three places. An npm package gives one source, versioned releases, and clean `package.json` dependency lines in both consumers. |
| **Rollout shape** | Hard cutover. The Phase 3 peer version is wire-incompatible with Phase 2; old peers see a "please reload to upgrade" message and drop. | The Phase 2 wire is a 5-message debugging protocol, not a substrate worth preserving. Carrying it as a backward-compat parallel path inside the Phase 3 peer would double the surface area of every code review for months. A clean break is cheaper. |
| **Plan location** | `documents/implementation/` in `dht-sim`. | The canonical reference docs (whitepaper, paper, architecture) live in `dht-sim`. The integration plan reads against them, so it lives next to them. |

---

## 2. The shared package — `@axona/protocol`

Extract from `dht-sim` into a new npm package, published to the public registry as `@axona/protocol`. The package contains nothing that touches a real network or a simulator engine — only the protocol kernel and the contract surfaces.

### 2.1 What goes in

| Path (in the new package) | Origin in `dht-sim` |
|---|---|
| `contracts/DHT.js` | `src/contracts/DHT.js` |
| `contracts/Transport.js` | `src/contracts/Transport.js` |
| `contracts/BootstrapService.js` | `src/contracts/BootstrapService.js` |
| `contracts/types.js` | `src/contracts/types.js` |
| `contracts/index.js` | `src/contracts/index.js` |
| `dht/NeuromorphicDHTNH1.js` | `src/dht/neuromorphic/NeuromorphicDHTNH1.js` |
| `dht/NeuronNode.js` | (existing helper) |
| `dht/Synapse.js` | (existing helper) |
| `pubsub/AxonManager.js` | `src/pubsub/AxonManager.js` |
| `pubsub/AxonPubSub.js` | `src/pubsub/AxonPubSub.js` |
| `pubsub/post.js` | `src/pubsub/post.js` |
| `util/s2.js` | S2 prefix helpers if separable |
| `util/xor.js` | XOR distance + stratum math |

### 2.2 What stays out

- `SimulatedNetwork`, `SimulatedTransport`, `SimulatorBootstrapService` — simulator-only.
- `Engine`, `BenchmarkSweep`, `Globe`, `main.js` — simulator orchestration and UI.
- `server.js`, `index.html` — simulator's local dev server.
- Everything that imports `nodeMap`, the globe, or the benchmark harness.

The boundary is mechanical: if a file depends on `SimulatedNetwork` or the simulator's Engine, it stays in `dht-sim`. If it only depends on `contracts/*` and on other `@axona/protocol` files, it moves.

### 2.3 Package shape

```
@axona/protocol/
├── package.json          # "type": "module", exports: contracts, dht, pubsub
├── README.md             # one-page README pointing at dht-sim docs
├── src/
│   ├── contracts/...
│   ├── dht/...
│   ├── pubsub/...
│   └── util/...
├── test/
│   ├── nh1-smoke.js      # ported from dht-sim's NH-1 test
│   ├── pubsub-delivery.js
│   └── pubsub-cascade.js
└── CHANGELOG.md
```

ES modules, no transpile step, Node ≥ 20 and modern browsers. Tests run under Node's built-in test runner (zero deps). `@axona/protocol@1.0.0` is the first release after extraction; it ships at the same time as Phase 3 peer/bridge.

### 2.4 The migration mechanics

1. Create `axona-net/axona-protocol` repo.
2. `git filter-repo` the listed files out of `dht-sim` into the new repo, preserving history.
3. Publish `@axona/protocol@1.0.0-beta.0` to npm.
4. In `dht-sim`, replace the moved files with `import { ... } from '@axona/protocol/...'`. The simulator-only files (`SimulatedTransport`, `Engine`, etc.) are unchanged — they consume the contracts the same way the production peer will.
5. Run the existing 25K-node parity-gate benchmark. The numbers must not move. If they do, the extraction got something wrong.
6. After two release cycles with no fixes needed, bump `@axona/protocol@1.0.0`.

The parity-gate step is non-negotiable. The reason the protocol code is portable is that nothing in it touches the simulator's god's-eye state; the extraction is a renamer, not a rewriter. If the benchmark drifts, we found a hidden dependency.

---

## 3. The Phase 3 wire protocol

The Transport contract specifies eight verbs (`start`, `stop`, `getLocalNodeId`, `openConnection`, `closeConnection`, `isConnected`, `send`, `notify`, `onRequest`, `onNotification`, `onPeerDied`, `getLatency`). The Phase 3 wire is what `send` and `notify` look like as bytes on a WebRTC `RTCDataChannel`.

### 3.1 Frame shape

Every message on a Phase 3 data channel is a single JSON object, one per `dataChannel.send()` call. Three frame types:

```js
// Request (expects a response):
{ k: 'req', id: <uint32>, type: '<message-type>', payload: <opaque> }

// Response to a request:
{ k: 'res', id: <uint32>, ok: <bool>, payload: <opaque> }

// One-way notification:
{ k: 'ntf', type: '<message-type>', payload: <opaque> }
```

`id` is a per-channel monotonic counter assigned by the sender. The receiver does **not** infer a request from absence of `id`; the `k` discriminator carries that.

### 3.2 Message types (initial set)

Inherited directly from the simulator-side handlers — the only thing changing is the carrier:

| Type | Frame | Used by |
|---|---|---|
| `lookup_step` | `req` | NH-1 routing chain |
| `lookahead_probe` | `req` | NH-1 two-hop AP scoring |
| `find_closest_set` | `req` | NH-1 stratified bootstrap, anneal candidate gathering |
| `local_probe` | `req` | NH-1 dead-synapse eviction, lateral spread |
| `sample_synaptome` | `req` | NH-1 anneal local-probe restructured form |
| `reinforce` | `ntf` | NH-1 LTP side-effect |
| `hop_cache` | `ntf` | NH-1 hop-caching side-effect |
| `lateral_spread` | `ntf` | NH-1 lateral-spread side-effect |
| `triadic_introduce` | `ntf` | NH-1 triadic-closure side-effect |
| `route_msg` | `req` | AxonManager pub/sub routing |
| `direct_pubsub:publish-k` | `ntf` | AxonManager direct delivery |
| `direct_pubsub:deliver` | `ntf` | AxonManager fan-out |
| `direct_pubsub:pullResp` | `ntf` | AxonPubSub pull response |
| `direct_pubsub:metricsResp` | `ntf` | AxonPubSub metrics response |
| `pubsub:pullReq` | `req` (routed) | AxonPubSub pull |
| `pubsub:metricsReq` | `req` (routed) | AxonPubSub metrics |
| `pubsub:reshareNotify` | `ntf` (routed) | AxonPubSub reshare |
| `pubsub:metricsBroadcast` | `ntf` (routed) | AxonPubSub multi-relay metrics |
| `ping` | `req` | Transport heartbeat (1 Hz) |

The `ping` frame replaces the Phase 2 application-level ping with a Transport-owned one; latency from this drives `Transport.getLatency()` for AP scoring. Application-level pings disappear in Phase 3.

### 3.3 Versioning

Every WebRTC connection negotiates a protocol version as the first exchange after the data channel opens. Format:

```
peer → peer: { k: 'hello', proto: 'axona/3', peerVersion: '1.0.0', nodeId: '<hex>' }
peer → peer: { k: 'hello-ack', proto: 'axona/3', peerVersion: '1.0.0', nodeId: '<hex>' }
```

If either side advertises a different `proto` than `'axona/3'`, both close the channel with code `4001` ("protocol-version mismatch") and surface a UI message. Hard cutover lives here: a Phase 2 peer never sends `hello`, so the Phase 3 peer times out the handshake (5 s) and closes with code `4002` ("legacy peer detected — please reload").

---

## 4. `axona-peer` Phase 3

Three changes to the existing peer. Each is independent; each can be reviewed and merged separately; the integration is the last one.

### 4.1 `WebRTCTransport` (new file, ~400 LOC)

A class that implements `Transport` from `@axona/protocol/contracts`. Wraps the existing `MeshManager` from `mesh.js`. Mapping:

| Transport method | Implementation on top of MeshManager |
|---|---|
| `start(localNodeId)` | Initialize internal `Map<peerId, channel>`, register `MeshManager` event listeners. |
| `stop()` | `MeshManager.stopAll()`, clear handler maps. |
| `getLocalNodeId()` | Return the `localNodeId` passed at start. |
| `openConnection(peerId)` | If we already have a `MeshManager.connections.get(peerId)` with an open data channel, resolve `true` immediately. Otherwise call `MeshManager.initiate(peerId)`; resolve `true` on `dc-open`, `false` on `pc-failed` / `pc-closed` / refuse. |
| `closeConnection(peerId)` | `MeshManager.close(peerId)` — closes pc + dc cleanly. |
| `isConnected(peerId)` | `MeshManager.connections.get(peerId)?.dc?.readyState === 'open'`. |
| `send(peerId, type, payload)` | Construct `{k:'req',id,type,payload}`, write to dc, return Promise resolved by the matching `{k:'res',id}`. 5-second timeout → reject. |
| `notify(peerId, type, payload)` | Construct `{k:'ntf',type,payload}`, write to dc. Returns void. |
| `onRequest(type, handler)` | Register `type` → handler in `this._reqHandlers`. Incoming `{k:'req'}` frames dispatch here; the return value becomes the `{k:'res'}` payload. |
| `onNotification(type, handler)` | Register `type` → handler in `this._ntfHandlers`. Incoming `{k:'ntf'}` frames dispatch here; return value ignored. |
| `onPeerDied(handler)` | Forward `MeshManager`'s `peer-failed` / `peer-closed` / heartbeat-timeout events. |
| `getLatency(peerId)` | EWMA of the last 10 `ping` round-trips on this channel. Initialize to `-1` until first pong arrives. |

The `MeshManager`'s existing 1 Hz application ping is **removed**; the Transport's 1 Hz `ping` request takes over. This is the one behavior change to existing mesh code.

### 4.2 The bilateral cap

The Transport contract specifies that `openConnection` returns `false` if the remote refused. This is the synaptome cap admission. Implementation:

- Each peer carries a configurable `maxConnections` (default 50 in browser, 256 on bridge).
- When a peer-joined event triggers `MeshManager.initiate(peerId)`, the receiver's `WebRTCTransport.onRequest('handshake-accept', ...)` checks if its current connection count is below cap. If yes, accept; if no, refuse with `{ ok: false, reason: 'cap-exceeded' }`.
- The initiator sees `openConnection` resolve `false` and proceeds with the next candidate from its synaptome-admission queue.

The cap is enforced on **incoming** acceptance, not outgoing initiation, because that's where the receiver knows its real-time state. The protocol layer never sees the cap directly — it just sees `openConnection` succeed or fail.

### 4.3 The synaptome-mesh transition

The current `mesh.js` opens an `RTCPeerConnection` to **every** peer the bridge announces. This must change. New behavior:

- On Phase 3 startup, the peer opens **one** connection — to the bridge — and uses it as the bootstrap sponsor.
- NH-1's `join(sponsor)` then drives the synaptome fill via stratified bootstrap. Each new candidate that NH-1 wants in its synaptome triggers `Transport.openConnection(candidateId)`, which in turn calls `MeshManager.initiate(candidateId)` for the WebRTC handshake.
- When NH-1 evicts a synapse, `Transport.closeConnection(peerId)` tears the WebRTC connection down.
- The full-mesh announce path (`peer-list`, `peer-joined`) is still useful as *discovery* but no longer as *connection trigger*. The Phase 3 peer treats those announcements as candidate IDs to consider, not as commands to open.

This is the largest behavior change in the peer, because the entire mesh-management state machine flips polarity. The Phase 3 peer is **synaptome-driven**, not announce-driven.

### 4.4 DHT instantiation

`client.js` becomes:

```js
import { NeuromorphicDHTNH1, AxonPubSub } from '@axona/protocol';
import { WebRTCTransport } from './transport.js';
import { BridgeBootstrap }  from './bootstrap.js';

const nodeId = await deriveNodeId();          // S2 prefix + pubkey hash
const transport = new WebRTCTransport({ meshManager });
const bootstrap = new BridgeBootstrap({ bridgeUrl });
const dht = new NeuromorphicDHTNH1({ nodeId, transport, maxConnections: 50 });
const pubsub = new AxonPubSub({ axon: dht.axonManager });

await dht.start();
await dht.join({ kind: 'rendezvous', url: bridgeUrl, manifestSig: '...' });
// dht is now operational; the UI subscribes to dht.onEvent(...) for telemetry.
```

The UI (peer table, indicator lights, peer count) reads from `dht.getMetrics()` and `dht.onEvent()` instead of `meshManager.connections` directly. The bridge stays the first row in the peer table; the other rows are synaptome entries, not the full announce-list.

### 4.5 What stays unchanged

- The bridge connection (`client.js` WebSocket plumbing) is unchanged in its plumbing — it just carries different message types (`hello` instead of `ping`) and stops being the source of truth for UI peer rows.
- The QR-code flow is unchanged in concept; the QR payload becomes a `BootstrapEndpoint` (kind: 'qr') JSON object that another peer can hand to its `BootstrapService`.
- The UI shell (indicator colors, RTT display, log panel) is unchanged.

---

## 5. `axona-bridge` Phase 3

The bridge gets one new responsibility: **be a DHT participant**. The signaling-broker role and the TURN-credential-minting role both continue.

### 5.1 The embedded peer

The bridge process starts a Node-side instance of `@axona/protocol`'s `NeuromorphicDHTNH1` with:

- `maxConnections: 256` (server-class)
- `highwayPct: 100` (marks this node explicitly as a transit hub)
- A persistent node-ID — generated once at first boot, persisted to disk, reloaded on every restart. This means the bridge has a stable identity in the DHT across restarts, which is what we want.
- A `WebRTCTransport` running on `node-webrtc` (the npm package providing the WebRTC API to Node.js).
- Bootstrap via a `simulator`-kind endpoint pointing at itself (the bridge is its own sponsor on first boot — bootstrapping itself out of nothing).

The embedded peer runs in the same process as the WebSocket server, sharing the event loop. Both subsystems write to the same structured log.

### 5.2 The bootstrap interaction

When a new browser peer connects over WebSocket:

1. Bridge sends `welcome` (existing Phase 2 behavior), now including `nodeId: <bridge's-DHT-nodeId>` and `proto: 'axona/3'`.
2. Bridge sends `bootstrap-offer` (new): `{ sponsorId: <bridge's-nodeId>, sdpOffer: <SDP-for-its-own-DHT-channel> }`. The browser peer creates an answer and signals back.
3. The new browser peer now has a WebRTC channel to the bridge's DHT peer. It treats that channel as the bootstrap sponsor for `dht.join(...)`.
4. `dht.join()` runs a self-lookup through the bridge, which returns synaptome candidates near the new peer's ID. The new peer opens WebRTC channels to those candidates via the same signaling path (`peer-list` discovery → `signal` relay → channel open).
5. After bootstrap completes, the new peer's synaptome is full and may or may not still contain the bridge. If it does, the bridge stays in the mesh as a transit hub. If it doesn't (the new peer's geography put farther-away peers higher in vitality), the bridge is evicted via `Transport.closeConnection` and the channel closes.

The signaling broker role continues unchanged — it relays `signal` payloads between any two peers that want to handshake — but it's no longer the only way to discover peers. The DHT's `find_closest_set` and `sample_synaptome` queries surface peers the bridge has never personally seen.

### 5.3 Highway-node behavior

Because the bridge runs with `maxConnections: 256`, its synaptome can hold ~5× a browser peer's. Effects:

- The bridge will tend to be a high-vitality candidate for geographic-prefix neighbors — its weight stays high through traffic, and its high capacity means it doesn't churn out as easily.
- Long-haul lookups frequently land at the bridge as an intermediate hop, which is exactly the right behavior for a highway node.
- Pub/sub axonal trees often root at the bridge for popular topics whose `hash(topic)` falls geographically near it.

This is by design and matches the simulator's `highwayPct` ablation in §6.11 of the whitepaper. The single bridge is a special case; a federated bridge mesh (Q4 2026) replaces this with N independent highway nodes that all play the same role.

### 5.4 What stays unchanged

- The WebSocket signaling protocol — Phase 2 wire — is unchanged. Existing client/bridge signaling messages (`welcome`, `peer-list`, `peer-joined`, `peer-left`, `signal`) keep flowing; new message types (`bootstrap-offer`, `bootstrap-answer`) ride alongside.
- The TURN credential minting is unchanged.
- The `healthz` endpoint is unchanged in shape but now also reports `dhtNodeId`, `dhtSynaptomeSize`, `dhtConnections`.

---

## 6. Work breakdown

Six tracks. Each can land independently against `main` in the relevant repo, with the integration step at the end coordinating them.

| Track | Repo | Approx. effort | Notes |
|---|---|---|---|
| **T1** Extract `@axona/protocol` | new repo + `dht-sim` | 2 days | Mechanical extraction + parity-gate. |
| **T2** Wire protocol formalization | `@axona/protocol/docs/wire.md` | 1 day | The §3 spec as a single doc in the new repo. |
| **T3** `WebRTCTransport` implementation | `axona-peer` | 4 days | New file + tests. Independent of T4. |
| **T4** Synaptome-mesh transition in `mesh.js` | `axona-peer` | 3 days | The mesh.js polarity flip. Builds on T3. |
| **T5** Bridge embedded peer | `axona-bridge` | 4 days | `node-webrtc` integration, persistent nodeId, bootstrap-offer flow. |
| **T6** End-to-end integration | all three repos | 3 days | First successful browser-browser DHT lookup over real WebRTC via the bridge. |

Total: ≈17 engineer-days of focused work, calendar-time TBD.

The non-linear dependency: T6 needs T1 + T3 + T4 + T5. T2 is the spec everyone reads. T1 unblocks T3 (no shared package = no `import { Transport }` in the peer). T3 unblocks T4 (the synaptome-mesh transition presumes the Transport surface exists). T5 can proceed in parallel once T1 publishes a usable `@axona/protocol@1.0.0-beta.0`.

---

## 7. Milestones

| Milestone | Definition | Verifies |
|---|---|---|
| **M1 — Package live** | `@axona/protocol@1.0.0-beta.0` published; `dht-sim` consumes it; parity-gate within 0%. | T1 |
| **M2 — Wire spec frozen** | `docs/wire.md` in `@axona/protocol`; reviewed by both peer and bridge engineers. | T2 |
| **M3 — Transport conformance** | `WebRTCTransport` passes the Transport conformance test (peer ↔ peer in two browser tabs, all twelve methods exercised). | T3 |
| **M4 — Synaptome-driven mesh** | A single browser peer connects to the bridge, runs `dht.join()`, and ends up with a synaptome whose membership is driven by NH-1 vitality, not by bridge announce-list. | T3 + T4 |
| **M5 — Bridge as DHT node** | Bridge `healthz` reports `dhtNodeId` and a non-empty `dhtSynaptomeSize`. A second peer connects through the bridge and the bridge's synaptome shows the second peer as a member. | T5 |
| **M6 — First real lookup** | Two browser peers, both joined via the bridge. Peer A issues `dht.lookup(someKey)` and the routing chain traverses real WebRTC hops, producing a `LookupResult` with hops ≥ 2. | T6 |
| **M7 — Pub/sub cascade** | The 2001-node `test_pubsub_cascade.js` test ported to a multi-browser test harness (~10 real browsers), counter invariants hold over real WebRTC. | T6 + soak |
| **M8 — Cutover** | Production `axona.net` / `bridge.axona.net` swap to Phase 3 binaries. Phase 2 peers see the protocol-mismatch banner and reload. | Production deployment |

M1 through M6 are engineering milestones. M7 is the field-validation step that establishes that the simulator numbers hold over real WebRTC. M8 is the operational cutover.

---

## 8. Risks and open questions

### 8.1 Risks

- **`node-webrtc` stability.** The bridge's embedded peer uses the `node-webrtc` npm package to expose the WebRTC API in Node.js. The package is not as well-maintained as browser WebRTC; it has rough edges around `RTCDataChannel` close semantics and ICE restart. We may need to fall back to a `wrtc` fork or a Rust binding (`webrtc-rs` via napi) if blockers appear.
- **Synaptome cap admission timing.** The Transport contract specifies that `openConnection` returns `false` if the remote refused, with the cap enforced inside the transport. In practice the cap check happens after SDP negotiation completes, which costs 1–3 seconds of handshake. If many peers race to admit a new arrival simultaneously, several will see `false` after paying the handshake cost. Mitigation: pre-admission signal — the initiator sends a lightweight `handshake-intent` first; receiver replies with cap status before the SDP exchange begins. Adds one round-trip but skips wasted handshakes.
- **Browser-tab WebRTC connection limits in production.** Chrome and Safari both cap simultaneous `RTCPeerConnection` count at ~500, but the practical cap with `RTCDataChannel` traffic open is closer to 95 on Safari. The `maxConnections: 50` default for browser peers is below this, but adversarial peers could try to force a browser past the cap. Mitigation: server-side connection-count tracking in the bridge's TURN-credential issuance — refuse credentials to a peer with too many concurrent connections.
- **Bridge as single point of bootstrap dependency.** Phase 3 has one bridge. If it goes down, no new peers can join (existing peers stay connected directly). Mitigation: federated bridge mesh (Q4 2026 roadmap item) where every bridge runs an `axona-peer` and they all peer with each other. New peers can connect to any bridge.

### 8.2 Open questions

- **Persistent peer identity.** Should browser peers persist their node-ID across sessions (localStorage), or generate fresh every load? Persistent gives stable identity (useful for reputation) but ties a key to a device; fresh gives easy anonymity but every reload is a "new" peer to the DHT. **Recommendation: persistent by default with a one-click "rotate identity" affordance**, but this is a UX-product choice as much as engineering.
- **QR-code bootstrap variant.** The contract supports `{ kind: 'qr', sponsorAddr: '...' }`. Does the QR payload encode a WebRTC offer directly (peer-to-peer pairing, no bridge needed), or does it encode a sponsor peer-ID that the receiver looks up via the bridge? **Recommendation: WebRTC offer in the QR.** That's what makes it true peer-to-peer pairing; relying on the bridge would defeat the purpose.
- **Replay-cache + pub/sub semantics across real-world latency.** AxonManager's replay cache is sized for the simulator's instant-RTT environment. Real WebRTC RTT will shift the deduplication window. Need a measurement pass during M7.
- **TURN traffic accounting.** When two peers can't establish a direct WebRTC channel (symmetric NAT), they relay through TURN. TURN bandwidth costs money; the bridge currently mints credentials for everyone. Do we account per-peer? Do we cap? Out of scope for Phase 3 but flagged for Q4.

---

## 9. What this plan does **not** cover

- **Production identity.** Ed25519 key generation, persistence, and signature verification on every message. The simulator uses stub signatures; production needs real ones. Tracked separately in the Q1 2027 hybrid-PQ identity work.
- **Application-level features.** The peer UI today is a debug surface. Application UIs (civildefense.io, future agent SDKs) build on top of the DHT contract via `subscribe` / `publish` / `pull` / `reshare`. Their build is out of scope.
- **Operational dashboards.** The simulator emits `cycle-snapshot` events; production peers should surface analogous metrics to operator dashboards. Architecture is in place via `onEvent`; the dashboards themselves are a separate workstream.
- **Adversarial hardening.** Sybil resistance, Byzantine pub/sub, proof-of-location. The whitepaper §16 covers the future-work agenda; Phase 3 is the cooperative-trust deployment, with adversarial work scheduled Q1 2027.

---

## 10. The shape of the deliverable

After Phase 3 cutover, the system looks like:

```
                    ┌──────────────────────────────────────┐
                    │   Application (civildefense, agent   │
                    │   SDK, social feed, …)               │
                    └────────────────┬─────────────────────┘
                                     │  @axona/protocol DHT contract
                                     │  (publish / subscribe / pull /
                                     │   reshare / metrics / lookup)
                    ┌────────────────▼─────────────────────┐
                    │   @axona/protocol                    │
                    │   NeuromorphicDHTNH1 + AxonManager + │
                    │   AxonPubSub                         │
                    └────────────────┬─────────────────────┘
                                     │  @axona/protocol Transport contract
                                     │  (openConnection / send / notify /
                                     │   onPeerDied / getLatency / …)
                    ┌────────────────▼─────────────────────┐
                    │   axona-peer (browser)               │
                    │   WebRTCTransport on MeshManager     │
                    │     - 1 Hz ping/pong                 │
                    │     - 50-connection cap              │
                    │     - synaptome-driven open/close    │
                    └────────────────┬─────────────────────┘
                                     │  WebRTC data channels + ICE
                                     │  signaling via axona-bridge
                    ┌────────────────▼─────────────────────┐
                    │   axona-bridge                       │
                    │   ┌──────────────────────────────┐  │
                    │   │ WebSocket signaling broker   │  │
                    │   └──────────────────────────────┘  │
                    │   ┌──────────────────────────────┐  │
                    │   │ Embedded axona-peer          │  │
                    │   │   - maxConnections: 256      │  │
                    │   │   - highwayPct: 100          │  │
                    │   │   - persistent node-ID       │  │
                    │   └──────────────────────────────┘  │
                    │   ┌──────────────────────────────┐  │
                    │   │ TURN credential mint         │  │
                    │   └──────────────────────────────┘  │
                    └──────────────────────────────────────┘
```

`dht-sim` continues to run as the research artifact, consuming the same `@axona/protocol` package the peer does. Numbers measured in the sim transfer to production because both sides of the integration depend on identical kernel code.

---

## 11. Appendix — file-by-file impact

| Repo / file | Phase 2 state | Phase 3 state |
|---|---|---|
| `@axona/protocol/*` | does not exist | new repo, npm-published kernel |
| `dht-sim/src/dht/neuromorphic/NeuromorphicDHTNH1.js` | 2133 LOC, canonical | moved to `@axona/protocol/dht/`; `dht-sim` re-imports |
| `dht-sim/src/pubsub/AxonManager.js` | canonical | moved to `@axona/protocol/pubsub/`; re-imported |
| `dht-sim/src/pubsub/AxonPubSub.js` | canonical | moved to `@axona/protocol/pubsub/`; re-imported |
| `dht-sim/src/contracts/*` | canonical | moved to `@axona/protocol/contracts/`; re-imported |
| `dht-sim/src/dht/SimulatedTransport.js` | unchanged | unchanged — implements `Transport` from `@axona/protocol/contracts` |
| `dht-sim/src/dht/SimulatorBootstrapService.js` | unchanged | unchanged |
| `dht-sim/src/main.js`, `Engine`, sim UI | unchanged | unchanged |
| `axona-peer/index.html` | UI shell | mostly unchanged; peer-table now reads from `dht.onEvent` |
| `axona-peer/src/client.js` | 672 LOC bridge-WS + UI | instantiates `WebRTCTransport`, `NeuromorphicDHTNH1`, `AxonPubSub` |
| `axona-peer/src/mesh.js` | 617 LOC full-mesh WebRTC manager | synaptome-driven; `initiate` is called by Transport, not by announce-list |
| `axona-peer/src/transport.js` | does not exist | new — `WebRTCTransport` implementation |
| `axona-peer/src/bootstrap.js` | does not exist | new — `BridgeBootstrap` (rendezvous variant of `BootstrapService`) |
| `axona-peer/src/qr.js` | unchanged | extended to emit `{kind:'qr',sponsorAddr}` BootstrapEndpoint payload |
| `axona-bridge/src/server.js` | 405 LOC signaling + TURN | + embedded `axona-peer` instance, `bootstrap-offer` flow, `healthz` extension |
| `axona-bridge/src/dht-node.js` | does not exist | new — embedded peer using `@axona/protocol` + `node-webrtc` |
| `axona-bridge/src/persistent-id.js` | does not exist | new — node-ID generation + disk persistence |

---

*End of plan. This document expects revision as engineering work surfaces details the design did not anticipate. The first revision will land at the M2 milestone after the wire-spec review.*
