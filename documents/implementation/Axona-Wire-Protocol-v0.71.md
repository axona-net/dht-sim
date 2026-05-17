# Axona Wire Protocol

## Phase 3 specification for `axona-peer` ↔ `axona-bridge`

**Document version:** v0.71.1 (initial draft)
**Companion to:** `Axona-Integration-Plan-v0.3.51.md`, `N-DHT-Architecture.md`
**Author:** David A. Smith — YZ.social
**Date:** 2026-05-17
**Status:** locked-in for the production peer/bridge integration. Subsequent revisions update version field.

---

## 0. Design principles

Two rules govern the entire surface below. Everything else is mechanical.

1. **The interface between the protocol layer and the transport layer is identical across all production protocols.** Every protocol in the set — NH-1, NX-17, K-DHT, G-DHT — calls exactly the same 12 methods on `Transport`, with exactly the same signatures, and exactly the same semantics. No protocol-specific transport extensions exist. The message *types* a protocol registers vary (an NH-1 peer issues `lookup_step`, a K-DHT peer issues `FIND_NODE`), but the *envelope* and *carrier* are uniform.

2. **The DHT-contract surface a protocol exposes upward is identical across the set.** Every protocol implements the same `start`, `stop`, `lookup`, `publish`, `subscribe`, `unsubscribe`, `getNodeId`, `getSynaptome`, `getMetrics`, `onEvent` methods with identical signatures. Protocols whose algorithm doesn't natively support a verb (K-DHT and G-DHT have no native pub/sub) expose stubs that surface a documented `not-supported` error rather than diverging the interface.

The wire format below carries the bytes between two peers running these protocols. The bytes are protocol-neutral — the wire doesn't know whether the bytes inside an `lookup_step` payload were emitted by NH-1, NX-17, or some future variant.

---

## 1. The Transport contract — uniform across all protocols

Defined in `src/contracts/Transport.js`. One Transport instance per running peer. The protocol layer calls into it.

```
Transport.start(localNodeId)         → Promise<void>
Transport.stop()                     → Promise<void>
Transport.getLocalNodeId()           → bigint

Transport.openConnection(peerId)     → Promise<boolean>   (false = remote refused / unreachable)
Transport.closeConnection(peerId)    → Promise<void>
Transport.isConnected(peerId)        → boolean

Transport.send(peerId, type, body)   → Promise<any>       (request → response)
Transport.notify(peerId, type, body) → Promise<void>      (one-way)
Transport.onRequest(type, handler)   → void
Transport.onNotification(type, handler) → void

Transport.onPeerDied(handler)        → unsubscribe()
Transport.getLatency(peerId)         → number             (ms RTT; -1 if unknown)
```

**Conformance rules — protocol code MUST:**
- Never reach around Transport to read remote-peer state. No `nodeMap.get(peerId)` analog in the deployed peer.
- Treat every cross-peer interaction as async. The handler at the other end is not in the same event loop.
- Consume `getLatency(peerId)` for AP scoring and latency accounting rather than computing latency itself.
- Subscribe to `onPeerDied` for liveness; populate a local `_deadPeers` Set; filter candidate enumerations against it.

**Conformance rules — Transport implementations MUST:**
- Maintain persistent channels — channel setup happens once per peer on `openConnection`, not per message.
- Run a 1 Hz `ping` request on every open channel; respond with `'pong'`. Expose the RTT EWMA via `getLatency`.
- Emit `onPeerDied` on heartbeat timeout (default 3 seconds of missed pongs).
- Enforce bilateral cap semantics: `openConnection(peerId)` resolves `false` if the remote refused (cap reached), allowing the protocol to fall through to the next candidate.
- Survive `stop()` / `start()` cycles cleanly.

---

## 2. Channel envelope

Every byte that flows on an `axona-peer` ↔ `axona-peer` data channel is a single JSON object, one per `dataChannel.send()` call. Three frame kinds:

### 2.1 Request — expects a response

```json
{
  "k":   "req",
  "id":  123,
  "type": "lookup_step",
  "body": { /* type-specific payload */ }
}
```

- `id` is a per-channel monotonic counter assigned by the sender.
- `type` selects a handler registered via `Transport.onRequest(type, handler)`.
- The receiver replies with a matching `res` frame carrying the same `id`.
- If the handler throws, the response carries `ok: false` and an error string. The protocol layer treats this the same as a network timeout — the request `Promise` rejects.

### 2.2 Response — reply to a request

```json
{
  "k":   "res",
  "id":  123,
  "ok":  true,
  "body": { /* handler return value */ }
}
```

