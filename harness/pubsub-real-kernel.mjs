// =====================================================================
// pubsub-real-kernel.mjs — drive the REAL shipped kernel AxonaPeer pub/sub
// at scale over the kernel SimNetwork, and measure the actual axon tree.
//
// Why this exists: the dht-sim "axona" engine uses 64-bit ids + a partial
// routing port, and its pub/sub membership test runs with pickRelayPeer ON —
// neither matches what production ships. This harness builds peers exactly the
// way axona-peer/axona-relay do — `new AxonaPeer({ domain, node, nodeIdentity,
// transport })`, NO axonaManager, NO pickRelayPeer — so the fan-out we measure
// is the one real users get. It imports the kernel SOURCE directly (not a
// vendored snapshot) so it always tests the shipped peer.
//
//   node harness/pubsub-real-kernel.mjs           # production config (default)
//   N=300 SUBS=200 PICK_RELAY=1 node harness/pubsub-real-kernel.mjs
//
// Env: N (nodes), SUBS (subscribers), K (routing-table size / k-closest),
//      REGION (lat,lng cluster), PICK_RELAY=1 (wire batch-adoption to compare).
// =====================================================================

// Imports the kernel via the `@axona/protocol` package link (file:../axona-protocol
// in package.json) — i.e. the SAME shipped kernel dht-sim's Node side already uses,
// so this test always exercises the current peer, never a stale vendored snapshot.
import {
  AxonaPeer, AxonaDomain, NeuronNode, Synapse, SimNetwork, simTransport,
  createNodeIdentity, createAuthorIdentity, deriveTopicId, clz264, KERNEL_VERSION,
} from '@axona/protocol';
import { buildXorRoutingTable } from '@axona/protocol/utils/geo.js';

const N        = +(process.env.N || 120);
const SUBS     = +(process.env.SUBS || 80);
const K        = +(process.env.K || 20);
const PICK_RELAY = process.env.PICK_RELAY === '1';
const LAT = +(process.env.LAT || 38.0), LNG = +(process.env.LNG || -77.0);   // us-east cluster
const SYN_CAP = +(process.env.SYN_CAP || 0);     // cap synaptome size (0=uncapped); bounded ≈ production
const SETTLE = +(process.env.SETTLE || 1500);   // ms after subscribes, before publish
const DELIVER = +(process.env.DELIVER || 2000);  // ms after publish, before measuring
const wait = (ms) => new Promise(r => setTimeout(r, ms));

console.log(`[harness] N=${N} SUBS=${SUBS} K=${K} pickRelay=${PICK_RELAY}  (kernel @axona/protocol v${KERNEL_VERSION})`);

// ── 1. Build N peers exactly as production does ──────────────────────
const network = new SimNetwork();
const domain  = new AxonaDomain({ k: K });
const peers = [];   // { peer, node, hex, big, author }

for (let i = 0; i < N; i++) {
  const identity = await createNodeIdentity({ lat: LAT, lng: LNG });
  const transport = simTransport({ network, identity, heartbeatMs: 0 });
  await transport.start(identity.id);
  const node = new NeuronNode({ id: BigInt('0x' + identity.id), lat: LAT, lng: LNG });
  node.transport = transport;
  // PRODUCTION CONFIG: no axonaManager, no pickRelayPeer — default manager.
  const peer = new AxonaPeer({ domain, node, nodeIdentity: identity, transport });
  await peer.start();
  // The manager is built LAZILY on first pub/sub (constructor leaves it null).
  // Force it now so our config/arming/instrumentation below actually binds to
  // the SAME instance peer.sub will use — otherwise the `if (am)` guard no-ops.
  peer._requireAxonaManager?.('harness-init');
  peers.push({ peer, node, hex: identity.id, big: node.id, author: null });
}
const byBig = new Map(peers.map(p => [p.big, p]));

