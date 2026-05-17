// =====================================================================
// NHOnePeer — per-node DHT contract implementation for NH-1.
//
// ── Migration status (Phase 1 of NH1-PerNode-Refactor-Plan-v0.71.md) ──
//
// Phase 1 — Skeleton + co-existence.
//
// This class exists to implement the per-node DHT contract at
// `src/contracts/DHT.js` against the existing multi-node
// `NeuromorphicDHTNH1` (the simulator's NH-1 engine).  In Phase 1 every
// method is a thin delegation to the engine, with the per-node
// `NeuronNode` reference passed through where the engine expects it.
//
// The intent is to validate the per-node API shape (matches the
// contract, can be constructed cleanly, can be observed via getMetrics
// and onEvent) before moving any actual protocol logic out of the
// engine.  Subsequent phases (2 → 3) progressively move read-only and
// then write operations into this class; Phase 4 then renames today's
// engine to `NHOneEngine` and finalises the split.
//
// During Phase 1 the simulator's behaviour is unchanged: the engine
// still owns all the routing logic; NHOnePeer is just an alternative
// API surface that production peers can use to exercise NH-1 through
// the contract.
//
// ── What this class IS ───────────────────────────────────────────────
//   - The DHT contract (src/contracts/DHT.js) implementation for one peer
//   - One instance per running node (in both sim and production)
//   - Owns: a reference to its NeuronNode (per-node state), a reference
//     to the engine (during Phase 1; later phases move logic here), a
//     reference to its transport, and a set of per-peer event listeners.
//
// ── What this class IS NOT ───────────────────────────────────────────
//   - A multi-node manager (that's the engine's job)
//   - A wrapper that hides the engine's existence from the simulator
//     (Phase 1 keeps the engine reachable so the simulator's tests and
//     Engine-cycle code continue to work)
// =====================================================================

import { DHT } from '../../contracts/DHT.js';

