// =====================================================================
// sim-peer-relay-kernel.mjs — REAL-KERNEL validation for PEER-RELAYED
//   SIGNALING (bridgeless connection; design: axona-docs/implementation/
//   Peer-Relayed-Signaling-v0.1.md, §8a "Next sim refinement: re-run over
//   the real kernel routing (AP-best, vitality) rather than the greedy-XOR
//   proxy").
//
// HOW THIS DIFFERS FROM sim-peer-relay.mjs (the proxy):
//   · The proxy built a synthetic stratified channel graph and routed a
//     signal with a hand-written greedy-XOR walk.  It validated TOPOLOGY.
//   · THIS builds N real kernel `AxonaPeer`s (`@axona/protocol`) over the
//     kernel's own `SimNetwork` + `simTransport`, bootstraps their
//     synaptomes with the production XOR k-bucket fill (buildXorRoutingTable
//     via TransportAxonaEngine), and routes the signal with the kernel's
//     ACTUAL `route_msg` forwarder — greedy next-hop + 2-hop terminal
//     lookahead (_findCloserInTwoHops), the same code a deployed peer runs.
//
// THE MECHANISM UNDER TEST (faithful to the design note §3.1):
//   A new edge A→C is bootstrapped by relaying a `mesh:signal` THROUGH the
//   mesh: A calls `peer.routeMessage(C, 'mesh:signal', …)`; the kernel
//   forwards it hop-by-hop over established channels until the terminal
//   node C consumes it.  Success ⇒ the signaling conduit exists ⇒ the A↔C
//   WebRTC channel could be negotiated without the bridge.
//
//   There is NO bridge in the kernel routing layer — `route_msg` IS the
//   peer-relay path.  So this run measures exactly the proxy's "bridge OFF"
//   column, but over real routing rather than the XOR proxy.  If the kernel
//   matches (or beats, via 2-hop lookahead escaping local minima) the
//   proxy's ~98–99.8 %, the GREEN verdict upgrades from "topology supports
//   it" to "the shipping router actually delivers it".
//
// WHAT THIS STILL DOES NOT MODEL (validated elsewhere, on purpose):
//   · Real WebRTC / ICE / NAT / DTLS negotiation → headless real-WebRTC harness.
//   · The `sendSignal` peer-first/bridge-fallback sink + capability flag
//     (that's the kernel implementation step this validates the basis for).
//
// Run: node scripts/sim-peer-relay-kernel.mjs [N] [K] [seed]
//      node scripts/sim-peer-relay-kernel.mjs           # sweep 200/500/1000/3000
// =====================================================================

import { TransportAxonaEngine } from '../src/dht/neuromorphic/TransportAxonaEngine.js';

const argN    = process.argv[2] ? parseInt(process.argv[2], 10) : null;
const argK    = parseInt(process.argv[3] || '20', 10);
const argSeed = parseInt(process.argv[4] || '1', 10);

// ── deterministic PRNG (reproducible sampling) ───────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pct(x) { return (100 * x).toFixed(1) + '%'; }
function statHops(hops) {
  if (!hops.length) return { mean: 0, p50: 0, p95: 0, max: 0 };
  const s = hops.slice().sort((a, b) => a - b);
  return {
    mean: s.reduce((a, h) => a + h, 0) / s.length,
    p50:  s[Math.floor(s.length * 0.5)],
    p95:  s[Math.floor(s.length * 0.95)],
    max:  s[s.length - 1],
  };
}

// Per-peer synaptome cap.  Production MAX_SYNAPTOME = 50; with the bootstrap
// cap left at Infinity the XOR k-bucket fill seats ~130 synapses at N=1000,
// which inflates connectivity and makes routing trivially 2-hop.  Capping to
// the real ceiling makes this a faithful test of whether the SHIPPING peer's
// table is rich enough to relay signaling.
const SYNAPTOME_CAP = 50;

