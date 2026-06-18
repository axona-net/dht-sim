// =====================================================================
// smoke_kernel_integration.mjs — verify @axona/protocol kernel modules
//                                 load and work end-to-end inside the
//                                 dht-sim node environment.
//
// This is the I1 acceptance smoke for the kernel-driven 'axona' protocol
// path.  Demonstrates:
//   1. Kernel imports resolve from dht-sim's node_modules
//   2. SimNetwork + simTransport bind multiple peers in-process
//   3. AxonaPeer constructs + start + standalone join works
//   4. Two peers can establish a channel + exchange a direct message
//   5. Identity derivation + signed envelope build works in this env
//   6. Wire-version handshake module is accessible
//
// What this DOES NOT yet do (deferred to a follow-up integration commit):
//   - Drive the full simulator benchmark loop via the kernel's AxonaPeer.
//     Today's benchmarks tick through AxonaEngine (god's-eye); the
//     transport-based path needs an engine adapter that doesn't exist
//     yet. See dht-sim/src/main.js: the 'axona' protocol case there
//     points at this file as the proof the kernel is wired in.
//
// Run:  node test/smoke_kernel_integration.mjs
// =====================================================================

import {
  SimNetwork, simTransport,
  AxonaPeer,
  createNodeIdentity,
  buildEnvelope, verifyEnvelope,
  WIRE_VERSION,
  KERNEL_VERSION,
} from '@axona/protocol';

let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}`); failed++; }
}

const LONDON = { lat: 51.5074, lng: -0.1278 };
const TOKYO  = { lat: 35.6762, lng: 139.6503 };

function testKernelLoads() {
  console.log('\n── kernel modules load from dht-sim/node_modules ──');
  check('WIRE_VERSION is a string',   typeof WIRE_VERSION === 'string');
  check('KERNEL_VERSION is a string', typeof KERNEL_VERSION === 'string');
  check('SimNetwork is a class',          typeof SimNetwork === 'function');
  check('simTransport is a factory',      typeof simTransport === 'function');
  check('AxonaPeer is a class',           typeof AxonaPeer === 'function');
  check('createNodeIdentity is async fn', typeof createNodeIdentity === 'function');
}

async function testIdentityAndEnvelope() {
  console.log('\n── identity + envelope works in dht-sim env ──');
  const id = await createNodeIdentity(LONDON);
  check('identity has 66-char hex id',
    typeof id.id === 'string' && id.id.length === 66);
  check('identity has pubkey + privkey',
    id.pubkey instanceof Uint8Array && id.privateKey != null);

  const env = await buildEnvelope({
    // Envelope v3: topic is the structured DESCRIPTOR { region, owner, name, write }
    // (signed, so verifyEnvelope can recompute the topic id + enforce write policy).
    topic: { region: 'useast', owner: null, name: 'integration-test', write: 'open' },
    message: { hello: 'from dht-sim' },
    identity: id,
  });
  check('envelope built with content msgId',
    typeof env.msgId === 'string' && env.msgId.length === 64);
  check('envelope signed by default',
    env.signature?.startsWith('ed25519:'));

  const r = await verifyEnvelope(env);
  check('envelope verifies inside dht-sim', r.ok === true);
}

async function testTwoPeerDirectMessage() {
  console.log('\n── two peers exchange a direct message via Transport.sim ──');
  const aliceId = await createNodeIdentity(LONDON);
  const bobId   = await createNodeIdentity(TOKYO);

  const network        = new SimNetwork();
  const aliceTransport = simTransport({ network, identity: aliceId, heartbeatMs: 0 });
  const bobTransport   = simTransport({ network, identity: bobId,   heartbeatMs: 0 });

  await aliceTransport.start(aliceId.id);
  await bobTransport.start(bobId.id);
  await aliceTransport.openConnection(bobId.id);

  const alice = new AxonaPeer({
    engine:    { onEvent: () => () => {} },
    node:      { id: aliceId.id, alive: true, synaptome: new Map() },
    nodeIdentity: aliceId,
    transport: aliceTransport,
  });
  const bob = new AxonaPeer({
    engine:    { onEvent: () => () => {} },
    node:      { id: bobId.id, alive: true, synaptome: new Map() },
    nodeIdentity: bobId,
    transport: bobTransport,
  });

  await alice.start();
  await bob.start();

  let bobReceived = null;
  bob.onMessage((senderId, msg) => {
    bobReceived = { senderId, msg };
    return { ok: true, by: 'bob' };
  });

  const reply = await alice.send(bobId.id, { hi: 'from alice' });
  check('alice send → bob handler → reply',
    reply?.by === 'bob');
  check('bob saw alice as sender',
    bobReceived?.senderId === aliceId.id);
  check('bob saw the message payload',
    bobReceived?.msg?.hi === 'from alice');

  await alice.leave({ drain: false, notify: false });
  await bob.leave({  drain: false, notify: false });
}

async function testStandaloneJoin() {
  console.log('\n── AxonaPeer.join() (standalone, no sponsor) ──');
  const id = await createNodeIdentity(LONDON);
  const network = new SimNetwork();
  const transport = simTransport({ network, identity: id, heartbeatMs: 0 });

  const peer = new AxonaPeer({
    engine: { onEvent: () => () => {} },
    node:   { id: id.id, alive: true, synaptome: new Map() },
    nodeIdentity: id,
    transport,
  });
  await peer.join();        // standalone — start + open transport
  check('peer started after join()',     peer._started === true);
  check('transport started',             transport._started === true);
  check('peers() is empty (no sponsor)', peer.peers().length === 0);
  check('peer can call health()',        typeof peer.health().synaptomeSize === 'number');

  await peer.leave({ drain: false, notify: false });
}

async function main() {
  console.log(`dht-sim ↔ @axona/protocol kernel integration smoke`);
  console.log(`kernel version: ${KERNEL_VERSION} · wire: ${WIRE_VERSION}\n`);
  testKernelLoads();
  await testIdentityAndEnvelope();
  await testTwoPeerDirectMessage();
  await testStandaloneJoin();
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error('integration smoke threw:', err); process.exit(2); });
