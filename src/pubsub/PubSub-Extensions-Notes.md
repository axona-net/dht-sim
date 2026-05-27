# Axona Pub/Sub Extensions — Implementation Notes

These notes track the design and current state of the **post-level**
pub/sub layer that sits on top of `AxonaManager`. The protocol shape
follows `documents/Axona_Protocol_Extensions.docx`, locked decisions
from the conversation, and the end-to-end argument: the protocol moves
opaque payloads; encryption and ordering live above.

## Layers

```
       application                        — your social-media UI
       ── AxonPubSub ──                    feed-style API (publish, subscribe, metrics, …)
       ── post.js ──                       hashing, canonical encoding, topic_id derivation
       ── AxonaManager ──                   axonal/dendritic relay tree (root + sub-axons)
       ── MockDHTNode / MockDHTNetwork ──  DHT routing primitives
```

`PubSubAdapter` / `PubSubDomain` (Croquet-style event bus) coexist
alongside but are a different model. `AxonPubSub` is the feed-style
path; both target the same `AxonaManager` transport.

## What ships in PR 1

| Capability | Where |
|---|---|
| Self-authenticating topic_id `sha256(publisher || ':' || name)` | `post.js: deriveTopicId` |
| Content-addressed post_hash over canonical(post fields) | `post.js: makePost` |
| Receiver-side post_hash + topic-ownership verification | `post.js: verifyPostHash, verifyTopicOwnership` |
| Application API: publish, subscribe, metrics | `AxonPubSub.js` |
| Per-relay `delivery_count` counter bumped on fan-out | `AxonaManager._onPublish, _onDeliver, _onPublishDirect` |
| Routed metricsReq + direct metricsResp wire path | `AxonaManager._onMetricsReq, _onMetricsResp` |
| Publisher-side promise-based metrics collection | `AxonaManager.requestMetrics` |
| Aggregation across relays into `AggregateMetrics` | `AxonPubSub.metrics` |
| In-process counter inspection oracle | `AxonaManager.getLocalCounters` |
| Single-subscriber end-to-end test (Test 1) | `test_pubsub_delivery.js` |

## Counter increment rules (current)

A relay increments `delivery_count[topicId][postHash]` exactly when:

- The relay (root or sub-axon) **successfully sends** a `pubsub:deliver`
  to one of its direct children, or
- The relay is itself a subscriber and the post lands in its own
  delivery callback (handled in the `childId === this.nodeId` branch).

This counts each successful forward to a child. In a deep axonal tree
where some children are themselves sub-axons (which then re-fan to
their own children), the *sum* of delivery_counts across all relays
slightly overshoots the unique-subscriber count by the number of
sub-axons that are also subscribers. A future refinement will subtract
the "relay-as-subscriber-counted-twice" cases by tagging sub-axon
children distinctly in `role.children`. For PR 1's flat single-root
test this is exact.

## Carried into the wire protocol

The `pubsub:publish-k`, `pubsub:publish`, `pubsub:deliver` payloads
gained two **optional** fields:

```
{ topicId, json, publishId, publishTs, postHash, publisher }
```

Old call sites that pass `pubsubPublish(topicId, json)` without meta
emit `postHash=null` and `publisher=null`. The counter bumps are gated
on `postHash` being truthy, so legacy callers (and the existing
`test_axon.js` / `test_integration.js` paths) see no behavioral
change. **All pre-existing tests continue to pass at the same 73 / 14
pass-fail mark they were at before this PR (the 14 failures are
unrelated to the new code and reproduce on a stash-revert).**

## What PR 2 added

| Capability | Where |
|---|---|
| `pull(ref) → SignedPost \| null` with local cache | `AxonPubSub.pull`, `_pullCache` |
| `reshare(topicName, postRef, commentary?)` convenience | `AxonPubSub.reshare` |
| Routed `pubsub:pullReq` → direct `pubsub:pullResp` | `AxonaManager._onPullReq, _onPullResp` |
| `pull_count++` ONLY on the relay that returns FOUND | `_onPullReq` (single-count invariant) |
| Routed `pubsub:reshareNotify` to referenced topics | Emitted in `_asyncPublish` when `references[]` non-empty |
| `reshare_count++` at the first role-bearing node hit by the notification | `_onReshareNotify` |
| Multi-relay metrics fan-out: tree-broadcast via `pubsub:metricsBroadcast` | `_onMetricsReq` now forwards to children; `_onMetricsBroadcast` recurses |
| Per-request dedup for metrics broadcast | `_seenMetricsReqs` ring |
| Receiver-side post verification on Pull | `AxonPubSub.pull` calls `verifyPostHash` + `verifyTopicOwnership` |
| Test 2: 1000 + 50 × 20 cascade — `reach = 2000` | `test_pubsub_cascade.js` (13/13 passing) |

