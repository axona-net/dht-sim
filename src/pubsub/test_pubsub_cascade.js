// =====================================================================
// test_pubsub_cascade.js — Test 2 (multi-republisher reshare cascade).
//
// Exercises the axonal tree end-to-end:
//
//   - 1 origin publisher P_orig with topic T_orig
//   - 1000 first-tier subscribers to T_orig (50 of them are also
//     republishers with their own topics T_R_i)
//   - 1000 second-tier subscribers, 20 each subscribed to one T_R_i
//
// Sequence:
//   1. P_orig publishes post P to T_orig.
//   2. All 1000 first-tier subs receive P (delivery_count = 1000 at
//      P_orig's relays).
//   3. Each of the 50 republishers reshares P to their own T_R_i.
//      That sends out 50 reshare-notifications to T_orig's tree, which
//      bumps reshare_count = 50.
//   4. Each second-tier subscriber receives the reshare from its R_i
//      (delivery_count = 20 at each T_R_i's relay).
//   5. The application logic on each second-tier subscriber sees the
//      reshare references and calls pull(T_orig, P.hash), which lands
//      at SOME relay in T_orig's tree holding the post. Each successful
//      Pull bumps pull_count by 1.
//   6. After settling, P_orig.metrics() returns:
//        delivery_count = 1000   (direct subs)
//        pull_count     = 1000   (second-tier referrals)
//        reshare_count  =   50   (republishers)
//        reach_estimate = 2000   ← the headline
//
// Default scale is reduced (1 + 5 × 4 = 21 second-tier subs) so the
// architecture can be verified quickly. CLI args scale the test up to
// the full 50 × 20 = 1000 second-tier count.
//
//     node test_pubsub_cascade.js               # small (default)
//     node test_pubsub_cascade.js --full        # 50 × 20 cascade
//     node test_pubsub_cascade.js --reposters 10 --secondPerRepost 8
// =====================================================================

import { MockDHTNetwork } from './MockDHTNode.js';
import { AxonManager }    from './AxonManager.js';
import { AxonPubSub }     from './AxonPubSub.js';

// ── CLI ─────────────────────────────────────────────────────────────
function parseArgs() {
  const a = process.argv.slice(2);
  const args = {
    firstTier:       50,    // total first-tier subscribers (incl. reposters)
    reposters:        5,    // how many of them also reshare
    secondPerRepost:  4,    // subscribers under each reshare topic
    settleMs:       200,    // wait for fan-out + reshare propagation
    pullTimeoutMs:  500,
    full:           false,
  };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--full') {
      args.full = true; args.firstTier = 1000; args.reposters = 50;
      args.secondPerRepost = 20; args.settleMs = 800;
    } else if (a[i] === '--reposters')        args.reposters       = +a[++i];
    else if   (a[i] === '--secondPerRepost')  args.secondPerRepost = +a[++i];
    else if   (a[i] === '--firstTier')        args.firstTier       = +a[++i];
    else if   (a[i] === '--settleMs')         args.settleMs        = +a[++i];
  }
  return args;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const lines = [];
