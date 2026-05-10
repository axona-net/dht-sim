/**
 * NeuromorphicDHTNX17 — publisher-prefix addressing + pure routed axonal tree.
 *
 * ── Migration status (v0.70.18 / refactor commit 12) ──────────────────────
 *
 * NX-17 is a RESEARCH/COMPARISON protocol; not migrated to the
 * Transport contract.  It inherits NX-15's legacy `nodeMap.get`-based
 * routing primitives (see NX-15's header for the full migration-status
 * note).  Production deployment uses NeuromorphicDHTNH1 exclusively.
 *
 * Tests confirm runtime parity with v0.70.16: AxonManager's
 * async-aware refactor is backward-compatible with NX-15/NX-17's sync
 * primitives.
 *
 * ── The two pieces ────────────────────────────────────────────────────────
 *
 * 1. **Publisher-prefix topic IDs.**
 *    NX-15 constructs topic IDs as a uniform 64-bit hash of the topic name.
 *    That works functionally, but whichever cell a random hash lands in is
 *    uncorrelated with the publisher, the subscribers, or any real-world
 *    locality — a chat group of US-east participants could find its root
 *    pinned to a cell in central Asia. NX-17 embeds the publisher's 8-bit
 *    S2 cell prefix in the topic ID, so:
 *
 *        topic_id = publisher.cell_prefix (8 bits) || hash_56(topic_name)
 *
 *    Publishers and subscribers agree on the prefix out-of-band (it is
 *    part of the topic name convention — the '@XX/domain/event' form
 *    handled by PubSubAdapter's topicIdForPrefixed). The tree root is
 *    then pinned into the publisher's own cell, typically close to the
 *    subscribers.
 *
 * 2. **Pure routed axonal tree — no K-closest replication.**
 *    NX-17 forces AxonManager's rootSetSize to 0, disabling the K-closest
 *    mode we experimented with and reverting to the original design:
 *
 *      • Subscribe = routeMessage(topicId, 'pubsub:subscribe'). The walk
 *        heads toward whichever node is XOR-closest to topicId. The first
 *        axon holding that topic on the path intercepts and adds the
 *        subscriber to its children; otherwise the terminal node opens a
 *        new role and becomes root.
 *
 *      • When an axon's direct-child count exceeds maxDirectSubs, the
 *        overflow subscriber is delegated to a sub-axon (recruited from
 *        an existing child or a routing peer). The tree grows toward
 *        subscribers as they arrive.
 *
 *      • Publish = routeMessage(topicId, 'pubsub:publish'). Same path,
 *        same first-axon-wins interception; the publish fans out
 *        through the tree.
 *
 *      • Churn resilience: every subscriber and every axon node
 *        periodically re-subscribes upstream. A subscribe whose
 *        sendDirect fails (parent dead) triggers an immediate
 *        re-subscribe via routeMessage, which walks around the dead
 *        node to a surviving path. Parents TTL-sweep children that
 *        haven't refreshed in maxSubscriptionAgeMs.
 *
 * ── What NX-17 deliberately does NOT do ───────────────────────────────────
 *
 * K-closest replication (K=5 root set, gossip of peer roots, send-to-all-K
 * publishing) is disabled. Earlier experiments showed the added complexity
 * did not consistently improve delivery under churn and introduced new
 * divergence modes between publisher and subscriber views. The current
 * design prioritises simplicity: one root per topic, grown by routing,
 * healed by re-subscription. Resilience mechanisms beyond that (e.g.
 * publisher-cached root + fast invalidation, child→grandparent
 * re-parenting, pre-emptive graceful-exit handoff) are intentionally
 * deferred until we have baseline numbers to identify which specific
 * failure modes dominate under churn.
 *
 * ── Implementation footprint ───────────────────────────────────────────────
 * Two lines of behavioural difference from NX-15:
 *   1. `usesPublisherPrefix = true` — tells the benchmark engine to emit
 *      '@XX/bench' topic names, activating PubSubAdapter's prefix path.
 *   2. `_membershipOpts.rootSetSize = 0` — forces AxonManager to take its
 *      routed code path rather than its K-closest code path.
 * All DHT routing, findKClosest, synaptome, and annealing logic is
 * inherited verbatim from NX-15 / NX-10 / NX-6.
 */

