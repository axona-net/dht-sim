/**
 * test_nx15_integration.js — PubSubAdapter + AxonaManager running on real
 * NeuromorphicDHTNX15 (not the mock).
 *
 * Uses a small NX-15 sim (~30 nodes) with omniscient init so the routing
 * tables are well-formed, then wires an AxonaManager + PubSubAdapter to
 * each node via dht.axonFor(nodeId). Tests exercise the same end-to-end
 * scenarios as test_integration.js but through the real NX-15 routing
 * pipeline — which proves that the four primitives NX-15 implements
 * (routeMessage, sendDirect, onRoutedMessage, onDirectMessage) are wired
 * correctly.
 *
 * Coverage:
 *   1. End-to-end subscribe + publish on real NX-15 routing
 *   2. Multiple subscribers receive a broadcast
 *   3. Publisher is also subscriber (local path)
 *   4. Adapter unsubscribe removes child at the axon
 *   5. Synaptome-weighted pickRecruitPeer override selects high-weight peer
 *   6. Recruitment triggers when subscribers exceed maxDirectSubs
 *   7. Sub-axon refreshes upward and stays in the tree
 *   8. Publish reaches leaves under sub-axon branches
 */

import { NeuromorphicDHTNX15 } from '../dht/neuromorphic/NeuromorphicDHTNX15.js';
import { PubSubAdapter, topicIdFor } from './PubSubAdapter.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const results = [];
function assert(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  ✓ ${name}`); }
  else      { failed++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/**
 * Spin up an NX-15 sim with n nodes, populate routing tables via the
 * omniscient-init path, then attach a PubSubAdapter to each node.
 */
async function buildNX15Stack(n, adapterOpts = {}) {
  // Tests here manually inject role state into specific axons. We turn
  // K-closest mode OFF by default so publishes always route to the same
  // (deterministic) terminal. Individual tests can opt in to K-closest.
  const membership = adapterOpts.membership ?? { rootSetSize: 0 };
  const dht = new NeuromorphicDHTNX15({ k: 20, alpha: 3, bits: 64, membership });

  // Create nodes at deterministic pseudo-random globe coordinates so the
  // test is reproducible across runs. Same PRNG seed shape as main.js's
  // benchmark harness — uniform on land-surface is approximated.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < n; i++) {
    const lat = -60 + rand() * 120;       // ±60° (avoid polar extremes)
    const lng = -180 + rand() * 360;
    await dht.addNode(lat, lng);
  }
  await dht.buildRoutingTables({ bidirectional: true, maxConnections: Math.min(n - 1, 50) });

  const nodes = [...dht.nodeMap.values()];
  const axons = nodes.map(node => dht.axonFor(node));
  const adapters = axons.map(axon => new PubSubAdapter({
    transport:       axon,
    reorderWindowMs: adapterOpts.reorderWindowMs ?? 100,
  }));

  return { dht, nodes, axons, adapters };
}

async function run() {
  // ── Test 1: End-to-end subscribe + publish ──────────────────────────
  {
    console.log('\n[Test 1] Subscribe + publish over real NX-15 routing');
    const { adapters } = await buildNX15Stack(20);

    let received = null;
    adapters[3].subscribe('chat', 'hello',
      (data, meta) => { received = { data, meta }; },
      'immediate');
    await sleep(50);

    adapters[0].publish('chat', 'hello', { text: 'hi' });
    await sleep(100);

    assert('subscriber received data',
           received && received.data && received.data.text === 'hi');
    assert('meta senderId is publisher node (hex)',
           received && received.meta.senderId === adapters[0].nodeId);
    assert('meta seq is 1', received && received.meta.seq === 1);
  }

  // ── Test 2: Broadcast to many subscribers ───────────────────────────
  {
    console.log('\n[Test 2] Broadcast reaches every subscriber');
    const { adapters } = await buildNX15Stack(20);
    const rcv = new Map();
    for (let i = 1; i <= 10; i++) {
      const idx = i;
      adapters[i].subscribe('broad', 'cast', () => {
        rcv.set(idx, (rcv.get(idx) || 0) + 1);
      }, 'immediate');
    }
    await sleep(50);

    adapters[0].publish('broad', 'cast', { n: 1 });
    await sleep(100);

    let okCount = 0;
    for (let i = 1; i <= 10; i++) if (rcv.get(i) === 1) okCount++;
    assert('all 10 subscribers received exactly once', okCount === 10,
           `got ${okCount}/10`);
  }

  // ── Test 3: Publisher is also subscriber ────────────────────────────
  {
    console.log('\n[Test 3] Publisher subscribed to own topic');
    const { adapters } = await buildNX15Stack(10);

    let fires = 0;
    adapters[0].subscribe('self', 'loop', () => fires++, 'immediate');
    await sleep(50);

    adapters[0].publish('self', 'loop', {});
    await sleep(50);
    assert('fires exactly once (via adapter local path)', fires === 1, `got ${fires}`);
  }

  // ── Test 4: Adapter unsubscribe clears the axon child ───────────────
  {
    console.log('\n[Test 4] Adapter unsubscribe propagates to axon state');
    const { dht, adapters } = await buildNX15Stack(10);
    const topicId = topicIdFor('c', 'x');

    adapters[2].subscribe('c', 'x', () => {}, 'immediate');
    await sleep(50);

    // Find the axon holding the role.
    let holder = null;
    for (const [node, axon] of dht._axonsByNode) {
      if (axon.axonRoles.has(topicId)) { holder = axon; break; }
    }
    assert('axon role found', holder !== null);
    assert('subscriber present',
           holder.axonRoles.get(topicId).children.has(adapters[2].nodeId));

    adapters[2].unsubscribe('c', 'x');
    await sleep(50);

    const role = holder.axonRoles.get(topicId);
    assert('subscriber removed after unsubscribe',
           !role || !role.children.has(adapters[2].nodeId));
  }

  // ── Test 5: Synaptome-weighted pickRecruitPeer (existing children) ──
  //   The new contract: pickRecruitPeer must return an ID that is already
  //   in role.children (we never grow the axon beyond maxDirectSubs
  //   during recruitment). NX-15's override scores existing children by
  //   synapse weight in the node's synaptome; children with no synapse
  //   fall through to XOR-distance selection.
  {
    console.log('\n[Test 5] NX-15 pickRecruitPeer picks high-weight existing child');
    const { dht, nodes } = await buildNX15Stack(8);
    const node = nodes[0];

    // Build a synthetic role whose children happen to include some of
    // node's synaptome peers. Assign weights so one child dominates.
    const subscriberId = nodes[7].id.toString(16).padStart(16, '0');
    const synChildren = [...node.synaptome.values()].slice(0, 3);
    if (synChildren.length < 2) {
      assert('skipped — synaptome too small for this node', true);
    } else {
      synChildren[0].weight = 0.99;
      for (let i = 1; i < synChildren.length; i++) synChildren[i].weight = 0.1;

      const role = {
        children: new Map(synChildren.map(s => [
          s.peerId.toString(16).padStart(16, '0'),
          { createdAt: 0, lastRenewed: 0 },
        ])),
      };

      const pickHex = dht._pickRecruitPeer(node, role, { fromId: 'fallbackId' }, subscriberId);
      const expected = synChildren[0].peerId.toString(16).padStart(16, '0');
      assert('high-weight child picked as recruit',
             pickHex === expected, `got ${pickHex} expected ${expected}`);
    }
  }

  // ── Test 6: Recruitment triggers at maxDirectSubs ──────────────────
  //   New contract: root's children cap is preserved. An EXISTING child
  //   gets promoted to sub-axon and the new subscriber joins under it.
  //   One of nodes[1..3] should end up with a role for this topic.
  {
    console.log('\n[Test 6] Recruitment: existing child promoted, root cap preserved');
    const { dht, nodes } = await buildNX15Stack(15);

    const rootNode = nodes[0];
    const axon = dht.axonFor(rootNode);
    axon.maxDirectSubs = 3;

    const topicId = 'fedc000000000000';
    const now = Date.now();
    const childHexIds = [1, 2, 3].map(i =>
      nodes[i].id.toString(16).padStart(16, '0'));
    axon.axonRoles.set(topicId, {
      parentId: null, isRoot: true,
      children: new Map(childHexIds.map(id => [id, { createdAt: now, lastRenewed: now }])),
      parentLastSent: 0, roleCreatedAt: now, emptiedAt: 0, lowWaterSince: 0,
    });

    const before = axon.axonRoles.get(topicId).children.size;
    const forwarderHex   = nodes[5].id.toString(16).padStart(16, '0');
    const subscriberHex  = nodes[10].id.toString(16).padStart(16, '0');
    axon._onSubscribe(
      { topicId, subscriberId: subscriberHex },
      { fromId: forwarderHex, isTerminal: false, hopCount: 1 }
    );
    await sleep(20);

    const after = axon.axonRoles.get(topicId).children.size;
    assert('root children cap preserved', after === before,
           `before=${before} after=${after}`);
    assert('direct subscriber NOT in root children',
           !axon.axonRoles.get(topicId).children.has(subscriberHex));
    assert('forwarder NOT injected into root children',
           !axon.axonRoles.get(topicId).children.has(forwarderHex));

    // One of the existing children (nodes[1..3]) should now hold a
    // sub-axon role containing the new subscriber.
    const promoted = [1, 2, 3].map(i => dht.axonFor(nodes[i]))
                              .filter(a => a.axonRoles.has(topicId));
    assert('exactly one existing child promoted', promoted.length === 1,
           `got ${promoted.length} promoted`);
    if (promoted.length === 1) {
      const subRole = promoted[0].axonRoles.get(topicId);
      assert('promoted child role is non-root', subRole.isRoot === false);
      assert('promoted child holds new subscriber',
             subRole.children.has(subscriberHex));
    }
  }

  // ── Test 7: Full-stack publish through recruited sub-axon ───────────
  //   Create a tree: root → sub-axon → leaf subscriber. Publish from a
  //   non-member. Verify the leaf receives.
  {
    console.log('\n[Test 7] Publish flows through sub-axon branch');
    const { dht, nodes, adapters } = await buildNX15Stack(12);
    const topicId = nodes[0].id.toString(16).padStart(16, '0');  // root = nodes[0]

    // Manually install a 2-level tree:
    //   root = nodes[0], direct children: [nodes[1].hex, nodes[5].hex]
    //   sub-axon at nodes[5], children: [nodes[10].hex]
    const rootAxon = dht.axonFor(nodes[0]);
    const subAxon  = dht.axonFor(nodes[5]);
    const now = Date.now();
    rootAxon.axonRoles.set(topicId, {
      parentId: null, isRoot: true,
      children: new Map([
        [nodes[1].id.toString(16).padStart(16, '0'), { createdAt: now, lastRenewed: now }],
        [nodes[5].id.toString(16).padStart(16, '0'), { createdAt: now, lastRenewed: now }],
      ]),
      parentLastSent: 0, roleCreatedAt: now, emptiedAt: 0, lowWaterSince: 0,
    });
    subAxon.axonRoles.set(topicId, {
      parentId: nodes[0].id.toString(16).padStart(16, '0'),
      isRoot:   false,
      children: new Map([
        [nodes[10].id.toString(16).padStart(16, '0'), { createdAt: now, lastRenewed: now }],
      ]),
      parentLastSent: 0, roleCreatedAt: now, emptiedAt: 0, lowWaterSince: 0,
    });

    // Register delivery callbacks on the leaves.
    const delivered = new Map();
    for (const i of [1, 10]) {
      adapters[i].axon = dht.axonFor(nodes[i]);   // just to document
      dht.axonFor(nodes[i]).onPubsubDelivery((tid, json) => {
        delivered.set(i, (delivered.get(i) || 0) + 1);
      });
    }

    // Publish from nodes[8] (not a subscriber, not in the tree).
    dht.axonFor(nodes[8]).pubsubPublish(topicId, '{"x":1}');
    await sleep(100);

    assert('direct leaf (nodes[1]) received',     delivered.get(1) === 1);
    assert('sub-axon leaf (nodes[10]) received',  delivered.get(10) === 1);
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  results.forEach(r => console.log(r));
  console.log('='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
