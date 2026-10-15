/**
 * DHTNode – base class representing a physical node in the DHT network.
 *
 * Design intent: this class is network-agnostic. In simulation mode, the
 * SimulatedNetwork wires nodes together directly. In a real deployment, a
 * RealNetwork implementation would replace SimulatedNetwork, intercepting
 * send/receive at the same interface without touching this class.
 */
import { geoCellId } from '../utils/s2.js';
import { clz64 }     from '../utils/geo.js';

/**
 * Number of bits used for the S2 geographic cell stored on every node.
 * 8 bits → 256 cells worldwide, radius ≈ 800 km each – fine-grained enough
 * for the 2000 km regional radius while still being coarser than node IDs.
 */
export const GEO_CELL_BITS = 8;

export class DHTNode {
  /**
   * @param {object} opts
   * @param {number} opts.id    - Unique identifier in the DHT key space
   * @param {number} opts.lat   - Geographic latitude  (-90 … 90)
   * @param {number} opts.lng   - Geographic longitude (-180 … 180)
   */
  constructor({ id, lat, lng }) {
    this.id = id;
    this.lat = lat;
    this.lng = lng;
    this.alive = true;
    this.joinedAt = Date.now();

    /**
     * Per-cycle traffic counters (v0.70.00).
     *
     * The simulator until now has had no model of bandwidth — every node
     * can handle an arbitrary number of messages per unit time. The
     * hypothesis (red-team Tier 1 "bandwidth saturation" deploy blocker)
     * is that real workloads will produce a heavy-tailed distribution: a
     * small number of nodes — highway hubs, hot pub/sub roots,
     * over-trained synapse targets — will accumulate physically impossible
     * message rates while the median node sees almost nothing.
     *
     * Every message through SimulatedNetwork.send() bumps a counter on
     * both endpoints and a per-type subtotal.
     * Engine.snapshotTrafficLoad() reads and resets them after each
     * training cycle, producing a per-cycle delta we can plot, summarize,
     * and use to set load-balancing goals.
     *
     * Initialized to 0; reset to 0 after each snapshot. msgsByType is a
     * null-prototype object to avoid hash-key collisions with method
     * names.
     */
    this.msgsSent = 0;
    this.msgsReceived = 0;
    this.msgsByType = Object.create(null);

    /**
     * S2 geographic cell ID (GEO_CELL_BITS wide).
     * Computed for every node regardless of protocol so that regional lookups
     * can route by geographic cell XOR even in plain Kademlia.
     */
    this.s2Cell = geoCellId(lat, lng, GEO_CELL_BITS);

    /**
     * Physical-transport connection budget.
     *
     * The real bottleneck for WebRTC-based P2P is the number of simultaneous
     * RTCPeerConnections a browser can hold (~50–100 before degrading,
     * Chromium hard-caps at 500). That budget is bilateral and symmetric:
     * a "connection" consumes one slot on each side regardless of which
     * party initiated it.
     *
     * `connections` is the set of peer IDs with a live physical link to me.
     * It's a superset of whatever routing structure (bucket / synaptome /
     * reverse-index) references a given peer — the transport must exist
     * before any routing table can use it.
     *
     * `tryConnect(other)` is the gate: both sides must have capacity,
     * otherwise the connection is refused. Routing code treats a refused
     * connection as "this peer is unavailable" and moves on to its next
     * candidate.
     */
    this.connections    = new Set();     // bigint peerIds with a live link
    this.maxConnections = Infinity;      // set by DHT.buildRoutingTables

    /**
     * Directional sub-caps on top of the bilateral total (Interpretation B,
     * v0.67.02). `_outboundConns` is the subset of `connections` that this
     * node initiated via tryConnect(). The complement (connections −
     * _outboundConns) is the inbound subset.
     *
     * - maxOutgoing : cap on how many connections THIS node may initiate
     * - maxIncoming : cap on how many connections THIS node may accept
     *
     * Both default to Infinity so the existing single-cap behavior is
     * preserved when these are not configured. Highway nodes also get
     * Infinity/Infinity so the "server backbone" semantics carry over.
     *
     * Models a P2P deployment where browser-class nodes voluntarily limit
     * outbound dial concurrency (CPU/bandwidth cost of NAT-traversal) but
     * keep more inbound headroom (reachability / pull from popular peers).
     */
    this._outboundConns = new Set();
    this.maxOutgoing    = Infinity;
    this.maxIncoming    = Infinity;

    /**
     * TWO POOLS (G7 of the two-pool packet, axona-docs ca52384; the kernel's
     * pool_profile.js is the source of the rules). `pools` is null (NOT
     * ARMED: the single bilateral cap plus the directional dial caps above,
     * byte-identical to 0.130.0) or a frozen {M, I, H}. Armed, every link
     * this node holds has a CLASS at this end — M for a link this node
     * selected (it initiated, or promoted), I for a link it accepted — and
     *   charged(M) ≤ M, charged(I) ≤ I, charged(M) + charged(I) ≤ H.
     * The simulator has no reservation window: tryConnect reserves and
     * allocates in one synchronous step, as the kernel's mesh does between
     * reserve() and _attachPc. A matrix from this engine may be called
     * "50+50" only when every node in it is armed (DHT.poolsArmed()).
     */
    this.pools = null;
    /** peerId → 'M' | 'I' (only while armed). */
    this._cls = new Map();
    this.poolCounters = { refusedM: 0, refusedI: 0, refusedH: 0, promoted: 0, promotionDeficit: 0, swapsM: 0 };

    // Injected by the DHT implementation
    this.routingTable = null;

    // Injected by the Network layer
    this._network = null;
  }

