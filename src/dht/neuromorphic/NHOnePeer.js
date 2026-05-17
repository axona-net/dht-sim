// =====================================================================
// NHOnePeer — per-node DHT contract implementation for NH-1.
//
// ── Migration status (Phase 1 of NH1-PerNode-Refactor-Plan-v0.71.md) ──
//
// Phase 1 — Skeleton + co-existence.
//
// This class exists to implement the per-node DHT contract at
// `src/contracts/DHT.js` against the existing multi-node
// `NeuromorphicDHTNH1` (the simulator's NH-1 engine).  In Phase 1 every
// method is a thin delegation to the engine, with the per-node
// `NeuronNode` reference passed through where the engine expects it.
//
// The intent is to validate the per-node API shape (matches the
// contract, can be constructed cleanly, can be observed via getMetrics
// and onEvent) before moving any actual protocol logic out of the
// engine.  Subsequent phases (2 → 3) progressively move read-only and
// then write operations into this class; Phase 4 then renames today's
// engine to `NHOneEngine` and finalises the split.
//
// During Phase 1 the simulator's behaviour is unchanged: the engine
// still owns all the routing logic; NHOnePeer is just an alternative
// API surface that production peers can use to exercise NH-1 through
// the contract.
//
// ── What this class IS ───────────────────────────────────────────────
//   - The DHT contract (src/contracts/DHT.js) implementation for one peer
//   - One instance per running node (in both sim and production)
//   - Owns: a reference to its NeuronNode (per-node state), a reference
//     to the engine (during Phase 1; later phases move logic here), a
//     reference to its transport, and a set of per-peer event listeners.
//
// ── What this class IS NOT ───────────────────────────────────────────
//   - A multi-node manager (that's the engine's job)
//   - A wrapper that hides the engine's existence from the simulator
//     (Phase 1 keeps the engine reachable so the simulator's tests and
//     Engine-cycle code continue to work)
// =====================================================================

import { DHT } from '../../contracts/DHT.js';

