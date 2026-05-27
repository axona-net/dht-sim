// =====================================================================
// test_pubsub_delivery.js — Test 1 (single-subscriber delivery).
//
// The smallest end-to-end test of the post-level pub/sub layer:
//
//   1. Publisher P creates topic T and publishes a post.
//   2. Subscriber S receives it via subscribe stream.
//   3. P queries metrics; sees delivery_count = 1, pull_count = 0.
//
// Establishes:
//   - Posts carry post_hash + topic_id; both are recomputed and
//     verified at the receiving edge.
//   - delivery_count fires exactly once per direct subscriber.
//   - pull_count stays at zero — no auto-Pull on display (privacy
//     default, §4.5b).
//   - reshare_count stays at zero — no references in this test.
//
// The anti-pattern variant (where the receiver auto-pulls on display)
// is deferred to PR 2 once pull() is implemented; the privacy default
// here is enforced by simply NOT calling pull() in any test client.
// =====================================================================

import { MockDHTNetwork } from './MockDHTNode.js';
import { AxonaManager }    from './AxonaManager.js';
import { AxonPubSub }     from './AxonPubSub.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const lines = [];
function assert(name, cond, detail = '') {
  if (cond) { passed++; lines.push(`  ✓ ${name}`); }
  else      { failed++; lines.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/**
 * Three-node mesh so the topic-tree root has somewhere to land
 * regardless of which node happens to be closest to hash(topic):
 *
 *   - 'pub'   the publisher
 *   - 'sub'   the lone subscriber
 *   - 'extra' a third node so 'extra' can become the root in the
 *             cases where the hash lands closest to it. The test must
 *             produce delivery_count = 1 regardless of which node is
 *             root, so a wider mesh actually strengthens the assertion.
 *
 * Deterministic IDs let the root location be predictable across runs,
 * which makes failure diagnosis easier.
 */
function buildNetwork() {
  const net = new MockDHTNetwork({ routingTableSize: 8 });
  const ids = {
    pub:   '0000000000000001',
    sub:   '0000000000000002',
    extra: '0000000000000003',
  };
  const nodes = {
    pub:   net.createNode(ids.pub),
    sub:   net.createNode(ids.sub),
    extra: net.createNode(ids.extra),
  };
  net.rebuildRoutingTables();

  const axons = {};
  for (const role of ['pub', 'sub', 'extra']) {
    axons[role] = new AxonaManager({
      dht: nodes[role],
      refreshIntervalMs:    100_000,   // tests drive manually
      maxSubscriptionAgeMs: 60_000,
      rootGraceMs:          120_000,
      rootSetSize:          0,         // routed mode (single root)
      crossFragmentRoots:   0,         // disable K-redundancy for clarity
    });
  }
  const pubsubs = {
    pub:   new AxonPubSub({ axon: axons.pub   }),
    sub:   new AxonPubSub({ axon: axons.sub   }),
    extra: new AxonPubSub({ axon: axons.extra }),
  };
  return { net, ids, nodes, axons, pubsubs };
}

async function run() {
  console.log('\n[Test 1] single-subscriber delivery + metrics');
  const { ids, axons, pubsubs } = buildNetwork();

  const TOPIC_NAME = 'announcements';

  // ── S subscribes to P's topic ─────────────────────────────────────
  const received = [];
  const handle = pubsubs.sub.subscribe(ids.pub, TOPIC_NAME, (post) => {
    received.push(post);
  });

  // Let the subscribe propagate through the mesh and become a child of
  // whichever node holds the root role for this topic_id.
  await sleep(60);

  // ── P publishes one post ──────────────────────────────────────────
  const published = pubsubs.pub.publish(TOPIC_NAME, { msg: 'hello, world' });

  // Wait for the routed publish to reach the root + the root's fan-out
  // sendDirect to land at S.
  await sleep(80);

  // ── Subscriber received exactly one post, well-formed ────────────
  assert('subscriber received exactly one post', received.length === 1,
    `got ${received.length}`);

  if (received.length === 1) {
    const got = received[0];
    assert('post_hash matches what publisher computed',
           got.post_hash === published.post_hash,
           `got ${got.post_hash}, expected ${published.post_hash}`);
    assert('topic_id is self-authenticated',
           got.topic_id === handle.topic_id);
    assert('publisher field matches sender',
           got.publisher === ids.pub);
    assert('content delivered intact',
           got.content && got.content.msg === 'hello, world');
    assert('no references on a fresh post',
           Array.isArray(got.references) && got.references.length === 0);
  }

  // ── Publisher queries metrics ────────────────────────────────────
  const metrics = await pubsubs.pub.metrics(TOPIC_NAME, [published.post_hash]);
  const agg = metrics.get(published.post_hash);

  assert('metrics returned an entry for the post', !!agg);
  if (agg) {
    assert('delivery_count = 1 (one subscriber received it)',
           agg.delivery_count === 1,
           `got ${agg.delivery_count}`);
    assert('pull_count = 0 (privacy default — no auto-pull on display)',
           agg.pull_count === 0,
           `got ${agg.pull_count}`);
    assert('reshare_count = 0 (no reshares in this test)',
           agg.reshare_count === 0,
           `got ${agg.reshare_count}`);
    assert('reach_estimate = 1 (delivery + pull)',
           agg.reach_estimate === 1,
           `got ${agg.reach_estimate}`);
    assert('coverage ≥ 1 (at least the root responded)',
           agg.coverage >= 1,
           `got ${agg.coverage}`);
  }

  // ── Verify ground truth via local counter inspection ─────────────
  // The simulator can read counters directly across nodes (no
  // protocol-traversal overhead). This is a sanity check: the wire
  // metrics call should reflect what's actually held by the role-
  // bearing node.
  let totalLocal = 0;
  let foundRoot = null;
  for (const a of Object.values(axons)) {
    const cs = a.getLocalCounters(handle.topic_id, [published.post_hash]);
    for (const c of cs) {
      totalLocal += c.delivery_count;
      if (c.delivery_count > 0) foundRoot = a.nodeId;
    }
  }
  assert('sum of local delivery counters across all nodes = 1',
         totalLocal === 1,
         `summed ${totalLocal}`);
  assert('exactly one node holds non-zero delivery_count',
         foundRoot !== null);

  handle.unsubscribe();

  // ── Report ───────────────────────────────────────────────────────
  console.log(lines.join('\n'));
  console.log(`\n  ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

run()
  .then(({ failed: f }) => process.exit(f === 0 ? 0 : 1))
  .catch(err => { console.error(err); process.exit(2); });
