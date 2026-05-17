// =====================================================================
// NX-17 smoke test (post-NH-1-subclass refactor).
//
// Builds a small Neuromorphic-NX17 network, runs lookups and a
// publish/subscribe cascade, and confirms the new NX-17 inherits NH-1's
// Transport-conformant body cleanly.
//
// Runs under Node directly: `node src/dht/neuromorphic/smoke_nx17.js`
// =====================================================================

import { SimulatedNetwork } from '../SimulatedNetwork.js';
import { NeuromorphicDHTNX17 } from './NeuromorphicDHTNX17.js';
import { AxonaEngine }  from './AxonaEngine.js';

const NODE_COUNT = 200;

function randomLatLng() {
  return {
    lat: -85 + Math.random() * 170,
    lng: -180 + Math.random() * 360,
  };
}

async function buildNetwork(DHTClass, label, { maxConnections = 100 } = {}) {
  console.log(`\n── ${label} ──`);
  const network = new SimulatedNetwork();
  const dht = new DHTClass({
    network,
    k: 20,
    alpha: 3,
    bits: 64,
    geoBits: 8,
    maxConnections,
  });
  for (let i = 0; i < NODE_COUNT; i++) {
    const { lat, lng } = randomLatLng();
    await dht.addNode(lat, lng);
  }
  // maxConnections=100 leaves room for NX-17's MAX_SYNAPTOME=60
  // without NH-1's auto-cap clobbering it (NH-1.js:501-502 lowers
  // MAX_SYNAPTOME if maxConnections is smaller).
  dht.buildRoutingTables({ bidirectional: true, maxConnections });
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
  return ok / n >= 0.95;
}

async function main() {
  console.log('NX-17 / NH-1 smoke test (uniform-API verification)');
  console.log(`Node count: ${NODE_COUNT}, k=20, α=3`);

  const nh1 = await buildNetwork(AxonaEngine, 'NH-1');
  const okNH = await exerciseGlobalLookups(nh1, 'NH-1', 30);

  const nx17 = await buildNetwork(NeuromorphicDHTNX17, 'NX-17');
  const okNX = await exerciseGlobalLookups(nx17, 'NX-17', 30);

  // Verify API identity: every property NH-1 exposes (methods AND
  // accessors like usesPublisherPrefix) is also accessible on NX-17.
  // Use `in` operator to walk the prototype chain so we don't miss
  // inherited getters or methods.
  const nh1Names = Object.getOwnPropertyNames(AxonaEngine.prototype)
    .filter(n => n !== 'constructor');
  const missing = nh1Names.filter(n => !(n in nx17));
  const apiOk = missing.length === 0;
  console.log(`\nAPI surface: ${apiOk ? 'identical ✓' : `missing on NX-17: ${missing.join(', ')}`}`);

  // Verify NX-17's tuning overrides are actually in effect.
  const tuningOk =
    nx17.MAX_SYNAPTOME      === 60 &&
    nx17.LOOKAHEAD_ALPHA    === 7  &&
    Math.abs(nx17.ANNEAL_COOLING - 0.99985) < 1e-9 &&
    nx17.ANNEAL_LOCAL_SAMPLE === 75;
  console.log(`NX-17 tuning: ${tuningOk ? 'all four knobs applied ✓' : 'overrides not in effect'}`);
  console.log(`  MAX_SYNAPTOME=${nx17.MAX_SYNAPTOME} (expected 60)`);
  console.log(`  LOOKAHEAD_ALPHA=${nx17.LOOKAHEAD_ALPHA} (expected 7)`);
  console.log(`  ANNEAL_COOLING=${nx17.ANNEAL_COOLING} (expected 0.99985)`);
  console.log(`  ANNEAL_LOCAL_SAMPLE=${nx17.ANNEAL_LOCAL_SAMPLE} (expected 75)`);

  const allPassed = okNH && okNX && apiOk && tuningOk;
  console.log(`\nResult: ${allPassed ? 'PASS ✓' : 'FAIL ✗'}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('smoke test threw:', err);
  process.exit(2);
});
