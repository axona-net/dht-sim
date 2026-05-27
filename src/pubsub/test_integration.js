/**
 * test_integration.js — end-to-end verification of the full stack:
 *
 *   App → PubSubAdapter → AxonaManager → MockDHTNode
 *
 * This proves that v0.51.00's adapter (sequencing, reorder, gap detection)
 * works unchanged against v0.51.02's membership protocol (routed subscribe,
 * axon fan-out, TTL). Together, the stack provides Croquet-style pub/sub
 * with per-sender ordering guarantees over a realistic DHT.
 *
 * Test groups:
 *   1-4.  Functional: subscribe/publish across adapter + real routing
 *   5-6.  Ordering: per-sender seq preserved end-to-end
 *   7.    Gap detection fires when the network drops an intermediate publish
 *   8.    TTL expiry of an adapter's subscription at the axon
 *   9.    Multiple publishers to same topic, per-sender tracking
 *  10.    Unsubscribe via adapter propagates all the way to axon role
 */

import { PubSubAdapter, topicIdFor } from './PubSubAdapter.js';
import { MockDHTNetwork, xorDistance } from './MockDHTNode.js';
import { AxonaManager } from './AxonaManager.js';

/** Pick the adapter whose node ID is *farthest* from `topic` so it is never
 *  elected root (its subscribe and the publish will always route over the
 *  network to a different node, exercising sendDirect + dropFn). */
