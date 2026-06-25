# Relay-poor + churn experiment — results (2026-06-25, kernel v4.2.2)

Harness: `harness/relay-churn-experiment.mjs` (real shipped kernel over SimNetwork).
Question (David): the live testnet is stable at near-zero churn with mostly web
apps — but mobile will outstrip relays and most users can't host relays. Does the
routing-only **single emergent root** survive high churn without stable relays, or
is today's stability relay-propped?

Config: N=36 churning subscriber peers, SUBS=30, K=12, 12 rounds, refresh 1200ms,
~3.2s re-convergence window/round. Churn = X% of live subscribers replaced each
round (transport.stop → died-handlers → peers route around; fresh peers join +
re-subscribe). Relays = always-on `host()` keyspace nodes that never churn. One
always-on measurement publisher (does not keyspace-host). Root read directly off
every live peer's `role.isRoot` (sim → exact). ONE run per condition (high variance;
mean%/distinct-roots/rootmix are the robust signals, not dip/recover).

| relays | churn/round | mean% | min% | distinct roots | root changes | root class |
|--------|-------------|-------|------|----------------|--------------|------------|
| 0      | 0%          | 100   | 100  | 1              | 0            | web peer   |
| 0      | 15%         | 74    | 51   | 1              | 0            | publisher (stable) |
| 0      | 30%         | 49    | 3    | 5              | 4            | web peer   |
| 3      | 30%         | 54    | 0    | 6              | 7            | web peer   |
| 0      | 50%         | 40    | 0    | 8              | 7            | web peer   |
| 3      | 50%         | 41    | 0    | 8              | 7            | web peer   |

## Findings

1. **Low churn needs no relay.** Relay-poor / 0% churn → 100% delivery, ONE stable
   root, and that root is a **web peer**. A long-lived tab is a fine root. This
   explains the live testnet's stability without crediting relays.

2. **Churn degrades the single root sharply** — relay-poor 30% → 49% mean (min 3%),
   the root thrashes across 5 distinct nodes. The fragility is real (measured, not
   asserted): once the root's host churns faster than the mesh re-converges,
   delivery craters.

3. **Adding 3 relays did NOT help** (30%: 54 vs 49; 50%: 41 vs 40), and the root
   stayed a **web peer in every relayed run** — the relays never won root. WHY:
   root = the node XOR-closest to the topicId. Three keyspace-hosting relays are
   closest to only a thin slice of the region's topic space; for an arbitrary topic
   the closest live node is almost always one of the 30+ web peers. So scattered
   relays don't anchor an arbitrary topic.

4. **The lever that worked was a STABLE root, not "relays."** In the 0/15% run the
   publisher happened to be XOR-closest and never churned → delivery held at 74%
   with ZERO root changes; the dips were only subscribers missing during their own
   join window, not root loss. Stability comes from the root not churning.

## Implications

- **Relays only anchor a topic if they're the closest node to it.** On testnet they
  appear to root everything only because they're a *large fraction* of all nodes
  right now. At mobile-majority scale that fraction → ~0, so relays would rarely be
  closest and would **not** anchor — "add relays" is not a churn fix.
- This also bounds **v4.2.2 keyspace-hosting**: it makes a relay KEEP a role it won,
  but relays rarely win an arbitrary topic, so it does little under churn. Correct,
  but not the lever.
- The real levers (none shipped): (i) **bias root election toward stable/hosting
  nodes** so a hosting relay is preferred as root for topics near it even when a
  transient peer is marginally closer; (ii) **root replication** (k-closest replica
  set, warm successor) so a single churn doesn't lose the root; (iii) churn-matched,
  event-driven failover (current 60s renew >> mobile churn).

## Update (2026-06-25, later) — stability-weighted root election

Added `MODE` (baseline | closest | stable | protect | stablehost), Lindy churn,
and a global age oracle to probe whether electing the root by **stability** (not
pure XOR-closeness) removes the churn fragility without relays.

| mode | what it does | mean% (relay-poor, 30% Lindy) |
|---|---|---|
| baseline | root = XOR-closest terminus (stock) | 50–56 |
| closest | hint everyone → XOR-closest | 59 |
| stable | hint everyone → most-stable in K-closest band | **46** (worse) |
| protect | exempt the natural root from churn | **77** (min 47, root-changes 1) |

**Key finding 1 — a durable root is the cure (protect: 50→77%, thrash 5→1).**
Root-thrash is the dominant loss; the residual 23% is subscriber churn-in.

