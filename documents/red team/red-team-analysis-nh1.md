# Neuromorphic DHT Architecture & Simulation: Red Team Analysis (NH-1 Update)

**Date:** 2026-04-29
**Role:** Red Team / Network & Architecture Reviewer
**Target:** `dht-sim` (NH-1 Protocol & Engine Update)
**Reference:** `presentation/deck.md` (v0.3.30)

---

## 1. Executive Summary

This document serves as a follow-up "Red Team" evaluation of the Neuromorphic Distributed Hash Table (DHT) architecture, focusing specifically on the transition from the NX-17 predecessor to the newly consolidated **NH-1** protocol. 

Since the last evaluation, the project has made a dramatic and highly successful pivot toward architectural maintainability. By collapsing 18 specialized rules down to 12, and unifying five disparate admission/eviction mechanisms under a single **vitality** metric (`weight × recency`), NH-1 proves that the neuromorphic concepts can survive without fragile, over-tuned parameter sets. Furthermore, new ablation studies (`geoBits = 0`) honestly separate the learning algorithm's true performance from the "free" geographic locality provided by the S2 prefix.

**However, the fundamental environmental "cheats" of the simulation remain.** NH-1 still operates in a frictionless vacuum. Connections establish instantly, bandwidth is infinite, and failed RPCs resolve synchronously. The architecture is far cleaner now, which makes it an excellent foundation for production, but it has not yet been subjected to the messy, adversarial friction of the real internet.

This report evaluates the progress made, maps the remaining vulnerabilities ("The Dark"), and outlines the updated action plan for remediation.

---

## 2. Progress Since Last Assessment: The Light

The transition to NH-1 addresses one of the most critical unspoken vulnerabilities of NX-17: **architectural complexity.** A protocol that cannot be understood cannot be secured or maintained in production.

### 2.1. Unified Admission Gate (Vitality)
NX-17 relied on an interconnected web of stratified eviction floors, two-tier highway management, and adaptive decay to maintain network shape. NH-1 replaces this with a single, elegant `_addByVitality` mechanism.
*   **Why it's a win:** It prevents parameter over-fitting. A unified `weight × recency` score is robust, biologically grounded (synaptic tagging), and predictable. It trades a negligible performance hit (~10% latency gap vs NX-17 under heavy caps) for massive gains in maintainability.

### 2.2. Honest Isolation of Learning (geoBits = 0)
The team acknowledged the structural shortcut of the S2 cell prefix. By running `geoBits = 0` (stripping the geographic clustering) against identical canonical boot states, the deck explicitly proves that the LTP learning mechanism alone yields a 26% (NX-17) / 8% (NH-1) improvement over Kademlia.
*   **Why it's a win:** It separates the *claims* of the DHT. Locality is a bootstrap seed, but the learning algorithm is doing real work.

### 2.3. Explicit Documentation of Failure Modes
The `deck.md` openly calls out pub/sub failure modes: Forwarder loss under churn, tree rebuild costs, and gateway concentration. Acknowledging that the tree heals at the speed of the 10s refresh interval (rather than magically via gossip) is a crucial step toward production-readiness.

---

## 3. The Dark: Remaining Gaps & Vulnerabilities

While the *protocol* has improved significantly, the *environment* it is simulated in has not. All of the critical Phase 1 and Phase 2 friction vulnerabilities from the previous report remain unaddressed. If NH-1 were deployed over WebRTC today, it would likely collapse under connection friction.

### 3.1. The Frictionless Connection Fantasy (Unaddressed)
*   **The Assumption:** Nodes immediately use a peer for routing the moment they discover them.
*   **The Reality:** Real WebRTC requires ICE negotiation, STUN/TURN resolution, and DTLS handshakes. This introduces 1–3 seconds of blocking delay. 
*   **The Implication:** The `Slice World` test shows NH-1 elegantly unzipping a partitioned network by leveraging a single bridge node. In reality, the flood of new triadic closures over that bridge would trigger hundreds of simultaneous WebRTC connection attempts, causing massive head-of-line blocking and dropping the bridge node offline.

### 3.2. Asynchronous Black Holes & Lack of Timeouts (Unaddressed)
*   **The Assumption:** Route queries to dead nodes are skipped instantly.
*   **The Reality:** The network has no concept of a dropped packet or a 5-second RPC timeout. 
*   **The Implication:** The 100% pub/sub recovery under 5% churn looks perfect because the simulator knows *instantly* who is dead. In the wild, subscribers would wait multiple seconds for a dead relay to respond before falling back to re-subscribe, severely degrading the "graceful degradation" curve.

### 3.3. Gateway Concentration & Bandwidth Exhaustion (New/Persistent)
*   **The Assumption:** Hop cost is strictly geographic distance (`10ms + distance`).
*   **The Reality:** The "Highway %" presentation correctly models asymmetrical node capacities, but fails to penalize overloaded nodes. A highway node with a 256-synaptome acting as a gateway for 5,000 pub/sub messages will saturate its NIC buffer. 
*   **The Implication:** Because NH-1 routes purely on `(XOR distance * weight * latency penalty)`, and latency is static based on geography, the network will mercilessly hammer the "best" nodes until they drop packets.

### 3.4. Sybil Forgery & S2 Trust (Acknowledged, but Unmitigated)
*   **The Reality:** S2 prefixes are still completely unverified. 
*   **The Implication:** The presentation honestly flags this ("The S2 prefix is not a trust primitive"). However, until Proof-of-Location, Vivaldi RTT-clustering, or IP-ASN bounding is implemented, an attacker can trivially target and eclipse any geographic cell by forging the top 8 bits of their Node ID.

---

## 4. Updated Action Plan for Remediation

The simplification of NH-1 means the team is now perfectly positioned to tackle the environmental realities that were previously masked by NX-17's complexity. 

### Phase 1: Implement the "Real Internet" Sim (Highest Priority)
The simulator MUST be updated to stop flattering the protocol.
1.  **Introduce `CONNECTION_SETUP_MS (1500ms)`**: When `triadic closure`, `_hopCache`, or `lateralSpread` suggest a new synapse, it must sit in a `PENDING` state and cannot be used for `AP_score` routing until the setup delay elapses.
2.  **Introduce `RPC_TIMEOUT_MS (3000ms)`**: When a message is sent to a node that has silently dropped offline (churned), the sender must stall for 3 seconds before the `iterative_fallback` or next `AP_score` hop can be tried. 

### Phase 2: Implement Load-Based Penalties
1.  **Dynamic Latency / Congestion Penalty**: Modify the `HOP_COST_MS` formula. If a node is processing a high volume of `pubsubm` forwardings, its apparent latency should spike. This will naturally cause the AP routing metric (`½^(latency_ms / 100)`) to temporarily steer traffic *away* from congested gateways, allowing them to drain their buffers.

### Phase 3: Transition to Trustless Locality
1.  **Vivaldi RTT Coordinate Integration**: The presentation mentions Vivaldi as "future work." This should become the active research priority. Replacing the highly vulnerable S2 self-declared prefix with organically learned Vivaldi coordinates will provide Sybil-resistant locality clustering without trusting the peers.
2.  **Mitigate Pub/Sub Gateway Concentration**: Implement the proposed secondary splitting mechanism (from the deck's known failure modes) so that overloaded axon roots automatically fracture their children based on geographic/RTT coordinates to shed load.

---

**Conclusion:** 
The move from NX-17 to NH-1 is an architectural triumph of consolidation and simplicity. The "brain" of the DHT is now production-ready. The next step is to make sure it can survive in a body that experiences real physical friction.
