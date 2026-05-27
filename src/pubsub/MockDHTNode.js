/**
 * MockDHTNode / MockDHTNetwork — minimal DHT simulator that provides the
 * routing primitives the AxonaManager needs:
 *
 *   routeMessage(targetId, type, payload)     — walk a message toward targetId
 *                                               letting each hop intercept
 *   onRoutedMessage(type, handler)            — register intercept handler
 *   sendDirect(peerId, type, payload)         — point-to-point delivery
 *   getSelfId() / getAlivePeer(id)            — identity + peer lookup
 *
 * Routing model (deliberately simple):
 *   - Node IDs are 64-bit hex strings.
 *   - Each node has a random K-sized "routing table" (a Map of nodeId -> MockDHTNode).
 *   - The full network is also globally addressable via MockDHTNetwork so
 *     that sendDirect(peerId, ...) to any node always works — in a real DHT
 *     this would be "do a lookup, then send"; in the mock we short-circuit.
 *   - Greedy routing: picks the peer in our routing table whose id has
 *     smallest XOR distance to the target.
 *
 * Network model:
 *   - Latency: constant default, overridable per edge via latencyFn.
 *   - Drop: dropFn can drop individual messages (for churn tests).
 *   - Kill: markDead(nodeId) removes a node from the network; routing
 *     toward a dead node will dead-end at the closest live neighbour.
 *
 * NOT modelled (out of scope for Phase 3a):
 *   - Routing-table maintenance, replication, or churn adaptation.
 *   - Backpressure, queueing.
 *   - Real synaptome dynamics (we're testing the membership protocol,
 *     not routing quality).
 */

// ── Utility ─────────────────────────────────────────────────────────────────

/** Return XOR distance between two 16-hex-char node IDs, as a BigInt. */
export function xorDistance(a, b) {
  return BigInt('0x' + a) ^ BigInt('0x' + b);
}

/** Generate a random 16-hex-char node ID. */
export function randomNodeId() {
  let s = '';
  for (let i = 0; i < 16; i++) s += (Math.floor(Math.random() * 16)).toString(16);
  return s;
}

/** Pick k random distinct entries from an array. */
function sample(arr, k) {
  const copy = arr.slice();
  const out = [];
  const n = Math.min(k, copy.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
    out.push(copy[i]);
  }
  return out;
}

// ── MockDHTNetwork ──────────────────────────────────────────────────────────

export class MockDHTNetwork {
  constructor({ defaultLatencyMs = 5, routingTableSize = 12 } = {}) {
    this.nodes               = new Map();   // nodeId -> MockDHTNode
    this.deadNodes           = new Set();   // nodeId of killed nodes
    this.defaultLatencyMs    = defaultLatencyMs;
    this.routingTableSize    = routingTableSize;

    // Behaviour hooks.
    this.latencyFn = (_from, _to, _type) => this.defaultLatencyMs;
    this.dropFn    = (_from, _to, _type) => false;

    // Diagnostics.
    this.stats = {
      sentDirect:     0,
      sentRouted:     0,
      hopsTotal:      0,
      dropped:        0,
      expiredHopCap:  0,
    };
  }

  /** Create and register a new node. Its routing table is populated lazily
   *  by `rebuildRoutingTables()` once the target network size is reached. */
  createNode(id = randomNodeId()) {
    if (this.nodes.has(id)) throw Error(`MockDHTNetwork: duplicate nodeId ${id}`);
    const node = new MockDHTNode(id, this);
    this.nodes.set(id, node);
    return node;
  }

  /** Populate each node's routing table with `routingTableSize` random live peers. */
  rebuildRoutingTables() {
    const liveIds = [...this.nodes.keys()].filter(id => !this.deadNodes.has(id));
    for (const nodeId of liveIds) {
      const node = this.nodes.get(nodeId);
      const others = liveIds.filter(id => id !== nodeId);
      const picks = sample(others, this.routingTableSize);
      node.routingTable.clear();
      for (const pid of picks) node.routingTable.set(pid, this.nodes.get(pid));
    }
  }

  /** Look up a node by id; returns null if dead or unknown. */
  getAlive(nodeId) {
    if (this.deadNodes.has(nodeId)) return null;
    return this.nodes.get(nodeId) || null;
  }

  /** Simulate node death (for churn tests in Phase 3c). */
  markDead(nodeId) {
    this.deadNodes.add(nodeId);
  }

  /** Revive a dead node (testing tool). */
  markAlive(nodeId) {
    this.deadNodes.delete(nodeId);
  }

  /** Number of live nodes. */
  liveCount() {
    return this.nodes.size - this.deadNodes.size;
  }
}

// ── MockDHTNode ─────────────────────────────────────────────────────────────

