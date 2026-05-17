/**
 * NeuromorphicDHTNX15 — Membership-protocol pub/sub.
 *
 * ── Migration status (v0.70.18 / refactor commit 12) ─────────────────
 *
 * NX-15 is a RESEARCH/COMPARISON protocol kept available for ablation
 * against the production target NH-1 (N-DHT).  The structural
 * Transport-contract migration that NH-1 went through in commits 4-11
 * — recursive forwarding lookup, parallel lookahead probes, transport
 * notify for LEARN side-effects, transport-mediated pub/sub primitives
 * — has NOT been propagated to NX-15 (or its parent NX-10/NX-6).  NX-15
 * still uses the simulator's god's-eye `nodeMap.get(peerId)` path for
 * peer access.
 *
 * Why kept on legacy paths:
 *   - NX-15 / NX-17 are how we reproduce the v0.66.x and earlier
 *     benchmark series against the same simulator code.  Migrating
 *     them would mean re-validating those numbers under the new
 *     transport model, which is out of scope for the production
 *     deployment effort.
 *   - The AxonManager refactor (commit 10) is intentionally
 *     backward-compatible: AxonManager's `await this.dht.findKClosest`
 *     / `await this.dht.sendDirect` work fine with a sync return value
 *     (await of a non-Promise is a microtask no-op), so NX-15's
 *     existing sync primitives plug in cleanly.  Tests confirm parity:
 *     test_nx15_integration: 15 passed / 2 failed (matches baseline).
 *
 * Production deployment uses AxonaEngine exclusively.  All
 * V1+V2 cleanup, contract compliance, and observability work targets
 * NH-1.  See `documents/implementation/N-DHT-refactor-punchlist.md`
 * for the full violation tally and migration plan.
 *
 * ── Original design notes (preserved for context) ────────────────────
 *
 * Extends NX-10 (inheriting synaptome, routing-topology forwarding tree,
 * churn resilience, and every prior NX-N rule) and adds a real, self-
 * organising pub/sub membership protocol on top:
 *
 *   • Subscribe routes toward hash(topic); first live axon on the path
 *     catches it. If no axon exists, the closest-to-hash node becomes
 *     the root.
 *   • When an axon's direct-subscriber count exceeds maxDirectSubs,
 *     subsequent subscribes trigger recruitment of a sub-axon (the peer
 *     on the routing path that forwarded the subscribe).
 *   • Periodic refresh keeps the tree alive; TTL expiry + hysteresis
 *     dissolve keep it pruned.
 *   • Every axon member re-subscribes on every refresh interval; a
 *     silent axon is dropped by its parent's TTL sweep.
 *   • NX-15's pickRecruitPeer override prefers forward-progress
 *     synaptome peers with highest synapse weight — axon membership is
 *     long-lived, so LTP-trusted synapses are the right backbone.
 *
 * The membership protocol is implemented by AxonManager (in
 * src/pubsub/AxonManager.js), which is protocol-agnostic. NX-15's job
 * is to provide the four routing primitives AxonManager needs:
 *
 *     routeMessage(targetId, type, payload, opts)
 *     sendDirect(peerId, type, payload)
 *     onRoutedMessage(type, handler)
 *     onDirectMessage(type, handler)
 *
 * Plus two identity accessors:
 *
 *     getSelfId()
 *     getAlivePeer(id)
 *
 * The inherited pubsubBroadcast(relayId, targetIds) one-shot API is
 * preserved unchanged (so NX-10's benchmark numbers are reproduced by
 * NX-15). A future integration phase can add a new benchmark that uses
 * the membership protocol end-to-end via PubSubAdapter → AxonManager.
 */

import { NeuromorphicDHTNX10 } from './NeuromorphicDHTNX10.js';
import { AxonManager } from '../../pubsub/AxonManager.js';

// ── Identity conversions ────────────────────────────────────────────────────
//
// The sim's NeuronNode IDs are BigInt; the adapter's topic IDs and subscriber
// IDs are 16-char lowercase hex strings. NX-15 converts at its boundary so
// every other layer stays untouched.

function topicToBigInt(topicId) {
  if (typeof topicId === 'bigint') return topicId;
  return BigInt('0x' + topicId);
}

