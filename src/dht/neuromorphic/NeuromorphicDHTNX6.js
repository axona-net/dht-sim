/**
 * NeuromorphicDHTNX6 (NX-6) – Churn-Resilient Routing
 *
 * ── Migration status (v0.70.19 / refactor commit 13) ─────────────────
 *
 * NX-6 is a RESEARCH/COMPARISON protocol kept available for ablation
 * against the production target NH-1 (N-DHT).  It is the larger parent
 * of the NX-{7,8,9,10,11,12,13,15,17} lineage — its highway-tier
 * doubled inner loops (synaptome + highway scans on every routing
 * hop) approximately double the V1+V2 surface relative to NH-1.  The
 * structural Transport-contract migration NH-1 went through in
 * commits 4-11 is NOT propagated to NX-6 or its descendants; they all
 * stay on the simulator's god's-eye `nodeMap.get(peerId)` path so the
 * v0.66.x and earlier benchmark numbers reproduce byte-for-byte.
 *
 * Why kept on legacy paths: same rationale as commit 12 (see NX-15's
 * header).  AxonaManager's async-aware refactor (commit 10) is
 * backward-compatible with NX-6's sync routing primitives, so the
 * lineage continues to work in the simulator without any code
 * changes.  Production deployment uses NH-1 exclusively.
 *
 * ── Original design notes (preserved for context) ────────────────────
 *
 * Derived from NX-5.  Two churn-resilience mechanisms that activate when
 * routing encounters dead peers:
 *
 * 1. Churn-triggered temperature reheat: when a node discovers a dead peer
 *    during routing, its annealing temperature is spiked to T_REHEAT (0.5).
 *    This causes annealing to fire aggressively (~50% per hop) on damaged
 *    nodes, driving rapid synapse exploration and repair.  The temperature
 *    naturally cools back down via ANNEAL_COOLING after repair completes.
 *
 * 2. Immediate dead-synapse eviction + replacement: instead of merely zeroing
 *    a dead synapse's weight and waiting for the next decay tick (every 100
 *    lookups), the dead synapse is immediately deleted and the slot is filled
 *    with a local candidate from the 2-hop neighborhood in the same stratum
 *    range.  This ensures the node's keyspace coverage is repaired instantly
 *    rather than degrading until passive mechanisms clean up.
 *
 * config.rules shape:
 *   {
 *     bootstrap:          { kBootFactor }
 *     twoTier:            { enabled, maxSynaptomeSize, highwaySlots }
 *     apRouting:          { lookaheadAlpha, weightScale, geoRegionBits,
 *                           explorationEpsilon, maxGreedyHops }
 *     ltp:                { enabled, inertiaDuration }
 *     hopCaching:         { enabled, cascadeWeight }
 *     lateralSpread:      { enabled, lateralK, lateralK2, lateralMaxDepth }
 *     stratifiedEviction: { enabled, strataGroups, stratumFloor }
 *     annealing:          { enabled, tInit, tMin, annealCooling, globalBias,
 *                           annealLocalSample }
 *     triadicClosure:     { enabled, introductionThreshold }
 *     markov:             { enabled, markovWindow, markovHotThreshold,
 *                           markovBaseWeight, markovMaxWeight }
 *     adaptiveDecay:      { enabled, decayInterval, pruneThreshold,
 *                           decayGammaMin, decayGammaMax, useSaturation,
 *                           decayGammaHighwayActive, decayGammaHighwayIdle,
 *                           highwayRenewalWindow, highwayFloor, synaptomeFloor }
 *     highwayRefresh:     { enabled, hubRefreshInterval, hubScanCap,
 *                           hubMinDiversity, hubNoise }
 *     loadBalancing:      { enabled (default false), loadDecay, loadPenalty,
 *                           loadFloor, loadSaturation }
 *   }
 */

import { DHT }               from '../DHT.js';
import { Synapse }           from './Synapse.js';
import { NeuronNode }        from './NeuronNode.js';
import { randomU64, clz64,
         roundTripLatency,
         buildXorRoutingTable,
         buildIntraCellTable, buildInterCellTable,
         reservoirSample }      from '../../utils/geo.js';
import { geoCellId }         from '../../utils/s2.js';

export class NeuromorphicDHTNX6 extends DHT {
  static get protocolName() { return 'Neuromorphic-NX6'; }