// Optional: wire the batch-adoption optimization to compare against prod default.
if (PICK_RELAY) {
  for (const p of peers) {
    const am = p.peer._axonaManager;
    if (am) am.pickRelayPeer = (role, sub, fwd) => p.peer._pickRelayPeer(role, sub, fwd);
  }
}

// ── 2. Seed a navigable XOR routing mesh (same recipe as the engine) ──
const sortedNodes = peers.map(p => p.node).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
let edges = 0;
for (const p of peers) {
  const cands = buildXorRoutingTable(p.node.id, sortedNodes, K, SYN_CAP || Infinity);
  for (const cand of cands) {
    if (cand.id === p.node.id || p.node.synaptome.has(cand.id)) continue;
    const syn = new Synapse({ peerId: cand.id, latencyMs: 1, stratum: clz264(p.node.id ^ cand.id) });
    syn.weight = 0.5; syn.inertia = 0; syn._addedBy = 'harness';
    p.node.synaptome.set(cand.id, syn);
    edges++;
  }
}
// Open the underlying sim channels for every synapse edge so sendDirect works.
let openFail = 0, openOk = 0;
for (const p of peers) {
  for (const peerBig of p.node.synaptome.keys()) {
    const target = byBig.get(peerBig);
    if (target) { try { await p.peer._transport.openConnection(target.hex); openOk++; } catch { openFail++; } }
  }
}
console.log(`[mesh] openConnection ok=${openOk} fail=${openFail}`);
await wait(200);
const synSizes = peers.map(p => p.node.synaptome.size).sort((a,b)=>a-b);
console.log(`[mesh] ${edges} synapse edges seeded; synaptome size min/med/max = ${synSizes[0]}/${synSizes[synSizes.length>>1]}/${synSizes[synSizes.length-1]}`);

// PRODUCTION PARITY: production arms the manager's refresh loop at sub time
// (axona-peer client.js:1250 `peer._axonaManager?.start?.()`). refreshTick
// re-issues subscribe-k to the CURRENT K roots and drives root-to-root
// anti-entropy + kill re-gossip — i.e. the convergence the architecture's
// "overlap is 4-or-5-of-5" robustness claim depends on. Without it we'd be
// measuring cold single-shot delivery, which is NOT steady state. Accelerate
// the 10s default so convergence completes in seconds for the harness.
const REFRESH = +(process.env.REFRESH || 1500);
const MAXDIRECT = +(process.env.MAXDIRECT || 0);   // >0 ⇒ raise cap (disable recruitment → pure star)
const TRACE = process.env.TRACE === '1';
// enrollment trace counters, keyed by subscriber nodeId hex (lowercased)
const tx = { sent: new Map(), sentTo: new Map(), recv: new Map(), seated: new Map(), psCall: new Map(), psErr: new Map(), psMsg: new Map() };
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const norm = (h) => String(h).toLowerCase().replace(/^0x/, '');
for (const p of peers) {
  const am = p.peer._axonaManager;
  if (am) {
    if (MAXDIRECT) am.maxDirectSubs = MAXDIRECT;
    am.refreshIntervalMs = REFRESH;
    if (TRACE) {
      // SEND side: this peer (as subscriber) emits subscribe-k to a root.
      const origSend = am.dht.sendDirect.bind(am.dht);
      am.dht.sendDirect = async (peerId, type, payload) => {
        if (type === 'pubsub:subscribe-k' && payload?.subscriberId) {
          const k = norm(payload.subscriberId);
          bump(tx.sent, k);
          if (!tx.sentTo.has(k)) tx.sentTo.set(k, new Set());
          tx.sentTo.get(k).add(norm(peerId));
        }
        return origSend(peerId, type, payload);
      };
      // ORIGINATION side: does peer.sub's (un-awaited) pubsubSubscribe even run / throw?
      const origPS = am.pubsubSubscribe.bind(am);
      am.pubsubSubscribe = (...a) => {
        bump(tx.psCall, norm(p.hex));
        try {
          const r = origPS(...a);
          if (r && typeof r.catch === 'function') r.catch(e => { bump(tx.psErr, norm(p.hex)); tx.psMsg.set(norm(p.hex), String(e?.message || e)); });
          return r;
        } catch (e) { bump(tx.psErr, norm(p.hex)); tx.psMsg.set(norm(p.hex), String(e?.message || e)); }
      };
      // RECV side: this peer (as root) handles an inbound subscribe-k.
      const origRecv = am._onSubscribeDirect.bind(am);
      am._onSubscribeDirect = async (payload, meta) => {
        const k = payload?.subscriberId ? norm(payload.subscriberId) : null;
        if (k) bump(tx.recv, k);
        const ret = await origRecv(payload, meta);
        try {
          const role = am.axonRoles.get(BigInt('0x' + payload.topicId));
          if (k && role?.children?.has(BigInt('0x' + payload.subscriberId))) bump(tx.seated, k);
        } catch {}
        return ret;
      };
    }
    am.start?.();
  }
}

