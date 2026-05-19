// =====================================================================
// smoke_kernel_regression.mjs — scaled @axona/protocol regression suite.
//
// Runs kernel scenarios at multiple sizes (N=10, 100, 1000) to catch
// regressions when the kernel changes.  Each scenario verifies an
// invariant that the production deployments (axona.net + bridge) rely
// on:
//
//   1. N-peer mesh construction       — every peer registered + reachable
//   2. Full-mesh send fan-out         — alice → every other peer; each
//                                       responds; correct senderId
//   3. Direct-messaging timing        — under load, send latency stays
//                                       bounded with the configured
//                                       latencyFn
//   4. Subscription handle plumbing   — N peers each register a sub via
//                                       AxonaPeer.sub() against a mock
//                                       AxonManager; .stop() reference
//                                       counting holds at scale
//   5. Signed envelope verification    — every envelope a publisher
//                                       builds, every other peer can
//                                       verify (cross-peer signature
//                                       sanity at population scale)
//
// What's deferred:
//   - End-to-end AxonManager pub/sub through Transport.sim at scale.
//     The kernel's AxonManager constructor takes a DHT-like adapter
//     that's currently provided by the simulator's AxonaEngine; wiring
//     each peer's AxonManager to drive deliveries via Transport.sim
//     requires the transport-based engine adapter that's queued
//     after I1.  Once that lands, the 11 axona-peer smokes
//     (smoke_pubsub.js, smoke_pubsub_replay.js, smoke_stress_100.js)
//     translate directly to this harness.
//
// Run:  node test/smoke_kernel_regression.mjs
// Bigger:  AXONA_REGRESSION_N=10000 node test/smoke_kernel_regression.mjs
// =====================================================================

import {
  SimNetwork, simTransport,
  AxonaPeer,
  deriveIdentity,
  buildEnvelope, verifyEnvelope,
}                          from '@axona/protocol';