// ── build N real kernel peers + bootstrap their synaptomes ───────────
async function buildKernelMesh(N, K) {
  const eng = new TransportAxonaEngine({ k: K, geoBits: 8 });
  // Spread peers over the globe so geo-prefixed nodeIds + haversine
  // latency stay correlated (the production addressing shape).
  for (let i = 0; i < N; i++) {
    const lat = -60 + (i * 7.3) % 120;          // deterministic spread
    const lng = -180 + (i * 13.7) % 360;
    await eng.addNode(lat, lng);
  }
  // Production XOR k-bucket bootstrap (capped to the real synaptome ceiling)
  // + open every synapse channel.
  await eng.buildRoutingTables({ bidirectional: true, maxConnections: SYNAPTOME_CAP });

  // Register the mesh:signal terminal handler on every peer.  A node
  // CONSUMES (returns the literal 'consumed' — the only value the kernel
  // route_msg path treats as a hit) iff IT is the routed target; any
  // intermediate returns null → the kernel forwards to its next hop.
  for (const [id, peer] of eng._peers) {
    peer.onRoutedMessage('mesh:signal', async (_payload, meta) => {
      return (meta.targetId === id) ? 'consumed' : null;
    });
  }
  return eng;
}

// ── sample: form a NEW edge A→C by routing mesh:signal over the mesh ──
async function sampleEdgeFormation(eng, rng, trials) {
  const ids  = [...eng.nodeMap.keys()].filter(id => eng.nodeMap.get(id).alive);
  let ok = 0, attempts = 0;
  const hops = [];
  for (let i = 0; i < trials; i++) {
    const A = ids[Math.floor(rng() * ids.length)];
    const C = ids[Math.floor(rng() * ids.length)];
    if (A === C) continue;
    const nodeA = eng.nodeMap.get(A);
    if (nodeA.synaptome.has(C)) continue;   // want a NEW edge (no direct synapse)
    attempts++;
    const peer = eng._peers.get(A);
    let r;
    try { r = await peer.routeMessage(C, 'mesh:signal', { ts: i }); }
    catch { r = { consumed: false }; }
    if (r && r.consumed) { ok++; hops.push(r.hops); }
  }
  const h = statHops(hops);
  return { attempts, success: ok, rate: attempts ? ok / attempts : 0, ...h };
}

// ── cross-check: kernel lookup found-rate (same routing, different sink)
async function sampleLookupFound(eng, rng, trials) {
  const ids = [...eng.nodeMap.keys()].filter(id => eng.nodeMap.get(id).alive);
  let ok = 0, attempts = 0;
  const hops = [];
  for (let i = 0; i < trials; i++) {
    const A = ids[Math.floor(rng() * ids.length)];
    const C = ids[Math.floor(rng() * ids.length)];
    if (A === C) continue;
    if (eng.nodeMap.get(A).synaptome.has(C)) continue;
    attempts++;
    let r;
    try { r = await eng._peers.get(A).lookup(C); }
    catch { r = { found: false }; }
    if (r && r.found) { ok++; hops.push(r.hops); }
  }
  const h = statHops(hops);
  return { attempts, success: ok, rate: attempts ? ok / attempts : 0, ...h };
}

// ── connectivity: largest component over the live channel/synapse graph
function largestComponentFrac(eng) {
  const live = [...eng.nodeMap.keys()].filter(id => eng.nodeMap.get(id).alive);
  if (!live.length) return 0;
  const liveSet = new Set(live);
  const seen = new Set();
  let best = 0;
  for (const start of live) {
    if (seen.has(start)) continue;
    let size = 0; const stack = [start]; seen.add(start);
    while (stack.length) {
      const id = stack.pop(); size++;
      const node = eng.nodeMap.get(id);
      for (const peerId of node.synaptome.keys()) {
        if (!liveSet.has(peerId) || seen.has(peerId)) continue;
        seen.add(peerId); stack.push(peerId);
      }
    }
    if (size > best) best = size;
  }
  return best / live.length;
}