function nodeIdToHex(id) {
  if (typeof id === 'string') return id;
  return id.toString(16).padStart(16, '0');
}

// ── NeuromorphicDHTNX15 ─────────────────────────────────────────────────────

export class NeuromorphicDHTNX15 extends NeuromorphicDHTNX10 {
  static get protocolName() { return 'Neuromorphic-NX15'; }

  constructor(opts = {}) {
    super(opts);

    // Per-node handler maps. Handlers are installed lazily when AxonManager
    // registers them for a given node.
    this._routedHandlers = new Map();  // NeuronNode → Map<type, handler>
    this._directHandlers = new Map();  // NeuronNode → Map<type, handler>

    // Per-node AxonManagers. Lazy-created on first pub/sub access so that
    // the cost is zero for nodes that never participate in a topic.
    this._axonsByNode = new Map();     // NeuronNode → AxonManager

    // Membership protocol parameters — inherited by every AxonManager we
    // create via axonFor(). The UI panel in index.html (id="nx15-panel")
    // controls these via Controls.getNX15Params() → main.js createDHT.
    // Any field left undefined uses AxonManager's default.
    this._membershipOpts = opts.membership || {};

    // sendDirect drain-loop state (see sendDirect docstring for rationale).
    this._sendQueue    = null;
    this._sendDraining = false;
  }

  // ── AxonManager lifecycle ───────────────────────────────────────────

  /**
   * Get (or lazily create) the AxonManager attached to `node`. `node` may
   * be the NeuronNode directly or its id (BigInt or hex string); the
   * returned AxonManager satisfies the PubSubAdapter transport contract.
   */
  axonFor(nodeOrId) {
    const node = this._resolveNode(nodeOrId);
    if (!node) throw Error(`NX-15: no live node for id ${nodeOrId}`);
    let axon = this._axonsByNode.get(node);
    if (axon) return axon;

    // Apply UI-tunable membership parameters; any field left undefined
    // falls through to AxonManager's compiled-in defaults.
    const m = this._membershipOpts;
    axon = new AxonManager({
      dht: this._nodeShim(node),
      maxDirectSubs:        m.maxDirectSubs,
      minDirectSubs:        m.minDirectSubs,
      refreshIntervalMs:    m.refreshIntervalMs,
      maxSubscriptionAgeMs: m.maxSubscriptionAgeMs,
      rootGraceMs:          m.rootGraceMs,
      rootSetSize:          m.rootSetSize,
      replayCacheSize:      m.replayCacheSize,
      // NX-15's override: prefer existing child that is also a high-weight
      // synapse of this node. Must return an existing child; never grows
      // the axon beyond maxDirectSubs.
      pickRecruitPeer: (role, meta, subscriberId) =>
        this._pickRecruitPeer(node, role, meta, subscriberId),
      // Subclass hook: if the subclass implements _pickRelayPeer, pass it
      // as AxonManager's pickRelayPeer (activates the batch-adoption
      // path). NX-17 implements this to return an external synaptome
      // peer; plain NX-15 leaves it undefined so AxonManager falls
      // through to the legacy single-recruit path.
      pickRelayPeer: (typeof this._pickRelayPeer === 'function')
        ? (role, subscriberId, forwarderId) =>
            this._pickRelayPeer(node, role, subscriberId, forwarderId)
        : null,
    });
    this._axonsByNode.set(node, axon);
    return axon;
  }

  /**
   * Clear per-topic pub/sub state on every AxonManager attached to this
   * DHT. Leaves synaptic weights, routing tables, and the AxonManager
   * instances themselves untouched — only the axon trees, subscriptions,
   * replay caches, and dedup sets are zeroed.
   *
   * Used by the benchmark runner to guarantee each pub/sub test starts
   * from an independent, clean state, while keeping any pub/sub-driven
   * LTP training baked into the synaptomes.
   */
  resetAllAxons() {
    for (const axon of this._axonsByNode.values()) {
      axon.resetState();
    }
  }

