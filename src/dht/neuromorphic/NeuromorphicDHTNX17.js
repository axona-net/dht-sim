// =====================================================================
// NeuromorphicDHTNX17 — Transport-conformant variant for the
// production protocol set (NH-1, NX-17, K-DHT, G-DHT).
//
// ── Status (v0.71.0 / refactor commit 16) ────────────────────────────
//
// NX-17 is now a **subclass of NH-1**.  Every method NH-1 exposes ---
// the DHT contract API (start / stop / lookup / publish / subscribe /
// unsubscribe / getNodeId / getSynaptome / getMetrics / onEvent), the
// simulator-side multi-node surface (addNode / removeNode /
// buildRoutingTables / bootstrapJoin / dispose), and the pub/sub
// primitives AxonManager consumes (routeMessage / sendDirect /
// findKClosest / _pickRecruitPeer / _pickRelayPeer) --- is inherited
// verbatim.  NX-17 makes no changes to the Transport contract surface
// either: it uses exactly the same 12 methods on the underlying
// `node.transport` that NH-1 uses, with exactly the same message-type
// vocabulary.
//
// The two protocols are interface-identical, both directions.  A peer
// running NX-17 and a peer running NH-1 can theoretically interoperate
// on the same wire because the per-hop request shapes
// (`lookup_step`, `lookahead_probe`, etc.) and pub/sub envelopes
// (`route_msg`, `direct_pubsub:*`) are unchanged.
//
// ── How NX-17 differs from NH-1 ──────────────────────────────────────
//
// NX-17 is parametrically tuned toward **wider exploration** rather
// than NH-1's tighter exploitation:
//
//   • Larger MAX_SYNAPTOME (60 vs 50)
//     A wider routing table holds more long-haul candidates, which
//     reduces hops on global lookups at the cost of more anneal
//     traffic during warmup.
//
//   • Higher LOOKAHEAD_ALPHA (7 vs 5)
//     Two-hop AP scoring probes more first-hop candidates in
//     parallel, raising the chance the best 2-hop path is in the
//     probe set.  Pays the extra wire cost in production.
//
//   • Slower ANNEAL_COOLING (0.99985 vs 0.9997)
//     Temperature decays ~2× more slowly, keeping per-node
//     exploration probability higher for longer.  Helps reach
//     better routing-table configurations under non-stationary
//     traffic.
//
//   • Higher ANNEAL_LOCAL_SAMPLE (75 vs 50)
//     Each anneal call examines more 2-hop candidates.  Trades
//     bandwidth for diversity in the replacement candidate.
//
// These four knobs are the production-level expression of NX-17's
// historical "more rules and more parameters" design ethos.  The
// in-simulator NX-6 → NX-10 → NX-15 → NX-17 lineage retained more
// elaborate mechanisms (two-tier highway, stratified eviction,
// adaptive decay gamma) that produced similar effects via different
// machinery; those are recoverable as further NX-17-only overrides
// if a future ablation shows them carrying meaningful additional
// signal beyond parameter tuning.
//
// Earlier NX-17 inherited from NeuromorphicDHTNX15 → NX10 → NX6 and
// thus carried that lineage's god's-eye `nodeMap.get(peerId)` reads
// inside its routing primitives (see
// `documents/red team/protocol-layer-godseye-audit.md`).  Those reads
// are now gone, by construction: this NX-17 inherits NH-1's
// Transport-conformant body without modification.  The benchmark
// numbers it produces are production-faithful in the same sense NH-1's
// are.
//
// ── Backward compatibility ───────────────────────────────────────────
//
// The two configuration fields the previous NX-17 advertised ---
// `usesPublisherPrefix = true` and `_membershipOpts.rootSetSize = 0`
// --- are inherited automatically: NH-1 already sets both to those
// values, as documented in NH-1's constructor and at lines 131 / 158
// of AxonaEngine.js.  Existing call sites in Engine.js and
// main.js that read `dht.usesPublisherPrefix` or pass through the
// rootSetSize=0 routed mode are unchanged.
// =====================================================================

import { AxonaEngine } from './AxonaEngine.js';

export class NeuromorphicDHTNX17 extends AxonaEngine {
  static get protocolName() { return 'Neuromorphic-NX17'; }

  /**
   * @param {Object} config — same shape as NH-1's config; NX-17 applies
   *   its tuning overrides on top of NH-1's defaults.  Caller-supplied
   *   `config.rules` entries still take precedence (so sweep-driven
   *   ablations override NX-17's character).
   */
  constructor(config = {}) {
    // Merge NX-17's parametric character into config.rules, then defer
    // to NH-1 for the rest.  Caller-supplied rule overrides win against
    // NX-17 defaults, just as NH-1's own defaults yield to caller rules.
    const callerRules = config.rules ?? {};
    const nx17Rules = {
      maxSynaptome:      callerRules.maxSynaptome      ?? 60,
      lookaheadAlpha:    callerRules.lookaheadAlpha    ?? 7,
      annealCooling:     callerRules.annealCooling     ?? 0.99985,
      annealLocalSample: callerRules.annealLocalSample ?? 75,
      // All other parameters inherit NH-1's defaults.
      ...callerRules,
    };
    super({ ...config, rules: nx17Rules });
  }
}