// ── 3. Subscribe SUBS peers to one regional topic ───────────────────
const topic   = { region: 'useast', name: 'load-test' };
const topicHex = await deriveTopicId(topic);
const topicBig = BigInt('0x' + topicHex);
console.log(`[topic] ${topic.region}/${topic.name} -> ${topicHex.slice(0,16)}…`);

// shuffle, take SUBS subscribers + 1 publisher (disjoint)
const shuffled = [...peers].sort(() => Math.random() - 0.5);
const subscribers = shuffled.slice(0, SUBS);
const publisher   = shuffled[SUBS] || shuffled[0];

const recv = new Map();   // hex -> Set(msgId received)
for (const s of subscribers) {
  recv.set(s.hex, new Set());
  await s.peer.sub(topic, (env) => { if (env?.msgId) recv.get(s.hex).add(String(env.msgId)); });
  await wait(3);   // light stagger so recruitment processes incrementally, as in the wild
}
await wait(SETTLE);   // let subscribe-k routing + recruitment + convergence settle

// ── 4. Publish a SERIES of signed messages across refresh cycles ─────
// Steady-state test: if per-publish delivery climbs toward 100% as the mesh
// warms, the cold-publish gap was a convergence/replay artifact; if it
// plateaus below, it's a real delivery gap.
publisher.author = await createAuthorIdentity();
const PUBS = +(process.env.PUBS || 1), PUBGAP = +(process.env.PUBGAP || 2500);
const published = [];
for (let i = 0; i < PUBS; i++) {
  const id = await publisher.peer.pub(topic, `probe-${i}`, { signWith: publisher.author });
  published.push(String(id));
  await wait(PUBGAP);   // spaced across refresh cycles so steady-state healing can act
}
console.log(`[pub] publisher ${publisher.hex.slice(0,10)} sent ${PUBS} message(s)`);
await wait(DELIVER);   // final delivery fan-out

// ── 5. Measure per-publish delivery + the ACTUAL axon tree ──────────
const perPub     = published.map(id => subscribers.filter(s => recv.get(s.hex).has(id)).length);
const delivered  = perPub.length ? perPub[perPub.length - 1] : 0;   // LAST (most-converged) publish
const cumulative = subscribers.filter(s => recv.get(s.hex).size > 0).length;

// Reconstruct the tree from every peer's role for this topic.
let roots = 0, subaxons = 0, plainRoleNodes = 0, maxFanout = 0, totalChildren = 0, roleNodes = 0;
const fanouts = [];
for (const p of peers) {
  const role = p.peer._axonaManager?.axonRoles?.get(topicBig);
  if (!role) continue;
  roleNodes++;
  const kids = role.children?.size ?? 0;
  totalChildren += kids;
  maxFanout = Math.max(maxFanout, kids);
  fanouts.push(kids);
  if (role.isRoot || role.isInRootSet) roots++;
  // count sub-axon children this role delegated to
  for (const childMeta of (role.children?.values?.() ?? [])) {
    if (childMeta?.isSubaxon) subaxons++;
  }
  if (!(role.isRoot || role.isInRootSet)) plainRoleNodes++;
}
fanouts.sort((a,b)=>a-b);