function farthestFrom(adapters, topic) {
  let best = adapters[0], bestDist = 0n;
  for (const a of adapters) {
    const d = xorDistance(a.nodeId, topic);
    if (d > bestDist) { bestDist = d; best = a; }
  }
  return best;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const results = [];
function assert(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  ✓ ${name}`); }
  else      { failed++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** Build a network with an AxonaManager + PubSubAdapter on every node. */
function buildStack(n, opts = {}) {
  const net = new MockDHTNetwork({
    routingTableSize: n - 1,         // full-mesh for deterministic routing
    defaultLatencyMs: opts.latencyMs ?? 3,
  });
  const nodes = [], axons = [], adapters = [];
  for (let i = 0; i < n; i++) nodes.push(net.createNode());
  net.rebuildRoutingTables();
  for (const node of nodes) {
    const axon = new AxonaManager({
      dht: node,
      refreshIntervalMs:    opts.refreshIntervalMs    ?? 100000,
      maxSubscriptionAgeMs: opts.maxSubscriptionAgeMs ?? 30000,
      rootGraceMs:          opts.rootGraceMs          ?? 60000,
      now:                  opts.now,
    });
    axons.push(axon);
    const adapter = new PubSubAdapter({
      transport: axon,
      reorderWindowMs: opts.reorderWindowMs ?? 100,
    });
    adapters.push(adapter);
  }
  return { net, nodes, axons, adapters };
}

async function run() {
  // ── Test 1: Basic end-to-end publish/subscribe ──────────────────────
  {
    console.log('\n[Test 1] App-level subscribe + publish across full stack');
    const { adapters } = buildStack(15);

    let received = null;
    adapters[1].subscribe('chat', 'hello',
      (data, meta) => { received = { data, meta }; },
      'immediate'
    );
    await sleep(150);

    adapters[0].publish('chat', 'hello', { text: 'hi from 0' });
    await sleep(200);

    assert('subscriber received data',
           received && received.data && received.data.text === 'hi from 0');
    assert('meta carries senderId (publisher node)',
           received && received.meta.senderId === adapters[0].nodeId);
    assert('meta seq is 1 (first publish)', received && received.meta.seq === 1);
  }

  // ── Test 2: Multiple subscribers, one publisher ─────────────────────
  {
    console.log('\n[Test 2] Broadcast to many subscribers');
    const { adapters } = buildStack(20);

    const rcv = new Map();
    for (let i = 1; i <= 8; i++) {
      const idx = i;
      adapters[i].subscribe('broad', 'cast',
        (data) => { rcv.set(idx, (rcv.get(idx) || 0) + 1); },
        'immediate'
      );
    }
    await sleep(250);

    adapters[0].publish('broad', 'cast', { n: 1 });
    await sleep(200);

    for (let i = 1; i <= 8; i++) {
      assert(`subscriber ${i} got exactly 1`, rcv.get(i) === 1,
             `got ${rcv.get(i) || 0}`);
    }
  }

  // ── Test 3: Publisher is also subscriber — no duplicate ─────────────
  {
    console.log('\n[Test 3] Publisher subscribed to own topic: fires once, no duplicate');
    const { adapters } = buildStack(10);

    let fires = 0;
    adapters[0].subscribe('self', 'loop', () => fires++, 'immediate');
    await sleep(150);

    adapters[0].publish('self', 'loop', {});
    await sleep(200);

    assert('fires once via adapter\'s local path', fires === 1, `got ${fires}`);
  }

  // ── Test 4: Unsubscribe halts further delivery ──────────────────────
  {
    console.log('\n[Test 4] Unsubscribe halts delivery at application level');
    const { adapters } = buildStack(10);

    let fires = 0;
    const cb = () => fires++;
    adapters[1].subscribe('t', 'u', cb, 'immediate');
    await sleep(150);

    adapters[0].publish('t', 'u', {});
    await sleep(150);
    assert('fires before unsubscribe', fires === 1);

    adapters[1].unsubscribe('t', 'u', cb);
    await sleep(150);

    adapters[0].publish('t', 'u', {});
    await sleep(150);
    assert('does NOT fire after unsubscribe', fires === 1, `got ${fires}`);
  }

  // ── Test 5: Sequence numbers preserved end-to-end ───────────────────
  {
    console.log('\n[Test 5] Per-sender seq preserved across adapter+axon');
    const { adapters } = buildStack(10);

    const seqs = [];
    adapters[1].subscribe('s', 'e',
      (data, meta) => seqs.push(meta.seq), 'immediate');
    await sleep(150);

    for (let i = 0; i < 5; i++) adapters[0].publish('s', 'e', { i });
    await sleep(300);

    assert('received 5 events', seqs.length === 5, `got ${seqs.length}`);
    assert('seqs are 1..5 in order',
           JSON.stringify(seqs) === '[1,2,3,4,5]',
           JSON.stringify(seqs));
  }

  // ── Test 6: Reorder buffer smooths over out-of-order arrival ────────
  {
    console.log('\n[Test 6] Reorder buffer preserves order under latency variance');
    const netLatencyFn = (from, to, type) => {
      // Deliver second publish faster than first by making 'pubsub:deliver'
      // for the second publish near-zero while the first is 30ms.
      // We coordinate by a shared counter.
      return 5;  // default
    };
    const { net, adapters } = buildStack(10, { latencyMs: 5 });
    let deliveryIdx = 0;
    net.latencyFn = (from, to, type) => {
      if (type !== 'pubsub:deliver') return 5;
      // First delivery (seq=1): slow. Second (seq=2): fast. Seq=1 arrives
      // after seq=2 at the subscriber; the adapter's reorder buffer must
      // reassemble them.
      const lat = deliveryIdx === 0 ? 30 : 3;
      deliveryIdx++;
      return lat;
    };

    const order = [];
    adapters[1].subscribe('o', 'r',
      (data, meta) => order.push(meta.seq), 'immediate');
    await sleep(150);

    adapters[0].publish('o', 'r', { i: 1 });
    adapters[0].publish('o', 'r', { i: 2 });
    await sleep(200);

    assert('both delivered', order.length === 2, `got ${order.length}`);
    assert('delivered in sequence order (reorder reassembled)',
           JSON.stringify(order) === '[1,2]',
           JSON.stringify(order));
  }

  // ── Test 7: Network drop → adapter fires __gap__ via onGap hook ─────
  {
    console.log('\n[Test 7] Dropped publish triggers __gap__ in the adapter');
    const { net, adapters } = buildStack(10, { latencyMs: 5 });
    // Pick a subscriber whose node is farthest from the topic hash so
    // the subscriber is NEVER the root — guarantees fan-out traverses
    // the network (via sendDirect + dropFn) rather than the self-delivery
    // local-callback shortcut.
    const topic = topicIdFor('g', 'ap');
    const sub = farthestFrom(adapters, topic);
    // Publisher is someone else — pick any non-subscriber.
    const pub = adapters.find(a => a !== sub);

    // Drop enough pubsub:deliver messages to suppress the first
    // publish's fan-out across all K redundant paths. With K=5, the
    // publisher sends to 5 roots and each fans to this subscriber, so
    // up to 5 deliver attempts arrive for the first publish. Dropping
    // 5 covers them; leaves the second publish's 5 attempts intact.
    let deliveryIdx = 0;
    net.dropFn = (from, to, type) => {
      if (type !== 'pubsub:deliver') return false;
      const drop = deliveryIdx < 5;
      deliveryIdx++;
      return drop;
    };

    const gaps = [];
    const delivered = [];
    sub.subscribe('g', 'ap',
      (data, meta) => delivered.push(meta.seq),
      { handling: 'immediate',
        onGap: (info) => gaps.push(info) });
    await sleep(150);

    pub.publish('g', 'ap', { i: 1 });   // delivery dropped
    pub.publish('g', 'ap', { i: 2 });   // delivered; held in reorder buf
    await sleep(400);

    assert('gap reported',     gaps.length === 1, `got ${gaps.length}`);
    assert('gap covers seq 1', gaps[0] && gaps[0].fromSeq === 1 && gaps[0].toSeq === 1);
    assert('seq 2 still delivered after gap',
           delivered.includes(2), JSON.stringify(delivered));
  }

  // ── Test 8: TTL expiry: subscriber that stops refreshing falls out ──
  {
    console.log('\n[Test 8] TTL expiry removes unrefreshing subscriber');
    let t = 1000;
    const now = () => t;
    const { axons, adapters } = buildStack(8, {
      now, maxSubscriptionAgeMs: 500, rootGraceMs: 60000,
    });

    adapters[1].subscribe('tl', 'e', () => {}, 'immediate');
    await sleep(150);

    // Find the axon holding the role and confirm the subscriber is present.
    const topicId = topicIdFor('tl', 'e');
    const axonHolder = axons.find(a => a.axonRoles.has(topicId));
    assert('axon holds subscriber', axonHolder &&
           axonHolder.axonRoles.get(topicId).children.has(adapters[1].nodeId));

    // Silence the subscriber's leaf refresh so it doesn't re-bump
    // lastRenewed when it happens to be the same node as the axon holder.
    axons[1].mySubscriptions.delete(topicId);

    // Advance clock past TTL, sweep without refresh.
    t = 2000;
    axonHolder.refreshTick();
    assert('subscriber reaped by TTL',
           !axonHolder.axonRoles.get(topicId) ||
           !axonHolder.axonRoles.get(topicId).children.has(adapters[1].nodeId));
  }

  // ── Test 9: Two publishers, independent seq tracking ────────────────
  {
    console.log('\n[Test 9] Two publishers: independent seq tracking, both delivered');
    const { adapters } = buildStack(10);

    const log = [];
    adapters[2].subscribe('m', 'p',
      (data, meta) => log.push(`${meta.senderId}#${meta.seq}`), 'immediate');
    await sleep(150);

    adapters[0].publish('m', 'p', {});
    adapters[0].publish('m', 'p', {});
    adapters[1].publish('m', 'p', {});
    adapters[1].publish('m', 'p', {});
    adapters[1].publish('m', 'p', {});
    await sleep(300);

    const fromA = log.filter(s => s.startsWith(adapters[0].nodeId));
    const fromB = log.filter(s => s.startsWith(adapters[1].nodeId));

    // Each publisher's seq starts at 1 independently.
    assert('A delivered 2 in seq',
           JSON.stringify(fromA) === JSON.stringify([
             `${adapters[0].nodeId}#1`, `${adapters[0].nodeId}#2`]));
    assert('B delivered 3 in seq',
           JSON.stringify(fromB) === JSON.stringify([
             `${adapters[1].nodeId}#1`, `${adapters[1].nodeId}#2`, `${adapters[1].nodeId}#3`]));
  }

  // ── Test 10: Adapter unsubscribe removes child at axon ──────────────
  {
    console.log('\n[Test 10] Adapter unsubscribe propagates to axon role');
    const { axons, adapters } = buildStack(10);
    const topicId = topicIdFor('c', 'x');

    adapters[1].subscribe('c', 'x', () => {}, 'immediate');
    await sleep(150);

    const holder = axons.find(a => a.axonRoles.has(topicId));
    assert('axon has subscriber before unsubscribe',
           holder.axonRoles.get(topicId).children.has(adapters[1].nodeId));

    adapters[1].unsubscribe('c', 'x');
    await sleep(200);

    // Role may linger (empty root in grace), but children should not include us.
    const role = holder.axonRoles.get(topicId);
    assert('child removed after unsubscribe',
           !role || !role.children.has(adapters[1].nodeId));
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  results.forEach(r => console.log(r));
  console.log('='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
