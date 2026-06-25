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

## Caveats / next

- Churn of 15–50%/round (~3s rounds) is a stress ceiling, not a forecast. Relative
  gaps + root-thrash are the signal, not absolute %.
- ONE seed per condition. Repeat across seeds for publication-grade means.
- Missing condition that would complete the story: a stable node GUARANTEED to be
  the topic's closest (anchored relay) under churn — expected to hold high like the
  0/15% publisher-root case. That measures the upper bound of the "stable-root" fix.
