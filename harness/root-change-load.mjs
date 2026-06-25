// =====================================================================
// root-change-load.mjs — when the root of a topic with MANY subscribers churns,
// how much re-subscribe load lands on the NEW root? Does the axonic tree bound it
// to ~fan-out, or does the new root sit at the center of an O(N) flood?
//
// Drives the REAL shipped kernel (AxonaPeer pub/sub) over the kernel SimNetwork at
// scale: builds N peers, subscribes SUBS (forming a multi-tier tree — root → ≤20
// sub-axons → leaves), then forces ONE root change (kills the current root) and
// measures, per node, the inbound subscribe-k it must process during re-home.
//
// MODE:
//   pull     — natural re-home: orphaned nodes re-subscribe toward the topic; the
//              new root delegates past MAX_DIRECT. Measures the herd on the new root.
//   handoff  — at kill time, transfer the dying root's subscriber/child table to the
//              successor (the next XOR-closest node). Models root-side handoff: the
//              new root inherits the backbone, so it should see ~0 re-subscribe load.
//
// Instrumentation: AxonaManager.prototype._onSub is patched to count, per manager,
// every subscribe-k that reaches its handler (__subkIn). We reset all counters AFTER
// the tree forms, so the numbers reflect ONLY the root-change re-home window.
//
//   N=500 SUBS=400 MODE=pull node harness/root-change-load.mjs
//   N=1200 SUBS=1000 MODE=handoff node harness/root-change-load.mjs
// =====================================================================
import {
  AxonaPeer, AxonaDomain, NeuronNode, Synapse, SimNetwork, simTransport, AxonaManager,
  createNodeIdentity, createAuthorIdentity, deriveTopicId, clz264, KERNEL_VERSION,
} from '@axona/protocol';
import { buildXorRoutingTable } from '@axona/protocol/utils/geo.js';

// ── instrument: count inbound subscribe-k per manager (prototype patch, pre-build) ──
const _origOnSub = AxonaManager.prototype._onSub;
AxonaManager.prototype._onSub = function (p, m) { this.__subkIn = (this.__subkIn || 0) + 1; return _origOnSub.call(this, p, m); };

const N       = +(process.env.N || 500);
const SUBS    = +(process.env.SUBS || Math.floor(N * 0.8));
const K       = +(process.env.K || 16);
const MODE    = process.env.MODE || 'pull';            // pull | handoff
const REFRESH = +(process.env.REFRESH || 1000);
// renewMs is the ACTUAL re-home gate (refreshTick only re-sends a subscribe-k once
// per renewMs). It IS the orphaning window after a root change. Default low here so
// re-home fires inside the observation window; prod default is ~60s (= a 60s orphan
// window — the thing the event-driven-rehome fix targets).
const RENEW   = +(process.env.RENEW || 1500);
const SETTLE  = +(process.env.SETTLE || 8000);          // tree must fully form
const WINDOW  = +(process.env.WINDOW || 6000);          // re-home observation window after the kill
const LAT = 38.0, LNG = -77.0;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const lc = (h) => String(h).toLowerCase().replace(/^0x/, '');

console.log(`root-change-load  kernel v${KERNEL_VERSION}  N=${N} SUBS=${SUBS} K=${K} MODE=${MODE} refresh=${REFRESH}ms`);

const network = new SimNetwork();
const domain  = new AxonaDomain({ k: K });
const byBig = new Map();
const peers = [];

async function makePeer(role) {
  const identity = await createNodeIdentity({ lat: LAT, lng: LNG });
  const transport = simTransport({ network, identity, heartbeatMs: 0 });
  await transport.start(identity.id);
  const node = new NeuronNode({ id: BigInt('0x' + identity.id), lat: LAT, lng: LNG });
  node.transport = transport;
  const peer = new AxonaPeer({ domain, node, nodeIdentity: identity, transport });
  await peer.start();
  const am = peer._requireAxonaManager?.('load-init');
  if (am) { am.refreshIntervalMs = REFRESH; am.renewMs = RENEW; }
  const p = { peer, node, hex: identity.id, big: node.id, role, am };
  byBig.set(p.big, p); peers.push(p);
  return p;
}

console.log('[build] minting peers…');
const pub = await makePeer('pub'); pub.author = await createAuthorIdentity();
for (let i = 0; i < N; i++) await makePeer('sub');

console.log('[build] seeding XOR mesh + opening channels…');
const allNodes = peers.map(p => p.node).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
for (const p of peers) {
  for (const cand of buildXorRoutingTable(p.node.id, allNodes, K, Infinity)) {
    if (cand.id === p.node.id || p.node.synaptome.has(cand.id)) continue;
    const syn = new Synapse({ peerId: cand.id, latencyMs: 1, stratum: clz264(p.node.id ^ cand.id) });
    syn.weight = 0.5; syn.inertia = 0; syn._addedBy = 'load'; p.node.synaptome.set(cand.id, syn);
  }
}
for (const p of peers) for (const peerBig of p.node.synaptome.keys()) { const t = byBig.get(peerBig); if (t) { try { await p.peer._transport.openConnection(t.hex); } catch { /* */ } } }
for (const p of peers) p.am?.start?.();