  /**
   * Build the thin wrapper that exposes the four DHT primitives in the shape
   * AxonManager expects, with the node captured in closure.
   */
  _nodeShim(node) {
    const self = this;
    return {
      get nodeId()   { return nodeIdToHex(node.id); },
      getSelfId()    { return nodeIdToHex(node.id); },
      getAlivePeer(peerId) {
        const peer = self.nodeMap.get(topicToBigInt(peerId));
        return peer?.alive ? peer : null;
      },
      routeMessage(targetId, type, payload, opts) {
        return self.routeMessage(node, targetId, type, payload, opts);
      },
      sendDirect(peerId, type, payload) {
        return self.sendDirect(node, peerId, type, payload);
      },
      onRoutedMessage(type, handler) {
        self.onRoutedMessage(node, type, handler);
      },
      onDirectMessage(type, handler) {
        self.onDirectMessage(node, type, handler);
      },
      /** K-closest lookup — AxonManager uses this in K-closest mode. */
      findKClosest(targetId, K, opts) {
        return self.findKClosest(node, targetId, K, opts)
                   .map(peer => nodeIdToHex(peer.id));
      },
    };
  }

  _resolveNode(nodeOrId) {
    if (nodeOrId && typeof nodeOrId === 'object' && 'synaptome' in nodeOrId) {
      return nodeOrId;
    }
    return this.nodeMap.get(topicToBigInt(nodeOrId));
  }

  // ── Handler registries ──────────────────────────────────────────────

  onRoutedMessage(node, type, handler) {
    let table = this._routedHandlers.get(node);
    if (!table) { table = new Map(); this._routedHandlers.set(node, table); }
    table.set(type, handler);
  }

  onDirectMessage(node, type, handler) {
    let table = this._directHandlers.get(node);
    if (!table) { table = new Map(); this._directHandlers.set(node, table); }
    table.set(type, handler);
  }

  // ── K-closest lookup ────────────────────────────────────────────────