- On success: `ok: true`, `body` carries the handler's return value (JSON-serialized).
- On failure: `ok: false`, `body` is `{ error: "<message>" }`.
- Responses without a matching outstanding request are dropped.

### 2.3 Notification — one-way, no response

```json
{
  "k":    "ntf",
  "type": "reinforce",
  "body": { /* type-specific payload */ }
}
```

- No `id` field. The receiver invokes its `onNotification(type, handler)` callback. Return value (if any) is ignored.
- A notification to a peer that disappeared mid-flight is silently dropped at both ends. Liveness is not signaled by notification failure.

### 2.4 Heartbeat — Transport-owned

```json
// Request (every 1 second)
{ "k": "req", "id": <n>, "type": "ping", "body": { "t": <epoch-ms> } }

// Response
{ "k": "res", "id": <n>, "ok": true, "body": { "t": <echoed>, "tServer": <epoch-ms> } }
```

The 1 Hz `ping` is the only message type the Transport itself originates. Application protocols use this round-trip's RTT (exposed via `getLatency`) for AP scoring. If three consecutive `ping` requests time out, the Transport closes the channel and fires `onPeerDied(peerId)`.

### 2.5 BigInt encoding

JSON has no BigInt. The wire encoding of a 64-bit node id (BigInt) is a **hex string** of exactly 16 lowercase hex characters with no `0x` prefix:

```
0n               →  "0000000000000000"
0xCAFE...n       →  "cafe000000000000"
```

Sender serializes BigInt → hex before `JSON.stringify`. Receiver re-hydrates hex → BigInt before invoking the handler. The library `BigInt('0x' + hex)` does the reverse. This is a pure wire concern; protocol code reads `payload.peerId` as a BigInt unchanged.

### 2.6 Maximum frame size

The wire enforces a 64 KiB maximum frame size per `dataChannel.send`. Payloads exceeding this MUST be split across multiple notifications with a continuation marker (out of scope for the initial integration; no current message type approaches this limit). The bridge's signaling broker enforces the same 64 KiB cap on relayed `signal` payloads.

---

## 3. Version handshake

Every WebRTC connection negotiates a protocol version as the first exchange after the data channel opens. This is what enforces the **hard cutover** between Phase 2 (signaling-only) and Phase 3 (full Axona protocol).

### 3.1 Sequence

After the data channel `onopen` event fires on both sides, each side immediately sends a `hello` notification, then waits for the peer's `hello-ack`. The exchange completes when both sides have seen each other's `hello-ack`.

```
Peer A → Peer B   { k: "ntf", type: "hello",
                     body: { proto: "axona/3", peerVersion: "1.0.0", nodeId: "<hex>" } }
Peer B → Peer A   { k: "ntf", type: "hello-ack",
                     body: { proto: "axona/3", peerVersion: "1.0.0", nodeId: "<hex>" } }
```

### 3.2 Mismatch behavior

If either side advertises a different `proto` than `"axona/3"`:
- Both close the data channel with WebSocket close code `4001` and reason `"protocol-version mismatch"`.
- The local UI surfaces a "peer running incompatible protocol" message.
- The bilateral connection cap slot is released.

If the version-handshake notification times out after 5 seconds:
- The Phase 2-style peer never sent `hello` (older release).
- Close with code `4002` and reason `"legacy peer detected — please reload"`.

The hard cutover lives entirely in this handshake. No backward-compat path runs on the Phase 3 peer.

### 3.3 `peerVersion` field

The `peerVersion` field reports the build version of the peer software (e.g. `"1.0.0"`). It MUST NOT gate protocol decisions in the initial release — semver-style negotiation is reserved for future variants.

---

## 4. Message types — NH-1 and NX-17

NH-1 and NX-17 share the wire vocabulary (NX-17 is a subclass of NH-1, registers exactly the same handler set). All requests are routed through `Transport.send`; all notifications through `Transport.notify`.

### 4.1 Routing primitives (request)

