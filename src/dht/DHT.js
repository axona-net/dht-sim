import { SimulatedNetwork } from './SimulatedNetwork.js';

/**
 * DHT – abstract base class for all DHT protocol implementations.
 *
 * Concrete subclasses (KademliaDHT, ChordDHT, etc.) override:
 *   - addNode(lat, lng)  → DHTNode
 *   - removeNode(nodeId)
 *   - lookup(sourceId, targetKey) → LookupResult
 *   - buildRoutingTables()
 *
 * The network layer (SimulatedNetwork) is swappable without touching subclasses.
 */
export class DHT {
  /**
   * @param {object} config - Protocol-specific configuration
   */
  constructor(config = {}) {
    this.config = config;
    // Pass `this` so the network can stamp the connection-cap onto every
    // registered node, including those added after buildRoutingTables runs
    // (churn replacements, interactive Add Nodes, etc.).
    this.network = new SimulatedNetwork(this);
    this.maxConnections = Infinity;  // default; overridden by buildRoutingTables
  }

  /**
   * Add a new node at the given geographic coordinates.
   * @returns {Promise<import('./DHTNode.js').DHTNode>}
   */
  async addNode(lat, lng) {
    throw new Error(`${this.constructor.name}.addNode() not implemented`);
  }

  /**
   * Remove a node by ID (simulate churn: node leaving).
   */
  async removeNode(nodeId) {
    throw new Error(`${this.constructor.name}.removeNode() not implemented`);
  }

  /**
   * Perform a key lookup starting from the given source node.
   *
   * @param {number} sourceId  - Node ID of the initiating node
   * @param {number} targetKey - The key being looked up
   * @returns {Promise<LookupResult>}
   *
   * @typedef {object} LookupResult
   * @property {number[]} path    - Ordered list of node IDs visited
   * @property {number}   hops    - Number of nodes contacted (excl. source)
   * @property {number}   time    - Critical-path time in ms
   * @property {boolean}  found   - Whether a responsible node was found
   */
  async lookup(sourceId, targetKey) {
    throw new Error(`${this.constructor.name}.lookup() not implemented`);
  }

  /**
   * Rebuild routing tables after bulk node additions.
   * Optional: some implementations do this lazily.
   */
  buildRoutingTables({
    bidirectional = true,
    maxConnections = Infinity,
    maxOutgoing    = Infinity,
    maxIncoming    = Infinity,
    highwayPct = 0,
    /**
     * v0.68.00 — initialization mode for cross-protocol comparisons.
     *
     *   'native'    — each protocol runs its own bootstrap strategy
     *                 (Kademlia: pure XOR; G-DHT: 50 / 50 XOR + random
     *                  global; NX-17 via NX-11: 80 / 20 XOR + random
     *                  global; NH-1: pure XOR). Measures the protocol
     *                  AS DESIGNED, including its bootstrap.
     *
     *   'canonical' — every protocol uses the same omniscient K-closest
     *                 XOR allocation (Kademlia-style). All random
     *                 supplements and stratification layers are skipped.
     *                 Measures the routing / learning algorithm in
     *                 isolation, with identical starting state.
     *
     * Default 'native' preserves all prior measurement semantics.
     */
    initMode = 'native',
  } = {}) {
    this.bidirectional  = bidirectional;
    this.maxConnections = maxConnections;
    this.maxOutgoing    = maxOutgoing;
    this.maxIncoming    = maxIncoming;
    this.highwayPct     = highwayPct;
    this.initMode       = initMode;
    // Propagate the per-node physical cap so tryConnect() can enforce it.
    // Every DHTNode already defaults to Infinity; subclasses' buildRoutingTables
    // should call super.buildRoutingTables() first so this runs before they
    // start wiring peers together.
    //
    // Mixed-capacity model: `highwayPct` fraction of nodes are promoted to
    // unrestricted (server-class). These "highway" nodes accept unlimited
    // incoming connections and act as transit hubs. The rest keep the
    // normal cap (browser-class clients). Models a realistic hybrid
    // deployment where a small server backbone complements a P2P swarm.
    //
    // Directional caps (Interpretation B, v0.67.02): browser-class nodes
    // also receive separate maxOutgoing / maxIncoming sub-caps. Defaults
    // to Infinity (no directional gate). Highway nodes always get
    // Infinity/Infinity in both directions.
    const nodes = this.getNodes();
    const highwayCount = Math.floor(nodes.length * (highwayPct / 100));
    const shuffled = [...nodes].sort(() => Math.random() - 0.5);
    const highwaySet = new Set(shuffled.slice(0, highwayCount).map(n => n.id));
    for (const node of nodes) {
      const isHw = highwaySet.has(node.id);
      node.maxConnections = isHw ? Infinity : maxConnections;
      node.maxOutgoing    = isHw ? Infinity : maxOutgoing;
      node.maxIncoming    = isHw ? Infinity : maxIncoming;
      node.isHighway      = isHw;
    }
  }

