---
marp: true
theme: default
size: 16:9
paginate: true
header: "N/DHT — Neuromorphic Distributed Hash Tables"
footer: "v0.2.0 · 2026-05-02 · YZ.social"
style: |
  section {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 18px;
    line-height: 1.45;
    color: #222;
    background: #fdfdfb;
    padding: 44px 60px;
    overflow: hidden;
  }
  section p, section ul, section ol { margin: 0.4em 0; }
  section h1, section h2, section h3 {
    color: #1a1a2e;
    font-weight: 700;
    margin: 0.2em 0 0.3em 0;
  }
  section h1 { font-size: 32px; }
  section h2 { font-size: 20px; color: #2d7373; letter-spacing: 0.05em; text-transform: uppercase; font-weight: 600; }
  section h3 { font-size: 17px; }
  section.title h1 { font-size: 56px; line-height: 1.05; margin-bottom: 0.3em; }
  section.title h2 { color: #555; font-weight: 400; font-size: 22px; text-transform: none; letter-spacing: normal; }
  section.hero { text-align: center; }
  section.hero .number {
    font-size: 110px;
    font-weight: 800;
    color: #2d7373;
    line-height: 1.0;
    margin: 0.15em 0 0.05em 0;
    letter-spacing: -0.02em;
  }
  section.hero .number-sub {
    font-size: 20px;
    color: #555;
    font-weight: 400;
    margin-bottom: 1em;
    max-width: 80%;
    margin-left: auto;
    margin-right: auto;
  }
  blockquote {
    border-left: 3px solid #2d7373;
    padding: 0.3em 0 0.3em 1em;
    color: #444;
    font-style: italic;
    margin: 0.6em 0;
    font-size: 18px;
  }
  strong { color: #2d7373; }
  em { color: #555; font-style: italic; }
  table { font-size: 15px; border-collapse: collapse; margin: 0.5em 0; }
  th, td { padding: 5px 12px; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; }
  th { color: #555; font-weight: 600; }
  .hi { color: #2d7373; font-weight: 700; }
  .muted { color: #888; font-size: 14px; }
  .callout {
    color: #c4572b;
    font-style: italic;
    border-left: 3px solid #c4572b;
    padding-left: 12px;
    margin-top: 0.8em;
    display: block;
  }
  .principle {
    font-size: 18px;
    margin: 0.4em 0;
  }
  .principle strong { color: #2d7373; }
  section::after { color: #999; }
  header { color: #888; font-size: 11px; }
  footer { color: #888; font-size: 11px; }
---

<!-- _class: title -->

# N/DHT

## *Neuromorphic Distributed Hash Tables*

<br>

A peer-to-peer routing fabric for an open internet — fast, learning-adaptive, and owned by no one.

<br>
<br>

**David A. Smith** · YZ.social
davidasmith@gmail.com
<span class="muted">github.com/YZ-social/dht-sim</span>

---

## Why we are building this

> *"Those who would give up essential Liberty, to purchase a little temporary Safety, deserve neither Liberty nor Safety."* — **Benjamin Franklin**

<br>

**Privacy is the precondition for free expression and association.** A communication channel that always passes through a trusted intermediary leaks the *fact* of the conversation even when the contents are encrypted. Knowing *who talked to whom, when, from where* is, on its own, a powerful surveillance signal — used commercially for advertising, used institutionally for law enforcement and intelligence.

**End-to-end encryption is not enough.** Encryption protects message contents but not metadata. As long as the routing fabric belongs to a single party — a server, a federation, an ISP — that party retains visibility into the network's *shape*, and that visibility is itself the asset.

**A peer-to-peer routing fabric removes the custodian.** No server, no privileged peer, no trusted coordinator: the routing layer becomes a participant-symmetric primitive in which no one party has a privileged view of the traffic.

<span class="callout">**The DHT is the minimum viable substrate for that property.** Without it, every "decentralized" service is one trusted server away from being centralized again.</span>

---

## What's broken today

The internet is supposed to be a peer-to-peer network. **In practice it isn't.** Routing, naming, content delivery, and increasingly identity all flow through a small number of intermediaries. Every alternative tried so far has fallen into one of three traps:

| Approach | Examples | The trap |
|---|---|---|
| **Trust a custodian** | Twitter, Slack, Gmail, Cloudflare | Surveillance, censorship, single point of failure |
| **Federate the custodianship** | Mastodon, Matrix, ActivityPub | Server admins are the new custodians; problem moved, not solved |
| **Decentralize but accept ~2-second routing** | IPFS, BitTorrent, Ethereum devp2p | Real-time apps cannot live with multi-second lookups; ecosystem stalls |

<br>

**The result:** twenty years of effort, no privacy-respecting alternative to the custodial internet has emerged at scale. Real applications — messaging, social, identity, real-time collaboration, federated AI — keep choosing custodians because the alternatives are too slow or too fragile.

<span class="callout">**The substrate that would unblock all of these — fast, peer-to-peer, custodian-free — has not existed. We built it.**</span>

---

## What we believe

Six principles N/DHT is built on. Each is checkable in code; none is aspirational marketing:

<br>

<p class="principle"><strong>1. No custodian.</strong> No privileged node, no server, no trusted coordinator. The routing layer is participant-symmetric.</p>

<p class="principle"><strong>2. Fast enough to actually use.</strong> Real-time means sub-second. ~2-second lookups disqualify a protocol from messaging, voice, social, gaming, and live collaboration. Speed is not optional.</p>

<p class="principle"><strong>3. Adaptive, not static.</strong> The routing table learns from traffic. The protocol improves with use, not with manual tuning or operator intervention.</p>

<p class="principle"><strong>4. Built-in publish/subscribe.</strong> Many-to-many delivery is a primitive, not a layer. Every modern application needs broadcast.</p>

<p class="principle"><strong>5. Browser-native.</strong> Runs anywhere WebRTC runs. No special infrastructure, no servers to host, no operations to manage.</p>

<p class="principle"><strong>6. Public good.</strong> Open source, no proprietary lock, no token, no exit strategy. The protocol is owned by no one because that is the only configuration in which it can mean what it claims to mean.</p>

<span class="callout">**These are the values. The next slides are the engineering that delivers them.**</span>

---

## The protocol class: N/DHT

**N/DHT** is a new class of distributed hash tables in which **routing tables learn from traffic**.

Every peer maintains a *synaptome* — a bounded set of weighted connections to other peers. Each connection carries a vitality score (`weight × recency`). Successful routing reinforces the weights; unused connections decay. The routing table evolves toward the traffic the network actually carries, the way a cortical region's synaptic structure is shaped by the sensory input it processes.

<br>

| Element | What it is |
|---|---|
| **N/DHT** | The protocol class — neuromorphic learning applied to routing |
| **Synaptome** | The vitality-scored routing table at each node (≤ 50 connections) |
| **Vitality** | `weight × recency` — Hebbian-reinforced score; the single admission gate |
| **Axonal tree** | Built-in publish/subscribe primitive; routed subscribe + reverse-path multicast |
| **NH-1** | Current implementation (Neuro-Homeostatic v1); 12 rules, 12 parameters |

<br>

**Lineage:** twenty-five years of compounded routing research — Kademlia (2002) → Pastry / Tapestry (2001) → SCRIBE (2002) → eighteen named NX iterations → NH-1 (2026). Not invented from scratch; *consolidated* from existing work.

---

<!-- _class: hero -->

## It works

<div class="number">1.18×</div>

<div class="number-sub">The Dabek 3δ analytical lower bound for any recursive O(log N) DHT — measured at 50,000 nodes.</div>

**Dabek et al. (NSDI 2004) proved that any recursive O(log N) DHT has a hard latency floor**: total ≈ **3δ** where δ is the median pairwise one-way internet latency. The bound has stood unbeaten for twenty years.

| Property | Result |
|---|---|
| **Latency** | NX-17 at 1.18× the floor (within 36 ms of the analytical optimum at 50K nodes); NH-1 at 1.28×; Kademlia at 2.65× and *worsens with scale* |
| **Pub/sub delivery** | 100% baseline, 100% recovered after 5% churn — through routed re-subscribe alone, no replication, no gossip |
| **Partition healing** | Single-bridge connectivity dissolves into full network re-stitching via cooperative learning |
| **Geography-independent** | Strip the locality prefix entirely; learning still beats Kademlia by 26% |

<span class="callout">**Performance is no longer the obstacle. The substrate exists.**</span>

---

## What this enables

N/DHT is general-purpose infrastructure. Real-world applications across many domains:

<br>

| Domain | What N/DHT enables |
|---|---|
| **Privacy-respecting messaging** | Signal-class infrastructure with no central server — no metadata trail, no custodian to compel |
| **Decentralized identity** | DID/ENS routing without identity intermediaries; verifiable credentials peer-to-peer |
| **Social networks without platforms** | Pub/sub fan-out at internet scale, no host, no algorithmic curator |
| **Censorship-resistant publishing** | Partition-tolerant content distribution; survives ISP filtering and regional outage |
| **Real-time collaboration** | Sub-second updates for documents, code, design — no WebSocket-server stack |
| **Federated AI / agent coordination** | Discovery + low-latency messaging for autonomous agents — without the hyperscaler API |
| **IoT mesh and edge networks** | Browser-native routing at the edge; no infrastructure to deploy |
| **Decentralized commerce / settlement** | Routing primitive for peer-to-peer markets, not custodial exchanges |

<br>

<span class="callout">**The point is not any one of these. The point is the substrate that makes them all newly possible.**</span>

---

## Why this is real, not slideware

Five things separate N/DHT from the long tail of "decentralized" projects that never ship:

<br>

| | |
|---|---|
| **Twenty-five years of routing-research lineage** | Kademlia → Pastry → Tapestry → SCRIBE → NX-1 through NX-17 → NH-1. Each generation addressed one measured failure mode in its predecessor. The current protocol is the consolidation of every working idea, with the failed ones explicitly archived. |
| **Empirical validation, not promises** | 50,000-node open-source simulator (~25,000 lines of JavaScript). Every measurement in this deck is reproducible from a CSV in the public repository. |
| **Peer-reviewed proof** | 12-page IEEE conference paper documenting the 3δ-floor measurement. The first DHT in the published literature shown to operate at the analytical floor. |
| **Three independent red-team analyses** | Adversarial review of the protocol, the simulator, and the deployment story. Findings are public; deploy blockers are named, scoped, and time-estimated. |
| **Everything open** | Code, simulator, papers, red-team analyses, deck source, this pitch — all at <code>github.com/YZ-social/dht-sim</code>. No hidden component, no proprietary build. |

<br>

<span class="callout">**This is engineering with measurements, lineage, and falsifiable claims. It is not a roadmap built from hope.**</span>

---

## How it gets funded

N/DHT is **open-source and non-profit**. The funding model is deliberate:

<br>

- **No tokens.** The substrate cannot be owned and cannot be speculated on. A protocol that requires you to buy in to participate is not a public good.
- **No proprietary fork.** The reference implementation is the canonical implementation. There is no commercial-only version waiting in the wings.
- **No exit strategy.** This isn't an investment; there is no liquidity event. The success state is *the protocol becomes infrastructure*, like TCP/IP, HTTP, DNS, and Linux did.
- **Funders shape direction, not ownership.** Funding pays for engineering runway. The substrate stays public. Funders' priorities can shape *what gets built next*, not *who owns it after*.

<br>

**Why this funding model works:** every layer of internet infrastructure that became universal — TCP/IP, DNS, HTTP, Linux, the open-source CA system, the IETF process itself — was funded into existence as a public good *before* private capital colonized the layers above. The pattern is well-tested. The alternative (token-funded, equity-funded, or hyperscaler-funded routing) has never produced a substrate with the properties this project requires.

<span class="callout">**The ask is for runway, not equity. Funders welcome at any size — foundations, mission-aligned corporations, individual technologists.**</span>

---

<!-- _class: hero -->

## What we need

<div class="number">$10M</div>

<div class="number-sub">24 months of engineering runway. Becomes infrastructure no one owns.</div>

| Allocation | % | What it buys |
|---|---|---|
| **Production engineering** | 60 % | 2–3 senior protocol engineers; production hardening per the red-team Phase 1 deploy blockers; scale to 1 M-node simulator validation |
| **Reference applications** | 25 % | Three high-profile partner deployments — messaging, identity, agent coordination — demonstrating what becomes possible |
| **Developer ecosystem** | 15 % | SDKs, documentation, conference presence, integration partnerships with browsers and adjacent infrastructure |

**End state at 24 months:** production-grade reference implementation, three reference applications on real networks, 100,000+ nodes in active deployment, SDKs that let third parties build on the substrate.

<span class="callout">**Runway, not equity. Public good, not platform. Open at every layer.**</span>

---

## The substrate

| Layer | Year | What it enabled |
|---|---|---|
| **TCP/IP** | 1974 | Internet routing |
| **DNS** | 1983 | Name resolution |
| **HTTP** | 1990 | The web |
| **Linux** | 1991 | An open operating system for the world |

<br>

**Each became universal because it was built as a public good — open, ownerless, available to anyone.** Each was funded into existence by some combination of academia, government, foundation, and contributor labor *before* private capital arrived to build on top.

**The fifth substrate is the peer-to-peer routing fabric** the modern internet still does not have. It is what makes privacy-respecting messaging possible without a server. It is what makes decentralized identity possible without an intermediary. It is what makes federated AI possible without a hyperscaler. It is what makes social networks possible without a platform.

It needs to be funded the same way the first four were: as infrastructure that nobody owns and everybody can use.

<span class="callout">**That is what we are building. And what we are asking you to help build.**</span>
