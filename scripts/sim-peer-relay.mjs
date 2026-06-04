// =====================================================================
// sim-peer-relay.mjs — dht-sim validation for PEER-RELAYED SIGNALING
//   (bridgeless connection; design: axona-docs/implementation/
//    Peer-Relayed-Signaling-v0.1.md, §8 Validation plan).
//
// QUESTION: with the bridge OFF, can a node form a new direct edge to an
// arbitrary peer by relaying signaling THROUGH existing peers — and does the
// mesh stay connected and routable under churn and scale?
//
// WHAT THIS MODELS (the connectivity/topology layer — the thing the bridge
// SPOF lives in):
//   · Each node has a SYNAPTOME = the set of established direct CHANNELS
//     (a channel ⇒ "I can send to this peer directly"). Capacity K.
//   · BOOTSTRAP: a bridge node everyone first connects to; it hands a joining
//     node a peer-list (its K-closest), from which the node forms its initial
//     channels — modelling the WebRTC mesh formed via bridge signaling at join.
//   · DISCOVERY: nodes learn of more peers from their neighbours (gossip /
//     triadic introduction) and form channels to their K-closest — densifying
//     the graph toward a Kademlia-ish structure, the steady state.
//   · NEW-EDGE SIGNALING (under test): to connect A→C with no direct channel,
//     A GREEDY-ROUTES a `mesh:signal` over the channel graph toward C (XOR
//     metric, the relay path). If it reaches C, the A↔C channel forms.
//     Bridge-on fallback: if no peer path, relay via the bridge (1 hop).
//
// WHAT THIS DOES NOT MODEL (validated elsewhere, on purpose):
//   · Real WebRTC / ICE / NAT / DTLS negotiation → headless real-WebRTC harness.
//   · touch/kill/pub semantics, security of relaying (reasoned in the note's
//     threat model: relay can drop/observe-metadata, never MITM).
//
// Greedy XOR routing over the channel graph is the proxy for AP-best routing;
// the connectivity claim depends on graph structure, not the exact metric.
//
// Run: node scripts/sim-peer-relay.mjs [N] [K] [seed]
// =====================================================================

const argN    = parseInt(process.argv[2] || '3000', 10);
const argK    = parseInt(process.argv[3] || '20', 10);
const argSeed = parseInt(process.argv[4] || '1', 10);

// ── deterministic PRNG (reproducible runs) ───────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 64-bit ids + XOR distance ────────────────────────────────────────
function randId(rng) {
  // 64-bit id as BigInt (sufficient for XOR-distance ordering).
  const hi = BigInt(Math.floor(rng() * 0x100000000)) & 0xFFFFFFFFn;
  const lo = BigInt(Math.floor(rng() * 0x100000000)) & 0xFFFFFFFFn;
  return (hi << 32n) | lo;
}
const xor = (a, b) => a ^ b;
// leading-zero count over 64 bits = Axona "stratum" (higher ⇒ closer in XOR).
function clz64(x) { return x === 0n ? 64 : 64 - x.toString(2).length; }
function closerByXor(target) {
  return (a, b) => {
    const da = xor(a, target), db = xor(b, target);
    return da < db ? -1 : da > db ? 1 : 0;
  };
}

// ── model ─────────────────────────────────────────────────────────────
class Node {
  constructor(id) {
    this.id = id;
    this.channels = new Set();   // peerId(BigInt) → established direct link
    this.known    = new Set();   // peerId(BigInt) we're aware of (for discovery)
    this.alive    = true;
  }
}

