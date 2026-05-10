/**
 * NeuromorphicDHTNH1 (NH-1) — Neuro-Homeostatic Protocol
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

import { DHT }          from '../DHT.js';
import { Synapse }      from './Synapse.js';
import { NeuronNode }   from './NeuronNode.js';
import { randomU64, clz64, roundTripLatency, buildXorRoutingTable }
                         from '../../utils/geo.js';
import { geoCellId }     from '../../utils/s2.js';
import { AxonManager }   from '../../pubsub/AxonManager.js';

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

export class NeuromorphicDHTNH1 extends DHT {
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
    node._nodeMapRef = this.nodeMap;
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
    return node;
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

    // Dead-peer callback.  Future commits convert this to fire reheat
    // + _evictAndReplace; for now record events for verification.
    node.transport.onPeerDied((peerId) => {
      if (!node._deadPeerEvents) node._deadPeerEvents = [];
      node._deadPeerEvents.push(peerId);
    });
  }

  async removeNode(nodeId) {
    const node = this.nodeMap.get(nodeId);
    if (!node) return;
    node.alive = false;
    this.network.removeNode(nodeId);
    this.nodeMap.delete(nodeId);
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
      node._nodeMapRef = this.nodeMap;
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
    newNode._nodeMapRef = this.nodeMap;
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
    newNode._nodeMapRef = this.nodeMap;
    newNode.temperature = this.T_INIT;
    return newNode.synaptome.size;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Routing — The Five Operations
  // ═══════════════════════════════════════════════════════════════════════════

  async lookup(sourceId, targetKey) {
    const source = this.nodeMap.get(sourceId);
    if (!source || !source.alive) return null;

    this.simEpoch++;
    if (++this.lookupsSinceDecay >= this.DECAY_INTERVAL) {
      this._tickDecay();                              // FORGET: periodic
      this.lookupsSinceDecay = 0;
    }

    const path = [sourceId], trace = [], queried = new Set([sourceId]);
    let currentId = sourceId, totalTimeMs = 0, reached = false;

    for (let hop = 0; hop < this.MAX_HOPS; hop++) {
      const current = this.nodeMap.get(currentId);
      if (!current || !current.alive) break;

      const currentDist = current.id ^ targetKey;
      if (currentDist === 0n) { reached = true; break; }

      // ── NAVIGATE: collect forward-progress candidates ──────────────────
      const deadSynapses = [], candidates = [];

      for (const s of current.synaptome.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue;
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) { deadSynapses.push(s); s.weight = 0; continue; }
        candidates.push(s);
      }
      for (const s of current.incomingSynapses.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue;
        if (this.nodeMap.get(s.peerId)?.alive) candidates.push(s);
      }

      // ── FORGET: dead-synapse eviction + replacement ────────────────────
      if (deadSynapses.length > 0) {
        current.temperature = Math.max(current.temperature, this.T_REHEAT);
        for (const syn of deadSynapses) {
          // v0.70.14 — _evictAndReplace is async (commits 6+8); await it
          // so the replacement synapse is in the synaptome before we
          // continue building the candidate set for this hop.
          const repl = await this._evictAndReplace(current, syn);
          if (repl && (repl.peerId ^ targetKey) < currentDist) candidates.push(repl);
        }
      }

      // ── NAVIGATE: iterative fallback ───────────────────────────────────
      if (candidates.length === 0) {
        let bestSyn = null, bestDist = null;
        const scan = (s) => {
          if (queried.has(s.peerId)) return;
          const peer = this.nodeMap.get(s.peerId);
          if (!peer?.alive) return;
          const d = s.peerId ^ targetKey;
          if (bestDist === null || d < bestDist) { bestDist = d; bestSyn = s; }
        };
        for (const s of current.synaptome.values()) scan(s);
        for (const s of current.incomingSynapses.values()) scan(s);
        if (!bestSyn) break;
        candidates.push(bestSyn);
      }

      // ── NAVIGATE: select next hop ──────────────────────────────────────
      let nextSyn;

      const direct = current.synaptome.get(targetKey)
                  ?? current.incomingSynapses.get(targetKey);
      if (direct && this.nodeMap.get(targetKey)?.alive) nextSyn = direct;

      if (!nextSyn && hop === 0 && Math.random() < this.EPSILON) {
        nextSyn = candidates[Math.floor(Math.random() * candidates.length)];
      }

      if (!nextSyn) {
        nextSyn = await this._bestByTwoHopAP(current, candidates, targetKey, currentDist);
      }

      const nextId = nextSyn.peerId;
      if (!this.nodeMap.get(nextId)) break;

      // ── LEARN: incoming promotion ──────────────────────────────────────
      if (current.incomingSynapses.has(nextId) && !current.synaptome.has(nextId)) {
        const inc = current.incomingSynapses.get(nextId);
        inc.useCount = (inc.useCount ?? 0) + 1;
        if (inc.useCount >= this.PROMOTE_THRESHOLD) {
          const syn = new Synapse({ peerId: nextId, latencyMs: inc.latency, stratum: inc.stratum });
          syn.weight = 0.5;
          syn.inertia = this.simEpoch;  // fresh recency
          syn._addedBy = 'promote';
          if (await this._addByVitality(current, syn)) current.incomingSynapses.delete(nextId);
        }
      }

      queried.add(nextId);
      path.push(nextId);
      trace.push({ fromId: currentId, synapse: nextSyn });
      totalTimeMs += nextSyn.latency;

      // ── TRAFFIC: count the actual hop (find_node-equivalent) ───────────
      // NH-1 bypasses SimulatedNetwork.send() (it accesses peers via
      // nodeMap directly), so the v0.70.00 traffic counters on send()
      // never fire for neuromorphic routing. We re-establish parity here:
      // every conceptual on-the-wire interaction calls _msg().
      const nextNode = this.nodeMap.get(nextId);
      this._msg(current, nextNode, 'find_node');

      // ── LEARN: hop caching ─────────────────────────────────────────────
      // v0.70.15 (commit 9) — hop caching is now a real wire notify
      // from source to current.  Current's hop_cache notify handler
      // installs a synapse for `target` and fires lateral_spread
      // notifications to its geographic neighbours.  Fire-and-forget;
      // off the routing critical path.
      if (currentId !== targetKey) {
        source.transport.notify(currentId, 'hop_cache', { target: targetKey, depth: 0 })
          .catch(err => console.error('NH-1: hop_cache notify failed:', err));
      }

      // ── LEARN: triadic closure ─────────────────────────────────────────
      if (currentId !== sourceId) this._recordTransit(current, sourceId, nextId);

      // ── EXPLORE: annealing ─────────────────────────────────────────────
      current.temperature = Math.max(this.T_MIN, current.temperature * this.ANNEAL_COOLING);
      // v0.70.03 — multiply trigger probability by ANNEAL_RATE_SCALE so
      // ablations can throttle the dominant local_probe source without
      // disturbing the temperature-reheat semantics on dead-peer detection.
      // v0.70.12 — anneal is fire-and-forget per the contract design:
      // it runs as a background task off the lookup's critical path.
      // Stray rejections are logged but do not propagate (the lookup
      // has already moved on to the next hop before anneal completes).
      if (Math.random() < current.temperature * this.ANNEAL_RATE_SCALE) {
        const annealNode = current;
        this._tryAnneal(annealNode).catch(err => {
          console.error(`NH-1: anneal failed at ${annealNode.id.toString(16)}:`, err);
        });
      }

      currentId = nextId;
    }

    // ── LEARN: LTP reinforcement on fast paths ───────────────────────────
    if (reached) {
      const hopCount = path.length - 1;
      this._emaHops = this._emaHops === null ? hopCount : 0.9 * this._emaHops + 0.1 * hopCount;
      this._emaTime = this._emaTime === null ? totalTimeMs : 0.9 * this._emaTime + 0.1 * totalTimeMs;
      if (trace.length > 0 && totalTimeMs <= this._emaTime) this._reinforceWave(source, trace);
    }

    return { path, hops: path.length - 1, time: totalTimeMs, found: reached };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NAVIGATE: Two-hop lookahead AP selection
  // ═══════════════════════════════════════════════════════════════════════════

  async _bestByTwoHopAP(current, candidates, targetKey, currentDist) {
    // v0.70.11 (refactor commit 5) — the two-hop lookahead now runs as
    // parallel `lookahead_probe` RPCs against each candidate, instead of
    // reaching synchronously into firstNode.synaptome.  This is the
    // first V2 (cross-peer state read) violation cleared.
    //
    // Wire shape: each probe asks the candidate "what is your closest
    // forward synapse to target?" and the candidate's onRequest
    // handler answers locally from its own synaptome.  Promise.allSettled
    // is the right primitive — a slow or dead candidate's rejection is
    // dropped and the rest of the responses still score.  No `_msg`
    // counter calls are needed: SimulatedTransport.send bumps the same
    // msgsSent / msgsReceived / msgsByType counters under the
    // 'lookahead_probe' type.

    const ranked = candidates.map(s => {
      const ap = Number(currentDist - (s.peerId ^ targetKey)) / s.latency;
      return { s, ap };
    }).sort((a, b) => b.ap - a.ap);

    const probeSet = ranked.slice(0, this.LOOKAHEAD_ALPHA).map(x => x.s);

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
        current.transport.send(first.peerId, 'lookahead_probe', {
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
    return bestSyn ?? current.bestByAP(candidates, targetKey, 0);
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
  _vitality(node, syn) {
    // Recency: exponential decay from last reinforcement
    let recency;
    if (syn.inertia > this.simEpoch) {
      recency = 1.0;  // LTP-locked: full recency
    } else {
      const elapsed = this.simEpoch - syn.inertia;
      recency = Math.max(0.1, Math.exp(-elapsed / this.RECENCY_HALF_LIFE));
    }
    return syn.weight * recency;
  }

  /** Add synapse, honouring bilateral cap and evicting lowest-vitality if full. */
  async _addByVitality(node, newSyn) {
    // v0.70.14 (refactor commit 8) — admission gate now goes entirely
    // through the Transport contract.  The bilateral-cap check moves
    // from node.tryConnect(peer) (which required a peer Node object
    // looked up via nodeMap) to await transport.openConnection(peerId)
    // (which only needs the id).  The synapse latency is filled in
    // from transport.getLatency() instead of roundTripLatency() with
    // peer's lat/lng — same haversine value in the simulator, real
    // heartbeat-measured RTT in production.
    //
    // Local capacity is checked *first* (purely local computation, no
    // network cost) so we don't open a remote channel only to
    // immediately close it if no eviction is possible.

    const cap = node._maxSynaptome ?? this.MAX_SYNAPTOME;

    // Pre-pick eviction victim if local synaptome is at capacity.
    let victim = null;
    if (node.synaptome.size >= cap) {
      let minV = Infinity, minVAny = Infinity, victimAny = null;
      for (const s of node.synaptome.values()) {
        if (s.inertia > this.simEpoch) continue;  // LTP-locked: protected
        const v = this._vitality(node, s);
        if (v < minVAny) { minVAny = v; victimAny = s; }
        if (!s.bootstrap && v < minV) { minV = v; victim = s; }
      }
      victim = victim ?? victimAny;
      if (!victim) return false;   // no evictable target — abort before opening anything
    }

    // Network-side bilateral cap check.  Returns false if remote
    // refused or unreachable.  Same semantic as the legacy tryConnect
    // failure path.  In production this opens a real WebRTC channel;
    // in the simulator it is a synchronous liveness check.
    const opened = await node.transport.openConnection(newSyn.peerId);
    if (!opened) return false;

    // Latency from the transport contract.  In production: -1 until
    // the first heartbeat fires (~1 second after openConnection); fall
    // back to a 200ms default until then so AP scoring has a usable
    // value.  Subsequent reinforcement events update the synapse's
    // latency from the same source.
    const measuredLat = node.transport.getLatency(newSyn.peerId);
    newSyn.latency = (measuredLat >= 0) ? measuredLat : 200;

    if (victim) {
      node.synaptome.delete(victim.peerId);
      node.connections?.delete(victim.peerId);
      await node.transport.closeConnection(victim.peerId);
    }
    node.addSynapse(newSyn);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LEARN: LTP Reinforcement
  // ═══════════════════════════════════════════════════════════════════════════

  _reinforceWave(source, trace) {
    // v0.70.15 (refactor commit 9) — LTP reinforcement via real wire
    // notifications.  The source of the successful lookup walks the
    // trace and fires a 'reinforce' notify to each step's `fromId`.
    // Each receiver runs the LTP update on its own local synaptome
    // entry (handler registered in _registerNH1Handlers).
    //
    // Notify is fire-and-forget.  If a receiver is dead or unreachable,
    // the notification drops silently — LTP missing on one step of a
    // historical successful path is a non-fatal benign loss.  The
    // counter still bumps on the SimulatedTransport side under
    // 'reinforce'.
    for (let i = trace.length - 1; i >= 0; i--) {
      const { fromId, synapse } = trace[i];
      source.transport.notify(fromId, 'reinforce', { synapsePeerId: synapse.peerId })
        .catch(err => console.error('NH-1: reinforce notify failed:', err));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LEARN: Triadic Closure
  // ═══════════════════════════════════════════════════════════════════════════

  _recordTransit(node, originId, nextId) {
    // v0.70.15 (refactor commit 9) — triadic introduction is now a real
    // wire notification.  The transit-observer fires
    // 'triadic_introduce' at the origin; the origin's notify handler
    // runs the local introduce logic (admission via _addByVitality).
    //
    // The legacy central _introduce dispatcher is removed — the
    // handler in _registerNH1Handlers is the only home for that logic
    // now.
    const key   = `${originId}_${nextId}`;
    const count = (node.transitCache.get(key) ?? 0) + 1;
    if (count >= this.TRIADIC_THRESHOLD) {
      node.transitCache.delete(key);
      node.transport.notify(originId, 'triadic_introduce', { peerId: nextId })
        .catch(err => console.error('NH-1: triadic_introduce notify failed:', err));
    } else {
      node.transitCache.set(key, count);
    }
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

  async _tryAnneal(node) {
    if (!node.alive || node.synaptome.size === 0) return;

    // Find weakest synapse by weight (skip LTP-locked)
    let victim = null, weakW = Infinity;
    for (const s of node.synaptome.values()) {
      if (s.inertia > this.simEpoch) continue;
      if (s.weight < weakW) { weakW = s.weight; victim = s; }
    }
    if (!victim) return;

    // Target under-represented stratum group
    const counts = new Array(this.STRATA_GROUPS).fill(0);
    for (const s of node.synaptome.values()) {
      counts[Math.min(this.STRATA_GROUPS - 1, s.stratum >>> 2)]++;
    }
    let targetGroup = 0, minCount = Infinity;
    for (let g = 0; g < this.STRATA_GROUPS; g++) {
      if (counts[g] < minCount) { minCount = counts[g]; targetGroup = g; }
    }

    const lo = targetGroup * 4, hi = lo + 3;
    const candidate = await this._localCandidate(node, lo, hi);
    if (!candidate || node.synaptome.has(candidate.id)) return;

    // v0.70.14 — anneal is a 1-for-1 exchange.  Close the victim's
    // channel before opening the candidate's.  Both go through the
    // Transport contract; the bilateral-cap check happens inside
    // openConnection (returns false if remote refused).
    node.synaptome.delete(victim.peerId);
    node.connections?.delete(victim.peerId);
    await node.transport.closeConnection(victim.peerId);

    const opened = await node.transport.openConnection(candidate.id);
    if (!opened) return;        // bilateral cap

    const measuredLat = node.transport.getLatency(candidate.id);
    const latMs   = (measuredLat >= 0) ? measuredLat : 200;
    const stratum = clz64(node.id ^ candidate.id);
    const syn     = new Synapse({ peerId: candidate.id, latencyMs: latMs, stratum });
    syn.weight    = 0.1;
    syn._addedBy  = 'anneal';
    node.addSynapse(syn);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRUCTURE: Dead-synapse Replacement + 2-hop Search
  // ═══════════════════════════════════════════════════════════════════════════

  async _evictAndReplace(node, deadSyn) {
    // v0.70.14 — admission via Transport contract.  The dead peer's
    // channel is closed; the candidate's channel is opened (which is
    // the bilateral-cap check); latency comes from getLatency.
    node.synaptome.delete(deadSyn.peerId);
    node.connections?.delete(deadSyn.peerId);
    await node.transport.closeConnection(deadSyn.peerId);

    const group = Math.min(this.STRATA_GROUPS - 1, deadSyn.stratum >>> 2);
    const candidate = await this._localCandidate(node, group * 4, group * 4 + 3);
    if (!candidate || node.synaptome.has(candidate.id)) return null;

    const opened = await node.transport.openConnection(candidate.id);
    if (!opened) return null;     // bilateral cap

    const weights = [];
    for (const s of node.synaptome.values()) weights.push(s.weight);
    weights.sort((a, b) => a - b);
    const medW = weights.length > 0 ? weights[weights.length >> 1] : this.VITALITY_FLOOR;

    const measuredLat = node.transport.getLatency(candidate.id);
    const latMs   = (measuredLat >= 0) ? measuredLat : 200;
    const stratum = clz64(node.id ^ candidate.id);
    const syn     = new Synapse({ peerId: candidate.id, latencyMs: latMs, stratum });
    syn.weight    = medW;
    syn._addedBy  = 'evictReplace';
    node.addSynapse(syn);
    return syn;
  }

  async _localCandidate(node, lo, hi) {
    // v0.70.12 (refactor commit 6) — the 2-hop neighbourhood scan now
    // runs as parallel `local_probe` RPCs against each peer in node's
    // synaptome, instead of synchronously reading peer.synaptome.values().
    //
    // This is the dominant V2 violation in NH-1.  At default
    // ANNEAL_RATE_SCALE = 1.0 and 50 K nodes, it accounted for ~89% of
    // all wire traffic (per the v0.70.04 bandwidth study).  In the
    // production deployment that ratio is likely re-tuned via
    // ANNEAL_RATE_SCALE = 0.10 (the knee point in the same study) but
    // the volume projection from the simulator transfers directly
    // because the simulator already counted these as wire messages.

    const probeTargets = [...node.synaptome.values()].map(s => s.peerId);
    if (probeTargets.length === 0) return null;

    const settled = await Promise.allSettled(
      probeTargets.map(peerId => node.transport.send(peerId, 'local_probe', null))
    );

    const candidates = [];
    outer:
    for (const r of settled) {
      if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
      for (const id of r.value) {
        if (id === node.id) continue;
        if (node.synaptome.has(id)) continue;
        const stratum = clz64(node.id ^ id);
        if (stratum < lo || stratum > hi) continue;
        candidates.push(id);
        if (candidates.length >= this.ANNEAL_LOCAL_SAMPLE) break outer;
      }
    }
    if (candidates.length === 0) return null;

    const chosenId = candidates[Math.floor(Math.random() * candidates.length)];
    // V1 violation kept until commit 8 — the callers (_tryAnneal,
    // _evictAndReplace) still need the Node object for tryConnect's
    // bilateral-cap check and roundTripLatency. Commit 8 replaces
    // those with transport.openConnection + transport.getLatency.
    const chosen = this.nodeMap.get(chosenId);
    return chosen?.alive ? chosen : null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Honest Churn Heal (each node checks its own synapses)
  // ═══════════════════════════════════════════════════════════════════════════

  async postChurnHeal() {
    for (const node of this.nodeMap.values()) {
      if (!node.alive) continue;
      const dead = [];
      for (const syn of node.synaptome.values()) {
        if (!this.nodeMap.get(syn.peerId)?.alive) dead.push(syn);
      }
      for (const syn of dead) await this._evictAndReplace(node, syn);
      for (const [peerId] of node.incomingSynapses) {
        if (!this.nodeMap.get(peerId)?.alive) node.incomingSynapses.delete(peerId);
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
      getAlivePeer(peerId) {
        // Used by AxonManager only as a liveness check — preserved
        // for now; commit 14 (NeuronNode cleanup) will remove this
        // entry from the shim once AxonManager stops reaching for
        // peer.alive directly.
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
  onRoutedMessage(node, type, handler) {
    let table = this._routedHandlers.get(node);
    if (!table) { table = new Map(); this._routedHandlers.set(node, table); }
    table.set(type, handler);
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
  onDirectMessage(node, type, handler) {
    let table = this._directHandlers.get(node);
    if (!table) { table = new Map(); this._directHandlers.set(node, table); }
    const wireType = `direct_${type}`;
    if (!table.has(type)) {
      // First registration for this type — install the transport bridge.
      node.transport.onNotification(wireType, (fromId, payload) => {
        const h = this._directHandlers.get(node)?.get(type);
        if (!h) return;
        const fromHex = (typeof fromId === 'bigint') ? nodeIdToHex(fromId) : fromId;
        try {
          h(payload, { fromId: fromHex, type });
        } catch (err) {
          console.error(`NH-1 direct handler error at ${node.id} for '${type}':`, err);
        }
      });
    }
    table.set(type, handler);
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
  async findKClosest(sourceNode, targetId, K = 5, { alpha = 3, maxRounds = 40 } = {}) {
    const src = this._resolveNode(sourceNode);
    if (!src) return [];
    const targetBig = topicToBigInt(targetId);

    /** @type {Map<bigint, bigint>} peerId → distance */
    const distances = new Map();
    const addCandidate = (peerId) => {
      if (typeof peerId !== 'bigint' || distances.has(peerId)) return;
      distances.set(peerId, peerId ^ targetBig);
    };

    // Seed: source + own synaptome + own incoming.  All local-state reads.
    addCandidate(src.id);
    for (const syn of src.synaptome.values())         addCandidate(syn.peerId);
    for (const syn of src.incomingSynapses.values())  addCandidate(syn.peerId);

    const visited = new Set();
    let lastPoolSize = 0;
    let stableRounds = 0;

    for (let round = 0; round < maxRounds; round++) {
      const sorted = [...distances.entries()]
        .sort((a, b) => a[1] < b[1] ? -1 : 1)
        .map(([peerId]) => peerId);
      const topK = sorted.slice(0, K);
      const topKAllVisited = topK.every(p => visited.has(p));

      let toQuery = topK.filter(p => !visited.has(p)).slice(0, alpha);
      if (toQuery.length < alpha) {
        const remaining = alpha - toQuery.length;
        const beyond = sorted
          .filter(p => !visited.has(p) && !topK.includes(p))
          .slice(0, remaining);
        toQuery = toQuery.concat(beyond);
      }
      if (toQuery.length === 0) break;

      // Parallel find_closest_set RPCs.  Skip src.id (we don't RPC
      // ourselves; we already seeded our own synaptome).  Use bucket
      // size this._k as the per-peer response bound — see v0.66.07
      // commentary in the prior implementation; bigger response = better
      // convergence on local 2000km tests.
      const probes = toQuery.filter(p => p !== src.id);
      for (const p of toQuery) visited.add(p);

      if (probes.length > 0) {
        const settled = await Promise.allSettled(
          probes.map(peerId =>
            src.transport.send(peerId, 'find_closest_set',
              { target: targetBig, K: this._k })
          )
        );
        for (const r of settled) {
          if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
          for (const peerId of r.value) addCandidate(peerId);
        }
      }

      const grew = distances.size > lastPoolSize;
      lastPoolSize = distances.size;
      stableRounds = grew ? 0 : stableRounds + 1;
      if (topKAllVisited && stableRounds >= 1) break;
    }

    return [...distances.entries()]
      .sort((a, b) => a[1] < b[1] ? -1 : 1)
      .slice(0, K)
      .map(([peerId]) => peerId);
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
  _greedyNextHopToward(node, targetId) {
    if (!node?.alive) return null;
    const target = (typeof targetId === 'bigint') ? targetId : topicToBigInt(targetId);
    let bestPeerId = null;
    let bestDist   = node.id ^ target;
    for (const syn of node.synaptome.values()) {
      const d = syn.peerId ^ target;
      if (d < bestDist) { bestDist = d; bestPeerId = syn.peerId; }
    }
    // NH-1 has no `highway` tier, so no second loop.
    return bestPeerId;
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
  async _findCloserInTwoHops(node, targetId) {
    // v0.70.13 (refactor commit 7) — clears the third V2 violation in
    // NH-1.  The terminal-globality check now reuses the lookahead_probe
    // RPC handler registered in commit 5: ask each first-hop peer "what
    // is your closest forward synapse to target?" (with fromDist set to
    // *node*'s own distance to target, so the receiver only returns
    // peers strictly closer than us).  Aggregate the responses and pick
    // the globally-closest 2-hop peer.
    //
    // v0.70.16 (refactor commit 10) — return type changed from Node to
    // BigInt peer-id.  Callers (routeMessage, route_msg request handler)
    // no longer dereference the result through nodeMap; they forward
    // via transport.send(peerId, ...) which is enough.  Liveness check
    // on incomingSynapses peers also dropped — if a peer is dead, the
    // forward RPC fails and the chain bubbles up `exhausted`.

    const target = (typeof targetId === 'bigint') ? targetId : topicToBigInt(targetId);
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

    // Incoming peers as a reverse-routing option (they point AT us, so
    // we can route via them to whatever they reach).  Pure local-state
    // read; no nodeMap.get.
    for (const syn of node.incomingSynapses.values()) {
      const d = syn.peerId ^ target;
      if (d < bestDist) { bestDist = d; bestPeerId = syn.peerId; }
    }
    return bestPeerId;
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
  async routeMessage(originNode, targetId, type, payload, opts = {}) {
    const originId  = opts.fromId ?? nodeIdToHex(originNode.id);
    const targetBig = topicToBigInt(targetId);

    // ── Step 1: origin's own greedy 1-hop / terminal check ──
    let nextHopId = this._greedyNextHopToward(originNode, targetBig);
    let isTerminal = nextHopId === null;
    if (isTerminal) {
      const closer = await this._findCloserInTwoHops(originNode, targetBig);
      if (closer !== null && closer !== originNode.id) {
        nextHopId  = closer;
        isTerminal = false;
      }
    }

    // ── Step 2: dispatch origin's local routed handler ──
    const result = await this._deliverRouted(originNode, type, payload, {
      fromId:   originId,
      targetId: targetBig,
      hopCount: 0,
      isTerminal,
      node:     originNode,
    });

    if (result === 'consumed') {
      return { consumed: true, atNode: originNode.id, hops: 0 };
    }
    if (isTerminal) {
      return { consumed: false, atNode: originNode.id, hops: 0, terminal: true };
    }

    // ── Step 3: forward to first hop via route_msg request chain ──
    try {
      const downstream = await originNode.transport.send(nextHopId, 'route_msg', {
        type, payload, targetId: targetBig, hops: 1, originId,
      });
      return downstream;
    } catch {
      return { consumed: false, atNode: originNode.id, hops: 0, exhausted: true };
    }
  }

  /**
   * v0.70.16 (refactor commit 10) — handlers can be async (AxonManager
   * is now async-aware end-to-end).  We await the handler's return so
   * the 'consumed'/'forward' decision reflects the post-await state.
   * Sync handlers still work — `await` over a non-Promise is a no-op.
   */
  async _deliverRouted(node, type, payload, meta) {
    const handlers = this._routedHandlers.get(node);
    const handler = handlers?.get(type);
    if (!handler) return 'forward';
    try {
      const result = await handler(payload, meta);
      return result || 'forward';
    } catch (err) {
      console.error(`NH-1 routed handler error at ${node.id} for '${type}':`, err);
      return 'forward';
    }
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
  async sendDirect(fromNode, peerId, type, payload) {
    if (!fromNode?.alive || !fromNode.transport) return false;
    const peerBig = topicToBigInt(peerId);
    try {
      const ok = await fromNode.transport.notify(peerBig, `direct_${type}`, payload);
      return ok !== false;
    } catch {
      return false;
    }
  }

  // ── Recruitment & relay policies (NX-15 / NX-17 parity) ──────────────────

  /**
   * Pick an EXISTING child to promote as sub-axon. Prefer children that
   * also appear in this node's synaptome with high LTP weight — high-weight
   * synapses are LTP-validated as reliable, so the axon backbone sits on
   * proven connections. Falls back to XOR-closest existing child.
   */
  _pickRecruitPeer(node, role, meta, subscriberId) {
    if (role.children.size === 0) return null;
    const selfHex   = nodeIdToHex(node.id);
    const forwarder = meta.fromId;

    // Index synaptome weights by hex peerId for quick lookup.
    const synapseWeights = new Map();
    for (const syn of node.synaptome.values()) {
      const peer = this.nodeMap.get(syn.peerId);
      if (!peer?.alive) continue;
      synapseWeights.set(nodeIdToHex(syn.peerId), {
        weight:  syn.weight,
        latency: syn.latency ?? syn.latencyMs ?? 0,
      });
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

    // No synaptome match — fall back to XOR-closest existing child.
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

  /**
   * Pick an EXTERNAL synaptome peer (not yet a child) to become a new
   * sub-axon when this role overflows past maxDirectSubs. AxonManager
   * partitions existing children by XOR direction toward this new relay
   * and hands off the in-direction subset in a single batch-adopt message.
   *
   * Selection: XOR-closest synaptome peer to the new subscriber's id —
   * cheapest signal of "which direction is this group growing toward."
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
      if (role.children.has(hex)) return;
      if (considered.has(hex))    return;
      considered.set(hex, { peer, distToSub: peer.id ^ subBig });
    };
    for (const syn of node.synaptome.values()) consider(this.nodeMap.get(syn.peerId));
    if (considered.size === 0) return null;

    let bestHex = null, bestDist = null;
    for (const [hex, rec] of considered) {
      if (bestDist === null || rec.distToSub < bestDist) {
        bestDist = rec.distToSub;
        bestHex  = hex;
      }
    }
    return bestHex;
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
