/**
 * Quick Node-side verification that GeographicDHTb's transport-attached
 * lookup works post-v0.70.22 fix.
 *
 * Run: node smoke_gdht.mjs
 */

import { GeographicDHTb } from './src/dht/geographic/GeographicDHT.js';
import { SimulatedNetwork } from './src/dht/SimulatedNetwork.js';

const N = 200;

async function main() {
  console.log(`G-DHT smoke (commit 16 / G-DHT FIND_NODE handler fix) — ${N} nodes`);

  const dht = new GeographicDHTb({ k: 20, alpha: 3, geoBits: 8 });
  dht.network = new SimulatedNetwork();
  dht._setupNetwork?.();

  for (let i = 0; i < N; i++) {
    const lat = (Math.random() - 0.5) * 170;
    const lng = (Math.random() - 0.5) * 360;
    await dht.addNode(lat, lng);
  }

  dht.buildRoutingTables({ bidirectional: true, maxConnections: 100 });

  // Verify transport handlers were registered.
  const sample = [...dht.nodeMap.values()][0];
  if (!sample.transport) {
    console.error('  FAIL: nodes have no transport attached'); process.exit(1);
  }
  console.log(`  added ${dht.nodeMap.size} nodes; first node has transport: yes`);

  const nodes = [...dht.nodeMap.values()];
  let ok = 0;
  for (let i = 0; i < 50; i++) {
    const src = nodes[Math.floor(Math.random() * nodes.length)];
    const dst = nodes[Math.floor(Math.random() * nodes.length)];
    if (src.id === dst.id) { i--; continue; }
    const r = await dht.lookup(src.id, dst.id);
    if (r && r.found) ok++;
  }
  console.log(`  lookup: ${ok}/50 succeeded`);
  if (ok < 48) { console.error('  FAIL: G-DHT lookup quality regressed'); process.exit(1); }

  console.log('  OK');
}

main().catch(err => { console.error('smoke test threw:', err); process.exit(1); });