export class MockDHTNode {
  constructor(id, network) {
    this.id                     = id;
    this.network                = network;
    this.routingTable           = new Map();      // nodeId -> MockDHTNode
    this._routedMessageHandlers = new Map();      // type -> handler
    this._directMessageHandlers = new Map();      // type -> handler
  }

  // ── Identity ────────────────────────────────────────────────────────

  getSelfId() { return this.id; }

  isAlive() { return !this.network.deadNodes.has(this.id); }

  // ── Handler registration ────────────────────────────────────────────

  /**
   * Register a handler for routed messages of the given type.
   * Handler signature: (payload, meta) => 'consumed' | 'forward' | undefined
   *   meta = { fromId, targetId, hopCount, isTerminal, node }
   * Return 'consumed' to terminate routing at this hop; anything else
   * (including undefined) forwards to the next hop.
   */
  onRoutedMessage(type, handler) {
    this._routedMessageHandlers.set(type, handler);
  }

  /**
   * Register a handler for point-to-point messages of the given type.
   * Handler signature: (payload, meta) => void
   *   meta = { fromId, type }
   */
  onDirectMessage(type, handler) {
    this._directMessageHandlers.set(type, handler);
  }

  // ── K-closest lookup ────────────────────────────────────────────────

  /**
   * Return up to K nodes (including ourselves when appropriate) whose IDs
   * are closest to `targetId`. Implements the Kademlia-style iterative
   * FIND_NODE: start with our own routing-table candidates, expand each
   * iteration by querying the closest unvisited candidates' tables, stop
   * when no closer nodes appear. In the simulator this is fully
   * synchronous (all routing tables are in-process memory); a real
   * implementation would issue α parallel RPCs per round.
   */
  findKClosest(targetId, K = 5, { alpha = 3, maxRounds = 40 } = {}) {
    const targetBig = BigInt('0x' + targetId);
    const dist = (id) => BigInt('0x' + id) ^ targetBig;
    const candidates = new Map();   // id → node
    const distances  = new Map();   // id → BigInt
    const addCandidate = (node) => {
      if (!node.isAlive() || candidates.has(node.id)) return;
      candidates.set(node.id, node);
      distances.set(node.id, dist(node.id));
    };

    addCandidate(this);
    for (const peer of this.routingTable.values()) addCandidate(peer);

    // Hybrid termination (see NX-15 findKClosest for rationale):
    //   stop only when top-K all visited AND pool has been stable
    //   for at least one round. Prefer top-K unvisited when picking
    //   α to query, but fall back to pool-wide unvisited if top-K
    //   is already exhausted but pool isn't stable yet.
    const visited = new Set();
    let lastPoolSize = 0;
    let stableRounds = 0;
    for (let round = 0; round < maxRounds; round++) {
      const sortedCands = [...candidates.values()]
        .sort((a, b) => distances.get(a.id) < distances.get(b.id) ? -1 : 1);
      const topK = sortedCands.slice(0, K);
      const topKAllVisited = topK.every(n => visited.has(n.id));

      let toQuery = topK.filter(n => !visited.has(n.id)).slice(0, alpha);
      if (toQuery.length < alpha) {
        const remaining = alpha - toQuery.length;
        const beyond = sortedCands.filter(n => !visited.has(n.id) && !topK.includes(n)).slice(0, remaining);
        toQuery = toQuery.concat(beyond);
      }
      if (toQuery.length === 0) break;

      for (const peer of toQuery) {
        visited.add(peer.id);
        for (const other of peer.routingTable.values()) addCandidate(other);
      }

      const grew = candidates.size > lastPoolSize;
      lastPoolSize = candidates.size;
      stableRounds = grew ? 0 : stableRounds + 1;
      if (topKAllVisited && stableRounds >= 1) break;
    }

    return [...candidates.values()]
      .sort((a, b) => distances.get(a.id) < distances.get(b.id) ? -1 : 1)
      .slice(0, K)
      .map(n => n.id);
  }

  // ── Greedy routing primitive ────────────────────────────────────────

  /**
   * Return the peer in our routing table with smallest XOR distance to
   * `targetId`. If our own id is strictly closer than every peer, returns
   * null (meaning "we are the terminal node for this target").
   */
  _greedyNextHopToward(targetId) {
    const selfDist = xorDistance(this.id, targetId);
    let bestPeer = null;
    let bestDist = selfDist;
    for (const peer of this.routingTable.values()) {
      if (!peer.isAlive()) continue;
      const d = xorDistance(peer.id, targetId);
      if (d < bestDist) { bestDist = d; bestPeer = peer; }
    }
    return bestPeer;
  }

  // ── Routed messaging ────────────────────────────────────────────────