  /**
   * Attempt to establish a bilateral physical link to `other`.
   *
   * Returns true if the link was already present or was newly established
   * (both sides now have each other in their `connections` set).
   * Returns false if either side is at capacity AND neither can free a
   * slot via the swap policy.
   *
   * Under a bilateral cap, naïve first-come-first-served refusal blocks
   * every learning/growth mechanism: new routes, dead-peer replacement,
   * incoming promotion, pub/sub child recruitment, and annealing all
   * stop the moment caps saturate. To let the graph keep growing, we
   * let a full node evict its LEAST-VALUABLE existing peer in favour
   * of the incoming candidate — if and only if the candidate genuinely
   * improves structural coverage (fills an under-represented XOR stratum).
   *
   * The default value function (stratum coverage) is protocol-agnostic.
   * Subclasses can override `_chooseVictim` to incorporate richer signals
   * (LTP weight for N-DHT, bucket recency for Kademlia, etc.).
   *
   * @param {DHTNode} other
   */
  // ── G7: the two pools ──────────────────────────────────────────────

  /**
   * Arm the two pools on this node. Refuses (throws) an infeasible profile
   * the way the kernel's makePoolProfile does for the three pool rules; the
   * kernel's module carries the full table. Idempotent; null disarms.
   */
  setPools(p) {
    if (p == null) { this.pools = null; this._cls.clear(); return null; }
    const M = Number(p.M), I = Number(p.I), H = p.H == null ? M + I : Number(p.H);
    if (!Number.isInteger(M) || M < 1) throw new RangeError(`pools.M must be an integer ≥ 1, got ${p.M}`);
    if (!Number.isInteger(I) || I < 0) throw new RangeError(`pools.I must be an integer ≥ 0, got ${p.I}`);
    if (!Number.isInteger(H) || M + I > H) throw new RangeError(`pools.H (${p.H}) must be ≥ M + I = ${M + I}: no borrowing, no 101st allocation`);
    this.pools = Object.freeze({ M, I, H });
    // The pools bound the physical links; the legacy total cap must not read
    // smaller than H or the pools could never fill (one bound, one source).
    if (Number.isFinite(this.maxConnections) && this.maxConnections < H) this.maxConnections = H;
    return this.pools;
  }
  get poolsArmed() { return this.pools !== null; }
  /** The class this end holds `peerId` in: 'M' | 'I' | null (unarmed, or not a link). */
  classOf(peerId) { return this.pools ? (this._cls.get(peerId) ?? null) : null; }
  chargedOf(cls) { let n = 0; for (const c of this._cls.values()) if (c === cls) n++; return n; }
  /** Room in class `cls` at this end, and under H. */
  _poolRoom(cls) {
    if (!this.pools) return true;
    if (this.connections.size >= this.pools.H) { this.poolCounters.refusedH++; return false; }
    if (this.chargedOf(cls) >= this.pools[cls]) { if (cls === 'M') this.poolCounters.refusedM++; else this.poolCounters.refusedI++; return false; }
    return true;
  }
  /**
   * G6 in the simulator: PROMOTE an I link to M at this end — no second
   * link, the class moves. Needs M room or a lawful M-class swap victim
   * (the stratum rule, M victims only). Ends in promoted or deficit; the
   * link stays I on deficit.
   */
  promote(peerId) {
    if (!this.pools || this._cls.get(peerId) !== 'I') return false;
    if (this.chargedOf('M') >= this.pools.M) {
      const other = this._network?.nodes?.get(peerId);
      if (!other || !this._trySwapIn(other, { victimClass: 'M' })) { this.poolCounters.promotionDeficit++; return false; }
    }
    this._cls.set(peerId, 'M');
    this.poolCounters.promoted++;
    return true;
  }
  /** Snapshot for the harness and the fence. */
  poolStats() {
    return {
      armed: this.pools !== null,
      pools: this.pools,
      chargedM: this.chargedOf('M'), chargedI: this.chargedOf('I'),
      links: this.connections.size,
      ...this.poolCounters,
    };
  }

