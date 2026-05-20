// =====================================================================
// smoke_transport_axona_engine.mjs — TransportAxonaEngine smoke.
//
// Validates the dht-sim adapter that satisfies the DHT contract by
// constructing N kernel AxonaPeers over kernel SimNetwork+simTransport,
// all sharing one AxonaDomain.
//
// Two scenarios:
//   1. 50-node mesh — addNode + buildRoutingTables + a successful
//      cross-mesh lookup
//   2. 5-node tight mesh — looks up every peer from peer[0]; verifies
//      100% success rate
//
// Run:  node test/smoke_transport_axona_engine.mjs
// =====================================================================

import { TransportAxonaEngine } from '../src/dht/neuromorphic/TransportAxonaEngine.js';

let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}`); failed++; }
}

function rand(min, max) { return min + Math.random() * (max - min); }

async function buildEngine(N) {
  const eng = new TransportAxonaEngine({ k: 20, geoBits: 8 });
  for (let i = 0; i < N; i++) {
    await eng.addNode(rand(-60, 60), rand(-180, 180));
  }
  await eng.buildRoutingTables({ bidirectional: true });
  return eng;
}

async function testSmallMeshAllPairs() {
  console.log('\n── 5-node mesh — peer[0] looks up every other peer ──');
  const eng = await buildEngine(5);
  const ids = [...eng.nodeMap.keys()];
  check('engine constructed 5 nodes',          ids.length === 5);
  check('every node has at least 1 synapse',
    [...eng.nodeMap.values()].every(n => n.synaptome.size >= 1));

  const source = ids[0];
  let ok = 0;
  for (let i = 1; i < ids.length; i++) {
    const r = await eng.lookup(source, ids[i]);
    if (r?.found) ok++;
  }
  check('peer[0] finds all 4 others',          ok === 4);
}

async function testMidMeshOneLookup() {
  console.log('\n── 50-node mesh — random cross-mesh lookup ──');
  const eng = await buildEngine(50);
  const ids = [...eng.nodeMap.keys()];
  check('engine constructed 50 nodes',         ids.length === 50);

  const src = ids[0];
  const dst = ids[ids.length - 1];
  const r = await eng.lookup(src, dst);
  check('lookup returned a result',            r != null);
  check('lookup.found === true',               r?.found === true);
  check('lookup.path includes target',         r?.path?.includes(dst));
  check('lookup.hops is a positive integer',
    typeof r?.hops === 'number' && r.hops > 0);
  check('domain.simEpoch advanced',            eng.domain.simEpoch >= 1);
  console.log(`  · hops=${r.hops}, time=${Math.round(r.time)}ms`);
}

async function main() {
  console.log('TransportAxonaEngine smoke (dht-sim adapter)');
  console.log('engine = N kernel AxonaPeers over Transport.sim, one shared AxonaDomain\n');

  await testSmallMeshAllPairs();
  await testMidMeshOneLookup();

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error('smoke threw:', err); process.exit(2); });