export class NHOnePeer extends DHT {
  /**
   * @param {object} opts
   * @param {import('./NeuromorphicDHTNH1.js').NeuromorphicDHTNH1} opts.engine
   *        The legacy multi-node engine (Phase 1: delegate target).
   * @param {import('./NeuronNode.js').NeuronNode} opts.node
   *        The NeuronNode this peer wraps.
   */
  constructor({ engine, node }) {
    super();
    if (!engine) throw new Error('NHOnePeer: engine is required');
    if (!node)   throw new Error('NHOnePeer: node is required');
    this._engine = engine;
    this._node   = node;
    this._started = false;
    /** @type {Set<(event: object) => void>} */
    this._eventListeners = new Set();
    /** @type {(event: object) => void | null} */
    this._engineListenerUnsub = null;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────
  //
  // Phase 1: start/stop are mostly bookkeeping.  The underlying node
  // was already created and registered with the engine via
  // `engine.addNode()` before this NHOnePeer instance came into
  // existence.  We just need to wire up event forwarding so that
  // `onEvent` listeners on this peer receive events that the engine
  // emits about this node.
  //
  // In later phases, start() will move into the real lifecycle:
  // allocate the synaptome, register transport handlers, spin up the
  // decay tick.  For Phase 1 it's idempotent and lightweight.

  async start() {
    if (this._started) return;

    // Engine emits events to a single global listener set today
    // (engine._eventListeners).  We subscribe and filter to events
    // about THIS node, then forward to our per-peer listeners.  This
    // lets the production peer subscribe via NHOnePeer.onEvent without
    // seeing other nodes' events (which it can't, since production
    // only has one node).
    this._engineListenerUnsub = this._engine.onEvent((ev) => {
      // Most events carry a node identifier in one of several fields:
      //   nodeId, peerId, observerId, sourceId, …
      // The current set of event types and their id fields is
      // documented in src/contracts/types.js (ProtocolEvent union).
      // Phase 1 forwards events that mention this._node.id in any of
      // the documented locations; refinement happens when start() owns
      // the event-emit sites in Phase 3.
      if (this._eventMentionsSelf(ev)) {
        for (const cb of this._eventListeners) {
          try { cb(ev); }
          catch (err) {
            console.error(`NHOnePeer ${this._node.id} listener threw:`, err);
          }
        }
      }
    });

    this._started = true;
  }

  async stop() {
    if (!this._started) return;
    if (this._engineListenerUnsub) {
      this._engineListenerUnsub();
      this._engineListenerUnsub = null;
    }
    this._started = false;
  }

  /**
   * Phase 1 stub.  The real production join() will:
   *   1. Use BootstrapService.bootstrap(sponsor) to open the first
   *      WebRTC channel.
   *   2. Run a self-lookup through that sponsor.
   *   3. Stratified-fill the synaptome via subsequent FIND_NODE-style
   *      RPCs over the new transport.
   * In Phase 1 we throw if called from the simulator path — the
   * simulator uses engine.bootstrapJoin instead, which is god's-eye
   * and not contract-shaped.  Production code paths arrive at this
   * stub once Phase 6 (integration) lands.
   */
  async join(_sponsor) {
    throw new Error(
      'NHOnePeer.join: not implemented in Phase 1. ' +
      'Simulator path uses engine.bootstrapJoin; ' +
      'production path lands in Phase 6 integration.'
    );
  }

  async leave() {
    // Phase 1: graceful shutdown is a no-op.  Real implementation
    // notifies known peers and closes channels; tracked in Phase 6.
    return;
  }

  // ─── DHT operations ────────────────────────────────────────────────
  //
  // Phase 1: delegate to the engine.  The engine's lookup takes
  // (sourceId, targetKey) — we supply this peer's id as the source.

  async lookup(targetKey) {
    return this._engine.lookup(this._node.id, targetKey);
  }

  async subscribe(topicName, handler) {
    // Phase 1: subscribe through the engine-owned AxonManager for
    // this node.  Future phases move this into the peer itself.
    const axon = this._engine.axonFor(this._node);
    return axon.subscribe(this._node.id, topicName, handler);
  }

  async unsubscribe(sub) {
    if (!sub) return;
    const axon = this._engine.axonFor(this._node);
    return axon.unsubscribe(sub);
  }

  async publish(topicName, payload) {
    const axon = this._engine.axonFor(this._node);
    return axon.publish(topicName, payload);
  }

  // ─── Identity & observability ──────────────────────────────────────

  getNodeId() {
    return this._node.id;
  }

  /**
   * Phase 2: own the synaptome-snapshot construction directly off the
   * local NeuronNode.  No engine round-trip.  Returns the per-node
   * snapshot — peer ids, weights, latencies, stratum indices.  The
   * application gets a frozen view; the protocol mutates the
   * underlying state independently.
   */
  getSynaptome() {
    if (!this._node) return [];
    return this._node.getSynaptomeSnapshot();
  }

  /**
   * Phase 2: own the metrics object construction.  Per-node lookup
   * counters still live in `engine._nodeStats` (a single Map keyed by
   * NeuronNode); Phase 3 will move those onto the peer.  Until then
   * we look up our entry there.
   */
  getMetrics() {
    const node = this._node;
    if (!node) return null;
    const stats = this._engine._nodeStats.get(node) ||
      { attempted: 0, succeeded: 0, sumHops: 0, sumLatency: 0 };
    const cycleStats = {
      lookupsAttempted: stats.attempted,
      lookupsSucceeded: stats.succeeded,
      avgHops:    stats.succeeded > 0 ? stats.sumHops    / stats.succeeded : 0,
      avgLatency: stats.succeeded > 0 ? stats.sumLatency / stats.succeeded : 0,
    };
    const traffic = {
      msgsSent:     node.msgsSent     | 0,
      msgsReceived: node.msgsReceived | 0,
      byType:       node.msgsByType ? { ...node.msgsByType } : {},
    };
    return {
      simEpoch:             this._engine.simEpoch,
      synaptomeSize:        node.synaptome.size,
      incomingSynapsesSize: node.incomingSynapses.size,
      temperature:          node.temperature ?? this._engine.T_INIT,
      cycleStats,
      traffic,
    };
  }

  // ─── Read-only candidate scoring (Phase 2) ─────────────────────────
  //
  // These methods are pure functions of this peer's local state
  // (synaptome, incomingSynapses) plus the routing target.  They take
  // no `node` parameter — `this._node` is the receiver.  The engine's
  // versions of the same names delegate here via `_peerFor(node)`.

  /**
   * Vitality score for a synapse.  weight × recency, where recency
   * decays exponentially from the synapse's last reinforcement epoch.
   * LTP-locked synapses (inertia > current epoch) get recency = 1.0.
   */
  _vitality(syn) {
    let recency;
    if (syn.inertia > this._engine.simEpoch) {
      recency = 1.0;
    } else {
      const elapsed = this._engine.simEpoch - syn.inertia;
      recency = Math.max(0.1, Math.exp(-elapsed / this._engine.RECENCY_HALF_LIFE));
    }
    return syn.weight * recency;
  }

  /**
   * Two-hop AP scoring with parallel `lookahead_probe` RPCs.  Body
   * matches NeuromorphicDHTNH1._bestByTwoHopAP byte-for-byte; only
   * the receiver changes (was `current` parameter, now `this._node`).
   * The engine method now delegates here.
   */
  async _bestByTwoHopAP(candidates, targetKey, currentDist) {
    const ranked = candidates.map(s => {
      const ap = Number(currentDist - (s.peerId ^ targetKey)) / s.latency;
      return { s, ap };
    }).sort((a, b) => b.ap - a.ap);

    const probeSet = ranked.slice(0, this._engine.LOOKAHEAD_ALPHA).map(x => x.s);

    // Short-circuit: any probe whose first-hop sits exactly on the
    // target wins outright (zero remaining XOR distance).
    for (const first of probeSet) {
      if ((first.peerId ^ targetKey) === 0n) return first;
    }

    // Parallel lookahead probes.  Each rejected probe is treated like
    // an empty-forward response — the source projects the second-hop
    // latency as 0 and distance as the first-hop's own distance to
    // target, the same fallback as `if (!fwd.length)` in the legacy
    // code path.
    const settled = await Promise.allSettled(
      probeSet.map(first =>
        this._node.transport.send(first.peerId, 'lookahead_probe', {
          target:   targetKey,
          fromDist: first.peerId ^ targetKey,
        })
      )
    );

    let bestSyn = null, bestAP2 = -Infinity;
    for (let i = 0; i < probeSet.length; i++) {
      const first = probeSet[i];
      const firstDist = first.peerId ^ targetKey;
      const r = settled[i];

      let twoHopDist, secondLat;
      if (r.status !== 'fulfilled' || !r.value || r.value.terminal) {
        twoHopDist = firstDist;
        secondLat  = 0;
      } else {
        twoHopDist = r.value.peerId ^ targetKey;
        secondLat  = r.value.latency;
      }

      const ap2 = Number(currentDist - twoHopDist) / (first.latency + secondLat);
      if (ap2 > bestAP2) { bestAP2 = ap2; bestSyn = first; }
    }
    return bestSyn ?? this._node.bestByAP(candidates, targetKey, 0);
  }

  /**
   * Pure synchronous greedy 1-hop nextHop selector.  Used by
   * `routeMessage` to find a first-hop closer to target than self.
   * Returns peerId or null if no synapse makes XOR progress.
   */
  _greedyNextHopToward(targetId) {
    if (!this._node?.alive) return null;
    const target = (typeof targetId === 'bigint')
      ? targetId
      : BigInt('0x' + targetId);
    let bestPeerId = null;
    let bestDist   = this._node.id ^ target;
    for (const syn of this._node.synaptome.values()) {
      const d = syn.peerId ^ target;
      if (d < bestDist) { bestDist = d; bestPeerId = syn.peerId; }
    }
    return bestPeerId;
  }

  /**
   * Bounded 2-hop "anyone closer than me?" check.  Parallel
   * `lookahead_probe` RPCs to each first-hop synapse; aggregates the
   * 2-hop responses + incomingSynapses-as-reverse-routing; returns
   * the globally-closest peer id strictly closer than self, or null
   * if this peer is a true 2-hop terminal.
   */
  async _findCloserInTwoHops(targetId) {
    const node = this._node;
    const target = (typeof targetId === 'bigint')
      ? targetId
      : BigInt('0x' + targetId);
    const myDist = node.id ^ target;
    let bestPeerId = null;
    let bestDist   = myDist;

    const probeTargets = [...node.synaptome.values()].map(s => s.peerId);
    if (probeTargets.length > 0) {
      const settled = await Promise.allSettled(
        probeTargets.map(peerId =>
          node.transport.send(peerId, 'lookahead_probe', { target, fromDist: myDist })
        )
      );
      for (const r of settled) {
        if (r.status !== 'fulfilled' || !r.value || r.value.terminal) continue;
        const d = r.value.peerId ^ target;
        if (d < bestDist) {
          bestDist   = d;
          bestPeerId = r.value.peerId;
        }
      }
    }
    for (const syn of node.incomingSynapses.values()) {
      const d = syn.peerId ^ target;
      if (d < bestDist) { bestDist = d; bestPeerId = syn.peerId; }
    }
    return bestPeerId;
  }

  onEvent(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('NHOnePeer.onEvent: handler must be a function');
    }
    this._eventListeners.add(handler);
    return () => this._eventListeners.delete(handler);
  }

  // ─── Internal: event filtering ────────────────────────────────────

  /**
   * @private
   * Decide whether a global engine event mentions this peer.  Phase 1
   * filter; refined in Phase 3 when the per-node event-emit sites
   * land directly on NHOnePeer.
   */
  _eventMentionsSelf(ev) {
    if (!ev || typeof ev !== 'object') return false;
    const me = this._node.id;
    // Common fields across the ProtocolEvent union.  Check all that
    // are documented in src/contracts/types.js; if the event doesn't
    // carry any of them it's a global event (cycle-snapshot) and
    // every per-peer instance receives it.
    return (
      ev.nodeId    === me ||
      ev.peerId    === me ||
      ev.observerId === me ||
      ev.sourceId  === me ||
      ev.type === 'cycle-snapshot'
    );
  }
}
