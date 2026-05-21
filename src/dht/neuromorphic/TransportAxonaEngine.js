// =====================================================================
// TransportAxonaEngine — the dht-sim DHT contract satisfied by N
//                        kernel AxonaPeers over kernel Transport.sim.
//
// Replaces the AxonaEngine god's-eye fallthrough that `case 'axona'`
// used to dispatch.  Where AxonaEngine owns every node directly and
// dispatches per-hop messages through SimulatedTransport (which has
// god's-eye access to the full nodeMap), TransportAxonaEngine is
// strictly peer-driven:
//
//   · Each NeuronNode pairs with a kernel AxonaPeer (`@axona/protocol`)
//   · Every cross-peer message goes through kernel SimNetwork +
//     simTransport — no global node-table lookup
//   · A single AxonaDomain holds shared state (simEpoch, EMAs,
//     tuning constants) for every peer
//   · `peer.lookup()` runs the kernel's iterative routing through
//     `transport.send('lookup_step', …)` exactly the same way a
//     standalone deployment would
//
// What v1 does NOT include (queued for follow-up commits that
// continue lifting engine-side handlers into the peer):
//
//   · Triadic closure, lateral spread, hop cache (the engine's
//     handler bodies for these still call back into engine-only
//     helpers like `_addByVitality(node, syn)`)
//   · Annealing + temperature decay tick (the peer reads
//     `domain.T_INIT / ANNEAL_RATE_SCALE / …` but no driver runs
//     the cooling loop)
//   · Dead-peer eviction-and-replace (NX-6 churn resilience)
//   · `find_closest_set` and the routed `route_msg` chain
//
// Without those, axona benchmarks at this layer hit the bootstrap-
// quality XOR table and produce numbers close to Kademlia/G-DHT
// — useful as a correctness signal, not yet a performance claim.
// The advanced features are what make NH-1/NX-17 fast at scale;
// they migrate one handler at a time.
// =====================================================================

import {
  AxonaPeer,
  AxonaDomain,
  NeuronNode,
  Synapse,
  SimNetwork,
  simTransport,
  geoCellId,
  roundTripLatency,
  randomU32,
} from '@axona/protocol';
import { buildXorRoutingTable }     from '@axona/protocol/utils/geo.js';
import { DHT } from '../DHT.js';

// 64-bit BigInt random (the simulator addressing layer is still on
// the legacy 64-bit nodeId path; the new kernel hex API is for
// production deployments).
function randomU64() {
  const hi = BigInt(randomU32());
  const lo = BigInt(randomU32());
  return (hi << 32n) | lo;
}

export class TransportAxonaEngine extends DHT {
  constructor(opts = {}) {
    super();
    this._k       = opts.k       ?? 20;
    this._alpha   = opts.alpha   ?? 3;
    this._bits    = opts.bits    ?? 64;
    this.GEO_BITS = opts.geoBits ?? 8;

    // One shared domain for every peer in this engine.  Hands the
    // peers their tuning constants + event bus + simEpoch counter.
    this.domain = new AxonaDomain(opts.domainOpts ?? {});

    // Node table that the simulator iterates against
    // (`dht.nodeMap.get(id)`, `dht.nodeMap.values()`, ...).
    /** @type {Map<bigint, NeuronNode>} */
    this.nodeMap = new Map();

    /** @type {Map<bigint, AxonaPeer>} */
    this._peers = new Map();

    // Kernel SimNetwork — the in-process pub/sub bus for the
    // peer-to-peer transports.  latencyFn does haversine + speed-of-
    // light propagation using NeuronNode lat/lng so XOR-distance and
    // wall-clock latency stay correlated (same shape AxonaEngine's
    // SimulatedTransport gave us via roundTripLatency).
    const positionByHex = new Map();   // hex → NeuronNode
    this._positionByHex = positionByHex;
    this._network = new SimNetwork({
      latencyFn: (fromHex, toHex) => {
        const a = positionByHex.get(fromHex);
        const b = positionByHex.get(toHex);
        if (!a || !b) return 0;
        // roundTripLatency is RTT; this is one-way, so halve it.
        return roundTripLatency(a, b) / 2;
      },
    });
  }

  // ─── DHT contract — addNode ──────────────────────────────────────

