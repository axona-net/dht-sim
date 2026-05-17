// =====================================================================
// NHOnePeer Phase 1 smoke test.
//
// Validates the per-node DHT contract surface that NHOnePeer exposes
// on top of today's multi-node NeuromorphicDHTNH1 engine.  Phase 1's
// goal is API-shape verification; nothing about routing decisions or
// performance has changed yet.
//
// Runs under Node:  `node src/dht/neuromorphic/smoke_nh1peer_phase1.js`
// =====================================================================

import { SimulatedNetwork }      from '../SimulatedNetwork.js';
import { NeuromorphicDHTNH1 }    from './NeuromorphicDHTNH1.js';
import { NHOnePeer }             from './NHOnePeer.js';
import { DHT as DHTContract }    from '../../contracts/DHT.js';

const NODE_COUNT = 30;

function randomLatLng() {
  return {
    lat: -85 + Math.random() * 170,
    lng: -180 + Math.random() * 360,
  };
}

let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}`); failed++; }
}

async function buildEngine() {
  const network = new SimulatedNetwork();
  const engine = new NeuromorphicDHTNH1({
    network,
    k: 20,
    alpha: 3,
    bits: 64,
    geoBits: 8,
    maxConnections: 100,
  });
  for (let i = 0; i < NODE_COUNT; i++) {
    const { lat, lng } = randomLatLng();
    await engine.addNode(lat, lng);
  }
  engine.buildRoutingTables({ bidirectional: true, maxConnections: 100 });
  return engine;
}

async function testConstruction() {
  console.log('\n── Construction + extends contract ──');
  const engine = await buildEngine();
  const someNode = [...engine.nodeMap.values()][0];
  const peer = new NHOnePeer({ engine, node: someNode });

  check('NHOnePeer instance can be constructed', peer != null);
  check('NHOnePeer extends the DHT contract',     peer instanceof DHTContract);
  check('throws if engine missing',
    (() => { try { new NHOnePeer({ node: someNode }); return false; }
             catch { return true; } })()
  );
  check('throws if node missing',
    (() => { try { new NHOnePeer({ engine }); return false; }
             catch { return true; } })()
  );
}

async function testLifecycle() {
  console.log('\n── Lifecycle (start / stop / idempotency) ──');
  const engine = await buildEngine();
  const someNode = [...engine.nodeMap.values()][0];
  const peer = new NHOnePeer({ engine, node: someNode });

  let threw = false;
  try { await peer.start(); } catch { threw = true; }
  check('first start() resolves', !threw);

  threw = false;
  try { await peer.start(); } catch { threw = true; }
  check('second start() is idempotent', !threw);

  threw = false;
  try { await peer.stop(); } catch { threw = true; }
  check('stop() resolves', !threw);

  threw = false;
  try { await peer.stop(); } catch { threw = true; }
  check('second stop() is idempotent', !threw);

  threw = false;
  try { await peer.start(); } catch { threw = true; }
  check('start() after stop() resolves', !threw);
  await peer.stop();
}

async function testIdentity() {
  console.log('\n── Identity ──');
  const engine = await buildEngine();
  const allNodes = [...engine.nodeMap.values()];
  const peerA = new NHOnePeer({ engine, node: allNodes[0] });
  const peerB = new NHOnePeer({ engine, node: allNodes[1] });

  check('getNodeId returns the wrapped node id',
    peerA.getNodeId() === allNodes[0].id);
  check('different peers report different ids',
    peerA.getNodeId() !== peerB.getNodeId());
}

async function testObservability() {
  console.log('\n── Observability (getSynaptome / getMetrics) ──');
  const engine = await buildEngine();
  const someNode = [...engine.nodeMap.values()][0];
  const peer = new NHOnePeer({ engine, node: someNode });

  const syn = peer.getSynaptome();
  check('getSynaptome returns an array', Array.isArray(syn));
  check('getSynaptome has at least one entry after bootstrap',
    syn.length > 0);
  if (syn.length > 0) {
    const entry = syn[0];
    check('synaptome entry has peerId',  typeof entry.peerId === 'bigint');
    check('synaptome entry has weight',  typeof entry.weight === 'number');
    check('synaptome entry has latency', typeof entry.latency === 'number');
  }

  const metrics = peer.getMetrics();
  check('getMetrics returns an object', metrics && typeof metrics === 'object');
  check('getMetrics carries synaptomeSize',
    typeof metrics.synaptomeSize === 'number');
}

async function testLookupDelegation() {
  console.log('\n── lookup() delegates to engine ──');
  const engine = await buildEngine();
  const allNodes = [...engine.nodeMap.values()];
  const sourceNode = allNodes[0];
  const targetId = allNodes[10].id;

  const peer = new NHOnePeer({ engine, node: sourceNode });
  await peer.start();

  // Run the same lookup two ways: via the engine directly and via the
  // peer.  They MUST be identical (the peer just forwards).
  const directResult = await engine.lookup(sourceNode.id, targetId);
  const peerResult   = await peer.lookup(targetId);

  check('peer.lookup found same as engine.lookup',
    directResult.found === peerResult.found);
  check('peer.lookup hops within 1 of engine.lookup (anneal randomness)',
    Math.abs((directResult.hops ?? 0) - (peerResult.hops ?? 0)) <= 1);

  await peer.stop();
}

async function testEventForwarding() {
  console.log('\n── onEvent forwards events about this peer ──');
  const engine = await buildEngine();
  const someNode = [...engine.nodeMap.values()][0];
  const peer = new NHOnePeer({ engine, node: someNode });
  await peer.start();

  const received = [];
  const unsub = peer.onEvent((ev) => received.push(ev));

  // Run a lookup that the engine emits a lookup-completed event for.
  const targetId = [...engine.nodeMap.values()][5].id;
  await peer.lookup(targetId);

  // Give the event loop a turn.
  await new Promise(r => setTimeout(r, 5));

  check('at least one event delivered', received.length > 0);
  if (received.length > 0) {
    const matches = received.filter(ev =>
      ev.nodeId    === someNode.id ||
      ev.peerId    === someNode.id ||
      ev.observerId === someNode.id ||
      ev.sourceId  === someNode.id ||
      ev.type === 'cycle-snapshot'
    );
    check('all received events relate to this peer (or are global)',
      matches.length === received.length);
  }

  unsub();
  await peer.stop();
}

async function testStub() {
  console.log('\n── Phase-1 stubs (join throws, leave no-ops) ──');
  const engine = await buildEngine();
  const someNode = [...engine.nodeMap.values()][0];
  const peer = new NHOnePeer({ engine, node: someNode });

  let joined = null;
  try { await peer.join({ kind: 'simulator', sim: engine, sponsorId: 0n }); }
  catch (err) { joined = err.message; }
  check('join() throws Phase-1-not-implemented',
    joined && joined.includes('Phase 1'));

  let threw = false;
  try { await peer.leave(); } catch { threw = true; }
  check('leave() returns silently (Phase 1)', !threw);
}

async function main() {
  console.log('NHOnePeer Phase 1 smoke test');
  console.log(`Node count: ${NODE_COUNT}, k=20, α=3`);
  await testConstruction();
  await testLifecycle();
  await testIdentity();
  await testObservability();
  await testLookupDelegation();
  await testEventForwarding();
  await testStub();
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('smoke test threw:', err);
  process.exit(2);
});