  /**
   * Return up to K nodes whose IDs are closest to `targetId` (as hex string),
   * using Kademlia-style iterative FIND_NODE over the local synaptome +
   * highway. Reuses the same algorithmic pattern as NX-6's addNode
   * iterative-lookup helper; returns bare NeuronNodes. K defaults to 5.
   *
   * This is the primitive the membership protocol (AxonManager K-closest
   * mode) uses to find the replicated root set for a topic: subscribe
   * STOREs at every node in the returned list, and publishers route to
   * any-of-K rather than one-true-closest. Making this function pre-
   * computes the root set in a single pass so the protocol can fan out
   * subscribe/publish without further iterative work.
   */
  findKClosest(sourceNode, targetId, K = 5, { alpha = 3, maxRounds = 40 } = {}) {
    const src = this._resolveNode(sourceNode);
    if (!src) return [];
    const targetBig = topicToBigInt(targetId);

    const candidates = new Map();   // BigInt id → NeuronNode
    const distances  = new Map();   // BigInt id → BigInt distance
    const addCandidate = (node) => {
      if (!node?.alive || candidates.has(node.id)) return;
      candidates.set(node.id, node);
      distances.set(node.id, node.id ^ targetBig);
    };

    // Seed with source node + ALL three of its routing tiers. Including
    // incomingSynapses (the reverse index) is important in LTP-
    // specialized networks where the outgoing synaptome is biased toward
    // frequently-used traffic. Incoming synapses provide backup reach
    // into sparsely-connected regions of the ID space — the same
    // technique NX-6's own _synaptomeFindClosest uses.
    addCandidate(src);
    const addTier = (tier) => {
      if (!tier) return;
      for (const syn of tier.values()) addCandidate(this.nodeMap.get(syn.peerId));
    };
    addTier(src.synaptome);
    addTier(src.highway);
    addTier(src.incomingSynapses);

    // Hybrid Kademlia FIND_NODE termination. Stop only when BOTH:
    //   (a) every node in the current top-K has been queried, AND
    //   (b) a full round of α probes added no new candidates.
    //
    // (a) alone was tighter than the original "pool saturated" check
    // but regressed in LTP-specialized (post-warmup) networks: the
    // top-K can get pinned to nodes whose sparse routing tables don't
    // reach the true closest region, so we terminate on a local optimum.
    //
    // (b) alone was the original criterion — exhausts the reachable
    // pool but doesn't guarantee the top-K are all probed, so two
    // starting positions can return slightly different top-K sets.
    //
    // Requiring BOTH: if top-K is visited AND expansion has saturated,
    // we've truly converged. If top-K is visited but expansion still
    // finding things, we keep going (covers the warmup-specialized
    // case). If expansion saturated but top-K isn't all visited,
    // the unvisited candidates keep being picked next round.
    const visited = new Set();
    let lastPoolSize = 0;
    let stableRounds = 0;
    for (let round = 0; round < maxRounds; round++) {
      const sortedCands = [...candidates.values()]
        .sort((a, b) => distances.get(a.id) < distances.get(b.id) ? -1 : 1);
      const topK = sortedCands.slice(0, K);
      const topKAllVisited = topK.every(n => visited.has(n.id));

      // Pick α unvisited — prefer top-K first, then broader pool.
      let toQuery = topK.filter(n => !visited.has(n.id)).slice(0, alpha);
      if (toQuery.length < alpha) {
        const remaining = alpha - toQuery.length;
        const beyond = sortedCands.filter(n => !visited.has(n.id) && !topK.includes(n)).slice(0, remaining);
        toQuery = toQuery.concat(beyond);
      }
      if (toQuery.length === 0) break;                   // fully exhausted

      for (const peer of toQuery) {
        visited.add(peer.id);
        // v0.66.07: simulate the wire FIND_NODE response. In a real
        // Kademlia, the response is bounded by the BUCKET SIZE (this._k,
        // typically 20), NOT the caller's requested K. The caller asks
        // for K=5 globally-closest, but each peer responds with their
        // top-_k=20 because that's the standard FIND_NODE primitive
        // (K-DHT does exactly this: `peer.findClosest(target, this.k)`).
        //
        // v0.66.06 used K (caller's 5) as the per-peer bound, which was
        // too small — convergence quality dropped (full-converge 99.4
        // → 98.6, local-2000km 99.9 → ~72%). Using this._k restores
        // convergence while keeping the iterative pool naturally
        // bounded (~k per peer per round, not full synaptome).
        this._addPeerTopKToCandidates(peer, this._k, targetBig, addCandidate);
      }

      const grew = candidates.size > lastPoolSize;
      lastPoolSize = candidates.size;
      stableRounds = grew ? 0 : stableRounds + 1;
      // Terminate only when top-K is fully probed AND pool is stable
      // for one full α-round. That rules out both "top-K trapped at
      // local optimum" and "pool saturated before top-K converged".
      if (topKAllVisited && stableRounds >= 1) break;
    }

    return [...candidates.values()]
      .sort((a, b) => distances.get(a.id) < distances.get(b.id) ? -1 : 1)
      .slice(0, K);
  }

  /**
   * Simulate a FIND_NODE RPC response from `peer`: peer reports its K
   * closest peers to `targetBig` from its OWN local view (synaptome +
   * highway). Inserts those K nodes into the caller's candidate pool
   * via `addCandidate`. This is the bounded wire response a real
   * Kademlia client would send — not a full routing-table dump.
   *
   * Insertion-sort into a fixed-size top-K array. Cheap because K is
   * small (typically 5) and peer's tiers are bounded by the cap.
   */
  _addPeerTopKToCandidates(peer, K, targetBig, addCandidate) {
    const top = [];   // sorted asc by dist; size <= K
    const consider = (syn) => {
      const node = this.nodeMap.get(syn.peerId);
      if (!node?.alive) return;
      const d = node.id ^ targetBig;
      if (top.length < K) {
        let i = 0;
        while (i < top.length && top[i].d < d) i++;
        top.splice(i, 0, { node, d });
      } else if (d < top[K - 1].d) {
        let i = 0;
        while (i < top.length && top[i].d < d) i++;
        top.splice(i, 0, { node, d });
        top.pop();
      }
    };
    for (const syn of peer.synaptome.values()) consider(syn);
    if (peer.highway) for (const syn of peer.highway.values()) consider(syn);
    for (const { node } of top) addCandidate(node);
  }

  // ── Greedy single-step routing ──────────────────────────────────────