  tryConnect(other) {
    if (other === this) return false;
    if (this.connections.has(other.id)) {
      // G7: a link this end holds as INCOMING that this end now SELECTS is a
      // promotion (v1.1 §3), not a second link.
      if (this.pools && this._cls.get(other.id) === 'I') return this.promote(other.id);
      return true;
    }

    // G7: armed pools — the initiator reserves M, the acceptor reserves I;
    // both under H. A refusal at either end allocates nothing on either side
    // and never reclassifies to bypass a full pool. An unarmed end keeps the
    // legacy caps below for its own side.
    if (this.pools || other.pools) {
      const mineOk   = this.pools  ? this._poolRoomOrSwap(other) : true;
      const theirsOk = other.pools ? other._poolRoom('I') : true;
      if (!mineOk || !theirsOk) return false;
    }

    // Bilateral total cap (always enforced).
    const myFull    = this.connections.size  >= this.maxConnections;
    const theirFull = other.connections.size >= other.maxConnections;

    // Directional sub-caps (Interpretation B, v0.67.02). When both default
    // to Infinity these are no-ops and behavior is identical to the
    // single-cap model. When set, they enforce in/out balance per node.
    const myOutFull   = this._outboundConns.size                              >= this.maxOutgoing;
    const otherInSize = other.connections.size - other._outboundConns.size;
    const otherInFull = otherInSize                                            >= other.maxIncoming;

    // Fast path: every gate has room.
    if (!myFull && !theirFull && !myOutFull && !otherInFull) {
      this.connections.add(other.id);
      this._outboundConns.add(other.id);
      other.connections.add(this.id);
      this._classify(other);
      return true;
    }

    // Directional caps don't have a swap policy — once you've initiated 45
    // connections, you can't initiate a 46th regardless of how many you'd
    // evict (the cap is on dial concurrency, not on stored peers). Refuse
    // outright. The total-cap swap policy still kicks in below.
    if (myOutFull || otherInFull) return false;

    // My total full — attempt a value-based swap to free a slot.
    if (myFull && !this._trySwapIn(other)) return false;

    // Other total full — they run the same policy from their perspective.
    if (theirFull && !other._trySwapIn(this)) return false;

    this.connections.add(other.id);
    this._outboundConns.add(other.id);
    other.connections.add(this.id);
    this._classify(other);
    return true;
  }

  /** G7: after a link forms, each armed end records its class: M at the initiator, I at the acceptor. */
  _classify(other) {
    if (this.pools)  this._cls.set(other.id, 'M');
    if (other.pools) other._cls.set(this.id, 'I');
  }
  /** G7: M room at the initiator, or a lawful swap among M-class victims only. */
  _poolRoomOrSwap(other) {
    if (this.connections.size >= this.pools.H) { this.poolCounters.refusedH++; return false; }
    if (this.chargedOf('M') < this.pools.M) return true;
    // At M full the only lawful way in is a managed replacement: the stratum
    // rule over M victims (never an I link — ingress is not coverage).
    if (this._trySwapIn(other, { victimClass: 'M' })) { this.poolCounters.swapsM++; return true; }
    this.poolCounters.refusedM++;
    return false;
  }

