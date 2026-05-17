/**
 * AxonaEngine (NH-1) — Neuro-Homeostatic Protocol
 *
 * Implements five fundamental operations through a unified vitality model:
 *
 *   NAVIGATE — AP routing with two-hop lookahead + iterative fallback
 *   LEARN    — LTP reinforcement, hop caching, triadic closure, incoming promotion
 *   FORGET   — continuous weight decay, vitality-based eviction
 *   EXPLORE  — temperature-controlled annealing, epsilon-greedy first hop
 *   STRUCTURE — diversity budget penalizes over-represented strata
 *
 * Vitality model:
 *   vitality(syn) = weight × recency(syn) × diversity(syn)
 *
 *   - weight:    [0,1] trained by LTP, decayed over time
 *   - recency:   exponential decay from last reinforcement (uses inertia field)
 *   - diversity:  1/(1+excess) penalty for over-represented stratum groups
 *
 * A single _addByVitality() method handles all admission decisions.
 * 12 parameters, each controlling a behavioral axis.
 */

import { DHT }          from '../DHT.js';   // simulator multi-node base
// v0.71.6 (Phase 5) — production kernel comes from the published
// `@axona/protocol` package.  The local copy of `AxonaPeer.js` was
// deleted in this commit (the package is the canonical source).
// Other production pieces (Synapse, NeuronNode, AxonManager, utils)
// also resolve through the package for identity consistency with
// AxonaPeer.  The simulator-only `src/dht/DHT.js` (above) and the
// rest of the simulator harness stay local.
import {
  AxonaPeer,
  Synapse,
  NeuronNode,
  AxonManager,
  randomU64,
  clz64,
  roundTripLatency,
  geoCellId,
} from '@axona/protocol';
// `buildXorRoutingTable` is reachable via the deep sub-path import.
import { buildXorRoutingTable } from '@axona/protocol/utils/geo.js';

// ── Identity conversions for the AxonManager boundary ────────────────────────
// AxonManager works in 16-char hex strings; NeuronNode uses BigInt. NH-1
// converts at the boundary so the rest of the protocol stays untouched.
function topicToBigInt(v) {
  if (typeof v === 'bigint') return v;
  return BigInt('0x' + v);
}
function nodeIdToHex(id) {
  if (typeof id === 'string') return id;
  return id.toString(16).padStart(16, '0');
}

export class AxonaEngine extends DHT {
  static get protocolName() { return 'Neuromorphic-NH1'; }

  constructor(config = {}) {
    super(config);
    this.nodeMap           = new Map();
    this.simEpoch          = 0;
    this.lookupsSinceDecay = 0;
    this._k                = config.k ?? 20;
    this._alpha            = config.alpha ?? 3;
    this._emaHops          = null;
    this._emaTime          = null;

    const r = config.rules ?? {};

    // ── Parameters — one per behavioral axis ────────────────────────────
    // STRUCTURE
    this.MAX_SYNAPTOME      = r.maxSynaptome       ?? 50;
    // (diversityBudget removed in v0.65.06 — penalty was harmful; stratum
    //  diversity is now enforced solely by DHTNode._trySwapIn at the
    //  connection layer.)
    // NAVIGATE
    // (weightScale removed in v0.66.10 — ablation showed it had no
    //  measurable effect on routing or pub/sub at 5K capped, and
    //  marginally hurt pub/sub full-converge. AP scoring is now pure
    //  progress/latency without LTP-weight bias.)
    this.LOOKAHEAD_ALPHA    = r.lookaheadAlpha      ?? 5;
    this.MAX_HOPS           = r.maxHops             ?? 40;
    // EXPLORE
    this.EPSILON            = r.epsilon             ?? 0.05;
    this.ANNEAL_COOLING     = r.annealCooling       ?? 0.9997;
    // FORGET
    this.DECAY_GAMMA        = r.decayGamma          ?? 0.995;
    this.VITALITY_FLOOR     = r.vitalityFloor       ?? 0.05;
    this.EN_ADAPTIVE_DECAY  = r.adaptiveDecay       ?? false;
    this.DECAY_GAMMA_MIN    = r.decayGammaMin       ?? 0.990;
    this.DECAY_GAMMA_MAX    = r.decayGammaMax        ?? 0.9998;
    this.USE_SATURATION     = r.useSaturation       ?? 20;
    // LEARN
    this.INERTIA_DURATION   = r.inertiaDuration     ?? 20;
    this.PROMOTE_THRESHOLD  = r.promoteThreshold    ?? 2;
    this.TRIADIC_THRESHOLD  = r.triadicThreshold    ?? 2;
    this.EN_LATERAL_SPREAD  = r.lateralSpread       ?? true;   // NX-6 parity: ON by default
    this.LATERAL_K          = r.lateralK            ?? 2;      // NX-6 parity: 2 (cold-corridor speedup)

    // ── Fixed constants ──────────────────────────────────────────────────
    this.DECAY_INTERVAL      = 100;
    this.T_INIT              = 1.0;
    this.T_MIN               = 0.05;
    this.T_REHEAT            = 0.5;
    // ── v0.70.03 — bandwidth-tax ablation knobs ──────────────────────────
    // ANNEAL_LOCAL_SAMPLE caps how many 2-hop candidates _localCandidate
    // examines per call. Default 50 makes _localCandidate the dominant
    // local_probe contributor (~89% of NH-1 wire traffic at 25K). Lower
    // values (5/10/20) trade off candidate diversity for bandwidth.
    //
    // ANNEAL_RATE_SCALE multiplies the per-hop anneal trigger probability,
    // letting us throttle anneal frequency without changing the
    // temperature-reheat semantics. Default 1.0 = current behaviour;
    // 0.1 = fire ~10× less often.
    this.ANNEAL_LOCAL_SAMPLE = r.annealLocalSample ?? 50;
    this.ANNEAL_RATE_SCALE   = r.annealRateScale   ?? 1.0;
    // GEO_BITS controls how many top bits of the 64-bit node ID encode the
    // S2 Hilbert-curve cell prefix for the node's lat/lng. Read from the
    // user's `geoBits` config (defaulting to 8) — previously hardcoded to 8,
    // which silently ignored geoBits=0 ablation requests and made
    // "without geo-prefix" benchmarks dishonest. v0.66.14 fix.
    this.GEO_BITS            = config.geoBits ?? 8;
    this.GEO_REGION_BITS     = r.geoRegionBits ?? Math.min(4, this.GEO_BITS);
    this.STRATA_GROUPS       = 16;
    // ANNEAL_LOCAL_SAMPLE / ANNEAL_RATE_SCALE moved up to the
    // bandwidth-tax knobs block so they're visible alongside their
    // siblings; both are now configurable via rules.
    this.RECENCY_HALF_LIFE   = r.recencyHalfLife ?? 50;

    // ── Membership pub/sub layer (AxonManager) ───────────────────────────
    // Per-node handler registries (lazy: empty until AxonManager registers).
    this._routedHandlers = new Map();   // NeuronNode → Map<type, handler>
    this._directHandlers = new Map();   // NeuronNode → Map<type, handler>
    // Per-node AxonManager instances. Lazy-created on first axonFor().
    this._axonsByNode    = new Map();   // NeuronNode → AxonManager

    // Membership params from UI / experiment config; passed through to each
    // AxonManager. rootSetSize=0 forces routed mode (NX-17 design — single
    // root per topic, grown by routing, healed by re-subscription).
    this._membershipOpts = {
      ...(config.membership || {}),
      rootSetSize: 0,
    };

    // sendDirect drain-loop state was removed in v0.70.16 (refactor
    // commit 10): notifications now run as transport.notify microtasks,
    // which don't blow the stack on deep fan-out trees.

    // ── Observability surface (refactor commit 15, v0.70.21) ────────────
    // Listeners registered via `onEvent(handler)`.  Events are fired
    // from the protocol body via `_emit(event)` at canonical sites:
    // peer-joined / peer-left / lookup-completed / dead-peer-detected
    // / anneal-fired / cycle-snapshot.  See `src/contracts/types.js`
    // for the ProtocolEvent union.
    /** @type {Set<(event: object) => void>} */
    this._eventListeners = new Set();

    // Per-node lookup counters used by getMetrics().cycleStats.  Updated
    // by lookup() and reset by snapshotMetrics().  Keyed by NeuronNode.
    /** @type {Map<object, {attempted: number, succeeded: number, sumHops: number, sumLatency: number}>} */
    this._nodeStats = new Map();

    // v0.71.3 (Phase 2 of NH1-PerNode-Refactor) — per-node DHT-contract
    // wrappers.  Each NeuronNode in `nodeMap` gets a corresponding
    // AxonaPeer in `_peers` created during `addNode()`.  Read-only
    // protocol methods (`_vitality`, `_bestByTwoHopAP`,
    // `_greedyNextHopToward`, `_findCloserInTwoHops`, `getSynaptome`,
    // `getMetrics`) delegate to the per-peer instance via `_peerFor`.
    // Phase 3 will migrate write operations.  Phase 4 renames this
    // class to `NHOneEngine`.
    /** @type {Map<object, import('./AxonaPeer.js').AxonaPeer>} */
    this._peers = new Map();
  }