export class NHOnePeer extends DHT {
  /**
   * @param {object} opts
   * @param {import('./NeuromorphicDHTNH1.js').NeuromorphicDHTNH1} opts.engine
   *        The legacy multi-node engine (Phase 1: delegate target).
   * @param {import('./NeuronNode.js').NeuronNode} opts.node
   *        The NeuronNode this peer wraps.
   */
  constructor({ engine, node }) {
    super();
    if (!engine) throw new Error('NHOnePeer: engine is required');
    if (!node)   throw new Error('NHOnePeer: node is required');
    this._engine = engine;
    this._node   = node;
    this._started = false;
    /** @type {Set<(event: object) => void>} */
    this._eventListeners = new Set();
    /** @type {(event: object) => void | null} */
    this._engineListenerUnsub = null;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────
  //
  // Phase 1: start/stop are mostly bookkeeping.  The underlying node
  // was already created and registered with the engine via
  // `engine.addNode()` before this NHOnePeer instance came into
  // existence.  We just need to wire up event forwarding so that
  // `onEvent` listeners on this peer receive events that the engine
  // emits about this node.
  //
  // In later phases, start() will move into the real lifecycle:
  // allocate the synaptome, register transport handlers, spin up the
  // decay tick.  For Phase 1 it's idempotent and lightweight.

  async start() {
    if (this._started) return;

    // Engine emits events to a single global listener set today
    // (engine._eventListeners).  We subscribe and filter to events
    // about THIS node, then forward to our per-peer listeners.  This
    // lets the production peer subscribe via NHOnePeer.onEvent without
    // seeing other nodes' events (which it can't, since production
    // only has one node).
    this._engineListenerUnsub = this._engine.onEvent((ev) => {
      // Most events carry a node identifier in one of several fields:
      //   nodeId, peerId, observerId, sourceId, …
      // The current set of event types and their id fields is
      // documented in src/contracts/types.js (ProtocolEvent union).
      // Phase 1 forwards events that mention this._node.id in any of
      // the documented locations; refinement happens when start() owns
      // the event-emit sites in Phase 3.
      if (this._eventMentionsSelf(ev)) {
        for (const cb of this._eventListeners) {
          try { cb(ev); }
          catch (err) {
            console.error(`NHOnePeer ${this._node.id} listener threw:`, err);
          }
        }
      }
    });

    this._started = true;
  }

  async stop() {
    if (!this._started) return;
    if (this._engineListenerUnsub) {
      this._engineListenerUnsub();
      this._engineListenerUnsub = null;
    }
    this._started = false;
  }

  /**
   * Phase 1 stub.  The real production join() will:
   *   1. Use BootstrapService.bootstrap(sponsor) to open the first
   *      WebRTC channel.
   *   2. Run a self-lookup through that sponsor.
   *   3. Stratified-fill the synaptome via subsequent FIND_NODE-style
   *      RPCs over the new transport.
   * In Phase 1 we throw if called from the simulator path — the
   * simulator uses engine.bootstrapJoin instead, which is god's-eye
   * and not contract-shaped.  Production code paths arrive at this
   * stub once Phase 6 (integration) lands.
   */
  async join(_sponsor) {
    throw new Error(
      'NHOnePeer.join: not implemented in Phase 1. ' +
      'Simulator path uses engine.bootstrapJoin; ' +
      'production path lands in Phase 6 integration.'
    );
  }

  async leave() {
    // Phase 1: graceful shutdown is a no-op.  Real implementation
    // notifies known peers and closes channels; tracked in Phase 6.
    return;
  }

  // ─── DHT operations ────────────────────────────────────────────────
  //
  // Phase 1: delegate to the engine.  The engine's lookup takes
  // (sourceId, targetKey) — we supply this peer's id as the source.

  async lookup(targetKey) {
    return this._engine.lookup(this._node.id, targetKey);
  }

  async subscribe(topicName, handler) {
    // Phase 1: subscribe through the engine-owned AxonManager for
    // this node.  Future phases move this into the peer itself.
    const axon = this._engine.axonFor(this._node);
    return axon.subscribe(this._node.id, topicName, handler);
  }

  async unsubscribe(sub) {
    if (!sub) return;
    const axon = this._engine.axonFor(this._node);
    return axon.unsubscribe(sub);
  }

  async publish(topicName, payload) {
    const axon = this._engine.axonFor(this._node);
    return axon.publish(topicName, payload);
  }

  // ─── Identity & observability ──────────────────────────────────────

  getNodeId() {
    return this._node.id;
  }

  getSynaptome() {
    // Engine.getSynaptome accepts (nodeOrId).  Return its per-node
    // snapshot.  No mutation; safe to read at any frequency.
    return this._engine.getSynaptome(this._node);
  }

  getMetrics() {
    return this._engine.getMetrics(this._node);
  }

  onEvent(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('NHOnePeer.onEvent: handler must be a function');
    }
    this._eventListeners.add(handler);
    return () => this._eventListeners.delete(handler);
  }

  // ─── Internal: event filtering ────────────────────────────────────

  /**
   * @private
   * Decide whether a global engine event mentions this peer.  Phase 1
   * filter; refined in Phase 3 when the per-node event-emit sites
   * land directly on NHOnePeer.
   */
  _eventMentionsSelf(ev) {
    if (!ev || typeof ev !== 'object') return false;
    const me = this._node.id;
    // Common fields across the ProtocolEvent union.  Check all that
    // are documented in src/contracts/types.js; if the event doesn't
    // carry any of them it's a global event (cycle-snapshot) and
    // every per-peer instance receives it.
    return (
      ev.nodeId    === me ||
      ev.peerId    === me ||
      ev.observerId === me ||
      ev.sourceId  === me ||
      ev.type === 'cycle-snapshot'
    );
  }
}