// ── run one network size ──────────────────────────────────────────────
async function run(N, K, seed) {
  console.log(`\n=== REAL-KERNEL peer-relayed signaling — N=${N} K=${K} seed=${seed} ===`);
  const t0 = Date.now();
  const eng = await buildKernelMesh(N, K);
  const avgSyn = [...eng.nodeMap.values()]
    .reduce((s, n) => s + n.synaptome.size, 0) / eng.nodeMap.size;
  console.log(`built: ${eng.nodeMap.size} kernel peers; avg synaptome = ${avgSyn.toFixed(1)} (${Date.now() - t0} ms)`);

  const TRIALS = Math.min(2000, Math.max(400, N * 2));

  // [1] New-edge formation via real route_msg (the mesh:signal mechanism)
  const edge = await sampleEdgeFormation(eng, mulberry32(seed + 1), TRIALS);
  console.log('\n[1] New-edge formation — kernel route_msg (mesh:signal)');
  console.log(`  delivered: ${pct(edge.rate)}  (${edge.success}/${edge.attempts}; mean ${edge.mean.toFixed(1)} hops, p50 ${edge.p50}, p95 ${edge.p95}, max ${edge.max})`);

  // [2] Cross-check: kernel lookup found-rate (same router, lookup sink)
  const look = await sampleLookupFound(eng, mulberry32(seed + 1), TRIALS);
  console.log('\n[2] Cross-check — kernel lookup() found-rate (same routing)');
  console.log(`  found: ${pct(look.rate)}  (mean ${look.mean.toFixed(1)} hops, p95 ${look.p95})`);

  // [3] Connectivity over the synapse graph
  const comp = largestComponentFrac(eng);
  console.log('\n[3] Connectivity (synapse graph)');
  console.log(`  largest component = ${pct(comp)} of live peers`);

  // [4] Churn: kill R% of peers + postChurnHeal, re-measure delivery.
  // removeNode is destructive, so rebuild a FRESH mesh per R — each R is an
  // INDEPENDENT "kill R% at once" event, not a cumulative one.
  console.log('\n[4] Churn: kill R% of relays + postChurnHeal, re-measure mesh:signal');
  for (const R of [0.1, 0.25, 0.5]) {
    const engC = await buildKernelMesh(N, K);
    const allIds = [...engC.nodeMap.keys()];
    const rngK = mulberry32(seed + 100 + Math.floor(R * 100));
    const shuffled = allIds.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rngK() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const killN = Math.floor(allIds.length * R);
    for (let i = 0; i < killN; i++) await engC.removeNode(shuffled[i]);
    try { await engC.postChurnHeal(); } catch (e) { /* heal is best-effort */ }

    const churnTrials = Math.min(1000, TRIALS);
    const churn = await sampleEdgeFormation(engC, mulberry32(seed + 7), churnTrials);
    // Same churn, but route via lookup()'s alpha-parallel iterative search
    // instead of single-path route_msg — quantifies whether sendSignal should
    // ride route_msg or the iterative machinery under heavy churn.
    const churnLk = await sampleLookupFound(engC, mulberry32(seed + 7), churnTrials);
    const compC = largestComponentFrac(engC);
    console.log(`  ${pct(R)} dead: route_msg ${pct(churn.rate)} (p95 ${churn.p95}) · lookup ${pct(churnLk.rate)} (p95 ${churnLk.p95}) · component ${pct(compC)}`);
  }

  return { N, edge, look, comp };
}

// ── scale sweep ────────────────────────────────────────────────────────
const SIZES = argN ? [argN] : [200, 500, 1000, 3000];
const summary = [];
for (const N of SIZES) summary.push(await run(N, argK, argSeed));

console.log('\n========================  SUMMARY  ========================');
console.log('N     | mesh:signal delivered | mean/p95 hops | lookup found | connectivity');
for (const s of summary) {
  console.log(
    `${String(s.N).padEnd(5)} | ${pct(s.edge.rate).padStart(20)} | ` +
    `${s.edge.mean.toFixed(1)}/${s.edge.p95}`.padStart(13) + ' | ' +
    `${pct(s.look.rate)}`.padStart(12) + ' | ' + pct(s.comp).padStart(12)
  );
}
console.log('===========================================================');
