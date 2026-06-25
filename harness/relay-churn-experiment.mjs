// =====================================================================
// relay-churn-experiment.mjs — does the routing-only single-root survive
// CHURN, and does STABILITY-WEIGHTED root election remove the dependence on
// stable relays? Drives the REAL shipped kernel (AxonaPeer pub/sub) over the
// kernel SimNetwork so root election + re-convergence are exactly production.
//
// QUESTION (David, 2026-06-25): live testnet is stable at near-zero churn even
// though peers are mostly web apps — a long-lived tab is a fine root. But mobile
// outstrips relays and most users can't host them. Can the emergent single root
// survive churn with NO stable relays — and if we ELECT the root by stability
// (expected residual uptime) instead of pure XOR-closeness, does it hold up?
//
// MODES (env MODES=comma list; default baseline):
//   baseline — stock kernel: root = emergent XOR-closest terminus.
//   closest  — override every peer's _rootHint_ to the plain XOR-closest LIVE
//              node (control: isolates the value of HINTING from STABILITY).
//   stable   — override _rootHint_ to the MOST-STABLE (oldest) node within the
//              topic's K-closest band (STABLE_ELIGIBLE roles only). This is the
//              stability-weighted root-election prototype. Uses a GLOBAL age
//              oracle (perfect stability knowledge) → measures the UPPER BOUND;
//              real deployment must AGREE on stability (gossip/observe) + the
//              K-closest band (lookup). Honest caveat, not a shippable mechanism.
//
// CHURN_MODEL (env): uniform (default) | lindy. lindy = older nodes are LESS
//   likely to churn (heavy-tailed sessions). Stability only predicts retention
//   under lindy; under uniform the oldest node dies as fast as any, so the stable
//   election shows no benefit BY CONSTRUCTION. Compare modes under the SAME model.
//
//   MODES=baseline,closest,stable CHURN_MODEL=lindy MATRIX=0:0.30 \
//     ROUNDS=12 N=36 node harness/relay-churn-experiment.mjs
// =====================================================================
import {
  AxonaPeer, AxonaDomain, NeuronNode, Synapse, SimNetwork, simTransport,
  createNodeIdentity, createAuthorIdentity, deriveTopicId, clz264, KERNEL_VERSION,
} from '@axona/protocol';
import { buildXorRoutingTable } from '@axona/protocol/utils/geo.js';

const N        = +(process.env.N || 36);
const SUBS     = +(process.env.SUBS || N);
const K        = +(process.env.K || 12);
const ROUNDS   = +(process.env.ROUNDS || 12);
const REFRESH  = +(process.env.REFRESH || 1200);
const SETTLE   = +(process.env.SETTLE || 3500);
const ROUND_SETTLE = +(process.env.ROUND_SETTLE || 3200);
const DELIVER  = +(process.env.DELIVER || 1500);
// A subscriber younger than CONVERGE_MS at publish time hasn't had time to attach
// → a miss is "join-related" (recoverable by replay-on-join). Older = "root/mesh".
const CONVERGE_MS = +(process.env.CONVERGE_MS || 2600);
const LAT = 38.0, LNG = -77.0;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const lc = (h) => String(h).toLowerCase().replace(/^0x/, '');

const MODES = (process.env.MODES || 'baseline').split(',').map(s => s.trim()).filter(Boolean);
const CHURN_MODEL = process.env.CHURN_MODEL || 'uniform';   // uniform | lindy
// roles eligible to be elected the stable root. default 'subs' = the hard,
// relay-poor, no-immortal-infra case (R* must be a churning peer, just the
// longest-lived one). 'all' lets the immortal publisher/relays win (upper bound).
const STABLE_ELIGIBLE = new Set((process.env.STABLE_ELIGIBLE || 'subs').split(',').map(s => s.trim()));

const MATRIX = (process.env.MATRIX || '0:0.30')
  .split(',').map(s => { const [r, c] = s.split(':'); return { relays: +r, churn: +c }; });

console.log(`relay-churn-experiment  kernel v${KERNEL_VERSION}  N=${N} SUBS=${SUBS} K=${K} rounds=${ROUNDS} refresh=${REFRESH}ms`);
console.log(`modes=[${MODES.join(',')}]  churn-model=${CHURN_MODEL}  stable-eligible={${[...STABLE_ELIGIBLE].join(',')}}  matrix=${MATRIX.map(m=>`${m.relays}:${m.churn}`).join(' ')}\n`);