  /**
   * Return the NeuronNode we should forward toward `targetId` from `node`,
   * or `null` if `node` itself is closest (terminal). Walks synaptome and
   * highway tiers; picks the peer whose XOR distance to the target is
   * strictly smaller than `node`'s own.
   *
   * This is the single-step primitive lifted out of NX-10's lookup inner
   * loop (sans the two-hop lookahead scoring, which is a lookup-quality
   * optimisation and not needed for protocol-level routed messaging).
   */
  _greedyNextHopToward(node, targetId) {
    if (!node?.alive) return null;
    const target = topicToBigInt(targetId);
    let best = null;
    let bestDist = node.id ^ target;

    for (const syn of node.synaptome.values()) {
      const peer = this.nodeMap.get(syn.peerId);
      if (!peer?.alive) continue;
      const d = syn.peerId ^ target;
      if (d < bestDist) { bestDist = d; best = peer; }
    }
    if (node.highway) {
      for (const syn of node.highway.values()) {
        const peer = this.nodeMap.get(syn.peerId);
        if (!peer?.alive) continue;
        const d = syn.peerId ^ target;
        if (d < bestDist) { bestDist = d; best = peer; }
      }
    }
    return best;
  }

  /**
   * Cheap 2-hop "is anyone closer than me?" check used by routeMessage's
   * terminal-globality verification. Answers: "from this terminal node,
   * does any of my 1-hop peers know about a 2-hop peer that's closer to
   * target than I am?"
   *
   * v0.66.06: restructured as an explicit per-peer query to make the
   * simulator's intent match real-network semantics. For each 1-hop peer
   * p1, we simulate p1's response to a "what's your closest to target?"
   * query — p1 reports its single best 2-hop candidate from p1's own
   * routing table. We then take the minimum across all p1 responses.
   *
   * Mathematically equivalent to the previous flat-loop implementation
   * (min over (p1, p2) pairs == min over p1 of (min over p2 in p1's
   * synaptome)), but the structure now explicitly reflects the bounded
   * wire-RPC pattern, making it obvious that we're not reading peer
   * memory directly. Same cost as before; this is a clarity refactor.
   */
  _findCloserInTwoHops(node, targetId) {
    const target = topicToBigInt(targetId);
    const myDist = node.id ^ target;
    let bestPeer = null;
    let bestDist = myDist;

    // For each 1-hop peer p1, ask: "what is p1's single closest peer to
    // target?" (bounded RPC response). Tracks p1's response separately
    // so the loop structure mirrors the wire pattern.
    const queryP1 = (p1) => {
      let p1Best = null, p1BestDist = null;
      const considerSyn = (syn2) => {
        if (syn2.peerId === node.id) return;     // self-loop
        const d2 = syn2.peerId ^ target;
        if (p1BestDist !== null && d2 >= p1BestDist) return;
        const p2 = this.nodeMap.get(syn2.peerId);
        if (!p2?.alive) return;
        p1BestDist = d2;
        p1Best = p2;
      };
      for (const syn2 of p1.synaptome.values()) considerSyn(syn2);
      if (p1.highway) for (const syn2 of p1.highway.values()) considerSyn(syn2);
      if (p1Best && p1BestDist < bestDist) {
        bestDist = p1BestDist;
        bestPeer = p1Best;
      }
    };

    for (const syn of node.synaptome.values()) {
      const p1 = this.nodeMap.get(syn.peerId);
      if (p1?.alive) queryP1(p1);
    }
    if (node.highway) {
      for (const syn of node.highway.values()) {
        const p1 = this.nodeMap.get(syn.peerId);
        if (p1?.alive) queryP1(p1);
      }
    }

    // Reverse-routing via incoming synapses (1-hop visibility through
    // peers who point at us — useful for sparse-region targets that
    // outgoing routing alone doesn't reach).
    for (const syn of node.incomingSynapses.values()) {
      const peer = this.nodeMap.get(syn.peerId);
      if (!peer?.alive) continue;
      const d = peer.id ^ target;
      if (d < bestDist) { bestDist = d; bestPeer = peer; }
    }
    return bestPeer;
  }

  // ── Routed messaging ────────────────────────────────────────────────

