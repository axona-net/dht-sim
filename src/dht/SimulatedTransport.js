// =====================================================================
// SimulatedTransport — Transport-conforming adapter for the simulator.
//
// One instance per running node, created via SimulatedNetwork.makeTransport.
// Implements the contract at src/contracts/Transport.js:
//
//   start / stop / getLocalNodeId
//   openConnection / closeConnection / isConnected
//   send / notify
//   onRequest / onNotification
//   onPeerDied / getLatency
//
// The implementation delegates to a shared SimulatedNetwork (the simulator
// world). Every node's SimulatedTransport registers itself with the
// SimulatedNetwork at start(); inbound messages are routed by looking up
// the receiver's transport and invoking its registered handler.
//
// This commit (v0.70.07) ADDS the SimulatedTransport in parallel to the
// existing SimulatedNetwork.send() path. No protocol code uses
// SimulatedTransport yet — this is the adapter layer that subsequent
// commits will migrate the protocol code onto. Existing tests and
// benchmarks continue to run on the legacy path.
// =====================================================================

import { Transport } from '../contracts/index.js';
import { roundTripLatency } from '../utils/geo.js';

export class SimulatedTransport extends Transport {

  /**
   * @param {import('./SimulatedNetwork.js').SimulatedNetwork} simNet
   * @param {bigint} localNodeId
   */
  constructor(simNet, localNodeId) {
    super();
    /** @private */ this._simNet = simNet;
    /** @private */ this._localNodeId = localNodeId;
    /** @private @type {Map<string, (fromId: bigint, payload: any) => Promise<any>>} */
    this._requestHandlers = new Map();
    /** @private @type {Map<string, (fromId: bigint, payload: any) => void>} */
    this._notificationHandlers = new Map();
    /** @private @type {Array<(peerId: bigint) => void>} */
    this._peerDiedHandlers = [];
    /** @private */ this._started = false;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async start(localNodeId) {
    if (localNodeId !== undefined) this._localNodeId = localNodeId;
    if (this._started) return;
    this._simNet._registerTransport(this._localNodeId, this);
    this._started = true;
  }

  async stop() {
    if (!this._started) return;
    this._simNet._unregisterTransport(this._localNodeId);
    this._started = false;
  }

  getLocalNodeId() {
    return this._localNodeId;
  }

  // ─── Channel pool ──────────────────────────────────────────────────
  //
  // In the simulator there is no real connection cost, so openConnection
  // is just a liveness check; closeConnection is a no-op. The contract's
  // bilateral-cap semantics are enforced at the protocol level (via
  // node.tryConnect) — the transport reports whether the peer exists,
  // not whether the cap has room.

  async openConnection(peerId) {
    const peer = this._simNet.nodes.get(peerId);
    return !!(peer && peer.alive);
  }

  async closeConnection(_peerId) {
    // no-op in sim — the SimulatedNetwork has no per-channel state
  }

  isConnected(peerId) {
    const peer = this._simNet.nodes.get(peerId);
    return !!(peer && peer.alive);
  }

  // ─── Messaging ─────────────────────────────────────────────────────
  //
  // send() looks up the receiver's SimulatedTransport, finds the handler
  // for the message type, and invokes it. Counters are bumped on both
  // endpoints to preserve the v0.70.00 traffic instrumentation that
  // Engine.snapshotTrafficLoad reads. Latency is computed but currently
  // not surfaced through the call (the protocol consumes latency via
  // getLatency).

  async send(peerId, type, payload) {
    if (!this._started) throw new Error('SimulatedTransport.send: not started');

    const fromNode = this._simNet.nodes.get(this._localNodeId);
    const toNode   = this._simNet.nodes.get(peerId);
    if (!toNode || !toNode.alive) {
      throw new Error(`SimulatedTransport.send: peer ${peerId} unreachable`);
    }

    const peerTransport = this._simNet._getTransport(peerId);
    if (!peerTransport) {
      throw new Error(`SimulatedTransport.send: peer ${peerId} has no transport`);
    }
    const handler = peerTransport._requestHandlers.get(type);
    if (!handler) {
      throw new Error(`SimulatedTransport.send: peer ${peerId} has no request handler for type='${type}'`);
    }

    this._bumpCounters(fromNode, toNode, type);
    return await handler(this._localNodeId, payload);
  }

  async notify(peerId, type, payload) {
    if (!this._started) throw new Error('SimulatedTransport.notify: not started');

    const fromNode = this._simNet.nodes.get(this._localNodeId);
    const toNode   = this._simNet.nodes.get(peerId);
    if (!toNode || !toNode.alive) {
      // notify is fire-and-forget — drop silently if peer is dead, just
      // like a real UDP datagram would. Liveness is reported via the
      // heartbeat / onPeerDied channel, not via notify failures.
      return;
    }

    const peerTransport = this._simNet._getTransport(peerId);
    if (!peerTransport) return;
    const handler = peerTransport._notificationHandlers.get(type);

    this._bumpCounters(fromNode, toNode, type);
    if (handler) {
      try { handler(this._localNodeId, payload); }
      catch (err) {
        console.error(`SimulatedTransport.notify: handler for type='${type}' threw:`, err);
      }
    }
  }

  /** @private */
  _bumpCounters(fromNode, toNode, type) {
    this._simNet.messageCount = (this._simNet.messageCount | 0) + 1;
    if (fromNode && fromNode.alive !== false) {
      fromNode.msgsSent = (fromNode.msgsSent | 0) + 1;
      if (!fromNode.msgsByType) fromNode.msgsByType = Object.create(null);
      fromNode.msgsByType[type] = (fromNode.msgsByType[type] | 0) + 1;
    }
    if (toNode) {
      toNode.msgsReceived = (toNode.msgsReceived | 0) + 1;
      if (!toNode.msgsByType) toNode.msgsByType = Object.create(null);
      toNode.msgsByType[type] = (toNode.msgsByType[type] | 0) + 1;
    }
  }

  // ─── Inbound dispatch ──────────────────────────────────────────────

  onRequest(type, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('SimulatedTransport.onRequest: handler must be a function');
    }
    this._requestHandlers.set(type, handler);
  }

