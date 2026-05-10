/**
 * GeographicDHT – a Kademlia variant where node IDs are derived from
 * physical location.
 *
 * Standard Kademlia assigns each node a random ID drawn uniformly from the
 * key space, so XOR distances carry no geographic meaning.
 *
 * GeographicDHT instead assigns IDs whose high-order bits encode the node's
 * S2-like geographic cell (via a Hilbert-curve mapping of lat/lng).  The
 * remaining lower bits are random to guarantee uniqueness within a cell.
 *
 *   Node ID layout  (32 bits total, geoBits = 8 example):
 *   ┌─────────────────────────┬────────────────────────────────┐
 *   │  geographic prefix      │  random suffix                 │
 *   │  (top geoBits bits)     │  (bottom 32-geoBits bits)      │
 *   │  8 bits → 256 geo cells │  24 bits → ~16 M unique IDs    │
 *   └─────────────────────────┴────────────────────────────────┘
 *
 * Consequence for routing:
 *   • Nodes in the same geographic cell share the same high-order bits.
 *   • XOR distance between two nodes is small when they are nearby.
 *   • Iterative FIND_NODE lookups tend to traverse geographically coherent
 *     paths, reducing propagation latency compared to random-ID Kademlia.
 *
 * Everything else (k-buckets, α-parallel lookup, termination) is unchanged.
 */

import { KademliaDHT, KademliaNode } from '../kademlia/KademliaDHT.js';
import { randomU64, buildIntraCellTable, buildInterCellTable, reservoirSample, buildXorRoutingTable, _collectBucket } from '../../utils/geo.js';
import { geoCellId }                  from '../../utils/s2.js';

// ─────────────────────────────────────────────────────────────────────────────
// GeographicDHT (original G-DHT-8: three-layer bootstrap)
// ─────────────────────────────────────────────────────────────────────────────

export class GeographicDHT extends KademliaDHT {
  /**
   * @param {object} config
   * @param {number} config.geoBits  – geographic prefix width in bits (default 8)
   * @param {number} config.k        – k-bucket size (default 20)
   * @param {number} config.alpha    – lookup parallelism (default 3)
   * @param {number} config.bits     – total key-space width (default 32)
   */
  constructor(config = {}) {
    super(config);
    this.geoBits = config.geoBits ?? 8;
    // Allow 3 consecutive no-progress rounds before terminating (vs Kademlia's 2).
    // One extra round gives the lookup a second chance to escape a local
    // minimum without significantly inflating hop counts.
    this.noProgressLimit = config.noProgressLimit ?? 3;
  }

  static get protocolName() { return 'Geographic'; }

  /**
   * Create a node whose ID encodes its geographic location in the high-order
   * bits, with random low-order bits for intra-cell uniqueness.
   */
  async addNode(lat, lng) {
    const prefix   = geoCellId(lat, lng, this.geoBits);
    const shift    = 64 - this.geoBits;
    // Top geoBits encode geographic cell; bottom (64-geoBits) bits are random.
    const randBits = randomU64() & ((1n << BigInt(shift)) - 1n);
    const id       = (BigInt(prefix) << BigInt(shift)) | randBits;

    const node = new KademliaNode({
      id, lat, lng, k: this.k, bits: this.bits,
      maxConnections: this.maxConnections ?? Infinity,
    });
    this.nodeMap.set(id, node);
    this.network.addNode(node);

    // v0.70.22 — G-DHT inherits K-DHT's transport-driven `lookup` (commit
    // 3 of the refactor sequence), so each node MUST have the FIND_NODE /
    // PING request handlers registered on its transport.  Without this,
    // every K-DHT-style FIND_NODE RPC during a G-DHT lookup throws "no
    // request handler" and the lookup discovers zero new candidates →
    // 0% success.  Mirrors KademliaDHT.addNode's transport-attach block.
    if (typeof this.network.makeTransport === 'function') {
      node.transport = this.network.makeTransport(id);
      await node.transport.start();
      this._registerKDHTHandlers(node);
    }
    return node;
  }