  /**
   * Walk a typed message from `originNode` toward `targetId`. Each hop may
   * inspect and optionally consume the message via its registered handler.
   *
   * The walk is synchronous in the simulator (no latency injected) —
   * matching how `lookup` already treats the hop walk. In a real network
   * each hop is a UDP/WebRTC message; the semantics of intercept + forward
   * carry over unchanged.
   *
   * Returns { consumed, atNode, hops, terminal?, exhausted? }.
   */
  async routeMessage(originNode, targetId, type, payload, opts = {}) {
    const maxHops = opts.maxHops ?? 40;
    const originId = opts.fromId ?? nodeIdToHex(originNode.id);

    let current = originNode;
    let previousId = originId;
    let hops = 0;

    // Terminal-globality visited set: if the greedy walk thinks it has
    // reached a terminal (no synaptome peer strictly closer to the
    // target), we verify via findKClosest(targetId, 1). If findKClosest
    // — which reaches through 2-hop expansion and incomingSynapses —
    // identifies a more globally-close node that current's local view
    // could not see, we forward the message there. Without this check,
    // different callers' greedy walks converge on different *local*
    // terminals, each of which opens its own axon root for the same
    // topic. That produces multiple roots per topic and publishes miss
    // any subscriber attached to a sibling root.
    //
    // `visitedTerminalCheck` prevents ping-pong if two nodes mutually
    // prefer each other under findKClosest: once we've forwarded from
    // current → X, we won't accept X → current as a globality redirect
    // later in the same walk.
    const visitedTerminalCheck = new Set();

    while (hops < maxHops) {
      let nextHop = this._greedyNextHopToward(current, targetId);
      let isTerminal = nextHop === null;

      if (isTerminal) {
        // v0.66.03: bounded 2-hop scan in place of full iterative
        // findKClosest. Same semantic — find a peer in 2 hops closer than
        // current — at ~10× lower cost. See _findCloserInTwoHops doc.
        const globalClosest = this._findCloserInTwoHops(current, targetId);
        if (globalClosest
            && globalClosest.id !== current.id
            && !visitedTerminalCheck.has(globalClosest.id)) {
          visitedTerminalCheck.add(current.id);
          nextHop = globalClosest;
          isTerminal = false;
        }
      }

      const result = this._deliverRouted(current, type, payload, {
        fromId:   previousId,
        targetId,
        hopCount: hops,
        isTerminal,
        node:     current,
      });

      if (result === 'consumed') return { consumed: true, atNode: current.id, hops };
      if (isTerminal) return { consumed: false, atNode: current.id, hops, terminal: true };

      previousId = nodeIdToHex(current.id);
      current = nextHop;
      hops++;
    }
    return { consumed: false, atNode: current.id, hops, exhausted: true };
  }

  _deliverRouted(node, type, payload, meta) {
    const handlers = this._routedHandlers.get(node);
    const handler = handlers?.get(type);
    if (!handler) return 'forward';
    try { return handler(payload, meta) || 'forward'; }
    catch (err) {
      console.error(`NX-15 routed handler error at ${node.id} for '${type}':`, err);
      return 'forward';
    }
  }

  // ── Point-to-point ──────────────────────────────────────────────────