let SEQ = 0;

async function makePeer(network, domain, role) {
  const identity = await createNodeIdentity({ lat: LAT, lng: LNG });
  const transport = simTransport({ network, identity, heartbeatMs: 0 });
  await transport.start(identity.id);
  const node = new NeuronNode({ id: BigInt('0x' + identity.id), lat: LAT, lng: LNG });
  node.transport = transport;
  const peer = new AxonaPeer({ domain, node, nodeIdentity: identity, transport });
  await peer.start();
  const am = peer._requireAxonaManager?.('exp-init');
  // RENEW = the re-subscribe gate (renewMs). It IS the orphan window: a subscriber
  // re-homes after a root change only when it renews. Default 60s in prod. Lowering
  // it is the real churn fix (the v0.1 §21 "event-driven via beacon" idea can't reach
  // the tree — sub-axons/leaves have random ids, outside the topic's beacon basin).
  if (am) { am.refreshIntervalMs = REFRESH; am.renewMs = +(process.env.RENEW || 60000); }
  return { peer, node, hex: identity.id, big: node.id, role, am, author: null, bornAt: Date.now() };
}

async function wireInto(p, liveNodes, byBig) {
  const sorted = liveNodes.map(x => x.node).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cands = buildXorRoutingTable(p.node.id, sorted, K, Infinity);
  for (const cand of cands) {
    if (cand.id === p.node.id) continue;
    if (!p.node.synaptome.has(cand.id)) {
      const syn = new Synapse({ peerId: cand.id, latencyMs: 1, stratum: clz264(p.node.id ^ cand.id) });
      syn.weight = 0.5; syn.inertia = 0; syn._addedBy = 'exp';
      p.node.synaptome.set(cand.id, syn);
    }
    const other = byBig.get(cand.id);
    if (other && !other.node.synaptome.has(p.node.id)) {
      const rsyn = new Synapse({ peerId: p.node.id, latencyMs: 1, stratum: clz264(other.node.id ^ p.node.id) });
      rsyn.weight = 0.5; rsyn.inertia = 0; rsyn._addedBy = 'exp';
      other.node.synaptome.set(p.node.id, rsyn);
    }
  }
  for (const peerBig of p.node.synaptome.keys()) {
    const t = byBig.get(peerBig);
    if (t) { try { await p.peer._transport.openConnection(t.hex); } catch { /* */ } }
  }
}

// Ongoing routing-table maintenance — the harness analog of the kernel's peer
// learning (gossip / find_closest / dead-peer eviction). Without this, nodes wired
// once at join accumulate stale synapses as the mesh churns and tenured nodes lose
// their route to the root — a HARNESS artifact, not a protocol property. Prune dead
// synapses on every live node, then re-wire toward the current live K-closest.
// (Optimistic: instant perfect re-learning → an upper bound on maintenance quality.)
const MAINTAIN = (process.env.MAINTAIN ?? '1') !== '0';
async function maintainMesh(byBig) {
  if (!MAINTAIN) return;
  const live = [...byBig.values()];
  for (const p of live) {
    for (const peerBig of [...p.node.synaptome.keys()]) if (!byBig.has(peerBig)) p.node.synaptome.delete(peerBig);
  }
  for (const p of live) await wireInto(p, live, byBig);
}

function rootsOf(live, topicBig) {
  const rs = [];
  for (const p of live) {
    const role = p.peer._axonaManager?.axonRoles?.get(topicBig);
    if (role && (role.isRoot || role.isInRootSet)) rs.push(p);
  }
  return rs;
}

// Stability-weighted (or closest) root choice over the live set. GLOBAL oracle.
function chooseRoot(live, topicBig, mode) {
  const byClose = [...live].sort((a, b) => { const da = a.big ^ topicBig, db = b.big ^ topicBig; return da < db ? -1 : da > db ? 1 : 0; });
  if (mode === 'closest') return byClose[0] || null;
  // stable: among the K XOR-closest ELIGIBLE nodes, the oldest (min bornAt).
  const elig = byClose.filter(p => STABLE_ELIGIBLE.has(p.role));
  const band = (elig.length ? elig : byClose).slice(0, K);
  band.sort((a, b) => a.bornAt - b.bornAt);
  return band[0] || null;
}
// Inject the oracle's choice: every live peer routes pub/sub via R* (single,
// consistent → no split root). Constant per topic (one topic in this experiment).
function applyHint(live, rootBig) {
  const hex = rootBig == null ? null : lc(rootBig.toString(16).padStart(66, '0'));
  for (const p of live) if (p.am) p.am._rootHint_ = () => hex;
}