  /**
   * Marker the benchmark engine reads to decide whether to emit prefixed
   * topic names ('@XX/…') or plain names. NH-1 uses publisher-prefix topic
   * IDs (NX-17 parity): top 8 bits = publisher's S2 cell, bottom 56 = hash
   * of the topic name. This pins the tree root close to the publisher.
   */
  get usesPublisherPrefix() { return true; }

  // ═══════════════════════════════════════════════════════════════════════════
  // Node Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  async addNode(lat, lng) {
    // Geographic ID assignment (NX-6 parity): top GEO_BITS encode the
    // S2 Hilbert-curve cell prefix for (lat, lng); bottom bits are random.
    // This makes XOR-distance correlate with geographic distance, which is
    // essential for: (1) regional lookup performance, (2) the 10%→10%
    // tributary test's XOR-nearest dest selection, (3) routing-table
    // structure giving useful first-hop candidates for nearby targets.
    const prefix   = geoCellId(lat, lng, this.GEO_BITS);
    const shift    = 64 - this.GEO_BITS;
    const randBits = randomU64() & ((1n << BigInt(shift)) - 1n);
    const id       = (BigInt(prefix) << BigInt(shift)) | randBits;
    const node = new NeuronNode({ id, lat, lng });
    // v0.70.20 (refactor commit 14) — `_nodeMapRef` is no longer
    // assigned: NeuronNode.getRoutingTableEntries / getSynaptomeSnapshot
    // both derive their answer from the local synaptome.  No back-
    // pointer into the protocol-level nodeMap is needed.
    node.temperature = this.T_INIT;
    this.nodeMap.set(id, node);
    this.network.addNode(node);

    // v0.70.10 (refactor commit 4) — give the node a Transport-conformant
    // interface and register NH-1's request/notification handlers + the
    // onPeerDied callback.  The legacy nodeMap-based path is left intact
    // (every existing method still works); subsequent commits 5–11
    // migrate one method at a time onto the transport contract.
    if (typeof this.network.makeTransport === 'function') {
      node.transport = this.network.makeTransport(id);
      await node.transport.start();
      this._registerNH1Handlers(node);
    }

    // v0.71.3 (Phase 2) — every NeuronNode pairs with an AxonaPeer
    // that exposes the DHT contract surface for this single node.  The
    // engine's own read-only methods now delegate via `_peerFor(node)`.
    // We don't call `peer.start()` here yet: in Phase 2 AxonaPeer's
    // start() only wires event forwarding, which the engine's tests
    // and benchmark harness do not subscribe to.  Phase 3 may
    // promote start() to register handlers when more logic migrates.
    const peer = new AxonaPeer({ engine: this, node });
    this._peers.set(node, peer);

