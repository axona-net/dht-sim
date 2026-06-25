// =====================================================================
// relay-churn-experiment.mjs — does the routing-only single-root survive
// CHURN, with and without stable relays? Drives the REAL shipped kernel
// (AxonaPeer pub/sub) over the kernel SimNetwork so the root election +
// re-convergence we measure is exactly what production runs.
//
// THE QUESTION (David, 2026-06-25): the live testnet is stable at near-zero
// churn even though peers are mostly web apps — so a stable open tab is a fine
// root. But mobile will far outstrip relays, and most users can't host relays.
// Can the emergent single root survive HIGH churn with NO stable relays, or is
// today's stability relay-propped? This isolates the variable: relay-poor vs
// relay-backed, across churn rates.
//
// MODEL (per round): publish one signed probe → measure delivery across the
// live subscribers → then CHURN: drop a fraction of the live subscriber peers
// (transport.stop() → died-handlers fire, peers route around) and join the same
// number of fresh peers (seed XOR synapses, open channels, subscribe). Relays
// (if any) are always-on keyspace hosts (peer.host()) and never churn — the
// stable anchor. The always-on measurement publisher never churns (so injection
// itself isn't the variable; it does not keyspace-host).
//
// We read role.isRoot DIRECTLY off every live peer (sim → exact, no ephemeral-id
// problem) and classify the root as relay / publisher / churning-peer / NONE.
//
//   node harness/relay-churn-experiment.mjs                 # default matrix
//   ROUNDS=12 N=36 SUBS=28 node harness/relay-churn-experiment.mjs
//   MATRIX='0:0.0,0:0.2,3:0.2,0:0.4,3:0.4' node harness/...   # relays:churnFrac
// =====================================================================
import {
  AxonaPeer, AxonaDomain, NeuronNode, Synapse, SimNetwork, simTransport,
  createNodeIdentity, createAuthorIdentity, deriveTopicId, clz264, KERNEL_VERSION,
} from '@axona/protocol';
import { buildXorRoutingTable } from '@axona/protocol/utils/geo.js';

const N        = +(process.env.N || 36);     // churning subscriber population (steady-state size)
const SUBS     = +(process.env.SUBS || N);   // how many of them subscribe (default: all)
const K        = +(process.env.K || 12);     // routing-table / k-closest
const ROUNDS   = +(process.env.ROUNDS || 12);
const REFRESH  = +(process.env.REFRESH || 1200);   // manager refresh (re-subscribe + heal) cadence
const SETTLE   = +(process.env.SETTLE || 3500);    // initial convergence window
const ROUND_SETTLE = +(process.env.ROUND_SETTLE || 3200);  // post-churn re-convergence window (≈2–3 refresh cycles)
const DELIVER  = +(process.env.DELIVER || 1500);   // wait after a publish before measuring
const LAT = 38.0, LNG = -77.0;                      // us-east cluster (region 0x89)
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// matrix entries are "relays:churnFrac"
const MATRIX = (process.env.MATRIX ||
  '0:0.0,0:0.15,0:0.30,3:0.30,0:0.50,3:0.50')
  .split(',').map(s => { const [r, c] = s.split(':'); return { relays: +r, churn: +c }; });

console.log(`relay-churn-experiment  kernel v${KERNEL_VERSION}  N=${N} SUBS=${SUBS} K=${K} rounds=${ROUNDS} refresh=${REFRESH}ms`);
console.log(`matrix (relays:churnFrac/round): ${MATRIX.map(m => `${m.relays}:${m.churn}`).join('  ')}\n`);

let SEQ = 0;   // global id-diversifier so fresh peers vary deterministically across the run