// Lindy victim selection: weight ∝ 1/age so younger churns more (older persists).
function pickVictims(liveSubs, nKill, model) {
  if (model !== 'lindy') return [...liveSubs].sort(() => Math.random() - 0.5).slice(0, nKill);
  const now = Date.now();
  const pool = liveSubs.map(p => ({ p, w: 1 / ((now - p.bornAt) / 1000 + 1) }));
  const picked = [];
  for (let k = 0; k < nKill && pool.length; k++) {
    const total = pool.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * total, i = 0;
    for (; i < pool.length; i++) { r -= pool[i].w; if (r <= 0) break; }
    i = Math.min(i, pool.length - 1);
    picked.push(pool[i].p); pool.splice(i, 1);
  }
  return picked;
}

async function runCondition(mode, R, churn) {
  const network = new SimNetwork();
  const domain  = new AxonaDomain({ k: K });
  const byBig   = new Map();
  const add = (p) => byBig.set(p.big, p);

  const relays = [];
  for (let i = 0; i < R; i++) { const p = await makePeer(network, domain, 'relay'); relays.push(p); add(p); }
  const pub = await makePeer(network, domain, 'pub'); add(pub);
  pub.author = await createAuthorIdentity();
  let subs = [];
  for (let i = 0; i < N; i++) { const p = await makePeer(network, domain, 'sub'); subs.push(p); add(p); }

  const all = [...relays, pub, ...subs];
  for (const p of all) await wireInto(p, all, byBig);
  await wait(150);

  const topic = { region: 'useast', name: 'churn-probe' };
  const topicHex = await deriveTopicId(topic); const topicBig = BigInt('0x' + topicHex);

  for (const r of relays) { try { await r.peer.host(); } catch { /* */ } }
  for (const p of all) p.am?.start?.();

  const recv = new Map();
  const subAt = new Map();   // hex -> when this peer (re)subscribed
  const subscribe = async (p) => { if (!recv.has(p.hex)) recv.set(p.hex, new Set()); subAt.set(p.hex, Date.now()); await p.peer.sub(topic, (env) => { if (env?.msgId) recv.get(p.hex).add(String(env.msgId)); }); };
  // re-seat: re-issue the subscribe (re-home at the CURRENT root) WITHOUT resetting
  // tenure — simulates fast event-driven re-home. REHOME=1 re-seats all live subs each
  // round; this sizes the "keep subscribers seated" fix against the orphaning loss.
  const REHOME = process.env.REHOME === '1';
  const reseat = async (p) => { try { await p.peer.sub(topic, (env) => { if (env?.msgId) recv.get(p.hex)?.add(String(env.msgId)); }); } catch { /* */ } };
  const subSet = subs.slice(0, SUBS);
  for (const p of subSet) { await subscribe(p); await wait(3); }

  // election: choose R* and inject the hint everywhere. For 'stablehost', R* also
  // host()s the topic so it HOLDS a role → a hint to it 'handle's (becomes root)
  // instead of rerolling to the XOR-closest (the v0.1 §7 Phase-0 failure). This is
  // the faithful mechanism prototype using EXISTING kernel primitives (host+hint).
  let prevHostBig = null;
  const reElect = async () => {
    if (mode === 'baseline' || mode === 'protect') return null;
    const live = [...byBig.values()];
    const r = chooseRoot(live, topicBig, mode);
    if (mode === 'stablehost' && r) {
      if (prevHostBig && prevHostBig !== r.big) { const prev = byBig.get(prevHostBig); try { await prev?.peer.unhost(topic); } catch { /* */ } }
      try { await r.peer.host(topic); } catch { /* */ }
      prevHostBig = r.big;
    }
    applyHint(live, r?.big ?? null);
    return r;
  };
  await reElect();
  await wait(SETTLE);

  const rows = [];
  const seenRoots = new Set();
  let prevRootHex = null;
  // miss classification accumulators
  let missJoin = 0, missRoot = 0, recvN = 0, recvTenSum = 0, missTenSum = 0, missN = 0, noRootRounds = 0;
  let missSeated = 0, missOrphan = 0;   // seated-but-missed (routing) vs not-seated (orphaned)
  for (let round = 0; round < ROUNDS; round++) {
    const id = String(await pub.peer.pub(topic, `r${round}`, { signWith: pub.author }));
    const tPub = Date.now();
    await wait(DELIVER);
    const liveSubs = subSet.filter(s => byBig.has(s.big));
    const delivered = liveSubs.filter(s => recv.get(s.hex)?.has(id)).length;
    const pct = liveSubs.length ? (100 * delivered / liveSubs.length) : 0;

    const live = [...byBig.values()];
    const rs = rootsOf(live, topicBig);
    const primary = rs[0];
    const rootClass = !primary ? 'NONE' : primary.role === 'relay' ? 'relay' : primary.role === 'pub' ? 'publisher' : 'churn-peer';
    const rootHex = primary?.hex ?? null;
    if (rootHex) seenRoots.add(rootHex);
    rows.push({ round, live: liveSubs.length, pct: pct.toFixed(0), nRoots: rs.length, rootClass, changed: rootHex !== prevRootHex });
    prevRootHex = rootHex;

    // classify each live subscriber's outcome by tenure at publish time.
    if (rs.length === 0) noRootRounds++;
    // DIRECT cause probe: is the subscriber actually SEATED in the primary root's
    // subscriber set right now? not-seated = orphaned (root changed / never re-homed);
    // seated-but-missed = a routing/delivery failure despite being a known subscriber.
    const primaryRole = primary?.peer._axonaManager?.axonRoles?.get(topicBig) || null;
    const seatedOf = (s) => !!primaryRole?.subscribers?.has(s.hex.toLowerCase());
    for (const s of liveSubs) {
      const tenure = tPub - (subAt.get(s.hex) ?? tPub);
      const got = recv.get(s.hex)?.has(id);
      if (got) { recvN++; recvTenSum += tenure; }
      else {
        missN++; missTenSum += tenure;
        if (tenure < CONVERGE_MS) missJoin++; else missRoot++;
        if (seatedOf(s)) missSeated++; else missOrphan++;   // the definitive split
      }
    }

    if (churn > 0 && round < ROUNDS - 1) {
      let liveNow = subs.filter(s => byBig.has(s.big));
      // 'protect' mode: faithfully isolate the VALUE of a stable root — exempt the
      // naturally-elected (XOR-closest) root from churn, i.e. "the root happens to
      // be a durable node." Real routing still decides the root; we just don't kill
      // it. Quantifies how much loss is root-thrash vs subscriber churn-in.
      if (mode === 'protect') {
        const rootBigs = new Set(rs.map(p => p.big));
        liveNow = liveNow.filter(s => !rootBigs.has(s.big));
      }
      const nKill = Math.max(1, Math.round(liveNow.length * churn));
      const victims = pickVictims(liveNow, nKill, CHURN_MODEL);
      for (const v of victims) {
        try { await v.peer._transport.stop?.(); } catch { /* */ }
        byBig.delete(v.big); subs = subs.filter(s => s.big !== v.big);
        const i = subSet.indexOf(v); if (i >= 0) subSet.splice(i, 1);
      }
      for (let j = 0; j < nKill; j++) {
        SEQ++;
        const np = await makePeer(network, domain, 'sub');
        add(np); subs.push(np);
        await wireInto(np, [...byBig.values()], byBig);
        np.am?.start?.();
        subSet.push(np); await subscribe(np);
      }
      await maintainMesh(byBig);   // keep existing nodes' routing tables fresh (kernel peer-learning analog)
      await reElect();   // re-elect R* over the new live set + re-host/re-hint
      // THE FIX UNDER TEST: re-seat every live subscriber at the current root each
      // round (fast event-driven re-home), so root changes / renewal lapses don't
      // orphan tenured subscribers. Sizes the "keep subscribers seated" win.
      if (REHOME) for (const s of subSet.filter(x => byBig.has(x.big))) await reseat(s);
    }
    await wait(ROUND_SETTLE);
  }

  const pcts = rows.map(r => +r.pct);
  const mean = (pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(0);
  const min  = Math.min(...pcts);
  const rootChanges = Math.max(0, rows.filter(r => r.changed).length - 1);
  const rootMix = rows.reduce((m, r) => (m[r.rootClass] = (m[r.rootClass] || 0) + 1, m), {});
  return { mode, R, churn, rows, mean, min, distinctRoots: seenRoots.size, rootChanges, rootMix,
           missJoin, missRoot, missN, recvN, recvTenSum, missTenSum, noRootRounds, missSeated, missOrphan };
}

const REPS = +(process.env.REPS || 1);
const avg = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd  = (a) => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(avg(a.map(x => (x - m) ** 2))); };
const agg = [];
for (const mode of MODES) for (const cond of MATRIX) {
  process.stdout.write(`\n### mode=${mode}  relays=${cond.relays}  churn=${(cond.churn*100).toFixed(0)}%/round (${CHURN_MODEL})  reps=${REPS} ###\n`);
  const means = [], mins = [], rchanges = [];
  let mJoin = 0, mRoot = 0, mTotal = 0, rTenSum = 0, rN = 0, mTenSum = 0, noRoot = 0, roundsTot = 0, mSeated = 0, mOrphan = 0;
  for (let rep = 0; rep < REPS; rep++) {
    const r = await runCondition(mode, cond.relays, cond.churn);
    means.push(+r.mean); mins.push(+r.min); rchanges.push(r.rootChanges);
    mJoin += r.missJoin; mRoot += r.missRoot; mTotal += r.missN; mSeated += r.missSeated; mOrphan += r.missOrphan;
    rTenSum += r.recvTenSum; rN += r.recvN; mTenSum += r.missTenSum; noRoot += r.noRootRounds; roundsTot += r.rows.length;
    console.log(`  rep ${rep}: mean=${r.mean}% root-changes=${r.rootChanges}  miss seated/orphan=${r.missSeated}/${r.missOrphan}`);
  }
  const joinShare = mTotal ? (100 * mJoin / mTotal) : 0;
  agg.push({ mode, R: cond.relays, churn: cond.churn, means, mins, rchanges,
             joinShare, mJoin, mRoot, mTotal,
             recvTen: rN ? rTenSum / rN : 0, missTen: mTotal ? mTenSum / mTotal : 0,
             noRootPct: roundsTot ? 100 * noRoot / roundsTot : 0 });
  const orphanShare = mTotal ? (100 * mOrphan / mTotal) : 0;
  console.log(`  → delivery ${avg(means).toFixed(0)}%±${sd(means).toFixed(0)}  root-changes ${avg(rchanges).toFixed(1)}  | misses ${mTotal}: ORPHANED(not-seated-at-root) ${orphanShare.toFixed(0)}% / seated-but-missed ${(100-orphanShare).toFixed(0)}%`);
  console.log(`     tenure recv/miss(ms): ${(rN ? rTenSum/rN : 0).toFixed(0)} / ${(mTotal ? mTenSum/mTotal : 0).toFixed(0)}`);
  agg[agg.length-1].orphanShare = orphanShare;
}

console.log('\n================= SUMMARY (mean ± sd over reps) =================');
console.log('mode       churn  delivery%     root-chg   miss-split (join/root)   tenure recv/miss(ms)');
for (const a of agg) {
  console.log(`${a.mode.padEnd(10)} ${(String((a.churn*100).toFixed(0))+'%').padEnd(6)} ${(avg(a.means).toFixed(0)+'±'+sd(a.means).toFixed(0)).padEnd(12)}  ${avg(a.rchanges).toFixed(1).padEnd(8)}   ${(a.joinShare.toFixed(0)+'% / '+(100-a.joinShare).toFixed(0)+'%').padEnd(22)}   ${a.recvTen.toFixed(0)} / ${a.missTen.toFixed(0)}`);
}
console.log(`\nMiss classification (CONVERGE_MS=${CONVERGE_MS}): join-related = the missing subscriber was younger than convergence at publish (recoverable by replay-on-join); root-related = tenured subscriber still missed. If join-share is high AND missed-tenure ≪ received-tenure, subscriber churn-in is the dominant loss and replay-on-join is the lever.`);
process.exit(0);