    this._emit({
      type: 'peer-joined', timestamp: Date.now(),
      peerId: node.id, addedBy: 'addNode',
    });
    return node;
  }

  /**
   * @private
   * Return the AxonaPeer wrapper for a given NeuronNode.  Used by
   * read-only methods (`_vitality` et al.) to forward into per-peer
   * implementations.  If a NeuronNode is encountered that doesn't
   * yet have a peer (e.g., legacy tests that pre-date Phase 2 and
   * construct nodes directly), lazily create one — keeps backward
   * compatibility through the migration window.
   */
  _peerFor(node) {
    if (!node) return null;
    let peer = this._peers.get(node);
    if (!peer) {
      peer = new AxonaPeer({ engine: this, node });
      this._peers.set(node, peer);
    }
    return peer;
  }

  /**
   * @private
   * Register NH-1 handlers on a node's transport.  Handlers added here
   * over the course of commits 5-11:
   *
   *   commit 4 — `ping`            (sanity), `onPeerDied`
   *   commit 5 — `find_node`       (the main routing-tick hop)
   *   commit 6 — `find_closest`    (lookahead probe response)
   *   commit 7 — `sample_synaptome` (local_probe response — anneal)
   *   commit 8 — none new          (admission gate is local logic)
   *   commit 9 — `reinforce`, `triadic`, `hop_cache` (notifications)
   *   commit 10 — pubsub:subscribe, pubsub:publish, pubsub:deliver, ...
   *   commit 11 — `bootstrap_offer` (sponsor-chain join)
   */
  _registerNH1Handlers(node) {
    // Sanity handler: any peer can ping us; we reply 'pong'.
    node.transport.onRequest('ping', async () => 'pong');

    // ── lookahead_probe (commit 5) ────────────────────────────────────
    // Source asks: "what is your closest forward synapse to target X?"
    // We answer with the peer of our best-AP synapse that strictly
    // makes XOR progress past `fromDist` (the source's own distance to
    // X passing through us). If we have no such forward, we report
    // ourselves as terminal — the source projects the second hop's
    // latency as 0, distance as our own distance to target.
    node.transport.onRequest('lookahead_probe', async (_fromId, payload) => {
      const target   = payload.target;
      const fromDist = payload.fromDist;     // BigInt
      const fwd = [];
      for (const syn of node.synaptome.values()) {
        if ((syn.peerId ^ target) < fromDist) fwd.push(syn);
      }
      if (fwd.length === 0) {
        return { peerId: node.id, latency: 0, terminal: true };
      }
      const best = node.bestByAP(fwd, target, 0);
      return { peerId: best.peerId, latency: best.latency, terminal: false };
    });

    // ── local_probe (commit 6) ────────────────────────────────────────
    // Source asks for our 2-hop neighbourhood — i.e., the peer ids in
    // our own synaptome.  The source then filters by stratum range and
    // picks a candidate at random for annealing / dead-peer replacement.
    // The receiver excludes the requestor itself (which would otherwise
    // appear as a candidate in the requestor's own synaptome — useless).
    node.transport.onRequest('local_probe', async (fromId, _payload) => {
      const peerIds = [];
      for (const syn of node.synaptome.values()) {
        if (syn.peerId !== fromId) peerIds.push(syn.peerId);
      }
      return peerIds;
    });

    // ── reinforce (commit 9) ──────────────────────────────────────────
    // Source-of-a-successful-path notifies each peer along the path:
    // "the synapse you used to reach {synapsePeerId} delivered.  Update
    // your local weight + inertia."  Receiver runs the LTP update on
    // its local synaptome entry.  No reply expected — fire-and-forget.
    node.transport.onNotification('reinforce', (_fromId, payload) => {
      const syn = node.synaptome.get(payload.synapsePeerId);
      if (!syn) return;
      syn.reinforce(this.simEpoch, this.INERTIA_DURATION);
      syn.useCount = (syn.useCount ?? 0) + 1;
    });

    // ── triadic_introduce (commit 9) ──────────────────────────────────
    // Transit-observer notifies the source: "I keep seeing you and
    // {peerId} go through me — you should know each other.  Add a
    // synapse to {peerId}."  Receiver runs the local introduce logic
    // (admission via _addByVitality).
    node.transport.onNotification('triadic_introduce', async (_fromId, payload) => {
      if (node.synaptome.has(payload.peerId)) return;
      const stratum = clz64(node.id ^ payload.peerId);
      const syn = new Synapse({ peerId: payload.peerId, latencyMs: 0, stratum });
      syn.weight   = 0.5;
      syn.inertia  = this.simEpoch;
      syn._addedBy = 'triadic';
      await this._addByVitality(node, syn);
    });

    // ── hop_cache + lateral_spread (commit 9) ─────────────────────────
    // After a successful hop A→B→C, source notifies B: "you should
    // know about C directly — install a hop-cache synapse."  Same
    // handler also serves the lateral-spread chain (depth=1) where
    // the original hop_cache receiver propagates to its
    // geo-neighbours.  Two different message types route here so the
    // per-type traffic breakdown preserves the depth distinction.
    const hopCacheHandler = async (_fromId, payload) => {
      const targetId = payload.target;
      const depth    = payload.depth ?? 0;
      if (node.synaptome.has(targetId)) return;
      const stratum = clz64(node.id ^ targetId);
      const syn = new Synapse({ peerId: targetId, latencyMs: 0, stratum });
      syn.weight   = 0.5;             // NX-6 parity
      syn.inertia  = this.simEpoch;
      syn._addedBy = depth === 0 ? 'hopCache' : 'lateralSpread';
      const added  = await this._addByVitality(node, syn);
      if (!added) return;

      // Lateral spread: receiver tells its geographic neighbours about
      // the new target.  Only fires for depth=0; depth=1 receivers
      // do not propagate further.
      if (this.EN_LATERAL_SPREAD && depth === 0) {
        const nodeRegion = node.id >> BigInt(64 - this.GEO_REGION_BITS);
        const regional = [];
        for (const s of node.synaptome.values()) {
          if (s.peerId === targetId) continue;
          if ((s.peerId >> BigInt(64 - this.GEO_REGION_BITS)) === nodeRegion) {
            regional.push(s);
          }
        }
        regional.sort((a, b) => b.weight - a.weight);
        for (let i = 0; i < Math.min(this.LATERAL_K, regional.length); i++) {
          node.transport.notify(regional[i].peerId, 'lateral_spread',
            { target: targetId, depth: 1 })
            .catch(err => console.error('NH-1: lateral_spread notify failed:', err));
        }
      }
    };
    node.transport.onNotification('hop_cache',      hopCacheHandler);
    node.transport.onNotification('lateral_spread', hopCacheHandler);

    // ── route_msg (commit 10) ─────────────────────────────────────────
    // Recursive-forwarding routed-message handler.  Receiver runs:
    //   1. greedy 1-hop scan over its own synaptome (closer than self?)
    //   2. if no 1-hop closer, run 2-hop terminal-globality check
    //   3. dispatch the local routed handler for `type` (if any)
    //   4. if handler returns 'consumed' → reply { consumed: true, ... }
    //   5. if terminal (1-hop fail + 2-hop fail) → reply terminal
    //   6. if maxHops reached → reply exhausted
    //   7. otherwise forward to nextHop via route_msg request, await its
    //      reply, and bubble up unchanged
    //
    // This replaces the source-orchestrated walk in routeMessage().
    // Source no longer needs nodeMap.get(nextId) to advance current=Node;
    // the walk now traverses via a chain of route_msg requests, each peer
    // making its next-hop decision from its own local view (V1 cleared).
    node.transport.onRequest('route_msg', async (fromId, msg) => {
      const { type, payload, targetId, hops, originId } = msg;
      const targetBig = (typeof targetId === 'bigint')
        ? targetId : topicToBigInt(targetId);

      // Greedy 1-hop forward
      let nextHopId = null;
      let bestDist  = node.id ^ targetBig;
      for (const syn of node.synaptome.values()) {
        const d = syn.peerId ^ targetBig;
        if (d < bestDist) { bestDist = d; nextHopId = syn.peerId; }
      }

      let isTerminal = nextHopId === null;
      if (isTerminal) {
        const closer = await this._findCloserInTwoHops(node, targetBig);
        if (closer !== null && closer !== node.id) {
          nextHopId  = closer;
          isTerminal = false;
        }
      }

      const meId = node.id;
      const result = await this._deliverRouted(node, type, payload, {
        fromId,
        targetId: targetBig,
        hopCount: hops,
        isTerminal,
        node,
      });

      if (result === 'consumed') {
        return { consumed: true, atNode: meId, hops };
      }
      if (isTerminal) {
        return { consumed: false, atNode: meId, hops, terminal: true };
      }
      if (hops + 1 >= this.MAX_HOPS) {
        return { consumed: false, atNode: meId, hops, exhausted: true };
      }

      try {
        const downstream = await node.transport.send(nextHopId, 'route_msg', {
          type, payload, targetId: targetBig, hops: hops + 1, originId,
        });
        return downstream;
      } catch {
        return { consumed: false, atNode: meId, hops, exhausted: true };
      }
    });

    // ── find_closest_set (commit 10) ──────────────────────────────────
    // Iterative-search RPC: caller asks "what are your top-K closest
    // peers to target?" and receiver replies with up to K peer-ids
    // drawn from its own synaptome.  Insertion-sorted scan; cheap
    // because synaptome.size is bounded by MAX_SYNAPTOME (~50).  The
    // caller merges results across rounds in findKClosest().
    node.transport.onRequest('find_closest_set', async (_fromId, payload) => {
      const targetBig = (typeof payload.target === 'bigint')
        ? payload.target : topicToBigInt(payload.target);
      const K = payload.K ?? this._k;
      const top = [];
      for (const syn of node.synaptome.values()) {
        const d = syn.peerId ^ targetBig;
        if (top.length < K) {
          let i = 0;
          while (i < top.length && top[i].d < d) i++;
          top.splice(i, 0, { peerId: syn.peerId, d });
        } else if (d < top[K - 1].d) {
          let i = 0;
          while (i < top.length && top[i].d < d) i++;
          top.splice(i, 0, { peerId: syn.peerId, d });
          top.pop();
        }
      }
      return top.map(t => t.peerId);
    });

    // ── lookup_step (commit 11) ──────────────────────────────────────
    // Recursive-forwarding routing-tick handler.  Receiver runs the
    // entire per-hop logic on its OWN local state (synaptome,
    // incomingSynapses, transitCache, temperature) and either:
    //   - reports `found: true` when it IS the target,
    //   - reports `found: false, terminal: true` when no candidate
    //     synapse makes XOR progress AND iterative fallback finds
    //     nothing, or
    //   - picks a next hop (direct / epsilon / two-hop AP), records
    //     the LEARN side-effects (incoming promotion, hop caching,
    //     triadic closure, anneal) locally, and forwards to nextHop
    //     via another lookup_step request.  The chain bubbles back the
    //     final outcome unchanged through every awaiter.
    //
    // This is the structural V1 + V2 cleanup for the routing tick:
    // the source no longer holds any reference to intermediate Node
    // objects; only the receiver reads or writes its own state.
    node.transport.onRequest('lookup_step', async (_fromId, payload) => {
      return await this._lookupStep(node, {
        sourceId:    payload.sourceId,
        targetKey:   payload.targetKey,
        hops:        payload.hops,
        path:        payload.path,
        trace:       payload.trace,
        queried:     payload.queried,
        totalTimeMs: payload.totalTimeMs,
      });
    });

    // Dead-peer callback.  v0.70.17 (refactor commit 11) — populates a
    // local Set of known-dead peer ids that the lookup_step handler
    // consults when filtering candidate synapses.  Replaces the legacy
    // `nodeMap.get(s.peerId)?.alive` god's-eye liveness check; now the
    // protocol learns about deaths the same way a real deployment does
    // — through transport-level peer-died notifications driven by the
    // heartbeat.  Kept as a `Set` for O(1) candidate-filter lookup.
    if (!node._deadPeers) node._deadPeers = new Set();
    node.transport.onPeerDied((peerId) => {
      if (node._deadPeers.has(peerId)) return;
      node._deadPeers.add(peerId);
      this._emit({
        type: 'dead-peer-detected', timestamp: Date.now(),
        observerId: node.id, peerId,
      });
    });
  }

  async removeNode(nodeId) {
    const node = this.nodeMap.get(nodeId);
    if (!node) return;
    node.alive = false;
    this.network.removeNode(nodeId);
    this.nodeMap.delete(nodeId);
    // v0.71.3 (Phase 2) — tear down the per-node DHT-contract wrapper.
    const peer = this._peers.get(node);
    if (peer) {
      try { peer.stop(); } catch { /* peer wasn't started; safe to drop */ }
      this._peers.delete(node);
    }
    this._emit({
      type: 'peer-left', timestamp: Date.now(),
      peerId: nodeId, reason: 'remove',
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRUCTURE: Bootstrap
  // ═══════════════════════════════════════════════════════════════════════════

  buildRoutingTables({
    bidirectional  = true,
    maxConnections = Infinity,
    maxOutgoing    = Infinity,
    maxIncoming    = Infinity,
    highwayPct     = 0,
    initMode       = 'native',
  } = {}) {
    // v0.67.01 fix: forward highwayPct to super so DHT.buildRoutingTables can
    // run the highway-promotion pass.
    // v0.67.02: forward maxOutgoing / maxIncoming directional caps too.
    // v0.68.00: forward initMode. NH-1's bootstrap is canonical-by-construction
    // (pure XOR fill via buildXorRoutingTable), so no behavioral change here —
    // the flag is accepted for API parity and recorded in this.initMode.
    super.buildRoutingTables({
      bidirectional,
      maxConnections,
      maxOutgoing,
      maxIncoming,
      highwayPct,
      initMode,
    });
    if (isFinite(maxConnections) && maxConnections < this.MAX_SYNAPTOME) {
      this.MAX_SYNAPTOME = maxConnections;
    }

    const k      = this._k;
    const sorted = [...this.nodeMap.values()].sort(
      (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );

    // Shuffled processing order (NX-6 parity): under tight bilateral caps,
    // first-come-first-served iteration starves the tail of the sort.
    // Random order produces a uniform connection distribution across nodes.
    const processingOrder = [...sorted].sort(() => Math.random() - 0.5);

    for (const node of processingOrder) {
      // ── Per-node bootstrap budget (v0.66.13: highway-aware) ─────────────
      // Use the node's OWN maxConnections (set by DHT.buildRoutingTables
      // based on highwayPct) as the bootstrap cap. Highway nodes have
      // Infinity, so buildXorRoutingTable takes the sequential-fill branch
      // and returns ~280 candidates; capped nodes get the stratified
      // branch with ~maxConnections candidates. This is the fix that
      // makes highway% actually matter — previously every node bootstrapped
      // from the same global stratified-100 plan regardless of highway
      // status, which is why the v0.66.12 sweep was completely flat.
      const nodeBootstrapCap = node.maxConnections ?? maxConnections;
      // Per-node synaptome cap: highway nodes can grow up to 256 synapses
      // (NX-6 uncapped parity); capped nodes use the global MAX_SYNAPTOME.
      node._maxSynaptome = isFinite(nodeBootstrapCap)
        ? Math.min(nodeBootstrapCap, this.MAX_SYNAPTOME)
        : 256;
      for (const peer of buildXorRoutingTable(node.id, sorted, k, nodeBootstrapCap)) {
        // Bilateral physical-cap gate: silently refuse if either side is full.
        if (!node.tryConnect(peer)) continue;
        const latMs   = roundTripLatency(node, peer);
        const stratum = clz64(node.id ^ peer.id);
        const syn     = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });
        syn.bootstrap = true;     // NX-6 parity: bootstrap synapses preferred to keep
        syn._addedBy  = 'bootstrap';
        node.addSynapse(syn);
        if (bidirectional) {
        peer.addIncomingSynapse(node.id, latMs, stratum);
        // TRAFFIC: bidirectional bootstrap requires a hello/handshake
        // exchange. Counts as one wire message (zeroed by the pre-baseline
        // snapshot before training starts, so this only matters for
        // dedicated bootstrap diagnostics).
        this._msg(node, peer, 'bootstrap');
      }
      }
      // v0.70.20 — `_nodeMapRef` retired (commit 14).
    }
    // Cap-enforcement audit happens via DHT.verifyConnectionCap in main.js
    // after this method returns, so every protocol gets the same check.
    this._logSynaptomeStats('post-bootstrap');
  }

  // ── Diagnostic: synaptome size distribution ─────────────────────────────────
  // Posts a one-line summary to /api/log so we can verify the per-node
  // _maxSynaptome cap is actually being honored in mixed-capacity sweeps.
  // Called at end of buildRoutingTables (post-bootstrap state) and at start
  // of dispose (post-training / post-benchmark state).
  _logSynaptomeStats(label) {
    if (!this.nodeMap || this.nodeMap.size === 0) return;
    const acc = (bucket, size, atCap, outD, inD) => {
      bucket.n++;
      bucket.sum += size;
      if (size > bucket.max) bucket.max = size;
      if (size < bucket.min) bucket.min = size;
      if (atCap) bucket.atCap++;
      bucket.outSum += outD;
      bucket.inSum  += inD;
      if (outD > bucket.outMax) bucket.outMax = outD;
      if (inD  > bucket.inMax)  bucket.inMax  = inD;
    };
    const newBucket = () => ({ n: 0, sum: 0, max: 0, min: Infinity, atCap: 0, outSum: 0, inSum: 0, outMax: 0, inMax: 0 });
    const norm = newBucket();
    const hwy  = newBucket();
    for (const node of this.nodeMap.values()) {
      const size = node.synaptome?.size ?? 0;
      const cap  = node._maxSynaptome ?? this.MAX_SYNAPTOME;
      const at   = size >= cap;
      const outD = node._outboundConns?.size ?? 0;
      const inD  = (node.connections?.size ?? 0) - outD;
      if (node.isHighway) acc(hwy, size, at, outD, inD);
      else                acc(norm, size, at, outD, inD);
    }
    const fmt = (b, capLabel) => b.n === 0
      ? `none`
      : `n=${b.n} syn=${(b.sum/b.n).toFixed(1)} synMax=${b.max} atCap=${(100*b.atCap/b.n).toFixed(0)}% out=${(b.outSum/b.n).toFixed(1)}/${b.outMax} in=${(b.inSum/b.n).toFixed(1)}/${b.inMax} synCap=${capLabel}`;
    const entry = `[NH-1 SYN ${label}] ` +
      `hwPct=${this.highwayPct ?? 0} maxConn=${this.maxConnections} ` +
      `maxOut=${this.maxOutgoing} maxIn=${this.maxIncoming} ` +
      `MAX_SYNAPTOME=${this.MAX_SYNAPTOME} | ` +
      `normal{${fmt(norm, this.MAX_SYNAPTOME)}} | ` +
      `highway{${fmt(hwy, 256)}}`;
    // Browser-only side channel: post to /api/log for offline inspection.
    if (typeof fetch !== 'undefined') {
      try {
        fetch('/api/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entry }),
        }).catch(() => {});
      } catch { /* non-browser environment */ }
    }
    if (typeof console !== 'undefined') console.log(entry);
  }

  bootstrapNode(newNode, sorted, k = 20) {
    if (!sorted?.length || !newNode?.alive) return;
    const bidir = this.bidirectional;
    // Per-node synaptome cap (v0.66.13): use newNode.maxConnections
    // (highway-aware), capped at protocol MAX_SYNAPTOME or 256 if highway.
    const newNodeCap = newNode.maxConnections ?? Infinity;
    newNode._maxSynaptome = isFinite(newNodeCap)
      ? Math.min(newNodeCap, this.MAX_SYNAPTOME)
      : 256;
    for (const peer of buildXorRoutingTable(newNode.id, sorted, k, newNodeCap)) {
      if (!newNode.tryConnect(peer)) continue;  // bilateral cap
      const latMs   = roundTripLatency(newNode, peer);
      const stratum = clz64(newNode.id ^ peer.id);
      const syn     = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });
      syn.weight    = 0.5;
      syn.bootstrap = true;     // NX-6 parity
      syn._addedBy  = 'bootstrap';
      newNode.addSynapse(syn);
      if (bidir) {
        peer.addIncomingSynapse(newNode.id, latMs, stratum);
        this._msg(newNode, peer, 'bootstrap');   // TRAFFIC: handshake
      }
    }
    // v0.70.20 — `_nodeMapRef` retired (commit 14).
  }

  bootstrapJoin(newNodeId, sponsorId) {
    const newNode = this.nodeMap.get(newNodeId);
    const sponsor = this.nodeMap.get(sponsorId);
    if (!newNode || !sponsor) return 0;

    const k = this._k, alpha = this._alpha;
    // Per-node synaptome cap (v0.66.13): churn-replacement nodes get the
    // same per-node cap they would have received at full bootstrap.
    if (newNode._maxSynaptome == null) {
      const c = newNode.maxConnections ?? Infinity;
      newNode._maxSynaptome = isFinite(c)
        ? Math.min(c, this.MAX_SYNAPTOME)
        : 256;
    }
    const newNodeCap = newNode._maxSynaptome;

    const addPeer = (peer) => {
      if (peer.id === newNodeId || newNode.synaptome.has(peer.id)) return;
      if (newNode.synaptome.size >= newNodeCap) return;
      if (!newNode.tryConnect(peer)) return;     // bilateral cap
      const latMs   = roundTripLatency(newNode, peer);
      const stratum = clz64(newNode.id ^ peer.id);
      const syn     = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });
      syn._addedBy  = 'bootstrapJoin';
      newNode.addSynapse(syn);
      if (this.bidirectional) {
        peer.addIncomingSynapse(newNode.id, latMs, stratum);
        this._msg(newNode, peer, 'bootstrap_join');   // TRAFFIC: churn-replacement handshake
      }
    };

    const findClosest = (node, targetId) => {
      const peers = [], seen = new Set();
      for (const s of node.synaptome.values()) {
        const p = this.nodeMap.get(s.peerId);
        if (p?.alive && !seen.has(p.id)) { seen.add(p.id); peers.push(p); }
      }
      for (const s of node.incomingSynapses.values()) {
        const p = this.nodeMap.get(s.peerId);
        if (p?.alive && !seen.has(p.id)) { seen.add(p.id); peers.push(p); }
      }
      peers.sort((a, b) => {
        const da = a.id ^ targetId, db = b.id ^ targetId;
        return da < db ? -1 : da > db ? 1 : 0;
      });
      return peers.slice(0, k);
    };

    const iterLookup = (targetId, startNode, maxRounds) => {
      const queried = new Set([newNodeId]);
      let shortlist = findClosest(startNode, targetId);
      for (const p of shortlist) addPeer(p);
      for (let round = 0; round < maxRounds; round++) {
        const unq = shortlist.filter(n => !queried.has(n.id)).slice(0, alpha);
        if (!unq.length) break;
        let improved = false;
        for (const peer of unq) {
          queried.add(peer.id);
          for (const c of findClosest(peer, targetId)) {
            if (c.id !== newNodeId && !queried.has(c.id)) {
              addPeer(c);
              if (!shortlist.some(n => n.id === c.id)) { shortlist.push(c); improved = true; }
            }
          }
        }
        shortlist.sort((a, b) => {
          const da = a.id ^ targetId, db = b.id ^ targetId;
          return da < db ? -1 : da > db ? 1 : 0;
        });
        shortlist = shortlist.slice(0, k);
        if (!improved) break;
      }
    };

    addPeer(sponsor);
    iterLookup(newNodeId, sponsor, 10);
    const shift = BigInt(64 - this.GEO_BITS);
    for (let bit = 0; bit < this.GEO_BITS; bit++) {
      iterLookup(newNodeId ^ (1n << (shift + BigInt(bit))), newNode, 2);
    }
    // v0.70.20 — `_nodeMapRef` retired (commit 14).
    newNode.temperature = this.T_INIT;
    return newNode.synaptome.size;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Routing — The Five Operations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Recursive-forwarding routing tick.  v0.70.17 (refactor commit 11).
   *
   * The legacy source-orchestrated walk (a for-loop on the source side
   * that did `current = nodeMap.get(currentId)` to read every
   * intermediate's synaptome / incomingSynapses / temperature) is gone.
   * Instead, the source kicks off a chain of `lookup_step` requests:
   * each peer in the walk runs the entire per-hop logic on its OWN
   * local state, then forwards to the next hop via another
   * `transport.send('lookup_step', ...)`.  The chain bubbles the
   * outcome (`{found, path, trace, totalTimeMs, hops}`) back up.
   *
   * V violations cleared in the routing path:
   *   - V1: every `nodeMap.get(currentId)` /
   *         `nodeMap.get(s.peerId)?.alive` site retired.  Liveness is
   *         now consulted via the per-node `_deadPeers` Set, populated
   *         by `transport.onPeerDied` callbacks (the production
   *         heartbeat-driven death notification).
   *   - V2: cross-peer state reads (peer.synaptome, peer.temperature,
   *         peer.incomingSynapses, peer.transitCache) all gone — every
   *         per-hop access is on the receiver's OWN local node.
   *
   * What stays on source:
   *   - First-step kick-off (source's own _lookupStep call: the source
   *     IS a node and its first-hop selection is locally-justified).
   *   - EMA bookkeeping for the protocol-wide latency / hop-count
   *     averages.
   *   - Reinforce-wave dispatch on fast paths (still a per-trace fan
   *     of 'reinforce' notifies).
   *
   * Wire-counter rename: per-hop traffic now bumps under type
   * 'lookup_step' (the SimulatedTransport bumps msgsByType[type] on
   * both sides of every send).  The legacy `_msg(current, nextNode,
   * 'find_node')` counter is gone.  Total wire-message count
   * unchanged; per-type breakdown shifts from 'find_node' to
   * 'lookup_step'.
   */
  // v0.71.4 (Phase 4) — body moved to AxonaPeer.lookup(targetKey).
  // The simulator's multi-node entry point keeps its (sourceId,
  // targetKey) signature; it resolves the source peer and delegates
  // to the contract-shape per-peer lookup.  Production code paths
  // (axona-peer) call `peer.lookup(target)` directly.
  async lookup(sourceId, targetKey) {
    const source = this.nodeMap.get(sourceId);
    if (!source || !source.alive) return null;
    return this._peerFor(source).lookup(targetKey);
  }

  /**
   * Single-hop step in the recursive lookup chain.  Runs entirely on
   * `node`'s local state.  See lookup() for the architectural
   * commentary.
   *
   * `ctx` is mutated in place (queried set, path/trace arrays,
   * totalTimeMs, hops counter) — the simulator transport passes the
   * same reference through to the receiver, so the mutation chain is
   * coherent.  In a production transport this object would be
   * serialized at every hop; the receiver would see a fresh copy and
   * mutate that.  Either way the final result bubbles up correctly
   * because each handler returns the post-mutation ctx.
   */
  // v0.71.3 (Phase 3g of per-node refactor) — body moved to
  // AxonaPeer._lookupStep.  The 150-line legacy body that previously
  // lived here has been removed; review the per-peer version in
  // AxonaPeer.js as the canonical implementation.
  async _lookupStep(node, ctx) {
    return this._peerFor(node)._lookupStep(ctx);
  }

  /** @private  Build the bubble-up result object from a chain context. */
  _lookupResult(ctx, found) {
    return {
      found,
      path:        ctx.path,
      trace:       ctx.trace,
      totalTimeMs: ctx.totalTimeMs,
      hops:        ctx.hops,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NAVIGATE: Two-hop lookahead AP selection
  // ═══════════════════════════════════════════════════════════════════════════

  // v0.71.3 (Phase 2 of per-node refactor) — body moved to
  // AxonaPeer._bestByTwoHopAP; this stub delegates so existing
  // callers (`_lookupStep` at L889) continue to work unchanged.
  async _bestByTwoHopAP(current, candidates, targetKey, currentDist) {
    return this._peerFor(current)._bestByTwoHopAP(candidates, targetKey, currentDist);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Vitality Model — The Unified Admission Gate
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Compute dynamic vitality: weight × recency.
   *
   * The diversity term (penalty for over-represented stratum groups) was
   * removed in v0.65.06 after a controlled benchmark showed it was actively
   * harmful — pub/sub broadcast hop counts dropped 17% and routing was
   * unaffected when the penalty was disabled. Stratum diversity is already
   * preserved at the connection layer by DHTNode._trySwapIn (which evicts
   * over-represented strata when accepting new peers); duplicating the
   * concept at the synaptome layer added cost without adding signal.
   */
  // v0.71.3 (Phase 2 of per-node refactor) — delegate to AxonaPeer.
  // The body has moved to AxonaPeer._vitality(syn); this stub keeps
  // existing internal callers working until Phase 3 moves _addByVitality
  // and the rest of the write-side machinery onto the peer.
  _vitality(node, syn) {
    return this._peerFor(node)._vitality(syn);
  }

  /** Add synapse, honouring bilateral cap and evicting lowest-vitality if full. */
  // v0.71.3 (Phase 3 of per-node refactor) — body moved to
  // AxonaPeer._addByVitality.
  async _addByVitality(node, newSyn) {
    return this._peerFor(node)._addByVitality(newSyn);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LEARN: LTP Reinforcement
  // ═══════════════════════════════════════════════════════════════════════════

  // v0.71.3 (Phase 3 of per-node refactor) — body moved to
  // AxonaPeer._reinforceWave.
  _reinforceWave(source, trace) {
    return this._peerFor(source)._reinforceWave(trace);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LEARN: Triadic Closure
  // ═══════════════════════════════════════════════════════════════════════════

  // v0.71.3 (Phase 3 of per-node refactor) — body moved to
  // AxonaPeer._recordTransit.
  _recordTransit(node, originId, nextId) {
    return this._peerFor(node)._recordTransit(originId, nextId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LEARN: Hop Caching
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // The central _hopCache(nodeId, targetId, depth) dispatcher was
  // removed in commit 9.  Its body now lives entirely inside the
  // 'hop_cache' / 'lateral_spread' notification handler in
  // _registerNH1Handlers.  Source fires the notify directly from the
  // lookup hop body; receiver runs the local hop-cache + recursive
  // lateral-spread chain in its handler.

  // ═══════════════════════════════════════════════════════════════════════════
  // FORGET: Periodic Decay + Vitality Pruning
  // ═══════════════════════════════════════════════════════════════════════════

  _tickDecay() {
    for (const node of this.nodeMap.values()) {
      if (!node.alive) continue;
      const toPrune = [];
      for (const syn of node.synaptome.values()) {
        if (syn.inertia > this.simEpoch) continue;  // LTP-locked: skip

        let gamma;
        if (this.EN_ADAPTIVE_DECAY) {
          // Usage-based: heavily-used synapses decay slower
          const useFrac = Math.min(1, (syn.useCount ?? 0) / this.USE_SATURATION);
          gamma = this.DECAY_GAMMA_MIN
                + (this.DECAY_GAMMA_MAX - this.DECAY_GAMMA_MIN) * useFrac;
          // Bootstrap synapses blend toward max gamma (slower decay)
          if (syn.bootstrap) gamma = gamma + (this.DECAY_GAMMA_MAX - gamma) * 0.5;
        } else {
          gamma = this.DECAY_GAMMA;
        }

        syn.decay(gamma);
      }
      // Never delete synapses during decay — only weaken them.
      // Eviction happens through _addByVitality when new connections are learned.
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPLORE: Annealing
  // ═══════════════════════════════════════════════════════════════════════════

  // v0.71.3 (Phase 3 of per-node refactor) — body moved to
  // AxonaPeer._tryAnneal.
  async _tryAnneal(node) {
    return this._peerFor(node)._tryAnneal();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRUCTURE: Dead-synapse Replacement + 2-hop Search
  // ═══════════════════════════════════════════════════════════════════════════

  // v0.71.3 (Phase 3 of per-node refactor) — body moved to
  // AxonaPeer._evictAndReplace.
  async _evictAndReplace(node, deadSyn) {
    return this._peerFor(node)._evictAndReplace(deadSyn);
  }

  // v0.71.3 (Phase 3 of per-node refactor) — body moved to
  // AxonaPeer._localCandidate.
  async _localCandidate(node, lo, hi) {
    return this._peerFor(node)._localCandidate(lo, hi);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Honest Churn Heal (each node checks its own synapses)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Per-node sweep that asks each live node to evict synapses pointing
   * at peers it has been notified are dead.  Called by the simulator
   * Engine after a churn batch.
   *
   * v0.70.20 (refactor commit 14) — uses each node's transport-driven
   * `_deadPeers` Set (populated by `transport.onPeerDied` callbacks
   * during `removeNode`).  No `this.nodeMap.get(syn.peerId)?.alive`
   * god's-eye reach.  The outer enumeration over `this.nodeMap.values()`
   * is the simulator's legitimate "every alive node" walk — Engine
   * orchestration, not protocol-level peer access.
   */
  async postChurnHeal() {
    for (const node of this.nodeMap.values()) {
      if (!node.alive) continue;
      const deadSet = node._deadPeers || new Set();
      const dead = [];
      for (const syn of node.synaptome.values()) {
        if (deadSet.has(syn.peerId)) dead.push(syn);
      }
      for (const syn of dead) await this._evictAndReplace(node, syn);
      for (const peerId of [...node.incomingSynapses.keys()]) {
        if (deadSet.has(peerId)) node.incomingSynapses.delete(peerId);
      }
      if (dead.length > 0) {
        node.temperature = Math.max(node.temperature, this.T_REHEAT);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Traffic Counters (parity with SimulatedNetwork.send instrumentation)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Bump per-node sent/received counters (and a per-type subtotal) for one
   * conceptual on-the-wire message. NH-1 bypasses SimulatedNetwork.send()
   * because every routing primitive accesses peers via this.nodeMap
   * directly — so the v0.70.00 traffic instrumentation that lives on
   * send() never fires for neuromorphic protocols. This helper is the
   * NH-1-side equivalent: every routing/learning primitive calls it at
   * each conceptual message site so Engine.snapshotTrafficLoad() sees the
   * same counters Kademlia produces.
   *
   * Pairs with the reset loop in snapshotTrafficLoad — the snapshot zeros
   * all four fields after each training cycle so the next cycle starts
   * clean and the captured numbers are deltas.
   */
  _msg(fromNode, toNode, type) {
    if (fromNode && fromNode.alive !== false) {
      fromNode.msgsSent = (fromNode.msgsSent | 0) + 1;
      if (!fromNode.msgsByType) fromNode.msgsByType = Object.create(null);
      fromNode.msgsByType[type] = (fromNode.msgsByType[type] | 0) + 1;
    }
    if (toNode && toNode.alive !== false) {
      toNode.msgsReceived = (toNode.msgsReceived | 0) + 1;
      if (!toNode.msgsByType) toNode.msgsByType = Object.create(null);
      toNode.msgsByType[type] = (toNode.msgsByType[type] | 0) + 1;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stats
  // ═══════════════════════════════════════════════════════════════════════════

  getStats() {
    const base  = super.getStats();
    const nodes = [...this.nodeMap.values()].filter(n => n.alive);
    const avgSyn = nodes.length
      ? (nodes.reduce((a, n) => a + n.synaptome.size, 0) / nodes.length).toFixed(1) : 0;
    const avgTemp = nodes.length
      ? (nodes.reduce((a, n) => a + (n.temperature ?? this.T_INIT), 0) / nodes.length).toFixed(3)
      : '—';
    return { ...base, protocol: 'Neuromorphic-NH1', epoch: this.simEpoch, avgSynapses: avgSyn, avgTemp };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Observability surface (DHT contract, refactor commit 15)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // The DHT contract at src/contracts/DHT.js mandates four read-only
  // observability methods: getNodeId(), getSynaptome(), getMetrics(),
  // onEvent().  In production each DHT instance is one node, so those
  // methods take no argument.  In the simulator one
  // AxonaEngine manages many nodes (legacy collapse for
  // performance), so we accept an optional `nodeOrId` argument that
  // selects which node to report on.  Production wiring will simply
  // omit the argument and the methods will resolve to the local node.

  /**
   * @param {object|bigint|string} [nodeOrId]  defaults to first live node
   * @returns {bigint}
   */
  getNodeId(nodeOrId) {
    const node = nodeOrId !== undefined
      ? this._resolveNode(nodeOrId)
      : this._anyAliveNode();
    if (!node) throw new Error('NH-1: getNodeId — no live node found');
    return node.id;
  }

  /**
   * Read-only snapshot of the local synaptome.
   *
   * @param {object|bigint|string} [nodeOrId]
   * @returns {Array<object>}  SynapseSnapshot[] per types.js
   */
  // v0.71.3 (Phase 2) — body moved to AxonaPeer.getSynaptome().
  // Engine retains the no-args "any alive node" fallback that the
  // simulator's dashboards use; resolved per-node calls delegate.
  getSynaptome(nodeOrId) {
    const node = nodeOrId !== undefined
      ? this._resolveNode(nodeOrId)
      : this._anyAliveNode();
    if (!node) return [];
    return this._peerFor(node).getSynaptome();
  }

  /**
   * Aggregate per-node metrics.  Read-only — safe at any frequency.
   *
   * @param {object|bigint|string} [nodeOrId]
   * @returns {object}  Metrics per types.js
   */
  // v0.71.3 (Phase 2) — body moved to AxonaPeer.getMetrics().  The
  // engine retains the no-args "any alive node" fallback used by the
  // simulator dashboards; resolved per-node calls delegate.
  getMetrics(nodeOrId) {
    const node = nodeOrId !== undefined
      ? this._resolveNode(nodeOrId)
      : this._anyAliveNode();
    if (!node) return null;
    return this._peerFor(node).getMetrics();
  }

  /**
   * Subscribe to protocol events.
   *
   * @param {(event: object) => void} handler
   * @returns {() => void}  unsubscribe
   */
  onEvent(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('NH-1.onEvent: handler must be a function');
    }
    this._eventListeners.add(handler);
    return () => this._eventListeners.delete(handler);
  }

  /**
   * Walk every live node and emit a 'cycle-snapshot' event per node.
   * The simulator Engine fires this once per training cycle so
   * downstream consumers (load-balance plots, dashboards) get a
   * point-in-time aggregation that doesn't require god's-eye nodeMap
   * walks.  After emission, per-node lookup counters are reset so the
   * next cycle starts clean.
   */
  snapshotMetrics(opts = {}) {
    const { reset = true } = opts;
    const ts = Date.now();
    for (const node of this.nodeMap.values()) {
      if (!node.alive) continue;
      const metrics = this.getMetrics(node);
      this._emit({ type: 'cycle-snapshot', timestamp: ts, peerId: node.id, metrics });
      if (reset) {
        const s = this._nodeStats.get(node);
        if (s) { s.attempted = 0; s.succeeded = 0; s.sumHops = 0; s.sumLatency = 0; }
        node.msgsSent     = 0;
        node.msgsReceived = 0;
        node.msgsByType   = Object.create(null);
      }
    }
  }

  /** @private */
  _emit(event) {
    if (this._eventListeners.size === 0) return;
    for (const h of this._eventListeners) {
      try { h(event); }
      catch (err) { console.error('NH-1: event listener threw:', err); }
    }
  }

  /** @private */
  _anyAliveNode() {
    for (const n of this.nodeMap.values()) if (n.alive) return n;
    return null;
  }

  /** @private */
  _bumpLookupStats(node, found, hops, latency) {
    let s = this._nodeStats.get(node);
    if (!s) { s = { attempted: 0, succeeded: 0, sumHops: 0, sumLatency: 0 }; this._nodeStats.set(node, s); }
    s.attempted++;
    if (found) {
      s.succeeded++;
      s.sumHops    += hops;
      s.sumLatency += latency;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Membership Pub/Sub Layer (AxonManager-driven)
  //
  // Ported from NX-15's pub/sub mechanics, adapted for NH-1's two-tier-free
  // synaptome (no `node.highway` map; everything lives in `node.synaptome`
  // and `node.incomingSynapses`). The four primitives AxonManager needs are:
  //
  //   routeMessage(targetId, type, payload, opts)
  //   sendDirect(peerId, type, payload)
  //   onRoutedMessage(type, handler)
  //   onDirectMessage(type, handler)
  //
  // Plus identity accessors getSelfId() / getAlivePeer() / findKClosest().
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get (or lazily create) the AxonManager attached to `node`.
   */
  axonFor(nodeOrId) {
    const node = this._resolveNode(nodeOrId);
    if (!node) throw Error(`NH-1: no live node for id ${nodeOrId}`);
    let axon = this._axonsByNode.get(node);
    if (axon) return axon;

    const m = this._membershipOpts;
    axon = new AxonManager({
      dht: this._nodeShim(node),
      maxDirectSubs:        m.maxDirectSubs,
      minDirectSubs:        m.minDirectSubs,
      refreshIntervalMs:    m.refreshIntervalMs,
      maxSubscriptionAgeMs: m.maxSubscriptionAgeMs,
      rootGraceMs:          m.rootGraceMs,
      rootSetSize:          m.rootSetSize,         // forced to 0 (routed mode)
      replayCacheSize:      m.replayCacheSize,
      // Recruit policy: prefer high-weight synaptome children when promoting
      // an existing child as sub-axon (NX-15 parity).
      pickRecruitPeer: (role, meta, subscriberId) =>
        this._pickRecruitPeer(node, role, meta, subscriberId),
      // Relay policy: when overflowing maxDirectSubs, return an EXTERNAL
      // synaptome peer to be the new sub-axon (NX-17 parity — batch-adopts
      // children whose IDs point toward the new relay).
      pickRelayPeer: (role, subscriberId, forwarderId) =>
        this._pickRelayPeer(node, role, subscriberId, forwarderId),
    });
    this._axonsByNode.set(node, axon);
    return axon;
  }

  /** Clear pub/sub state on every AxonManager. Synaptomes / weights / LTP
   *  are preserved — only axon trees, subscriptions, replay caches, dedup
   *  sets are zeroed. Used by the benchmark runner to start clean per test. */
  resetAllAxons() {
    for (const axon of this._axonsByNode.values()) {
      axon.resetState();
    }
  }

  /** Build the thin shim that exposes NH-1 primitives in the shape AxonManager
   *  expects, with `node` captured in closure. */
  /**
   * v0.70.16 (refactor commit 10) — three of the four primitives below
   * are now async (routeMessage, sendDirect, findKClosest).  The shim
   * methods just await/return; AxonManager is updated in the same
   * commit to add `await` at every call site.
   */
  _nodeShim(node) {
    const self = this;
    return {
      get nodeId()   { return nodeIdToHex(node.id); },
      getSelfId()    { return nodeIdToHex(node.id); },
      // v0.70.20 (refactor commit 14) — `getAlivePeer` retired.
      // AxonManager never consumed it (verified via grep across the
      // codebase).  The shim now exposes only what AxonManager
      // actually depends on.  NX-15 still publishes the method for
      // its own legacy contract — that's NX-15's choice.
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
      async findKClosest(targetId, K, opts) {
        const peerIds = await self.findKClosest(node, targetId, K, opts);
        return peerIds.map(nodeIdToHex);
      },
    };
  }

  _resolveNode(nodeOrId) {
    if (nodeOrId && typeof nodeOrId === 'object' && 'synaptome' in nodeOrId) {
      return nodeOrId;
    }
    return this.nodeMap.get(topicToBigInt(nodeOrId));
  }

  // ── Handler registries ────────────────────────────────────────────────────

  /**
   * Register a routed-message handler for `type` on `node`.  Routed
   * messages arrive at the receiver via the `route_msg` request handler
   * (registered once per node in `_registerNH1Handlers`); that handler
   * looks up `type` in this per-node table and dispatches.
   *
   * Result returned by the handler:
   *   'consumed' — message handled here; do not forward
   *   anything else — message not consumed; keep walking toward target
   */
  // v0.71.3 (Phase 3 of per-node refactor) — body moved to
  // AxonaPeer.onRoutedMessage.
  onRoutedMessage(node, type, handler) {
    return this._peerFor(node).onRoutedMessage(type, handler);
  }

  /**
   * Register a direct-message handler for `type` on `node`.
   *
   * v0.70.16 (refactor commit 10) — bridges to a transport-level
   * notification handler.  Each `direct_${type}` notification arriving
   * at this node's transport dispatches into the per-node table.  We
   * register the bridge once per (node, type) — duplicate calls
   * (AxonManager re-registering on resetState) just overwrite the
   * stored handler, since the notification handler reads the current
   * entry from the table at delivery time.
   */
  // v0.71.3 (Phase 3 of per-node refactor) — body moved to
  // AxonaPeer.onDirectMessage.
  onDirectMessage(node, type, handler) {
    return this._peerFor(node).onDirectMessage(type, handler);
  }

  // ── K-closest iterative lookup (used for terminal-globality verification
  // during routed messaging, and as a primitive AxonManager can call directly). ──

  /**
   * v0.70.16 (refactor commit 10) — async iterative K-closest search
   * driven by `find_closest_set` request RPCs.  Same hybrid termination
   * (top-K all visited AND a full α-round added no new candidates).
   * Returns BigInt peer-ids (the `_nodeShim` wrapper maps to hex).
   *
   * V1 violations cleared: source no longer materialises Node objects
   * for the candidate pool.  It tracks (peerId → distance) and relies
   * on `find_closest_set` responses to discover new peers.  The seed
   * pool is still populated from `src.synaptome` + `src.incomingSynapses`
   * (local state on the source — V1-clean).
   *
   * Wire-counter rename: per-RPC `_msg(src, peer, 'find_closest')` is
   * gone; `transport.send(peerId, 'find_closest_set', …)` bumps the
   * counter inside the transport adapter under that same per-type key.
   */
  // v0.71.3 (Phase 3 of per-node refactor) — body moved to
  // AxonaPeer.findKClosest.
  async findKClosest(sourceNode, targetId, K = 5, opts = {}) {
    const src = this._resolveNode(sourceNode);
    if (!src) return [];
    return this._peerFor(src).findKClosest(targetId, K, opts);
  }

  // ── Greedy single-step routing (used by routeMessage entry) ──────────────

  /**
   * v0.70.16 (refactor commit 10) — returns the BigInt peer-id of the
   * closest 1-hop synapse to `target`, or null if no synapse is strictly
   * closer than self.  No nodeMap.get / liveness check; the receiving
   * peer's transport will fail the forward RPC if it is dead, and the
   * chain bubbles `exhausted` upward.  Same V1-cleanup philosophy as
   * `_findCloserInTwoHops`.
   */
  // v0.71.3 (Phase 2 of per-node refactor) — body moved to
  // AxonaPeer._greedyNextHopToward.
  _greedyNextHopToward(node, targetId) {
    return this._peerFor(node)._greedyNextHopToward(targetId);
  }

  /**
   * Cheap 2-hop "is anyone closer than me?" check used by routeMessage's
   * terminal-globality verification.
   *
   * The terminal check exists to detect cases where the greedy walk reaches
   * a *local* terminal — a node whose 1-hop synapses are all farther from
   * target than itself, but a 2-hop peer (a friend's friend) is actually
   * closer. Without this check, different greedy walks converge on
   * different local terminals and the pub/sub tree fragments.
   *
   * The original implementation called `findKClosest(current, target, 1)`,
   * which runs a full iterative K-closest search through the network. At
   * 25K nodes that's 5-15ms per call; multiplied across ~12K
   * routeMessage calls per refresh phase it dominates total benchmark
   * time. This bounded 2-hop scan answers exactly the same question
   * (is there a closer peer reachable in <=2 hops?) at O(|synaptome|^2)
   * cost (~10K BigInt ops, ~0.5-1ms in JS at cap=100).
   *
   * Returns the closest node strictly closer than `node`, or null if no
   * such 2-hop peer exists (true terminal).
   */
  // v0.71.3 (Phase 2 of per-node refactor) — body moved to
  // AxonaPeer._findCloserInTwoHops.
  async _findCloserInTwoHops(node, targetId) {
    return this._peerFor(node)._findCloserInTwoHops(targetId);
  }

  // ── Routed messaging ─────────────────────────────────────────────────────

  /**
   * Walk a typed message from `originNode` toward `targetId`. Each hop may
   * inspect and optionally consume the message via its registered handler.
   * Returns { consumed, atNode, hops, terminal?, exhausted? }.
   *
   * v0.70.16 (refactor commit 10) — recursive-forwarding model.  This
   * entry point dispatches the origin's own routed handler first
   * (origin can be a subscriber/role-holder for `type`), then if the
   * origin doesn't consume, forwards to the first hop via a `route_msg`
   * transport request.  Each downstream peer runs the same logic in its
   * own `route_msg` request handler (registered in `_registerNH1Handlers`),
   * so the source no longer needs nodeMap.get to advance `current=Node`.
   * V1 violations cleared in routeMessage proper; the only remaining
   * read is `originNode.synaptome` / `originNode.incomingSynapses`,
   * which is local state on the source.
   *
   * Wire-counter rename: `_msg(current, nextHop, 'route_msg')` is gone.
   * Counter bumping now happens inside `transport.send`, which records
   * the wire transaction in the same per-type aggregation
   * (Engine.snapshotTrafficLoad consumes msgsByType from the receiver
   * via SimulatedTransport's bumps).
   */
  // v0.71.3 (Phase 3 of per-node refactor) — body moved to
  // AxonaPeer.routeMessage.
  async routeMessage(originNode, targetId, type, payload, opts = {}) {
    return this._peerFor(originNode).routeMessage(targetId, type, payload, opts);
  }

  /**
   * v0.70.16 (refactor commit 10) — handlers can be async (AxonManager
   * is now async-aware end-to-end).  We await the handler's return so
   * the 'consumed'/'forward' decision reflects the post-await state.
   * Sync handlers still work — `await` over a non-Promise is a no-op.
   */
  // v0.71.3 (Phase 3 of per-node refactor) — body moved to
  // AxonaPeer._deliverRouted.
  async _deliverRouted(node, type, payload, meta) {
    return this._peerFor(node)._deliverRouted(type, payload, meta);
  }

  // ── Point-to-point notify ───────────────────────────────────────────────

  /**
   * Deliver `payload` directly to `peerId` as a fire-and-forget notify.
   * Returns true if the transport accepted the notification (peer was
   * live at send time), false if it was dropped.
   *
   * v0.70.16 (refactor commit 10) — collapses to a thin
   * `transport.notify(peerBig, 'direct_${type}', payload)` wrapper.
   * Per-type wire counter is bumped inside the transport.  The legacy
   * iterative drain loop (which existed because synchronous nested
   * handler calls could blow Node's ~10K stack frame limit) is gone:
   * notifications return immediately, and the receiver's notification
   * handler runs as its own microtask, so deep fan-out trees no longer
   * need a queue.
   *
   * V1 violations cleared: nodeMap.get + alive-check dropped — if peer
   * is dead the transport returns false / throws and we surface that.
   * The caller-side _directHandlers dispatch is now wired in
   * `onDirectMessage` as a transport.onNotification bridge, so
   * receiver-side dispatch is also free of nodeMap.
   */
  // v0.71.3 (Phase 3 of per-node refactor) — body moved to
  // AxonaPeer.sendDirect.
  async sendDirect(fromNode, peerId, type, payload) {
    return this._peerFor(fromNode).sendDirect(peerId, type, payload);
  }

  // ── Recruitment & relay policies (NX-15 / NX-17 parity) ──────────────────

  /**
   * Pick an EXISTING child to promote as sub-axon. Prefer children that
   * also appear in this node's synaptome with high LTP weight — high-weight
   * synapses are LTP-validated as reliable, so the axon backbone sits on
   * proven connections. Falls back to XOR-closest existing child.
   */
  // v0.71.3 (Phase 3 of per-node refactor) — body moved to
  // AxonaPeer._pickRecruitPeer.
  _pickRecruitPeer(node, role, meta, subscriberId) {
    return this._peerFor(node)._pickRecruitPeer(role, meta, subscriberId);
  }

  /**
   * Pick an EXTERNAL synaptome peer (not yet a child) to become a new
   * sub-axon when this role overflows past maxDirectSubs. AxonManager
   * partitions existing children by XOR direction toward this new relay
   * and hands off the in-direction subset in a single batch-adopt message.
   *
   * Selection: XOR-closest synaptome peer to the new subscriber's id —
   * cheapest signal of "which direction is this group growing toward."
   */
  // v0.71.3 (Phase 3 of per-node refactor) — body moved to
  // AxonaPeer._pickRelayPeer.
  _pickRelayPeer(node, role, subscriberId, forwarderId) {
    return this._peerFor(node)._pickRelayPeer(role, subscriberId, forwarderId);
  }

  // ── Dispose: release pub/sub state along with synaptic state ─────────────

  dispose() {
    this._logSynaptomeStats('pre-dispose');
    this._axonsByNode?.clear();
    this._routedHandlers?.clear();
    this._directHandlers?.clear();
    this._axonsByNode    = null;
    this._routedHandlers = null;
    this._directHandlers = null;
    super.dispose();
  }
}