  onNotification(type, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('SimulatedTransport.onNotification: handler must be a function');
    }
    this._notificationHandlers.set(type, handler);
  }

  // ─── Liveness & latency ────────────────────────────────────────────
  //
  // In the simulator, peer liveness is observable directly from the
  // node's `alive` flag. SimulatedNetwork.removeNode notifies all
  // registered transports; each fires its onPeerDied handlers.
  //
  // Latency is geometric (haversine + node-delay constant), not measured
  // — the simulator has no real RTT. The same value the existing
  // SimulatedNetwork.computeLatency returns.

  onPeerDied(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('SimulatedTransport.onPeerDied: handler must be a function');
    }
    this._peerDiedHandlers.push(handler);
    return () => {
      this._peerDiedHandlers = this._peerDiedHandlers.filter(h => h !== handler);
    };
  }

  getLatency(peerId) {
    const fromNode = this._simNet.nodes.get(this._localNodeId);
    const toNode   = this._simNet.nodes.get(peerId);
    if (!fromNode || !toNode || !toNode.alive) return -1;
    return roundTripLatency(fromNode, toNode);
  }

  // ─── Internal API used by SimulatedNetwork ─────────────────────────
  //
  // These are not part of the Transport contract; they're how the
  // simulator world signals into per-node transports. Production
  // transports won't have analogues — they'll observe peer death via
  // the heartbeat timeout instead.

  /** @internal called by SimulatedNetwork.removeNode for every other transport */
  _firePeerDied(peerId) {
    for (const h of this._peerDiedHandlers) {
      try { h(peerId); }
      catch (err) {
        console.error('SimulatedTransport: onPeerDied handler threw:', err);
      }
    }
  }
}