  async addNode(lat, lng) {
    // Geographic ID assignment — top GEO_BITS encode S2 cell prefix
    // for (lat, lng), bottom bits are random.  Same encoding the
    // engine-driven AxonaEngine uses; keeps XOR distance correlated
    // with geographic distance so the bootstrap routing table is
    // useful immediately.
    const prefix   = geoCellId(lat, lng, this.GEO_BITS);
    const shift    = BigInt(64 - this.GEO_BITS);
    const randBits = randomU64() & ((1n << shift) - 1n);
    const id       = (BigInt(prefix) << shift) | randBits;

    const node = new NeuronNode({ id, lat, lng });
    node.alive       = true;
    node.temperature = this.domain.T_INIT;
    this.nodeMap.set(id, node);

    // Wire kernel transport + register with the SimNetwork latency
    // model.  Pass BigInt id directly — simTransport.start hex-
    // encodes internally (Phase 5e normalisation).
    const transport = simTransport({ network: this._network, heartbeatMs: 0 });
    await transport.start(id);
    node.transport = transport;

    // Make the position-by-hex lookup work for the latencyFn closure
    // above.  start() converted BigInt → hex; ask the transport for
    // its own resolved local id rather than re-encoding here.
    this._positionByHex.set(transport.getLocalNodeId(), node);

    const peer = new AxonaPeer({
      domain: this.domain,
      node,
      transport,
    });
    await peer.start();              // installs lookup_step handler
    this._peers.set(id, peer);

    this.domain._emit({
      type: 'peer-joined',
      timestamp: Date.now(),
      peerId: id,
      addedBy: 'addNode',
    });
    return node;
  }

  // ─── DHT contract — buildRoutingTables ───────────────────────────

  buildRoutingTables({
    bidirectional  = true,
    maxConnections = Infinity,
    maxOutgoing    = Infinity,
    maxIncoming    = Infinity,
    highwayPct     = 0,             // (v1 ignores)
    initMode       = 'native',      // (v1 always native)
  } = {}) {
    const k = this._k;
    // BigInt-sorted node list — buildXorRoutingTable needs ascending id.
    const sorted = [...this.nodeMap.values()].sort(
      (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );

    // Shuffled iteration order (parity with AxonaEngine) so the
    // bilateral cap doesn't starve later nodes.
    const order = [...sorted].sort(() => Math.random() - 0.5);

    for (const node of order) {
      const cap = isFinite(maxConnections) ? maxConnections : Infinity;
      node._maxSynaptome = isFinite(cap)
        ? Math.min(cap, this.domain.MAX_SYNAPTOME)
        : 256;
      const candidates = buildXorRoutingTable(node.id, sorted, k, cap);
      for (const peer of candidates) {
        if (!node.tryConnect(peer)) continue;
        const latMs   = roundTripLatency(node, peer);
        const stratum = clz64(node.id ^ peer.id);
        const syn = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });
        syn.bootstrap = true;
        syn._addedBy  = 'bootstrap';
        node.addSynapse(syn);
        if (bidirectional) {
          peer.addIncomingSynapse(node.id, latMs, stratum);
        }
      }
    }

