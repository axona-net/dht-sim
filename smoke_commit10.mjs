/**
 * Smoke test for refactor commit 10 — NH-1 pub/sub primitives on transport.
 *
 * Builds a small NH-1 network, runs lookups, exercises pub/sub via the
 * AxonManager (publish + subscribe + refresh), and checks delivery.
 *
 * Run with:  node smoke_commit10.mjs
 */

import { NeuromorphicDHTNH1 } from './src/dht/neuromorphic/NeuromorphicDHTNH1.js';
import { SimulatedNetwork }  from './src/dht/SimulatedNetwork.js';

const N = 200;

async function main() {
  console.log(`NH-1 smoke (commit 10) — ${N} nodes`);

  const dht = new NeuromorphicDHTNH1({ k: 20 });
  // Need a SimulatedNetwork as the world; the DHT base class uses
  // this.network internally for everything routing-related.
  dht.network = new SimulatedNetwork();
  dht._setupNetwork?.();

  // 1. Add nodes uniformly distributed.
  for (let i = 0; i < N; i++) {
    const lat = (Math.random() - 0.5) * 170;
    const lng = (Math.random() - 0.5) * 360;
    await dht.addNode(lat, lng);
  }

  // 2. Bootstrap — buildRoutingTables wires synaptomes for each node.
  dht.buildRoutingTables({ maxConnections: 50 });

  console.log(`  added ${dht.nodeMap.size} nodes; bootstrapping done`);

  // 3. Lookup smoke test: pick 20 random pairs, check the lookup terminates.
  const nodes = [...dht.nodeMap.values()];
  let lookupOk = 0;
  for (let i = 0; i < 20; i++) {
    const src = nodes[Math.floor(Math.random() * nodes.length)];
    const dst = nodes[Math.floor(Math.random() * nodes.length)];
    if (src.id === dst.id) { i--; continue; }
    const r = await dht.lookup(src.id, dst.id);
    if (r && r.found) lookupOk++;
  }
  console.log(`  lookup: ${lookupOk}/20 succeeded`);

  // 4. Pub/sub smoke: pick a publisher, 5 subscribers; subscribe, publish,
  //    verify all subscribers receive.  Use the AxonManager directly.
  const publisher = nodes[0];
  const subs = nodes.slice(1, 6);

  // Pre-create AxonManagers for every node so direct-message receivers
  // have their handlers registered (matches Engine's pattern at line 905).
  for (const n of nodes) dht.axonFor(n);

  const received = new Map(subs.map(n => [n.id, 0]));
  for (const sub of subs) {
    const ax = dht.axonFor(sub);
    ax.onPubsubDelivery((topicId, json) => {
      received.set(sub.id, received.get(sub.id) + 1);
    });
  }

  // Use a synthetic 64-bit topic id (hex string).
  const topicId = '00ff00ff00ff00ff';

  for (const sub of subs) {
    dht.axonFor(sub).pubsubSubscribe(topicId);
  }
  // Drain microtasks: pubsubSubscribe is sync from caller's view but
  // fires the underlying network ops as a fire-and-forget promise chain.
  await new Promise(r => setTimeout(r, 10));

  // Inspect axon role distribution after subscribes.
  let rootCount = 0;
  let totalChildren = 0;
  for (const n of nodes) {
    const ax = dht._axonsByNode.get(n);
    if (!ax) continue;
    for (const [, role] of ax.axonRoles) {
      if (role.isRoot) rootCount++;
      totalChildren += role.children.size;
    }
  }
  console.log(`  post-subscribe: ${rootCount} roots, ${totalChildren} total children attached`);

  // Refresh a few rounds so the tree settles.
  for (let r = 0; r < 3; r++) {
    for (const n of nodes) {
      await dht.axonFor(n).refreshTick();
    }
  }

  rootCount = 0;
  totalChildren = 0;
  for (const n of nodes) {
    const ax = dht._axonsByNode.get(n);
    if (!ax) continue;
    for (const [, role] of ax.axonRoles) {
      if (role.isRoot) rootCount++;
      totalChildren += role.children.size;
    }
  }
  console.log(`  post-refresh:   ${rootCount} roots, ${totalChildren} total children attached`);

  dht.axonFor(publisher).pubsubPublish(topicId, JSON.stringify({ hello: 'world' }));
  await new Promise(r => setTimeout(r, 10));   // let fan-out drain

  let delivered = 0;
  for (const [, count] of received) if (count > 0) delivered++;
  console.log(`  pub/sub delivered: ${delivered}/${subs.length}`);

  if (lookupOk < 18) { console.error('  FAIL: lookup quality regressed'); process.exit(1); }
  if (delivered < subs.length - 1) { console.error('  FAIL: pub/sub coverage regressed'); process.exit(1); }

  // Larger lookup sweep: 200 random pairs to exercise the recursive
  // lookup_step chain across many synaptome configurations.
  let bigOk = 0;
  let totalHops = 0;
  for (let i = 0; i < 200; i++) {
    const src = nodes[Math.floor(Math.random() * nodes.length)];
    const dst = nodes[Math.floor(Math.random() * nodes.length)];
    if (src.id === dst.id) { i--; continue; }
    const r = await dht.lookup(src.id, dst.id);
    if (r && r.found) { bigOk++; totalHops += r.hops; }
  }
  console.log(`  big lookup: ${bigOk}/200 succeeded, avg hops ${(totalHops/Math.max(1,bigOk)).toFixed(2)}`);
  if (bigOk < 195) { console.error('  FAIL: large-sweep success rate regressed'); process.exit(1); }

  console.log('  OK');
}

main().catch(err => { console.error('smoke test threw:', err); process.exit(1); });