  /**
   * Route a message toward `targetId`. Each hop may intercept.
   *
   * The walk is async because each hop is asynchronous in a real network;
   * in the mock we use setTimeout(latency). Returns a promise that
   * resolves to { consumed, atNode, hops, exhausted? }.
   *
   * Handlers may trigger follow-up messages synchronously (e.g., an axon
   * catching a subscribe might send a promote-axon direct message); the
   * walk remains correct because each hop resolves its own local handler
   * before scheduling the next hop.
   */
  async routeMessage(targetId, type, payload, opts = {}) {
    const maxHops = opts.maxHops ?? 40;
    const originId = opts.fromId ?? this.id;

    let currentNode = this;
    let previousId  = originId;
    let hops        = 0;

    while (hops < maxHops) {
      // Determine whether this node is the terminal for the target.
      const nextHop = currentNode._greedyNextHopToward(targetId);
      const isTerminal = nextHop === null;

      // Invoke this node's handler (if any).  Handlers may be async
      // (AxonaManager became async-aware in v0.70.16), so we await the
      // result before deciding whether the message was consumed.
      const result = await currentNode._deliverRouted(type, payload, {
        fromId:    previousId,
        targetId,
        hopCount:  hops,
        isTerminal,
        node:      currentNode,
      });

      this.network.hopsTotal = (this.network.hopsTotal ?? 0) + 1;
      this.network.stats.hopsTotal++;

      if (result === 'consumed') {
        this.network.stats.sentRouted++;
        return { consumed: true, atNode: currentNode.id, hops };
      }

      if (isTerminal) {
        // We're at the closest live node and nobody consumed. Done.
        this.network.stats.sentRouted++;
        return { consumed: false, atNode: currentNode.id, hops, terminal: true };
      }

      // Forward to nextHop. Apply latency + drop simulation.
      if (this.network.dropFn(currentNode.id, nextHop.id, type)) {
        this.network.stats.dropped++;
        return { consumed: false, atNode: currentNode.id, hops, dropped: true };
      }
      const latency = this.network.latencyFn(currentNode.id, nextHop.id, type);
      if (latency > 0) await new Promise(r => setTimeout(r, latency));

      previousId  = currentNode.id;
      currentNode = nextHop;
      hops++;
    }

    this.network.stats.expiredHopCap++;
    return { consumed: false, atNode: currentNode.id, hops, exhausted: true };
  }

  /** Invoke the registered handler for a routed type; returns the handler's
   *  result.  Async-aware (v0.70.16): awaits the handler so the
   *  'consumed'/'forward' decision reflects the post-await state. */
  async _deliverRouted(type, payload, meta) {
    const handler = this._routedMessageHandlers.get(type);
    if (!handler) return 'forward';
    try {
      const r = await handler(payload, meta);
      return r ?? 'forward';
    } catch (err) {
      console.error(`MockDHTNode ${this.id}: handler error for routed '${type}':`, err);
      return 'forward';
    }
  }

  // ── Direct (point-to-point) messaging ───────────────────────────────

  /**
   * Send a typed message directly to `peerId`. The peer's direct-message
   * handler for that type fires after the network latency. Fire-and-
   * forget; no response semantics.
   *
   * If the peer is dead or unknown, the message is silently dropped
   * (returns false). Caller can check the return value to detect
   * liveness for churn handling.
   */
  sendDirect(peerId, type, payload) {
    // Return value semantics: TRUE = "peer was alive at call time, send
    // was scheduled" (even if the packet is dropped in flight); FALSE =
    // "peer is dead or unknown" (caller should remove them from their
    // state). This mirrors real-world transport: a sender knows
    // immediately if a connection failed at the OS/transport layer, but
    // can only learn about in-flight drops via missing acks, which is a
    // separate mechanism out of scope for this simulator.
    const peer = this.network.getAlive(peerId);
    if (!peer) {
      this.network.stats.dropped++;
      return false;
    }
    if (this.network.dropFn(this.id, peerId, type)) {
      this.network.stats.dropped++;
      return true;    // alive but message lost — caller keeps the relationship
    }
    this.network.stats.sentDirect++;
    const latency = this.network.latencyFn(this.id, peerId, type);
    setTimeout(() => peer._deliverDirect(type, payload, { fromId: this.id, type }), latency);
    return true;
  }

  /** v0.70.16 — `async` so that async handlers (AxonaManager became
   *  async-aware) drain to completion before the setTimeout callback
   *  resolves.  Without the await, fan-out chains lag behind the
   *  test's `await sleep(...)` window, causing flaky timing-dependent
   *  assertions in test_axon.js. */
  async _deliverDirect(type, payload, meta) {
    if (!this.isAlive()) return;
    const handler = this._directMessageHandlers.get(type);
    if (!handler) return;
    try { await handler(payload, meta); }
    catch (err) {
      console.error(`MockDHTNode ${this.id}: handler error for direct '${type}':`, err);
    }
  }
}
