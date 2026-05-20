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
