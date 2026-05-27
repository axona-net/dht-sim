/**
 * test_axon.js — AxonaManager (Phase 3a) membership protocol tests.
 *
 *   1. First subscribe → terminal node becomes root for the topic
 *   2. Non-root nodes forward subscribe (no role created)
 *   3. Multiple subscribers attach to the same root
 *   4. Renewal: re-subscribing bumps lastRenewed on existing child
 *   5. Publish routed by publisher → axon fans out to all children
 *   6. Publisher is not a child: still routes toward hash, axon delivers
 *   7. Self-subscribe + self-publish: local delivery via axon fan-out
 *   8. Unsubscribe removes the child from the axon's role
 *   9. TTL sweep drops children whose lastRenewed is too old
 *  10. Refresh keeps a subscription alive past the TTL window
 *  11. Empty non-root axon is GCed on next sweep (even though no recruitment in 3a)
 *  12. Empty root persists for rootGraceMs before GC
 *  13. refreshTick() re-issues subscribes for all mySubscriptions
 */

import { MockDHTNetwork } from './MockDHTNode.js';
import { AxonaManager } from './AxonaManager.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const results = [];
function assert(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  ✓ ${name}`); }
  else      { failed++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/**
 * Build a network of nodes, each with an AxonaManager attached.
 * Returns { net, nodes, axons } where axons[i] drives nodes[i].
 */
function buildAxonNetwork(n, opts = {}) {
  // Use a routing table that sees every peer so all subscribers converge
  // on the true closest-to-hash terminal. A realistic partial-mesh
  // routing table is studied under Phase 3c (churn + routing quality).
  const netOpts = { routingTableSize: n - 1, ...(opts.network || {}) };
  const net = new MockDHTNetwork(netOpts);
  const nodes = [];
  const axons = [];
  for (let i = 0; i < n; i++) {
    // Deterministic IDs — the test harness uses i+1 in hex so the root
    // for any topicId is predictable, avoiding flakes where the root
    // happens to coincide with a subscribed/killed node.
    const id = (i + 1).toString(16).padStart(16, '0');
    const node = net.createNode(id);
    nodes.push(node);
  }
  net.rebuildRoutingTables();
  // Attach an axon manager to each node AFTER the routing tables are built
  // so the handler registration lands on the finished topology.
  for (const node of nodes) {
    const axon = new AxonaManager({
      dht: node,
      maxDirectSubs:        opts.maxDirectSubs        ?? 20,
      minDirectSubs:        opts.minDirectSubs        ?? 5,
      refreshIntervalMs:    opts.refreshIntervalMs    ?? 100000,   // tests drive manually
      maxSubscriptionAgeMs: opts.maxSubscriptionAgeMs ?? 30000,
      rootGraceMs:          opts.rootGraceMs          ?? 60000,
      rootSetSize:          opts.rootSetSize          ?? 0,        // routed mode by default
      now:                  opts.now || (() => Date.now()),
    });
    axons.push(axon);
  }
  return { net, nodes, axons };
}

/** Helper: find the axon for topicId — i.e., the one that holds its role. */
function findRootFor(axons, topicId) {
  return axons.find(a => a.axonRoles.has(topicId));
}

async function run() {
  // ── Test 1: Subscribe → root created at terminal ────────────────────
  {
    console.log('\n[Test 1] First subscribe creates root at terminal node');
    const topicId = 'aaaaaaaaaaaaaaaa';
    const { nodes, axons } = buildAxonNetwork(15);

    axons[0].pubsubSubscribe(topicId);
    await sleep(200);   // let the routed subscribe walk the network

    const roots = axons.filter(a => a.axonRoles.has(topicId));
    assert('exactly one root for the topic', roots.length === 1);
    const root = roots[0];
    const role = root.axonRoles.get(topicId);
    assert('root is marked isRoot', role.isRoot === true);
    assert('root has subscriber in children', role.children.has(nodes[0].id));
    assert('child has timestamps',
           role.children.get(nodes[0].id).createdAt > 0 &&
           role.children.get(nodes[0].id).lastRenewed > 0);
  }

  // ── Test 2: Intermediate hops do not create roles ────────────────────
  {
    console.log('\n[Test 2] Forwarding nodes do not create roles');
    const topicId = 'bbbbbbbbbbbbbbbb';
    const { axons } = buildAxonNetwork(20);

    axons[0].pubsubSubscribe(topicId);
    await sleep(200);

    const holders = axons.filter(a => a.axonRoles.has(topicId));
    assert('only one node holds the role', holders.length === 1);
  }

  // ── Test 3: Multiple subscribers attach to same root ─────────────────
  {
    console.log('\n[Test 3] Multiple subscribers attach to same root');
    const topicId = 'cccccccccccccccc';
    const { nodes, axons } = buildAxonNetwork(20);

    for (let i = 0; i < 5; i++) axons[i].pubsubSubscribe(topicId);
    await sleep(300);

    const root = findRootFor(axons, topicId);
    assert('root exists', !!root);
    assert('root has all 5 subscribers', root.axonRoles.get(topicId).children.size === 5);
    for (let i = 0; i < 5; i++) {
      assert(`child ${i} recorded`,
             root.axonRoles.get(topicId).children.has(nodes[i].id));
    }
  }

  // ── Test 4: Renewal bumps lastRenewed ────────────────────────────────
  {
    console.log('\n[Test 4] Re-subscribe bumps lastRenewed');
    let t = 1000;
    const now = () => t;
    const topicId = 'dddddddddddddddd';
    const { nodes, axons } = buildAxonNetwork(10, { now });

    axons[0].pubsubSubscribe(topicId);
    await sleep(100);
    const root = findRootFor(axons, topicId);
    const initial = root.axonRoles.get(topicId).children.get(nodes[0].id).lastRenewed;

    t = 5000;
    axons[0].pubsubSubscribe(topicId);   // renewal
    await sleep(100);
    const bumped  = root.axonRoles.get(topicId).children.get(nodes[0].id).lastRenewed;

    assert('lastRenewed bumped', bumped > initial);
    assert('still only one subscriber entry', root.axonRoles.get(topicId).children.size === 1);
  }

  // ── Test 5: Publish fans out ─────────────────────────────────────────
  {
    console.log('\n[Test 5] Publish routed toward topic hash, axon fans out');
    const topicId = 'eeeeeeeeeeeeeeee';
    const { axons } = buildAxonNetwork(20);

    const received = new Map();
    for (let i = 0; i < 5; i++) {
      axons[i].onPubsubDelivery((tid, json) => {
        if (!received.has(i)) received.set(i, []);
        received.get(i).push({ tid, json });
      });
      axons[i].pubsubSubscribe(topicId);
    }
    await sleep(300);

    // Publisher is a separate node (index 10 — not a subscriber).
    axons[10].pubsubPublish(topicId, JSON.stringify({ hello: 'world' }));
    await sleep(300);

    // All 5 subscribers should have received it exactly once.
    for (let i = 0; i < 5; i++) {
      const list = received.get(i) || [];
      assert(`subscriber ${i} received exactly 1 message`, list.length === 1,
             `got ${list.length}`);
      if (list.length > 0) {
        const parsed = JSON.parse(list[0].json);
        assert(`subscriber ${i} received correct data`, parsed.hello === 'world');
      }
    }
  }

  // ── Test 6: Non-subscriber publisher works ───────────────────────────
  {
    console.log('\n[Test 6] Publisher is not a subscriber — still works');
    const topicId = 'ffffffffffffffff';
    const { axons } = buildAxonNetwork(15);

    let fired = 0;
    axons[0].onPubsubDelivery(() => fired++);
    axons[0].pubsubSubscribe(topicId);
    await sleep(150);

    axons[5].pubsubPublish(topicId, '{"x":1}');
    await sleep(200);
    assert('non-subscriber publish reaches subscriber', fired === 1);
  }

  // ── Test 7: Publisher is also a subscriber (local delivery) ──────────
  {
    console.log('\n[Test 7] Publisher is also a subscriber — local delivery');
    const topicId = '1111111111111111';
    const { axons } = buildAxonNetwork(15);

    let selfFired = 0;
    axons[0].onPubsubDelivery(() => selfFired++);
    axons[0].pubsubSubscribe(topicId);
    await sleep(150);

    axons[0].pubsubPublish(topicId, '{"y":2}');
    await sleep(200);

    // The adapter layer normally filters self-delivery via senderId match,
    // but the axon itself should still produce one delivery callback at
    // the subscriber/publisher node. (At the adapter level it would be
    // filtered; at the raw axon level we see it.)
    assert('self-publish triggers delivery at self',
           selfFired === 1, `fired=${selfFired}`);
  }

  // ── Test 8: Unsubscribe removes the child ────────────────────────────
  {
    console.log('\n[Test 8] Unsubscribe removes child from role');
    const topicId = '2222222222222222';
    const { nodes, axons } = buildAxonNetwork(15);

    axons[0].pubsubSubscribe(topicId);
    axons[1].pubsubSubscribe(topicId);
    await sleep(200);

    const root = findRootFor(axons, topicId);
    assert('2 subscribers before unsubscribe',
           root.axonRoles.get(topicId).children.size === 2);

    axons[0].pubsubUnsubscribe(topicId);
    await sleep(200);

    assert('1 subscriber after unsubscribe',
           root.axonRoles.get(topicId).children.size === 1);
    assert('remaining subscriber is correct',
           root.axonRoles.get(topicId).children.has(nodes[1].id));
  }

  // ── Test 9: TTL sweep drops stale children ───────────────────────────
  {
    console.log('\n[Test 9] TTL sweep drops children whose lastRenewed is too old');
    let t = 1000;
    const now = () => t;
    const topicId = '3333333333333333';
    const { axons } = buildAxonNetwork(10, {
      now, maxSubscriptionAgeMs: 1000,
    });

    axons[0].pubsubSubscribe(topicId);
    await sleep(150);
    const root = findRootFor(axons, topicId);
    assert('subscribed before TTL sweep',
           root.axonRoles.get(topicId).children.size === 1);

    // Advance clock past TTL. Tick the sweep manually.
    t = 3000;
    root.refreshTick();
    assert('stale subscriber swept',
           root.axonRoles.get(topicId).children.size === 0);
  }

  // ── Test 10: Refresh keeps subscription alive ────────────────────────
  {
    console.log('\n[Test 10] Refresh keeps subscription alive past TTL');
    let t = 1000;
    const now = () => t;
    const topicId = '4444444444444444';
    const { axons } = buildAxonNetwork(10, {
      now, maxSubscriptionAgeMs: 1000,
    });

    axons[0].pubsubSubscribe(topicId);
    await sleep(150);
    const root = findRootFor(axons, topicId);

    // Advance clock 800ms (within TTL). Refresh the subscriber's leaf.
    t = 1800;
    axons[0].refreshTick();    // re-issues subscribe via mySubscriptions
    await sleep(150);

    // Advance clock another 800ms (now 1600ms since original sub, but
    // only 800ms since refresh). Sweep.
    t = 2600;
    root.refreshTick();
    assert('refreshed subscriber survives',
           root.axonRoles.get(topicId).children.size === 1);

    // Simulate the subscriber going silent (no more leaf-refresh). This is
    // different from unsubscribe (which would explicitly notify the axon);
    // we model the browser tab closing without a clean goodbye. Without
    // this step the test is flaky: if axons[0] happens to be the terminal
    // for this topic hash then it IS the root, and its own refreshTick
    // would bump the child's lastRenewed before the sweep ran.
    axons[0].mySubscriptions.delete(topicId);

    // Advance past TTL without further refresh.
    t = 4000;
    root.refreshTick();
    assert('unrefreshed subscriber expires',
           root.axonRoles.get(topicId).children.size === 0);
  }

  // ── Test 11: Empty non-root axon GC ──────────────────────────────────
  //    Phase 3a has no recruitment, so every axon is a root by normal
  //    flow. We inject a synthetic non-root role directly (simulating
  //    the state Phase 3b will create) and drive the expiry + GC path.
  {
    console.log('\n[Test 11] Empty non-root role is GCed on sweep');
    let t = 1000;
    const now = () => t;
    const topicId = '5555555555555555';
    const { nodes, axons } = buildAxonNetwork(5, { now, maxSubscriptionAgeMs: 500 });

    // Inject a synthetic non-root role that is already empty. The guard
    // we added to refreshTick (skip axon-refresh when children.size==0)
    // plus the GC step together should remove the empty role in one
    // tick, which is what the Phase 3b orderly-collapse machinery will
    // rely on in production flow.
    const target = axons[2];
    target.axonRoles.set(topicId, {
      parentId:       nodes[0].id,
      isRoot:         false,
      children:       new Map(),      // empty
      parentLastSent: 0,
      roleCreatedAt:  0,
      emptiedAt:      0,
    });

    t = 2000;
    target.refreshTick();
    assert('non-root empty role removed', !target.axonRoles.has(topicId));
  }

  // ── Test 12: Empty root grace period ─────────────────────────────────
  {
    console.log('\n[Test 12] Empty root persists for rootGraceMs');
    let t = 1000;
    const now = () => t;
    const topicId = '6666666666666666';
    const { axons } = buildAxonNetwork(5, {
      now, rootGraceMs: 5000, maxSubscriptionAgeMs: 60000,
    });

    axons[0].pubsubSubscribe(topicId);
    await sleep(100);
    const root = findRootFor(axons, topicId);
    assert('root exists', !!root);

    // Unsubscribe the only subscriber.
    axons[0].pubsubUnsubscribe(topicId);
    await sleep(100);
    assert('children empty', root.axonRoles.get(topicId).children.size === 0);
    assert('emptiedAt was set', root.axonRoles.get(topicId).emptiedAt > 0);

    // Advance clock 3 seconds — within grace period. Root should persist.
    t = 4000;
    root.refreshTick();
    assert('root persists within grace', root.axonRoles.has(topicId));

    // Advance past grace. Root should dissolve.
    t = 10000;
    root.refreshTick();
    assert('root dissolves past grace', !root.axonRoles.has(topicId));
  }

  // ── Test 13: refreshTick re-issues subscribes ────────────────────────
  {
    console.log('\n[Test 13] refreshTick re-issues subscribes for all mySubscriptions');
    let t = 1000;
    const now = () => t;
    const topicId = '7777777777777777';
    const { axons } = buildAxonNetwork(10, { now });

    axons[0].pubsubSubscribe(topicId);
    await sleep(150);
    const root = findRootFor(axons, topicId);
    const initial = [...root.axonRoles.get(topicId).children.values()][0].lastRenewed;

    // Advance clock and tick refresh. The re-subscribe should update lastRenewed.
    t = 5000;
    axons[0].refreshTick();
    await sleep(150);

    const bumped = [...root.axonRoles.get(topicId).children.values()][0].lastRenewed;
    assert('lastRenewed bumped by refreshTick', bumped > initial,
           `initial=${initial} bumped=${bumped}`);
  }

  // ── Test 14: Recruitment — axon at cap promotes existing child ──────
  {
    console.log('\n[Test 14] Recruitment: existing child promoted (root cap unchanged)');
    const topicId = '8888888888888888';
    const { nodes, axons } = buildAxonNetwork(10, { maxDirectSubs: 3 });

    // Hand-install a root role with exactly 3 children so the next
    // subscribe triggers recruitment. Deterministic IDs (0x02, 0x03, 0x04)
    // mean we can compute which child will be promoted for subscriber
    // nodes[4].id (0x05): XOR distances are 0x07, 0x06, 0x01 — so
    // nodes[3] (0x04) is closest.
    const root = axons[0];
    const now = Date.now();
    root.axonRoles.set(topicId, {
      parentId:       null,
      isRoot:         true,
      children:       new Map([
        [nodes[1].id, { createdAt: now, lastRenewed: now }],
        [nodes[2].id, { createdAt: now, lastRenewed: now }],
        [nodes[3].id, { createdAt: now, lastRenewed: now }],
      ]),
      parentLastSent: 0,
      roleCreatedAt:  now,
      emptiedAt:      0,
      lowWaterSince:  0,
    });

    root._onSubscribe(
      { topicId, subscriberId: nodes[4].id },
      { fromId: nodes[5].id, isTerminal: false, hopCount: 1 }
    );

    assert('root children cap preserved (still 3, not grown)',
           root.axonRoles.get(topicId).children.size === 3);
    assert('new subscriber NOT added to root children',
           !root.axonRoles.get(topicId).children.has(nodes[4].id));
    assert('forwarder NOT added to root children (since not already present)',
           !root.axonRoles.get(topicId).children.has(nodes[5].id));

    await sleep(50);

    // The existing child with smallest XOR to nodes[4] is nodes[3]
    // (d=0x01 vs 0x06 and 0x07 for nodes[2] and nodes[1]).
    const recruit = axons[3];
    assert('XOR-closest existing child got the promote-axon',
           recruit.axonRoles.has(topicId));
    const recruitRole = recruit.axonRoles.get(topicId);
    assert('recruit role is non-root',      recruitRole.isRoot === false);
    assert('recruit parentId is promoter',  recruitRole.parentId === nodes[0].id);
    assert('recruit has new subscriber as child',
           recruitRole.children.has(nodes[4].id));
  }

  // ── Test 15: Two new subscribers to same sub-axon ───────────────────
  {
    console.log('\n[Test 15] Two subscribers routed via same existing-child recruit');
    const topicId = '9999999999999999';
    const { nodes, axons } = buildAxonNetwork(10, { maxDirectSubs: 2 });

    // Pre-populate root with 2 children (nodes[1]=0x02, nodes[2]=0x03).
    // New subscribers nodes[4] (0x05) and nodes[6] (0x07).
    //   XOR(nodes[1], nodes[4]) = 0x07 | XOR(nodes[2], nodes[4]) = 0x06 → nodes[2] chosen.
    //   XOR(nodes[1], nodes[6]) = 0x05 | XOR(nodes[2], nodes[6]) = 0x04 → nodes[2] chosen.
    // Both delegated to nodes[2].
    const root = axons[0];
    const now = Date.now();
    root.axonRoles.set(topicId, {
      parentId: null, isRoot: true,
      children: new Map([
        [nodes[1].id, { createdAt: now, lastRenewed: now }],
        [nodes[2].id, { createdAt: now, lastRenewed: now }],
      ]),
      parentLastSent: 0, roleCreatedAt: now, emptiedAt: 0, lowWaterSince: 0,
    });

    root._onSubscribe(
      { topicId, subscriberId: nodes[4].id },
      { fromId: nodes[5].id, isTerminal: false });
    root._onSubscribe(
      { topicId, subscriberId: nodes[6].id },
      { fromId: nodes[5].id, isTerminal: false });

    await sleep(50);

    assert('root children cap preserved (still 2)',
           root.axonRoles.get(topicId).children.size === 2);
    const recruit = axons[2];      // nodes[2] is XOR-closest for both subscribers
    assert('recruit has role',
           recruit.axonRoles.has(topicId));
    assert('recruit role holds both delegated subscribers',
           recruit.axonRoles.get(topicId).children.size === 2,
           `size=${recruit.axonRoles.get(topicId).children.size}`);
    assert('subscriber 4 in recruit children',
           recruit.axonRoles.get(topicId).children.has(nodes[4].id));
    assert('subscriber 6 in recruit children',
           recruit.axonRoles.get(topicId).children.has(nodes[6].id));
  }

  // ── Test 16: End-to-end publish reaches sub-axon branch ─────────────
  {
    console.log('\n[Test 16] Publish fans out through sub-axon to leaf subscribers');
    const { nodes, axons } = buildAxonNetwork(10, { maxDirectSubs: 2 });
    const topicId = nodes[0].id;

    // Pre-populate root with [nodes[1]=0x02, nodes[2]=0x03].
    const root = axons[0];
    const now = Date.now();
    root.axonRoles.set(topicId, {
      parentId: null, isRoot: true,
      children: new Map([
        [nodes[1].id, { createdAt: now, lastRenewed: now }],
        [nodes[2].id, { createdAt: now, lastRenewed: now }],
      ]),
      parentLastSent: 0, roleCreatedAt: now, emptiedAt: 0, lowWaterSince: 0,
    });

    // Install a 'pubsub:deliver' direct handler on nodes[1], nodes[2],
    // nodes[4], nodes[6]. Count deliveries per node.
    const delivered = new Map();
    for (const i of [1, 2, 4, 6]) {
      axons[i].onPubsubDelivery((tid, json) => {
        delivered.set(i, (delivered.get(i) || 0) + 1);
      });
    }

    // Add two more subscribers through recruit nodes[5].
    root._onSubscribe({ topicId, subscriberId: nodes[4].id },
                     { fromId: nodes[5].id, isTerminal: false });
    root._onSubscribe({ topicId, subscriberId: nodes[6].id },
                     { fromId: nodes[5].id, isTerminal: false });
    await sleep(50);

    // Publish from an uninvolved node (nodes[7]).
    axons[7].pubsubPublish(topicId, '{"x":1}');
    await sleep(200);

    assert('leaf subscriber 1 (direct at root) received',    delivered.get(1) === 1);
    assert('leaf subscriber 2 (direct at root) received',    delivered.get(2) === 1);
    assert('leaf subscriber 4 (under sub-axon) received',    delivered.get(4) === 1);
    assert('leaf subscriber 6 (under sub-axon) received',    delivered.get(6) === 1);
  }

  // ── Test 17: Hysteresis dissolve — below min → dissolve-hint to children ─
  {
    console.log('\n[Test 17] Non-root axon below minDirectSubs dissolves');
    let t = 1000;
    const now = () => t;
    const topicId = 'bbbb222222222222';
    const { nodes, axons } = buildAxonNetwork(10, {
      now, minDirectSubs: 3, refreshIntervalMs: 500, maxSubscriptionAgeMs: 60000,
    });

    // Inject a non-root role with only 2 children (below minDirectSubs=3).
    const subAxon = axons[5];
    subAxon.axonRoles.set(topicId, {
      parentId:       nodes[0].id,
      isRoot:         false,
      children:       new Map([
        [nodes[1].id, { createdAt: t, lastRenewed: t }],
        [nodes[2].id, { createdAt: t, lastRenewed: t }],
      ]),
      parentLastSent: 0,
      roleCreatedAt:  t,
      emptiedAt:      0,
      lowWaterSince:  0,
    });

    // First tick: notice low-water, set lowWaterSince. Don't dissolve yet.
    t = 1400;
    subAxon.refreshTick();
    assert('role persists on first low-water tick', subAxon.axonRoles.has(topicId));
    assert('lowWaterSince set',
           subAxon.axonRoles.get(topicId).lowWaterSince > 0);

    // Second tick after one refresh interval has passed: dissolve.
    t = 2500;
    subAxon.refreshTick();
    assert('role removed after refreshInterval below min',
           !subAxon.axonRoles.has(topicId));
  }

  // ── Test 18: Hysteresis — recovery above min cancels dissolve ───────
  {
    console.log('\n[Test 18] lowWaterSince clears when children recover above min');
    let t = 1000;
    const now = () => t;
    const topicId = 'cccc333333333333';
    const { nodes, axons } = buildAxonNetwork(10, {
      now, minDirectSubs: 3, refreshIntervalMs: 500, maxSubscriptionAgeMs: 60000,
    });

    const subAxon = axons[5];
    subAxon.axonRoles.set(topicId, {
      parentId: nodes[0].id, isRoot: false,
      children: new Map([
        [nodes[1].id, { createdAt: t, lastRenewed: t }],
        [nodes[2].id, { createdAt: t, lastRenewed: t }],
      ]),
      parentLastSent: 0, roleCreatedAt: t, emptiedAt: 0, lowWaterSince: 0,
    });

    // First tick: mark low-water.
    t = 1400;
    subAxon.refreshTick();
    assert('lowWaterSince set after first low tick',
           subAxon.axonRoles.get(topicId).lowWaterSince > 0);

    // A new subscriber arrives, bringing us to 3 (at min).
    subAxon.axonRoles.get(topicId).children.set(
      nodes[3].id, { createdAt: t, lastRenewed: t });

    // Second tick: we are at min (>= minDirectSubs), so lowWaterSince clears.
    t = 1900;
    subAxon.refreshTick();
    assert('role still present',           subAxon.axonRoles.has(topicId));
    assert('lowWaterSince reset to 0',
           subAxon.axonRoles.get(topicId).lowWaterSince === 0);
  }

  // ── Test 19: Dissolve-hint direct handler re-issues subscribe ───────
  {
    console.log('\n[Test 19] Leaf subscriber receiving dissolve-hint re-subscribes');
    const topicId = 'dddd444444444444';
    const { nodes, axons } = buildAxonNetwork(8);

    // Leaf subscribes so mySubscriptions has the topic.
    let reSubscribes = 0;
    const origRoute = axons[3].dht.routeMessage.bind(axons[3].dht);
    axons[3].dht.routeMessage = async (...args) => {
      if (args[1] === 'pubsub:subscribe') reSubscribes++;
      return origRoute(...args);
    };

    axons[3].pubsubSubscribe(topicId);
    await sleep(100);
    const priorCount = reSubscribes;

    // Deliver a dissolve-hint directly to axons[3].
    axons[3]._onDissolveHint({ topicId, suggestedParent: nodes[0].id }, { fromId: nodes[1].id });
    await sleep(50);

    assert('leaf re-issues subscribe on dissolve-hint',
           reSubscribes > priorCount);
  }

  // ── Test 20: Root never dissolves via hysteresis ────────────────────
  {
    console.log('\n[Test 20] Root axon never dissolves via hysteresis');
    let t = 1000;
    const now = () => t;
    const topicId = 'eeee555555555555';
    const { nodes, axons } = buildAxonNetwork(5, {
      now, minDirectSubs: 5, refreshIntervalMs: 500, rootGraceMs: 60000,
      maxSubscriptionAgeMs: 60000,
    });

    const root = axons[0];
    root.axonRoles.set(topicId, {
      parentId: null, isRoot: true,
      children: new Map([
        [nodes[1].id, { createdAt: t, lastRenewed: t }],
      ]),
      parentLastSent: 0, roleCreatedAt: t, emptiedAt: 0, lowWaterSince: 0,
    });

    // Many ticks below minDirectSubs — root must persist.
    for (let step = 0; step < 10; step++) {
      t += 700;
      root.refreshTick();
    }
    assert('root persists regardless of low-water', root.axonRoles.has(topicId));
  }

  // ───────────────────────────────────────────────────────────────────
  // Phase 3c — churn recovery
  //
  // These tests exercise the membership protocol under node death. The
  // recovery mechanism in Phase 3a+3b is pure TTL + refresh: when a
  // parent dies, its children's next refresh routes past the corpse to
  // whoever is now on the path toward the topic hash. Stale state ages
  // out via lastRenewed TTL. No explicit death-detection message types.
  //
  // Tests confirm the tree heals within a bounded number of ticks.
  // ───────────────────────────────────────────────────────────────────

  // ── Test 21: Root death → new root elected by next refresh ──────────
  {
    console.log('\n[Test 21] Root dies → next refresh elects new root');
    let t = 1000;
    const now = () => t;
    const topicId = 'fedcba9876543210';
    const { net, nodes, axons } = buildAxonNetwork(10, {
      now,
      refreshIntervalMs:    1000,
      maxSubscriptionAgeMs: 3000,
      rootGraceMs:          1000,
    });

    // Subscribe multiple nodes so there's a real tree to salvage.
    const subs = [1, 2, 3, 4, 5];
    for (const i of subs) axons[i].pubsubSubscribe(topicId);
    await sleep(100);

    // Identify the current root and kill it.
    const originalRoot = axons.find(a => a.axonRoles.has(topicId) &&
                                          a.axonRoles.get(topicId).isRoot);
    assert('original root exists', !!originalRoot);
    const originalRootNodeId = originalRoot.nodeId;
    const originalRootNode = nodes.find(n =>
      n.id === originalRootNodeId
    );
    net.markDead(originalRootNodeId);

    // Advance one refresh interval and tick every live axon's refresh.
    t = 2100;
    for (let i = 0; i < axons.length; i++) {
      if (nodes[i].id === originalRootNodeId) continue;   // dead node doesn't refresh
      axons[i].refreshTick();
    }
    await sleep(100);

    // A new root should now exist somewhere.
    const newRoot = axons.find(a => a.nodeId !== originalRootNodeId &&
                                    a.axonRoles.has(topicId) &&
                                    a.axonRoles.get(topicId).isRoot);
    assert('new root elected after one refresh', !!newRoot,
           `roles: ${axons.filter(a => a.axonRoles.has(topicId)).map(a =>
             `${a.nodeId.slice(0,6)}:root=${a.axonRoles.get(topicId).isRoot}`).join(' ')}`);

    // Publish from a non-subscriber and verify at least one subscriber gets it.
    let fires = 0;
    for (const i of subs) {
      axons[i].onPubsubDelivery(() => fires++);
    }
    axons[7].pubsubPublish(topicId, '{"msg":"post-churn"}');
    await sleep(200);
    assert('at least one subscriber receives post-churn publish',
           fires >= 1, `fires=${fires}`);
  }

  // ── Test 22: Subscriber death → silently swept by TTL ───────────────
  {
    console.log('\n[Test 22] Dead subscriber is swept by TTL');
    let t = 1000;
    const now = () => t;
    const topicId = '1234567890abcdef';
    const { net, nodes, axons } = buildAxonNetwork(8, {
      now,
      refreshIntervalMs:    1000,
      maxSubscriptionAgeMs: 2000,
    });

    axons[0].pubsubSubscribe(topicId);
    axons[1].pubsubSubscribe(topicId);
    await sleep(100);

    const root = axons.find(a => a.axonRoles.has(topicId) &&
                                 a.axonRoles.get(topicId).isRoot);
    assert('root holds 2 subscribers',
           root.axonRoles.get(topicId).children.size === 2);

    // Kill one subscriber and silence its leaf-refresh.
    net.markDead(nodes[1].id);
    axons[1].mySubscriptions.delete(topicId);

    // Advance clock to t=1500, let the live subscriber refresh (mimics
    // steady-state operation where every live leaf ticks each interval).
    t = 1500;
    axons[0].refreshTick();
    await sleep(50);

    // Advance past TTL for the dead subscriber. Live subscriber's
    // lastRenewed = 1500, age at t=4000 is 2500 > 2000 too... so we also
    // need to refresh axons[0] again right before the sweep.
    t = 3000;
    axons[0].refreshTick();
    await sleep(50);
    t = 4000;
    root.refreshTick();
    assert('dead subscriber swept, live subscriber retained',
           root.axonRoles.get(topicId).children.size === 1);
  }

  // ── Test 23: Multi-subscriber churn — majority survives ─────────────
  //   Subscribe 5 nodes, kill 2 leaf subscribers (explicitly not the root
  //   so the topic's anchor survives), publish again, verify the other 3
  //   still receive. This isolates "subscriber churn without root churn"
  //   from the larger "root dies" scenario covered in Test 21.
  {
    console.log('\n[Test 23] Partial subscriber churn: survivors keep receiving');
    const topicId = 'aabbccdd11223344';
    const { net, nodes, axons } = buildAxonNetwork(10);

    const delivered = new Map();
    for (let i = 0; i < 5; i++) {
      const idx = i;
      axons[i].onPubsubDelivery(() => delivered.set(idx, (delivered.get(idx) || 0) + 1));
      axons[i].pubsubSubscribe(topicId);
    }
    await sleep(150);

    // Baseline: all 5 should receive the first publish.
    axons[8].pubsubPublish(topicId, '{"seq":1}');
    await sleep(200);
    const baselineFires = [...delivered.values()].reduce((a, b) => a + b, 0);
    assert('baseline: all 5 got first publish', baselineFires === 5,
           `fires=${baselineFires}`);

    // Pick two subscribers to kill — explicitly skip the one that is
    // currently the root, so we're testing leaf churn in isolation.
    const rootAxon = axons.find(a => a.axonRoles.has(topicId) &&
                                     a.axonRoles.get(topicId).isRoot);
    const rootNodeId = rootAxon.nodeId;
    const victims = [];
    for (let i = 0; i < 5 && victims.length < 2; i++) {
      if (nodes[i].id.toString(16).padStart(16, '0') === rootNodeId) continue;
      victims.push(i);
    }
    for (const i of victims) {
      net.markDead(nodes[i].id);
      axons[i].mySubscriptions.delete(topicId);
    }

    delivered.clear();
    axons[8].pubsubPublish(topicId, '{"seq":2}');
    await sleep(200);

    // Survivors = [0..4] \ victims.
    const survivors = [0, 1, 2, 3, 4].filter(i => !victims.includes(i));
    const survivorFires = survivors.filter(i => delivered.get(i) === 1).length;
    assert('all 3 survivors receive post-churn publish',
           survivorFires === 3,
           `survivorFires=${survivorFires}, victims=${victims}, survivors=${survivors}`);
  }

  // ── Test 24b: Eager dead-child removal on publish fan-out ───────────
  //   When sendDirect fails, the axon drops the child immediately rather
  //   than waiting for TTL. Next publish has a tighter fan-out set.
  {
    console.log('\n[Test 24b] Eager dead-child removal on sendDirect failure');
    const topicId = '5a5a5a5a5a5a5a5a';
    const { net, nodes, axons } = buildAxonNetwork(8);

    for (let i = 0; i < 3; i++) axons[i].pubsubSubscribe(topicId);
    await sleep(100);

    const root = axons.find(a => a.axonRoles.has(topicId));
    assert('baseline: 3 children', root.axonRoles.get(topicId).children.size === 3);

    // Kill subscriber 1 and publish once.
    net.markDead(nodes[1].id);
    axons[4].pubsubPublish(topicId, '{}');
    await sleep(150);

    assert('dead child removed immediately after publish',
           root.axonRoles.get(topicId).children.size === 2,
           `children=${root.axonRoles.get(topicId).children.size}`);
  }

  // ── Test 24: Publish routes around a dead intermediate hop ──────────
  //   The DHT's greedy routing naturally picks an alive alternate when
  //   the preferred next hop is dead. Verify a publish still reaches its
  //   axon after we kill random nodes that are neither the root, the
  //   publisher, nor the subscriber.
  {
    console.log('\n[Test 24] Publish routes around a dead intermediate');
    const topicId = 'abcd1234ef915678';   // 16 hex chars
    const { net, nodes, axons } = buildAxonNetwork(12);

    let received = 0;
    axons[0].onPubsubDelivery(() => received++);
    axons[0].pubsubSubscribe(topicId);
    await sleep(100);

    const rootAxon = axons.find(a => a.axonRoles.has(topicId));
    const rootNodeId = rootAxon.nodeId;
    const pubNodeId  = nodes[10].id;
    const subNodeId  = nodes[0].id;
    // Pick 3 nodes to kill that are none of {root, publisher, subscriber}.
    const victims = [];
    for (let i = 1; i < nodes.length && victims.length < 3; i++) {
      const nid = nodes[i].id;
      if (nid === rootNodeId || nid === pubNodeId || nid === subNodeId) continue;
      victims.push(nid);
    }
    for (const vid of victims) net.markDead(vid);

    axons[10].pubsubPublish(topicId, '{}');
    await sleep(200);
    assert('publish survives intermediate deaths',
           received === 1, `received=${received}, victims=${victims}, root=${rootNodeId}`);
  }

  // ── Test 24d: Self-recruit prevention ───────────────────────────────
  //   If a root's children include SELF (self-subscribe case — root is
  //   also in the K-closest for its own topic), pickRecruitPeer must
  //   never return self. Returning self would cause promote-axon →
  //   _onPromoteAxon → pickRecruitPeer → self again → infinite loop.
  //   The _pickExistingChildForRecruit helper excludes self.
  {
    console.log('\n[Test 24d] Recruitment never picks self (would infinite-loop)');
    const topicId = '00ff00ff00ff00ff';
    const { nodes, axons } = buildAxonNetwork(10, { maxDirectSubs: 3 });
    const root = axons[0];
    const now = Date.now();

    // Inject a role where root.children includes self as a child.
    root.axonRoles.set(topicId, {
      parentId: null, isRoot: true, isInRootSet: true,
      peerRoots: new Set(),
      children: new Map([
        [root.nodeId,   { createdAt: now, lastRenewed: now }],   // ← self
        [nodes[1].id,   { createdAt: now, lastRenewed: now }],
        [nodes[2].id,   { createdAt: now, lastRenewed: now }],
      ]),
      parentLastSent: 0, roleCreatedAt: now, emptiedAt: 0, lowWaterSince: 0,
    });

    // Trigger recruitment with a new subscriber whose id is closer to
    // self than to nodes[1]/nodes[2]. Without the guard, self would be
    // picked → infinite loop when the promote-axon routes back to us.
    // With the guard, one of nodes[1]/nodes[2] is picked instead.
    const newSub = nodes[5].id;
    root._onSubscribe(
      { topicId, subscriberId: newSub },
      { fromId: nodes[1].id, isTerminal: false }
    );
    await sleep(20);

    // Root should still exist and not have grown its children beyond the cap.
    assert('root role still exists (no infinite loop)',
           root.axonRoles.has(topicId));
    assert('root children cap preserved',
           root.axonRoles.get(topicId).children.size === 3);
    // One of nodes[1] or nodes[2] should now have a sub-axon role.
    const subAxons = [1, 2].map(i => axons[i]).filter(a => a.axonRoles.has(topicId));
    assert('recruit was nodes[1] or nodes[2] (not self)',
           subAxons.length === 1);
  }

  // ── Test 24c: Sub-axon cascade — promote-axon also caps at maxDirectSubs ─
  //   When a sub-axon receives multiple promote-axon messages it must run
  //   its own recruitment at capacity. Without this cascade, sub-axons
  //   accumulate children far beyond maxDirectSubs (observed as
  //   "max subs/axon = 182" in a benchmark run before the fix).
  {
    console.log('\n[Test 24c] Sub-axon cascades recruitment on promote-axon overflow');
    const topicId = '7777ababcdcd0000';
    const { nodes, axons } = buildAxonNetwork(15, { maxDirectSubs: 3 });

    const subAxon = axons[5];
    const parentHex = nodes[0].id;
    const now = Date.now();

    // Pre-populate the sub-axon with 3 children (at its cap of 3).
    subAxon.axonRoles.set(topicId, {
      parentId: parentHex, isRoot: false,
      children: new Map([
        [nodes[1].id, { createdAt: now, lastRenewed: now }],
        [nodes[2].id, { createdAt: now, lastRenewed: now }],
        [nodes[3].id, { createdAt: now, lastRenewed: now }],
      ]),
      parentLastSent: 0, roleCreatedAt: now, emptiedAt: 0, lowWaterSince: 0,
    });

    // Promoter sends a new subscriber via promote-axon — sub-axon is full,
    // so it must cascade by promoting one of its own children.
    subAxon._onPromoteAxon(
      { topicId, newSubscriberId: nodes[7].id, parentId: parentHex },
      { fromId: parentHex }
    );
    await sleep(20);

    assert('sub-axon children cap preserved under promote-axon pressure',
           subAxon.axonRoles.get(topicId).children.size === 3,
           `size=${subAxon.axonRoles.get(topicId).children.size}`);

    // One of nodes[1..3] should now hold a role (the cascaded promote).
    const grandchildren = [1, 2, 3].map(i => axons[i])
                                    .filter(a => a.axonRoles.has(topicId));
    assert('sub-axon cascaded to exactly one grand-sub',
           grandchildren.length === 1, `got ${grandchildren.length}`);
  }

  // ── Test 25: K-closest subscribe replicates to all K roots ─────────
  //   Explicit test of the K-closest mode: a single subscriber subscribes
  //   and we verify that K different nodes all hold a role for the topic
  //   (replicating the subscriber list). Subsequent publishes from any
  //   peer should be delivered to the subscriber regardless of which
  //   root the publish's lookup lands at.
  {
    console.log('\n[Test 25] K-closest subscribe replicates at all K roots');
    const topicId = 'feedface1234abcd';
    const K = 3;
    const { axons } = buildAxonNetwork(12, { rootSetSize: K });

    let received = 0;
    axons[7].onPubsubDelivery(() => received++);
    axons[7].pubsubSubscribe(topicId);
    await sleep(50);

    // Exactly K distinct nodes should now hold a role for this topic.
    const holders = axons.filter(a => a.axonRoles.has(topicId));
    assert(`K (=${K}) roots hold the topic`,
           holders.length === K, `got ${holders.length}`);

    // Every holder's role is marked isInRootSet.
    for (const h of holders) {
      const role = h.axonRoles.get(topicId);
      assert(`root ${h.nodeId.slice(0, 4)} marked isInRootSet`,
             role.isInRootSet === true);
      assert(`root ${h.nodeId.slice(0, 4)} has subscriber`,
             role.children.has(axons[7].nodeId));
    }

    // Publish from a non-subscriber. Because the publisher picks one of
    // K roots at random and sends direct, the subscriber should always
    // get the message regardless of which root was selected.
    axons[3].pubsubPublish(topicId, '{"test":1}');
    await sleep(50);
    assert('subscriber received from K-closest publish', received === 1,
           `received=${received}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  results.forEach(r => console.log(r));
  console.log('='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