**Key finding 2 — you cannot relocate the root by hinting.** `stable` was *worse*
because the kernel binds `root ≡ XOR-closest terminus`: `_topicDecision` only lets
a node act as root for a `via[0]=self` message if it ALREADY holds the role, else
it rerolls to the closest node. So a hint toward a non-closest stable node can't
make it root — it just adds a popped hop + instability. Electing a stable root
needs the node to actually HOLD a role (via `host()`) AND be hinted — tested as
`stablehost` (result: _[fill]_), which is the faithful mechanism using existing
primitives (no new invariant).

Design model: `axona-docs/architecture/Pubsub-Stability-Root-Election-v0.1.md`.

## Update 2 (2026-06-25) — REPLICATED (5 reps): root election is NO-GO

Single-seed delivery% turned out wildly noisy (protect read 77% one run, 53% the
next). Replicated, relay-poor, 30% Lindy churn, 5 reps each:

| mode | delivery% | min-floor% | root-changes |
|---|---|---|---|
| baseline | 48 ± 8 | 4 | 3.8 ± 2.6 |
| protect (durable root) | 52 ± 7 | 17 | 1.4 ± 1.0 |
| stablehost (host+hint mechanism) | 44 ± 1 | 0 | 6.0 ± 1.3 |

**A perfectly stable root barely moves average delivery (48→52%, within sd).** It
stabilises the root (changes 3.8→1.4) and helps the worst rounds (floor 4→17%), but
the bulk of the loss is elsewhere → **subscriber churn-in**, not root-thrash. The
`stablehost` mechanism was *worse*. **Decision: do NOT build stability-weighted root
election** — eclipse-sensitive invariant change for ~4 pts inside the noise.
**Pivot → replay-on-join** (reliable history pull on (re)subscribe) + faster
re-attach. See `axona-docs/architecture/Pubsub-Stability-Root-Election-v0.1.md` §9.

Methodology lesson: single-seed sim deliveries are noise; require REPS≥5 mean±sd
before any conclusion. (I twice over-claimed off one run before repping.)

## Update 3 (2026-06-25) — ROOT CAUSE FOUND + FIX VALIDATED: subscription continuity

Instrumented each missed message: (a) tenure of the missing subscriber, (b) is it
SEATED in the current root's subscriber set, (c) added per-round routing-table
maintenance (`MAINTAIN`, the kernel peer-learning analog) to remove a frozen-table
confound. Findings (relay-poor, 30% Lindy churn, real kernel):

- Maintaining routing tables did **not** help (46% vs frozen 48%) → not a routing-
  table-staleness problem.
- **93% of misses are ORPHANED** — the subscriber is NOT in the current root's
  subscriber set at publish time; only 7% are seated-but-undelivered (true routing).
  Missers are systematically the *tenured* subscribers (28s vs 8s received).
- Mechanism: when the root changes (or a renewal lapses), existing subscribers were
  seated at the OLD root; the new root doesn't know them until they re-home. Fresh
  (re)subscribers are always seated at the current root → they receive.
- **FIX VALIDATED (`REHOME`): re-seat every live subscriber at the current root each
  round → delivery 41% → 91%±7**, misses 726 → 107, with root-thrash *unchanged/higher*
  (5.7 vs 4.7). The win is 100% subscription continuity, 0% root stabilization.

**The lever is keeping subscribers seated across root change — NOT root election, NOT
relays, NOT stable routing tables.** Kernel directions (all low-risk, no eclipse/
invariant change): (1) event-driven re-home — a subscriber re-subscribes to the
current root immediately on a root-change signal (the v4.1 root beacon already names
the root) instead of waiting for the `renewMs=60s` tick (≫ churn); (2) root-side
subscriber-set handoff on promotion (transfer subscribers to the successor, like
stamped-replay-up transfers history); (3) shorter renewMs. Caveat: `REHOME` re-seats
every ~4.7s (optimistic/periodic); event-driven would target the change moment.

## Caveats / next

- Churn of 15–50%/round (~3s rounds) is a stress ceiling, not a forecast. Relative
  gaps + root-thrash are the signal, not absolute %.
- ONE seed per condition. Repeat across seeds for publication-grade means.
- Missing condition that would complete the story: a stable node GUARANTEED to be
  the topic's closest (anchored relay) under churn — expected to hold high like the
  0/15% publisher-root case. That measures the upper bound of the "stable-root" fix.