// Tree depth, top-down: from each root, follow children flagged isSubaxon that
// themselves hold a role, recursively. Robust across BOTH recruitment paths
// (fallback promote-axon and pickRelayPeer batch adoption both mark the child
// meta isSubaxon), unlike a parentId walk which the batch path sets differently.
const roleByBig = new Map();
for (const p of peers) { const r = p.peer._axonaManager?.axonRoles?.get(topicBig); if (r) roleByBig.set(p.big, r); }
const depthFrom = (big, seen) => {
  const r = roleByBig.get(big);
  if (!r || seen.has(big)) return 1;
  seen.add(big);
  let mx = 1;
  for (const [childBig, meta] of (r.children ?? new Map())) {
    if (meta?.isSubaxon && roleByBig.has(childBig)) mx = Math.max(mx, 1 + depthFrom(childBig, seen));
  }
  return mx;
};
let maxDepth = 0;
for (const [big, r] of roleByBig) if (r.isRoot || r.isInRootSet) maxDepth = Math.max(maxDepth, depthFrom(big, new Set()));
if (!maxDepth && roleByBig.size) maxDepth = 1;

console.log('\n================ RESULT ================');
console.log(`per-publish delivery (/${SUBS}): [${perPub.join(', ')}]  first→last`);
console.log(`last publish:     ${delivered}/${SUBS}  (${(100*delivered/SUBS).toFixed(1)}%)`);
console.log(`cumulative (any): ${cumulative}/${SUBS}  (${(100*cumulative/SUBS).toFixed(1)}%)`);
console.log(`role-bearing nodes (axons): ${roleNodes}  (roots/in-root-set: ${roots}, sub-axons delegated: ${subaxons}, other: ${plainRoleNodes})`);
console.log(`fan-out per axon:  max=${maxFanout}  median=${fanouts[fanouts.length>>1] ?? 0}  (maxDirectSubs default=20)`);
console.log(`tree depth:        ${maxDepth}  (1 = flat star at roots; >1 = sub-axon tiers)`);
console.log(`total child links: ${totalChildren}`);
console.log('========================================\n');

// ── 6. Diagnose the persistent misses: enrollment vs root-set overlap ─
const lastId = published[published.length - 1];
const missing = subscribers.filter(s => !recv.get(s.hex).has(lastId));
if (missing.length) {
  const pubRoots = (await publisher.peer.findKClosest(topicBig, 5)).map(x => String(x));
  const enrolled = new Set();                       // every nodeId that is a child in SOME role
  for (const p of peers) {
    const r = p.peer._axonaManager?.axonRoles?.get(topicBig);
    if (r) for (const c of r.children.keys()) enrolled.add(c);
  }
  console.log(`[diag] ${missing.length} persistent miss(es). publisher's roots: ${pubRoots.map(x=>x.slice(-6)).join(',')}`);
  const rootHexes = pubRoots.map(rb => byBig.get(BigInt(rb))?.hex).filter(Boolean);
  for (const m of missing.slice(0, 6)) {
    const mRoots  = (await m.peer.findKClosest(topicBig, 5)).map(x => String(x));
    const overlap = mRoots.filter(x => pubRoots.includes(x)).length;
    const connRoots = rootHexes.filter(rh => { try { return m.peer._transport.isConnected?.(rh); } catch { return false; } }).length;
    const k = norm(m.hex);
    const trace = TRACE ? `  psCall=${tx.psCall.get(k)||0} psErr=${tx.psErr.get(k)||0} sentK=${tx.sent.get(k)||0} recvAtRoots=${tx.recv.get(k)||0}${tx.psMsg.get(k) ? '  err="'+tx.psMsg.get(k)+'"' : ''}` : '';
    console.log(`  miss …${m.hex.slice(-6)}: enrolledInATree=${enrolled.has(m.big)}  overlap=${overlap}/5  connRoots=${connRoots}/${rootHexes.length}${trace}`);
  }
  // do all subscribers + publisher even agree on the root set?
  const agree = subscribers.slice(0,12).map(s => (s._kc ??= null));
  console.log('[diag] (overlap=0 ⇒ K-closest disagreement; enrolledInATree=false ⇒ never seated; true+overlap>0 ⇒ forwarding gap)');
}