### Test 2 result summary

```
[Test 2] reshare cascade — first=1000 reposters=50 secondPerRepost=20 (FULL)
  total nodes: 2001
  P_orig.delivery_count = 1000   ← 1000 direct subscribers
  P_orig.pull_count     = 1000   ← 1000 second-tier referrals
  P_orig.reshare_count  =   50   ← 50 republishers
  P_orig.reach_estimate = 2000   ← headline
  each reposter.delivery_count = 20
  13 passed, 0 failed  (~4.4s)
```

Sub-scale (`--firstTier 200 --reposters 20 --secondPerRepost 10`) and
small default (`5 × 4 = 20`) both pass identically; the architecture
behaves correctly across two orders of magnitude.

### Counter invariants verified by Test 2

| Aggregate | What it equals | Why |
|---|---|---|
| `Σ delivery_count` across all `T_orig` relays | 1000 = first-tier count | one bump per leaf delivery in `T_orig`'s tree |
| `Σ pull_count` across all `T_orig` relays | 1000 = second-tier count | one bump per FOUND response, single-count rule |
| `Σ reshare_count` across all `T_orig` relays | 50 = reposter count | one bump per `reshareNotify` consumed |
| `Σ delivery_count` for each `T_R_i` | 20 = second-tier-per-reposter | independent count, untainted by `T_orig`'s tree |

### Open issues (not blocking PR 2)

- **`reshareNotify` is not signature-verified.** A malicious node could
  spam fake notifications and inflate `reshare_count`. Mitigation will
  arrive with real Ed25519 signatures: the notification will carry the
  signed reshare post (or just its signature), and the receiving relay
  verifies before bumping. Documented as adversarial-pass work.
- **`crossFragmentRoots=0` (single-root mode).** Test 2 uses this for
  deterministic counters. K-closest mode introduces a different
  aggregation question (deduplicating across K parallel roots) which
  is its own follow-up — counters under K-redundancy are sketched
  in `AxonaManager._useKClosestMode` but not yet exercised by tests.
- **Full-mesh routing table (n-1) in Test 2.** Real deployments use
  much smaller tables; correctness under sparse routing is the same
  problem the N-DHT protocols (NH-1, NX-11) solve, and is covered by
  the existing `test_axon.js` infrastructure. The post-level layer
  rides on whatever the underlying DHT gives it.

## Deferred to a future pass

- Pull amplification rate limiting (§6.x)
- Per-relay onion-routing or origin-anonymization for Pulls (§4.7
  privacy note)
- Real signatures (`signature: stub:<publisher>` → Ed25519)
- Time-based expiry beyond the replay-cache LRU
- Subscriber privacy from relays (relays still see subscriber lists;
  separate hardening pass)

## Stubbed for later phases

- **Signatures.** `signature: 'stub:<publisher>'` is a placeholder.
  Ed25519 over the canonical post bytes is a 1-line swap once
  identity keys are in scope; receivers already recompute `post_hash`
  and reject mismatches, which closes the most common tamper paths
  even without crypto.
- **Expiry by age.** Posts age out via the existing replay-cache LRU
  (`replayCacheSize`, default 100 per role). Time-based expiry is
  not yet wired through; tests that need it can shrink the cache
  bound or insert pruning at `_addToReplayCache`.

## Convention: receivers do not Pull on display

The protocol provides `delivery_count` as the canonical "delivered"
signal. Clients **must not** call `pull()` on a post they already
received via the subscription stream — doing so would manufacture a
read-receipt channel that exposes the recipient's reading behaviour
to the publisher. The privacy default is enforced by simply not
generating the extra fetch. This convention is documented in
`AxonPubSub` and reinforced by Test 1 (which asserts `pull_count = 0`
under normal subscriber behaviour).