  /**
   * Build routing tables with a three-layer strategy:
   *
   * Layer 1 — Intra-cell local (XOR buckets 0 … 63-geoBits)
   *   Peers sharing the same geographic S2-cell prefix.  Low-latency hops
   *   within the geographic cluster.
   *
   * Layer 2 — Inter-cell structured (XOR buckets 64-geoBits … 63)
   *   One peer per bucket covering each geographic-prefix bit, exactly as
   *   Kademlia does for its full key space.  Guarantees that every target
   *   anywhere in the world is reachable — the key-space halving invariant
   *   applied to the inter-cell portion of the ID.
   *   geo8 → 8 buckets (b=56–63); geo16 → 16 buckets (b=48–63).
   *
   * Layer 3 — Random global (uniform sample from full network)
   *   Redundancy and load distribution beyond the structured minimum.
   *
   * Budget allocation (web-limit = 50 example for geo8):
   *   Inter-cell structured: k=1 per bucket → 8 peers (skeleton only)
   *   Remaining 42: half local (21), half random (21)
   *
   * Without web-limit:
   *   Local: all intra-cell peers (k per bucket)
   *   Inter-cell: k peers per bucket
   *   Random: k additional random global peers
   */
  buildRoutingTables({
    bidirectional  = true,
    maxConnections = Infinity,
    initMode       = 'native',
  } = {}) {
    this.bidirectional  = bidirectional;
    this.maxConnections = maxConnections;
    this.initMode       = initMode;

    const k      = this.k;
    const sorted = [...this.nodeMap.values()]
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

    // Propagate global connection cap to every node
    for (const node of sorted) node.maxConnections = maxConnections;

    // ── CANONICAL INIT (v0.68.00) ────────────────────────────────────────────
    // Skip G-DHT's stratified 3-layer allocation. Use pure K-closest XOR
    // fill instead — same starting state as Kademlia and NH-1. Measures
    // the routing layer in isolation from the bootstrap strategy.
    if (initMode === 'canonical') {
      const processingOrder = [...sorted].sort(() => Math.random() - 0.5);
      for (const node of processingOrder) {
        for (const peer of buildXorRoutingTable(node.id, sorted, k, maxConnections)) {
          node.addToBucket(peer);
          if (bidirectional) peer.addToBucket(node);
        }
      }
      return;
    }

    // ── NATIVE INIT — G-DHT's stratified 3-layer allocation ──────────────────
    const intraBuckets = 64 - this.geoBits;   // geo8 → 56, geo16 → 48
    const allNodes     = [...this.nodeMap.values()];

    for (const node of sorted) {
      const selected = new Set([node.id]);

      // ── Layer 2: inter-cell structured (always first to guarantee budget) ──
      // Under web-limit use k=1 (minimum halving guarantee per bucket).
      // Uncapped: use full k per bucket.
      const interCellK = isFinite(maxConnections) ? 1 : k;
      const interCellPeers = buildInterCellTable(node.id, sorted, interCellK, intraBuckets);
      for (const peer of interCellPeers) {
        node.addToBucket(peer);
        if (bidirectional) peer.addToBucket(node);
        selected.add(peer.id);
      }

      // ── Remaining budget after inter-cell ──────────────────────────────────
      let localBudget, globalBudget;
      if (!isFinite(maxConnections)) {
        localBudget  = Infinity;   // all intra-cell peers
        globalBudget = k;          // k random global peers
      } else {
        const remaining = Math.max(0, maxConnections - interCellPeers.length);
        // Even split: empirically optimal balance between local routing
        // density (final hops) and global random reach (last-mile coverage).
        localBudget  = Math.max(1, Math.floor(remaining / 2));
        globalBudget = Math.max(1, remaining - localBudget);
      }

      // ── Layer 1: intra-cell local ──────────────────────────────────────────
      const rawLocal   = buildIntraCellTable(node.id, sorted, k, intraBuckets);
      const localPeers = isFinite(localBudget) ? rawLocal.slice(0, localBudget) : rawLocal;
      for (const peer of localPeers) {
        node.addToBucket(peer);
        if (bidirectional) peer.addToBucket(node);
        selected.add(peer.id);
      }

      // ── Layer 3: random global ─────────────────────────────────────────────
      const globalPeers = reservoirSample(allNodes, globalBudget, selected);
      for (const peer of globalPeers) {
        node.addToBucket(peer);
        if (bidirectional) peer.addToBucket(node);
      }
    }
  }

