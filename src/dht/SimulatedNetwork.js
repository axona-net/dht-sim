import { roundTripLatency } from '../utils/geo.js';
import { SimulatedTransport } from './SimulatedTransport.js';

/**
 * SimulatedNetwork – implements message passing without real network I/O.
 *
 * Latency is computed geometrically (great-circle distance) rather than
 * waited on, making the simulation run at full CPU speed.
 *
 * To convert this into a real network:
 *   - Replace `send()` with an async TCP/UDP call to the target node.
 *   - Replace `computeLatency()` with measured RTT.
 *   - Keep the same interface so DHTNode / DHT subclasses need zero changes.
 */
export class SimulatedNetwork {
  constructor(dht = null) {
    /** @type {Map<number, import('./DHTNode.js').DHTNode>} */
    this.nodes = new Map();
    this.messageCount = 0;
    /**
     * Back-reference to the owning DHT so we can propagate connection-cap
     * invariants to every node that registers, including those added long
     * after `buildRoutingTables` has already run (churn replacements,
     * interactive Add Nodes, slice-world bridges, etc.).
     */
    this.dht = dht;

    // v0.70.07 — per-node Transport registry. Each node's
    // SimulatedTransport registers itself at start() so other transports
    // can find it for inbound dispatch and so removeNode can broadcast
    // onPeerDied. Lives in parallel to the legacy `nodes` map and the
    // legacy send() path; subsequent commits migrate protocol code from
    // the legacy path to transport.send / transport.notify.
    /** @type {Map<bigint, import('./SimulatedTransport.js').SimulatedTransport>} */
    this._transports = new Map();
  }

  /**
   * Register a node, attach this network to it, and inherit the DHT-wide
   * connection cap (set by buildRoutingTables). This is the single chokepoint
   * where the bilateral-cap invariant gets stamped onto every node — no
   * subclass can forget to do it because every subclass calls this method.
   */
  addNode(node) {
    this.nodes.set(node.id, node);
    node._network = this;
    if (this.dht && isFinite(this.dht.maxConnections)) {
      node.maxConnections = this.dht.maxConnections;
    }
  }

  /** Mark a node as dead and remove it from the registry. */
  removeNode(nodeId) {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.alive = false;
      node._network = null;
      this.nodes.delete(nodeId);
    }

    // v0.70.07 — broadcast onPeerDied to every other registered
    // transport. In production this signal arrives via heartbeat
    // timeout; in the simulator it's deterministic, fired the moment
    // the node is removed.
    if (this._transports.has(nodeId)) {
      this._transports.delete(nodeId);
    }
    for (const [otherId, transport] of this._transports) {
      if (otherId !== nodeId) transport._firePeerDied(nodeId);
    }
  }

  /**
   * Simulate sending a message from `fromNode` to `toNodeId`.
   * Calls `handleMessage` on the target node synchronously (no real I/O).
   *
   * Per-cycle traffic counters (v0.70.00) are incremented here on both
   * endpoints — sender and receiver — plus a per-type subtotal. This is
   * the single chokepoint every protocol-level message passes through, so
   * instrumenting once captures everything: lookups, pings, pub/sub
   * forwarding, sponsor-chain joins, hop caching, triadic closure, every
   * mechanism. Engine.snapshotTrafficLoad() reads and resets these
   * counters after each training cycle.
   *
   * The `from` half is bumped only for live nodes (sender may be a
   * "ghost" node during certain edge-case test paths).
   *
   * @returns {{ response: any, latency: number }}   latency in ms (round-trip)
   */
  send(fromNode, toNodeId, type, data) {
    const toNode = this.nodes.get(toNodeId);
    if (!toNode || !toNode.alive) {
      throw new Error(`Node ${toNodeId} is unreachable`);
    }

    this.messageCount++;

    // ── Traffic counters: sender side ─────────────────────────────────
    if (fromNode && fromNode.alive !== false) {
      fromNode.msgsSent = (fromNode.msgsSent | 0) + 1;
      if (!fromNode.msgsByType) fromNode.msgsByType = Object.create(null);
      fromNode.msgsByType[type] = (fromNode.msgsByType[type] | 0) + 1;
    }
    // ── Traffic counters: receiver side ────────────────────────────────
    toNode.msgsReceived = (toNode.msgsReceived | 0) + 1;
    if (!toNode.msgsByType) toNode.msgsByType = Object.create(null);
    toNode.msgsByType[type] = (toNode.msgsByType[type] | 0) + 1;

    const latency = roundTripLatency(fromNode, toNode);
    const response = toNode.handleMessage({ type, from: fromNode.id, data });
    return { response, latency };
  }

  /** One-way latency for analytics (used by lookup algorithms). */
  computeLatency(fromNode, toNode) {
    return roundTripLatency(fromNode, toNode);
  }

  get size() {
    return this.nodes.size;
  }

  // ─── v0.70.07 — Transport registry / factory ───────────────────────
  //
  // Per-node SimulatedTransport instances register here at start() so
  // they can be found for inbound dispatch (transport.send → look up
  // receiver's transport → invoke registered handler) and so
  // removeNode() can broadcast onPeerDied. The registry is decoupled
  // from the legacy `nodes` map so the existing SimulatedNetwork.send
  // path keeps working without change.

  /**
   * Create a SimulatedTransport instance for `nodeId`. The transport
   * is *not* started yet — caller must call `await transport.start()`.
   *
   * @param {bigint} nodeId
   * @returns {import('./SimulatedTransport.js').SimulatedTransport}
   */
  makeTransport(nodeId) {
    return new SimulatedTransport(this, nodeId);
  }

  /** @internal used by SimulatedTransport.start */
  _registerTransport(nodeId, transport) {
    this._transports.set(nodeId, transport);
  }

  /** @internal used by SimulatedTransport.stop */
  _unregisterTransport(nodeId) {
    this._transports.delete(nodeId);
  }

  /** @internal used by SimulatedTransport.send for inbound dispatch */
  _getTransport(nodeId) {
    return this._transports.get(nodeId);
  }
}
