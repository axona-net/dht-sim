import { DHTNode } from '../DHTNode.js';
import { DHT } from '../DHT.js';
import { randomU64, clz64, roundTripLatency, buildXorRoutingTable } from '../../utils/geo.js';

// ─────────────────────────────────────────────────────────────────────────────
// K-Bucket
// ─────────────────────────────────────────────────────────────────────────────

class KBucket {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.nodes = [];
  }

  add(node) {
    if (this.nodes.some(n => n.id === node.id)) return false;
    if (this.nodes.length < this.maxSize) {
      this.nodes.push(node);
      return true;
    }
    // In production Kademlia, we'd ping the tail and evict if unresponsive.
    // In simulation, buckets simply ignore nodes once full.
    return false;
  }

  remove(nodeId) {
    this.nodes = this.nodes.filter(n => n.id !== nodeId);
  }

  getAll() {
    return this.nodes.filter(n => n.alive);
  }

  get size() {
    return this.nodes.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KademliaNode
// ─────────────────────────────────────────────────────────────────────────────

export class KademliaNode extends DHTNode {
  /**
   * @param {object} opts
   * @param {number} opts.id
   * @param {number} opts.lat
   * @param {number} opts.lng
   * @param {number} opts.k     - Bucket size (default 20)
   * @param {number} opts.bits  - Key-space bit width (default 32)
   * @param {number} opts.maxConnections - Global connection cap (Infinity = no limit)
   */
  constructor({ id, lat, lng, k = 20, bits = 64, maxConnections = Infinity }) {
    super({ id, lat, lng });
    this.k = k;
    this.bits = bits;
    this.maxConnections = maxConnections;
    this._totalConns = 0;   // cached connection count
    // One bucket per bit in the key space
    this.buckets = Array.from({ length: bits }, () => new KBucket(k));

    /**
     * Reverse connection index: nodes that have this node in their k-buckets
     * but where this node may NOT have them (asymmetric under web-limit).
     * Doubles effective routing candidates — analogous to NeuronNode.incomingSynapses.
     * @type {Map<bigint, KademliaNode>}
     */
    this.incomingPeers = new Map();
  }

  // ── XOR helpers ─────────────────────────────────────────────────────────

  xorDistance(otherId) {
    return this.id ^ otherId; // 64-bit BigInt XOR
  }

  /** 0-based bucket index for another node's ID (highest differing bit). */
  bucketIndex(otherId) {
    const xor = this.id ^ otherId;
    if (xor === 0n) return -1;
    return Math.min(63 - clz64(xor), this.bits - 1);
  }

  // ── Routing table management ─────────────────────────────────────────────

  /** Total number of peers across all buckets (including dead, matches real WebSocket count). */
  get totalConnections() {
    return this._totalConns;
  }

  addToBucket(node) {
    if (node.id === this.id) return;
    const idx = this.bucketIndex(node.id);
    if (idx < 0 || idx >= this.bits) return;

    // Already in this bucket — no-op
    if (this.buckets[idx].nodes.some(n => n.id === node.id)) return;

    // Per-bucket K-cap still applies (classic Kademlia: a full bucket rejects
    // new entries unless the LRU is dead — here we treat a full bucket as a
    // soft reject, matching real-world Kademlia behaviour).
    if (this.buckets[idx].size >= this.k) return;

    // Gate on the physical-transport layer: both sides must have a free
    // connection slot, otherwise the WebRTC link can't be established and
    // we cannot route through this peer. Refused by either side → skip.
    if (!this.tryConnect(node)) {
      // Preserve XOR-stratum coverage: if THIS bucket is empty and we're at
      // cap, try evicting from our largest bucket to make room (keeps the
      // reachability invariant — every populated stratum has a route).
      if (this.buckets[idx].size !== 0) return;
      let maxB = -1, maxSize = 0;
      for (let b = 0; b < this.bits; b++) {
        if (this.buckets[b].size > maxSize) { maxSize = this.buckets[b].size; maxB = b; }
      }
      if (maxB < 0 || maxSize <= 1) return;
      const evicted = this.buckets[maxB].nodes.pop();
      this._totalConns--;
      if (evicted?.incomingPeers) evicted.incomingPeers.delete(this.id);
      this.disconnect(evicted);
      if (!this.tryConnect(node)) return;  // peer still refused (its own cap) — give up
    }

    // Physical link established (both sides); finalize bucket insertion.
    if (this.buckets[idx].add(node)) {
      this._totalConns++;
      // Reverse index kept for legacy read paths (findClosest reads it).
      // The authoritative transport record is `this.connections` / `node.connections`.
      if (node.incomingPeers && !node.incomingPeers.has(this.id)) {
        node.incomingPeers.set(this.id, this);
      }
    }
  }

  removeFromBucket(nodeId) {
    const xor = this.id ^ nodeId;
    if (xor === 0n) return;
    const idx = Math.min(63 - clz64(xor), this.bits - 1);
    const before = this.buckets[idx].size;
    this.buckets[idx].remove(nodeId);
    this._totalConns -= (before - this.buckets[idx].size);
    // Also remove from incoming peers if present
    this.incomingPeers.delete(nodeId);
    // Drop the physical connection (both sides). Safe even if the peer is
    // already dead — DHTNode.disconnect tolerates a missing `connections` set.
    this.connections.delete(nodeId);
  }

  /**
   * Return up to `count` live nodes from the routing table, sorted by XOR
   * distance to `targetId`.
   */
  findClosest(targetId, count) {
    const seen = new Set();
    const all = [];
    // Outgoing bucket entries (primary)
    for (const b of this.buckets) {
      for (const n of b.getAll()) {
        if (!seen.has(n.id)) { seen.add(n.id); all.push(n); }
      }
    }
    // Incoming reverse connections (peers who have us in THEIR buckets)
    for (const [, n] of this.incomingPeers) {
      if (n.alive && !seen.has(n.id)) { seen.add(n.id); all.push(n); }
    }
    return all
      .sort((a, b) => {
        const da = a.id ^ targetId;
        const db = b.id ^ targetId;
        return da < db ? -1 : da > db ? 1 : 0;
      })
      .slice(0, count);
  }

  /**
   * Return up to `count` live nodes from the routing table, sorted by XOR
   * distance of their S2 geographic cell to `targetCell`.
   *
   * Used for regional lookups: routing by S2-cell XOR gives geographic
   * proximity without requiring geo-encoded node IDs.
   */
  findClosestByGeo(targetCell, count) {
    const seen = new Set();
    const all = [];
    for (const b of this.buckets) {
      for (const n of b.getAll()) {
        if (!seen.has(n.id)) { seen.add(n.id); all.push(n); }
      }
    }
    for (const [, n] of this.incomingPeers) {
      if (n.alive && !seen.has(n.id)) { seen.add(n.id); all.push(n); }
    }
    return all
      .sort((a, b) => ((a.s2Cell ^ targetCell) >>> 0) - ((b.s2Cell ^ targetCell) >>> 0))
      .slice(0, count);
  }

  /**
   * Return all live nodes currently in this node's routing table.
   * Used by the globe to visualise routing-table connections on click.
   */
  getRoutingTableEntries() {
    const seen = new Set();
    const entries = [];
    for (const b of this.buckets) {
      for (const n of b.getAll()) {
        if (!seen.has(n.id)) { seen.add(n.id); entries.push(n); }
      }
    }
    for (const [, n] of this.incomingPeers) {
      if (n.alive && !seen.has(n.id)) { seen.add(n.id); entries.push(n); }
    }
    return entries;
  }

  // ── Message handler (called by SimulatedNetwork) ─────────────────────────

  handleMessage({ type, from, data }) {
    switch (type) {
      case 'FIND_NODE': {
        // When a geoKey is present, route by S2-cell XOR (geographic mode).
        // Otherwise use standard Kademlia ID XOR.
        const closest = (data.geoKey !== undefined)
          ? this.findClosestByGeo(data.geoKey, this.k)
          : this.findClosest(data.target, this.k);
        return closest.filter(n => n.id !== from).map(n => n.id);
      }
      case 'PING':
        return 'PONG';
      default:
        return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KademliaDHT
// ─────────────────────────────────────────────────────────────────────────────

export class KademliaDHT extends DHT {
  static get protocolName() { return 'Kademlia'; }

  /**
   * @param {object} config
   * @param {number} config.k      - Bucket size           (default 20)
   * @param {number} config.alpha  - Lookup parallelism    (default 3)
   * @param {number} config.bits   - Key-space bit width   (default 32)
   */
  constructor(config = {}) {
    super(config);
    this.k = config.k ?? 20;
    this.alpha = config.alpha ?? 3;
    this.bits = config.bits ?? 64;
    // How many consecutive no-progress rounds before lookup terminates.
    // Standard Kademlia uses 2. Geo-structured variants may set higher to
    // allow longer inter-cell routing chains under tight connection budgets.
    this.noProgressLimit = config.noProgressLimit ?? 2;
    /** @type {Map<number, KademliaNode>} */
    this.nodeMap = new Map();
  }

  // ── Node lifecycle ───────────────────────────────────────────────────────

  async addNode(lat, lng) {
    const id = randomU64();
    const node = new KademliaNode({
      id, lat, lng, k: this.k, bits: this.bits,
      maxConnections: this.maxConnections ?? Infinity,
    });
    this.nodeMap.set(id, node);
    this.network.addNode(node);

    // v0.70.09 — give the node a Transport-conformant interface and
    // register K-DHT's request handlers on it.  The legacy
    // node.handleMessage path is left intact (other simulator code
    // and the network.send() chokepoint still use it); this commit
    // adds the transport-driven path that lookup() now uses.
    if (typeof this.network.makeTransport === 'function') {
      node.transport = this.network.makeTransport(id);
      await node.transport.start();
      this._registerKDHTHandlers(node);
    }
    return node;
  }

  /**
   * @private
   * Register K-DHT request/notification handlers on a node's transport.
   * Mirrors the cases in {@link KademliaNode#handleMessage} but in the
   * transport-conformant shape: handler returns a Promise<response>,
   * caller awaits.
   */
  _registerKDHTHandlers(node) {
    node.transport.onRequest('FIND_NODE', async (fromId, payload) => {
      const closest = (payload?.geoKey !== undefined)
        ? node.findClosestByGeo(payload.geoKey, this.k)
        : node.findClosest(payload.target, this.k);
      return closest.filter(n => n.id !== fromId).map(n => n.id);
    });
    node.transport.onRequest('PING', async () => 'PONG');
  }

  async removeNode(nodeId) {
    const node = this.nodeMap.get(nodeId);
    if (!node) return;
    node.alive = false;
    // Node is simply gone. Neighbors discover dead links when they next
    // try to route through them — dead entries are skipped in getAll()
    // (alive check). No walking the dying node's state (unrealistic).
    this.network.removeNode(nodeId);
    this.nodeMap.delete(nodeId);
  }

  /**
   * Populate routing tables for all nodes at once.
   * O(n log n) via binary search on contiguous XOR-bucket ID ranges.
   */
  buildRoutingTables({
    bidirectional  = true,
    maxConnections = Infinity,
    initMode       = 'native',  // K-DHT is canonical-by-construction; flag is accepted for API parity.
  } = {}) {
    super.buildRoutingTables({ bidirectional, maxConnections, initMode });
    const k      = this.k;
    const sorted = [...this.nodeMap.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    // Propagate global connection cap to every node
    for (const node of sorted) node.maxConnections = maxConnections;

    // Shuffle processing order so no sort-order position gets systematic
    // first-pick advantage under tight caps.
    const processingOrder = [...sorted].sort(() => Math.random() - 0.5);

    for (const node of processingOrder) {
      for (const peer of buildXorRoutingTable(node.id, sorted, k, maxConnections)) {
        node.addToBucket(peer);
        // Bidirectional: also make peer aware of node (reverse edge).
        if (bidirectional) peer.addToBucket(node);
      }
    }
  }

  // ── Bootstrap join ───────────────────────────────────────────────────────

  /**
   * Integrate a freshly-created node into an existing network through a
   * sponsor, simulating real Kademlia bootstrap.
   *
   * The new node performs an iterative self-lookup (FIND_NODE for its own ID)
   * starting from the sponsor.  Every peer discovered along the way is added
   * to the new node's routing table, and if bidirectional is enabled those
   * peers also learn about the new node.
   *
   * @param {BigInt} newNodeId  ID of the freshly-created node (already in nodeMap).
   * @param {BigInt} sponsorId  ID of an existing live node.
   */
  bootstrapJoin(newNodeId, sponsorId) {
    const newNode = this.nodeMap.get(newNodeId);
    const sponsor = this.nodeMap.get(sponsorId);
    if (!newNode || !sponsor) return;

    const bidir = this.bidirectional ?? true;

    const addPeer = (peer) => {
      if (peer.id === newNode.id) return;
      newNode.addToBucket(peer);                    // k-bucket limit per bucket
      if (bidir) peer.addToBucket(newNode);
    };

    // 1. Connect to sponsor
    addPeer(sponsor);

    // 2. Iterative self-lookup: FIND_NODE(newNode.id)
    //    Mirrors the real Kademlia join — each round queries α unqueried nodes
    //    for their k closest peers and merges them into the shortlist.
    const queried = new Set([newNode.id]);
    let shortlist = sponsor.findClosest(newNode.id, this.k);
    for (const peer of shortlist) addPeer(peer);

    for (let round = 0; round < 10; round++) {
      const unqueried = shortlist.filter(n => !queried.has(n.id)).slice(0, this.alpha);
      if (unqueried.length === 0) break;

      let improved = false;
      for (const peer of unqueried) {
        queried.add(peer.id);
        const found = peer.findClosest(newNode.id, this.k);
        for (const candidate of found) {
          if (candidate.id !== newNode.id && !queried.has(candidate.id)) {
            addPeer(candidate);
            // Merge into shortlist if not already present
            if (!shortlist.some(n => n.id === candidate.id)) {
              shortlist.push(candidate);
              improved = true;
            }
          }
        }
      }

      // Re-sort by XOR distance to new node
      shortlist.sort((a, b) => {
        const da = a.id ^ newNode.id;
        const db = b.id ^ newNode.id;
        return da < db ? -1 : da > db ? 1 : 0;
      });
      shortlist = shortlist.slice(0, this.k);

      if (!improved) break;  // converged
    }
  }

  // ── Iterative lookup ─────────────────────────────────────────────────────

  /**
   * Kademlia iterative FIND_NODE lookup.
   *
   * Time model:
   *   - Each round queries up to α nodes in parallel from the initiating source.
   *   - Round time = max(RTT(source → node)) for nodes queried in that round.
   *   - Total time = Σ round times (rounds are sequential).
   *   - Hops = number of routing rounds (each round = α parallel queries).
   *
   * Path (for visualisation):
   *   - Records the greedy chain: source + the single closest-to-target node
   *     discovered each round.  This means path.length - 1 == hops, and the
   *     demo animation shows a clean sequential progression rather than all
   *     α·hops individual query arcs.
   *
   * @returns {Promise<import('../DHT.js').LookupResult>}
   */
  /**
   * Kademlia iterative FIND_NODE lookup.
   *
   * @param {number} sourceId
   * @param {number} targetKey  - Key to look up (random ID or S2 cell value)
   * @param {object} [opts]
   * @param {number} [opts.geoKey] - When set, route by S2-cell XOR instead of
   *   ID XOR.  Used for regional lookups so that plain Kademlia converges to
   *   geographically nearby nodes rather than XOR-nearby random nodes.
   */
  async lookup(sourceId, targetKey, { geoKey } = {}) {
    const source = this.nodeMap.get(sourceId);
    if (!source || !source.alive) return null;

    const alpha = this.alpha;
    const k = this.k;

    // In geographic mode, rank nodes by S2-cell XOR distance to geoKey.
    // In standard mode, rank by node-ID XOR distance to targetKey.
    const useGeo = geoKey !== undefined;
    const xorTo = useGeo
      ? id => { const n = this.nodeMap.get(id); return n ? (n.s2Cell ^ geoKey) >>> 0 : 0xffffffff; }
      : id => id ^ targetKey;  // BigInt XOR for non-geo mode

    // Bootstrap shortlist from source's routing table
    let shortlist = useGeo
      ? source.findClosestByGeo(geoKey, k)
      : source.findClosest(targetKey, k);
    const queried = new Set([sourceId]);
    const path = [sourceId];

    let totalHops = 0;
    // Track the closest node seen so far for termination
    let closestDist = shortlist.length ? xorTo(shortlist[0].id) : (useGeo ? 0xffffffff : 0xFFFFFFFFFFFFFFFFn);
    let noProgressRounds = 0;

    while (true) {
      // Pick the α closest unqueried live nodes from the shortlist
      const toQuery = shortlist
        .filter(n => n.alive && !queried.has(n.id))
        .slice(0, alpha);

      if (toQuery.length === 0) break;

      toQuery.forEach(n => queried.add(n.id));
      totalHops += 1; // one hop = one routing round (α queries sent in parallel)

      // For the visualisation path, record only the node closest to target
      // queried this round (the greedy "best hop"), so path.length-1 == hops.
      const bestThisRound = toQuery.reduce(
        (best, n) => xorTo(n.id) < xorTo(best.id) ? n : best, toQuery[0]
      );
      path.push(bestThisRound.id);

      // v0.70.09 — Send FIND_NODE to each candidate in TRUE parallel via
      // transport.send.  Promise.allSettled is the right primitive: a slow
      // or dead peer should not fail the whole batch — its rejection is
      // dropped and the rest of the responses are processed.
      //
      // The previous implementation used `this.network.send()` in a
      // serial for-loop, which the simulator's instantaneous clock made
      // indistinguishable from parallel.  In production, serial would
      // pay α × RTT per round; parallel pays one RTT.
      const newNodes = [];
      const transport = source.transport;
      const settled = await Promise.allSettled(
        toQuery.map(n => transport.send(n.id, 'FIND_NODE', { target: targetKey, geoKey }))
      );
      for (const r of settled) {
        if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
        for (const id of r.value) {
          const peer = this.nodeMap.get(id);
          if (peer && peer.alive && !queried.has(peer.id)) newNodes.push(peer);
        }
      }

      // Merge and re-sort shortlist
      const combined = [...shortlist, ...newNodes];
      const seen = new Set();
      shortlist = combined
        .filter(n => n && n.alive && !seen.has(n.id) && seen.add(n.id))
        .sort((a, b) => {
          const da = xorTo(a.id), db = xorTo(b.id);
          return da < db ? -1 : da > db ? 1 : 0;
        })
        .slice(0, k);

      // Termination: stop when no closer node is found after 2 fruitless rounds
      const newClosest = shortlist.length ? xorTo(shortlist[0].id) : (useGeo ? 0xffffffff : 0xFFFFFFFFFFFFFFFFn);
      if (newClosest >= closestDist) {
        if (++noProgressRounds >= this.noProgressLimit) break;
      } else {
        noProgressRounds = 0;
        closestDist = newClosest;
      }
    }

    // Correct the path terminus to the overall closest node found.
    // The greedy per-round tracking can leave path[-1] pointing at a node
    // from a "no-progress" round that ran after the true destination was
    // already discovered.  shortlist[0] is always the closest node seen.
    if (shortlist.length > 0 && path.length > 1) {
      path[path.length - 1] = shortlist[0].id;
    }

    // Compute total lookup time as the sum of RTTs along the greedy path.
    // Each RTT is between consecutive nodes on the path (path[i] → path[i+1]),
    // so only the successful, connected nodes on the actual route contribute.
    let totalTimeMs = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const fromNode = this.nodeMap.get(path[i]);
      const toNode   = this.nodeMap.get(path[i + 1]);
      if (fromNode && toNode) {
        totalTimeMs += roundTripLatency(fromNode, toNode);
      }
    }

    // In ID-XOR mode the target IS a real node's ID (receiver.id from the engine).
    // A lookup truly succeeds only when that exact node is in the final shortlist
    // (XOR distance 0 is the unique minimum — it can never be beaten or evicted).
    // If the routing got stuck in a local cluster that doesn't include the target
    // (e.g. geo8 + web limit routing only through same-cell nodes), the target
    // will be absent and found = false, accurately reflecting the routing failure.
    //
    // In geo-key mode the target is an S2 cell key, not a node ID; any non-empty
    // result is valid (keep original behaviour).
    const found = shortlist.length > 0 &&
      (useGeo || shortlist.some(n => n.id === targetKey));

    return {
      path,
      hops: totalHops,
      time: totalTimeMs,
      found,
    };
  }

  getStats() {
    const base = super.getStats();
    return {
      ...base,
      protocol: 'Kademlia',
      k: this.k,
      alpha: this.alpha,
      bits: this.bits,
    };
  }
}