if (TRACE) {
  const withCall = subscribers.filter(s => (tx.psCall.get(norm(s.hex)) || 0) > 0).length;
  const withSent = subscribers.filter(s => (tx.sent.get(norm(s.hex)) || 0) > 0).length;
  console.log(`[trace] instrument sanity: subscribers with pubsubSubscribe called = ${withCall}/${SUBS}; with ≥1 subscribe-k sent = ${withSent}/${SUBS}`);
}

// ── 7. Churn / self-healing (optional): kill CHURN_PCT% of nodes, heal, re-publish ──
const CHURN_PCT = +(process.env.CHURN_PCT || 0);
let churn = null;
if (CHURN_PCT > 0) {
  const killN = Math.max(1, Math.floor(N * CHURN_PCT / 100));
  const victims = peers.filter(p => p !== publisher).sort(() => Math.random() - 0.5).slice(0, killN);
  const victimBig = new Set(victims.map(v => v.big));
  for (const v of victims) { try { await v.peer.stop?.(); } catch {} }   // ungraceful death (unregisters transport, clears timers)
  // Survivors forget the dead from their synaptomes (production does this via
  // vitality / dead-peer eviction; we do it explicitly so routing avoids ghosts).
  for (const p of peers) { if (victimBig.has(p.big)) continue; for (const vb of victimBig) p.node.synaptome.delete(vb); }
  const survSubs = subscribers.filter(s => !victimBig.has(s.big));
  await wait(Math.max(DELIVER, REFRESH * 4));   // heal: refresh re-subscribes survivors to the new K-closest
  const cId = String(await publisher.peer.pub(topic, 'post-churn-probe', { signWith: publisher.author }));
  await wait(DELIVER);
  const survDeliv = survSubs.filter(s => recv.get(s.hex).has(cId)).length;
  // recompute tree depth among survivors
  const rb = new Map();
  for (const p of peers) { if (victimBig.has(p.big)) continue; const r = p.peer._axonaManager?.axonRoles?.get(topicBig); if (r) rb.set(p.big, r); }
  const dF = (big, seen) => { const r = rb.get(big); if (!r || seen.has(big)) return 1; seen.add(big); let mx = 1; for (const [cb, m] of (r.children ?? new Map())) if (m?.isSubaxon && rb.has(cb)) mx = Math.max(mx, 1 + dF(cb, seen)); return mx; };
  let dDepth = 0; for (const [big, r] of rb) if (r.isRoot || r.isInRootSet) dDepth = Math.max(dDepth, dF(big, new Set())); if (!dDepth && rb.size) dDepth = 1;
  churn = { killedPct: CHURN_PCT, killed: killN, survSubs: survSubs.length, delivered: survDeliv, pct: +(100 * survDeliv / survSubs.length).toFixed(1), depth: dDepth };
  console.log(`[churn] killed ${killN} (${CHURN_PCT}%); post-churn delivery to survivors: ${survDeliv}/${survSubs.length} (${churn.pct}%); tree depth ${dDepth}`);
}

// Machine-readable result line for the sweep runner to aggregate.
console.log('RESULT_JSON ' + JSON.stringify({
  N, SUBS, K, pickRelay: PICK_RELAY, synCap: SYN_CAP,
  delivery: delivered, deliveryPct: +(100 * delivered / SUBS).toFixed(1),
  depth: maxDepth, maxFanout, roleNodes, subaxons, churn,
}));

process.exit(0);
