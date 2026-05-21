import { DHTNode } from '../DHTNode.js';
import { DHT } from '../DHT.js';
import { randomU64, clz64, buildXorRoutingTable } from '../../utils/geo.js';

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
        //
        // v0.3.51 (god's-eye audit fix): returns descriptors {id, s2Cell}
        // matching the transport-conformant handler. Legacy callers that
        // expect raw ids should switch to reading `.id` off the
        // descriptor.
        const closest = (data.geoKey !== undefined)
          ? this.findClosestByGeo(data.geoKey, this.k)
          : this.findClosest(data.target, this.k);
        return closest
          .filter(n => n.id !== from)
          .map(n => ({ id: n.id, s2Cell: n.s2Cell }));
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
   *
   * v0.3.51 (god's-eye audit fix): FIND_NODE response is now an array
   * of descriptors `{id, s2Cell}` not raw ids. The caller stores these
   * directly in its shortlist; no `nodeMap.get(id)` rehydration. This
   * matches what a real WebRTC deployment would carry on the wire and
   * removes the audit's C-9 violation (Kademlia geo-mode xorTo reading
   * peer.s2Cell via global nodeMap).
   *
   * Also registers an `onPeerDied` callback that populates a per-node
   * `_deadPeers` Set, mirroring the pattern NH-1 uses. The lookup
   * filters candidates against this Set instead of reading peer.alive
   * via nodeMap (audit C-10).
   */
  _registerKDHTHandlers(node) {
    node.transport.onRequest('FIND_NODE', async (fromId, payload) => {
      const closest = (payload?.geoKey !== undefined)
        ? node.findClosestByGeo(payload.geoKey, this.k)
        : node.findClosest(payload.target, this.k);
      return closest
        .filter(n => n.id !== fromId)
        .map(n => ({ id: n.id, s2Cell: n.s2Cell }));
    });
    node.transport.onRequest('PING', async () => 'PONG');

    // Dead-peer callback. Mirrors AxonaEngine._registerNH1Handlers.
    // Populates a local Set of known-dead peer ids that the lookup
    // consults when filtering candidates. Replaces the legacy
    // `peer.alive` god's-eye liveness check; the protocol learns about
    // deaths the same way a real deployment does -- through
    // transport-level peer-died notifications driven by the heartbeat.
    if (!node._deadPeers) node._deadPeers = new Set();
    node.transport.onPeerDied((peerId) => {
      node._deadPeers.add(peerId);
    });
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

    // Memory: under churn at 25K, leaving the dying node referenced
    // from every surviving peer's bucket + incomingPeers Map creates
    // a retained graph that doesn't get GC'd between churn rounds —
    // dying node holds buckets + incomingPeers pointing back into
    // the swarm, alive peers hold dying node, cycle survives.
    // K-DHT's bucket-cap (k=20) bounds the bucket side, but
    // incomingPeers is unbounded: every peer that ever added the
    // dying node to its bucket left a reverse-reference behind.
    //
    // G-DHT's Phase-2 inter-cell discovery multiplies these
    // references by ~geoBits (8×) per replacement, so the retained
    // graph blows up specifically in G-DHT churn at 25K nodes.
    //
    // Sweep references to the dying node out of every surviving
    // peer's incomingPeers + buckets so the GC can collect the
    // zombie immediately.  The simulator's god's-eye nodeMap makes
    // this a single pass; a real Kademlia client would discover
    // dead links lazily, which is fine for live traffic but is
    // exactly what makes the in-memory simulator accumulate state.
    if (node.incomingPeers instanceof Map) node.incomingPeers.clear();
    for (const peer of this.nodeMap.values()) {
      if (!peer || peer === node) continue;
      peer.incomingPeers?.delete?.(nodeId);
      peer.removeFromBucket?.(nodeId);
      peer._deadPeers?.delete?.(nodeId);
    }

    // Aggressive teardown of the dying node's heavy fields so GC
    // collects them on the next minor cycle.  V8 has trouble
    // reclaiming the dying node when it holds a self-referential
    // cycle via transport (node.transport → transport._requestHandlers
    // → closure → node), and that pinning chains through to the dying
    // node's buckets and _deadPeers — leaking ~500KB per kill that
    // compounds round-over-round (round 2 +265MB, round 3 +1083MB
    // observed at 25K × 5% churn).  Explicit cleanup breaks every
    // pinning chain at the dying side.
    if (node.transport) {
      node.transport._requestHandlers?.clear?.();
      node.transport._notificationHandlers?.clear?.();
      if (Array.isArray(node.transport._peerDiedHandlers)) {
        node.transport._peerDiedHandlers.length = 0;
      }
      node.transport._simNet = null;
      node.transport._localNodeId = null;
      node.transport = null;
    }
    if (node._deadPeers instanceof Set)  node._deadPeers.clear();
    if (node.connections instanceof Set) node.connections.clear();
    if (Array.isArray(node.buckets)) {
      for (const b of node.buckets) b?.nodes && (b.nodes.length = 0);
    }
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
    // Self-resolution: turn the caller's own node id into its local
    // KademliaNode reference. This is the simulator's analog of "the
    // DHT instance owns its own state"; the production peer would
    // already have its own node object in scope. Category B
    // (legitimate). The lookup never reads `this.nodeMap` again after
    // this line.
    const source = this.nodeMap.get(sourceId);
    if (!source || !source.alive) return null;

    const transport = source.transport;
    const alpha = this.alpha;
    const k = this.k;

    // v0.3.51 (god's-eye audit fix): the shortlist is now an array of
    // descriptors `{id, s2Cell}` rather than raw KademliaNode refs. The
    // initial entries come from the source's own routing table (local
    // state -- the source learned its peers' s2Cell when it added them
    // to its buckets, so reading from those entries is a local-state
    // read, not a god's-eye one). Subsequent entries are appended from
    // FIND_NODE responses which are themselves `{id, s2Cell}`
    // descriptors per the new wire format.
    //
    // Removed: `xorTo(id) => this.nodeMap.get(id).s2Cell ^ geoKey` --
    // the geo-mode scorer that read peer.s2Cell via the global
    // simulator nodeMap (audit C-9). `xorTo` now takes the descriptor
    // and reads `.s2Cell` from the descriptor directly.
    const useGeo = geoKey !== undefined;
    const xorTo = useGeo
      ? e => (e.s2Cell ^ geoKey) >>> 0
      : e => e.id ^ targetKey;  // BigInt XOR for non-geo mode

    const toDescriptor = n => ({ id: n.id, s2Cell: n.s2Cell });
    let shortlist = (useGeo
      ? source.findClosestByGeo(geoKey, k)
      : source.findClosest(targetKey, k)
    ).map(toDescriptor);

    const queried = new Set([sourceId]);
    const path = [sourceId];

    let totalHops = 0;
    let totalTimeMs = 0;
    // Track the closest node seen so far for termination
    let closestDist = shortlist.length ? xorTo(shortlist[0]) : (useGeo ? 0xffffffff : 0xFFFFFFFFFFFFFFFFn);
    let noProgressRounds = 0;

    // v0.3.51: liveness comes from the local `_deadPeers` Set populated
    // by `transport.onPeerDied` callbacks (set up in
    // `_registerKDHTHandlers`). Replaces the legacy `peer.alive` reach
    // through nodeMap (audit C-10).
    const dead = source._deadPeers || new Set();

    while (true) {
      // Pick the α closest unqueried, not-known-dead descriptors.
      const toQuery = shortlist
        .filter(d => !queried.has(d.id) && !dead.has(d.id))
        .slice(0, alpha);

      if (toQuery.length === 0) break;

      toQuery.forEach(d => queried.add(d.id));
      totalHops += 1; // one hop = one routing round (α queries sent in parallel)

      // For the visualisation path, record only the descriptor closest to
      // target queried this round (the greedy "best hop"), so
      // path.length-1 == hops.
      const bestThisRound = toQuery.reduce(
        (best, d) => xorTo(d) < xorTo(best) ? d : best, toQuery[0]
      );
      path.push(bestThisRound.id);

      // v0.70.09 — FIND_NODE sent in TRUE parallel via transport.send.
      // Promise.allSettled lets a slow or dead peer in one probe drop
      // without failing the whole batch.
      const newDescriptors = [];
      const settled = await Promise.allSettled(
        toQuery.map(d => transport.send(d.id, 'FIND_NODE', { target: targetKey, geoKey }))
      );
      for (const r of settled) {
        if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
        for (const desc of r.value) {
          // v0.3.51: FIND_NODE response is now `{id, s2Cell}` descriptors,
          // not raw ids. Filter against local queried + dead sets, no
          // `nodeMap.get(id)` rehydration (audit C-10).
          if (!queried.has(desc.id) && !dead.has(desc.id)) {
            newDescriptors.push(desc);
          }
        }
      }

      // v0.3.51 (god's-eye audit fix): accumulate latency inline using
      // `transport.getLatency(peerId)`, the same source-of-truth the
      // protocol consumes for any other RTT decision. Replaces the
      // legacy post-walk `roundTripLatency(nodeMap.get(prev),
      // nodeMap.get(next))` reach (audit C-11). The round wire cost is
      // the slowest of the parallel sends, so we take the max.
      let roundLatency = 0;
      for (let i = 0; i < toQuery.length; i++) {
        if (settled[i].status !== 'fulfilled') continue;
        const lat = transport.getLatency(toQuery[i].id);
        if (lat > 0 && lat > roundLatency) roundLatency = lat;
      }
      totalTimeMs += roundLatency;

      // Merge and re-sort shortlist (descriptors only).
      const combined = [...shortlist, ...newDescriptors];
      const seen = new Set();
      shortlist = combined
        .filter(d => d && !dead.has(d.id) && !seen.has(d.id) && seen.add(d.id))
        .sort((a, b) => {
          const da = xorTo(a), db = xorTo(b);
          return da < db ? -1 : da > db ? 1 : 0;
        })
        .slice(0, k);

      // Termination: stop when no closer node is found after 2 fruitless rounds
      const newClosest = shortlist.length ? xorTo(shortlist[0]) : (useGeo ? 0xffffffff : 0xFFFFFFFFFFFFFFFFn);
      if (newClosest >= closestDist) {
        if (++noProgressRounds >= this.noProgressLimit) break;
      } else {
        noProgressRounds = 0;
        closestDist = newClosest;
      }
    }

    // Correct the path terminus to the overall closest descriptor found.
    if (shortlist.length > 0 && path.length > 1) {
      path[path.length - 1] = shortlist[0].id;
    }

    // In ID-XOR mode the target IS a real node's ID (receiver.id from
    // the engine). A lookup truly succeeds only when that exact id is
    // in the final shortlist (XOR distance 0 is the unique minimum --
    // it can never be beaten or evicted). In geo-key mode the target
    // is an S2 cell key, not a node id; any non-empty result is valid.
    const found = shortlist.length > 0 &&
      (useGeo || shortlist.some(d => d.id === targetKey));

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
