# N-DHT (NH-1) Red Team Analysis

## Critical Issues Facing Deployment — Ranked

**Document version:** v0.3.38
**Companion to:** Neuromorphic DHT — NH-1 research deck v0.3.38, simulator v0.69.00
**Date:** 2026-04-30
**Author:** David A. Smith — YZ.social (davidasmith@gmail.com)
**Scope:** Failure modes, attack surfaces, and deployment risks for NH-1 as it moves from simulator to production. Each issue is a full structural risk — not a tuning concern.

---

## Front Matter

### Purpose

The NH-1 simulator demonstrates that a vitality-driven, learning-adaptive DHT can plateau at ~1.18× the analytical 3δ latency floor at 50,000 nodes, deliver pub/sub at 100% baseline and 100% recovered under 5% churn, and dissolve a single-bridge partition through cooperative re-stitching. That is the brain of the system, and it is production-ready.

**The body is not.** This document catalogues the gap between "the routing logic works" and "the deployed system survives the Internet." It is intentionally adversarial: it does not credit the simulator's measurements where the simulator excludes the failure mode being measured. Each issue below describes a way real-world deployment can fail in a way the simulator cannot currently observe.

### Methodology

Issues were identified through three lenses:

1. **What the simulator does not model.** Connection setup cost, RPC timeouts, bandwidth limits, jitter, and Byzantine peers are absent or trivially modelled. Anything the protocol depends on for correctness that the simulator removes is a candidate failure mode.

2. **What prior art warns about.** Castro et al. (OSDI 2002), Harvesf-Blough (IEEE P2P 2007), Makris et al. (BIGDATA 2017), Ghinita-Teo (IPDPS 2006), and Dabek et al. (NSDI 2004) each catalogue a class of distributed-system failure mode. Issues that map onto known failure classes from this literature are weighted heavily.

3. **What asymmetric or adversarial workloads expose.** The simulator runs uniform-rate lookups on uniformly-distributed nodes against uniformly-distributed targets. Real networks have Zipf-distributed traffic, heterogeneous churn, asymmetric reachability, and adversarial participants. Anything whose analysis assumes uniformity is suspect.

### Ranking Criteria

Issues are ranked by a composite of five criteria:

| Criterion | Weight |
|---|---|
| **Probability of occurrence** in real deployment | high |
| **Severity of impact** if it occurs | high |
| **Detectability** before customer impact | inverse — harder-to-detect ranks higher |
| **Time-to-fix** from detection | inverse — slower-to-fix ranks higher |
| **Deploy-blocker status** | binary — blockers rank above non-blockers |

Issues 1–4 are **deploy blockers**: the protocol's claimed properties cannot be verified in production until these are addressed. Issues 5–8 are **correctness-under-stress** items: the protocol works in nominal conditions but degrades in ways that compromise its core promises under realistic adversarial or heterogeneous conditions. Issues 9–13 are **hardening** items: known gaps that should be closed before scale-out, but where staged rollout can manage the risk.

### Risk Overview Matrix

| # | Issue | Severity | Category | Deploy blocker? | Time-to-fix |
|---:|---|---|---|:---:|---|
| 1 | Connection setup friction (WebRTC ICE/STUN/TURN/DTLS) | Critical | Friction | Yes | 4–8 weeks |
| 2 | RPC timeouts and asynchronous black holes | Critical | Friction | Yes | 4–6 weeks |
| 3 | Bandwidth saturation and congestion collapse | Critical | Load | Yes | 6–10 weeks |
| 4 | Latency jitter and signal noise in AP routing | Critical | Friction | Yes | 4–6 weeks |
| 5 | S2 cell eclipse and Sybil swarms | High | Security | No | 8–12 weeks |
| 6 | Heterogeneous churn convergence | High | Correctness | No | 6–8 weeks |
| 7 | Byzantine relay hijacking on pub/sub topics | High | Security | No | 8–12 weeks |
| 8 | Cross-hemisphere asymmetry and routing loops | High | Correctness | No | 4–6 weeks |
| 9 | Incoming synapse bias and asymmetric learning | Medium | Correctness | No | 4–6 weeks |
| 10 | Parameter sensitivity and tuning brittleness | Medium | Operability | No | 3–4 weeks (measurement only) |
| 11 | Temporal pub/sub cache semantics under partition | Medium | Correctness | No | 4–6 weeks |
| 12 | Concurrent connection setup contention | Medium | Friction | No | 2–4 weeks |
| 13 | Adversarial operator tuning manipulation | Medium | Operability | No | 4–6 weeks |

**Total estimated work to clear deploy blockers (Issues 1–4):** 18–30 person-weeks, partially parallelizable. Realistic timeline: **2–3 calendar months** with one engineer; **6–8 weeks** with two.

**Total estimated work to clear all 13 issues:** 65–90 person-weeks. With staged rollout, Tier 2 (5–8) and Tier 3 (9–13) can be addressed during early production runs without blocking initial deployment.

---

## Issue 1 — Connection Setup Friction (WebRTC ICE/STUN/TURN/DTLS)

**Severity:** Critical
**Category:** Friction
**Affected layer:** Transport, all protocol mechanisms that depend on new synapse availability
**Deploy blocker:** Yes

### Description

The simulator treats new synapses as immediately usable: the moment a node decides to connect to another, the synapse is live, scored by AP routing, and available as a forwarder. Real WebRTC requires:

- **ICE gathering** — 1–3 seconds to enumerate candidate paths (host, server-reflexive, relayed)
- **STUN exchange** — additional round-trips against a STUN server to discover NAT mappings
- **TURN allocation** — when direct paths fail, fallback through a TURN relay, adding latency and bandwidth cost
- **DTLS handshake** — DTLS-SRTP key exchange before data channel becomes usable
- **Data channel ready** — additional sub-second delay before the channel is bidirectional

The total cost from `connectToPeer()` to first usable RPC is **1.5–3 seconds** under typical conditions, and can exceed 10 seconds when ICE hits restrictive NATs or TURN allocation is required.

### Why this is the #1 issue

NH-1's most important behavioral results depend on synapses becoming usable rapidly:

- **Slice World recovery** — the bridge becomes a "seed crystal" because triadic closure, hop caching, and lateral spread fire on every successful crossing, depositing 20+ cross-hemisphere synapses within 10 lookups. In production, each of those new synapses takes 1–3 seconds to become live. Recovery time degrades from "10 lookups" to "30+ seconds, sequentially gated."
- **Annealing replacement** — every routing hop has probability `T` of replacing the lowest-vitality synapse with a 2-hop neighbor. At T=1.0 (early life of a node), this fires on nearly every hop. In production, each fire triggers a multi-second connection attempt that may not complete before the next anneal step decides the synapse is no longer needed.
- **Hop caching cascade** — when a lookup succeeds, every node on the path adds the destination to its synaptome, plus lateral spread to up to 6 geographic neighbors. A single successful lookup can trigger 8–12 simultaneous connection attempts at the source's neighborhood. Browser connection-thread pools cannot sustain this.

### Social dimension

End users experience this as **"the network feels slow on first contact."** A new subscriber joining a topic doesn't get its expected sub-second join time — instead, several seconds of dead air while the synaptome materializes. New nodes joining the network experience a 30–60 second warmup during which lookups fail or take 5–10× longer than expected. For a privacy-first peer-to-peer system competing with centralized alternatives, this is the failure mode that loses adoption.

For operators, the social cost is more subtle: **the system's measured latency in production will not match the simulator's claims**, and operators will not initially understand why. The 261 ms global lookup measurement assumes instant connection availability. Real measurements will report 1500–3000 ms during warmup phases and remain elevated long enough that the operator may reasonably conclude the protocol is broken.

### Architectural dimension

The friction lives at the boundary between the **synaptome management layer** (which assumes synapses are abstract, immediately-usable references) and the **transport layer** (which has to do real work to make the abstraction concrete). NH-1's synapse data structure has no notion of "connection state." It carries `weight`, `latency`, `stratum`, `inertia`, `useCount`, `bootstrap` flag — but no `connectionState` field, no `pendingSetupSince` timestamp, no `setupAttempts` counter.

This is a deliberate simplification — it lets the protocol logic remain transport-agnostic. But it pushes the complexity into the application boundary, where it cannot influence routing decisions. AP scoring will pick a synapse that's still in DTLS handshake. The lookup will time out. The synapse may be evicted by annealing before it ever becomes usable. The connection setup work is wasted.

### Security dimension

**Connection setup amplification attack.** An attacker can advertise itself as a useful peer (high stratum diversity, low claimed latency) and accept connection requests slowly, exhausting victims' connection-setup parallelism. The victim's node spends its setup capacity on the attacker's slow handshakes instead of legitimate peers.

**Connection refusal as denial of service.** If an attacker controls a few nodes that NH-1 frequently selects as next-hop forwarders, the attacker can refuse data channel establishment after ICE succeeds, causing the victim's lookups to time out at the transport layer rather than the protocol layer. Iterative fallback eventually finds a working path, but each timeout costs 3+ seconds.

### Protocol dimension

The mechanisms that interact with this friction:

| Mechanism | How it breaks |
|---|---|
| AP routing | Scores synapses that aren't yet connected; lookup hangs at "send" |
| Two-hop lookahead | Probes a candidate's onward synapse list, but that list may include peers the candidate hasn't yet connected to |
| Iterative fallback | Triggers when AP returns no candidate; if the cause is that all candidates are still in setup, fallback waits in the same queue |
| LTP reinforcement wave | Reinforces the path that succeeded; in production, the path may have included synapses that took 3s to set up, but reinforcement is unaware |
| Triadic closure | Introduces A→C as a direct synapse; the introduction triggers connection setup that takes seconds to complete |
| Hop caching | Adds destination to each intermediate node's synaptome; each addition is a connection setup |
| Lateral spread | Cascades up to 6 connections in parallel from one event; will saturate browser connection pool |
| Annealing replacement | Replaces lowest-vitality with 2-hop neighbor; the new connection takes seconds |
| Bootstrap | Iterative self-lookup + inter-cell discovery requires up to 16 sequential lookups, each potentially delayed by setup |

### Design roadmap

**Phase 1A: Connection state in the synapse**

Add a `connectionState` field to `Synapse`:

```
connectionState ∈ { PENDING, CONNECTING, READY, FAILED, CLOSED }
pendingSince: Date  // when CONNECTING started
setupAttempts: int  // for backoff
lastFailure: { reason, timestamp }
```

Synapses in `PENDING` or `CONNECTING` are **excluded from AP scoring**. They cannot be selected as next-hop, cannot participate in two-hop lookahead, and cannot be reinforced by LTP. They sit in the synaptome but don't influence routing decisions until they reach `READY`.

**Phase 1B: Adaptive connection-setup throttling**

Introduce a per-node `setupQueue` with bounded parallelism (default: 4 concurrent ICE gathers, configurable). New synapses requested by hop caching, lateral spread, triadic closure, or annealing are queued. The queue services them in priority order:

1. **High priority:** synapses needed for an in-flight lookup (e.g., next-hop forwarder discovered during routing)
2. **Medium priority:** synapses from successful-path learning (LTP, hop caching)
3. **Low priority:** speculative synapses (lateral spread, annealing replacement)

Low-priority requests can be **dropped** if the queue is saturated for more than 30 seconds. The synapse is recorded as a "deferred candidate" — eligible for reconsideration when the queue drains.

**Phase 1C: Realistic warmup model**

Rebuild the simulator's bootstrap phase to model setup latency. New nodes should require 30–60 seconds of warmup during which their synaptome fills incrementally, not instantly. This makes the simulator measurements honest.

**Phase 2: Pre-connection probing**

Before committing to a synapse via setup, do a lightweight reachability probe (e.g., a STUN-bind exchange to verify the peer is online). This adds ~100 ms but avoids 3-second wasted setups against dead peers. The probe failure can trigger immediate eviction (skip the multi-second timeout).

**Phase 3: Connection pooling for ephemeral peers**

For short-lived peers (annealing candidates, lateral spread targets), maintain connections in a pool with idle timeouts. Reuse pooled connections for opportunistic synapse evaluation without paying full setup cost each time.

### Deployment roadmap

| Step | Duration | Gate |
|---|---|---|
| Implement connectionState in Synapse | 1 week | Code review |
| Implement setupQueue with parallelism cap | 1 week | Unit tests pass |
| Modify AP scoring to exclude PENDING/CONNECTING | 0.5 weeks | Existing benchmarks within 5% |
| Modify hop caching, lateral spread, annealing to queue | 1 week | Lookup success rate ≥ 99% on 1K-node testnet |
| Run on 100-node WebRTC testnet (real ICE, real DTLS) | 1 week | p95 lookup ≤ 2× simulator measurement |
| Run on 1K-node WebRTC testnet | 1 week | Slice World recovery completes in ≤ 60 seconds |
| Run on 5K-node staging | 2 weeks | All Tier 1 alerts (network partition, lookup collapse, pub/sub failure) below threshold |