    // Open every transport channel between paired nodes so the
    // kernel's lookup_step send() finds open channels.  Bilateral
    // admission is automatic.
    //
    // We do this AFTER synapse fill so we only open the channels
    // we'll actually use — N synaptome × N peers worth, not full
    // N×N which would dominate setup time at >1K nodes.
    return Promise.all(
      [...this.nodeMap.values()].map(async (node) => {
        for (const syn of node.synaptome.values()) {
          try { await node.transport.openConnection(syn.peerId); }
          catch { /* peer transport not up yet, retry on next pass */ }
        }
      }),
    );
  }

  // ─── DHT contract — removeNode (churn) ──────────────────────────
  //
  // The benchmark's churn round calls `await dht.removeNode(node.id)`
  // for each killed peer.  Without an override the base class throws
  // "not implemented" and the entire sweep wedges on the first
  // round, so we wire one up that mirrors AxonaEngine.removeNode
  // (tear down the per-node DHT-contract wrapper) plus the bits
  // unique to this engine (stop the kernel SimTransport, drop our
  // positionByHex entry).

  async removeNode(nodeId) {
    const node = this.nodeMap.get(nodeId);
    if (!node) return;
    node.alive = false;
    const peer = this._peers.get(nodeId);
    if (peer) {
      try { await peer.stop(); } catch { /* not started; safe to drop */ }
      this._peers.delete(nodeId);
    }
    if (node.transport) {
      try { this._positionByHex.delete(node.transport.getLocalNodeId()); }
      catch { /* transport already disposed */ }
      try { await node.transport.stop(); }
      catch { /* not started */ }
    }
    this.nodeMap.delete(nodeId);

    // Memory: same zombie-reference sweep as KademliaDHT.removeNode
    // and AxonaEngine.removeNode.  Without this, every surviving
    // node's synaptome + incomingSynapses Map keeps the dying
    // node's Synapse object reachable, which keeps the dying node
    // and its own back-references reachable.  Compounds per churn
    // round and exhausts the heap at 25K within 2-3 rounds.
    if (node.synaptome instanceof Map) node.synaptome.clear();
    if (node.incomingSynapses instanceof Map) node.incomingSynapses.clear();
    for (const other of this.nodeMap.values()) {
      if (!other || other === node) continue;
      other.synaptome?.delete?.(nodeId);
      other.incomingSynapses?.delete?.(nodeId);
      other._deadPeers?.delete?.(nodeId);
    }

    // Aggressive teardown — see KademliaDHT.removeNode.  node.transport
    // was already stopped + nulled higher in this method; clear the
    // remaining heavy maps so the GC collects on the next minor cycle.
    if (node._deadPeers instanceof Set)        node._deadPeers.clear();
    if (node.connections instanceof Set)       node.connections.clear();
    if (node.regionalBaselines instanceof Map) node.regionalBaselines.clear();
    if (node.transitCache instanceof Map)      node.transitCache.clear();

    this.domain._emit({
      type: 'peer-left', timestamp: Date.now(),
      peerId: nodeId, reason: 'remove',
    });
  }

  // ─── DHT contract — bootstrapJoin (churn replacement) ───────────
  //
  // Called by the churn loop after addNode for each replacement
  // peer.  Walks the synaptome of the sponsor outward (XOR-iterative
  // closest-set discovery), opens SimTransport channels to every
  // discovered peer, and admits them as synapses on the new node so
  // it's reachable from the surviving mesh on the next lookup round.
  //
  // Returns the number of synapses installed (also stored as
  // newNode._joinReach for benchmark introspection).

  async bootstrapJoin(newNodeId, sponsorId) {
    const newNode = this.nodeMap.get(newNodeId);
    const sponsor = this.nodeMap.get(sponsorId);
    if (!newNode || !sponsor) return 0;

    const k = this._k;
    const alpha = this._alpha;
    if (newNode._maxSynaptome == null) {
      const c = newNode.maxConnections ?? Infinity;
      newNode._maxSynaptome = isFinite(c)
        ? Math.min(c, this.domain.MAX_SYNAPTOME)
        : 256;
    }

    const addPeer = async (peer) => {
      if (peer.id === newNodeId || newNode.synaptome.has(peer.id)) return false;
      if (newNode.synaptome.size >= newNode._maxSynaptome) return false;
      if (!newNode.tryConnect(peer)) return false;
      const latMs   = roundTripLatency(newNode, peer);
      const stratum = clz64(newNode.id ^ peer.id);
      const syn = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });
      syn._addedBy = 'bootstrapJoin';
      newNode.addSynapse(syn);
      if (this.bidirectional !== false) {
        peer.addIncomingSynapse(newNode.id, latMs, stratum);
      }
      // Open the kernel SimTransport channel so lookup_step.send can
      // route between them.  Tolerate failures (peer transport may
      // already be torn down by a concurrent removeNode in heavy
      // churn — the next refresh round retries).
      try { await newNode.transport.openConnection(peer.id); } catch {}
      return true;
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

    const iterLookup = async (targetId, startNode, maxRounds) => {
      const queried = new Set([newNodeId]);
      let shortlist = findClosest(startNode, targetId);
      for (const p of shortlist) await addPeer(p);
      for (let round = 0; round < maxRounds; round++) {
        const unq = shortlist.filter(n => !queried.has(n.id)).slice(0, alpha);
        if (!unq.length) break;
        let improved = false;
        for (const peer of unq) {
          queried.add(peer.id);
          for (const c of findClosest(peer, targetId)) {
            if (c.id !== newNodeId && !queried.has(c.id)) {
              await addPeer(c);
              if (!shortlist.some(n => n.id === c.id)) {
                shortlist.push(c); improved = true;
              }
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

    await addPeer(sponsor);
    await iterLookup(newNodeId, sponsor, 10);

    newNode._joinReach = newNode.synaptome.size;
    return newNode._joinReach;
  }

  // ─── DHT contract — postChurnHeal ────────────────────────────────
  //
  // Called once at the end of each churn round.  Asks each surviving
  // peer's AxonaPeer to evict synapses pointing at known-dead peers
  // and replace them via the kernel's _evictAndReplace primitive.

  async postChurnHeal() {
    for (const [nodeId, peer] of this._peers.entries()) {
      const node = this.nodeMap.get(nodeId);
      if (!node?.alive) continue;
      const deadSet = node._deadPeers || new Set();
      const dead = [];
      for (const syn of node.synaptome.values()) {
        if (deadSet.has(syn.peerId) || !this.nodeMap.get(syn.peerId)?.alive) {
          dead.push(syn);
        }
      }
      for (const syn of dead) {
        node.synaptome.delete(syn.peerId);
        node.connections?.delete(syn.peerId);
        try { await node.transport.closeConnection(syn.peerId); } catch {}

        // Replacement: the kernel's _evictAndReplace path queries
        // `_localCandidate` via `local_probe` RPCs — but
        // _installRoutingHandlers doesn't wire that handler yet
        // ("not yet wired" per the kernel comment), so the RPC
        // never returns and no replacement is admitted.  Without
        // a replacement, post-churn synaptomes shrink each round
        // and the routing graph degrades (observed: 50% success
        // at 500 nodes after 5 churn rounds).
        //
        // Use the simulator's god's-eye nodeMap to pick a
        // replacement at the dead synapse's stratum group.  This
        // matches what AxonaEngine.postChurnHeal does via
        // `_evictAndReplace` on the engine-driven path; we just
        // skip the routed-probe step and read directly from
        // nodeMap.
        await this._installReplacement(node, syn);
      }
      for (const peerId of [...node.incomingSynapses.keys()]) {
        if (deadSet.has(peerId) || !this.nodeMap.get(peerId)?.alive) {
          node.incomingSynapses.delete(peerId);
        }
      }
      if (dead.length > 0) {
        node.temperature = Math.max(node.temperature, this.domain.T_REHEAT ?? 1);
        // Clear the dead-peers cache so the next lookup round can
        // freely probe peers that were marked dead during this round.
        deadSet.clear?.();
      }
    }
  }

  /**
   * Pick a stratum-matched replacement for a recently-evicted dead
   * synapse from the live nodeMap.  XOR-closest live peer in the
   * dead synapse's stratum group that's NOT already in the
   * synaptome.  Opens the SimTransport channel and admits the
   * synapse so the lookup graph repairs immediately.
   *
   * @private
   */
  async _installReplacement(node, deadSyn) {
    if (node.synaptome.size >= (node._maxSynaptome ?? this.domain.MAX_SYNAPTOME)) {
      return null;
    }
    const targetStratum = deadSyn.stratum;
    // Walk nodeMap, score by stratum-distance and XOR-distance.
    let best = null;
    let bestScore = Infinity;
    for (const candidate of this.nodeMap.values()) {
      if (!candidate.alive) continue;
      if (candidate.id === node.id) continue;
      if (node.synaptome.has(candidate.id)) continue;
      const stratum = clz64(node.id ^ candidate.id);
      const stratumDist = Math.abs(stratum - targetStratum);
      // Tie-break stratum equality by XOR distance — smaller is closer.
      const xor = node.id ^ candidate.id;
      const score = stratumDist * 1_000_000 + Number(xor & 0xffffffffn);
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (!best) return null;
    if (!node.tryConnect(best)) return null;
    try { await node.transport.openConnection(best.id); } catch {}
    const latMs   = roundTripLatency(node, best);
    const stratum = clz64(node.id ^ best.id);
    const syn = new Synapse({ peerId: best.id, latencyMs: latMs, stratum });
    syn._addedBy = 'postChurnHeal';
    node.addSynapse(syn);
    if (this.bidirectional !== false) {
      best.addIncomingSynapse(node.id, latMs, stratum);
    }
    return syn;
  }

  // ─── DHT contract — lookup ───────────────────────────────────────

  /**
   * @param {bigint} sourceId
   * @param {bigint} targetId
   * @returns {Promise<{ found, hops, path, time }>}
   */
  async lookup(sourceId, targetId) {
    const peer = this._peers.get(sourceId);
    if (!peer) return { found: false, hops: 0, path: [sourceId], time: 0 };
    return peer.lookup(targetId);
  }

  // ─── DHT contract — dispose (release everything between protocols) ──
  //
  // dht-sim calls dht.dispose() synchronously before allocating the
  // next protocol's engine (main.js:304).  Without this override the
  // base class's dispose runs against `this.network` / `this.nodeMap`
  // but never sees TransportAxonaEngine's own large object graphs —
  // _peers (N AxonaPeers), _network (kernel SimNetwork holding N
  // SimTransports), _positionByHex — and the next protocol's allocation
  // happens on top of a still-live Axona graph.  At 25K × 5 protocols
  // that's enough to OOM browser memory ~10 minutes into a sweep.
  //
  // The teardown has to be synchronous because dispose itself is
  // synchronous (the base contract).  We can't await peer.stop() /
  // transport.stop() here; instead we walk every Map/Set/timer that
  // would root a SimTransport or AxonaPeer and clear it directly.
  // Any in-flight async work resolves to no-ops because the maps are
  // already empty.  GC reclaims the cycle on the next minor.

  dispose() {
    // Step 1 — neutralise every AxonaPeer: clear its handler tables
    // and subscriptions so closures over `peer` don't keep nodes /
    // transport alive through the synaptome cache.
    if (this._peers instanceof Map) {
      for (const peer of this._peers.values()) {
        try {
          if (peer._engineListenerUnsub) {
            peer._engineListenerUnsub();
            peer._engineListenerUnsub = null;
          }
          peer._directHandlers?.clear?.();
          peer._routedHandlers?.clear?.();
          peer._subscriptions?.clear?.();
          peer._axonManager = null;
          peer._started = false;
          peer._transport = null;
          peer._node = null;
        } catch { /* defensive — never throw out of dispose */ }
      }
      this._peers.clear();
      this._peers = null;
    }

    // Step 2 — tear down every SimTransport synchronously.  Critical
    // bits: (a) clearInterval all heartbeats (timers root the transport
    // from the runtime); (b) clear the SimNetwork's _transports registry
    // entry (otherwise the network roots the transport).
    if (this._network) {
      const transports = this._network._transports;
      if (transports instanceof Map) {
        for (const t of transports.values()) {
          try {
            if (t._heartbeats instanceof Map) {
              for (const h of t._heartbeats.values()) clearInterval(h);
              t._heartbeats.clear();
            }
            t._latency?.clear?.();
            t._openTo?.clear?.();
            t._pendingRequests?.clear?.();
            t._diedHandlers?.clear?.();
            t._requestHandlers?.clear?.();
            t._notificationHandlers?.clear?.();
            t._network = null;
            t._localId = null;
            t._started = false;
          } catch {}
        }
        transports.clear();
      }
      // Null out latencyFn closure — it captures positionByHex which
      // captures every NeuronNode.
      try { this._network._latencyFn = null; } catch {}
      this._network = null;
    }

    if (this._positionByHex instanceof Map) {
      this._positionByHex.clear();
      this._positionByHex = null;
    }

    // Step 3 — base-class cleanup walks nodeMap (synaptomes, etc.)
    // and the *dht-sim* SimulatedNetwork at this.network.  Calling it
    // last so our Axona-specific clears run first while peers still
    // resolve.
    super.dispose();
  }

  // ─── DHT contract — health / introspection ──────────────────────

  /**
   * Override DHT.getNodes() — the base class returns
   * `[...this.network.nodes.values()]` and `this.network` is dht-sim's
   * SimulatedNetwork (instantiated by `super()`).  We don't populate
   * that network — every cross-peer message uses the kernel
   * SimNetwork at `this._network` instead.  So we point getNodes()
   * at our own nodeMap, which the simulator's benchmark loop reads
   * via `dht.getNodes().filter(n => n.alive)` at ~15+ sites
   * (δ-baseline, lookup test, churn analysis, …).
   */
  getNodes() {
    return [...this.nodeMap.values()];
  }

  verifyConnectionCap(_tag) {
    // v1 no-op.  The engine-side check walks every node's
    // synaptome.size — we already enforce caps in buildRoutingTables
    // via tryConnect.
  }

  /** Iterate live nodes — the simulator uses this to choose lookup
   *  sources / destinations and pubsubm role analysis. */
  *aliveNodes() {
    for (const n of this.nodeMap.values()) if (n.alive) yield n;
  }
}

// ─── Local 64-bit shim (mirrors AxonaEngine + axona-peer pattern) ──
// Kernel v1.0 dropped clz64 in favour of clz264 for the 264-bit hex
// path.  buildXorRoutingTable + Synapse-stratum machinery is still
// on the legacy 64-bit BigInt path here.  Math.clz32-chunks impl
// is ~100× faster than the naive BigInt-shift loop and matches
// what the simulator's AxonaEngine and axona-peer already use.
function clz64(x) {
  if (x === 0n) return 64;
  const hi = Number((x >> 32n) & 0xFFFFFFFFn);
  if (hi !== 0) return Math.clz32(hi);
  const lo = Number(x & 0xFFFFFFFFn);
  return 32 + Math.clz32(lo);
}