  /**
   * G-DHT bootstrap join — extends Kademlia's iterative self-lookup with
   * additional lookups targeting diverse geographic prefixes.
   *
   * The standard self-lookup finds XOR-close peers (same geo cell), but
   * G-DHT's routing strength comes from inter-cell structured peers and
   * random global reach.  We simulate this by doing extra FIND_NODE lookups
   * for synthetic target IDs with flipped geographic prefix bits, which
   * discovers peers in distant cells.
   */
  bootstrapJoin(newNodeId, sponsorId) {
    // Phase 1: standard Kademlia self-lookup for close peers
    super.bootstrapJoin(newNodeId, sponsorId);

    const newNode = this.nodeMap.get(newNodeId);
    const sponsor = this.nodeMap.get(sponsorId);
    if (!newNode || !sponsor) return;

    const bidir = this.bidirectional ?? true;
    const addPeer = (peer) => {
      if (peer.id === newNode.id) return;
      newNode.addToBucket(peer);
      if (bidir) peer.addToBucket(newNode);
    };

    // Phase 2: inter-cell discovery — lookup synthetic targets with
    // different geographic prefixes to find peers in distant cells.
    // Flip each geo-prefix bit one at a time to target each inter-cell bucket.
    // Start from newNode (which now has Phase 1 peers) for better starting
    // positions, and limit to 2 rounds per prefix for performance.
    const shift = BigInt(64 - this.geoBits);
    for (let bit = 0; bit < this.geoBits; bit++) {
      const targetId = newNode.id ^ (1n << (shift + BigInt(bit)));

      const queried = new Set([newNode.id]);
      let shortlist = newNode.findClosest(targetId, this.k);
      for (const peer of shortlist) addPeer(peer);

      for (let round = 0; round < 2; round++) {
        const unqueried = shortlist.filter(n => !queried.has(n.id)).slice(0, this.alpha);
        if (unqueried.length === 0) break;

        let improved = false;
        for (const peer of unqueried) {
          queried.add(peer.id);
          const found = peer.findClosest(targetId, this.k);
          for (const candidate of found) {
            if (candidate.id !== newNode.id && !queried.has(candidate.id)) {
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
        shortlist = shortlist.slice(0, this.k);

        if (!improved) break;
      }
    }
  }

  getStats() {
    return {
      ...super.getStats(),
      protocol: `G-DHT-${this.geoBits}`,
      geoBits: this.geoBits,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GeographicDHTa (G-DHT-a: stratified allocation matching Kademlia)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * G-DHT-a — fixes the reachability gap in G-DHT-8 by using Kademlia's
 * stratified allocation under web-limit instead of the three-layer approach.
 *
 * The original G-DHT-8 allocated only k=1 per inter-cell bucket (8 peers
 * for geo8), starving global reachability.  G-DHT-a uses the same
 * buildXorRoutingTable as Kademlia (Phase 1: 1 per non-empty bucket for
 * breadth; Phase 2: remaining budget to highest buckets first for depth),
 * ensuring inter-cell coverage matches Kademlia's.
 *
 * Node IDs remain geographic (S2 prefix), preserving the latency advantage.
 */
export class GeographicDHTa extends GeographicDHT {
  static get protocolName() { return 'Geographic-a'; }

  buildRoutingTables({ bidirectional = true, maxConnections = Infinity } = {}) {
    this.bidirectional  = bidirectional;
    this.maxConnections = maxConnections;

    const k            = this.k;
    const intraBuckets = 64 - this.geoBits;
    const sorted       = [...this.nodeMap.values()]
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const allNodes     = [...this.nodeMap.values()];

    for (const node of sorted) node.maxConnections = maxConnections;

    for (const node of sorted) {
      if (isFinite(maxConnections)) {
        // ── Budget-capped: use Kademlia's stratified allocation ──────────────
        // Guarantees 1 peer per non-empty bucket (breadth) then fills highest
        // buckets first (depth), ensuring inter-cell coverage even though
        // geographic IDs cluster most nodes in low-b buckets.
        for (const peer of buildXorRoutingTable(node.id, sorted, k, maxConnections)) {
          node.addToBucket(peer);
          if (bidirectional) peer.addToBucket(node);
        }
      } else {
        // ── Uncapped: three-layer for best geographic awareness ──────────────
        const selected = new Set([node.id]);

        const interCellPeers = buildInterCellTable(node.id, sorted, k, intraBuckets);
        for (const peer of interCellPeers) {
          node.addToBucket(peer);
          if (bidirectional) peer.addToBucket(node);
          selected.add(peer.id);
        }

        const localPeers = buildIntraCellTable(node.id, sorted, k, intraBuckets);
        for (const peer of localPeers) {
          node.addToBucket(peer);
          if (bidirectional) peer.addToBucket(node);
          selected.add(peer.id);
        }

        const globalPeers = reservoirSample(allNodes, k, selected);
        for (const peer of globalPeers) {
          node.addToBucket(peer);
          if (bidirectional) peer.addToBucket(node);
        }
      }
    }
  }

  getStats() {
    return {
      ...super.getStats(),
      protocol: 'G-DHT-a',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GeographicDHTb (G-DHT-b: stratified core + random global supplement)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * G-DHT-b — starts from G-DHT-a's 100% reachability, then supplements
 * with random global peers for churn resilience.
 *
 * Strategy: use buildXorRoutingTable for 80% of the budget (proven
 * stratified allocation — guarantees reachability), then add random
 * global peers with the remaining 20%.  The random peers provide
 * diverse backup paths that the structured allocation misses.
 *
 * This avoids the trap of under-allocating inter-cell coverage (G-DHT-b
 * at 40% had 9.8% success) while restoring the churn resilience that
 * G-DHT-8's random layer provided.
 */
export class GeographicDHTb extends GeographicDHT {
  static get protocolName() { return 'Geographic-b'; }

  buildRoutingTables({ bidirectional = true, maxConnections = Infinity } = {}) {
    this.bidirectional  = bidirectional;
    this.maxConnections = maxConnections;

    const k            = this.k;
    const intraBuckets = 64 - this.geoBits;
    const sorted       = [...this.nodeMap.values()]
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const allNodes     = [...this.nodeMap.values()];

    for (const node of sorted) node.maxConnections = maxConnections;

    // Randomize processing order to avoid sort-order bias under tight caps
    // (see KademliaDHT.buildRoutingTables for the rationale).
    const processingOrder = [...sorted].sort(() => Math.random() - 0.5);

    for (const node of processingOrder) {
      if (isFinite(maxConnections)) {
        // ── Core: stratified allocation for 80% of budget ─────────────────
        const coreBudget = Math.floor(maxConnections * 0.8);
        const selected = new Set([node.id]);

        for (const peer of buildXorRoutingTable(node.id, sorted, k, coreBudget)) {
          node.addToBucket(peer);
          if (bidirectional) peer.addToBucket(node);
          selected.add(peer.id);
        }

        // ── Supplement: random global peers for remaining 20% ─────────────
        const randomBudget = maxConnections - coreBudget;
        const globalPeers = reservoirSample(allNodes, randomBudget, selected);
        for (const peer of globalPeers) {
          node.addToBucket(peer);
          if (bidirectional) peer.addToBucket(node);
        }
      } else {
        // ── Uncapped: three-layer ───────────────────────────────────────────
        const selected = new Set([node.id]);

        const interCellPeers = buildInterCellTable(node.id, sorted, k, intraBuckets);
        for (const peer of interCellPeers) {
          node.addToBucket(peer);
          if (bidirectional) peer.addToBucket(node);
          selected.add(peer.id);
        }

        const localPeers = buildIntraCellTable(node.id, sorted, k, intraBuckets);
        for (const peer of localPeers) {
          node.addToBucket(peer);
          if (bidirectional) peer.addToBucket(node);
          selected.add(peer.id);
        }

        const globalPeers = reservoirSample(allNodes, k, selected);
        for (const peer of globalPeers) {
          node.addToBucket(peer);
          if (bidirectional) peer.addToBucket(node);
        }
      }
    }
  }

  getStats() {
    return {
      ...super.getStats(),
      protocol: 'G-DHT-b',
    };
  }
}