import { NeuromorphicDHTNX15 } from './NeuromorphicDHTNX15.js';

export class NeuromorphicDHTNX17 extends NeuromorphicDHTNX15 {
  static get protocolName() { return 'Neuromorphic-NX17'; }

  constructor(opts = {}) {
    super(opts);
    // Force AxonManager into routed mode: K-closest replication off.
    // _membershipOpts was set by NX-15's constructor from opts.membership;
    // we override rootSetSize unconditionally so UI / experiment params
    // cannot reintroduce K-closest behaviour for this protocol.
    this._membershipOpts = { ...this._membershipOpts, rootSetSize: 0 };
  }

  /**
   * Marker the benchmark engine reads to decide whether to emit prefixed
   * topic names ('@XX/…') or plain names.
   */
  get usesPublisherPrefix() { return true; }

  /**
   * Batch-adoption hook (AxonManager's pickRelayPeer). When an axon role
   * overflows past maxDirectSubs, AxonManager asks the DHT for an
   * EXTERNAL synaptome peer to become a new sub-axon. The parent then
   * partitions its existing children by XOR direction toward this new
   * peer and hands off the "in-direction" subset in a single
   * pubsub:adopt-subscribers message.
   *
   * Selection policy: XOR-closest synaptome-or-highway peer to the new
   * subscriber's id, excluding self, the forwarder, and anyone already
   * in role.children (we want a FRESH relay, not a promoted child). If
   * no suitable peer is found, return null and AxonManager falls back
   * to the legacy single-promote-from-children path.
   *
   * Why XOR-closest to the *new subscriber* rather than to, say, the
   * cluster's centroid: the new subscriber's id is the cheapest-to-
   * compute signal of "which geographic / ID-space direction is this
   * group growing toward." The partition step that follows naturally
   * collects all existing children whose ids point the same way.
   */
  _pickRelayPeer(node, role, subscriberId, forwarderId) {
    if (!node?.alive) return null;
    const selfHex = nodeIdToHex(node.id);
    const subBig  = topicToBigInt(subscriberId);

    const considered = new Map();   // hexId → { peer, distToSub }
    const consider = (peer) => {
      if (!peer?.alive) return;
      const hex = nodeIdToHex(peer.id);
      if (hex === selfHex)       return;
      if (hex === forwarderId)   return;
      if (hex === subscriberId)  return;
      if (role.children.has(hex)) return;     // exclude existing children
      if (considered.has(hex))    return;
      considered.set(hex, { peer, distToSub: peer.id ^ subBig });
    };

    // Walk synaptome + highway; both are candidate sources for a relay peer.
    for (const syn of node.synaptome.values()) consider(this.nodeMap.get(syn.peerId));
    if (node.highway) for (const syn of node.highway.values()) consider(this.nodeMap.get(syn.peerId));

    if (considered.size === 0) return null;

    // Pick the one closest in XOR to the new subscriber.
    let bestHex = null, bestDist = null;
    for (const [hex, rec] of considered) {
      if (bestDist === null || rec.distToSub < bestDist) {
        bestDist = rec.distToSub;
        bestHex  = hex;
      }
    }
    return bestHex;
  }
}

// Reused helpers from NX-15 — local shims since NX-17 needs them for
// _pickRelayPeer. Kept module-local to avoid widening NX-15's exports.
function topicToBigInt(v) {
  if (typeof v === 'bigint') return v;
  return BigInt('0x' + v);
}
function nodeIdToHex(id) {
  if (typeof id === 'string') return id;
  return id.toString(16).padStart(16, '0');
}