  constructor(config = {}) {
    super(config);
    this.nodeMap           = new Map();
    this.simEpoch          = 0;
    this.lookupsSinceDecay = 0;
    this._k                = config.k ?? 20;
    this._emaHops          = null;
    this._emaTime          = null;
    this._annealBuffer     = null;
    this._annealBufDirty   = true;
    this._annealBufCount   = 0;

    const r = config.rules ?? {};
    // p(rule, param, default) — read a numeric param with fallback
    const p = (rule, param, def) => {
      const v = r[rule]?.[param];
      return (v !== undefined && v !== null && v !== '') ? +v : def;
    };
    // e(rule, default) — read enabled flag
    const e = (rule, def = true) => {
      const v = r[rule]?.enabled;
      return v !== undefined ? Boolean(v) : def;
    };

    // ── Rule enabled flags ────────────────────────────────────────────────────
    // Rule 1 (Bootstrap) is always active — no flag
    this.EN_TWO_TIER        = e('twoTier');
    this.EN_LTP             = e('ltp');
    this.EN_TRIADIC         = e('triadicClosure');
    this.EN_HOP_CACHING     = e('hopCaching');
    this.EN_LATERAL_SPREAD  = e('lateralSpread');
    this.EN_STRATIFIED      = e('stratifiedEviction', false);  // off by default: simple eviction outperforms
    this.EN_ANNEALING       = e('annealing');
    this.EN_MARKOV          = e('markov');
    this.EN_ADAPTIVE_DECAY  = e('adaptiveDecay');
    this.EN_HIGHWAY_REFRESH = e('highwayRefresh', false);  // off by default: static highway outperforms periodic refresh
    this.EN_LOAD_BALANCING  = e('loadBalancing', false);  // off by default

    // ── Rule 1: Bootstrap ─────────────────────────────────────────────────────
    // GEO_BITS controls how many top bits of the 64-bit node ID encode a
    // Hilbert-curve geographic cell prefix. 0 = no geographic bias (pure
    // random IDs); 8 = ~256 cells (default); up to 32 for maximum
    // geographic clustering. Configurable from the UI's G-DHT Bits slider
    // so NX-* can be characterised against G-DHT at matching prefix widths.
    this.GEO_BITS      = Math.min(32, Math.max(0, Number.isFinite(+config.geoBits) ? +config.geoBits : 8));
    this.K_BOOT_FACTOR = p('bootstrap', 'kBootFactor', 1);

    // ── Rule 2: Two-Tier Synaptome ────────────────────────────────────────────
    this.MAX_SYNAPTOME_SIZE = p('twoTier', 'maxSynaptomeSize', 48);
    this.HIGHWAY_SLOTS      = this.EN_TWO_TIER
                               ? p('twoTier', 'highwaySlots', 12) : 0;

    // ── Rule 3: AP Routing with Two-Hop Lookahead ─────────────────────────────
    this.LOOKAHEAD_ALPHA     = p('apRouting', 'lookaheadAlpha', 3);  // reduced from 5 → 3: empirically LOOKAHEAD_ALPHA=3 matches LOOKAHEAD_ALPHA=5 on hop count within noise at 25K, while cutting two-hop probe cost by 40 %
    this.WEIGHT_SCALE        = p('apRouting', 'weightScale', 0.40);
    this.GEO_REGION_BITS     = p('apRouting', 'geoRegionBits', 4);
    this.EXPLORATION_EPSILON = p('apRouting', 'explorationEpsilon', 0.05);
    this.MAX_GREEDY_HOPS     = p('apRouting', 'maxGreedyHops', 40);

    // ── Rule 4: LTP Reinforcement ─────────────────────────────────────────────
    this.INERTIA_DURATION = p('ltp', 'inertiaDuration', 20);

    // ── Rule 5: Triadic Closure ───────────────────────────────────────────────
    this.INTRODUCTION_THRESHOLD = p('triadicClosure', 'introductionThreshold', 1);

    // ── Rule 6: Hop Caching + Cascade Backprop ────────────────────────────────
    this.HOP_CASCADE_WEIGHT = p('hopCaching', 'cascadeWeight', 0.1);

    // ── Rule 7: Cascading Lateral Spread ──────────────────────────────────────
    this.LATERAL_K         = p('lateralSpread', 'lateralK', 2);   // reduced 6→2: primary cache hit (current→target) still fires; lateral propagation to regional neighbours is bounded. Cuts hop-caching wall-clock by ~65% on cold-corridor tests like NA→AS
    this.LATERAL_K2        = p('lateralSpread', 'lateralK2', 1);   // unused when LATERAL_MAX_DEPTH=1
    this.LATERAL_MAX_DEPTH = p('lateralSpread', 'lateralMaxDepth', 1);

    // ── Rule 8: Stratified Eviction ───────────────────────────────────────────
    this.STRATA_GROUPS = p('stratifiedEviction', 'strataGroups', 16);
    this.STRATUM_FLOOR = p('stratifiedEviction', 'stratumFloor', 2);

    // ── Rule 9: Simulated Annealing ───────────────────────────────────────────
    this.T_INIT              = p('annealing', 'tInit', 1.0);
    this.T_MIN               = p('annealing', 'tMin', 0.05);
    this.ANNEAL_COOLING      = p('annealing', 'annealCooling', 0.9997);
    this.GLOBAL_BIAS         = p('annealing', 'globalBias', 0.5);
    this.ANNEAL_LOCAL_SAMPLE = p('annealing', 'annealLocalSample', 50);
    // v0.70.03 — anneal-rate throttle for bandwidth-tax ablation. Default
    // 1.0 keeps existing behaviour; lower values reduce per-hop trigger
    // probability without interfering with T_REHEAT or temperature decay.
    // NX-17 inherits this through NX-15 → NX-10 → NX-6 verbatim.
    this.ANNEAL_RATE_SCALE   = p('annealing', 'annealRateScale', 1.0);
    this.ANNEAL_BUF_REBUILD  = 200;

    // ── Rule 11: Markov Pre-learning ──────────────────────────────────────────
    this.MARKOV_WINDOW        = p('markov', 'markovWindow', 16);
    this.MARKOV_HOT_THRESHOLD = p('markov', 'markovHotThreshold', 3);
    this.MARKOV_BASE_WEIGHT   = p('markov', 'markovBaseWeight', 0.5);
    this.MARKOV_MAX_WEIGHT    = p('markov', 'markovMaxWeight', 0.9);

    // ── Rule 12: Adaptive Decay ───────────────────────────────────────────────
    this.DECAY_INTERVAL             = p('adaptiveDecay', 'decayInterval', 100);
    this.PRUNE_THRESHOLD            = p('adaptiveDecay', 'pruneThreshold', 0.05);
    this.DECAY_GAMMA_MIN            = p('adaptiveDecay', 'decayGammaMin', 0.990);
    this.DECAY_GAMMA_MAX            = p('adaptiveDecay', 'decayGammaMax', 0.9998);
    this.USE_SATURATION             = p('adaptiveDecay', 'useSaturation', 20);
    this.DECAY_GAMMA_HIGHWAY_ACTIVE = p('adaptiveDecay', 'decayGammaHighwayActive', 0.9995);
    this.DECAY_GAMMA_HIGHWAY_IDLE   = p('adaptiveDecay', 'decayGammaHighwayIdle', 0.990);
    this.HIGHWAY_RENEWAL_WINDOW     = p('adaptiveDecay', 'highwayRenewalWindow', 3000);
    this.HIGHWAY_FLOOR              = p('adaptiveDecay', 'highwayFloor', 2);
    this.SYNAPTOME_FLOOR            = p('adaptiveDecay', 'synaptomeFloor', 48);

    // ── Rule 13: Highway Refresh ──────────────────────────────────────────────
    this.HUB_REFRESH_INTERVAL = p('highwayRefresh', 'hubRefreshInterval', 300);
    this.HUB_SCAN_CAP         = p('highwayRefresh', 'hubScanCap', 120);
    this.HUB_MIN_DIVERSITY    = p('highwayRefresh', 'hubMinDiversity', 5);
    this.HUB_NOISE            = p('highwayRefresh', 'hubNoise', 1.0);

    // ── Rule 14 (NX-5): Incoming Synapse Promotion ─────────────────────────────
    // Promote an incomingSynapse to a full synapse after it's been used as a
    // routing hop this many times.  Low threshold = aggressive promotion.
    this.INCOMING_PROMOTE_THRESHOLD = p('incomingPromotion', 'threshold', 2);

    // ── Rule 16 (NX-6): Churn-Triggered Temperature Reheat ───────────────────
    // When routing discovers a dead peer, spike the discovering node's annealing
    // temperature to max(current, T_REHEAT).  This causes annealing to fire
    // aggressively on nodes damaged by churn, accelerating synapse replacement.
    this.T_REHEAT = p('churnReheat', 'tReheat', 0.5);

    // ── Rule 17 (NX-6): Immediate Dead-Synapse Eviction + Replacement ────────
    // When routing finds a dead synapse, immediately delete it and attempt to
    // fill the slot with a local candidate in the same stratum range, rather
    // than zeroing the weight and waiting for passive decay.
    this.EN_DEAD_EVICTION = e('deadEviction', true);

    // ── Optional: Load-Aware AP Scoring (from N-7W/N-9W, off by default) ──────
    this.LOAD_DECAY      = p('loadBalancing', 'loadDecay', 0.995);
    this.LOAD_PENALTY    = p('loadBalancing', 'loadPenalty', 0.40);
    this.LOAD_FLOOR      = p('loadBalancing', 'loadFloor', 0.10);
    this.LOAD_SATURATION = p('loadBalancing', 'loadSaturation', 0.15);
  }

  // ── Node lifecycle ──────────────────────────────────────────────────────────

  async addNode(lat, lng) {
    const prefix   = geoCellId(lat, lng, this.GEO_BITS);
    const shift    = 64 - this.GEO_BITS;
    const randBits = randomU64() & ((1n << BigInt(shift)) - 1n);
    const id       = (BigInt(prefix) << BigInt(shift)) | randBits;
    const node     = new NeuronNode({ id, lat, lng });

    node.temperature     = this.EN_ANNEALING ? this.T_INIT : 1.0;
    node.highway         = new Map();   // always init; stays empty if two-tier disabled
    node.hubRefreshCount = 0;
    node.recentDests     = [];
    node.recentDestFreq  = new Map();
    if (this.EN_LOAD_BALANCING) {
      node.loadEMA       = 0;
      node.loadLastEpoch = 0;
    }

    this.nodeMap.set(id, node);
    this.network.addNode(node);
    this._annealBufDirty = true;
    return node;
  }

  async removeNode(nodeId) {
    const node = this.nodeMap.get(nodeId);
    if (!node) return;
    node.alive = false;
    this.network.removeNode(nodeId);
    this.nodeMap.delete(nodeId);
    this._annealBufDirty = true;
  }

  // ── Neurogenesis ────────────────────────────────────────────────────────────

  buildRoutingTables({
    bidirectional  = true,
    maxConnections = Infinity,
    initMode       = 'native',
  } = {}) {
    super.buildRoutingTables({ bidirectional, maxConnections, initMode });
    if (maxConnections < this.MAX_SYNAPTOME_SIZE) {
      this.MAX_SYNAPTOME_SIZE = maxConnections;
    }
    // When uncapped (no web limit), raise the synaptome cap to 256 so the
    // bootstrap's three-layer fill is not pruned down during ongoing ops.
    // This enables a fair comparison with uncapped Kademlia/G-DHT which
    // can grow their bucket populations unrestricted.
    if (!isFinite(maxConnections) && this.MAX_SYNAPTOME_SIZE < 256) {
      this.MAX_SYNAPTOME_SIZE = 256;
      this.SYNAPTOME_FLOOR = Math.min(this.SYNAPTOME_FLOOR, 256);
    }

    const k            = this._k * this.K_BOOT_FACTOR;
    const intraBuckets = 64 - this.GEO_BITS;
    const sorted = [...this.nodeMap.values()].sort(
      (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );

    const wireSynapse = (node, peer, isStructural) => {
      if (!node.tryConnect(peer)) return;  // physical cap exhausted on either side
      const latMs   = roundTripLatency(node, peer);
      const stratum = clz64(node.id ^ peer.id);
      const syn     = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });
      if (isStructural) { syn.weight = 0.9; syn.bootstrap = true; }
      node.addSynapse(syn);
      if (this.bidirectional) peer.addIncomingSynapse(node.id, latMs, stratum);
    };

