---
marp: true
theme: default
size: 16:9
paginate: true
header: "The Federated Nervous System"
footer: "v0.3.49 · 2026-05-06 · YZ.social"
style: |
  section {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 18px;
    line-height: 1.4;
    color: #222;
    background: #fdfdfb;
    padding: 48px 64px;
    overflow: hidden;
  }
  section p, section ul, section ol { margin: 0.4em 0; }
  section h1, section h2, section h3 {
    color: #1a1a2e;
    font-weight: 700;
    margin: 0.2em 0 0.25em 0;
  }
  section h1 { font-size: 36px; }
  section h2 { font-size: 22px; color: #2d7373; letter-spacing: 0.05em; text-transform: uppercase; font-weight: 600; }
  section h3 { font-size: 18px; }
  section.title h1 { font-size: 56px; line-height: 1.1; margin-bottom: 0.3em; }
  section.title h2 { color: #555; font-weight: 400; font-size: 24px; text-transform: none; letter-spacing: normal; }
  section.hero { text-align: center; }
  section.hero .number {
    font-size: 140px;
    font-weight: 800;
    color: #2d7373;
    line-height: 1.0;
    margin: 0.15em 0 0.05em 0;
    letter-spacing: -0.02em;
  }
  section.hero .number-sub {
    font-size: 22px;
    color: #555;
    font-weight: 400;
    margin-bottom: 1.2em;
    max-width: 80%;
    margin-left: auto;
    margin-right: auto;
  }
  strong { color: #2d7373; }
  em { color: #555; font-style: italic; }
  table { font-size: 15px; border-collapse: collapse; margin: 0.5em auto; }
  th, td { padding: 5px 12px; border-bottom: 1px solid #ddd; text-align: left; }
  th { color: #555; font-weight: 600; }
  .hi { color: #2d7373; font-weight: 700; }
  .muted { color: #888; font-size: 15px; }
  .callout {
    color: #c4572b;
    font-style: italic;
    border-left: 3px solid #c4572b;
    padding-left: 12px;
    margin-top: 1.2em;
  }
  .tagline {
    font-size: 26px;
    color: #1a1a2e;
    font-weight: 300;
    margin: 0.8em 0;
  }
  section::after { color: #999; }
  header { color: #888; font-size: 11px; }
  footer { color: #888; font-size: 11px; }
---

<!-- _class: title -->

# The Federated Nervous System

## *The Neuromorphic DHT*

<br>

A learning-adaptive routing protocol for the AI agent era.

<br>
<br>

**David A. Smith** · YZ.social
davidasmith@gmail.com
<span class="muted">github.com/YZ-social/dht-sim</span>

---

## The Mission

<p class="tagline"><strong>AI agents need to find each other.</strong></p>

<p class="tagline">Without a custodian. At internet scale. In real time.</p>

<br>

<p class="tagline">We built the protocol that does it.</p>

<br>

<span class="muted">Open-source. Non-profit. Built on twenty-five years of routing research, validated on a 50,000-node simulator, performing within 18% of the analytical lower bound.</span>

---

<!-- _class: hero -->

## The Problem

<div class="number">~2 seconds</div>

<div class="number-sub">Global lookup latency on the routing protocol every "decentralized AI" project ships today (Kademlia, ~1 M nodes).</div>

**Today, every AI interaction routes through 3–5 hyperscalers** — OpenAI, Anthropic, Google, Microsoft, Meta. Tomorrow, billions of autonomous agents will need to discover each other, exchange context, and federate work.

The choices today: trust a custodian, or accept multi-second latency that makes real-time impossible.

<span class="callout">**The AI federation has no nervous system. The substrate doesn't exist.**</span>

---

<!-- _class: hero -->

## Why Now

<div class="number">1 billion+</div>

<div class="number-sub">AI agents projected by 2030. Today: zero production-grade routing protocols designed for them.</div>

**Five forces converging in 2025–2026:**

1. **AI agent proliferation** — autonomous + assisted, billions within five years
2. **$50 B+ already invested in decentralized AI** (Bittensor, Gensyn, Ritual, Akash) — all bottlenecked on Kademlia-class routing
3. **Browser-native P2P** — WebRTC ships everywhere; agents run anywhere
4. **Trust collapse** — AI-generated content + surveillance erode custodial trust at the moment AI scale is exploding
5. **Cryptographic identity is solved** — every agent will have a key. The only missing primitive is *routing*.

<span class="callout">**Every prerequisite for the AI nervous system exists. The substrate is what's missing.**</span>

---

<!-- _class: hero -->

## The Solution

<div class="number">100%</div>

<div class="number-sub">Pub/sub baseline delivery. 100% recovered under 5% churn. No replication. No gossip. No parent tracking.</div>

**A routing protocol that learns.** Hebbian long-term potentiation — the brain's actual learning rule — applied to overlay routing. Every successful path strengthens; unused edges decay. The routing table evolves toward a traffic-shaped optimum.

<br>

**Two contributions to the AI stack:**

| | |
|---|---|
| **It IS an AI model.** | Weights, decay, reinforcement, synaptic tagging, plasticity — applied to routing decisions. The first DHT whose routing table *learns from traffic*. |
| **It's the substrate AI federation requires.** | Discovery, messaging, pub/sub for billions of agents. Built into the protocol, not layered on a custodial API. |

<span class="callout">**Browser-native. Open-source. Validated in a 50,000-node simulator.**</span>

---

<!-- _class: hero -->

## The Proof

<div class="number">1.18×</div>

<div class="number-sub">The Dabek 3δ analytical lower bound — within 36 ms of the theoretical optimum at 50,000 nodes.</div>

**Dabek et al. (NSDI 2004) proved a hard latency floor** for any recursive O(log N) DHT: total ≈ **3δ** where δ is the median pairwise one-way internet latency. The bound has stood unbeaten for twenty years.

| Protocol at 50 K nodes | × the floor |
|---|---|
| **Neuromorphic DHT (NX-17)** | **1.18×** |
| Neuromorphic DHT (NH-1, current) | 1.28× |
| Geographic DHT | 1.41× |
| **Kademlia** *(every existing decentralized AI project)* | **2.65×** *and worsens with scale* |

<span class="callout">**The first DHT measured at the floor. Performance is no longer the obstacle.**</span>

---

<!-- _class: hero -->

## The Market

<div class="number">$1T+</div>

<div class="number-sub">AI infrastructure annual spend projected by 2030. The opportunity isn't capturing share from a platform — it is becoming the protocol underneath.</div>

| Layer | Why we win |
|---|---|
| **AI agent infrastructure** ($1 T+ by 2030) | We are the missing routing primitive |
| **Decentralized AI compute** ($50 B+ today, 50 % YoY) | Bittensor / Gensyn / Ritual all on Kademlia today |
| **Decentralized identity** ($10 B+) | Every agent has an identity; needs routing |
| **Privacy-respecting messaging** ($5 B+) | Direct substitute for Signal-class infrastructure |
| **Federated learning + edge AI** | Currently impossible without a substrate |

<span class="callout">**TCP/IP, HTTP, DNS — none owned. The AI federation's nervous system should be the same.**</span>

---

<!-- _class: hero -->

## The Competition

<div class="number">0</div>

<div class="number-sub">Production-grade routing protocols at the analytical floor. Until now.</div>

| Class | Speed | Custodian | Adapts to traffic |
|---|---|---|---|
| Centralized AI APIs (OpenAI, Anthropic) | fast | **YES** | n/a |
| Kademlia DHTs (IPFS, BitTorrent, Ethereum) | ~2 s | none | no |
| "Decentralized AI" stacks (Bittensor, Gensyn, Ritual) | ~2 s *(inherits)* | partial | no |
| Federated platforms (Mastodon, Matrix) | server-bound | **YES** | no |
| **Neuromorphic DHT** | **~250 ms** | **none** | **YES** |

**The moat:** twenty-five years of compounded routing research — Kademlia → Pastry → Tapestry → SCRIBE → NX-17 → NH-1 — performing at the analytical floor, open-source for adoption velocity.

---

<!-- _class: hero -->

## The Roadmap

<div class="number">18 months</div>

<div class="number-sub">From research-grade today to production-grade NH-1 in deployment. Milestones defined and falsifiable.</div>

| Phase | Duration | Outcome |
|---|---|---|
| **Now** | — | 50K-node simulator, IEEE paper, three red-team analyses, all open-source |
| **0–6 months** | 6 mo | Production hardening — connection-setup model, RPC timeouts, bandwidth (red-team Phase 1 deploy blockers) |
| **6–12 months** | 6 mo | Three reference applications: agent registry, agent-to-agent messaging, federated-learning coordination |
| **12–18 months** | 6 mo | SDKs, browser integration, developer ecosystem |
| **18–36 months** | 18 mo | 100K+ nodes in production; first commercial pilots in regulated industries |

<span class="callout">**Phase 1 deploy-blocker work is scoped at 6–8 weeks for two engineers.** The path to production is short, scoped, and starts with falsifiable milestones.</span>

---

<!-- _class: hero -->

## The Vision

<div class="number">4</div>

<div class="number-sub">Substrate layers, none owned by any single party.</div>

| Layer | Year | What it enabled |
|---|---|---|
| **TCP/IP** | 1974 | Internet routing |
| **DNS** | 1983 | Name resolution |
| **HTTP** | 1990 | The web |
| **Linux** | 1991 | Open-source operating systems |

<br>

**The 5th is the AI federation's nervous system.** That's what we're building.

<span class="callout">**The alternative is the same five hyperscalers that own AI compute owning AI routing.** That outcome is the one this project exists to prevent. Privacy and intelligence — both built into the routing fabric, not bolted on after.</span>

---

<!-- _class: hero -->

## The Ask

<div class="number">$10M</div>

<div class="number-sub">24 months. Becomes infrastructure no one owns.</div>

<br>

| Allocation | % | What it buys |
|---|---|---|
| **Production engineering** | 60 % | 2–3 senior protocol engineers, scaled simulator, deploy-blocker mitigation, 1 M-node validation |
| **Reference applications** | 25 % | Three high-profile partner deployments demonstrating what becomes possible |
| **Developer ecosystem** | 15 % | SDKs, documentation, conference presence, ecosystem partnerships |

<br>

**Open-source. Non-profit. Funding becomes a public good** — like TCP/IP, HTTP, DNS, and Linux were before private capital colonized the layers above. The AI federation deserves the same architectural commitment.

<span class="callout">**Without a public-good substrate, the same five hyperscalers will own routing too. Fund the alternative now, while it's still possible.**</span>