function assert(name, cond, detail = '') {
  if (cond) { passed++; lines.push(`  ✓ ${name}`); }
  else      { failed++; lines.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function deterministicId(n) {
  // 16-hex deterministic node ids so test results don't drift across
  // runs based on which random ID hashes closest to a topic.
  return n.toString(16).padStart(16, '0');
}

function buildNetwork(totalNodes, latencyMs = 1) {
  // Full-mesh routing table so greedy lookups always converge to the
  // globally-closest node. This matches how test_axon.js sizes its
  // table for deterministic root election. Production / sparse-mesh
  // behavior is studied separately under churn / fragmentation sweeps;
  // here we're verifying the protocol's correctness under ideal routing.
  const net = new MockDHTNetwork({
    defaultLatencyMs: latencyMs,
    routingTableSize: totalNodes - 1,
  });
  const nodes = [];
  for (let i = 0; i < totalNodes; i++) {
    nodes.push(net.createNode(deterministicId(i + 1)));
  }
  net.rebuildRoutingTables();
  return { net, nodes };
}

function attachPubSub(node, opts = {}) {
  const axon = new AxonManager({
    dht: node,
    maxDirectSubs:        opts.maxDirectSubs        ?? 20,
    minDirectSubs:        opts.minDirectSubs        ?? 5,
    refreshIntervalMs:    100_000,
    maxSubscriptionAgeMs: 60_000,
    rootGraceMs:          120_000,
    rootSetSize:          0,                  // routed mode
    crossFragmentRoots:   0,
  });
  const ps = new AxonPubSub({ axon });
  return { axon, ps };
}

async function run() {
  const args = parseArgs();
  console.log(`\n[Test 2] reshare cascade — first=${args.firstTier} ` +
              `reposters=${args.reposters} secondPerRepost=${args.secondPerRepost}` +
              `${args.full ? ' (FULL)' : ''}`);

  // ── Network sizing ─────────────────────────────────────────────────
  //   1 publisher
  // + firstTier first-tier subs (reposters are a subset of these)
  // + reposters*secondPerRepost second-tier subs
  //
  // We allocate IDs in this order so each role's index is predictable:
  //   [0]                       = P_orig
  //   [1 .. firstTier]          = first-tier subs (first `reposters` of
  //                               these are R_1 .. R_reposters)
  //   [firstTier+1 .. end]      = second-tier subs (20 per reposter,
  //                               adjacent in id space)
  const totalNodes = 1 + args.firstTier + args.reposters * args.secondPerRepost;
  console.log(`  total nodes: ${totalNodes}`);

  const t0 = Date.now();
  const { net, nodes } = buildNetwork(totalNodes, 0);

  // ── Attach pub/sub to every node ───────────────────────────────────
  const psNodes = nodes.map(n => attachPubSub(n));
  const P_orig    = psNodes[0];
  const firstTier = psNodes.slice(1, 1 + args.firstTier);
  const reposters = firstTier.slice(0, args.reposters);
  const secondTier = psNodes.slice(1 + args.firstTier);

  const ORIG_TOPIC = 'origin-feed';
  const REPOST_NAMES = Array.from({ length: args.reposters },
                                  (_, i) => `repost-feed-${i}`);

  // ── First-tier subscriptions ───────────────────────────────────────
  const firstTierFires = new Set();
  for (let i = 0; i < firstTier.length; i++) {
    firstTier[i].ps.subscribe(P_orig.axon.nodeId, ORIG_TOPIC, (post) => {
      firstTierFires.add(P_orig.axon.nodeId + ':' + i);

      // If this first-tier sub is also a reposter, reshare the post.
      // Tracking is by index in firstTier; reposters are the first
      // `args.reposters` of them.
      if (i < args.reposters) {
        reposters[i].ps.reshare(REPOST_NAMES[i], {
          topic_id:  post.topic_id,
          post_hash: post.post_hash,
        });
      }
    });
  }

  // ── Second-tier subscriptions ──────────────────────────────────────
  // Each second-tier sub subscribes to exactly one reposter's feed and,
  // on receiving a reshare, calls pull() on the referenced original
  // (the application convention — the SECOND-tier subscriber here is
  // a "Twitter-like" reader that resolves references for display).
  const secondTierFires = new Set();
  const secondTierPullSuccess = new Set();
  for (let i = 0; i < secondTier.length; i++) {
    const repostIdx = Math.floor(i / args.secondPerRepost);
    const repostName = REPOST_NAMES[repostIdx];
    const repostAuthor = reposters[repostIdx].axon.nodeId;
    const reader = secondTier[i];

    reader.ps.subscribe(repostAuthor, repostName, async (post) => {
      secondTierFires.add(repostAuthor + ':' + i);
      for (const ref of (post.references || [])) {
        const original = await reader.ps.pull(ref, undefined, { timeoutMs: args.pullTimeoutMs });
        if (original) secondTierPullSuccess.add(repostAuthor + ':' + i);
      }
    });
  }

  // Let subscriptions propagate. The axonal tree builds up over a few
  // refresh ticks; with refreshIntervalMs disabled in tests we rely on
  // the subscribe -> route-to-root -> recruit-sub-axon path completing.
  await sleep(args.settleMs);

  // ── Publish the original post ──────────────────────────────────────
  const published = P_orig.ps.publish(ORIG_TOPIC, {
    msg: 'breaking news', t: Date.now(),
  });

  // Wait for the cascade: P → first-tier → reshare → second-tier → pull.
  await sleep(args.settleMs * 2);

  // ── Assertions: first-tier reception ───────────────────────────────
  const expectedFirst = firstTier.length;
  assert(`first-tier reception: all ${expectedFirst} got original`,
         firstTierFires.size === expectedFirst,
         `got ${firstTierFires.size}`);

  // ── Second-tier reception ──────────────────────────────────────────
  const expectedSecond = secondTier.length;
  assert(`second-tier reception: all ${expectedSecond} got the reshare`,
         secondTierFires.size === expectedSecond,
         `got ${secondTierFires.size}`);

  // ── Second-tier Pull success ───────────────────────────────────────
  assert(`second-tier Pull: all ${expectedSecond} resolved the original`,
         secondTierPullSuccess.size === expectedSecond,
         `got ${secondTierPullSuccess.size}`);

  // ── Metrics at P_orig ──────────────────────────────────────────────
  const m = await P_orig.ps.metrics(ORIG_TOPIC, [published.post_hash], { timeoutMs: 500 });
  const orig = m.get(published.post_hash);

  assert('P_orig metrics: returned entry for the post', !!orig);
  if (orig) {
    assert(`P_orig.delivery_count = ${expectedFirst}`,
           orig.delivery_count === expectedFirst,
           `got ${orig.delivery_count}`);
    assert(`P_orig.pull_count = ${expectedSecond}`,
           orig.pull_count === expectedSecond,
           `got ${orig.pull_count}`);
    assert(`P_orig.reshare_count = ${args.reposters}`,
           orig.reshare_count === args.reposters,
           `got ${orig.reshare_count}`);
    const expectedReach = expectedFirst + expectedSecond;
    assert(`P_orig.reach_estimate = ${expectedReach}`,
           orig.reach_estimate === expectedReach,
           `got ${orig.reach_estimate}`);
  }

  // ── Metrics at each reposter ───────────────────────────────────────
  // Sample one reposter and verify their own reshare's metrics.
  // (Doing all 50 would slow tests; the headline invariant is the
  // origin's view.)
  {
    const sample = reposters[0];
    // The post the reposter created has post_hash we don't easily
    // know up front — query "all hashes" by passing empty array.
    const mr = await sample.ps.metrics(REPOST_NAMES[0], [], { timeoutMs: 500 });
    let sampleAgg = null;
    for (const v of mr.values()) { sampleAgg = v; break; }
    assert(`sample reposter has at least one post tracked`,
           mr.size >= 1, `size=${mr.size}`);
    if (sampleAgg) {
      assert(`sample reposter.delivery_count = ${args.secondPerRepost}`,
             sampleAgg.delivery_count === args.secondPerRepost,
             `got ${sampleAgg.delivery_count}`);
    }
  }

  // ── Cross-check via local oracle ───────────────────────────────────
  // Total pull_count summed across every node should equal Pull successes.
  let totalPull = 0;
  let totalDelivery = 0;
  let totalReshare = 0;
  for (const { axon } of psNodes) {
    const cs = axon.getLocalCounters(published.topic_id, [published.post_hash]);
    for (const c of cs) {
      totalDelivery += c.delivery_count;
      totalPull     += c.pull_count;
      totalReshare  += c.reshare_count;
    }
  }
  assert(`oracle: Σ delivery_count for P_orig = ${expectedFirst}`,
         totalDelivery === expectedFirst,
         `summed ${totalDelivery}`);
  assert(`oracle: Σ pull_count for P_orig = ${expectedSecond}`,
         totalPull === expectedSecond,
         `summed ${totalPull}`);
  assert(`oracle: Σ reshare_count for P_orig = ${args.reposters}`,
         totalReshare === args.reposters,
         `summed ${totalReshare}`);

  const elapsedMs = Date.now() - t0;
  console.log(lines.join('\n'));
  console.log(`\n  ${passed} passed, ${failed} failed (${elapsedMs}ms)`);
  return { passed, failed };
}

run()
  .then(({ failed: f }) => process.exit(f === 0 ? 0 : 1))
  .catch(err => { console.error(err); process.exit(2); });