  /**
   * Try to evict a less-valuable existing peer in favour of `candidate`.
   * Default policy: find the most over-represented XOR stratum (ignoring
   * `candidate`'s stratum); only swap if the candidate's stratum is
   * strictly less-represented. This is a conservative Pareto improvement
   * — we never swap if it would worsen stratum coverage.
   *
   * Returns true if a slot was freed (caller can then add `candidate`),
   * false if no swap improves coverage.
   *
   * @param {DHTNode} candidate
   */
  _trySwapIn(candidate, { victimClass = null } = {}) {
    const candidateStratum = Math.min(63, clz64(this.id ^ candidate.id));
    const counts = new Array(64).fill(0);
    // G7: with a victim class named, only links of that class count and may
    // be evicted (an M swap never evicts an I link).
    const eligible = (pid) => victimClass === null || this._cls.get(pid) === victimClass;
    for (const pid of this.connections) {
      if (!eligible(pid)) continue;
      const s = Math.min(63, clz64(this.id ^ pid));
      counts[s]++;
    }
    // Find the most over-represented stratum OTHER than the candidate's.
    let evictStratum = -1;
    let maxCount    = 0;
    for (let s = 0; s < 64; s++) {
      if (s === candidateStratum) continue;
      if (counts[s] > maxCount) { maxCount = counts[s]; evictStratum = s; }
    }
    // Only swap if the candidate fills a stratum with strictly fewer peers
    // than the evict-source. This is the "net structural improvement"
    // guard: it prevents thrashing (evicting and re-adding similar peers).
    if (maxCount <= counts[candidateStratum] + 1) return false;

    const victimId = this._chooseVictim(evictStratum, victimClass);
    if (victimId == null) return false;

    // Free the slot on both sides. The victim's routing-table entry (if
    // any) becomes stale; future traffic through the victim will simply
    // find no live path and trigger protocol-specific cleanup (e.g.
    // dead-peer eviction in N-DHT).
    this.connections.delete(victimId);
    this._outboundConns.delete(victimId);  // safe even if victim was inbound
    this._cls.delete(victimId);
    const victimNode = this._network?.nodes?.get(victimId);
    if (victimNode) {
      victimNode.connections.delete(this.id);
      victimNode._outboundConns.delete(this.id);
      victimNode._cls.delete(this.id);
    }
    return true;
  }

  /**
   * Choose a specific peer to evict from a given stratum.
   *
   * Base implementation: first peer found in the target stratum. Subclasses
   * can override to prefer low-LTP-weight peers (N-DHT) or
   * least-recently-used peers (Kademlia bucket tail).
   *
   * @param {number} stratum
   * @returns {bigint|null} peerId to evict, or null if no peer is in this stratum
   */
  _chooseVictim(stratum, victimClass = null) {
    for (const pid of this.connections) {
      if (victimClass !== null && this._cls.get(pid) !== victimClass) continue;   // G7
      const s = Math.min(63, clz64(this.id ^ pid));
      if (s === stratum) return pid;
    }
    return null;
  }

  /**
   * Tear down the physical link to `other` (both sides).
   * Called when a routing table drops the peer and no other structure
   * still wants it; also called automatically during dead-peer eviction.
   */
  disconnect(other) {
    if (!other) return;
    this.connections.delete(other.id);
    this._outboundConns?.delete(other.id);    // safe — only fires if outbound
    this._cls?.delete(other.id);              // G7: the class leaves with the link
    other.connections?.delete(this.id);
    other._outboundConns?.delete(this.id);    // safe — only fires if outbound
    other._cls?.delete(this.id);
  }

  /**
   * Handle an incoming message.  Implemented by subclasses (e.g. KademliaNode).
   * @param {{ type: string, from: number, data: any }} msg
   * @returns {any}
   */
  handleMessage(msg) {
    throw new Error(`${this.constructor.name}.handleMessage() not implemented`);
  }

  /**
   * Send a message to another node via the network layer.
   * Returns { response, latency } where latency is in ms.
   * In simulation this is synchronous + instant; latency is computed, not waited.
   *
   * @param {number}  targetId
   * @param {string}  type
   * @param {any}     data
   */
  async send(targetId, type, data) {
    if (!this._network) throw new Error('Node not connected to a network');
    return this._network.send(this, targetId, type, data);
  }

  toJSON() {
    return { id: this.id, lat: this.lat, lng: this.lng, alive: this.alive };
  }
}