  /**
   * Deliver `payload` directly to `peerId`. Returns `true` if the peer
   * was live at call time, `false` if dropped (peer dead or unknown).
   *
   * Iterative BFS-drain implementation: the liveness check and handler
   * lookup happen synchronously (so the return value is accurate and the
   * caller's eager-dead-child removal still works), but the handler
   * invocation is put on a FIFO queue drained by an outer while-loop.
   * This keeps a fan-out through a deep axon tree off the synchronous
   * call stack — otherwise a 3-level axonal tree with 20-way fan-out
   * blows past Node's ~10K frame limit and crashes with
   * "Maximum call stack size exceeded".
   *
   * Publish-time semantics are preserved: all handlers dispatched by a
   * single top-level sendDirect invocation complete before that call
   * returns, so benchmarks that count deliveries immediately after
   * publish() still see the correct numbers.
   */
  sendDirect(fromNode, peerId, type, payload) {
    const peer = this.nodeMap.get(topicToBigInt(peerId));
    if (!peer?.alive) return false;
    const handlers = this._directHandlers.get(peer);
    const handler = handlers?.get(type);
    if (!handler) return true;        // peer alive, no handler registered — no-op

    const item = {
      handler,
      payload,
      meta: { fromId: nodeIdToHex(fromNode.id), type },
      peerId: peer.id,
      type,
    };

    if (this._sendDraining) {
      // Nested call from inside another handler — enqueue; the outer
      // drain loop will pick it up.
      this._sendQueue.push(item);
      return true;
    }

    // Top-level: start a drain loop.
    this._sendQueue   = [item];
    this._sendDraining = true;
    let processed = 0;
    let peakSize  = 1;
    const ABORT_CAP = 200000;
    try {
      while (this._sendQueue.length > 0) {
        if (this._sendQueue.length > peakSize) peakSize = this._sendQueue.length;
        if (processed >= ABORT_CAP) {
          const typeCounts = {};
          for (const q of this._sendQueue) typeCounts[q.type] = (typeCounts[q.type] || 0) + 1;
          console.error(`NX-15 drain loop aborted after ${processed} items (queue size ${this._sendQueue.length}, peak ${peakSize}). Top-level type='${item.type}'. Queue contents: ${JSON.stringify(typeCounts)}`);
          // Sample a few items to diagnose.
          const samples = this._sendQueue.slice(0, 5).map(q => ({ type: q.type, peerId: String(q.peerId).slice(0, 8), fromId: String(q.meta?.fromId).slice(0, 8) }));
          console.error('  samples:', JSON.stringify(samples));
          break;
        }
        const next = this._sendQueue.shift();
        processed++;
        try {
          next.handler(next.payload, next.meta);
        } catch (err) {
          console.error(`NX-15 direct handler error at peer ${next.peerId} for '${next.type}':`, err);
        }
      }
    } finally {
      this._sendDraining = false;
      this._sendQueue    = null;
    }
    return true;
  }

  // ── Recruitment policy: synaptome-weighted peer selection ───────────

  /**
   * Pick an EXISTING child to promote as sub-axon, preferring those that
   * also appear in this node's synaptome with high weight. High-weight
   * synapses have been validated by LTP as reliable, so promoting them
   * yields trees whose backbone sits on proven connections.
   *
   * Contract: the return value MUST already be present in role.children —
   * recruitment never grows the axon beyond maxDirectSubs. If no child
   * has a synaptome match, falls back to AxonManager's default (XOR-
   * closest existing child to the new subscriber).
   */
  _pickRecruitPeer(node, role, meta, subscriberId) {
    if (role.children.size === 0) return null;
    const selfHex    = nodeIdToHex(node.id);
    const forwarder  = meta.fromId;   // never recruit the peer that just
                                      // forwarded this to us (see loop
                                      // explanation in AxonManager).

    // Build an index of our synaptome+highway weights keyed by hex-string peerId,
    // so we can look them up quickly while walking role.children.
    const synapseWeights = new Map();
    const tiers = [node.synaptome];
    if (node.highway) tiers.push(node.highway);
    for (const tier of tiers) {
      for (const syn of tier.values()) {
        const peer = this.nodeMap.get(syn.peerId);
        if (!peer?.alive) continue;
        synapseWeights.set(nodeIdToHex(syn.peerId), {
          weight:  syn.weight,
          latency: syn.latency ?? syn.latencyMs ?? 0,
        });
      }
    }

    let bestChildId = null;
    let bestScore = -Infinity;
    for (const childId of role.children.keys()) {
      if (childId === selfHex)   continue;
      if (childId === forwarder) continue;
      const s = synapseWeights.get(childId);
      if (!s) continue;
      const score = s.weight * 1_000_000 - s.latency;
      if (score > bestScore) { bestScore = score; bestChildId = childId; }
    }
    if (bestChildId) return bestChildId;

    const subBig = topicToBigInt(subscriberId);
    let best = null;
    let bestDist = null;
    for (const childId of role.children.keys()) {
      if (childId === selfHex)   continue;
      if (childId === forwarder) continue;
      const d = BigInt('0x' + childId) ^ subBig;
      if (bestDist === null || d < bestDist) { bestDist = d; best = childId; }
    }
    return best;
  }
}