### Acceptance criteria

The issue is considered closed when:

1. p95 lookup latency on a real WebRTC testnet (≥ 1K nodes) is within 2× of the simulator's measurement at the same N
2. Slice World partition recovery completes (≥ 90% delivery) in less than 60 seconds on real WebRTC
3. New-node warmup (cold join → 95% lookup success rate) completes in less than 90 seconds on real WebRTC
4. Bowled-over scenario: when a node receives 50 simultaneous learning events (hop caching cascade), no more than 4 connections are attempted concurrently and the rest are queued without dropping protocol-level liveness

### Cross-references

- **Existing red team item:** "Frictionless connection fantasy" (deck §)
- **Prior art:** Phase 1 of the action plan in deck v0.3.38
- **Related issues:** #2 (timeouts compound this), #12 (concurrent setup contention is a sub-aspect)

---

## Issue 2 — RPC Timeouts and Asynchronous Black Holes

**Severity:** Critical
**Category:** Friction
**Affected layer:** Transport, churn detection, pub/sub liveness
**Deploy blocker:** Yes

### Description

The simulator detects dead peers instantly. When a node sends a message to a peer that has been killed by the churn injector, the simulator returns "DEAD" immediately, allowing iterative fallback to fire on the next hop and `_evictAndReplace` to repair the synaptome before the lookup proceeds. This synchronous, omniscient liveness model is one of the most consequential simplifications in the simulator.

In production, dead peers are silent. A message is sent. There is no acknowledgment. There is no error. There is no signal until a timeout fires — typically **3–10 seconds** for a TCP-based protocol, **3 seconds** is a reasonable default for a request/reply RPC over WebRTC data channels. During that interval:

- The lookup is blocked
- The synapse appears live to the rest of the synaptome
- Other lookups continue to select it as a candidate, each blocking on its own timeout
- LTP reinforcement does not fire (no success), but no LTD signal exists either — the synapse retains its weight
- The replay cache on the upstream relay continues accumulating messages for which no acknowledgment will ever arrive

This is the **asynchronous black hole**: a peer that has stopped responding but has not yet been declared dead.

### Why this is critical

The simulator's pub/sub recovery measurement of 100% delivery under 5% churn assumes that dead-peer detection is instantaneous. In production, every dead peer in the axonal tree creates a multi-second delivery gap. With 5% churn injected at simulator-typical rates (1% every 5 ticks), the network is in a state of **continuous partial blackout** as dead-peer-detection windows overlap.

More concretely: with a 3-second timeout and 1% churn per 5-tick interval, at any given moment ~3% of synapses are in an undetected-dead state. AP scoring continues to select them. Lookups stall. Pub/sub messages are silently dropped. The replay cache has them, but the subscriber has no way to know to ask for replay until the relay is itself declared dead.

### Social dimension

End users experience this as **"messages occasionally disappear with no indication."** A pub/sub message is published; some subscribers receive it; others do not; nobody is notified that delivery was incomplete. For an application built on NH-1 (a decentralized chat, a distributed social feed), this is the difference between a usable system and an unusable one. Users will lose trust in the network's reliability before they understand why.