  /** Return all currently active nodes. */
  getNodes() {
    return [...this.network.nodes.values()];
  }

  /** Summary statistics about the current DHT state. */
  getStats() {
    const nodes = this.getNodes();
    return {
      totalNodes: nodes.length,
      aliveNodes: nodes.filter(n => n.alive).length,
      messageCount: this.network.messageCount,
    };
  }

  /**
   * Release all large object-graph references so the GC can collect this DHT
   * immediately after a benchmark protocol finishes — without waiting for the
   * next GC cycle to discover the circular references.
   *
   * Subclasses with additional large Maps (e.g. nodeMap) should override and
   * call super.dispose().
   */
  dispose() {
    // Neuromorphic nodes carry multiple Maps per node plus a _nodeMapRef
    // back-pointer, creating a circular reference graph that the GC must fully
    // trace before it can reclaim anything.  Explicitly clearing every per-node
    // collection before dropping the nodeMap breaks all cycles immediately so
    // memory is freed on the next minor GC rather than waiting for a full cycle.
    if (this.nodeMap instanceof Map) {
      for (const node of this.nodeMap.values()) {
        // v0.81.x — per-node SimulatedTransport cleanup.
        //
        // The Transport-conformance refactor (kdht/gdht/nh1/nx17 — see
        // commits bb64842, 47e1811, a963f73) gave every node its own
        // SimulatedTransport via `network.makeTransport(id)`.  Each
        // transport carries _requestHandlers / _notificationHandlers
        // Maps whose handler functions close over the node and the
        // owning protocol instance, AND registers itself in
        // `network._transports`.  Without explicit teardown here,
        // SimulatedNetwork._transports keeps every transport alive
        // across protocol switches → handler closures pin every
        // protocol instance + node graph → memory grows ~linearly
        // with #protocols × 25K nodes and crashes the tab on the
        // 3rd-4th protocol of a 5-protocol sweep.
        //
        // Clear the handler maps and detach the transport from the
        // network before clearing the node's own state.  Stop() is
        // async so we can't await it from sync dispose — instead
        // we replicate its effect: clear handlers, then drop the
        // network's reference so GC can reclaim the transport.
        const t = node.transport;
        if (t) {
          t._requestHandlers?.clear?.();
          t._notificationHandlers?.clear?.();
          if (Array.isArray(t._peerDiedHandlers)) t._peerDiedHandlers.length = 0;
          else t._peerDiedHandlers?.clear?.();
          t._simNet     = null;     // SimulatedTransport back-ref
          t._network    = null;     // kernel simTransport back-ref
          t._localNodeId = null;
          t._localId    = null;
          t._started    = false;
          node.transport = null;
        }
        node.synaptome?.clear();
        node.incomingSynapses?.clear();
        node.highway?.clear();
        node.transitCache?.clear();
        node.regionalBaselines?.clear();
        node.recentDestFreq?.clear();
        node.pinWindowFreq?.clear();
        node.pinnedDests?.clear();
        if (node.recentDests)  node.recentDests.length  = 0;
        if (node.pinWindow)    node.pinWindow.length    = 0;
        node._nodeMapRef = null;  // break the circular back-reference
      }
      this.nodeMap.clear();
      this.nodeMap = null;
    }
    // Clear the network node + transport registries.  SimulatedNetwork
    // also holds `_transports` (added during the Transport-conformance
    // refactor) — left un-cleared this map roots every transport's
    // handler closures across protocol switches.
    if (this.network) {
      this.network.nodes?.clear();
      this.network._transports?.clear?.();
      this.network = null;
    }
    // Per-protocol registries the base class doesn't know about by
    // name but that pin large object graphs when un-cleared:
    //   · KademliaDHT.incomingPeers — Map<id, Set<peerId>>
    //   · GeographicDHT inherits buckets / incomingPeers from K-DHT
    //   · NX-17 / NH-1 / AxonaEngine carry _peers / _axonsByNode etc.,
    //     which their own dispose() overrides clear before super.
    this.incomingPeers?.clear?.();
    this.buckets = null;
  }