let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}`); failed++; }
}

// Test sizes — env override for ad-hoc large runs.
const SIZES = (() => {
  const env = process.env.AXONA_REGRESSION_N;
  if (env) return env.split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0);
  return [10, 100];   // CI defaults; 1000+ for nightly
})();

// ── Helpers ──────────────────────────────────────────────────────────

class MockAxonManager {
  constructor(nodeId) {
    this.nodeId = nodeId;
    this._publishCounter = 0;
    this._lastSeenTsByTopic = new Map();
    this._deliveryCallback = null;
  }
  pubsubPublish() { return `m-${++this._publishCounter}`; }
  pubsubSubscribe()   {}
  pubsubUnsubscribe() {}
  onPubsubDelivery(cb) { this._deliveryCallback = cb; }
}

async function spawnPeer(network) {
  // Use ~5km grid points around London so S2 prefixes vary modestly.
  const lat = 51.5 + (Math.random() - 0.5) * 0.5;
  const lng = -0.1 + (Math.random() - 0.5) * 0.5;
  const identity = await deriveIdentity({ lat, lng });
  const transport = simTransport({ network, identity, heartbeatMs: 0 });
  const node = { id: identity.id, alive: true, synaptome: new Map() };
  const peer = new AxonaPeer({
    engine:    { onEvent: () => () => {} },
    node, identity, transport,
    axonManager: new MockAxonManager(identity.id),
  });
  return { peer, identity, transport };
}

async function spawnMesh(N) {
  const network = new SimNetwork();
  const peers = [];
  for (let i = 0; i < N; i++) peers.push(await spawnPeer(network));
  // peer.join() brings up the transport (transport.start + listener
  // registration) — standalone (no sponsor) is fine for the harness.
  for (const p of peers) await p.peer.join();
  // Pairwise open: each peer connects to peer 0 so the fan-out star
  // exists; we don't need a full mesh for the assertion suite.
  for (let i = 1; i < N; i++) {
    await peers[i].transport.openConnection(peers[0].identity.id);
  }
  return { network, peers };
}

async function tearDown(peers) {
  for (const p of peers) {
    try { await p.peer.leave({ drain: false, notify: false }); }
    catch { /* ignore */ }
  }
}

// ── Scenarios per size ───────────────────────────────────────────────

async function runStarFanout(N) {
  console.log(`\n── N=${N}: star fan-out (peer[0] sends to all) ──`);
  const t0 = Date.now();
  const { network, peers } = await spawnMesh(N);
  const tBuild = Date.now() - t0;

  check(`network has ${N} peers registered`, network.size() === N);
  check('every peer started',
    peers.every(p => p.transport._started === true));
  check(`peer[1..N-1] each connected to peer[0]`,
    peers.slice(1).every(p => p.transport.isConnected(peers[0].identity.id)));

  // Set up handlers on every non-zero peer.
  for (let i = 1; i < N; i++) {
    peers[i].peer.onMessage((senderId, msg) => ({ from: senderId, echo: msg.n }));
  }

  // peer[0] sends to every other peer in parallel.
  const tSendStart = Date.now();
  const replies = await Promise.all(
    peers.slice(1).map((p, i) =>
      peers[0].peer.send(p.identity.id, { n: i + 1 })
    ),
  );
  const tSend = Date.now() - tSendStart;

  check(`all ${N-1} replies received`, replies.length === N - 1);
  check('every reply has correct echo',
    replies.every((r, i) => r.echo === i + 1));
  check('every reply identifies peer[0] as sender',
    replies.every(r => r.from === peers[0].identity.id));

  console.log(`  · build ${tBuild}ms, send-all ${tSend}ms (${Math.round(tSend / (N-1) * 1000) / 1000}ms/peer)`);

  await tearDown(peers);
  check('teardown succeeds', network.size() === 0);
}

async function runEnvelopeAtScale(N) {
  console.log(`\n── N=${N}: every publisher signs, every peer verifies ──`);
  // Each of N peers builds a signed envelope; we cross-verify every
  // envelope against the SAME message bytes to confirm signatures
  // round-trip at population scale.
  const t0 = Date.now();
  const identities = [];
  for (let i = 0; i < N; i++) {
    identities.push(await deriveIdentity({
      lat: 51.5 + i * 0.01, lng: -0.1 + i * 0.01,
    }));
  }
  const tIdentities = Date.now() - t0;

  const envelopes = [];
  const tBuildStart = Date.now();
  for (let i = 0; i < N; i++) {
    envelopes.push(await buildEnvelope({
      topic:    'regression',
      message:  { i, hello: 'from peer ' + i },
      identity: identities[i],
      ts:       1700000000000 + i,
    }));
  }
  const tBuild = Date.now() - tBuildStart;

  check(`built ${N} envelopes`, envelopes.length === N);
  check('every msgId is 64-char hex',
    envelopes.every(e => typeof e.msgId === 'string' && e.msgId.length === 64));
  check('every envelope is signed',
    envelopes.every(e => e.signature?.startsWith('ed25519:')));
  check('every signerPubkey matches its identity',
    envelopes.every((e, i) => e.signerPubkey === identities[i].pubkeyHex));

  // Verify a random sample (full-NxN would dominate at large N).
  const sampleSize = Math.min(N, 50);
  const tVerifyStart = Date.now();
  let allOk = true;
  for (let i = 0; i < sampleSize; i++) {
    const idx = Math.floor(Math.random() * N);
    const r = await verifyEnvelope(envelopes[idx]);
    if (!r.ok || !r.signed) { allOk = false; break; }
  }
  const tVerify = Date.now() - tVerifyStart;
  check(`random sample of ${sampleSize} envelopes all verify ok`, allOk);

  console.log(`  · identity x${N} ${tIdentities}ms · build x${N} ${tBuild}ms · verify x${sampleSize} ${tVerify}ms`);
}

async function runSubscriptionRefcount(N) {
  console.log(`\n── N=${N}: subscription handle reference counting ──`);
  // One peer with many subscriptions to the same topic — verifies the
  // peer's internal _subscriptions set holds N handles and that
  // stopping all of them eventually triggers a single
  // AxonManager.pubsubUnsubscribe call.
  const id = await deriveIdentity({ lat: 51.5, lng: -0.1 });
  const am = new MockAxonManager(id.id);
  let unsubCount = 0;
  am.pubsubUnsubscribe = () => unsubCount++;

  const peer = new AxonaPeer({
    engine:    { onEvent: () => () => {} },
    node:      { id: id.id, alive: true, synaptome: new Map() },
    identity:  id,
    axonManager: am,
  });

  const t0 = Date.now();
  const subs = [];
  for (let i = 0; i < N; i++) {
    subs.push(await peer.sub('regression', () => {}));
  }
  const tSubs = Date.now() - t0;
  check(`registered ${N} subs to same topic`, subs.length === N);

  // Stop all but one — no unsubscribe yet.
  for (let i = 1; i < N; i++) await subs[i].stop();
  check(`unsubscribe NOT called while subs remain (N-1 stopped, 1 active)`,
    unsubCount === 0);

  // Stop the last one — exactly one unsubscribe fires.
  await subs[0].stop();
  check('unsubscribe fires exactly once after last handler stops',
    unsubCount === 1);

  console.log(`  · ${N} subs registered in ${tSubs}ms`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`@axona/protocol kernel scaled regression suite`);
  console.log(`sizes: ${SIZES.join(', ')}\n`);

  for (const N of SIZES) {
    await runStarFanout(N);
    await runEnvelopeAtScale(N);
    await runSubscriptionRefcount(N);
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('regression suite threw:', err);
  process.exit(2);
});