function buildNetwork(N, K, rng) {
  const nodes = new Map();                 // id → Node
  const ids   = [];
  while (nodes.size < N) {
    const id = randId(rng);
    if (nodes.has(id)) continue;
    nodes.set(id, new Node(id)); ids.push(id);
  }
  // Bridge: a distinguished always-reachable node everyone first meets.
  const bridgeId = randId(rng);
  const bridge   = new Node(bridgeId);
  nodes.set(bridgeId, bridge);
  bridge.isBridge = true;

  const link = (a, b) => {
    if (a === b) return;
    nodes.get(a)?.channels.add(b);
    nodes.get(b)?.channels.add(a);
  };

  // Stratified channel formation: for each XOR-distance stratum (bucket), keep
  // up to BUCKET channels to the closest candidates known at that scale — the
  // Kademlia-k-bucket / Axona-stratum structure that yields the long-range
  // links (one per distance scale) greedy routing needs.
  const formStratified = (id, candidates, BUCKET, MAXDEG) => {
    const me = nodes.get(id);
    const byStratum = new Map();
    for (const p of candidates) {
      if (p === id || p === bridgeId) continue;
      const s = clz64(xor(id, p));
      if (!byStratum.has(s)) byStratum.set(s, []);
      byStratum.get(s).push(p);
    }
    for (const [, peers] of byStratum) {
      peers.sort(closerByXor(id));
      for (const p of peers.slice(0, BUCKET)) {
        if (me.channels.size >= MAXDEG || nodes.get(p).channels.size >= MAXDEG) continue;
        link(id, p); me.known.add(p); nodes.get(p).known.add(id);
      }
    }
  };

  const BUCKET = 2, MAXDEG = 6 * K;
  // BOOTSTRAP: every node connects to the bridge; the bridge knows everyone and
  // seeds the joiner with a STRATIFIED contact set spanning the whole keyspace
  // (the compressed equivalent of lookups filling buckets), not just its
  // nearest neighbours. This is what gives a node long-range links from join.
  for (const id of ids) { link(id, bridgeId); bridge.known.add(id); nodes.get(id).known.add(bridgeId); }
  for (const id of ids) formStratified(id, bridge.known, BUCKET, MAXDEG);

  // DISCOVERY: gossip rounds — learn neighbours-of-neighbours, then form a
  // STRATIFIED synaptome: for each XOR-distance stratum (bucket), keep up to
  // BUCKET channels to the closest peers known at that scale. This is the
  // Kademlia-k-bucket / Axona-stratum structure — it gives the long-range
  // links (one per distance scale) that make greedy routing converge, instead
  // of a purely nearest-neighbour graph that fragments.
  // DISCOVERY: gossip rounds — learn neighbours-of-neighbours (spreads
  // knowledge across the keyspace via the long-range seeds), then re-fill
  // stratum buckets from the grown known-set.
  const ROUNDS = 5;
  for (let r = 0; r < ROUNDS; r++) {
    for (const id of ids) {
      const me = nodes.get(id);
      for (const nb of [...me.channels]) {
        if (nb === bridgeId) continue;
        for (const nn of nodes.get(nb).channels) if (nn !== id) me.known.add(nn);
      }
    }
    for (const id of ids) formStratified(id, nodes.get(id).known, BUCKET, MAXDEG);
  }
  return { nodes, ids, bridgeId };
}

// ── greedy relay-route a signal A→target over the channel graph ───────
// Returns { ok, hops }.  bridge usable only if `bridgeUp`.  Excludes dead
// nodes.  Models "form a new edge by relaying signaling through peers".
function relaySignal(nodes, A, target, { bridgeUp, bridgeId, maxHops = 40 }) {
  const me = nodes.get(A);
  if (!me || !me.alive) return { ok: false, hops: 0 };
  // Bridge fallback: if A still holds the bridge channel and bridge is up,
  // the bridge can introduce any node it knows (1 relay hop).
  const usable = (nbId) => {
    const n = nodes.get(nbId);
    if (!n || !n.alive) return false;
    if (nbId === bridgeId && !bridgeUp) return false;
    return true;
  };
  let cur = A, hops = 0, prevDist = xor(A, target);
  const seen = new Set([A]);
  while (hops < maxHops) {
    const meCur = nodes.get(cur);
    // Direct delivery: a channel to the target exists.
    if (meCur.channels.has(target) && nodes.get(target)?.alive) return { ok: true, hops: hops + 1 };
    // Bridge shortcut: if cur holds the (live) bridge and the bridge knows the
    // target, the bridge relays the signal to it.
    if (bridgeUp && meCur.channels.has(bridgeId) &&
        nodes.get(bridgeId).known.has(target) && nodes.get(target)?.alive) {
      return { ok: true, hops: hops + 2 };
    }
    // Greedy next hop: live channel-neighbour closest to target, must progress.
    let best = null, bestDist = prevDist;
    for (const nb of meCur.channels) {
      if (!usable(nb) || seen.has(nb)) continue;
      const d = xor(nb, target);
      if (d < bestDist) { bestDist = d; best = nb; }
    }
    if (best === null) return { ok: false, hops };   // stuck (local minimum)
    seen.add(best); cur = best; prevDist = bestDist; hops++;
  }
  return { ok: false, hops };
}

// ── connectivity: largest component over live channel graph ───────────
function largestComponentFrac(nodes, ids, { bridgeUp, bridgeId }) {
  const live = ids.filter(id => nodes.get(id).alive);
  if (live.length === 0) return 0;
  const seen = new Set();
  let best = 0;
  for (const start of live) {
    if (seen.has(start)) continue;
    let size = 0; const stack = [start]; seen.add(start);
    while (stack.length) {
      const id = stack.pop(); size++;
      for (const nb of nodes.get(id).channels) {
        if (nb === bridgeId && !bridgeUp) continue;
        if (!nodes.get(nb)?.alive || seen.has(nb)) continue;
        seen.add(nb); stack.push(nb);
      }
    }
    if (size > best) best = size;
  }
  return best / live.length;
}