// Build one kernel peer in the shared network. role: 'relay'|'pub'|'sub'.
async function makePeer(network, domain, role) {
  const identity = await createNodeIdentity({ lat: LAT, lng: LNG });
  const transport = simTransport({ network, identity, heartbeatMs: 0 });
  await transport.start(identity.id);
  const node = new NeuronNode({ id: BigInt('0x' + identity.id), lat: LAT, lng: LNG });
  node.transport = transport;
  const peer = new AxonaPeer({ domain, node, nodeIdentity: identity, transport });
  await peer.start();
  const am = peer._requireAxonaManager?.('exp-init');
  if (am) am.refreshIntervalMs = REFRESH;
  return { peer, node, hex: identity.id, big: node.id, role, am, author: null };
}

// Seed `p` a navigable XOR routing table over `liveNodes` (and reverse edges so
// it's reachable), then open the underlying sim channels.
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
    // reverse edge so existing nodes can route TO the newcomer
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

// The root(s) for the topic across all CURRENTLY-LIVE nodes.
function rootsOf(live, topicBig) {
  const rs = [];
  for (const p of live) {
    const role = p.peer._axonaManager?.axonRoles?.get(topicBig);
    if (role && (role.isRoot || role.isInRootSet)) rs.push(p);
  }
  return rs;
}