For operators, the social cost is that **monitoring dashboards will not show the failure**. The pub/sub delivery metric will be reported as 100% by sender-side instrumentation (the publisher published; the relay accepted; the relay's local view says it forwarded). The receiver-side metric will show < 100%. Reconciling these two views requires end-to-end tracing that the current architecture does not specify.

### Architectural dimension

NH-1's churn-recovery story is built on three mechanisms:

1. **Dead-synapse eviction** in `_evictAndReplace` — discovered during routing
2. **Temperature reheat** to T=0.5 on dead-peer discovery
3. **Iterative fallback** when greedy AP returns no candidate

All three depend on **synchronous** dead-peer detection. If detection is delayed by 3 seconds, all three mechanisms are delayed by 3 seconds. The network does not recover; it staggers.

The deeper architectural issue is that NH-1 has no **liveness layer separate from routing**. Dead peers are discovered as a side effect of failed routing. There is no proactive ping, no heartbeat, no active liveness probe. This was a deliberate simplification (re-subscribe is the liveness check for pub/sub; routing is the liveness check for the DHT), but it ties detection latency to lookup latency. A peer that is never used in routing is never discovered to be dead.

### Security dimension

**Selective non-response attack.** An attacker can configure its nodes to respond to lookup queries (so they appear live and are reinforced by LTP) but to silently drop pub/sub forwarding messages. The relay continues to receive subscribes (and respond, maintaining its tree role) but does not forward publishes. From every metric, the network appears healthy; messages simply vanish.

**Slowloris-style amplification.** An attacker holds connections open but responds with maximum delay (e.g., 2.9 seconds per RPC, just under the timeout threshold). Every lookup through this peer is artificially slowed. AP scoring's exponential latency penalty eventually shifts away, but only after many slow lookups have completed — and the attacker can rotate identities to keep the trick fresh.

### Protocol dimension

Specific failure modes by mechanism:

| Mechanism | Failure mode |
|---|---|
| AP routing | Selects a black-holed synapse; lookup blocks for the full timeout window |
| Two-hop lookahead | Probes a candidate's onward synapses; if the probe times out, the lookahead is wasted |
| Iterative fallback | Fires only after AP returns nothing; if the cause is that all candidates are black-holed, fallback waits behind their timeouts |
| LTP reinforcement | Does not fire (no success), but no penalty signal exists; the synapse retains its weight |
| Vitality eviction | The black-holed synapse may be evicted by competing high-vitality synapses, but only if the synaptome is full and a new high-vitality candidate exists |
| Re-subscribe | Routes toward `topicId`; if path includes a black-holed relay, re-subscribe times out and subscriber is briefly orphaned |
| Replay cache | Holds messages for `topicId`; if relay is itself silent (incoming messages not acknowledged), no replay can be triggered |
| `_evictAndReplace` | Triggers on detected dead peer; cannot trigger until detection completes |
| Temperature reheat | Same — depends on detection |

### Design roadmap

**Phase 2A: Bounded RPC timeout per request**

Introduce `RPC_TIMEOUT_MS = 3000` (configurable). Every send-and-wait operation has an explicit timeout. On timeout, the synapse is marked `SUSPECTED` (not yet `DEAD`).

**Phase 2B: Suspicion-based partial liveness**

Add a `suspicionLevel ∈ [0, 1]` to each synapse. On RPC timeout, increment suspicion by 0.3. On RPC success, decrement by 0.5 (faster recovery than degradation). Synapses with suspicion > 0.6 are excluded from AP scoring but retained in the synaptome for one more probe attempt.

```
effectiveLiveness(syn) = (1 - suspicion) × connectionState
```

This is the missing **LTD signal** for the simulator's omniscient liveness — a continuous, locally-observed degradation of trust based on response behavior.

**Phase 2C: Active liveness probe**

For high-value synapses (LTP-locked, high-vitality, highway tier), run a low-rate active ping (every 30–60 seconds). The ping is asymmetric: it does not consume connection-setup budget but does verify that the peer is responsive. Ping failure increments suspicion immediately.

**Phase 2D: End-to-end pub/sub acknowledgment**

For pub/sub specifically, add an end-to-end delivery confirmation channel. Every published message carries a `publishId`. Each subscriber, on receipt, sends a lightweight `DELIVERY_ACK` toward the publisher. The publisher tracks ack rate per topic; if ack rate drops below 95%, alert.

This is more expensive than the current "publish and pray" model, but it provides the receiver-side visibility that operators need.

**Phase 2E: Forward-and-reverse path verification**

Refactor `routeMessage` to maintain forward-path and reverse-path receipts. The forward path's success does not imply the reverse path's success. Either failure fails the RPC.

### Deployment roadmap

| Step | Duration | Gate |
|---|---|---|
| Implement RPC timeout | 0.5 weeks | All RPCs have explicit timeout |
| Implement suspicion-based liveness | 1 week | Lookup success rate maintained on 1K-node testnet |
| Modify AP scoring to incorporate suspicion | 0.5 weeks | No regression on benchmarks |
| Implement active liveness probe (high-value synapses only) | 1 week | Ping overhead < 1% of bandwidth |
| Implement end-to-end pub/sub ack | 1 week | Receiver-side delivery measurement matches publisher-side ± 2% |
| Forward-and-reverse path verification | 0.5 weeks | RPC failure correctly fails the parent operation |
| Validate on 5K-node staging | 1 week | Pub/sub recovery ≥ 95% under simulated 5% churn with real timeouts |

### Acceptance criteria

1. End-to-end pub/sub delivery rate, measured at the subscriber, is within 5% of the publisher's report
2. Mean dead-peer detection time is below 5 seconds on a real WebRTC testnet
3. Lookups blocked by undetected-dead peers complete via iterative fallback in less than 6 seconds (timeout + one fallback hop)
4. Selective-non-response attack (1% of nodes silently drop pub/sub forwards) is detected within 5 minutes via end-to-end ack rate

### Cross-references

- **Existing red team item:** "Asynchronous black holes & missing timeouts"
- **Prior art:** Ghinita-Teo (IPDPS 2006) — threshold-triggered liveness checks
- **Related issues:** #1 (setup friction), #6 (heterogeneous churn requires adaptive timeouts), #7 (Byzantine relays exploit silence)

---

## Issue 3 — Bandwidth Saturation and Congestion Collapse

**Severity:** Critical
**Category:** Load
**Affected layer:** Transport, AP routing, axonal tree, replay cache
**Deploy blocker:** Yes

### Description

The simulator models latency but not throughput. Every node has the same modeled hop cost — `10 ms + propagation` — regardless of how many messages it is currently forwarding. A relay processing 10,000 pub/sub messages per second is scored identically to an idle node by AP routing. There is no notion of TX queue depth, bandwidth cap, or backpressure.

In production, real workloads are skewed. Pub/sub topics follow Zipf's law: a small fraction of topics carry the bulk of traffic. A single popular topic with 2,000 subscribers and a publish rate of 100 messages/second generates 200,000 forwarding events per second, concentrated through the axonal tree's relay nodes. Even a generously-provisioned server-class node with 1 Gbps capacity will saturate well before the topic's full membership is served.

The consequence is a **success disaster** dynamic:

1. AP routing reinforces the highest-vitality, lowest-latency relay (correct under uniform load)
2. The relay accumulates traffic; its TX queue depth grows; effective forwarding latency increases
3. Other relays observe the saturated relay's increased latency through AP scoring; routing shifts away
4. The saturated relay drains; its latency drops; AP scoring shifts back toward it
5. Repeat — oscillation, with consistent message loss during shift transitions

### Why this is critical

This is not a tail-case scenario. Every real pub/sub system that has ever been deployed has encountered Zipf workloads. Twitter, Reddit, Discord — all production systems route the bulk of traffic through a small fraction of topic relays. NH-1's axonal tree, as currently designed, has a single root per topic. Under any popular workload, that root saturates first.

The deeper issue is that NH-1's adaptive routing **amplifies** the problem rather than mitigating it. AP scoring's latency penalty correctly identifies overloaded nodes as slow, but the response (route around them) cycles back when the overload clears, creating oscillation. A static routing protocol like Kademlia would simply degrade gracefully (everyone hits the same overloaded peer; everyone is equally slow); NH-1 actively destabilizes around it.

### Social dimension

End users experience this as **"the network works fine for unpopular content but breaks for anything that catches on."** The privacy-first peer-to-peer use case competes specifically against centralized platforms whose advantage is exactly the opposite: scaling to viral content. A network that fails on its own success is unusable for the workloads that drive adoption.

For application developers building on NH-1, this is the failure mode that drives them to build workarounds at the application layer: explicit sharding of topics, manual replication of popular content, or eventually abandonment of the platform for a centralized alternative. The architectural commitment in the deck — "pub/sub belongs in the network" — fails if the network cannot carry the workload.

For operators, the social cost is the on-call burden. Latency creep alerts will fire repeatedly. Each one will look different: sometimes one topic, sometimes another, sometimes a regional cluster, sometimes the global network. Without a mechanism to route around saturation, every popular event becomes a Page Two incident.

### Architectural dimension

NH-1 has no admission control, no flow control, and no load awareness in routing decisions. The axonal tree assumes uniform throughput per relay. The synaptome has no notion of "this peer is busy." AP scoring treats latency as a property of the link, not a function of load.

The architectural gap is that **load awareness is a property the routing layer needs, but only the transport layer can measure**. A peer doesn't know how loaded its forwarders are unless the forwarders tell it. This requires a new signal — periodic load reports from peers, or load-encoded latency that increases with queue depth — neither of which currently exists.

The replay cache exacerbates the problem. When a relay drops a message due to saturation, the cache does not record the drop. Subscribers re-subscribing after the saturation event will not be told "you missed message X because we couldn't forward it" — they will just have a gap.

### Security dimension

**Topic-flooding denial of service.** An attacker creates a popular topic and publishes at maximum rate. The topic's relay saturates; pub/sub for adjacent topics (sharing relays via tree branching) degrades. With careful topic-ID construction (collisions in publisher cell prefix), an attacker can target specific cells for service degradation.

**Subscribe-flooding denial of service.** An attacker subscribes 10,000 sybil identities to a topic. The axon tree branches recursively, but the root and upper-tier relays still see fan-out proportional to the subscriber count. CPU and memory pressure on those relays causes legitimate subscribers' re-subscribes to time out.

**Saturation-as-eclipse.** An attacker saturates a particular relay deliberately to push traffic through alternate routes that the attacker controls. AP routing's load-aware behavior (in a future load-aware variant) would prefer the attacker's routes.

### Protocol dimension

| Mechanism | Failure mode under saturation |
|---|---|
| AP routing | Latency penalty correctly identifies saturated relay as slow; routing oscillates between alternate relays |
| Two-hop lookahead | Same oscillation; the second hop's quality is also load-dependent |
| Axonal tree | Root saturates first; subscribers re-subscribe and find the same root (publisher-prefix topic ID is deterministic) |
| Branching on overflow | Adds sub-axons, but they're chosen from the saturated relay's synaptome — likely also saturated |
| Replay cache | Bounded ring buffer (default 100 messages); a saturated relay overflows the cache, losing history |
| Re-subscribe | Carries `lastSeenTs`; if the relay's cache has overflowed, replay is incomplete |
| LTP reinforcement | Reinforces the saturated relay during good moments; oscillation is encoded in the synaptic weights |
| Adaptive decay | Slow weight decay means the saturated relay retains high weight even during bad moments |

### Design roadmap

**Phase 3A: Per-node load reporting**

Each node tracks `outgoingMsgRate` (messages/sec) and `bandwidthCap` (configured per node class). Compute `loadFactor = outgoingMsgRate / bandwidthCap`. Periodically (every 10 seconds), each node includes its current `loadFactor` in routine acknowledgments to its synaptome members.

**Phase 3B: Load-aware AP scoring**

Modify the AP score:

```
AP(syn, target) = progress × weight × ½^(latency_ms / 100) × ½^(loadFactor)
```

A relay at 50% load gets a 0.71× penalty; at 80% load, 0.57×; at 100% load, 0.5×. This gives a smooth gradient away from saturated nodes without the binary "in/out" cliff that drives oscillation.

The exponential form (matching the existing latency penalty) ensures that load and latency contribute in commensurable units and that the system gracefully shifts traffic rather than lurching.

**Phase 3C: Hot-axon-root migration**

Implement Makris et al. (BIGDATA 2017) — the Directory For Exceptions (DFE) pattern adapted to NH-1's axon tree. When an axon root's load factor exceeds 0.8 for more than 60 seconds, the root **migrates** to a less-loaded peer in its synaptome:

1. Root selects a peer P with `loadFactor < 0.4` and stratum proximity to the topic's S2 prefix
2. Root sends `MIGRATE_TOPIC(topicId, P)` to P; P accepts and becomes the new root
3. Root installs a `REDIRECT(topicId → P)` entry locally; new subscribes hitting the original root are redirected
4. After 30 seconds (long enough for re-subscribes to find the new root), the original root drops the redirect and the topic is fully migrated

The redirect is the DFE — a "directory for exceptions" indicating that the canonical placement (publisher's S2 cell) has been overridden for hotspot mitigation.

**Phase 3D: MaxDisjoint replication for hot topics**

For topics that exceed a threshold popularity (say, 1,000 subscribers or 100 publishes/sec), replicate the root across `d = 3` disjoint locations using Harvesf-Blough placement. Subscribers select their root by a deterministic hash of their own ID (load-balancing across replicas). Publishers send to all replicas in parallel.

This is more expensive than single-root, but it scales pub/sub linearly with replica count — the architectural escape from the success-disaster trap.

**Phase 3E: Replay cache load awareness**

Modify the replay cache to track per-message-rate cache lifetime: `cacheLifetime = capacity / publishRate`. For high-rate topics, increase capacity proportionally (or shorten retention with explicit "replay window expired" responses to subscribers).

### Deployment roadmap

| Step | Duration | Gate |
|---|---|---|
| Implement per-node load reporting | 1 week | Load measurements visible in metrics |
| Implement load-aware AP scoring | 1 week | OFAT shows no regression on uniform-load benchmarks |
| Run Zipf-distributed pub/sub benchmark on simulator | 2 weeks | Quantify saturation thresholds; identify oscillation regimes |
| Implement hot-axon-root migration | 2 weeks | Migration completes in < 30 seconds; subscriber loss < 5% |
| Run Zipf benchmark with migration enabled | 1 week | No oscillation observed; latency stable under hot topics |
| Implement MaxDisjoint replication for hot topics | 2 weeks | 3-replica setup tested; publisher latency increases acceptably |
| Validate on 5K-node staging with synthetic Zipf load | 1 week | p95 latency stable under α=1.0 Zipf workload at 100 publishes/sec |

### Acceptance criteria

1. Under Zipf-distributed pub/sub load (α = 1.0, 100 topics, 100 publishes/sec total), no relay's `loadFactor` exceeds 0.8 for more than 5 minutes without triggering migration
2. Hot topics (> 1,000 subscribers) are replicated across ≥ 2 disjoint relays
3. Latency oscillation (peak-to-trough swing in p95 over 1-hour window) is below 30%
4. Subscribe-flooding attack (10K sybil subscribers to one topic) does not degrade adjacent-topic pub/sub by more than 10%

### Cross-references

- **Existing red team item:** "Gateway concentration & infinite bandwidth"
- **Prior art:** Makris, Tserpes, Anagnostopoulos (BIGDATA 2017) — DFE; Harvesf-Blough (P2P 2007) — MaxDisjoint
- **Related issues:** #4 (jitter compounds load oscillation), #7 (saturation is an attack surface), #11 (replay cache semantics under load)

---

## Issue 4 — Latency Jitter and Signal Noise in AP Routing

**Severity:** Critical
**Category:** Friction
**Affected layer:** AP routing, LTP reinforcement, EMA latency tracker
**Deploy blocker:** Yes

### Description

The simulator computes per-hop latency as a deterministic function of haversine distance: `RTT = 2 × (haversine_km / 20015 × 150 ms + 10 ms)`. For two given nodes, every measurement returns the same value. The signal that drives AP routing — `latency` in the AP formula — is noise-free.

Real Internet RTTs have substantial variance. Published measurements (Ledlie, Gardner, Seltzer, NSDI 2007 — *Network Coordinates in the Wild*) show:

- **Per-link variance:** 20–40% standard deviation around mean RTT, driven by queueing, bufferbloat, and asymmetric paths
- **Asymmetry:** path A→B has a different RTT distribution than B→A
- **Correlation:** if A→B is congested, A's other outbound paths are likely also slow (shared bottleneck links)
- **Non-stationarity:** the mean shifts on second-to-minute timescales as load changes elsewhere in the network

The `latency` field in NH-1's `Synapse` is updated as an exponential moving average (EMA) of observed round-trip times. The EMA constant determines how much each new measurement updates the estimate. The simulator's EMA is tuned for noise-free signals; in production, it must contend with measurements that swing 30% on individual samples.

### Why this is critical

The 3δ floor analysis — NH-1's headline claim of plateau-at-1.18× the analytical lower bound — depends on accurate latency measurement. AP routing's exponential latency penalty selects fast peers because their measured latency is genuinely low. If measurements are noisy, two failure modes emerge:

1. **False decay of good synapses.** A high-quality, low-latency synapse experiences one bad measurement (due to queue spike, GC pause, or transient congestion). The EMA pulls its tracked latency upward. AP scoring deprecates it. LTP fails to reinforce. Eventually, vitality decays and the synapse is evicted — the network has lost a good edge to noise.

2. **False reinforcement of lucky synapses.** A mediocre, average-latency synapse experiences a transient improvement (briefly uncongested neighbor). Its EMA tracks lower than its true average. AP scoring promotes it. LTP reinforces. Vitality increases. The synapse becomes locked-in despite being structurally inferior.

Both failure modes degrade routing quality slowly and silently. They will not show up as alerts; they will manifest as **latency creep over the first few weeks of operation**, with no clear root cause for the operator to address.

### Social dimension

End users experience this as **"the network was fast at first but feels sluggish now."** The simulator's measurements set expectations; production reality drifts away. There is no specific failure event — no outage, no error message — just a gradual decline in responsiveness. Users who tested the system during the warmup phase remember it as fast; the same users a month later find it slow.

For operators, the social cost is **diagnostic frustration**. The latency creep alert (#5 in §12.5) fires repeatedly. The playbook (§13.3) walks through hot topics, synaptome churn, temperature distribution, and saturation — but if the cause is jitter-induced misclassification of synapses, none of these sub-investigations will identify it. The operator concludes "the network just runs slow," which is the wrong conclusion.

For the protocol's reputation, the consequence is that **the simulator's measurements lose credibility**. Anyone who deploys NH-1 and measures their own results will see something different. The 1.18× claim becomes a marketing number rather than an operational target.

### Architectural dimension

NH-1's `Synapse` data structure tracks `latency` as a single scalar. This is sufficient for noise-free measurements but throws away the information that makes noise tractable. Specifically, it does not track:

- **Variance** (or any second-moment statistic)
- **Sample count** (so confidence in the estimate is unknown)
- **Last-N raw samples** (so outliers cannot be identified)
- **Direction** (asymmetric paths cannot be modeled)

The EMA constant itself is a fixed parameter. It does not adapt to observed jitter — a synapse with stable RTT and a synapse with high-jitter RTT both update at the same rate. In a noise-free simulator, this is fine; in production, it means the system cannot distinguish "consistent 50 ms peer with one 200 ms outlier" from "consistent 100 ms peer."

### Security dimension

**Latency manipulation attack.** An attacker controls a small number of peers in the synaptome of a target node. By selectively delaying responses (sometimes 50 ms, sometimes 500 ms), the attacker injects jitter that the EMA tracks. The attacker can:

- **Promote itself.** Respond fast during AP-scoring contexts (e.g., known training lookups), normal otherwise. The EMA underestimates true latency; the attacker wins more routing decisions.
- **Demote competitors.** Combined with proximity-based attacks, the attacker can cause a competitor relay to appear high-latency by delaying ACKs that pass through the attacker's intermediate peers.

**EMA-poisoning.** An attacker periodically sends spurious "latency probes" with crafted timing. If the victim's EMA tracker is naive, the probes update the tracked latency. Over time, the attacker shifts the victim's latency estimates to favor the attacker's nodes.

### Protocol dimension

| Mechanism | Failure mode under jitter |
|---|---|
| AP routing | Selects synapses based on noisy latency; routing decisions become probabilistic rather than principled |
| Two-hop lookahead | Latency-summed paths chosen in the sample may not be the truly best paths |
| LTP reinforcement | "At-or-below EMA latency" gate fires inconsistently — paths that are genuinely fast may not pass the gate, paths that are genuinely slow may pass it |
| LTP quality gate | The EMA itself drifts — its threshold shifts with noise, decoupling reinforcement from actual quality |
| Adaptive decay | Heavily-used synapses decay slowly; if their EMA latency has drifted, the slow decay locks in a bad estimate |
| Vitality eviction | Computes vitality as `weight × recency` — but weight has been corrupted by misreinforcement. Wrong synapses are evicted |
| Temperature reheat | Fires on dead-peer detection; jitter-induced timeouts can spuriously trigger reheats, wasting exploration |

### Design roadmap

**Phase 4A: Add variance tracking to Synapse**

Extend the `Synapse` to track both EMA mean and EMA variance:

```
latencyEMA: double  // existing
latencyVar: double  // new — exponentially-weighted variance
sampleCount: int    // for confidence
```

EMA variance updates: `latencyVar = α × (newSample - latencyEMA)² + (1-α) × latencyVar`.

**Phase 4B: Confidence-aware AP scoring**

Modify the AP score to incorporate confidence:

```
confidence(syn) = sampleCount / (sampleCount + 5)  // [0, 1)
adjustedLatency = latencyEMA + (1 - confidence) × √latencyVar
AP = progress × weight × ½^(adjustedLatency / 100)
```

Low-confidence synapses (few samples, high variance) are penalized — their estimated latency is treated as upper-bound. High-confidence synapses (many samples, low variance) are scored on their mean. This trades aggressive exploration for safer exploitation.

**Phase 4C: Outlier rejection in EMA update**

Before incorporating a sample into the EMA, check if it is a >3σ outlier. If so, **either** discard the sample (option A) **or** apply it with reduced weight (option B). Tunable. Option B is safer (avoids missing genuine regime change); option A is faster (avoids polluting the estimate during transient spikes).

**Phase 4D: Adaptive EMA constant**

The EMA constant α should depend on observed variance: high-variance synapses should have **lower α** (more inertia, less reactive to noise); low-variance synapses can have higher α (more responsive to genuine change).

```
α(syn) = α_base × (1 / (1 + latencyVar / variance_threshold))
```

**Phase 4E: Asymmetric latency tracking**

Track outbound and inbound RTT separately when possible. For pub/sub specifically, the publisher → subscriber direction matters more than the reverse. Model the directional path quality, not just bidirectional RTT.

**Phase 4F: LTP gate uses mean-confidence band**

The LTP reinforcement gate ("path completed at or below running average latency") should compare against `latencyEMA + 0.5 × √latencyVar` rather than `latencyEMA` alone. This prevents false reinforcement during noise-driven below-mean lookups.

### Deployment roadmap

| Step | Duration | Gate |
|---|---|---|
| Add variance tracking to Synapse | 1 week | Existing benchmarks within 2% (no behavior change yet) |
| Implement confidence-aware AP scoring | 1 week | OFAT shows acceptable latency profile |
| Implement outlier rejection | 0.5 weeks | Synthetic noise-injection test passes |
| Implement adaptive EMA constant | 0.5 weeks | Benchmark stable under varied jitter sigma |
| Inject jitter into simulator (30% σ) and re-validate all benchmarks | 2 weeks | 3δ floor result reproduced within 10% |
| Validate on real WebRTC testnet | 1 week | Real measurements within 30% of jittered-simulator predictions |

### Acceptance criteria

1. Under simulated jitter of σ = 0.30 × baseline RTT, global lookup p95 latency stays within 15% of noise-free measurement
2. Synthetic latency-manipulation attack (10% of synapses respond with arbitrary delays) does not measurably shift AP scoring outcomes within a 1-hour observation window
3. Real WebRTC measurements on a 1K-node testnet match jittered-simulator predictions within 30%
4. EMA convergence time (number of samples required to track a regime change) is below 20 samples for low-variance peers, below 100 for high-variance peers

### Cross-references

- **Existing red team item:** "Jitter-free latency"
- **Prior art:** Ledlie, Gardner, Seltzer (NSDI 2007) — *Network Coordinates in the Wild*; Vivaldi (Dabek et al., SIGCOMM 2004)
- **Related issues:** #2 (timeouts trigger on jitter spikes), #3 (load and jitter co-vary), #10 (parameter sensitivity to EMA constant)

---

## Issue 5 — S2 Cell Eclipse and Sybil Swarms

**Severity:** High
**Category:** Security
**Affected layer:** Node identity, bootstrap, geographic prefix
**Deploy blocker:** No (but blocks open public deployment)

### Description

The S2 cell prefix in a node ID is **self-declared** and unverified. Any peer can construct a node ID with any 8-bit prefix. The simulator assumes peers are honest about their location; production deployment cannot.

This creates two related attack surfaces:

1. **Cell eclipse.** An attacker creates many node IDs all claiming the same target S2 cell. Because the geographic prefix dominates XOR distance for nearby targets, new nodes bootstrapping into the network preferentially connect to cells with high apparent population. An attacker who creates 100 fake "Western North America" nodes makes that cell appear well-populated to bootstrappers; new nodes admitted to the network attach predominantly to attacker peers.

2. **Sybil multiplication.** Without identity binding, a single attacker can generate unlimited node IDs at zero marginal cost. The constraint on Sybil attacks in NH-1 is purely the cost of running the bootstrap and synaptome management for each fake identity — which, on modern hardware, is essentially zero.

These attacks compound. A Sybil attacker who controls 5% of the network can selectively concentrate their identities in target cells (the 5% becomes 50% of one cell), transforming a low-impact wide attack into a high-impact targeted one.

### Why this is high-severity

The Castro et al. (OSDI 2002) framework establishes that DHT routing security requires three jointly-necessary mechanisms: constrained routing tables, secure node ID assignment, and redundant routing. NH-1 has the third (iterative fallback, route diversity through synaptome candidates) but lacks the first two.

The deck explicitly notes this as future work, framed as "today's locality is a *cooperative* primitive." That framing is honest, but it also defines the threat model: NH-1 in its current state is **deployable in private or trusted environments only**. Open public deployment requires this issue to be addressed.

### Social dimension

The social risk is regulatory and reputational, not directly user-facing. Users do not see eclipse attacks; they experience them as "messages don't reach the people they should" or "regional connectivity feels weird." The damage is to **adoption confidence** — security researchers and privacy-focused communities will flag this gap as disqualifying. For a privacy-first peer-to-peer system, the perception that "Sybils can run the network" is fatal to legitimate user trust.

For operators, the social cost is more immediate: when a Sybil attack is suspected, operators have **no forensic tools** to confirm or refute it. The current architecture provides no signal for "this peer's claimed location is implausible." Operators will spend on-call hours investigating without ground truth.

### Architectural dimension

The S2 prefix enters NH-1's architecture at exactly one point: node ID construction (`nodeId = cellPrefix(8b) ‖ H(publicKey)`). After that, it is opaque — every downstream mechanism (XOR distance, stratum calculation, AP scoring, axon root selection) treats the prefix as data.

This is architecturally elegant but security-naive. The protocol has no mechanism to:

- Verify a claimed prefix matches the peer's true location
- Down-rank synapses with implausible prefix-distance combinations
- Detect coordinated prefix collisions (many peers claiming same cell)
- Quarantine or expire misbehaving identities

### Security dimension

Specific attack vectors:

**Eclipse-on-bootstrap.** An attacker concentrates Sybil identities in a target cell. New legitimate nodes joining the network in that geographic region preferentially see the Sybil cluster (geographic XOR proximity). The new node's stratified bootstrap fills with Sybils. The new node's synaptome is now attacker-controlled.

**Topic eclipse.** An attacker concentrates Sybil identities in the cell prefix used by a popular topic's publisher. Subscribers' subscribe-toward-`topicId` walks pass through Sybils. Attackers intercept subscribes, fail to forward (silent black hole), and the topic effectively disappears from their region.

**Geographic flooding.** An attacker creates 10,000 Sybils all claiming the same cell. The cell becomes a routing hotspot — not because of real load but because of routing-table concentration. Legitimate traffic for that region routes through Sybils.

**Cross-cell bridge eclipse.** In a Slice-World-like partition recovery scenario, an attacker becomes the "bridge" by concentrating identities at the S2 cells of likely connector regions. The partition recovery mechanism deposits new cross-hem synapses through attacker peers. The attacker silently controls all cross-region traffic.

### Protocol dimension

| Mechanism | Failure mode under Sybil/Eclipse |
|---|---|
| Stratified bootstrap | Fills synaptome with Sybils in target cells |
| AP routing | Picks Sybil-controlled paths (Sybils respond fast and correctly to maintain reputation) |
| Hop caching | Caches Sybil destinations; spreads Sybil edges to legitimate peers |
| Triadic closure | Introduces legitimate peers to other legitimate peers via Sybil intermediaries; the introductions are real but Sybil-mediated |
| Axon root selection | Topic root in attacker-controlled cell; subscribes route through Sybils |
| Re-subscribe | Healing via re-subscribe drops subscribers onto attacker-controlled re-roots |
| Replay cache | Sybil relays' caches are attacker-controlled; replay can be manipulated |
| LTP reinforcement | Sybils that respond correctly become high-vitality, locked-in synapses |
| Vitality eviction | Cannot evict Sybils that have received LTP reinforcement |

### Design roadmap

**Phase 5A: Vivaldi RTT coordinate validation**

Implement a Vivaldi-style coordinate system as a **secondary check** on declared prefix. Each node maintains a Vivaldi coordinate that converges to predict its measured RTT to peers. When evaluating a new synapse:

1. Read the peer's claimed S2 prefix
2. Estimate expected RTT from the prefix (using S2 cell centroid distance)
3. Measure actual RTT
4. If actual RTT > expected RTT × 3, flag the peer as **prefix-suspect**

Suspect peers are de-prioritized in bootstrap, capped in synaptome share-of-cell, and excluded from axon root candidacy. Critically, this is a **statistical** check — it doesn't require any peer to "prove" anything cryptographically, just to be consistent with measured network behavior.

**Phase 5B: Prefix entropy monitoring**

Track per-cell synaptome composition. For each cell prefix, count how many synapses claim that prefix and compute the entropy of their public-key hashes. Sudden entropy collapse (many peers with similar but not identical IDs in one cell) is a Sybil signature.

**Phase 5C: Bootstrap diversity enforcement**

Modify stratified bootstrap to enforce a per-source-cell diversity constraint. No more than 30% of bootstrap synapses may originate from any single declared cell. If the bootstrap completes with one cell saturated, subsequent admission rejects new synapses from that cell until other cells fill.

**Phase 5D: MaxDisjoint axon root replication**

For high-value topics (popular pub/sub topics, public discovery topics), replicate the axon root across `d = 3` disjoint placements using Harvesf-Blough geometry. An attacker would need to compromise all `d` independent placements to silently silence the topic. This is the canonical Byzantine pub/sub defense.

**Phase 5E: Reputation-anchored peer selection**

Per-synapse `reputation ∈ [0, 1]`, starts at 0.5. Successful relays increment by 0.05; missed forwards (detected via end-to-end ack from Issue #2) decrement by 0.10. AP scoring gates: synapses with reputation < 0.3 are excluded.

This is not a full Byzantine framework but it provides graceful degradation against detectable misbehavior.

**Phase 5F: Optional proof-of-location for high-trust deployments**

For deployments where operators want stronger guarantees, support a pluggable proof-of-location module: GPS attestation (mobile devices), ASN/IP-region binding (servers), or trusted-witness schemes (federated networks). The protocol does not require this but can verify it when present.

### Deployment roadmap

| Step | Duration | Gate |
|---|---|---|
| Implement Vivaldi coordinates | 2 weeks | Coordinate convergence in < 200 lookups |
| Implement prefix-suspect flagging | 1 week | Synthetic Sybil-eclipse attack detected within 30 minutes |
| Implement bootstrap diversity enforcement | 1 week | Per-cell synaptome share enforced |
| Implement reputation tracking | 1 week | Reputation converges; honest peers > 0.7, attackers < 0.3 |
| Implement MaxDisjoint axon root for top-1% topics | 2 weeks | Replicated topics survive 50% relay compromise |
| Validate against synthetic Sybil attack on 5K-node testnet | 1 week | Lookup success ≥ 90% with 10% Sybils all in one cell |

### Acceptance criteria

1. A 10% Sybil-eclipse attack against a single cell does not degrade lookup success below 90% in that cell
2. Honest peers' reputations converge above 0.7 within 1000 lookups; Sybil peers' reputations converge below 0.3 within 5000 lookups
3. Hot topics (top 1% by subscriber count) are replicated across ≥ 2 disjoint relays
4. Vivaldi-anchored prefix verification flags 95% of geographically-impossible peer claims within 100 measurements

### Cross-references

- **Existing red team item:** "Sybil forgery & cell eclipse"
- **Prior art:** Castro et al. (OSDI 2002); Harvesf-Blough (P2P 2007); Vivaldi (SIGCOMM 2004); S/Kademlia (Baumgart-Mies 2007)
- **Related issues:** #7 (Byzantine relay hijacking is a pub/sub-specific manifestation), #9 (incoming synapse spam is a related Sybil vector)

---

## Issue 6 — Heterogeneous Churn Convergence

**Severity:** High
**Category:** Correctness
**Affected layer:** Annealing, vitality decay, synapse aging, regional convergence
**Deploy blocker:** No

### Description

The simulator's churn benchmark is uniform: 1% of nodes (or 5%, or 25%) killed every K ticks, distributed without regard to geography, node class, or topic membership. Every node experiences the same churn rate. NH-1's churn-handling parameters — `T_COOLING`, `DECAY_GAMMA`, `INERTIA_DURATION`, `RECENCY_HALF_LIFE` — are tuned against this uniform model.

Real networks are heterogeneous along several dimensions:

- **Geographic.** Some regions have stable infrastructure (Northern Europe, North America); others have higher disconnection rates (mobile-dominated regions, regions with frequent power instability)
- **Node class.** Browser tabs churn at minute-scale; servers churn at month-scale; mobile devices churn at usage-pattern-dependent rates with strong diurnal and weekly cycles
- **Topic membership.** Subscribers to short-lived topics churn aggressively; subscribers to long-lived topics are stable
- **Time-of-day.** Active hours show 10× lower churn than overnight in single-region deployments; global networks see rolling churn waves following population centers

The result is that **a node's local churn rate is not the network's average churn rate**. A browser node in a high-churn region with active topic subscribers may experience 5× the average churn. A server node in a stable region with persistent peers may experience 0.1× the average. The same fixed parameters cannot be optimal for both.

### Why this is high-severity

The protocol's adaptive mechanisms (annealing, decay, vitality eviction) are designed to respond to churn. Their parameters control *how aggressively* they respond. Mistuning produces predictable failures:

- **Under-aggressive (parameters tuned for low-churn) in high-churn region:** Synapses linger after dying. Lookups select dead peers; iterative fallback fires repeatedly; latency creep. The temperature reheat mechanism partially compensates but slowly.
- **Over-aggressive (parameters tuned for high-churn) in low-churn region:** Annealing rate is high; legitimate, stable synapses are unnecessarily replaced. The synaptome thrashes; LTP reinforcement is wasted because reinforced synapses are evicted. Latency stays adequate but learning is ineffective.

The deeper issue is that NH-1 has **no per-node adaptive parameters**. Every node uses the same `T_COOLING`. The protocol cannot be tuned for an intrinsically heterogeneous network using a single global parameter set.

### Social dimension

The user-facing manifestation is **regional disparity in service quality**. Users in stable regions get fast, reliable service. Users in volatile regions experience higher latency and occasional message loss. Both groups are running the same protocol; both experiences are accurate measurements of NH-1's behavior in their respective regions.

This is a particularly difficult social dynamic because the affected populations correlate with broader inequities — mobile-dominated regions, regions with less robust infrastructure, lower-income regions are statistically more likely to be high-churn. A privacy-first system that systematically performs worse for users in those regions is failing its mission.

For operators, the social cost is **incomplete diagnostic visibility**. Network-wide metrics (Tier 2 in §12.2) report averages that hide regional variation. The dashboard says "global p95 latency: 263 ms" but doesn't say "Western Europe: 180 ms; West Africa: 580 ms." The information needed to address the disparity is not collected.

### Architectural dimension

The fix requires per-node parameter adaptation. Each node needs to:

1. **Estimate its local churn rate** — from observed dead-peer detection rate, from inbound connection churn, from synaptome turnover
2. **Adjust its parameters** in response — slower decay if churn is low, faster annealing if churn is high
3. **Coordinate with the rest of the network** — or not. The Ghinita-Teo (IPDPS 2006) framework treats per-node adaptation as fully local, with no coordination needed.

This is an architectural addition, not a parameter change. The simplest implementation is a small "local statistics" module that tracks `(μ_observed, λ_observed)` (failure rate, join rate) and writes derived parameter values to be read by the protocol's adaptation rules.

### Security dimension

**Churn-rate spoofing.** An attacker that wants to suppress a target's exploration (so it commits to attacker-controlled synapses without re-evaluating) sends fake "I'm dying" signals at a high rate. Or, conversely, sends fake "I'm stable" signals to suppress the target's annealing. Without authentication of churn signals, this is feasible.

**Adversarial parameter injection.** If parameters are written to a config that can be remotely updated (operator dial), an attacker compromising the config server can push parameter changes — e.g., extreme decay — that destabilize the synaptome. This is the operator-tuning attack (Issue #13) in a specific manifestation.

### Protocol dimension

| Mechanism | Failure mode under heterogeneous churn |
|---|---|
| Temperature annealing | Cooling rate is global; some regions stay too hot, others too cold |
| Reheat on dead-peer | Triggers correctly but cools at the same rate everywhere |
| Adaptive decay (in NH-1's gamma=0.995 default) | Same rate everywhere |
| Vitality eviction | Recency half-life is global; high-churn regions evict too slowly |
| Synaptome stability | Measured globally; regional instability hidden |
| Bootstrap | Stratified diversity not adjusted for regional density |

### Design roadmap

**Phase 6A: Local churn estimator**

Each node tracks:

```
deadPeersDiscoveredLast1H: int  // count
synapsesEvictedLast1H: int      // count
inboundConnectionsLast1H: int   // count
```

Compute:

```
μ_local = deadPeersDiscoveredLast1H / synaptomeSize / 3600  // failures per second per peer
λ_local = inboundConnectionsLast1H / 3600                   // arrivals per second
churnRate_local = μ_local / max(λ_local, ε)                 // dimensionless
```

This is a Ghinita-Teo-style statistical estimator, computed per-node, requiring no coordination.

**Phase 6B: Parameter adaptation rules**

```
T_COOLING_local = 0.9990 + 0.0007 × (1 - sigmoid(churnRate_local))
DECAY_GAMMA_local = 0.985 + 0.013 × (1 - sigmoid(churnRate_local))
T_REHEAT_local = 0.3 + 0.4 × sigmoid(churnRate_local)
RECENCY_HALF_LIFE_local = 30 + 100 × (1 - sigmoid(churnRate_local))
```

In low-churn regions, decay is slow and reheat is conservative. In high-churn regions, decay is fast and reheat is aggressive. The transitions are smooth (sigmoid) to avoid lurching.

**Phase 6C: Per-node parameter vs. global parameter**

Operator's "Dial 1: Churn Health" remains the override — the operator can force a specific parameter regime. By default, each node uses its locally-estimated regime. The operator dial sets a *floor* and *ceiling* on the local estimator output.

**Phase 6D: Variable-churn benchmark**

Add three benchmark scenarios to the simulator:

- **Stable core + volatile periphery.** Inner 80% of nodes at 2% churn; outer 20% at 20% churn
- **Island model.** Five geographic clusters at 2% churn; 20% inter-island churn
- **Diurnal cycle.** Churn rate varies sinusoidally with 24-hour period; peak 5×, trough 0.2×

Measure: does the per-node parameter adaptation track the variation? Does the network's global success rate match the homogeneous-churn baseline at the same average rate?

### Deployment roadmap

| Step | Duration | Gate |
|---|---|---|
| Implement local churn estimator | 1 week | Estimator stable, low-noise |
| Implement parameter adaptation rules | 1 week | Smooth transitions; no lurching observed |
| Add variable-churn benchmarks to simulator | 1 week | Three scenarios reproducible |
| Validate adaptation tracks variation | 2 weeks | Local parameter values correlate with local churn rate (r > 0.8) |
| Integrate operator dial as override | 0.5 weeks | Override correctly bounds adaptation |
| Validate on 5K-node staging with regional variation | 1 week | Regional p95 latency variance < 2× under 5×-variation churn scenario |

### Acceptance criteria

1. Per-node `churnRate_local` estimates correlate (Pearson r > 0.8) with ground-truth local churn rates in synthetic benchmarks
2. Under stable-core + volatile-periphery scenario, regional p95 latency variance is < 2× (vs. 5×+ with global parameters)
3. Diurnal cycle scenario shows parameter adaptation tracking the cycle within one cycle period
4. No regression on uniform-churn benchmarks (within 5% of homogeneous-parameter baseline)

### Cross-references

- **Existing red team item:** none directly; flagged as "adaptive anneal/reheat" in Phase 2 of action plan
- **Prior art:** Ghinita-Teo (IPDPS 2006) — adaptive stabilization framework
- **Related issues:** #4 (jitter and churn co-vary), #10 (parameter sensitivity becomes per-node)

---

## Issue 7 — Byzantine Relay Hijacking on Pub/Sub Topics

**Severity:** High
**Category:** Security
**Affected layer:** Axonal tree, replay cache, end-to-end delivery
**Deploy blocker:** No (but blocks high-value topic deployment)

### Description

Issue #5 covers Sybil/eclipse attacks on the routing layer. This issue covers a more specific attack: a Byzantine peer that has already been admitted as a relay in an axonal tree and selectively misbehaves.

A Byzantine relay in NH-1's pub/sub tree can:

1. **Drop publishes.** Receive a `PUBLISH(topicId, data)` and silently fail to forward to children
2. **Selectively forward.** Forward to most children but drop messages to specific subscribers (targeted censorship)
3. **Replay manipulation.** Hold messages in replay cache and deliver inconsistent history to different re-subscribers
4. **Forge delivery acks.** Acknowledge delivery to the publisher when delivery actually failed
5. **Refuse re-subscribes.** When a subscriber re-subscribes, return success but not actually attach them

The current architecture has no mechanism to detect any of these. The publisher sees its messages successfully sent. The relay reports successful delivery. Some subscribers receive; others do not. There is no end-to-end signal.

### Why this is high-severity for some workloads

For low-stakes workloads (casual chat, social broadcasting), occasional message loss is tolerable. For high-stakes workloads (coordination among activists, distributed news, censorship-resistant publishing), the entire point of NH-1 is that no single party can silence a topic. A Byzantine relay that selectively drops messages **directly negates the system's value proposition** for the workloads that motivate its existence.

The deck's privacy-first framing ("the DHT is the minimum viable substrate for that property") makes this issue load-bearing. A pub/sub layer that can be silently subverted is not the substrate the deck claims it is.

### Social dimension

The user-facing manifestation is **inconsistent delivery without explanation**. Some users receive a message; others claim they did not. There is no shared truth: each user has only their own view. For coordination workloads, this is poisonous — participants cannot agree on what was said.

For the system's reputation, **the censorship narrative writes itself**. "Activists used NH-1; their organizing messages were silently dropped by hostile relays; the system was supposed to prevent this." Even if the actual incidence is low, a single high-profile case can establish the reputation that "NH-1 doesn't actually deliver on its censorship-resistance promise."

For operators, the diagnostic challenge is severe. Without end-to-end delivery confirmation (Issue #2 §2D), the operator cannot tell delivery failure from subscriber misconfiguration. Both look like "subscriber didn't see the message."

### Architectural dimension

The axonal tree is built on the assumption that **relays cooperate**. The architecture has elegant healing for relay *death* (re-subscribe) but no healing for relay *misbehavior*. A live but Byzantine relay maintains its tree position indefinitely.

The deeper architectural issue is that NH-1 commits to **single-relay-per-subscriber**. If that relay misbehaves, the subscriber has no alternate path. The MaxDisjoint replication design (mentioned in Issue #5) addresses this by giving each subscriber multiple disjoint paths to the topic.

### Security dimension

**Targeted censorship.** An attacker positions a Byzantine relay in the axonal tree of a specific topic (acquiring this position via Sybil/eclipse — Issue #5 — or by genuinely earning it through good behavior, then turning Byzantine). The relay drops messages from specific publishers or to specific subscribers based on content inspection or identity matching.

**Coordinated relay collusion.** Multiple Byzantine relays controlled by the same attacker collude. They confirm to each other "yes, we delivered," even though no actual delivery occurred. The publisher's end-to-end ack rate (if implemented) shows high delivery; the actual subscribers see nothing.

**Replay-cache poisoning.** A Byzantine relay holds publications in its cache and delivers them with modified content (if message authentication is weak) or in modified order (if ordering is not enforced). On re-subscribe, the new subscriber sees a fabricated history.

### Protocol dimension

| Mechanism | Failure mode under Byzantine relay |
|---|---|
| Axonal tree forwarding | Relay receives publishes; selective drops invisible to publisher |
| Re-subscribe | Routes through Byzantine relay; relay accepts subscribe but doesn't actually attach |
| Replay cache | Byzantine relay's cache may contain fabricated history |
| End-to-end delivery | No mechanism currently exists; Byzantine relay can claim delivery succeeded |
| LTP reinforcement | Byzantine relay successfully relays during LTP-evaluation lookups (to maintain reputation), then misbehaves on real publishes |
| Vitality eviction | Cannot evict a Byzantine relay that has earned high vitality through cooperative routing |

### Design roadmap

**Phase 7A: Content-hash binding** *(prerequisite)*

Every published message carries a `contentHash = H(senderPubKey, topicId, body, publishTs, nonce)`. Subscribers verify the hash against the message body on receipt. Mismatch → relay flagged as Byzantine; reputation decremented; alert raised.

**Phase 7B: End-to-end delivery acknowledgment**

(See Issue #2 Phase 2D.) Subscribers send `DELIVERY_ACK(publishId)` toward the publisher. Publisher tracks per-topic ack rate. Drop > 10% → alert.

**Phase 7C: Subscribe-confirmation acknowledgment**

When a subscriber subscribes, they expect to receive at least one publish within some window (say, 30 seconds for active topics, 5 minutes for low-rate topics). If no publish arrives, the subscriber re-routes to a different relay path (alternate sub-axon) and tries again. Failed subscribes after 3 attempts mark the relay as suspect.

**Phase 7D: Multi-path delivery for high-value topics**

For topics flagged as high-value (operator-tagged or Sybil-resistant tier), implement MaxDisjoint replication of the axon root and **dual-path delivery**: every publish goes through both paths. Subscribers receive duplicates and dedupe by `publishId`. Disagreement (one path delivers, other does not) is a Byzantine signal.

**Phase 7E: Reputation cascade**

When a Byzantine relay is detected (via content-hash mismatch, missing acks, or re-subscribe failure), its reputation drops. If reputation falls below 0.3, it is **excluded from future axon role assignments**. The current axon tree is rebuilt on the next refresh, routing around the suspect.

**Phase 7F: Subscriber-side history reconciliation**

For high-value topics, subscribers periodically exchange publish-id sets with peers via the routing layer (lightweight). If two subscribers have substantially divergent histories for the same topic, alert. This is expensive but provides a strong cross-check against history-fork attacks.

### Deployment roadmap

| Step | Duration | Gate |
|---|---|---|
| Implement content-hash binding | 1 week | All publishes carry hash; subscribers verify |
| Implement end-to-end delivery ack | 1 week | Per-topic ack rate visible in metrics |
| Implement subscribe-confirmation timeout | 1 week | Failed subscribes detected within 30s for active topics |
| Implement reputation cascade for relays | 1 week | Synthetic Byzantine relay detected within 5 minutes |
| Implement MaxDisjoint dual-path for high-value topics | 2 weeks | High-value topic delivery survives 1 of 2 paths failing |
| Validate against synthetic Byzantine attack on 5K-node testnet | 1 week | 1% Byzantine relays do not degrade delivery below 95% |

### Acceptance criteria

1. Byzantine relay dropping 50% of forwards is detected within 5 minutes
2. Content-hash mismatch is detected with 100% accuracy and triggers reputation cascade
3. High-value topics achieve > 95% delivery even with 1% Byzantine relays in the axon tree
4. Re-subscribe latency increases by < 30% under 1% Byzantine load (cost of reputation gating)

### Cross-references

- **Existing red team item:** included implicitly in "Sybil forgery" discussion
- **Prior art:** Castro et al. (OSDI 2002); Harvesf-Blough (P2P 2007)
- **Related issues:** #2 (end-to-end ack is also dependency), #5 (eclipse attacks position Byzantine relays), #11 (replay cache integrity)

---

## Issue 8 — Cross-Hemisphere Asymmetry and Routing Loops

**Severity:** High
**Category:** Correctness
**Affected layer:** Bilateral synapse model, triadic closure, iterative fallback
**Deploy blocker:** No

### Description

The simulator's bilateral connection model assumes that if A connects to B, then B can also reach A on the same connection. This is true for outbound symmetric WebRTC channels. It is not true for many real-world deployments:

- **NAT asymmetry.** Some NATs (carrier-grade NATs especially) drop unsolicited inbound traffic. A→B works (initiated by A) but B→A spontaneously fails
- **Firewall asymmetry.** Some corporate or regional firewalls block specific traffic patterns. A→B may pass; B→A may be blocked
- **Bandwidth asymmetry.** Many residential connections have asymmetric upstream/downstream. A→B may have 100 Mbps; B→A may have 10 Mbps. RTT measurements diverge by direction
- **Rogue NATs and middleboxes.** Some networks rewrite traffic in ways that break end-to-end connectivity

When connectivity is asymmetric, NH-1's bilateral model fails in subtle ways:

1. **Synaptome divergence.** A learns that B is a good relay (A→B works); B never learns that A is a good relay (A→B succeeds but B→A's reverse traffic never arrives at A). A's outbound paths use B; B's outbound paths use someone else.
2. **Triadic closure asymmetry.** A→B→C succeeds; the introduction A→C is created. But the reverse C→A has never been validated; if asymmetry blocks it, the new synapse C→A may be unusable.
3. **Routing loops.** With asymmetric paths, the topological assumption "if I can reach B and B can reach C, I can reach C through B" fails. A→B→C→A→B... loops are possible if B's view of C disagrees with C's view of A.
4. **Iterative fallback amplifies the problem.** When AP routing dead-ends, fallback expands to k-closest. If the expanded set includes asymmetric peers, the fallback routes them as if they were live, and they silently fail.

### Why this is high-severity

The bilateral assumption permeates NH-1. Every learning rule (LTP, hop caching, lateral spread, triadic closure) assumes that what one node knows is what the other can use. The simulator's clean bilateral model means none of these failure modes are observable in current measurements. Production deployments will hit them, and the failures will look like "intermittent connectivity bugs" rather than systematic protocol gaps.

The Slice World test, which is the deck's strongest demonstration of partition-healing, assumes the bridge is bilateral. If the bridge is one-directional (E can route through bridge to W, but not vice versa), recovery is fundamentally different — half the network successfully heals, the other half permanently disconnects.

### Social dimension

The user-facing manifestation is **"some users in some regions just can't reach me, but I can reach them."** This is uniquely confusing because it violates the user's mental model of network connectivity. Email reaches them; my pub/sub doesn't. The user blames the application; the operator blames the network; nobody fixes it because nobody understands it.

For operators, asymmetric reachability is **invisible to network-wide metrics**. Tier 2 metrics (§12.2) report aggregate success; the asymmetry shows up only in specific peer-pair correlations that the metrics don't compute. Diagnosing requires per-edge connectivity testing that is not currently part of the operational toolset.

For mobile-heavy regions especially, asymmetric NAT behavior is the rule, not the exception. Carrier-grade NAT in many emerging markets makes bilateral assumption broken by default.

### Architectural dimension

NH-1's `Synapse` records `peerId`, `weight`, `latency`, `stratum`, `inertia`, `useCount`, `bootstrap` — but does not record:

- **Direction of last verified use.** Did A use this synapse to reach B (forward), or did B use it to reach A (reverse)? Or both?
- **Asymmetric latency.** Is the forward latency the same as the reverse?
- **Asymmetric reachability.** Is the synapse currently usable forward, reverse, or both?

Adding these fields requires extending the data structure and extending every learning rule to update them appropriately.

The deeper architectural issue is **incoming synapses** (which already exist in NH-1 as a separate data structure) implicitly encode reverse-direction connectivity, but they're treated as a routing optimization rather than a primary reachability signal. They could be promoted to first-class status.

### Security dimension

**Asymmetric reachability as eclipse vector.** An attacker's nodes are configured to accept inbound but never establish outbound. Victims connect to them, reinforce them via LTP, but the attacker never reciprocates connection-wise. The victim's synaptome fills with "useful peers" who are actually black holes for any reverse-direction traffic.

**Routing loop denial of service.** A coordinated set of attackers configures their synapses asymmetrically such that legitimate traffic enters loops that fail iterative-fallback hop limits. Each lookup wastes hops before failing.

### Protocol dimension

| Mechanism | Failure mode under asymmetry |
|---|---|
| AP routing | Selects synapses based on outbound success; reverse-direction failures are silent |
| Bilateral connection model | Assumes one-edge-equals-bidirectional; broken on asymmetric NATs |
| Triadic closure | Creates A→C edge that may be reverse-asymmetric; the introduction is wasted |
| Hop caching | Caches destination based on forward-path success; doesn't validate reverse |
| Iterative fallback | Expands to k-closest; if k-closest includes asymmetric peers, fallback routes through them |
| LTP reinforcement | Reinforces the forward path; reverse path quality is uncorrelated |
| Vitality eviction | Asymmetric synapses retain forward-direction vitality but are useless for reverse traffic |
| Re-subscribe | Routes toward `topicId`; if the path includes asymmetric peers, re-subscribe may fail at unrelated points |

### Design roadmap

**Phase 8A: Asymmetric reachability tracking**

Extend `Synapse`:

```
forwardReachable: bool      // last verified outbound success
reverseReachable: bool      // last verified inbound success
forwardLatencyEMA: double   // outbound RTT
reverseLatencyEMA: double   // inbound RTT (when measurable)
asymmetryFlag: bool         // |forward - reverse| > threshold
```

Update on every successful exchange in either direction.

**Phase 8B: Direction-specific AP scoring**

When routing forward (toward target), use `forwardLatencyEMA` and exclude synapses with `forwardReachable == false`. When routing reverse (subscribe ack from subscriber to publisher), use `reverseLatencyEMA` and exclude `reverseReachable == false`.

**Phase 8C: Loop detection**

Per-lookup, track visited node IDs. If the same node is visited twice in a single lookup, terminate with an iterative-fallback expansion that explicitly excludes already-visited nodes.

**Phase 8D: Bidirectional eviction agency**

When A connects to B, B independently runs its own admission decision. B may refuse the reverse edge if its synaptome is full and the new edge has lower vitality than its lowest-vitality existing edge. The asymmetry is now explicit: A has B, but B may not have A.

This requires acknowledgment of admission status. A connect attempt that succeeds at the connection level but fails at B's admission gate is a different state — A holds the synapse but flags it `reverseUnreciprocated`.

**Phase 8E: Asymmetric-partition test**

Add a benchmark scenario: 50% of cross-region edges are removed asymmetrically (only A→B, not B→A). Measure: does NH-1 detect the asymmetry and adjust? Does the global delivery rate match the symmetric-partition baseline?

### Deployment roadmap

| Step | Duration | Gate |
|---|---|---|
| Extend Synapse with asymmetric tracking | 1 week | Existing benchmarks within 2% (no behavior change) |
| Implement direction-specific AP scoring | 1 week | Synthetic asymmetry benchmark passes |
| Implement loop detection in iterative fallback | 0.5 weeks | No infinite loops in stress tests |
| Implement bidirectional eviction agency | 1 week | Acceptance flow works correctly |
| Add asymmetric-partition benchmark | 1 week | Scenario reproducible |
| Validate on real WebRTC testnet with NAT asymmetry | 1 week | Lookup success ≥ 95% under simulated asymmetric reachability |

### Acceptance criteria

1. Lookup success rate ≥ 95% under 50% asymmetric-edge removal scenario
2. No lookups hit MAX_HOPS due to detectable loops
3. Reverse-direction failures are detected within 5 attempts and excluded from AP scoring
4. Asymmetry flag (`asymmetryFlag` on synapse) accurately identifies asymmetric peers in synthetic NAT scenarios

### Cross-references

- **Existing red team item:** none directly
- **Prior art:** general NAT-traversal literature; ICE in particular addresses this for setup, not for ongoing routing
- **Related issues:** #1 (NAT-asymmetry interacts with connection setup), #2 (asymmetric paths can cause request/reply timeouts)

---

## Issue 9 — Incoming Synapse Bias and Asymmetric Learning

**Severity:** Medium
**Category:** Correctness
**Affected layer:** Incoming synapse promotion, LEARN operations
**Deploy blocker:** No

### Description

NH-1's "incoming promotion" rule (LEARN operation #4) elevates incoming synapses to outbound status when they exhibit sufficient reach traffic. The rationale is **passive learning**: if peers are contacting me, they likely matter, so I should track them as outbound peers.

The rule has a subtle asymmetry. Incoming traffic is a signal of **the other peer's interest in me**, not my interest in them. A node that becomes locally popular (a hub, an axon root, a frequent transit point) accumulates many incoming synapses. Its synaptome budget is consumed by promoted incoming peers — peers selected for their interest in the local node, not for the local node's need to reach them.

The result is a structural bias: **popular nodes' synaptomes become subscriber-dominated**, losing diverse outbound coverage.

### Why this is medium-severity

The rule works correctly for typical workloads. Most nodes are not popular; the bias does not manifest. For nodes that become popular — pub/sub topic roots, regional hubs, server-class nodes — the bias accumulates. These are often the nodes whose routing quality matters most, and they're the ones whose synaptomes are at risk.

The deeper issue is that the rule has **no defensive limit**. A target node whose synaptome should be 50/50 outbound/incoming-promoted might, under heavy incoming traffic, become 5/45 — almost entirely composed of peers selected for their interest in the target rather than the target's need to reach them.

### Social dimension

This is an internal protocol bias with limited direct social manifestation. Where it surfaces is in pub/sub topics with publisher-subscriber asymmetry: a publisher may serve thousands of subscribers; the publisher's own outbound routing degrades because its synaptome is saturated with subscriber-incoming-promoted edges; the publisher itself becomes harder to reach for non-subscribers.

For operators, this manifests as **"the publisher's lookups got slower over time, but I can't tell why."** Tier 1 metrics (synaptome size, stratum coverage) won't show it directly; you'd need to track outbound vs. incoming-origin synapse share.

### Architectural dimension

The rule is implemented as a count-based threshold: when an incoming synapse's `useCount >= 2`, it is promoted to outbound status. The promotion call bypasses the normal vitality eviction process — the promoted synapse can displace an existing outbound synapse if vitality is comparable.

There is no separate incoming-synapse cap. Theoretically, the entire 50-synapse budget could become incoming-promoted.

### Security dimension

**Incoming spam.** An attacker spams a target node with frequent incoming connection attempts. Each attempt registers as an incoming synapse. After 2 successful lookups (which the attacker can satisfy), the attacker is promoted to outbound. The attacker has bypassed normal outbound-quality gates and inserted itself into the target's primary routing table.

**Subscribe spam.** For pub/sub topics, an attacker subscribes from many sybil identities. Each subscriber-to-relay attachment increments the relay's incoming synapse count for that subscriber. Promoted subscribers consume the relay's synaptome budget; the relay's reach to other relays degrades.

### Protocol dimension

| Mechanism | Failure mode |
|---|---|
| Incoming promotion | No cap on share of synaptome dedicated to promoted incoming |
| Vitality eviction | Cannot distinguish promoted-incoming from earned-outbound |
| AP routing | Treats promoted incoming the same as outbound, but the peer was selected based on different criteria |
| LTP reinforcement | Reinforces promoted incoming on successful path use; the asymmetry is encoded into vitality |

### Design roadmap

**Phase 9A: Per-origin synaptome share cap**

Track origin per synapse: `OUTBOUND_LEARNED | INCOMING_PROMOTED | BOOTSTRAP_SEED`. Cap promoted-incoming at 30% of synaptome budget. Once cap is reached, further promotions require an existing promoted-incoming to be evicted (not an outbound-learned).

**Phase 9B: Promotion gate based on outbound need**

Before promoting an incoming, check the synaptome's stratum coverage. If the incoming's stratum is already well-covered by outbound-learned synapses, skip the promotion. Promote only if the incoming fills a coverage gap.

**Phase 9C: Promoted-incoming with reduced inertia**

When promoting, give the new outbound synapse only **half** the inertia lock duration of an LTP-reinforced synapse. Promoted-incoming should be more readily evictable than synapses earned through proven outbound utility.

**Phase 9D: Spam detection**

Track incoming connection attempts per source-peer over time. Sources that spam (>10 connections per second) have promotion suppressed regardless of useCount.

### Deployment roadmap

| Step | Duration | Gate |
|---|---|---|
| Track synapse origin | 0.5 weeks | Origin field populated |
| Implement promoted-incoming cap | 1 week | Cap enforced; no regression |
| Implement need-based promotion gate | 1 week | Stratum coverage maintained |
| Implement reduced inertia for promoted | 0.5 weeks | Evictability increased |
| Implement spam detection | 1 week | Synthetic spam attack mitigated |
| Validate on synthetic asymmetric workload | 1 week | Publisher synaptome remains diverse under 1000-subscriber pressure |

### Acceptance criteria

1. Under a 1-publisher / 1000-subscriber benchmark, the publisher's synaptome remains > 50% outbound-learned
2. Synthetic incoming-spam attack does not result in attacker peer being promoted within 5 minutes
3. No regression on existing benchmarks (within 5% of baseline)
4. Stratum coverage maintained under heavy incoming load

### Cross-references

- **Existing red team item:** none directly
- **Prior art:** general spam-resistance literature
- **Related issues:** #5 (Sybil), #7 (Byzantine relay)

---

## Issue 10 — Parameter Sensitivity and Tuning Brittleness

**Severity:** Medium
**Category:** Operability
**Affected layer:** All NH-1 parameters
**Deploy blocker:** No (but blocks confident operator handoff)

### Description

NH-1 advertises 12 parameters as a simplification advantage over NX-17's 44. The advantage is real only if the 12 are individually robust and have well-understood interactions. Without measurement, it is possible that:

- One parameter is so sensitive that ±10% changes break the network
- Two parameters interact strongly so that joint values matter, not individual values
- Optimal values change with scale (1K vs. 50K nodes) such that no single configuration fits all deployments
- Optimal values change with workload (Zipf vs. uniform) such that no single configuration fits all use cases

If any of these hold, the "12 parameters" claim collapses. Operators cannot reason about the system. The four-dial framework (§11.2) cannot reliably map deployment profile to parameter set.

### Why this is medium-severity

This is not a deploy-blocker because the simulator's results, however brittle, are the results actually measured. If they hold up in production, the brittleness doesn't matter operationally. But it becomes a deploy-blocker for **second-deployment confidence**: someone deploying NH-1 in a different network from the simulator's defaults needs to know whether they can simply set parameters and run, or whether re-tuning is mandatory.

### Social dimension

This affects **operator self-efficacy**. If operators can confidently tune the system based on observable conditions, NH-1 is operationalized. If parameter changes have unpredictable effects, operators become reactive — they touch nothing because they fear consequences. The four-dial framework loses its value.

### Architectural dimension

Sensitivity must be measured. The architecture itself doesn't change; what changes is the operational documentation and the four-dial framework's confidence intervals.

### Security dimension

(See Issue #13.) Parameter sensitivity is a precondition for adversarial parameter manipulation. If the system is robust to ±20% parameter variation, attackers can't easily destabilize it through metric manipulation.

### Protocol dimension

Each of the 12 parameters interacts with specific mechanisms:

| Parameter | Interacts with |
|---|---|
| INERTIA_DURATION | LTP, vitality, eviction |
| RECENCY_HALF_LIFE | Vitality, eviction, decay |
| DECAY_GAMMA | All weights, all admission decisions |
| T_INIT, T_MIN, T_COOLING | Annealing, exploration |
| EPSILON | First-hop randomization |
| LOOKAHEAD_ALPHA | Two-hop lookahead |
| MAX_SYNAPTOME_SIZE | All admission decisions |
| HIGHWAY_PCT | Synaptome diversity, transit hub identification |
| GEO_BITS | Bootstrap, S2 prefix |
| MAX_HOPS | Iterative fallback termination |

### Design roadmap

**Phase 10A: One-Factor-At-a-Time (OFAT) sensitivity sweep**

For each of the 12 parameters, vary ±20% and ±50% from default. Run the standard benchmark suite at 25K nodes. Record:

- p50, p95, p99 lookup latency
- Lookup success rate
- Pub/sub delivery rate
- Synaptome stability
- Temperature distribution

Identify parameters where ±20% causes > 10% degradation in any metric. These are "high-sensitivity" parameters and need narrow operator dial bounds.

**Phase 10B: 2D interaction sweep**

For all 66 parameter pairs, vary jointly across a 5×5 grid. Identify pairs that show strong interactions (joint variation effects > sum of individual effects). These pairs need to be co-tuned.

**Phase 10C: Scale-dependent sensitivity**

Repeat OFAT at 1K, 10K, 50K nodes. Identify parameters whose optimal values shift with N. These need scale-aware defaults in the four-dial framework.

**Phase 10D: Workload-dependent sensitivity**

Repeat OFAT under three workloads: uniform-lookup, Zipf-pub/sub, Slice-World. Identify parameters whose optimal values shift with workload. These need workload-aware defaults.

**Phase 10E: Robustness validation**

For the four operator dial profiles (low/medium/high churn, all-browser/mixed/server-heavy, message-queue/interactive/real-time, single-region/continental/global), verify that ±20% parameter perturbations within each profile do not cause network failure (success rate < 90%).

### Deployment roadmap

| Step | Duration | Gate |
|---|---|---|
| OFAT sensitivity sweep | 1 week | Sensitivity catalog produced |
| 2D interaction sweep | 2 weeks | Interaction matrix produced |
| Scale-dependent sensitivity | 1 week | Scale-aware defaults validated |
| Workload-dependent sensitivity | 1 week | Workload-aware defaults validated |
| Robustness validation against perturbation | 0.5 weeks | All dial profiles robust to ±20% |
| Update operator dial framework with confidence bounds | 0.5 weeks | Framework documents sensitivity |

### Acceptance criteria

1. No single parameter ±20% from any operator dial default causes > 10% latency degradation or > 2% success rate drop
2. Strong parameter interactions documented and reflected in dial framework
3. Scale-aware and workload-aware defaults documented and validated
4. Operator can change any one parameter ±20% in production without consulting protocol engineering

### Cross-references

- **Existing red team item:** none directly
- **Prior art:** classical experimental design (Box, Hunter, Hunter)
- **Related issues:** #6 (heterogeneous churn requires per-node parameter adaptation), #13 (adversarial tuning requires parameter robustness)

---

## Issue 11 — Temporal Pub/Sub Cache Semantics Under Partition

**Severity:** Medium
**Category:** Correctness
**Affected layer:** Replay cache, re-subscribe, partition recovery
**Deploy blocker:** No

### Description

The bounded replay cache on every relay is designed to recover from transient churn. Under a network partition lasting longer than the cache retention window, semantics become undefined:

1. **Diverged caches.** West-side relays accumulate publishes during the partition; East-side relays accumulate different publishes. On heal, subscribers crossing the boundary in re-subscribe receive their new relay's cache, missing the other side's accumulation.
2. **Cache overflow.** During an extended partition, a relay's bounded cache (default 100 messages) overflows. Older messages are dropped. On heal, subscribers re-subscribing miss the dropped middle.
3. **Replay ordering.** When a re-subscribe arrives, the relay replays from `lastSeenTs` forward. If multiple replays arrive (subscriber re-subscribes via different paths), the subscriber may receive duplicate or out-of-order messages.

NH-1's specification of replay semantics is incomplete:

- What happens when `lastSeenTs > cacheNewestTs`? (subscriber thinks they've seen messages that the relay never had)
- What happens when `lastSeenTs < cacheOldestTs`? (subscriber missed messages older than cache)
- How are duplicate publishes (same `publishId` arriving via different paths) deduplicated?

### Why this is medium-severity

For low-rate topics with stable subscribers, this rarely matters — the cache is mostly empty and sub/pub patterns are simple. For high-rate topics during partitions, the gaps become large and visible.

The deeper issue is that NH-1's claim of "100% recovered delivery under 5% churn" is measured under uniform distributed churn, not partition churn. A regional outage that disconnects 20% of the network for 10 minutes is not represented in the simulator's churn model.

### Social dimension

User-facing manifestation is **"after the regional outage, my message history is incomplete and inconsistent across devices."** For a chat or social workload, this is annoying but tolerable. For coordination workloads (the privacy-first use case), missing messages are mission-critical.

### Architectural dimension

The replay cache is a **per-relay** data structure. Under partition, relays drift independently. There is no synchronization on heal. The "first re-subscribe wins" semantics make consistency dependent on routing path, not a designed property.

### Security dimension

**Replay-cache divergence as forensic evidence.** An attacker who partitions a network deliberately and then heals can, with knowledge of cache semantics, reconstruct partial history of any relay. (Limited threat — relays don't carry sensitive data — but worth noting.)

**Selective replay manipulation.** A Byzantine relay (Issue #7) can manipulate replays — send some messages, omit others — and claim "cache overflow." Distinguishing genuine overflow from malicious selection is impossible.

### Design roadmap

**Phase 11A: Cache age and gap signaling**

Each replay carries metadata:

```
{
  oldestMessageTs: Timestamp,  // oldest message in cache
  newestMessageTs: Timestamp,  // newest message in cache
  cacheCapacity: int,          // configured size
  cacheUtilization: int,       // current count
  gapsDetected: bool           // whether cache had any overflow event
}
```

Subscriber sees this metadata on every replay. If `lastSeenTs < oldestMessageTs`, subscriber knows there's a gap and can attempt to fetch from another relay path.

**Phase 11B: Multi-source replay reconciliation**

For topics with MaxDisjoint replication (Issue #5 Phase 5D), subscriber can re-subscribe to multiple replicas in parallel. Each replica returns its own replay; subscriber merges and deduplicates by `publishId`.

**Phase 11C: Partition-aware retention**

When a relay observes partition signals (high rate of failed forward attempts), increase cache retention temporarily. Allows post-partition recovery to span longer windows.

**Phase 11D: Replay-completeness signaling to publisher**

Subscribers periodically report their highest `publishId` to the publisher (lightweight, low-rate). Publisher tracks which subscribers are caught up. Stale subscribers can be alerted.

### Deployment roadmap

| Step | Duration | Gate |
|---|---|---|
| Add cache metadata to replays | 1 week | Metadata visible |
| Implement multi-source replay reconciliation | 1 week | Subscribers correctly dedupe duplicates |
| Implement partition-aware retention | 1 week | Cache retention adjusts during simulated partition |
| Implement replay-completeness signaling | 1 week | Stale subscribers identified |
| Validate on partition-recovery scenario | 1 week | Post-heal delivery > 95% |

### Acceptance criteria

1. After a 10-minute regional partition with high publish rate, post-heal delivery rate > 95%
2. Subscribers correctly identify and signal cache gaps
3. Duplicate messages from multi-source replay are deduplicated 100%

### Cross-references

- **Existing red team item:** none directly
- **Related issues:** #5 (MaxDisjoint replication enables multi-source replay), #7 (Byzantine relays manipulate replay)

---

## Issue 12 — Concurrent Connection Setup Contention

**Severity:** Medium
**Category:** Friction
**Affected layer:** Browser transport
**Deploy blocker:** No (but combined with Issue #1, blocks browser deployment)

### Description

Real browsers have limits on concurrent network operations. Chrome limits concurrent ICE gathers; Firefox limits concurrent DTLS handshakes; mobile browsers throttle aggressively. A node firing 10 simultaneous connection attempts may have only 4 actually proceeding; the rest queue or fail silently.

NH-1's learning rules can trigger many simultaneous setups:

- Lateral spread cascades to 6 geographic neighbors
- Hop caching adds destination at every intermediate node on a path
- Annealing replacement fires on every routing hop with probability T
- Bootstrap iterates self-lookup + 8 inter-cell discoveries

Without throttling, the browser's concurrency pool saturates, all setups become slower, and learning rules effectively serialize.

### Design roadmap

(See Issue #1 Phase 1B — adaptive connection-setup throttling — which directly addresses this.)

Additionally:

**Phase 12A: Browser-aware concurrency cap**

Detect browser identity and adapt concurrency cap:

- Chrome desktop: 4 concurrent ICE
- Chrome mobile: 2 concurrent ICE
- Firefox desktop: 4 concurrent ICE
- Safari/iOS: 2 concurrent ICE

**Phase 12B: GC-pause tolerance**

Browser GC pauses (50–500 ms) can cause spurious RPC timeouts (Issue #2). Detect GC-induced timeouts (very short, regular pattern) and don't increment suspicion for these.

**Phase 12C: Tab-backgrounding handling**

When tab goes background, throttle outgoing connection setups to 1 concurrent. When tab returns to foreground, resume normal cap.

### Deployment roadmap

(Combines with Issue #1 deployment.)

### Acceptance criteria

1. Browser concurrency cap respected; no more than configured ICE attempts in flight
2. GC pauses do not cause synapse degradation
3. Backgrounded tabs maintain network presence at reduced rate

### Cross-references

- **Related issues:** #1 (sub-aspect)

---

## Issue 13 — Adversarial Operator Tuning Manipulation

**Severity:** Medium
**Category:** Operability / Security
**Affected layer:** Operator dial framework, parameter management
**Deploy blocker:** No

### Description

The four-dial framework (§11.2) makes NH-1 operable for non-experts. The dials map deployment profile (churn level, device class, latency profile, geographic span) to parameter values. Operators don't see raw parameters; they see profile choices.

This abstraction creates an attack surface: **the dials themselves can be manipulated**. If an attacker can convince an operator to set Dial 1 to "HIGH churn" (whether through false metrics, social engineering, or compromised dashboards), the operator unintentionally configures aggressive decay and faster forgetting — which benefits the attacker (their malicious synapses don't accumulate enough vitality history to be recognized as bad).

The attack surfaces:

1. **Metric manipulation.** Compromise the metrics pipeline so churn rates appear higher than reality
2. **Dashboard compromise.** Push false dial-recommendation alerts to trick the operator
3. **Social engineering.** Convince an operator that the network is in "HIGH churn" mode through external claims
4. **Insider threat.** A privileged operator deliberately misconfigures

### Why this is medium-severity

This is post-deployment. It requires the attacker to have already gained some position (either compromised metrics or operator trust). It is a residual risk, not a deploy-blocker.

### Social dimension

This is a **trust and audit** concern. Operators need to be able to verify dial settings against ground truth, not just dashboard inputs. Multiple operators should review parameter changes (4-eyes principle for any production change).

### Design roadmap

**Phase 13A: Parameter robustness (combines with Issue #10)**

Ensure the protocol is robust to ±20% parameter perturbation. An attacker cannot destabilize the network through dial manipulation if parameters in any dial profile are not catastrophically suboptimal.

**Phase 13B: Multi-source metric verification**

Important metrics (churn rate, latency creep, success rate) should be verifiable from independent sources. If the dashboard's churn rate disagrees with locally-measured churn rate from a sample of nodes, alert.

**Phase 13C: Audit log for parameter changes**

Every dial change is logged with: who made the change, when, what was changed, what metric drove the change. Multiple operators can review.

**Phase 13D: Slow rollout of parameter changes**

Parameter changes affect 10% of nodes for 1 hour. If metrics regress, automatic rollback. If stable, expand to 50% for 1 hour. Then 100%.

### Deployment roadmap

| Step | Duration | Gate |
|---|---|---|
| Validate parameter robustness | (tracked under Issue #10) | All dial profiles robust to ±20% |
| Implement multi-source metric verification | 2 weeks | Discrepancies detected |
| Implement audit log | 1 week | All dial changes logged |
| Implement canary rollout for parameter changes | 1 week | Rollback works correctly |

### Acceptance criteria

1. ±20% parameter perturbation within any dial profile does not cause network failure
2. Metric discrepancies between dashboard and local node measurements detected within 5 minutes
3. Parameter change audit log retained for 90 days, queryable
4. Failed parameter rollouts revert within 1 hour of detection

### Cross-references

- **Related issues:** #10 (parameter sensitivity is precondition for robustness)

---

## Deployment Readiness Matrix

For each issue, the recommended deployment posture:

| Issue | Status before fix | Status after fix | Recommended scale gate |
|---|---|---|---|
| #1 Connection setup friction | Cannot deploy on real WebRTC | Deploy after testnet validation | 1K-node testnet pass |
| #2 RPC timeouts | Pub/sub delivery claims unverifiable | Deploy after end-to-end ack | End-to-end ack rate > 95% |
| #3 Bandwidth saturation | Will fail on first viral content | Deploy after MaxDisjoint replication for high-value topics | Zipf workload at α=1.0 stable |
| #4 Latency jitter | 3δ floor claim unverifiable in production | Deploy after variance-aware AP scoring | Real WebRTC matches simulator within 30% |
| #5 S2 eclipse | Cannot deploy on open public network | Deploy on private/federated networks before fix | Vivaldi convergence + Sybil resistance test |
| #6 Heterogeneous churn | Regional service disparity | Deploy with global parameters initially; per-node adaptation post-launch | Regional p95 variance < 2× |
| #7 Byzantine relay hijacking | Cannot host high-value topics | Deploy with content-hash + reputation; full MaxDisjoint for high-value | High-value topics replicated |
| #8 Asymmetric reachability | Mobile-region service degradation | Deploy after asymmetric tracking | Lookup success ≥ 95% under asymmetric NAT |
| #9 Incoming synapse bias | Publisher synaptome degradation | Deploy with promotion cap | Publisher synaptome > 50% outbound-learned |
| #10 Parameter sensitivity | Operator confidence undefined | Document sensitivity; verify dial profiles robust | OFAT analysis complete |
| #11 Replay cache under partition | Regional partition recovery incomplete | Deploy with cache metadata; multi-source replay for high-value topics | Post-partition delivery > 95% |
| #12 Concurrent setup contention | Browser deployment will throttle | Deploy with browser-aware caps | Mobile and desktop browsers tested |
| #13 Adversarial operator tuning | Residual operational risk | Deploy with audit log + canary rollout | Multi-source metric verification operational |

---

## Summary

NH-1's research deck demonstrates that a vitality-driven, learning-adaptive DHT with axonal pub/sub achieves performance close to the analytical 3δ latency floor and recovers cleanly from churn and partition under simulator conditions. The protocol is the result of three years of iteration; the brain is production-ready.

The body is not. Of the thirteen issues catalogued in this document:

- **Four are deploy blockers** (Issues #1–4): connection setup friction, RPC timeouts, bandwidth saturation, latency jitter. All four are friction-modeling gaps in the simulator. Fixing them requires extending the simulator with realistic transport behavior and adapting the protocol's data structures to track the additional state (connection status, suspicion, load, variance). Estimated effort: 18–30 person-weeks, or 2–3 calendar months with one engineer.

- **Four are correctness-under-stress items** (Issues #5–8): S2 cell eclipse, heterogeneous churn, Byzantine relay hijacking, asymmetric reachability. These compromise the protocol's claimed properties under realistic adversarial or heterogeneous conditions but can be addressed during early deployment with staged rollout. Estimated effort: 22–32 person-weeks.

- **Five are hardening items** (Issues #9–13): incoming synapse bias, parameter sensitivity, replay cache semantics, concurrent setup contention, adversarial operator tuning. These can be addressed post-launch as the network scales. Estimated effort: 17–22 person-weeks.

**The recommended deployment path:**

1. **Months 1–3:** Address Issues #1–4 (deploy blockers). Validate on real WebRTC testnet at 1K nodes.
2. **Months 3–4:** Begin staged rollout to staging environment. Address Issue #10 (parameter sensitivity) measurement-only — document sensitivity, validate dial profiles.
3. **Months 4–5:** Address Issues #6, #8, #9 in parallel with staging soak test.
4. **Months 5–6:** Limited production release. Address Issues #5, #7, #11 for high-value topic support.
5. **Month 6+:** Production scale-out. Address Issues #12, #13 as operational hardening.

The brain is production-ready. The body becomes production-ready when these thirteen issues are systematically closed, in order, against measurable acceptance criteria. The simulator remains the primary lab bench for validating each fix before it ships.

---

## References

**Whitepaper** — `documents/Neuromorphic-DHT-Architecture.md` (companion repository, v0.67)
**Research deck** — `deck.md` (v0.3.38, simulator v0.69.00, 2026-04-30)
**Source + data** — `github.com/YZ-social/dht-sim`

### Architecture and friction
- Saltzer, Reed, Clark · *End-to-End Arguments in System Design* (ACM TOCS 1984)
- Ledlie, Gardner, Seltzer · *Network Coordinates in the Wild* (NSDI 2007) — Internet RTT variance characterization

### Foundational DHT work
- Maymounkov & Mazières · *Kademlia* (IPTPS 2002)
- Rowstron & Druschel · *Pastry* (Middleware 2001)
- Stoica et al. · *Chord* (SIGCOMM 2001)

### Latency-aware DHTs
- Dabek, Li, Sit, Robertson, Kaashoek, Morris · *Designing a DHT for low latency and high throughput* (NSDI 2004) — 3δ floor analysis
- Freedman, Freudenthal, Mazières · *Coral DSHT* (NSDI 2004)

### Adaptive coordinates
- Dabek, Cox, Kaashoek, Morris · *Vivaldi: A Decentralized Network Coordinate System* (SIGCOMM 2004)

### Byzantine resistance / route diversity
- Castro, Druschel, Ganesh, Rowstron, Wallach · *Secure Routing for Structured Peer-to-Peer Overlay Networks* (OSDI 2002) — constrained routing + secure ID assignment + redundant routing
- Harvesf, Blough · *The Design and Evaluation of Techniques for Route Diversity in Distributed Hash Tables* (IEEE P2P 2007) — MaxDisjoint replica placement
- Baumgart & Mies · *S/Kademlia* (ICPADS 2007)

### Load and hotspot mitigation
- Makris, Tserpes, Anagnostopoulos · *A novel object placement protocol for minimizing the average response time of get operations in distributed key-value stores* (IEEE BIGDATA 2017) — Directory For Exceptions

### Adaptive churn handling
- Mahajan, Castro, Rowstron · *Controlling the Cost of Reliability in Peer-to-peer Overlays* (IPTPS 2003)
- Krishnamurthy, El-Ansary, Aurell, Haridi · *A statistical theory of Chord under churn* (IPTPS 2005)
- Ghinita, Teo · *An Adaptive Stabilization Framework for Distributed Hash Tables* (IPDPS 2006) — local statistical estimation of (μ, λ, N)

### Pub/Sub
- Castro, Druschel, Kermarrec, Rowstron · *SCRIBE* (JSAC 2002)

---

*End of red team document. Total length ≈ 50 pages typeset.*

*Suggested next steps for the reader:*
1. *If you are deciding whether to deploy: Issues #1–4 are the gating questions. Until they are addressed, simulator measurements should not be treated as production predictions.*
2. *If you are planning a private or federated deployment: Issues #1–4 still apply, but Issues #5 and #7 can be deferred. Open public deployment requires #5 and #7.*
3. *If you are planning an engineering roadmap: the deployment readiness matrix above sequences the work; prioritize deploy blockers, then correctness, then hardening.*
4. *If you are an operator preparing for go-live: Issues #2, #3, #4, and #11 will be the most operationally visible. Familiarize with the diagnosis playbooks (whitepaper §13) before launch.*