  /** Human-readable protocol name – used in UI. */
  static get protocolName() {
    return 'DHT';
  }

  /**
   * Verify the bilateral connection cap is being honored.
   *
   * The browser-transport cap (this.maxConnections) is the central physical
   * constraint that the entire simulator exists to model — exceeding it makes
   * benchmark numbers misleading because the protocol is operating with more
   * peer information than a real WebRTC client could sustain. This check
   * guards against any future change (in this protocol or a new one) that
   * silently bypasses tryConnect.
   *
   * Returns null when no cap is in effect (web limit off / Infinity), so
   * callers can short-circuit. Otherwise returns a snapshot:
   *   { cap, alive, avg, max, overflow, overflowIds }
   *
   * `overflow` is the count of live nodes whose connections.size > cap.
   * `overflowIds` is a small sample (up to 5) for quick diagnosis.
   *
   * @param {string} [phase] - Label for log output (e.g. "post-init").
   * @returns {object|null}
   */
  verifyConnectionCap(phase = 'unspecified') {
    const dhtCap = this.maxConnections;
    // Web limit off: no cap to enforce. Return null so callers can skip
    // logging / scoring without a special-case.
    if (!isFinite(dhtCap)) return null;

    const alive = this.getNodes().filter(n => n.alive);
    if (alive.length === 0) return null;

    // Each node has its own maxConnections (highway nodes get Infinity).
    // We check each node against ITS OWN cap, not the DHT-wide cap, so
    // highway nodes are correctly exempted from violation reporting.
    let sum = 0, max = 0, overflow = 0;
    let highwayCount = 0;
    const overflowIds = [];
    for (const n of alive) {
      const sz = n.connections?.size ?? 0;
      sum += sz;
      if (sz > max) max = sz;
      const nodeCap = n.maxConnections;
      if (!isFinite(nodeCap)) { highwayCount++; continue; }
      if (sz > nodeCap) {
        overflow++;
        if (overflowIds.length < 5) overflowIds.push(n.id);
      }
    }
    const avg = sum / alive.length;
    const proto = this.constructor.protocolName ?? this.constructor.name;
    const hwTag = highwayCount > 0 ? `, highway=${highwayCount}` : '';
    if (overflow > 0) {
      console.error(
        `[CAP VIOLATION] ${proto} @${phase}: ${overflow}/${alive.length - highwayCount} ` +
        `capped nodes exceed cap=${dhtCap} (max observed=${max}, ` +
        `sample IDs=${overflowIds.join(',')}${hwTag})`,
      );
    } else {
      console.log(
        `[cap-ok] ${proto} @${phase}: cap=${dhtCap}, alive=${alive.length}${hwTag}, ` +
        `avg=${avg.toFixed(1)}, max=${max}`,
      );
    }
    return { cap: dhtCap, alive: alive.length, highway: highwayCount, avg, max, overflow, overflowIds };
  }
}
