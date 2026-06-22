// =====================================================================
// smoke_transport_axona_pubsub.mjs — the `axona` engine's pub/sub path.
//
// Validates TransportAxonaEngine.axonFor(): the membership/PubSubAdapter
// contract delegating to the REAL kernel peer.pub / peer.sub (so the browser
// benchmark's `axona` protocol exercises the shipped axon-tree pub/sub, not a
// sim-native manager). Drives it exactly as src/simulation/Engine.js does:
// new PubSubAdapter({ transport: dht.axonFor(node) }) → subscribe/publish.
//
// Run:  node test/smoke_transport_axona_pubsub.mjs
// =====================================================================

import { TransportAxonaEngine } from '../src/dht/neuromorphic/TransportAxonaEngine.js';
import { PubSubAdapter } from '../src/pubsub/PubSubAdapter.js';

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (l, c) => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.log(`  ✗ ${l}`); failed++; } };

const N = +(process.env.N || 40), SUBS = +(process.env.SUBS || 30);
console.log(`\n── axona pub/sub via axonFor — N=${N} SUBS=${SUBS} ──`);

const eng = new TransportAxonaEngine({ k: 20, geoBits: 8 });
for (let i = 0; i < N; i++) await eng.addNode(38 + Math.random() * 2, -77 + Math.random() * 2); // us-east cluster
await eng.buildRoutingTables({ bidirectional: true });

const nodes = [...eng.nodeMap.values()];
check('axonFor returns the PubSubAdapter shim', typeof eng.axonFor(nodes[0])?.pubsubSubscribe === 'function');

const subs = nodes.slice(0, SUBS);
const pub  = nodes[SUBS] || nodes[0];
const got  = new Map();
for (const n of subs) {
  got.set(n.id, false);
  const a = new PubSubAdapter({ transport: eng.axonFor(n) });
  a.subscribe('bench', 'room', () => got.set(n.id, true), 'immediate');
}
const pubAdapter = new PubSubAdapter({ transport: eng.axonFor(pub) });

await wait(+(process.env.SETTLE || 9000));    // converge (shim arms the refresh loop)
pubAdapter.publish('bench', 'room', { hello: 1 });
await wait(+(process.env.DELIVER || 4000));

const delivered = [...got.values()].filter(Boolean).length;
console.log(`  delivery: ${delivered}/${SUBS} (${(100 * delivered / SUBS).toFixed(1)}%)`);
check('delivery ≥ 90% over the real kernel axon tree', delivered >= Math.ceil(SUBS * 0.9));

eng.resetAllAxons();
check('resetAllAxons clears the shims', eng._axonShims.size === 0);

// ── visualization data path: buildAxonTree → axonTreeEdges (what the globe draws) ──
console.log('\n── buildAxonTree + axonTreeEdges (the green-tree viz data) ──');
const veng = new TransportAxonaEngine({ k: 20, geoBits: 8 });
for (let i = 0; i < 60; i++) await veng.addNode(38 + Math.random() * 2, -77 + Math.random() * 2);
await veng.buildRoutingTables({ bidirectional: true });
const { topicBig, subscribed } = await veng.buildAxonTree({ subscribers: 45, settleMs: 3000 });
const tree = veng.axonTreeEdges(topicBig);
console.log(`  tree: subs=${subscribed} edges=${tree.edges.length} roots=${tree.roots.size} subaxons=${tree.subaxons.size} depth=${tree.depth}`);
check('buildAxonTree produced tree edges', tree.edges.length > 0);
check('tree has ≥1 root', tree.roots.size >= 1);
check('every edge endpoint resolves to a renderable node', tree.edges.every(([p, c]) => veng.nodeMap.has(p) && veng.nodeMap.has(c)));

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