| Type | Payload | Response |
|---|---|---|
| `lookup_step` | `{ sourceId, targetKey, hops, path, trace, queried, totalTimeMs }` | `LookupResult` — see §4.1.1 |
| `lookahead_probe` | `{ target, fromDist }` | `{ peerId, latency, terminal }` — see §4.1.2 |
| `find_closest_set` | `{ target, K }` | `[peerId, peerId, ...]` (length ≤ K) |
| `local_probe` | `{}` | `[peerId, peerId, ...]` (receiver's synaptome member ids, excluding caller) |
| `route_msg` | `{ type, payload, targetId, hops, originId }` | `RouteResult` — see §4.1.3 |

#### 4.1.1 `LookupResult` shape

```
{
  found:        boolean      // true if target was reached
  terminal:     boolean      // true if no candidate makes XOR progress and fallback failed
  exhausted:    boolean      // true if MAX_HOPS reached without termination
  hops:         number       // path.length - 1
  path:         [bigint]     // node ids traversed, sender first
  trace:        [{ fromId, synapse }]  // per-hop diagnostic record
  totalTimeMs:  number       // cumulative observed latency
}
```

Exactly one of `found`, `terminal`, `exhausted` is `true` on any returned result.

#### 4.1.2 `lookahead_probe` semantics

The two-hop AP scoring primitive. Receiver scans its own synaptome for entries whose XOR distance to `target` is strictly less than `fromDist`. If any qualify, returns the best by AP (action-potential) scoring. If none, returns `terminal: true`.

Used by `_bestByTwoHopAP` in parallel across `LOOKAHEAD_ALPHA` candidates per routing decision.

#### 4.1.3 `RouteResult` shape

```
{
  consumed:   boolean       // true if a local handler accepted the message at `atNode`
  atNode:     bigint        // the node that terminated the routed walk
  hops:       number        // number of hops to reach atNode
  terminal?:  boolean       // true if walk terminated by no-XOR-progress + 2-hop-failed fallback
  exhausted?: boolean       // true if MAX_HOPS reached
}
```

### 4.2 LEARN side-effects (notification)

| Type | Payload | Receiver action |
|---|---|---|
| `reinforce` | `{ synapsePeerId }` | LTP update on the synaptome entry for `synapsePeerId`. Bump `useCount`. |
| `triadic_introduce` | `{ peerId }` | Add a fresh synapse to `peerId` via `_addByVitality` (admission gate applies). |
| `hop_cache` | `{ target, depth }` | Add a hop-cache synapse to `target`. If `depth==0`, also lateral-spread to ≤ `LATERAL_K` geo-neighbours. |
| `lateral_spread` | `{ target, depth: 1 }` | Same handler as `hop_cache` but `depth==1` (no further propagation). |

These are post-lookup events emitted by the source after a successful path. The receiver applies them to its own local synaptome.

### 4.3 Pub/sub primitives

The Axona pub/sub layer consists of routed control plane (subscribe / publish / pull / reshare / metrics requests that walk the DHT toward a topic id) and a direct delivery plane (axonal-tree fan-out via direct notify). Both share the wire vocabulary below.

#### 4.3.1 Routed (carried inside `route_msg`)

The outer envelope is `route_msg` (§4.1). The inner `payload.type` selects one of:

| Inner type | Payload shape | Purpose |
|---|---|---|
| `pubsub:subscribe` | `{ topicId, subscriberId }` | Walk toward `topicId`; first role-bearing relay attaches subscriber. |
| `pubsub:unsubscribe` | `{ topicId, subscriberId }` | Drop the subscriber from whichever axon currently holds them. |
| `pubsub:publish` | `{ topicId, json, postHash?, publisher?, references? }` | Walk to root; fan out through the tree. |
| `pubsub:metricsReq` | `{ topicId, postHashes?, requesterId, requestId }` | Request publisher-only aggregate metrics. |
| `pubsub:pullReq` | `{ topicId, postHash, requesterId, requestId }` | Fetch a specific post by content hash. |
| `pubsub:reshareNotify` | `{ referencedTopicId, referencedPostHash, reshareTopicId, resharePostHash }` | Notify upstream topics of a downstream reshare. |

#### 4.3.2 Direct (Transport-level `notify`)

Each pub/sub direct message is delivered as a `Transport.notify(peerId, 'direct_pubsub:<verb>', payload)`. The receiver's `onNotification` handler is registered by `AxonManager.onDirectMessage(type, h)`, which dispatches based on the per-(node, type) handler table.

| Type | Payload shape | Purpose |
|---|---|---|
| `direct_pubsub:deliver` | `{ topicId, json, publishId, publishTs, postHash?, publisher? }` | Subscriber-facing delivery. |
| `direct_pubsub:promote-axon` | `{ topicId, axonId }` | Promote a child to sub-axon role under hysteresis. |
| `direct_pubsub:adopt-subscribers` | `{ topicId, subscribers, fromAxon }` | Bulk reassignment of subscribers to a new sub-axon. |
| `direct_pubsub:dissolve-hint` | `{ topicId, axonId }` | Soft retirement hint from a parent. |
| `direct_pubsub:replay-batch` | `{ topicId, posts }` | Replay-cache delivery to a newly-attached subscriber. |
| `direct_pubsub:pullResp` | `{ topicId, postHash, post?, requestId }` | Pull response (post or null). |
| `direct_pubsub:metricsResp` | `{ topicId, entries, responderId, requestId }` | Metrics response (per-relay counters). |
| `direct_pubsub:metricsBroadcast` | `{ topicId, postHashes?, requesterId, requestId, ttl }` | Multi-relay metrics fan-out (tree broadcast). |
| `direct_pubsub:subscribe-k` | `{ topicId, subscriberId }` | Direct subscribe (K-closest replication mode; unused when `rootSetSize=0`). |
| `direct_pubsub:publish-k` | `{ topicId, json, publishId, publishTs, postHash?, publisher? }` | Direct publish (K-closest mode; unused when `rootSetSize=0`). |
| `direct_pubsub:unsubscribe-k` | `{ topicId, subscriberId }` | Direct unsubscribe (K-closest mode; unused). |

NX-17 and NH-1 both default to `_membershipOpts.rootSetSize = 0`, which disables the K-closest replication path. The `-k` variants exist for completeness and benchmark ablation.

---

## 5. Message types — K-DHT and G-DHT

K-DHT exposes only routing; it has no native pub/sub. G-DHT inherits K-DHT's wire vocabulary verbatim.

| Type | Payload | Response |
|---|---|---|
| `FIND_NODE` | `{ target, geoKey? }` | `[{ id, s2Cell }, ...]` (length ≤ K) |
| `PING` | `{}` | `"PONG"` |

`geoKey` is an optional 32-bit unsigned integer used in geo-mode lookups; absent in standard XOR-mode. Response descriptors carry `s2Cell` so the requester can compute geo-XOR scores locally — no `nodeMap.get(id)` rehydration on receipt.

**Pub/sub on K-DHT or G-DHT.** Calling `dht.publish` or `dht.subscribe` on a K-DHT or G-DHT instance returns a rejected `Promise` with `{ error: "not-supported", protocol: "kademlia" }`. The DHT contract surface is honored (the methods exist) but the algorithm doesn't support the verb. Applications that need pub/sub must run on NH-1 or NX-17.

---

## 6. Bridge wire format

Phase 2's signaling protocol (described in `axona-bridge/README.md`) is preserved for the WebSocket client ↔ bridge channel; Phase 3 adds two new message types.

### 6.1 Preserved (Phase 2)

| Direction | Type | Payload |
|---|---|---|
| client → bridge | `ping` | `{ t: <client epoch ms> }` |
| bridge → client | `welcome` | `{ connId, serverT, version, turnUri?, turnUser?, turnPass? }` |
| bridge → client | `peer-list` | `{ peers: [<peerId>, ...], serverT }` |
| bridge → client | `pong` | `{ t: <echoed>, serverT }` |
| bridge → client | `peer-joined` (broadcast) | `{ peerId, serverT }` |
| bridge → client | `peer-left` (broadcast) | `{ peerId, serverT }` |
| client → bridge | `signal` | `{ to: <peerId>, payload: <opaque-SDP-or-ICE> }` |
| bridge → client | `signal` | `{ from: <peerId>, payload: <opaque> }` |

### 6.2 Added (Phase 3)

| Direction | Type | Payload | Purpose |
|---|---|---|---|
| bridge → client | `bootstrap-offer` | `{ sponsorId, sdp, version }` | The bridge announces its embedded DHT peer to a newly-connected client. Client treats this as the BootstrapEndpoint sponsor and creates a WebRTC answer. |
| client → bridge | `bootstrap-answer` | `{ sdp }` | Client's answer SDP for the bridge's DHT peer offer. |
| client → bridge | `healthz` | `{}` | Optional client-initiated health check. Bridge replies as a normal `pong` plus DHT-status fields. |

### 6.3 TURN credentials

The bridge embeds HMAC-signed short-lived TURN credentials in `welcome.turnUser` / `welcome.turnPass`. Credentials are valid for 2 hours and scoped to a single `connId`. Peers MUST splice the credentials into the `iceServers` config when creating an `RTCPeerConnection`; reuse across sessions is rejected.

### 6.4 The connection-initiation rule (preserved from Phase 2)

The bridge's `peer-list` / `peer-joined` distinction continues to encode WebRTC initiator/responder role:
- Peers in your `peer-list` → you initiate (offer first).
- Peers in your `peer-joined` event → you wait for their offer (respond).

This rule prevents simultaneous-offer races and is invariant across Phase 2 and Phase 3.

---

## 7. Error semantics

### 7.1 Request handler errors

If a request handler throws (synchronously or async), the receiver MUST return:

```json
{ "k": "res", "id": <n>, "ok": false, "body": { "error": "<message>" } }
```

The caller's `Transport.send(...)` Promise rejects with `new Error(body.error)`. The protocol layer treats this identically to a network timeout — the caller's iterative scan moves to the next candidate.

### 7.2 Request timeout

Default request timeout: **5 seconds**. After timeout, the local Transport rejects the `Promise` with `new Error('timeout')` and does NOT close the channel (the missing pong heartbeat handles that separately).

### 7.3 Notification handler errors

Notifications are fire-and-forget. If a receiver's `onNotification` handler throws, the error is logged locally; the sender never observes it. Notifications NEVER produce wire traffic from receiver to sender beyond what the protocol explicitly arranges.

### 7.4 Bilateral cap refusal

`openConnection(peerId)` resolves with `false` if the remote refused. Refusal scenarios:
- Receiver at synaptome cap (configurable, default 50 for browser peers, 256 for highway bridge).
- Receiver in shutdown / unreachable.
- Initiator failed ICE.

The protocol layer treats `false` as a routing-table admission failure and moves on. The transport MUST NOT retry on its own.

### 7.5 Peer death

`onPeerDied(handler)` fires once per peer when:
- 3 consecutive `ping` heartbeats time out, OR
- `dataChannel.onerror` fires with an unrecoverable error, OR
- `RTCPeerConnection.connectionState` transitions to `failed` or `closed`.

The handler is invoked with the peer's `nodeId` (BigInt). The protocol layer's standard response is to add the id to a `_deadPeers` Set and let routing primitives filter against it on the next decision.

---

## 8. Conformance test plan

A future `@axona/protocol/test/transport-conformance.js` runs against any implementation of the Transport contract. The Phase 3 deliverable includes both:

- The simulator's `SimulatedTransport` passing the suite (regression baseline).
- The peer's `WebRTCTransport` passing the suite over real loopback (production gate).

Test categories:

1. **Lifecycle** — `start`/`stop` idempotency; restart after stop.
2. **Channel pool** — `openConnection` truthy/false semantics; persistent across multiple sends.
3. **Request/response** — round-trip, error propagation, timeout, late-response drop.
4. **Notification** — delivery, handler errors don't propagate, dropped on peer death.
5. **Heartbeat** — 1 Hz cadence, RTT EWMA convergence, `onPeerDied` after 3 misses.
6. **Liveness** — `_deadPeers` Set integration when peer dies mid-routing.
7. **Bilateral cap** — receiver at-cap returns `false`; cap-aware admission flow.
8. **Hard cutover** — Phase 2-style peer sees code 4002 close.

---

## 9. Open issues (deferred)

These don't block the initial Phase 3 integration but should be tracked.

- **Frame compression.** JSON encoding with hex-stringified BigInts is verbose. A future revision may switch to CBOR or a custom binary frame; the message-type vocabulary stays.
- **Per-message-type rate limiting.** No bound on how often `lookahead_probe` can be requested. Adversarial peers could spam this. Rate-limit table in the receiver, gated by sender's contribution to recent successful lookups. Deferred to adversarial pass.
- **Authenticated `hello`.** The version handshake doesn't yet verify peer identity. Once Ed25519 keys are in scope (Q1 2027 roadmap), `hello` carries a signed challenge-response.
- **Signed `pubsub:publish` envelopes.** Currently `signature: 'stub:<publisher>'`. Real Ed25519 signing is a 1-line swap once identity keys exist; receivers already recompute `post_hash` and reject mismatches.
- **Subscriber privacy from relays.** Relays see subscriber lists today. Separate hardening pass scoped post-launch.

---

## 10. Versioning

This document's version field tracks **wire-compatible revisions**. Any change that breaks the wire format bumps the major segment in `proto: "axona/<major>"` (currently `axona/3`). Any change to the *message-type vocabulary* (new types added, payload fields changed) bumps the minor segment in the document version (currently `v0.71.1`).

The hard-cutover rule means peers running different `axona/<major>` versions refuse each other. The minor revisions are forward-compatible: a peer running `v0.71.x` reads frames from a `v0.71.y` peer correctly (additional fields are ignored; missing optional fields default to absent).

---

*End of spec. Anything not described here is undefined and MAY change without notice in subsequent revisions.*