    // Randomize processing order to avoid sort-order bias under tight caps
    // (see KademliaDHT.buildRoutingTables). Under bidirectional bilateral
    // tryConnect, first-come-first-served iteration starves the tail of the
    // sort. Shuffling produces a uniform connection distribution.
    const processingOrder = [...sorted].sort(() => Math.random() - 0.5);

    if (isFinite(maxConnections)) {
      // ── Web-limited: flat XOR init (same as NX-2W) for reliable coverage ──
      for (const node of processingOrder) {
        for (const peer of buildXorRoutingTable(node.id, sorted, k, maxConnections)) {
          wireSynapse(node, peer, false);
        }
        node._nodeMapRef = this.nodeMap;
      }
    } else {
      // ── Uncapped: three-layer geographic init for best latency ──
      const allNodes = [...this.nodeMap.values()];
      for (const node of processingOrder) {
        const selected = new Set([node.id]);

        // Layer 2: inter-cell structured (bootstrap-protected)
        const interCellPeers = buildInterCellTable(node.id, sorted, k, intraBuckets);
        for (const peer of interCellPeers) {
          wireSynapse(node, peer, true);
          selected.add(peer.id);
        }

        // Layer 1: intra-cell local
        const localPeers = buildIntraCellTable(node.id, sorted, k, intraBuckets);
        for (const peer of localPeers) {
          wireSynapse(node, peer, false);
          selected.add(peer.id);
        }

        // Layer 3: random global
        const globalPeers = reservoirSample(allNodes, k, selected);
        for (const peer of globalPeers) {
          wireSynapse(node, peer, false);
        }

        node._nodeMapRef = this.nodeMap;
      }
    }
  }

  // ── Churn bootstrap ──────────────────────────────────────────────────────────

  /**
   * Wire a freshly-added node into the live network using the pre-sorted
   * node list.  Called by Engine.js during churn in place of the
   * Kademlia-only _bootstrapNode (which calls addToBucket — a method
   * NeuronNode doesn't have, so new nodes were getting zero connections).
   *
   * Base version: flat XOR routing table, matching buildRoutingTables()'s
   * web-limited path.  NX-11+ overrides with 80/20 stratified+random.
   *
   * @param {NeuronNode} newNode   The node just returned by addNode().
   * @param {NeuronNode[]} sorted  All live nodes, pre-sorted by id.
   * @param {number} k             Bucket size (peers per XOR stratum).
   */
  bootstrapNode(newNode, sorted, k = 20) {
    if (!sorted?.length || !newNode?.alive) return;

    const maxConn = newNode.maxConnections ?? this.MAX_SYNAPTOME_SIZE ?? Infinity;
    const bidir   = this.bidirectional;

    for (const peer of buildXorRoutingTable(newNode.id, sorted, k, maxConn)) {
      if (!newNode.tryConnect(peer)) continue;  // physical cap
      const latMs   = roundTripLatency(newNode, peer);
      const stratum = clz64(newNode.id ^ peer.id);
      const syn     = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });
      syn.weight    = 0.5;
      newNode.addSynapse(syn);
      if (bidir) peer.addIncomingSynapse(newNode.id, latMs, stratum);
    }

    newNode._nodeMapRef = this.nodeMap;
  }

  // ── Organic join ────────────────────────────────────────────────────────────

  /**
   * Bootstrap a newly-added node into the live network via a known sponsor.
   *
   * Explores the sponsor's 1-2 hop neighbourhood, sorts candidates by XOR
   * distance to the new node, and wires synapses to the closest ones.
   * Existing peers learn about the new node via addIncomingSynapse so they
   * can route to it without disrupting their trained weights.
   *
   * @param {BigInt} newNodeId  ID of the freshly-created node (already in nodeMap).
   * @param {BigInt} sponsorId  ID of the existing entry-point node.
   * @returns {number} Number of synapses wired.
   */
  _synaptomeFindClosest(node, targetId, k) {
    const seen = new Set();
    const peers = [];
    for (const syn of node.synaptome.values()) {
      const peer = this.nodeMap.get(syn.peerId);
      if (peer?.alive && !seen.has(peer.id)) { seen.add(peer.id); peers.push(peer); }
    }
    if (this.EN_TWO_TIER) {
      for (const syn of node.highway.values()) {
        const peer = this.nodeMap.get(syn.peerId);
        if (peer?.alive && !seen.has(peer.id)) { seen.add(peer.id); peers.push(peer); }
      }
    }
    for (const syn of node.incomingSynapses.values()) {
      const peer = this.nodeMap.get(syn.peerId);
      if (peer?.alive && !seen.has(peer.id)) { seen.add(peer.id); peers.push(peer); }
    }
    peers.sort((a, b) => {
      const da = a.id ^ targetId;
      const db = b.id ^ targetId;
      return da < db ? -1 : da > db ? 1 : 0;
    });
    return peers.slice(0, k);
  }

  bootstrapJoin(newNodeId, sponsorId) {
    const newNode = this.nodeMap.get(newNodeId);
    const sponsor = this.nodeMap.get(sponsorId);
    if (!newNode || !sponsor) return 0;

    const k     = this._k;
    const alpha = this._alpha ?? 3;
    const synCap = isFinite(this.maxConnections) ? this.maxConnections : this.MAX_SYNAPTOME_SIZE;

    // ── NX-5: Stratum-aware addPeer with eviction ─────────────────────────
    // Like K-DHT's addToBucket: when at capacity, accept a peer for an
    // underrepresented stratum by evicting from the most-populated one.
    // Groups use the same STRATA_GROUPS (16) as the runtime _stratifiedAdd.
    const GROUPS = this.STRATA_GROUPS;
    const stratumGroup = (s) => Math.min(Math.floor(s / 4), GROUPS - 1);

    const addPeer = (peer) => {
      if (peer.id === newNodeId || newNode.synaptome.has(peer.id)) return;
      if (!newNode.tryConnect(peer)) return;  // physical cap exhausted on either side
      const latMs   = roundTripLatency(newNode, peer);
      const stratum = clz64(newNode.id ^ peer.id);
      const newSyn  = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });

      // Under cap — add freely
      if (newNode.synaptome.size < synCap) {
        newNode.addSynapse(newSyn);
        peer.addIncomingSynapse(newNode.id, latMs, stratum);
        return;
      }

      // At cap — stratum-aware eviction: only add if we improve coverage
      const newGroup = stratumGroup(stratum);

      // Count peers per stratum group
      const counts = new Array(GROUPS).fill(0);
      for (const syn of newNode.synaptome.values()) {
        counts[stratumGroup(syn.stratum)]++;
      }

      // Only evict if the new peer's group is underrepresented
      // Find the most-populated group (that isn't the new peer's group)
      let evictGroup = -1, maxCount = 0;
      for (let g = 0; g < GROUPS; g++) {
        if (g !== newGroup && counts[g] > maxCount) {
          maxCount = counts[g];
          evictGroup = g;
        }
      }

      // Evict if the donor group has more peers than the new peer's group + 1
      // (guarantees net improvement in coverage balance)
      if (evictGroup >= 0 && maxCount > counts[newGroup] + 1) {
        // Evict the weakest (lowest weight) in the donor group
        let victim = null, victimW = Infinity;
        for (const syn of newNode.synaptome.values()) {
          if (stratumGroup(syn.stratum) === evictGroup && syn.weight < victimW) {
            victimW = syn.weight;
            victim = syn;
          }
        }
        if (victim) {
          newNode.synaptome.delete(victim.peerId);
          newNode.addSynapse(newSyn);
          peer.addIncomingSynapse(newNode.id, latMs, stratum);
        }
      }
    };

    // ── Iterative lookup (shared by both phases) ──────────────────────────
    const iterativeLookup = (targetId, startNode, maxRounds) => {
      const queried = new Set([newNodeId]);
      let shortlist = this._synaptomeFindClosest(startNode, targetId, k);
      for (const peer of shortlist) addPeer(peer);

      for (let round = 0; round < maxRounds; round++) {
        const unqueried = shortlist.filter(n => !queried.has(n.id)).slice(0, alpha);
        if (unqueried.length === 0) break;

        let improved = false;
        for (const peer of unqueried) {
          queried.add(peer.id);
          const found = this._synaptomeFindClosest(peer, targetId, k);
          for (const candidate of found) {
            if (candidate.id !== newNodeId && !queried.has(candidate.id)) {
              addPeer(candidate);
              if (!shortlist.some(n => n.id === candidate.id)) {
                shortlist.push(candidate);
                improved = true;
              }
            }
          }
        }

        shortlist.sort((a, b) => {
          const da = a.id ^ targetId;
          const db = b.id ^ targetId;
          return da < db ? -1 : da > db ? 1 : 0;
        });
        shortlist = shortlist.slice(0, k);

        if (!improved) break;
      }
    };

    // Phase 1: Connect to sponsor + self-lookup for close peers
    addPeer(sponsor);
    iterativeLookup(newNodeId, sponsor, 10);

    // Phase 2: Inter-cell discovery — flip each geo-prefix bit.
    // With stratum-aware eviction, Phase 2 peers can now displace
    // over-represented close peers from Phase 1.
    //
    // Optimization: use only 2 rounds per prefix (enough to discover
    // one good peer per stratum) and start from the new node itself
    // (which now has Phase 1 peers) rather than the sponsor — this
    // gives better starting positions for each direction.
    const shift = BigInt(64 - this.GEO_BITS);
    for (let bit = 0; bit < this.GEO_BITS; bit++) {
      const targetId = newNodeId ^ (1n << (shift + BigInt(bit)));
      iterativeLookup(targetId, newNode, 2);
    }

    newNode._nodeMapRef = this.nodeMap;
    newNode.temperature = this.EN_ANNEALING ? this.T_INIT : 1.0;
    return newNode.synaptome.size;
  }

  // ── Routing ─────────────────────────────────────────────────────────────────

  async lookup(sourceId, targetKey) {
    const source = this.nodeMap.get(sourceId);
    if (!source || !source.alive) return null;

    this.simEpoch++;
    if (++this.lookupsSinceDecay >= this.DECAY_INTERVAL) {
      this._tickDecay();
      this.lookupsSinceDecay = 0;
    }

    if (++this._annealBufCount >= this.ANNEAL_BUF_REBUILD) {
      this._annealBufDirty = true;
      this._annealBufCount = 0;
    }

    // Rule 11: Markov hot-destination pre-learning
    if (this.EN_MARKOV) {
      this._markovRecord(source, targetKey);
      if (!this._hasAny(source, targetKey)) {
        const freq = source.recentDestFreq.get(targetKey) ?? 0;
        if (freq >= this.MARKOV_HOT_THRESHOLD) {
          const wt = Math.min(this.MARKOV_MAX_WEIGHT,
            this.MARKOV_BASE_WEIGHT +
            (this.MARKOV_MAX_WEIGHT - this.MARKOV_BASE_WEIGHT) * (freq / this.MARKOV_WINDOW));
          this._introduce(sourceId, targetKey, wt);
        }
      }
    }

    const path    = [sourceId];
    const trace   = [];
    const queried = new Set([sourceId]);   // NX-4: track visited nodes
    let currentId   = sourceId;
    let totalTimeMs = 0;
    let reached     = false;

    for (let hop = 0; hop < this.MAX_GREEDY_HOPS; hop++) {
      const current = this.nodeMap.get(currentId);
      if (!current || !current.alive) break;

      const currentDist = current.id ^ targetKey;
      if (currentDist === 0n) { reached = true; break; }

      // Yield every 4 hops to keep the main thread responsive. On cold-
      // corridor lookups (e.g. NA→AS), a single lookup can do ~8 hops of
      // ~1,200 ops each — 10 K+ ops of uninterrupted sync compute would
      // block the heartbeat-tick setInterval (400 ms). Yielding mid-lookup
      // caps the blocking window to ~4 hops × ~1 ms each = ~4-50 ms.
      if (hop > 0 && hop % 4 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }

      // Collect forward-progress candidates from all tiers
      // NX-6: collect dead synapses for deferred eviction+replacement
      const deadSynapses = [];
      const candidates = [];
      for (const s of current.synaptome.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue;
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) { deadSynapses.push({ tier: 'local', syn: s }); s.weight = 0; continue; }
        candidates.push(s);
      }
      if (this.EN_TWO_TIER) {
        for (const s of current.highway.values()) {
          if ((s.peerId ^ targetKey) >= currentDist) continue;
          const peer = this.nodeMap.get(s.peerId);
          if (!peer?.alive) { deadSynapses.push({ tier: 'highway', syn: s }); continue; }
          candidates.push(s);
        }
      }
      for (const s of current.incomingSynapses.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue;
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) continue;
        candidates.push(s);
      }

      // NX-6: Process dead synapses — reheat + evict/replace
      if (deadSynapses.length > 0) {
        // Strategy A: Churn-triggered temperature reheat
        if (this.EN_ANNEALING) {
          current.temperature = Math.max(current.temperature, this.T_REHEAT);
        }
        // Strategy B: Immediate dead-synapse eviction + replacement
        for (const { tier, syn } of deadSynapses) {
          if (tier === 'local' && this.EN_DEAD_EVICTION) {
            const newSyn = this._evictAndReplace(current, syn);
            // Immediately reroute: if replacement makes forward progress,
            // add it to this hop's candidates so the current lookup can use it
            if (newSyn && (newSyn.peerId ^ targetKey) < currentDist) {
              candidates.push(newSyn);
            }
          } else if (tier === 'highway') {
            current.highway.delete(syn.peerId);
          }
        }
      }

      // NX-4: Iterative fallback — when no forward-progress candidate exists,
      // find the closest unvisited peer to the target (regardless of XOR progress)
      if (candidates.length === 0) {
        let bestSyn = null;
        let bestDist = null;
        const scanPeer = (s) => {
          if (queried.has(s.peerId)) return;
          const peer = this.nodeMap.get(s.peerId);
          if (!peer?.alive) {
            // NX-6: reheat on dead peer in fallback scan too
            if (this.EN_ANNEALING) {
              current.temperature = Math.max(current.temperature, this.T_REHEAT);
            }
            return;
          }
          const d = s.peerId ^ targetKey;
          if (bestDist === null || d < bestDist) {
            bestDist = d;
            bestSyn = s;
          }
        };
        for (const s of current.synaptome.values()) scanPeer(s);
        if (this.EN_TWO_TIER) {
          for (const s of current.highway.values()) scanPeer(s);
        }
        for (const s of current.incomingSynapses.values()) scanPeer(s);

        if (!bestSyn) break;          // truly exhausted — no unvisited peers
        candidates.push(bestSyn);     // use as sole candidate for hop selection
      }

      const inTargetRegion =
        ((current.id ^ targetKey) >> BigInt(64 - this.GEO_REGION_BITS)) === 0n;

      // Select next hop: priority order
      let nextSyn;

      // Priority 1: direct synapse to target
      const directSyn = current.synaptome.get(targetKey)
                     ?? (this.EN_TWO_TIER ? current.highway.get(targetKey) : undefined)
                     ?? current.incomingSynapses.get(targetKey);
      if (directSyn && this.nodeMap.get(targetKey)?.alive) {
        nextSyn = directSyn;
      }

      // Priority 2: explore randomly (first hop, epsilon-greedy)
      if (!nextSyn && hop === 0 && Math.random() < this.EXPLORATION_EPSILON) {
        nextSyn = candidates[Math.floor(Math.random() * candidates.length)];
      }

      // Priority 4: two-hop lookahead AP scoring
      if (!nextSyn) {
        const wScale = inTargetRegion ? this.WEIGHT_SCALE : 0;
        nextSyn = this._bestByTwoHopAP(current, candidates, targetKey, currentDist, wScale);
      }

      const nextId   = nextSyn.peerId;
      const nextNode = this.nodeMap.get(nextId);
      if (!nextNode) break;

      // NX-5: Incoming synapse promotion — when an incomingSynapse proves
      // its routing value through repeated use, promote it to a full synapse.
      // This lets the network organically discover and cement the connections
      // that actually carry traffic, similar to Hebbian "fire together, wire
      // together" learning.
      if (current.incomingSynapses.has(nextId) && !current.synaptome.has(nextId)) {
        const inc = current.incomingSynapses.get(nextId);
        inc.useCount = (inc.useCount ?? 0) + 1;
        if (inc.useCount >= this.INCOMING_PROMOTE_THRESHOLD) {
          const latMs   = inc.latency;
          const stratum = inc.stratum;
          const promoted = new Synapse({ peerId: nextId, latencyMs: latMs, stratum });
          promoted.weight = 0.5;  // start at mid-weight — already proven useful
          if (this._stratifiedAdd(current, promoted)) {
            current.incomingSynapses.delete(nextId);
          }
        }
      }

      queried.add(nextId);           // NX-4: mark visited
      path.push(nextId);
      trace.push({ fromId: currentId, synapse: nextSyn });
      totalTimeMs += nextSyn.latency;

      // TRAFFIC: each hop transition is one wire FIND_NODE message.
      this._msg(current, nextNode, 'find_node');

      // Highway renewal timestamp (N-15W rule)
      if (this.EN_TWO_TIER) {
        nextSyn.lastActiveEpoch = this.simEpoch;
        const hwRenew = current.highway.get(nextSyn.peerId);
        if (hwRenew && hwRenew !== nextSyn) hwRenew.lastActiveEpoch = this.simEpoch;
      }

      // Optional: Load tracking for load-aware AP scoring
      if (this.EN_LOAD_BALANCING) {
        const elapsed = this.simEpoch - (nextNode.loadLastEpoch ?? 0);
        nextNode.loadEMA       = (nextNode.loadEMA ?? 0) * Math.pow(this.LOAD_DECAY, elapsed)
                                 + (1 - this.LOAD_DECAY);
        nextNode.loadLastEpoch = this.simEpoch;
      }

      // Rule 5: Triadic closure (not at source)
      if (this.EN_TRIADIC && currentId !== sourceId) {
        this._recordTransit(current, sourceId, nextId);
      }

      // Rule 6/7: Hop caching + lateral spread
      if (this.EN_HOP_CACHING && currentId !== targetKey) {
        this._introduceAndSpread(currentId, targetKey);
      }

      // Rule 9: Simulated annealing
      if (this.EN_ANNEALING) {
        current.temperature = Math.max(this.T_MIN, current.temperature * this.ANNEAL_COOLING);
        // v0.70.03 — ANNEAL_RATE_SCALE throttle (default 1.0 = unchanged)
        if (Math.random() < current.temperature * this.ANNEAL_RATE_SCALE) {
          this._tryAnneal(current);
        }
      }

      // Rule 13: Highway refresh
      if (this.EN_TWO_TIER && this.EN_HIGHWAY_REFRESH) {
        if (++current.hubRefreshCount >= this.HUB_REFRESH_INTERVAL) {
          current.hubRefreshCount = 0;
          this._refreshHighway(current);
        }
      }

      currentId = nextId;
    }

    const hopCount = path.length - 1;
    if (reached) {
      this._emaHops = this._emaHops === null
        ? hopCount : 0.9 * this._emaHops + 0.1 * hopCount;
      this._emaTime = this._emaTime === null
        ? totalTimeMs : 0.9 * this._emaTime + 0.1 * totalTimeMs;

      // Rule 4: LTP reinforcement on fast paths
      if (this.EN_LTP && trace.length > 0 && totalTimeMs <= this._emaTime) {
        this._reinforceWave(trace);
      }

      // Rule 6: Cascade backpropagation
      if (this.EN_HOP_CACHING && trace.length >= 2) {
        const last = trace[trace.length - 1];
        if (last.synapse.peerId === targetKey) {
          const gatewayId = last.fromId;
          for (let j = 0; j < trace.length - 1; j++) {
            const fromNode = this.nodeMap.get(trace[j].fromId);
            if (fromNode && !this._hasAny(fromNode, targetKey)) {
              this._introduce(trace[j].fromId, gatewayId, this.HOP_CASCADE_WEIGHT);
            }
          }
        }
      }
    }

    return {
      path,
      hops:  path.length - 1,
      time:  totalTimeMs,
      found: reached,
    };
  }

  // ── LTP reinforcement wave ──────────────────────────────────────────────────

  _reinforceWave(trace) {
    for (let i = trace.length - 1; i >= 0; i--) {
      const { fromId, synapse } = trace[i];
      const node = this.nodeMap.get(fromId);
      if (!node) continue;
      const syn = node.synaptome.get(synapse.peerId)
               ?? (this.EN_TWO_TIER ? node.highway.get(synapse.peerId) : undefined);
      if (syn) {
        syn.reinforce(this.simEpoch, this.INERTIA_DURATION);
        syn.useCount = (syn.useCount ?? 0) + 1;
        // TRAFFIC: LTP feedback — peer acknowledges that node's synapse to
        // it carried a fast-path lookup. One wire ack per reinforced step.
        const peer = this.nodeMap.get(synapse.peerId);
        if (peer) this._msg(peer, node, 'reinforce');
      }
    }
  }

  // ── Two-hop lookahead AP selection ─────────────────────────────────────────

  _bestByTwoHopAP(current, candidates, targetKey, currentDist, wScale) {
    const sorted = candidates.map(s => {
      const pd  = s.peerId ^ targetKey;
      let ap1   = (Number(currentDist - pd) / s.latency) * (1 + wScale * s.weight);
      // Optional load balancing penalty
      if (this.EN_LOAD_BALANCING) {
        const peer = this.nodeMap.get(s.peerId);
        if (peer && peer.loadEMA !== undefined) {
          const elapsed = this.simEpoch - (peer.loadLastEpoch ?? 0);
          const load    = peer.loadEMA * Math.pow(this.LOAD_DECAY, elapsed);
          ap1 *= Math.max(this.LOAD_FLOOR,
                          1 - this.LOAD_PENALTY * (load / this.LOAD_SATURATION));
        }
      }
      return { s, ap1 };
    }).sort((a, b) => b.ap1 - a.ap1);

    // ── Last-hop / trusted-route shortcut ──────────────────────────────────
    // The two-hop probe's purpose is to avoid greedy local minima. Once the
    // top-AP1 candidate is either very close to the target or carries a
    // strongly-reinforced LTP weight, the probe cannot improve on one-hop
    // greedy — and its cost (5× synaptome scan + sort) dominates lookup
    // wall-clock. Skip it in those cases.
    //
    // This was the main source of wall-clock slowness on cross-continent
    // NA→AS lookups where each hop makes enough XOR progress that the
    // probe adds no routing information.
    if (sorted.length > 0) {
      const top = sorted[0].s;
      const topDist = top.peerId ^ targetKey;
      if (topDist === 0n) return top;                    // exact match
      if (topDist < (currentDist >> 4n)) return top;     // ≥ 4 bits of XOR progress — last-hop territory
      if (top.weight > 0.5) return top;                  // well-trained synapse — trust greedy
    }

    const probeSet = sorted.slice(0, this.LOOKAHEAD_ALPHA).map(x => x.s);

    let bestSyn = null;
    let bestAP2 = -Infinity;

    for (const firstSyn of probeSet) {
      const firstDist = firstSyn.peerId ^ targetKey;
      if (firstDist === 0n) return firstSyn;

      const firstNode = this.nodeMap.get(firstSyn.peerId);
      if (!firstNode?.alive) continue;

      // TRAFFIC: each two-hop AP probe asks `firstNode` for its closest
      // peer to target. One wire round-trip per probe-set entry.
      this._msg(current, firstNode, 'lookahead_probe');

      const fwdCands = [];
      for (const fs of firstNode.synaptome.values()) {
        if ((fs.peerId ^ targetKey) < firstDist && this.nodeMap.get(fs.peerId)?.alive)
          fwdCands.push(fs);
      }
      if (this.EN_TWO_TIER) {
        for (const fs of firstNode.highway.values()) {
          if ((fs.peerId ^ targetKey) < firstDist && this.nodeMap.get(fs.peerId)?.alive)
            fwdCands.push(fs);
        }
      }

      let twoHopDist, secondLatency;
      if (fwdCands.length === 0) {
        twoHopDist    = firstDist;
        secondLatency = 0;
      } else {
        const bestFwd = firstNode.bestByAP(fwdCands, targetKey, wScale);
        twoHopDist    = bestFwd.peerId ^ targetKey;
        secondLatency = bestFwd.latency;
      }

      const progress2 = Number(currentDist - twoHopDist);
      const totalLat  = firstSyn.latency + secondLatency;
      const ap2       = (progress2 / totalLat) * (1 + wScale * firstSyn.weight);

      if (ap2 > bestAP2) { bestAP2 = ap2; bestSyn = firstSyn; }
    }

    return bestSyn ?? current.bestByAP(candidates, targetKey, wScale);
  }

  // ── Standard introduce ──────────────────────────────────────────────────────

  _introduce(aId, cId, initialWeight = 0.5) {
    const nodeA = this.nodeMap.get(aId);
    const nodeC = this.nodeMap.get(cId);
    if (!nodeA || !nodeC || !nodeA.alive || !nodeC.alive) return;
    if (this._hasAny(nodeA, cId)) return;

    const latMs   = roundTripLatency(nodeA, nodeC);
    const stratum = clz64(nodeA.id ^ nodeC.id);
    const syn     = new Synapse({ peerId: cId, latencyMs: latMs, stratum });
    syn.weight    = initialWeight;
    const added = this._stratifiedAdd(nodeA, syn);
    // TRAFFIC: A probes C to confirm liveness and learn latency. Counted
    // only on successful add so silent bilateral-cap refusals don't
    // contribute. This site fires for: triadic closure, Markov pre-learn,
    // cascade backpropagation, and any future _introduce caller.
    if (added) this._msg(nodeA, nodeC, 'introduce_probe');
  }

  // ── Hop caching + cascading lateral spread ──────────────────────────────────

  _introduceAndSpread(aId, cId, depth = 1) {
    const nodeA = this.nodeMap.get(aId);
    const nodeC = this.nodeMap.get(cId);
    if (!nodeA || !nodeC || !nodeA.alive || !nodeC.alive) return;
    if (this._hasAny(nodeA, cId)) return;

    const latMs   = roundTripLatency(nodeA, nodeC);
    const stratum = clz64(nodeA.id ^ nodeC.id);
    const syn     = new Synapse({ peerId: cId, latencyMs: latMs, stratum });
    syn.weight    = 0.5;
    const added   = this._stratifiedAdd(nodeA, syn);

    // TRAFFIC: hop-cache pickup probes C from A; charge depth-1 vs deeper
    // separately so we can see which level produces the bulk of writes.
    if (added) this._msg(nodeA, nodeC, depth === 1 ? 'hop_cache' : 'hop_cache_lateral');

    // Rule 7: Cascade to regional neighbours
    if (this.EN_LATERAL_SPREAD && added && depth <= this.LATERAL_MAX_DEPTH) {
      const aRegion  = aId >> BigInt(64 - this.GEO_REGION_BITS);
      const regional = [];
      for (const s of nodeA.synaptome.values()) {
        if (s.peerId === cId) continue;
        if ((s.peerId >> BigInt(64 - this.GEO_REGION_BITS)) !== aRegion) continue;
        if (this.nodeMap.get(s.peerId)?.alive) regional.push(s);
      }
      regional.sort((a, b) => b.weight - a.weight);
      const k = depth === 1 ? this.LATERAL_K : this.LATERAL_K2;
      for (let i = 0; i < Math.min(k, regional.length); i++) {
        // TRAFFIC: lateral spread tells the regional peer about target.
        const lateralPeer = this.nodeMap.get(regional[i].peerId);
        if (lateralPeer) this._msg(nodeA, lateralPeer, 'lateral_spread');
        this._introduceAndSpread(regional[i].peerId, cId, depth + 1);
      }
    }
  }

  // ── Two-tier helper ─────────────────────────────────────────────────────────

  _hasAny(node, peerId) {
    return node.synaptome.has(peerId)
        || (this.EN_TWO_TIER && !!(node.highway?.has(peerId)));
  }

  // ── Local-tier stratified admission ────────────────────────────────────────

  _stratifiedAdd(node, newSyn) {
    // Physical-transport gate. If either side is at cap, refuse silently
    // — the caller (LTP introduce, hop caching, triadic closure) will try
    // again on a future lookup. Aggressive eviction-on-refusal was tried
    // in v0.63.05 and produced severe synaptome thrashing: good routes
    // were evicted before LTP could reinforce them, degrading baseline
    // routing quality by ~10 pp. The churn-resilience fix lives in
    // `_evictAndReplace` alone (where the alternative — leaving a slot
    // empty after a peer dies — is genuinely worse than evicting any
    // substitute).
    const peer = this.nodeMap?.get(newSyn.peerId);
    if (peer && !node.tryConnect(peer)) return false;

    if (node.synaptome.size < this.MAX_SYNAPTOME_SIZE) {
      node.addSynapse(newSyn);
      return true;
    }

    if (!this.EN_STRATIFIED) {
      // Simple eviction: weakest non-bootstrap connection preferred
      let weakest = null, weakestW = Infinity;
      let weakestAny = null, weakestAnyW = Infinity;
      for (const syn of node.synaptome.values()) {
        if (syn.weight < weakestAnyW) { weakestAnyW = syn.weight; weakestAny = syn; }
        if (!syn.bootstrap && syn.weight < weakestW) { weakestW = syn.weight; weakest = syn; }
      }
      const victim = weakest ?? weakestAny;
      if (!victim) return false;
      node.synaptome.delete(victim.peerId);
      node.addSynapse(newSyn);
      return true;
    }

    const { counts, byGroup } = this._buildGroupCounts(node);

    let evictGroup = -1, maxCount = this.STRATUM_FLOOR;
    for (let g = 0; g < this.STRATA_GROUPS; g++) {
      if (counts[g] > maxCount) { maxCount = counts[g]; evictGroup = g; }
    }
    if (evictGroup === -1) return false;

    let weakest = null, weakestW = Infinity;
    let weakestAny = null, weakestAnyW = Infinity;
    for (const syn of byGroup[evictGroup]) {
      if (syn.weight < weakestAnyW) { weakestAnyW = syn.weight; weakestAny = syn; }
      if (!syn.bootstrap && syn.weight < weakestW) { weakestW = syn.weight; weakest = syn; }
    }
    const victim = weakest ?? weakestAny;
    if (!victim) return false;

    node.synaptome.delete(victim.peerId);
    node.addSynapse(newSyn);
    return true;
  }

  // ── Highway tier management ─────────────────────────────────────────────────

  _refreshHighway(node) {
    if (!node.alive || this.HIGHWAY_SLOTS === 0) return;

    const candidates = [];
    const seen       = new Set([node.id]);

    outer:
    for (const syn of node.synaptome.values()) {
      const peer = this.nodeMap.get(syn.peerId);
      if (!peer?.alive) continue;
      // TRAFFIC: highway-refresh probes each 1-hop peer for its synaptome
      // to discover candidate hubs. One RPC per peer iterated.
      this._msg(node, peer, 'highway_probe');
      seen.add(peer.id);
      for (const pSyn of peer.synaptome.values()) {
        if (seen.has(pSyn.peerId)) continue;
        seen.add(pSyn.peerId);
        const candidate = this.nodeMap.get(pSyn.peerId);
        if (!candidate?.alive) continue;
        candidates.push(candidate);
        if (candidates.length >= this.HUB_SCAN_CAP) break outer;
      }
    }

    const scored = candidates
      .map(c => ({ node: c, score: this._stratumDiversity(c) + Math.random() * this.HUB_NOISE }))
      .filter(c => c.score >= this.HUB_MIN_DIVERSITY);

    scored.sort((a, b) => b.score - a.score);

    node.highway.clear();
    for (let i = 0; i < Math.min(this.HIGHWAY_SLOTS, scored.length); i++) {
      const hub     = scored[i].node;
      const latMs   = roundTripLatency(node, hub);
      const stratum = clz64(node.id ^ hub.id);
      const syn     = new Synapse({ peerId: hub.id, latencyMs: latMs, stratum });
      syn.weight          = 0.5;
      syn.lastActiveEpoch = this.simEpoch;   // grace period on creation
      node.highway.set(hub.id, syn);
    }
  }

  _stratumDiversity(node) {
    const groups = new Set();
    for (const syn of node.synaptome.values()) groups.add(syn.stratum >>> 2);
    return groups.size;
  }

  // ── Markov rolling-window tracking ─────────────────────────────────────────

  _markovRecord(node, targetKey) {
    node.recentDests.push(targetKey);
    node.recentDestFreq.set(targetKey, (node.recentDestFreq.get(targetKey) ?? 0) + 1);
    if (node.recentDests.length > this.MARKOV_WINDOW) {
      const evicted = node.recentDests.shift();
      const f = node.recentDestFreq.get(evicted) - 1;
      if (f <= 0) node.recentDestFreq.delete(evicted);
      else        node.recentDestFreq.set(evicted, f);
    }
  }

  // ── Triadic closure ─────────────────────────────────────────────────────────

  _recordTransit(node, originId, nextId) {
    const key   = `${originId}_${nextId}`;
    const count = (node.transitCache.get(key) ?? 0) + 1;
    if (count >= this.INTRODUCTION_THRESHOLD) {
      node.transitCache.delete(key);
      // TRAFFIC: the transit observer (`node`) hints to the original source
      // that it should connect to nextId. One wire message per fired triadic.
      const nodeA = this.nodeMap.get(originId);
      if (nodeA) this._msg(node, nodeA, 'triadic_introduce');
      this._introduce(originId, nextId);
    } else {
      node.transitCache.set(key, count);
    }
  }

  // ── Local-tier annealing ────────────────────────────────────────────────────

  _tryAnneal(node) {
    if (!node.alive || node.synaptome.size === 0) return;
    if (node.synaptome.size <= this.SYNAPTOME_FLOOR) return;

    let weakest = null, weakestW = Infinity;
    let targetLo = 0, targetHi = 63;

    let weakestAny = null, weakestAnyW = Infinity;

    if (this.EN_STRATIFIED) {
      const { counts, byGroup } = this._buildGroupCounts(node);

      let evictGroup = -1, maxCount = this.STRATUM_FLOOR;
      for (let g = 0; g < this.STRATA_GROUPS; g++) {
        if (counts[g] > maxCount) { maxCount = counts[g]; evictGroup = g; }
      }
      if (evictGroup === -1) return;

      let minCount = Infinity, targetGroup = 0;
      for (let g = 0; g < this.STRATA_GROUPS; g++) {
        if (counts[g] < minCount) { minCount = counts[g]; targetGroup = g; }
      }
      targetLo = targetGroup * 4;
      targetHi = targetLo + 3;

      for (const syn of byGroup[evictGroup]) {
        if (syn.weight < weakestAnyW) { weakestAnyW = syn.weight; weakestAny = syn; }
        if (!syn.bootstrap && syn.weight < weakestW) { weakestW = syn.weight; weakest = syn; }
      }
    } else {
      for (const syn of node.synaptome.values()) {
        if (syn.weight < weakestAnyW) { weakestAnyW = syn.weight; weakestAny = syn; }
        if (!syn.bootstrap && syn.weight < weakestW) { weakestW = syn.weight; weakest = syn; }
      }
    }
    const victim = weakest ?? weakestAny;
    if (!victim) return;

    const useGlobal = Math.random() < ((node.temperature ?? 0.5) * this.GLOBAL_BIAS);
    const candidate = useGlobal
      ? this._globalCandidate(node, targetLo, targetHi)
      : this._localCandidate(node, targetLo, targetHi);

    if (!candidate || this._hasAny(node, candidate.id)) return;

    // Free the victim's physical slot before trying to connect the candidate —
    // otherwise tryConnect would refuse at-cap even though the victim is about
    // to be evicted from the synaptome.
    const victimPeer = this.nodeMap.get(victim.peerId);
    node.synaptome.delete(victim.peerId);
    if (victimPeer) node.disconnect(victimPeer);

    if (!node.tryConnect(candidate)) return;  // candidate's own cap blocked us
    const latMs   = roundTripLatency(node, candidate);
    const stratum = clz64(node.id ^ candidate.id);
    const newSyn  = new Synapse({ peerId: candidate.id, latencyMs: latMs, stratum });
    newSyn.weight = 0.1;
    node.addSynapse(newSyn);
    // TRAFFIC: anneal handshake — node connects to a fresh candidate
    // discovered via 2-hop scan. One wire message per successful anneal.
    this._msg(node, candidate, 'anneal');
  }

  // ── Global candidate (annealing exploration) ───────────────────────────────

  // HONESTY: No access to global nodeMap — nodes can only explore via their
  // own synaptome neighbourhood. Delegate to _localCandidate (2-hop search).
  _globalCandidate(node, lo, hi) {
    return this._localCandidate(node, lo, hi);
  }

  // ── Local candidate (annealing neighbourhood) ─────────────────────────────

  _localCandidate(node, lo, hi) {
    const list = this._localCandidateList(node, lo, hi);
    return list.length > 0 ? list[0] : null;
  }

  /** Return a shuffled list of all viable 2-hop-neighbourhood candidates in
   *  the given stratum range. Callers that may be refused by `tryConnect`
   *  (i.e. `_evictAndReplace` under a bilateral-cap regime) can iterate
   *  through this list retrying instead of giving up after a single pick. */
  _localCandidateList(node, lo, hi) {
    const candidates = [];
    outer:
    for (const syn of node.synaptome.values()) {
      const peer = this.nodeMap.get(syn.peerId);
      if (!peer?.alive) continue;
      // TRAFFIC: each 1-hop peer probed for its synaptome is a "tell me
      // your peers" RPC. Inner loop is data within that response.
      this._msg(node, peer, 'local_probe');
      for (const peerSyn of peer.synaptome.values()) {
        const id = peerSyn.peerId;
        if (id === node.id || this._hasAny(node, id)) continue;
        const candidate = this.nodeMap.get(id);
        if (!candidate?.alive) continue;
        const stratum = clz64(node.id ^ id);
        if (stratum >= lo && stratum <= hi) {
          candidates.push(candidate);
          if (candidates.length >= this.ANNEAL_LOCAL_SAMPLE) break outer;
        }
      }
    }
    // Fisher–Yates shuffle so retries don't collide on the same first pick
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    return candidates;
  }

  // ── NX-6: Dead-synapse eviction + replacement ──────────────────────────────

  /**
   * Immediately remove a dead synapse and attempt to fill the slot with a
   * local candidate from the 2-hop neighborhood in the same stratum range.
   */
  _evictAndReplace(node, deadSyn) {
    const stratum = deadSyn.stratum;
    // The dead peer held a physical slot too; free it before we probe for a
    // replacement so tryConnect has room.
    node.synaptome.delete(deadSyn.peerId);
    node.connections.delete(deadSyn.peerId);   // peer is dead — no bilateral cleanup needed

    // Target the same stratum group as the dead peer
    const group = Math.min(this.STRATA_GROUPS - 1, stratum >>> 2);
    const lo = group * 4;
    const hi = lo + 3;

    // Under a bilateral connection cap, picking a single random candidate
    // and giving up on refusal leaks slots: the dead peer's slot stays
    // empty and the synaptome shrinks permanently. Iterate the shuffled
    // candidate list until one accepts — typically the first 1-3 pass on
    // an under-loaded network, later ones on a saturated one. If every
    // local candidate refuses, we fall through to the widened scan below.
    const localCands = this._localCandidateList(node, lo, hi);
    let candidate = null;
    for (const c of localCands) {
      if (this._hasAny(node, c.id)) continue;
      if (node.tryConnect(c)) { candidate = c; break; }
    }

    // Fallback: widen the stratum window. If the target stratum is empty
    // or every candidate in it is at cap, search the whole synaptome's
    // 2-hop neighbourhood for any free-slot peer. Better to replace with
    // a suboptimal-stratum peer than to leave the slot empty.
    if (!candidate) {
      const wideCands = this._localCandidateList(node, 0, 63);
      for (const c of wideCands) {
        if (this._hasAny(node, c.id)) continue;
        if (node.tryConnect(c)) { candidate = c; break; }
      }
    }

    if (!candidate) return null;

    // Replacement weight = median of existing synapses (not penalised —
    // the dead node was killed by churn, the replacement is equally stable)
    const weights = [];
    for (const s of node.synaptome.values()) weights.push(s.weight);
    weights.sort((a, b) => a - b);
    const medianW = weights.length > 0
      ? weights[weights.length >> 1]
      : this.PRUNE_THRESHOLD;

    const latMs      = roundTripLatency(node, candidate);
    const newStratum = clz64(node.id ^ candidate.id);
    const newSyn     = new Synapse({ peerId: candidate.id, latencyMs: latMs, stratum: newStratum });
    newSyn.weight    = medianW;
    node.addSynapse(newSyn);
    // TRAFFIC: A confirms the chosen replacement candidate (handshake to
    // learn live latency). One wire message per successful replace.
    this._msg(node, candidate, 'evict_replace');
    return newSyn;   // return so caller can add to current-hop candidates
  }

  // ── Stratum group helpers ──────────────────────────────────────────────────

  _buildGroupCounts(node) {
    const counts  = new Array(this.STRATA_GROUPS).fill(0);
    const byGroup = Array.from({ length: this.STRATA_GROUPS }, () => []);
    for (const syn of node.synaptome.values()) {
      const g = Math.min(this.STRATA_GROUPS - 1, syn.stratum >>> 2);
      counts[g]++;
      byGroup[g].push(syn);
    }
    return { counts, byGroup };
  }

  // ── Adaptive temporal decay ────────────────────────────────────────────────

  _tickDecay() {
    for (const node of this.nodeMap.values()) {
      this._decayTier(node, node.synaptome, true);
      if (this.EN_TWO_TIER) this._decayTier(node, node.highway, false);
    }
  }

  _decayTier(node, tierMap, applyStructuralRule) {
    const toPrune   = [];
    const isHighway = !applyStructuralRule;

    for (const syn of tierMap.values()) {
      if (syn.inertia > this.simEpoch) continue;

      let gamma;
      if (isHighway) {
        if (this.EN_ADAPTIVE_DECAY) {
          const lastActive = syn.lastActiveEpoch ?? 0;
          const isActive   = (lastActive + this.HIGHWAY_RENEWAL_WINDOW) > this.simEpoch;
          gamma = isActive ? this.DECAY_GAMMA_HIGHWAY_ACTIVE : this.DECAY_GAMMA_HIGHWAY_IDLE;
        } else {
          gamma = this.DECAY_GAMMA_MIN;   // fixed cold rate when adaptive decay off
        }
      } else {
        if (this.EN_ADAPTIVE_DECAY) {
          const useFrac = Math.min(1, (syn.useCount ?? 0) / this.USE_SATURATION);
          gamma = this.DECAY_GAMMA_MIN + (this.DECAY_GAMMA_MAX - this.DECAY_GAMMA_MIN) * useFrac;
        } else {
          gamma = this.DECAY_GAMMA_MIN;   // fixed rate when adaptive decay off
        }
      }
      // Bootstrap synapses decay more slowly — blend toward GAMMA_MAX
      if (syn.bootstrap) gamma = gamma + (this.DECAY_GAMMA_MAX - gamma) * 0.5;
      syn.decay(gamma);

      if (syn.weight < this.PRUNE_THRESHOLD) toPrune.push(syn);
    }

    if (!toPrune.length) return;

    // Highway floor
    if (isHighway) {
      if (tierMap.size <= this.HIGHWAY_FLOOR) {
        for (const syn of toPrune) syn.weight = this.PRUNE_THRESHOLD;
        return;
      }
      const canDelete = tierMap.size - this.HIGHWAY_FLOOR;
      toPrune.sort((a, b) => a.weight - b.weight);
      for (let i = 0; i < toPrune.length; i++) {
        if (i < canDelete) tierMap.delete(toPrune[i].peerId);
        else               toPrune[i].weight = this.PRUNE_THRESHOLD;
      }
      return;
    }

    // Guard B: local tier synaptome floor
    if (tierMap.size <= this.SYNAPTOME_FLOOR) {
      for (const syn of toPrune) syn.weight = this.PRUNE_THRESHOLD;
      return;
    }

    if (!this.EN_STRATIFIED) {
      // Simple: delete below-threshold, but spare bootstrap synapses
      for (const syn of toPrune) {
        if (syn.bootstrap) { syn.weight = this.PRUNE_THRESHOLD; continue; }
        tierMap.delete(syn.peerId);
      }
      return;
    }

    // Per-stratum structural survival rule
    const byStratum = new Map();
    for (const syn of toPrune) {
      let arr = byStratum.get(syn.stratum);
      if (!arr) { arr = []; byStratum.set(syn.stratum, arr); }
      arr.push(syn);
    }

    const minPerStratum = this._k;
    for (const [stratum, candidates] of byStratum) {
      let total = 0;
      for (const s of tierMap.values()) { if (s.stratum === stratum) total++; }
      const removable = Math.max(0, total - minPerStratum);
      candidates.sort((a, b) => a.weight - b.weight);
      for (let i = 0; i < candidates.length; i++) {
        if (i < removable) tierMap.delete(candidates[i].peerId);
        else               candidates[i].weight = this.PRUNE_THRESHOLD;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Traffic Counters (parity with SimulatedNetwork.send instrumentation)
  // v0.70.02 — NX-6's routing primitives access peers via this.nodeMap
  // directly (just like NH-1), so SimulatedNetwork.send's traffic counters
  // never fire for the bulk of the protocol's wire activity. _msg() is the
  // NX-6-side equivalent: every lookup hop, two-hop probe, LTP step, hop
  // cache, lateral spread, triadic intro, local candidate scan, highway
  // refresh, and dead-peer replacement calls _msg() once per conceptual
  // wire message. Every NX-6 descendant (NX-7…NX-17) inherits this
  // automatically because none of them override the routing methods.
  // ═══════════════════════════════════════════════════════════════════════════

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

  // ── Stats ──────────────────────────────────────────────────────────────────

  getStats() {
    const base  = super.getStats();
    const nodes = [...this.nodeMap.values()];
    const localSyn  = nodes.reduce((a, n) => a + n.synaptome.size, 0);
    const hwSyn     = nodes.reduce((a, n) => a + (n.highway?.size ?? 0), 0);
    const avgTemp   = nodes.length
      ? (nodes.reduce((a, n) => a + (n.temperature ?? this.T_INIT), 0) / nodes.length).toFixed(3)
      : '—';

    return {
      ...base,
      protocol:      'Neuromorphic-NX6',
      epoch:         this.simEpoch,
      avgSynapses:   nodes.length ? ((localSyn + hwSyn) / nodes.length).toFixed(1) : 0,
      avgLocalSyn:   nodes.length ? (localSyn / nodes.length).toFixed(1) : 0,
      avgHighwaySyn: nodes.length ? (hwSyn / nodes.length).toFixed(1) : 0,
      avgTemp,
    };
  }
}