async function runCondition({ relays: R, churn }) {
  const network = new SimNetwork();
  const domain  = new AxonaDomain({ k: K });
  const byBig   = new Map();
  const add = (p) => byBig.set(p.big, p);

  // 1. Always-on infra: R relays (keyspace hosts) + 1 measurement publisher.
  const relays = [];
  for (let i = 0; i < R; i++) { const p = await makePeer(network, domain, 'relay'); relays.push(p); add(p); }
  const pub = await makePeer(network, domain, 'pub'); add(pub);
  pub.author = await createAuthorIdentity();

  // 2. Churning subscriber population.
  let subs = [];
  for (let i = 0; i < N; i++) { const p = await makePeer(network, domain, 'sub'); subs.push(p); add(p); }

  // 3. Wire the full mesh + open channels.
  const all = [...relays, pub, ...subs];
  for (const p of all) await wireInto(p, all, byBig);
  await wait(150);

  const topic = { region: 'useast', name: 'churn-probe' };
  const topicHex = await deriveTopicId(topic); const topicBig = BigInt('0x' + topicHex);

  // 4. Relays host the keyspace (the always-on anchor); arm refresh on all.
  for (const r of relays) { try { await r.peer.host(); } catch { /* */ } }
  for (const p of all) p.am?.start?.();

  // 5. Subscribe SUBS of the churning peers.
  const recv = new Map();
  const subscribe = async (p) => {
    if (!recv.has(p.hex)) recv.set(p.hex, new Set());
    await p.peer.sub(topic, (env) => { if (env?.msgId) recv.get(p.hex).add(String(env.msgId)); });
  };
  const subSet = subs.slice(0, SUBS);
  for (const p of subSet) { await subscribe(p); await wait(3); }
  await wait(SETTLE);

  // 6. Rounds: publish → measure → churn.
  const rows = [];
  const seenRoots = new Set();
  let prevRootHex = null, dipRoundsTotal = 0, pendingRecover = 0, recoverSamples = [];
  for (let round = 0; round < ROUNDS; round++) {
    const id = String(await pub.peer.pub(topic, `r${round}`, { signWith: pub.author }));
    await wait(DELIVER);
    const liveSubs = subSet.filter(s => byBig.has(s.big));
    const delivered = liveSubs.filter(s => recv.get(s.hex)?.has(id)).length;
    const pct = liveSubs.length ? (100 * delivered / liveSubs.length) : 0;

    const live = [...byBig.values()];
    const rs = rootsOf(live, topicBig);
    const primary = rs[0];
    const rootClass = !primary ? 'NONE'
      : primary.role === 'relay' ? 'relay'
      : primary.role === 'pub'   ? 'publisher'
      : 'churn-peer';
    const rootHex = primary?.hex ?? null;
    const changed = rootHex !== prevRootHex;
    if (rootHex) seenRoots.add(rootHex);

    // re-convergence accounting: a "dip" = delivery <90%; count rounds until recovery
    if (pct < 90) { dipRoundsTotal++; pendingRecover++; }
    else if (pendingRecover > 0) { recoverSamples.push(pendingRecover); pendingRecover = 0; }

    rows.push({ round, live: liveSubs.length, pct: pct.toFixed(0), nRoots: rs.length, rootClass, changed });
    prevRootHex = rootHex;

    // CHURN: drop `churn` fraction of live subscribers, join the same number fresh.
    if (churn > 0 && round < ROUNDS - 1) {
      const liveNow = subs.filter(s => byBig.has(s.big));
      const nKill = Math.max(1, Math.round(liveNow.length * churn));
      const victims = [...liveNow].sort(() => Math.random() - 0.5).slice(0, nKill);
      for (const v of victims) {
        try { await v.peer._transport.stop?.(); } catch { /* */ }
        byBig.delete(v.big);
        subs = subs.filter(s => s.big !== v.big);
        const i = subSet.indexOf(v); if (i >= 0) subSet.splice(i, 1);
      }
      // join fresh replacements
      for (let j = 0; j < nKill; j++) {
        SEQ++;
        const np = await makePeer(network, domain, 'sub');
        add(np); subs.push(np);
        await wireInto(np, [...byBig.values()], byBig);
        np.am?.start?.();
        subSet.push(np);
        await subscribe(np);
      }
    }
    await wait(ROUND_SETTLE);
  }
  if (pendingRecover > 0) recoverSamples.push(pendingRecover);

  // summary
  const pcts = rows.map(r => +r.pct);
  const mean = (pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(0);
  const min  = Math.min(...pcts);
  const rootChanges = rows.filter(r => r.changed).length - 1;   // first row's "change" is just initial
  const avgRecover = recoverSamples.length ? (recoverSamples.reduce((a, b) => a + b, 0) / recoverSamples.length).toFixed(1) : '0';
  const rootMix = rows.reduce((m, r) => (m[r.rootClass] = (m[r.rootClass] || 0) + 1, m), {});

  return { R, churn, rows, mean, min, distinctRoots: seenRoots.size, rootChanges: Math.max(0, rootChanges), dipRoundsTotal, avgRecover, rootMix };
}

// ── run the matrix ──
const results = [];
for (const cond of MATRIX) {
  process.stdout.write(`\n### relays=${cond.relays}  churn=${(cond.churn*100).toFixed(0)}%/round ###\n`);
  const r = await runCondition(cond);
  results.push(r);
  console.log(`  per-round delivery%: [${r.rows.map(x => x.pct).join(' ')}]`);
  console.log(`  per-round root:      [${r.rows.map(x => x.rootClass[0]).join(' ')}]  (r=relay p=publisher c=churn-peer N=none)`);
  console.log(`  mean=${r.mean}%  min=${r.min}%  distinct-roots=${r.distinctRoots}  root-changes=${r.rootChanges}  dip-rounds=${r.dipRoundsTotal}  avg-recover=${r.avgRecover} rounds  rootmix=${JSON.stringify(r.rootMix)}`);
}

console.log('\n================= SUMMARY =================');
console.log('relays  churn   mean%  min%  distinctRoots  rootChanges  dipRounds  avgRecover  rootClassMix');
for (const r of results) {
  console.log(
    `${String(r.R).padEnd(6)}  ${(String((r.churn*100).toFixed(0))+'%').padEnd(6)}  ${String(r.mean).padEnd(5)}  ${String(r.min).padEnd(4)}  ` +
    `${String(r.distinctRoots).padEnd(13)}  ${String(r.rootChanges).padEnd(11)}  ${String(r.dipRoundsTotal).padEnd(9)}  ${String(r.avgRecover).padEnd(10)}  ${JSON.stringify(r.rootMix)}`);
}
console.log('\nReads: relay-poor (relays=0) at rising churn vs relay-backed (relays=3). Distinct-roots/root-changes = how much the single root thrashes; dipRounds/avgRecover = delivery cost + re-convergence latency of a root loss.');
process.exit(0);