const topic = { region: 'useast', name: 'load-probe' };
const topicHex = await deriveTopicId(topic); const topicBig = BigInt('0x' + topicHex);

console.log(`[sub] subscribing ${SUBS}…`);
const recv = new Map();
const subPeers = peers.filter(p => p.role === 'sub').slice(0, SUBS);
for (const p of subPeers) { recv.set(p.hex, new Set()); await p.peer.sub(topic, (env) => { if (env?.msgId) recv.get(p.hex).add(String(env.msgId)); }); }
console.log(`[sub] settling tree (${SETTLE}ms)…`);
await wait(SETTLE);

// ── snapshot the tree ──
const roleNodes = peers.filter(p => p.peer._axonaManager?.axonRoles?.get(topicBig));
const roots = roleNodes.filter(p => { const r = p.peer._axonaManager.axonRoles.get(topicBig); return r.isRoot || r.isInRootSet; });
const roleByBig = new Map(roleNodes.map(p => [p.big, p]));
const depthFrom = (big, seen) => { const r = byBig.get(big)?.peer._axonaManager?.axonRoles?.get(topicBig); if (!r || seen.has(big)) return 1; seen.add(big); let mx = 1; for (const ch of (r.children || [])) { const cb = BigInt('0x' + lc(ch)); if (roleByBig.has(cb)) mx = Math.max(mx, 1 + depthFrom(cb, seen)); } return mx; };
let depth = 0; for (const r of roots) depth = Math.max(depth, depthFrom(r.big, new Set()));
const oldRoot = roots[0];
const oldRootRole = oldRoot?.peer._axonaManager.axonRoles.get(topicBig);
console.log(`[tree] role-bearing nodes=${roleNodes.length}  roots=${roots.length}  depth=${depth}  oldRoot direct children=${oldRootRole?.children?.size ?? 0} subscribers=${oldRootRole?.subscribers?.size ?? 0}`);

// ── reset inbound counters: measure ONLY the re-home window ──
for (const p of peers) p.am.__subkIn = 0;

// ── successor = XOR-closest LIVE node to the topic, excluding the dying root ──
const successor = peers.filter(p => p.big !== oldRoot.big)
  .sort((a, b) => { const da = a.big ^ topicBig, db = b.big ^ topicBig; return da < db ? -1 : da > db ? 1 : 0; })[0];

if (MODE === 'handoff') {
  // transfer the dying root's subscriber/child table to the successor before it dies.
  const sam = successor.peer._axonaManager;
  let srole = sam.axonRoles.get(topicBig) || sam._becomeRoot(topicBig);
  srole.isRoot = true;
  for (const [k, v] of oldRootRole.subscribers) srole.subscribers.set(k, v);
  for (const c of oldRootRole.children) srole.children.add(c);
  console.log(`[handoff] transferred ${oldRootRole.subscribers.size} subs / ${oldRootRole.children.size} children → successor ${successor.hex.slice(0,10)}`);
}

console.log(`[kill] killing old root ${oldRoot.hex.slice(0,10)} → observing ${WINDOW}ms re-home`);
try { await oldRoot.peer._transport.stop?.(); } catch { /* */ }
byBig.delete(oldRoot.big);
await wait(WINDOW);

// ── measure ──
const live = peers.filter(p => byBig.has(p.big));
const newRoots = live.filter(p => { const r = p.peer._axonaManager?.axonRoles?.get(topicBig); return r && (r.isRoot || r.isInRootSet); });
const newRoot = newRoots.sort((a, b) => (b.am.__subkIn || 0) - (a.am.__subkIn || 0))[0] || successor;
const byLoad = live.map(p => ({ hex: p.hex, in: p.am.__subkIn || 0 })).sort((a, b) => b.in - a.in);
const totalSubk = byLoad.reduce((s, x) => s + x.in, 0);

// delivery after re-home: publish a probe, measure across live subscribers.
const id = String(await pub.peer.pub(topic, 'after-change', { signWith: pub.author }));
await wait(3000);
const liveSubs = subPeers.filter(p => byBig.has(p.big));
const delivered = liveSubs.filter(p => recv.get(p.hex)?.has(id)).length;

console.log('\n================ RESULT ================');
console.log(`mode=${MODE}  N=${N} SUBS=${SUBS}  tree depth=${depth}`);
console.log(`NEW ROOT inbound subscribe-k during window: ${newRoot.am.__subkIn || 0}   (≈ MAX_DIRECT=20 ⇒ tree-bounded; ≈ SUBS ⇒ O(N) flood)`);
console.log(`top-8 nodes by inbound subscribe-k: [${byLoad.slice(0, 8).map(x => x.in).join(', ')}]`);
console.log(`total subscribe-k processed (all nodes, window): ${totalSubk}`);
console.log(`post-change delivery: ${delivered}/${liveSubs.length} (${(100*delivered/Math.max(1,liveSubs.length)).toFixed(0)}%)`);
process.exit(0);
