// =====================================================================
// K-DHT / G-DHT smoke test (post-Transport-conformance refactor)
//
// Builds a small network, exercises lookups in standard + geo mode,
// and confirms that the refactored protocols still hit 100% success
// and return sensible hop / latency numbers.
//
// Runs under Node directly: `node src/dht/kademlia/smoke_kdht.js`
// =====================================================================

import { SimulatedNetwork } from '../SimulatedNetwork.js';
import { KademliaDHT }      from './KademliaDHT.js';
import { GeographicDHT }    from '../geographic/GeographicDHT.js';

const NODE_COUNT = 200;

// World latitudes/longitudes -- spread across continents for geo-mode realism.
function randomLatLng() {
  return {
    lat: -85 + Math.random() * 170,
    lng: -180 + Math.random() * 360,
  };
}

async function buildNetwork(DHTClass, label) {
  console.log(`\n── ${label} ──`);
  const network = new SimulatedNetwork();
  const dht = new DHTClass({
    network,
    k: 20,
    alpha: 3,
    bits: 64,
    maxConnections: 50,
    geoBits: 8,   // G-DHT honours this; K-DHT ignores
  });
  // K-DHT has no geo prefix at construction; both pull lat/lng from addNode.
  for (let i = 0; i < NODE_COUNT; i++) {
    const { lat, lng } = randomLatLng();
    await dht.addNode(lat, lng);
  }
  dht.buildRoutingTables({ bidirectional: true, maxConnections: 50 });
  return dht;
}

async function exerciseGlobalLookups(dht, label, n = 50) {
  const allIds = [...dht.nodeMap.keys()];
  let ok = 0, totalHops = 0, totalTime = 0;
  for (let i = 0; i < n; i++) {
    const sourceId = allIds[(Math.random() * allIds.length) | 0];
    const targetId = allIds[(Math.random() * allIds.length) | 0];
    if (sourceId === targetId) continue;
    const r = await dht.lookup(sourceId, targetId);
    if (r?.found) ok++;
    if (r) { totalHops += r.hops; totalTime += r.time; }
  }
  console.log(`  ${label} global: ${ok}/${n} (${((ok / n) * 100).toFixed(1)}%) avg hops=${(totalHops / n).toFixed(2)} avg ms=${(totalTime / n).toFixed(1)}`);
  return ok === n;
}

async function exerciseRegionalLookups(dht, label, n = 50, radiusKm = 2000) {
  // Pick random source nodes, find a target by S2-cell prefix XOR.
  const allNodes = [...dht.nodeMap.values()];
  let ok = 0, totalHops = 0, totalTime = 0;
  for (let i = 0; i < n; i++) {
    const source = allNodes[(Math.random() * allNodes.length) | 0];
    const target = allNodes[(Math.random() * allNodes.length) | 0];
    if (source.id === target.id) continue;
    const r = await dht.lookup(source.id, target.id, { geoKey: target.s2Cell });
    if (r?.found) ok++;
    if (r) { totalHops += r.hops; totalTime += r.time; }
  }
  console.log(`  ${label} regional (geo): ${ok}/${n} (${((ok / n) * 100).toFixed(1)}%) avg hops=${(totalHops / n).toFixed(2)} avg ms=${(totalTime / n).toFixed(1)}`);
  return ok === n;
}

async function main() {
  console.log('K-DHT / G-DHT smoke test (post-audit refactor)');
  console.log(`Node count: ${NODE_COUNT}, k=20, α=3`);

  const kdht = await buildNetwork(KademliaDHT, 'Kademlia');
  const okK1 = await exerciseGlobalLookups(kdht, 'K-DHT', 30);
  const okK2 = await exerciseRegionalLookups(kdht, 'K-DHT', 30);

  const gdht = await buildNetwork(GeographicDHT, 'Geographic DHT');
  const okG1 = await exerciseGlobalLookups(gdht, 'G-DHT', 30);
  const okG2 = await exerciseRegionalLookups(gdht, 'G-DHT', 30);

  const allPassed = okK1 && okK2 && okG1 && okG2;
  console.log(`\nResult: ${allPassed ? 'PASS ✓' : 'FAIL ✗'}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('smoke test threw:', err);
  process.exit(2);
});