// ── sampling helpers ──────────────────────────────────────────────────
function sampleEdgeFormation(nodes, ids, opts, rng, trials = 2000) {
  const live = ids.filter(id => nodes.get(id).alive);
  let ok = 0; const hops = [];
  for (let i = 0; i < trials; i++) {
    const A = live[Math.floor(rng() * live.length)];
    let C = live[Math.floor(rng() * live.length)];
    if (A === C || nodes.get(A).channels.has(C)) continue;   // want a NEW edge
    const r = relaySignal(nodes, A, C, opts);
    if (r.ok) { ok++; hops.push(r.hops); }
  }
  hops.sort((a, b) => a - b);
  const n = hops.length;
  return {
    attempts: trials, success: ok,
    rate: ok / trials,
    meanHops: n ? (hops.reduce((s, h) => s + h, 0) / n) : 0,
    p50: n ? hops[Math.floor(n * 0.5)] : 0,
    p95: n ? hops[Math.floor(n * 0.95)] : 0,
    maxHops: n ? hops[n - 1] : 0,
  };
}

function pct(x) { return (100 * x).toFixed(1) + '%'; }

// ── run ────────────────────────────────────────────────────────────────
function run(N, K, seed) {
  const rng = mulberry32(seed);
  console.log(`\n=== Peer-relayed signaling — N=${N} K=${K} seed=${seed} ===`);
  const { nodes, ids, bridgeId } = buildNetwork(N, K, rng);
  const avgDeg = ids.reduce((s, id) => s + nodes.get(id).channels.size, 0) / ids.length;
  console.log(`built: ${ids.length} nodes + 1 bridge; avg channels/node = ${avgDeg.toFixed(1)}`);

  // 1. Baseline (bridge ON) vs. bridge OFF — new-edge formation.
  const on  = sampleEdgeFormation(nodes, ids, { bridgeUp: true,  bridgeId }, mulberry32(seed + 1));
  const off = sampleEdgeFormation(nodes, ids, { bridgeUp: false, bridgeId }, mulberry32(seed + 1));
  console.log('\n[1] New-edge formation success');
  console.log(`  bridge ON : ${pct(on.rate)}  (mean ${on.meanHops.toFixed(1)} hops, p95 ${on.p95})`);
  console.log(`  bridge OFF: ${pct(off.rate)}  (mean ${off.meanHops.toFixed(1)} hops, p95 ${off.p95})  ← peer-relay only`);

  // 2. Connectivity with the bridge removed.
  const compOff = largestComponentFrac(nodes, ids, { bridgeUp: false, bridgeId });
  console.log('\n[2] Connectivity (bridge OFF)');
  console.log(`  largest component = ${pct(compOff)} of live nodes`);

  // 3. Bootstrap boundary: a fresh node with exactly j peer channels (bridge
  //    OFF) — can it relay-signal to arbitrary targets?
  console.log('\n[3] Bootstrap boundary (bridge OFF): success vs. # peer channels held');
  for (const j of [0, 1, 2, 3, 5]) {
    // synthesize a fresh node F that knows j of its would-be K-closest peers.
    const fid = randId(rng);
    const F = new Node(fid); nodes.set(fid, F);
    const near = ids.slice().sort(closerByXor(fid)).slice(0, Math.max(j, 1));
    for (let k = 0; k < j; k++) { F.channels.add(near[k]); nodes.get(near[k]).channels.add(fid); }
    let ok = 0, tr = 400;
    const liveTargets = ids;
    for (let i = 0; i < tr; i++) {
      const C = liveTargets[Math.floor(rng() * liveTargets.length)];
      if (C === fid || F.channels.has(C)) continue;
      if (relaySignal(nodes, fid, C, { bridgeUp: false, bridgeId }).ok) ok++;
    }
    console.log(`  ${j} peer channel(s): ${pct(ok / tr)} reachable`);
    // cleanup
    for (const p of F.channels) nodes.get(p)?.channels.delete(fid);
    nodes.delete(fid);
  }

  // 4. Churn: kill R% of nodes, bridge OFF, re-measure.
  console.log('\n[4] Churn (bridge OFF): kill R% of relays, re-measure');
  for (const R of [0.1, 0.25, 0.5]) {
    // snapshot alive, kill a fresh random R% each iteration (reset first)
    for (const id of ids) nodes.get(id).alive = true;
    const shuffled = ids.slice();
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(mulberry32(seed + 100 + Math.floor(R * 100))() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const kill = Math.floor(ids.length * R);
    for (let i = 0; i < kill; i++) nodes.get(shuffled[i]).alive = false;
    const churn = sampleEdgeFormation(nodes, ids, { bridgeUp: false, bridgeId }, mulberry32(seed + 7));
    const comp  = largestComponentFrac(nodes, ids, { bridgeUp: false, bridgeId });
    console.log(`  ${pct(R)} dead: edge success ${pct(churn.rate)} (p95 ${churn.p95} hops), largest component ${pct(comp)}`);
  }
  for (const id of ids) nodes.get(id).alive = true;
  return { on, off, compOff };
}

// scale sweep
const SIZES = process.argv[2] ? [argN] : [1000, 3000, 10000];
for (const N of SIZES) run(N, argK, argSeed);
