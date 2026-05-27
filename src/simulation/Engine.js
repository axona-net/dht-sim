import { randomU64, computeStats, haversine, continentOf, buildXorRoutingTable, messageLatency } from '../utils/geo.js';
import { PubSubAdapter, topicIdFor, topicIdForPrefixed } from '../pubsub/PubSubAdapter.js';
import { applySliceWorldPartition, findNodeNearest } from '../dht/sliceWorld.js';

/**
 * SimulationEngine – orchestrates lookup tests and churn tests on a DHT.
 *
 * Emits progress via onProgress(fraction, partialStats) callback.
 * All timing is simulated (no real waits); the engine yields to the event loop
 * periodically so the UI stays responsive.
 */
export class SimulationEngine {
  constructor() {
    this.running = false;
    this.onProgress = null;   // (fraction: 0-1, partial: object) => void
    this.onComplete = null;   // (result: object) => void
    this.onPathFound = null;  // (path: number[], dht) => void  – for visualization
  }

  stop() {
    this.running = false;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Pick a random live node from the DHT. */
  _randomNode(dht) {
    const nodes = dht.getNodes().filter(n => n.alive);
    if (!nodes.length) return null;
    return nodes[Math.floor(Math.random() * nodes.length)];
  }

  /** Pick a random live node from the DHT that is NOT excludeId. */
  _randomOtherNode(dht, excludeId) {
    const nodes = dht.getNodes().filter(n => n.alive && n.id !== excludeId);
    if (!nodes.length) return null;
    return nodes[Math.floor(Math.random() * nodes.length)];
  }

  /**
   * Return all live nodes within radiusKm of sourceNode (excluding itself).
   * Uses the Haversine great-circle distance.
   */
  _nodesWithinRadius(dht, sourceNode, radiusKm) {
    return dht.getNodes().filter(n =>
      n.alive &&
      n.id !== sourceNode.id &&
      haversine(sourceNode.lat, sourceNode.lng, n.lat, n.lng) <= radiusKm
    );
  }

  /**
   * Return all live nodes that have at least one other live node within
   * radiusKm.  Used to pre-filter eligible senders in regional mode so that
   * every randomly chosen sender is guaranteed to have a reachable receiver.
   */
  _eligibleRegionalSenders(dht, radiusKm) {
    const nodes = dht.getNodes().filter(n => n.alive);
    return nodes.filter(n =>
      nodes.some(m => m.id !== n.id &&
        haversine(n.lat, n.lng, m.lat, m.lng) <= radiusKm)
    );
  }

  /** Yield to the browser event loop so the UI can update. */
  _yield() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  _partialStats(hops, times) {
    return {
      hops: computeStats(hops),
      time: computeStats(times),
      count: hops.length,
    };
  }

  /**
   * Prime the synaptomes of an NX-15+ DHT with pub/sub-style traffic,
   * then wipe all axon state. Subscribe + publish trains the synaptic
   * weights along the routed-subscribe and routed-publish paths — the
   * same paths a real membership test will exercise — but the axon
   * trees, subscriptions, replay caches, and dedup sets are cleared
   * before the test starts so each measurement sees a clean topology
   * over a realistically trained routing table.
   *
   * Intended to be called once per DHT, before the first pub/sub test
   * runs. `ensurePubsubPrimed()` below wraps this with a one-shot flag
   * so repeated invocations are harmless no-ops.
   *
   * @param {object} dht — must expose axonFor() and resetAllAxons()
   */
  async _primePubsubRouting(dht) {
    if (typeof dht.axonFor !== 'function') return;
    if (typeof dht.resetAllAxons !== 'function') return;

    const alive = dht.getNodes().filter(n => n.alive);
    if (alive.length < 32) return;

    const NUM_TOPICS     = 8;
    const SAMPLE_SIZE    = Math.min(800, Math.max(64, Math.floor(alive.length * 0.03)));
    const PUBLISH_TICKS  = 3;

    // Pick random publishers and a larger subscriber pool.
    const shuffled    = [...alive].sort(() => Math.random() - 0.5);
    const publishers  = shuffled.slice(0, NUM_TOPICS);
    const subscribers = shuffled.slice(NUM_TOPICS, NUM_TOPICS + SAMPLE_SIZE);

    // Match the topic-naming convention used by the real pub/sub tests
    // so routed subscribes/publishes exercise the same code path (prefix
    // handling, topic-id computation, etc.).
    const usePrefix = dht.usesPublisherPrefix === true;
    const domainFor = (pub) => {
      if (!usePrefix) return 'prime';
      const pfxByte = Number((pub.id >> 56n) & 0xffn);
      return `@${pfxByte.toString(16).padStart(2, '0')}/prime`;
    };

    // Eager-register AxonaManagers across the whole live set so routed
    // subscribes terminate at a handler-installed node.
    for (const n of alive) dht.axonFor(n);

    const adapters = new Map();
    const adapterFor = (node) => {
      let a = adapters.get(node.id);
      if (!a) {
        a = new PubSubAdapter({ transport: dht.axonFor(node) });
        adapters.set(node.id, a);
      }
      return a;
    };

    // Every subscriber subscribes to every topic — 8 × SAMPLE_SIZE routed
    // subscribes total. Cheap but broad enough to train a representative
    // cross-section of the synaptome.
    for (const pub of publishers) {
      if (!this.running) break;
      const domain = domainFor(pub);
      for (const sub of subscribers) {
        adapterFor(sub).subscribe(domain, 'prime', () => {}, 'immediate');
      }
      adapterFor(pub);   // ensure publisher has an adapter
    }

    // Fire publishes so fan-out paths receive training too.
    for (let t = 0; t < PUBLISH_TICKS; t++) {
      if (!this.running) break;
      for (const pub of publishers) {
        adapterFor(pub).publish(domainFor(pub), 'prime', {});
      }
    }

    // Wipe pub/sub state — only the LTP training in the synaptomes
    // survives this call.
    dht.resetAllAxons();
  }

  /**
   * Run `_primePubsubRouting` at most once per DHT, then reset state
   * on subsequent calls. Safe to call from every pub/sub test block.
   */
  async _ensurePubsubPrimed(dht) {
    if (typeof dht.resetAllAxons !== 'function') return;
    if (!dht._pubsubPrimed) {
      await this._primePubsubRouting(dht);
      dht._pubsubPrimed = true;
    } else {
      dht.resetAllAxons();
    }
  }

  // ── Lookup Test ──────────────────────────────────────────────────────────

  /**
   * Run `numMessages` independent random lookups and collect metrics.
   *
   * @param {import('../dht/DHT.js').DHT} dht
   * @param {object}  params
   * @param {number}  params.numMessages
   * @param {boolean} params.captureLastPath  – store the final path for globe viz
   * @returns {Promise<LookupTestResult>}
   */
  async runLookupTest(dht, params = {}) {
    const {
      numMessages    = 500,
      captureLastPath = true,
      regional       = false,
      regionalRadius = 2000,
      hotPct         = 100,
      sourcePct      = 0,    // 0 = disabled; 1-99 = % of nodes that act as sources
      sourceNodes    = null, // pre-built source pool (takes precedence over sourcePct)
      destPct        = 0,    // 0 = disabled; 1-99 = % of nodes designated as destinations
      destNodes      = null, // pre-built destination pool (takes precedence over destPct).
                             // Pass this from runBenchmark so warmup and measurement share
                             // the EXACT same destination set — critical for N-DHT learning.
      destRandom     = false,  // when true and destPool is active, pick a random dest from the
                               // pool instead of the XOR-nearest entry. Used for continent tests
                               // where any cross-continental destination is equally valid.
      managed        = false,  // when true, caller owns this.running (used by runBenchmark)
    } = params;
    if (!managed) this.running = true;

    const hopsArr = [];
    const timeArr = [];
    let failures = 0;
    let lastPath = null;

    // Build a nodeMap once so per-lookup destination checks are O(1)
    const allNodes = dht.getNodes();
    const nodeMap  = new Map(allNodes.map(n => [n.id, n]));

    // In regional mode, pre-compute senders that have at least one node
    // within the radius.  This eliminates all "no nearby nodes" failures
    // and ensures the full numMessages count is meaningful.
    const eligibleSenders = regional
      ? this._eligibleRegionalSenders(dht, regionalRadius)
      : null;

    // Source pool — restricts which nodes can initiate lookups.
    //   1. sourceNodes (pre-built array): use as-is, filtering for liveness.
    //   2. sourcePct (percentage): sample a fresh random pool now.
    //   3. Neither set → no source restriction (standard behaviour).
    // sourcePool is mutually exclusive with hotPool and regional.
    let sourcePool = null;
    if (!regional && sourceNodes) {
      sourcePool = sourceNodes.filter(n => n.alive);
    } else if (!regional && sourcePct > 0 && sourcePct < 100) {
      const aliveNodes = allNodes.filter(n => n.alive);
      const poolSize   = Math.max(1, Math.ceil(aliveNodes.length * sourcePct / 100));
      sourcePool = shuffleSample(aliveNodes, poolSize);
    }

    // Destination pool — three priority levels:
    //   1. destNodes (pre-built array): use as-is, filtering for liveness.
    //      Used by runBenchmark so warmup and measurement share the same pool.
    //   2. destPct (percentage): sample a fresh random pool now.
    //      Used by standalone Lookup Tests from the UI.
    //   3. Neither set → no destination restriction (standard behaviour).
    // destPool and hotPool are mutually exclusive; destPool takes precedence.
    let destPool = null;
    if (destNodes) {
      // Pre-built pool passed in — filter for current liveness only
      destPool = destNodes.filter(n => n.alive);
    } else if (!regional && destPct > 0 && destPct < 100) {
      const aliveNodes = allNodes.filter(n => n.alive);
      const poolSize   = Math.max(1, Math.ceil(aliveNodes.length * destPct / 100));
      destPool = shuffleSample(aliveNodes, poolSize);
    }

    // Hot-node pool: when hotPct < 100 AND neither sourcePool nor destPool is active,
    // restrict both sources and destinations to a random subset of alive nodes.
    // Repeated traffic between the same popular nodes gives the neuromorphic
    // synaptome enough signal to build dense shortcuts.
    let hotPool = null;
    if (!regional && !sourcePool && !destPool && hotPct < 100) {
      const aliveNodes = allNodes.filter(n => n.alive);
      const poolSize   = Math.max(2, Math.ceil(aliveNodes.length * hotPct / 100));
      hotPool = shuffleSample(aliveNodes, poolSize);
    }

    if (regional && eligibleSenders.length === 0) {
      this.running = false;
      return {
        type: 'lookup', hops: null, time: null,
        totalRuns: 0, successes: 0, failures: numMessages,
        successRate: 0, lastPath: null, hopsRaw: [], timeRaw: [],
      };
    }

    const YIELD_EVERY = 1; // Yield every lookup. Even ONE NX-17 NA→AS lookup
                             // can consume ~10 K ops (9 hops × ~1,200 ops).
                             // Yielding between every lookup keeps the main
                             // thread responsive (heartbeat ticks, UI updates)
                             // throughout the test. Overhead of ~500 extra
                             // yields × ~1 ms = ~500 ms per 500-lookup test —
                             // negligible vs the several-minute runtime itself.

    for (let i = 0; i < numMessages; i++) {
      if (!this.running) break;

      const source = regional
        ? eligibleSenders[Math.floor(Math.random() * eligibleSenders.length)]
        : sourcePool
          ? sourcePool[Math.floor(Math.random() * sourcePool.length)]
          : hotPool
            ? hotPool[Math.floor(Math.random() * hotPool.length)]
            : this._randomNode(dht);
      if (!source || !source.alive) { failures++; continue; }

      try {
        let result;
        if (regional) {
          // Pick a receiver within the regional radius and route to its actual
          // node ID using each protocol's native XOR routing.
          const nearby = this._nodesWithinRadius(dht, source, regionalRadius);
          const receiver = nearby[Math.floor(Math.random() * nearby.length)];
          result = await dht.lookup(source.id, receiver.id);
        } else {
          // Pick a target: destPool → hotPool → uniform random.
          let receiver;
          if (destPool) {
            if (destRandom) {
              // Random selection — used for continent tests where any
              // destination in the target region is equally valid. Single
              // pass with rejection: pick a random index, fall back to a
              // bounded scan only if the picked node is dead or self.
              // O(1) typical, O(N_dest) worst case. Avoids allocating a
              // fresh filtered array every lookup (was 5K-element alloc
              // per call at 10 %/50K, 2.5M allocations for a 500-lookup
              // test cell — observable GC stall on the main thread).
              const srcId = source.id;
              receiver = null;
              const tries = Math.min(destPool.length, 8);
              for (let t = 0; t < tries; t++) {
                const cand = destPool[Math.floor(Math.random() * destPool.length)];
                if (cand && cand.alive && cand.id !== srcId) { receiver = cand; break; }
              }
              if (!receiver) {
                // Linear scan fallback (rare — only when the random picks
                // all hit the source or dead nodes).
                for (const n of destPool) {
                  if (n.alive && n.id !== srcId) { receiver = n; break; }
                }
              }
              if (!receiver) receiver = this._randomOtherNode(dht, source.id);
            } else {
              // XOR-nearest selection for hot-dest / CDN traffic pattern.
              // Each client reaches its most topologically-accessible
              // popular node; repeated traffic along those short paths
              // lets N-DHT build dense shortcut webs (the tributary
              // effect).
              //
              // Single-pass scan with cached best-distance — was a
              // .filter().reduce() chain that recomputed best.id^srcId
              // on every comparison and allocated a fresh filtered
              // array per lookup. At 10 %/50K (5K dest pool, 500
              // lookups) that's 2.5M extra BigInt XORs and 2.5M
              // allocations per test cell. Observable browser-tab
              // hang on the v0.70.04 whitepaper-refresh sweep at this
              // exact (G-DHT, dest, 50K) cell.
              const srcId = source.id;
              let bestNode = null;
              let bestDist = 0n;
              for (const n of destPool) {
                if (!n.alive || n.id === srcId) continue;
                const d = n.id ^ srcId;
                if (bestNode === null || d < bestDist) {
                  bestNode = n; bestDist = d;
                }
              }
              receiver = bestNode ?? this._randomOtherNode(dht, source.id);
            }
          } else if (hotPool) {
            const others = hotPool.filter(n => n.id !== source.id && n.alive);
            receiver = others.length > 0
              ? others[Math.floor(Math.random() * others.length)]
              : this._randomOtherNode(dht, source.id);
          } else {
            receiver = this._randomOtherNode(dht, source.id);
          }
          result = await dht.lookup(source.id, receiver ? receiver.id : randomU64());
        }

        if (result && result.found) {
          hopsArr.push(result.hops);
          timeArr.push(result.time);
          if (captureLastPath && result.path.length > 1) {
            lastPath = result.path;
          }
        } else {
          failures++;
        }
      } catch {
        failures++;
      }

      // Yield & report progress periodically
      if ((i + 1) % YIELD_EVERY === 0) {
        await this._yield();
        if (this.onProgress) {
          this.onProgress((i + 1) / numMessages, this._partialStats(hopsArr, timeArr));
        }
      }
    }

    const result = {
      type: 'lookup',
      hops: computeStats(hopsArr),
      time: computeStats(timeArr),
      totalRuns: numMessages,
      successes: hopsArr.length,
      failures,
      successRate: hopsArr.length / numMessages,
      lastPath,
      hopsRaw: hopsArr,
      timeRaw: timeArr,
    };

    if (!managed) {
      if (this.onComplete) this.onComplete(result);
      if (captureLastPath && lastPath && this.onPathFound) {
        this.onPathFound(lastPath, dht);
      }
      this.running = false;
    }
    return result;
  }

  // ── Benchmark ────────────────────────────────────────────────────────────

  /**
   * Run a multi-protocol, multi-radius benchmark.
   *
   * For each entry in `protocolDefs`, calls `entry.buildFn()` (async) to get a
   * pre-built DHT, then runs lookups at each radius in `radii`.  A radius of 0
   * means global (uniform random pairs).
   *
   * @param {Array<{key:string, label:string, buildFn:()=>Promise<DHT>}>} protocolDefs
   * @param {object}   params
   * @param {object[]} params.testSpecs      - Array of test-cell descriptors:
   *   { type:'regional', radius:number } | { type:'global' } | { type:'dest', pct:number }
   * @param {number}   params.numMessages    - Lookups per cell.
   * @param {Function} params.onStart        - (msg:string) => void  — status before each cell
   * @param {Function} params.onStep         - (msg:string) => void  — called after each cell completes
   * @returns {Promise<object>}  { protocolDefs, testSpecs, data }
   *   data[protocolKey][specKey] = { hops, time, successRate, totalRuns }
   */
  /**
   * v0.70.04 — apply a single round of churn (kill + bootstrap-join + heal).
   *
   * Used by training-mode sweeps that interleave churn with traffic-load
   * snapshots to validate "does the throttled neuromorphic profile still
   * recover under sustained churn?" The benchmark's churn test runs a
   * fixed 5 rounds; this lets training drive per-cycle churn at any rate
   * with the same kill / replace / heal mechanics.
   *
   * @param {object} dht
   * @param {number} ratePct        — % of live nodes to replace this round
   * @param {Function|null} landFn  — (lat,lng)=>bool land detector
   */
  async applyChurnRound(dht, ratePct, landFn = null) {
    const rate = Math.max(0, Math.min(1, ratePct / 100));
    if (rate <= 0) return { killed: 0, added: 0 };
    const getLandPoint = landFn ?? (() => randomLandPoint(null));
    const alive = dht.getNodes().filter(n => n.alive);
    const numToReplace = Math.max(1, Math.floor(alive.length * rate));
    for (const node of shuffleSample(alive, numToReplace)) {
      await dht.removeNode(node.id);
    }
    const liveAfter = dht.getNodes().filter(n => n.alive);
    let added = 0;
    for (let i = 0; i < numToReplace; i++) {
      const { lat, lng } = getLandPoint();
      const newNode = await dht.addNode(lat, lng);
      const sponsor = liveAfter[Math.floor(Math.random() * liveAfter.length)];
      if (sponsor && typeof dht.bootstrapJoin === 'function') {
        dht.bootstrapJoin(newNode.id, sponsor.id);
      }
      added++;
    }
    if (typeof dht.postChurnHeal === 'function') await dht.postChurnHeal();
    dht.verifyConnectionCap?.('training-churn');
    return { killed: numToReplace, added };
  }

  async runBenchmark(protocolDefs, params = {}) {
    const {
      testSpecs = [
        { type: 'regional', radius: 500  },
        { type: 'regional', radius: 1000 },
        { type: 'regional', radius: 2000 },
        { type: 'regional', radius: 5000 },
        { type: 'global' },
      ],
      numMessages = 500,
      landFn      = null,       // () => {lat, lng} — for churn node replacement
      onStart     = () => {},   // (msg) => void — status update only, no progress increment
      onStep      = () => {},   // (msg) => void — called after each cell completes
    } = params;

    // Stable string key and human-readable label for each test spec.
    const specKey   = s => s.type === 'regional'  ? `r${s.radius}`
                         : s.type === 'dest'      ? `dest_${s.pct}`
                         : s.type === 'source'    ? `src_${s.pct}`
                         : s.type === 'srcdest'   ? `srcdest_${s.srcPct}_${s.destPct}`
                         : s.type === 'churn'     ? `churn_${s.rate}`
                         : s.type === 'continent' ? `cont_${s.src}_${s.dst}`
                         : s.type === 'slice'     ? 'slice'
                         : s.type === 'pubsub'    ? 'pubsub'
                         : 'global';
    const specLabel = s => s.type === 'regional'  ? `${s.radius} km`
                         : s.type === 'dest'      ? `${s.pct}% dest`
                         : s.type === 'source'    ? `${s.pct}% src`
                         : s.type === 'srcdest'   ? `${s.srcPct}%→${s.destPct}%`
                         : s.type === 'churn'     ? `${s.rate}% churn`
                         : s.type === 'continent' ? `${s.src}→${s.dst}`
                         : s.type === 'slice'     ? 'Slice World'
                         : s.type === 'pubsub'    ? 'Pub/Sub'
                         : 'Global';

    this.running = true;
    const data   = {};
    const totalProtos = protocolDefs.length;
    let deltaReported = false;  // δ baseline measurement — once per sweep

    // ── Diagnostic instrumentation ──────────────────────────────────────
    //
    // Print one line per protocol start, per test cell start, per churn
    // round, per test cell end, and per protocol end — with current heap
    // usage in MB.  performance.memory is Chrome-only (V8 exposes it
    // unconditionally when devtools is open; behind the
    // --enable-precise-memory-info flag otherwise).  Other engines just
    // log without the heap number.
    //
    // Format: `[bench] <event> protocol=… ...`  — grep-friendly.

    const heapMB = () => {
      const m = (typeof performance !== 'undefined' && performance.memory)
        ? performance.memory
        : null;
      if (!m) return '?';
      const used = (m.usedJSHeapSize / 1048576).toFixed(1);
      const limit = (m.jsHeapSizeLimit / 1048576).toFixed(0);
      return `${used}/${limit}MB`;
    };

    const logBench = (...parts) => {
      const line = '[bench] ' + parts.join(' ') + ' heap=' + heapMB();
      // Console — visible in DevTools, captured by Preview's log surface.
      console.log(line);
      // POST to the server so it lands in research.log too.  Async,
      // fire-and-forget; an HTTP error here must never abort the sweep.
      try {
        fetch('/api/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entry: line }),
        }).catch(() => {});
      } catch (_) { /* ignore */ }
    };

    for (let defIdx = 0; defIdx < totalProtos; defIdx++) {
      const def = protocolDefs[defIdx];
      if (!this.running) break;
      data[def.key] = {};
      // Tag prepended to every status message: "N-5 (7/11)"
      const tag = `${def.label} (${defIdx + 1}/${totalProtos})`;

      // Build phase reported by caller via def.buildFn
      logBench('PROTOCOL-build-start', `protocol=${def.label}`,
               `(${defIdx + 1}/${totalProtos})`);
      const dht = await def.buildFn();
      if (!dht) continue;
      logBench('PROTOCOL-build-done', `protocol=${def.label}`,
               `nodes=${dht.getNodes?.().length ?? '?'}`);

      // δ baseline: median pairwise one-way latency for this population.
      // Used as the Dabek 3δ theoretical floor for lookup latency.
      // Only measure once per sweep (population identical across protocols).
      if (!deltaReported) {
        deltaReported = true;
        const allNodes = dht.getNodes().filter(n => n.alive);
        const SAMPLES = 10000;
        const oneWay = [];
        for (let s = 0; s < SAMPLES; s++) {
          const a = allNodes[Math.floor(Math.random() * allNodes.length)];
          const b = allNodes[Math.floor(Math.random() * allNodes.length)];
          if (a.id !== b.id) oneWay.push(messageLatency(a, b));
        }
        const stats = computeStats(oneWay);
        const dLine = `[δ baseline] N=${allNodes.length} samples=${oneWay.length} ` +
          `median=${stats.median.toFixed(2)}ms mean=${stats.mean.toFixed(2)}ms ` +
          `p25=${stats.p25.toFixed(2)} p75=${stats.p75.toFixed(2)} ` +
          `p95=${stats.p95.toFixed(2)} max=${stats.max.toFixed(2)} | ` +
          `3δ_median=${(3 * stats.median).toFixed(1)}ms ` +
          `3δ_mean=${(3 * stats.mean).toFixed(1)}ms`;
        try {
          fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entry: dLine }),
          }).catch(() => {});
        } catch (_) { /* ignore */ }
        // Stash on the engine for the CSV writer to pick up
        this._deltaBaseline = stats;
      }

      // Optional warmup for protocols that need pre-training (e.g. neuromorphic).
      // Runs a burst of hot-node regional lookups so synaptic weights form before
      // any measurement cells are recorded.  Warmup counts are specified on the
      // protocol def; non-neuromorphic protocols leave warmupLookups undefined/0.
      if (def.warmupLookups > 0) {
        onStart(`${tag} · warming up (${def.warmupLookups.toLocaleString()} regional lookups)…`);
        await this.runLookupTest(dht, {
          numMessages:    def.warmupLookups,
          captureLastPath: false,
          regional:       true,
          regionalRadius: def.warmupRadius ?? 2000,
          hotPct:         def.warmupHotPct ?? 10,
          managed:        true,
        });
      }

      // NX-5+: additional global warmup so learning mechanisms can exercise
      // and repair long-range routes that bootstrap may have missed.
      if (def.warmupGlobalLookups > 0) {
        onStart(`${tag} · global warmup (${def.warmupGlobalLookups.toLocaleString()} lookups)…`);
        await this.runLookupTest(dht, {
          numMessages:    def.warmupGlobalLookups,
          captureLastPath: false,
          regional:       false,
          hotPct:         100,
          managed:        true,
        });
      }

      // Bilateral-cap invariant check after warmup completes. Warmup-driven
      // hop caching, triadic closure, and annealing all add synapses; if any
      // bypass tryConnect we'd see overflow here.
      if (def.warmupLookups > 0 || def.warmupGlobalLookups > 0) {
        dht.verifyConnectionCap?.(`${tag} post-warmup`);
      }

      for (const spec of testSpecs) {
        if (!this.running) break;

        // Build the dest/source pool ONCE per spec so that both the warmup and the
        // measurement run against the EXACT same node set.  This is critical
        // for neuromorphic protocols: the synaptome learns routes toward/from specific
        // nodes during warmup; if the measurement used a different random pool
        // those learned shortcuts would never fire.
        let sharedDestNodes   = null;
        let sharedSourceNodes = null;
        if (spec.type === 'dest') {
          const alive    = dht.getNodes().filter(n => n.alive);
          const poolSize = Math.max(1, Math.ceil(alive.length * spec.pct / 100));
          sharedDestNodes = shuffleSample(alive, poolSize);
        }
        if (spec.type === 'source') {
          const alive    = dht.getNodes().filter(n => n.alive);
          const poolSize = Math.max(1, Math.ceil(alive.length * spec.pct / 100));
          sharedSourceNodes = shuffleSample(alive, poolSize);
        }
        if (spec.type === 'srcdest') {
          const alive       = dht.getNodes().filter(n => n.alive);
          const srcPoolSize = Math.max(1, Math.ceil(alive.length * spec.srcPct / 100));
          const dstPoolSize = Math.max(1, Math.ceil(alive.length * spec.destPct / 100));
          sharedSourceNodes = shuffleSample(alive, srcPoolSize);
          // Destination pool must not overlap with source pool to model the
          // separation between active senders and active receivers.
          const srcSet      = new Set(sharedSourceNodes.map(n => n.id));
          const nonSrc      = alive.filter(n => !srcSet.has(n.id));
          sharedDestNodes   = shuffleSample(nonSrc.length >= dstPoolSize ? nonSrc : alive, dstPoolSize);
        }
        if (spec.type === 'continent') {
          // Pre-compute the full node sets for each continent.  Both pools are used
          // for both warmup and measurement so the synaptome trains on the exact
          // cross-continental routes that will be measured.
          const alive       = dht.getNodes().filter(n => n.alive);
          sharedSourceNodes = alive.filter(n => continentOf(n.lat, n.lng) === spec.src);
          sharedDestNodes   = alive.filter(n => continentOf(n.lat, n.lng) === spec.dst);
        }

        // Dest-specific warmup for neuromorphic protocols.
        if (spec.type === 'dest' && def.warmupLookups > 0) {
          onStart(`${tag} · warming up for ${spec.pct}% dest (${def.warmupLookups.toLocaleString()} lookups)…`);
          await this.runLookupTest(dht, {
            numMessages:    def.warmupLookups,
            captureLastPath: false,
            destNodes:      sharedDestNodes,   // same pool as measurement
            managed:        true,
          });
        }

        // Source-specific warmup for neuromorphic protocols.
        if (spec.type === 'source' && def.warmupLookups > 0) {
          onStart(`${tag} · warming up for ${spec.pct}% src (${def.warmupLookups.toLocaleString()} lookups)…`);
          await this.runLookupTest(dht, {
            numMessages:    def.warmupLookups,
            captureLastPath: false,
            sourceNodes:    sharedSourceNodes,
            managed:        true,
          });
        }

        // Src→Dest combined warmup for neuromorphic protocols.
        if (spec.type === 'srcdest' && def.warmupLookups > 0) {
          onStart(`${tag} · warming up for ${spec.srcPct}%→${spec.destPct}% (${def.warmupLookups.toLocaleString()} lookups)…`);
          await this.runLookupTest(dht, {
            numMessages:    def.warmupLookups,
            captureLastPath: false,
            sourceNodes:    sharedSourceNodes,
            destNodes:      sharedDestNodes,
            managed:        true,
          });
        }

        // Continent-crossing warmup: train the synaptome on trans-continental
        // routes before measurement so long-range strata can build shortcuts.
        if (spec.type === 'continent' && def.warmupLookups > 0) {
          onStart(`${tag} · warming up for ${spec.src}→${spec.dst} (${def.warmupLookups.toLocaleString()} lookups)…`);
          await this.runLookupTest(dht, {
            numMessages:    def.warmupLookups,
            captureLastPath: false,
            sourceNodes:    sharedSourceNodes,
            destNodes:      sharedDestNodes,
            destRandom:     true,   // any destination in the target continent is valid
            managed:        true,
          });
        }

        // ── Churn rounds (applied before final measurement, always last spec) ──
        if (spec.type === 'churn') {
          const CHURN_ROUNDS  = 5;
          const rate          = (spec.rate ?? 5) / 100;
          const getLandPoint  = landFn ?? (() => randomLandPoint(null));
          // Adapt lookups between rounds for neuromorphic protocols.
          // Scale to warmupLookups / CHURN_ROUNDS so per-round density matches
          // the original warmup density — critical at high node counts where
          // 100 fixed lookups cover only a tiny fraction of replaced nodes.
          const ADAPT_LOOKUPS = def.warmupLookups > 0
            ? Math.max(100, Math.round(def.warmupLookups / CHURN_ROUNDS))
            : 0;

          for (let round = 0; round < CHURN_ROUNDS; round++) {
            if (!this.running) break;
            onStart(`${tag} · churn round ${round + 1}/${CHURN_ROUNDS} (${spec.rate}% turnover)…`);
            logBench('CHURN-round',
                     `protocol=${def.label}`,
                     `round=${round + 1}/${CHURN_ROUNDS}`,
                     `rate=${spec.rate}%`);

            const alive = dht.getNodes().filter(n => n.alive);
            const numToReplace = Math.max(1, Math.floor(alive.length * rate));
            for (const node of shuffleSample(alive, numToReplace)) {
              await dht.removeNode(node.id);
            }
            // Add replacement nodes — each performs a realistic iterative
            // bootstrap join through a random live sponsor, discovering the
            // network the same way a real node would (no omniscient sorted
            // array).  The sponsor is picked randomly from the live set.
            const liveAfterRemoval = dht.getNodes().filter(n => n.alive);
            for (let i = 0; i < numToReplace; i++) {
              const { lat, lng } = getLandPoint();
              const newNode = await dht.addNode(lat, lng);
              // Pick a random live sponsor for the iterative join.
              const sponsor = liveAfterRemoval[
                Math.floor(Math.random() * liveAfterRemoval.length)
              ];
              if (sponsor && typeof dht.bootstrapJoin === 'function') {
                dht.bootstrapJoin(newNode.id, sponsor.id);
              }
            }

            // NX-12+: Second-pass re-heal — repair any synapses whose
            // first-pass replacement was also churned in this same batch.
            if (typeof dht.postChurnHeal === 'function') {
              await dht.postChurnHeal();
            }
            // Bilateral-cap invariant check after each churn round. No-op
            // when web limit is off (cap=Infinity). Surfaces any new protocol
            // that bypasses tryConnect during bootstrapJoin or churn-heal.
            dht.verifyConnectionCap?.(`${tag} churn-round-${round + 1}`);

            // Neuromorphic protocols get adaptation lookups between rounds
            // so synaptic weights can adjust to the changed topology.
            if (ADAPT_LOOKUPS > 0 && round < CHURN_ROUNDS - 1) {
              await this.runLookupTest(dht, {
                numMessages:    ADAPT_LOOKUPS,
                captureLastPath: false,
                managed:        true,
              });
            }
            await this._yield();
          }
        }

        // ── Pub/Sub measurement ─────────────────────────────────────────────
        // Pub/sub is handled entirely here; skip the normal runLookupTest path.
        if (spec.type === 'pubsub') {
          const groupSize = spec.groupSize ?? 32;
          const coverage  = spec.coverage  ?? 10;

          // Build concordance groups using the same staggered-stride strategy
          // as the interactive pub/sub test so routing patterns are consistent.
          const aliveNodes  = dht.getNodes().filter(n => n.alive);
          const targetNodes = Math.ceil(aliveNodes.length * coverage / 100);
          const numGroups   = Math.max(1, Math.ceil(targetNodes / groupSize));
          const shuffled    = [...aliveNodes].sort(() => Math.random() - 0.5);
          const stride      = Math.max(1, Math.floor(shuffled.length / numGroups));

          const groups = [];
          for (let i = 0; i < numGroups; i++) {
            const base         = (i * stride) % shuffled.length;
            const relay        = shuffled[base];
            const participants = [];
            for (let j = 1; j <= groupSize; j++) {
              participants.push(shuffled[(base + j) % shuffled.length]);
            }
            groups.push({ id: i, relay, participants });
          }

          // Pub/sub warmup: 2× the standard warmup budget, using actual pub/sub
          // ticks so the synaptome learns relay→participant routes specifically.
          if (def.warmupLookups > 0) {
            const warmupTicks = Math.ceil((def.warmupLookups * 2) / (groupSize + 1));
            onStart(`${tag} · pub/sub warmup (${warmupTicks} ticks)…`);
            for (let t = 0; t < warmupTicks; t++) {
              if (!this.running) break;
              await this.runPubSubTick(dht, groups);
            }
          }

          // Measurement: enough ticks to match the lookup count of other cells.
          const measTicks = Math.max(10, Math.ceil(numMessages / (groupSize + 1)));
          onStart(`${tag} · Pub/Sub (${measTicks} ticks)…`);

          const allMsgHops      = [];
          const allMsgMs        = [];
          const allBcastHops    = [];
          const allBcastMs      = [];
          const allMaxFanout    = [];
          const allAvgSubs      = [];
          let   maxTreeDepth    = 0;
          for (let t = 0; t < measTicks; t++) {
            if (!this.running) break;
            const tick = await this.runPubSubTick(dht, groups);
            if (!tick) continue;
            allMsgHops.push(tick.msgHops);
            if (tick.msgMs > 0) allMsgMs.push(tick.msgMs);
            allBcastHops.push(...tick.bcastHops);
            if (tick.bcastMsStats?.mean != null) allBcastMs.push(tick.bcastMsStats.mean);
            if (tick.maxNodeLookups != null) allMaxFanout.push(tick.maxNodeLookups);
            if (tick.avgSubsPerNode != null) allAvgSubs.push(tick.avgSubsPerNode);
            if (tick.treeDepth != null) maxTreeDepth = Math.max(maxTreeDepth, tick.treeDepth);
          }

          data[def.key]['pubsub'] = {
            msgHops:       computeStats(allMsgHops),
            msgMs:         computeStats(allMsgMs),
            bcastHops:     computeStats(allBcastHops),
            bcastMs:       computeStats(allBcastMs),
            maxFanout:     computeStats(allMaxFanout),
            avgSubsPerNode: computeStats(allAvgSubs),
            treeDepth:     maxTreeDepth,
            numGroups,
            totalTicks:    measTicks,
          };
          onStep(`${tag} · Pub/Sub ✓`);
          continue; // skip the normal runLookupTest path
        }

        // ── Pub/Sub Membership measurement (NX-15+) ─────────────────────────
        // Drives the AxonaManager-based membership protocol rather than the
        // inherited one-shot pubsubBroadcast. Each participant in every
        // group subscribes via a PubSubAdapter; each tick, the relay
        // publishes via its own adapter; we count deliveries per-group and
        // inspect the resulting axon tree. Only supported on DHTs that
        // expose `axonFor` (NX-15 and descendants).
        if (spec.type === 'pubsubm' || spec.type === 'pubsubm-local') {
          const isLocal = spec.type === 'pubsubm-local';
          const resultKey = isLocal ? 'pubsubm-local' : 'pubsubm';
          const label     = isLocal ? 'Pub/Sub (Local)' : 'Pub/Sub (Membership)';

          if (typeof dht.axonFor !== 'function') {
            data[def.key][resultKey] = {
              unsupported: true,
              reason:      'protocol does not expose axonFor()',
            };
            onStep(`${tag} · ${label} — n/a`);
            continue;
          }

          // Prime synaptomes once (first pub/sub test on this DHT) and
          // reset AxonaManager state so the tree we're about to measure
          // is not contaminated by any previous pub/sub test.
          onStart(`${tag} · ${label} · priming pub/sub routing…`);
          await this._ensurePubsubPrimed(dht);

          const groupSize = spec.groupSize ?? 32;
          const coverage  = spec.coverage  ?? 10;
          const radiusKm  = spec.radius    ?? 2000;

          const aliveNodes  = dht.getNodes().filter(n => n.alive);
          const targetNodes = Math.ceil(aliveNodes.length * coverage / 100);
          const numGroups   = Math.max(1, Math.ceil(targetNodes / groupSize));

          // Group construction differs between variants:
          //   pubsubm        — relays + participants are random, global
          //                    (stride through a shuffled node list so no
          //                    geographic locality).
          //   pubsubm-local  — relays are picked widely apart, and each
          //                    relay's participants are the `groupSize`
          //                    closest alive nodes by haversine distance
          //                    (within `radiusKm`). If a relay has fewer
          //                    than groupSize neighbours in the radius,
          //                    the group runs at whatever size it has —
          //                    we'd rather measure honest locality than
          //                    pad with far-away nodes.
          const shuffled    = [...aliveNodes].sort(() => Math.random() - 0.5);
          const groups      = [];
          if (!isLocal) {
            const stride = Math.max(1, Math.floor(shuffled.length / numGroups));
            for (let i = 0; i < numGroups; i++) {
              const base         = (i * stride) % shuffled.length;
              const relay        = shuffled[base];
              const participants = [];
              for (let j = 1; j <= groupSize; j++) {
                participants.push(shuffled[(base + j) % shuffled.length]);
              }
              groups.push({ id: i, relay, participants });
            }
          } else {
            // Pick relays widely apart by sampling at stride intervals from
            // the shuffled list (same as the global variant — spreads them
            // across latitudes/longitudes roughly uniformly since geoCellId
            // is not correlated with list position).
            const stride = Math.max(1, Math.floor(shuffled.length / numGroups));
            const relays = [];
            for (let i = 0; i < numGroups; i++) {
              relays.push(shuffled[(i * stride) % shuffled.length]);
            }
            // For each relay, find the `groupSize` closest neighbours by
            // haversine distance within radiusKm, excluding other relays.
            const relaySet = new Set(relays.map(r => r.id));
            for (let i = 0; i < relays.length; i++) {
              const relay = relays[i];
              const cand  = [];
              for (const n of aliveNodes) {
                if (n === relay || relaySet.has(n.id)) continue;
                const d = haversine(relay.lat, relay.lng, n.lat, n.lng);
                if (d <= radiusKm) cand.push({ node: n, d });
              }
              cand.sort((a, b) => a.d - b.d);
              const participants = cand.slice(0, groupSize).map(x => x.node);
              // Even if participants is empty, push the group so CSV gets
              // a consistent row count; measureDeliveredPct tolerates it.
              groups.push({ id: i, relay, participants });
            }
          }

          // Pre-register an AxonaManager on every live node. The membership
          // protocol needs a handler on whichever node happens to be the
          // terminal (closest to hash(topic)) for each group's topic —
          // otherwise the routed subscribe walks all the way to terminal
          // and silently fizzles because no handler intercepts it. We
          // can't know in advance which node the hash will land on, so we
          // blanket-register. Handler/state footprint is ~1 KB per node.
          for (const node of aliveNodes) dht.axonFor(node);

          // Set up one PubSubAdapter per distinct node (relay or participant).
          // `entries.get(nodeId) = { adapter, deliveries: Map<groupId, bool> }`.
          // We subscribe each participant to its own group's topic and
          // install a per-group callback that flips the delivery bit when
          // a publish arrives.
          const entries = new Map();
          const getEntry = (node) => {
            let e = entries.get(node.id);
            if (e) return e;
            e = { node, adapter: new PubSubAdapter({ transport: dht.axonFor(node) }), deliveries: new Map() };
            entries.set(node.id, e);
            return e;
          };

          // Topic naming: protocols that opt into publisher-prefix addressing
          // (NX-17+) get '@XX/bench' as the domain, where XX is the relay's
          // 8-bit S2 cell prefix in lowercase hex. The adapter's
          // topicIdForPrefixed parses the sentinel and pins the topic ID
          // into the relay's cell. Older protocols (NX-15 and earlier) get plain
          // 'bench' and fall through to the unprefixed 64-bit hash.
          const usePrefix    = dht.usesPublisherPrefix === true;
          const domainFor    = (group) => {
            if (!usePrefix) return 'bench';
            const pfxByte = Number((group.relay.id >> 56n) & 0xffn);
            return `@${pfxByte.toString(16).padStart(2, '0')}/bench`;
          };

          for (const group of groups) {
            const gKey   = 'g' + group.id;
            const domain = domainFor(group);
            for (const p of group.participants) {
              const entry = getEntry(p);
              entry.deliveries.set(group.id, false);
              // Capture by-group delivery via the subscribe callback.
              entry.adapter.subscribe(domain, gKey,
                () => { entry.deliveries.set(group.id, true); }, 'immediate');
            }
            // Publisher adapter (may be different node than any participant).
            getEntry(group.relay);
          }

          // Short warmup — let the tree stabilise before we start counting.
          const warmupTicks = 3;
          onStart(`${tag} · ${label} warmup (${warmupTicks} ticks)…`);
          const runOneTick = async () => {
            // Reset per-group delivery bits.
            for (const e of entries.values()) {
              for (const gid of e.deliveries.keys()) e.deliveries.set(gid, false);
            }
            // Publish on each group. Yield every 20 groups so a tick
            // doesn't freeze the main thread on heavy N-DHT publishes.
            let i = 0;
            for (const group of groups) {
              const gKey = 'g' + group.id;
              getEntry(group.relay).adapter.publish(domainFor(group), gKey, {});
              if (++i % 20 === 0) await this._yield();
            }
          };
          for (let t = 0; t < warmupTicks; t++) { if (!this.running) break; await runOneTick(); }

          const measTicks = Math.max(10, Math.ceil(numMessages / (groupSize + 1)));
          onStart(`${tag} · ${label} (${measTicks} ticks)…`);

          const perTickDeliveredPct = [];
          const perTickAxonRoles    = [];
          const perTickMaxChildren  = [];
          const perTickTreeDepth    = [];
          for (let t = 0; t < measTicks; t++) {
            if (!this.running) break;
            await runOneTick();

            // Count per-group delivery rate for this tick.
            let delivered = 0, expected = 0;
            for (const group of groups) {
              for (const p of group.participants) {
                expected++;
                if (entries.get(p.id).deliveries.get(group.id)) delivered++;
              }
            }
            perTickDeliveredPct.push(expected === 0 ? 100 : (delivered / expected) * 100);

            // Inspect the network's axon roles for each topic.
            let totalRoles = 0, maxChildren = 0, maxDepth = 1;
            for (const group of groups) {
              const topicId = topicIdForPrefixed(domainFor(group), 'g' + group.id);
              for (const axon of dht._axonsByNode.values()) {
                const role = axon.axonRoles.get(topicId);
                if (!role) continue;
                totalRoles++;
                maxChildren = Math.max(maxChildren, role.children.size);
                if (!role.isRoot) maxDepth = Math.max(maxDepth, 2); // simple depth proxy
              }
            }
            perTickAxonRoles.push(totalRoles);
            perTickMaxChildren.push(maxChildren);
            perTickTreeDepth.push(maxDepth);
          }

          // Per-topic K-closest overlap diagnostic. Measures whether the
          // publisher and a sample of its subscribers compute the same K
          // set for each topic. At steady state this should be ~100% (all
          // K, all pairs) if the addressing scheme produces deterministic
          // convergence. Divergence here is the proximate cause of
          // delivery misses seen in pubsubmchurn — measuring it separately
          // helps explain churn behaviour.
          const SAMPLE_PER_GROUP = 5;
          const anyAxon = [...dht._axonsByNode.values()][0];
          // Use `||` (not `??`) so rootSetSize=0 — which signals routed
          // mode with no K-replication — still falls through to K=5 for
          // the diagnostic computation. Overlap / stability stay
          // meaningful metrics in routed mode too: they answer "do
          // publisher and subscriber agree on the top-K candidates by
          // XOR distance to topicId", which predicts delivery regardless
          // of whether the protocol actually stores at all K of them.
          const overlapK = anyAxon?.rootSetSize || 5;
          let totalOverlap = 0, totalSamples = 0, fullConverge = 0;
          // ── Source-rule attribution diagnostic (NH-1 / NX-15 with tagged synapses) ──
          // For each (publisher, subscriber) pair where the K-sets diverge,
          // tabulate WHICH RULE introduced each divergent peer in the
          // subscriber's local view. This pinpoints whether triadic / hop-cache
          // / lateral-spread / etc. is the dominant source of K-set drift.
          //
          // A divergent peer P is "in subK but not pubK" — meaning the
          // subscriber's findKClosest considered P close enough to be in
          // its top-K, but the publisher's didn't. We look up P in the
          // subscriber's synaptome (or incomingSynapses) to find its
          // _addedBy tag. Peers reached only through 2-hop iterative search
          // (not in subscriber's direct routing table) are tagged
          // 'discoveredByIter' since their introduction is implicit.
          const ruleTally = new Map();   // ruleName → { divergent: count, totalAppearances: count }
          const recordRule = (rule, isDivergent) => {
            let entry = ruleTally.get(rule);
            if (!entry) { entry = { divergent: 0, total: 0 }; ruleTally.set(rule, entry); }
            entry.total++;
            if (isDivergent) entry.divergent++;
          };
          for (const group of groups) {
            const topicId = topicIdForPrefixed(domainFor(group), 'g' + group.id);
            const pubK = dht.findKClosest(group.relay, topicId, overlapK).map(n => n.id);
            const pubSet = new Set(pubK);
            const sample = group.participants.slice(0, SAMPLE_PER_GROUP);
            for (const sub of sample) {
              const subK = dht.findKClosest(sub, topicId, overlapK).map(n => n.id);
              const ov = subK.filter(id => pubSet.has(id)).length;
              totalOverlap += ov;
              totalSamples++;
              if (ov === overlapK) fullConverge++;

              // Attribute each subK member's rule of origin in `sub`'s
              // synaptome. Mark those NOT in pubSet as divergent.
              for (const id of subK) {
                let rule = 'discoveredByIter';
                const directSyn = sub.synaptome?.get(id);
                if (directSyn) {
                  rule = directSyn._addedBy ?? 'untagged';
                } else if (sub.incomingSynapses?.has(id)) {
                  rule = 'incomingSynapse';
                }
                recordRule(rule, !pubSet.has(id));
              }
            }
          }
          const overlap = totalSamples === 0
            ? { overlapPct: null, convergePct: null, samples: 0 }
            : {
                overlapPct:  (totalOverlap / (totalSamples * overlapK)) * 100,
                convergePct: (fullConverge / totalSamples) * 100,
                samples:     totalSamples,
              };
          // Emit the rule-tally to the console for analysis. Sorted by
          // divergent count desc; shows total appearances for context
          // (so we can compute "divergence rate per rule").
          if (ruleTally.size > 0) {
            const sorted = [...ruleTally.entries()].sort((a, b) =>
              b[1].divergent - a[1].divergent);
            const proto = dht.constructor.protocolName ?? dht.constructor.name;
            console.log(`[k-set-divergence] ${proto} ${spec.type}:`);
            for (const [rule, stats] of sorted) {
              const rate = stats.total > 0 ? (100 * stats.divergent / stats.total).toFixed(1) : '0.0';
              console.log(`  ${rule.padEnd(20)} divergent=${stats.divergent.toString().padStart(4)}  total=${stats.total.toString().padStart(4)}  rate=${rate}%`);
            }
          }

          data[def.key][resultKey] = {
            deliveredPct:  computeStats(perTickDeliveredPct),
            axonRoles:     computeStats(perTickAxonRoles),
            maxChildren:   computeStats(perTickMaxChildren),
            treeDepth:     Math.max(...perTickTreeDepth, 1),
            overlap,
            numGroups,
            groupSize,
            totalTicks:    measTicks,
            ...(isLocal ? { radiusKm, avgParticipants: groups.reduce((s, g) => s + g.participants.length, 0) / Math.max(1, groups.length) } : {}),
          };
          onStep(`${tag} · ${label} ✓`);
          continue;
        }

        // ── Pub/Sub Membership + Churn (NX-15+) ─────────────────────────────
        // Measures how K-closest replication + TTL/refresh holds up when a
        // fraction of nodes die mid-test. Three phases produce three
        // independent delivery-rate numbers:
        //
        //   baseline  — steady-state delivery before any churn
        //   immediate — delivery right after killing `rate`% of nodes,
        //               before any refresh cycles run (measures raw
        //               resilience from K-fold replication alone)
        //   recovered — delivery after driving refresh ticks across all
        //               surviving axons (measures whether TTL/refresh +
        //               K-closest drift-tracking heal the tree)
        //
        // Dead subscribers are excluded from the denominator — the
        // question is "do surviving subscribers still get messages?",
        // not "can dead nodes receive publishes?" (obviously no).
        if (spec.type === 'pubsubmchurn') {
          if (typeof dht.axonFor !== 'function') {
            data[def.key]['pubsubmchurn'] = { unsupported: true };
            onStep(`${tag} · Pub/Sub (Membership+Churn) — n/a`);
            continue;
          }

          // Prime synaptomes once (first pub/sub test on this DHT) and
          // reset AxonaManager state so baseline/immediate/recovered
          // measurements reflect this test only.
          onStart(`${tag} · Pub/Sub+Churn · priming pub/sub routing…`);
          await this._ensurePubsubPrimed(dht);

          const groupSize = spec.groupSize ?? 32;
          const coverage  = spec.coverage  ?? 10;
          const churnRate = spec.rate      ?? 25;

          const aliveNodes  = dht.getNodes().filter(n => n.alive);
          const targetNodes = Math.ceil(aliveNodes.length * coverage / 100);
          const numGroups   = Math.max(1, Math.ceil(targetNodes / groupSize));
          const shuffled    = [...aliveNodes].sort(() => Math.random() - 0.5);
          const stride      = Math.max(1, Math.floor(shuffled.length / numGroups));

          const groups = [];
          for (let i = 0; i < numGroups; i++) {
            const base         = (i * stride) % shuffled.length;
            const relay        = shuffled[base];
            const participants = [];
            for (let j = 1; j <= groupSize; j++) {
              participants.push(shuffled[(base + j) % shuffled.length]);
            }
            groups.push({ id: i, relay, participants });
          }

          // Pre-register axons on every live node (same reason as pubsubm).
          for (const node of aliveNodes) dht.axonFor(node);

          // Subscribe every participant and install per-group delivery bits.
          const entries = new Map();
          const getEntry = (node) => {
            let e = entries.get(node.id);
            if (e) return e;
            e = { node, adapter: new PubSubAdapter({ transport: dht.axonFor(node) }),
                  deliveries: new Map() };
            entries.set(node.id, e);
            return e;
          };
          // Same '@XX/bench' topic-naming logic as the pubsubm handler
          // above. NX-17+ (dht.usesPublisherPrefix) gets the publisher's
          // cell prefix baked into every topic ID.
          const usePrefix = dht.usesPublisherPrefix === true;
          const domainFor = (group) => {
            if (!usePrefix) return 'bench';
            const pfxByte = Number((group.relay.id >> 56n) & 0xffn);
            return `@${pfxByte.toString(16).padStart(2, '0')}/bench`;
          };

          for (const group of groups) {
            const gKey   = 'g' + group.id;
            const domain = domainFor(group);
            for (const p of group.participants) {
              const entry = getEntry(p);
              entry.deliveries.set(group.id, false);
              entry.adapter.subscribe(domain, gKey,
                () => { entry.deliveries.set(group.id, true); }, 'immediate');
            }
            getEntry(group.relay);
          }

          // runOneTick publishes across ~79 groups. Each publish routes
          // through the DHT, which on N-DHT can cost ~10 K ops (7+ hops ×
          // 1,200 ops). A single synchronous tick (79 × 10 K = ~800 K ops)
          // can block the main thread for several hundred ms — enough to
          // freeze the heartbeat timer. Yielding every 20 groups keeps
          // the main thread responsive across a tick.
          const runOneTick = async () => {
            for (const e of entries.values()) {
              if (!e.node.alive) continue;
              for (const gid of e.deliveries.keys()) e.deliveries.set(gid, false);
            }
            let i = 0;
            for (const group of groups) {
              if (!group.relay.alive) continue;
              const gKey = 'g' + group.id;
              getEntry(group.relay).adapter.publish(domainFor(group), gKey, {});
              if (++i % 20 === 0) await this._yield();
            }
          };
          const measureDeliveredPct = () => {
            let delivered = 0, expected = 0;
            for (const group of groups) {
              for (const p of group.participants) {
                if (!p.alive) continue;          // exclude dead subs from denominator
                expected++;
                if (entries.get(p.id).deliveries.get(group.id)) delivered++;
              }
            }
            return expected === 0 ? 100 : (delivered / expected) * 100;
          };

          // ── Per-topic K-closest overlap diagnostic ──────────────────────
          // For each topic, compute the set the publisher's findKClosest
          // returns and compare against each subscriber's set. This is the
          // mechanism that determines whether a publish actually reaches
          // subscribers: they only match if both parties' K-closest views
          // overlap. Under churn, divergence between publisher and
          // subscriber views is the proximate cause of delivery misses.
          //
          // Sample up to SAMPLE_PER_GROUP live subscribers per group to
          // keep the cost bounded at scale. Returns mean overlap as %
          // of K and the fraction of samples achieving full convergence
          // (all K match exactly).
          const SAMPLE_PER_GROUP = 5;
          const anyAxon = [...dht._axonsByNode.values()][0];
          // Use `||` (not `??`) so rootSetSize=0 — which signals routed
          // mode with no K-replication — still falls through to K=5 for
          // the diagnostic computation. Overlap / stability stay
          // meaningful metrics in routed mode too: they answer "do
          // publisher and subscriber agree on the top-K candidates by
          // XOR distance to topicId", which predicts delivery regardless
          // of whether the protocol actually stores at all K of them.
          const overlapK = anyAxon?.rootSetSize || 5;
          const measureOverlap = () => {
            let totalOverlap = 0, totalSamples = 0, fullConverge = 0;
            for (const group of groups) {
              if (!group.relay.alive) continue;
              const topicId = topicIdForPrefixed(domainFor(group), 'g' + group.id);
              const pubK = dht.findKClosest(group.relay, topicId, overlapK).map(n => n.id);
              const pubSet = new Set(pubK);
              const liveSubs = group.participants.filter(p => p.alive);
              const sample = liveSubs.slice(0, SAMPLE_PER_GROUP);
              for (const sub of sample) {
                const subK = dht.findKClosest(sub, topicId, overlapK).map(n => n.id);
                const ov = subK.filter(id => pubSet.has(id)).length;
                totalOverlap += ov;
                totalSamples++;
                if (ov === overlapK) fullConverge++;
              }
            }
            if (totalSamples === 0) return { overlapPct: null, convergePct: null, samples: 0 };
            return {
              overlapPct:  (totalOverlap / (totalSamples * overlapK)) * 100,
              convergePct: (fullConverge / totalSamples) * 100,
              samples:     totalSamples,
            };
          };

          // ── K-set stability diagnostic ─────────────────────────────────
          // Complementary to overlap: does each caller's OWN K-set drift
          // between phases? Takes a snapshot of publisher + subscriber
          // K-sets per topic and later compares against current values.
          //
          // This distinguishes "publisher and subscriber diverge" (overlap)
          // from "each side's view churns internally" (stability). The
          // NX-17 25%-churn advantage turned out to come WITH *lower*
          // publisher/subscriber overlap, so the hypothesis is that the
          // advantage comes from publisher-K-stability instead: publisher's
          // LTP-trained routing into its own cell means its findKClosest
          // keeps returning the same, reachable K even after 25% of nodes
          // die — giving subscribers' pre-churn subscriptions (registered
          // at publisher's then-K) a higher chance of still matching.
          const snapshotKSets = () => {
            // groupId → { pub: Set<id>, subs: Map<subNodeId, Set<id>> }
            const snap = new Map();
            for (const group of groups) {
              if (!group.relay.alive) continue;
              const topicId = topicIdForPrefixed(domainFor(group), 'g' + group.id);
              const pub = new Set(dht.findKClosest(group.relay, topicId, overlapK).map(n => n.id));
              const subs = new Map();
              const liveSubs = group.participants.filter(p => p.alive);
              for (const sub of liveSubs.slice(0, SAMPLE_PER_GROUP)) {
                const s = new Set(dht.findKClosest(sub, topicId, overlapK).map(n => n.id));
                subs.set(sub.id, s);
              }
              snap.set(group.id, { pub, subs });
            }
            return snap;
          };

          // Compare current K-sets against a snapshot. "Stability" for each
          // caller = (K-set members from snapshot still in current K-set)
          // divided by K. Dead nodes count as lost (they cannot remain in
          // top-K because findKClosest filters dead), so stability is capped
          // by survival rate.
          const measureStability = (snap) => {
            let pubTotal = 0, pubCount = 0;
            let subTotal = 0, subCount = 0;
            for (const group of groups) {
              if (!group.relay.alive) continue;
              const rec = snap.get(group.id);
              if (!rec) continue;
              const topicId = topicIdForPrefixed(domainFor(group), 'g' + group.id);
              const curPub = new Set(dht.findKClosest(group.relay, topicId, overlapK).map(n => n.id));
              const pubStable = [...rec.pub].filter(id => curPub.has(id)).length;
              pubTotal += pubStable / overlapK;
              pubCount++;
              for (const [subId, subSnap] of rec.subs) {
                const subNode = dht.nodeMap.get(subId);
                if (!subNode?.alive) continue;
                const curSub = new Set(dht.findKClosest(subNode, topicId, overlapK).map(n => n.id));
                const subStable = [...subSnap].filter(id => curSub.has(id)).length;
                subTotal += subStable / overlapK;
                subCount++;
              }
            }
            return {
              pubStabilityPct: pubCount ? (pubTotal / pubCount) * 100 : null,
              subStabilityPct: subCount ? (subTotal / subCount) * 100 : null,
              pubSamples: pubCount,
              subSamples: subCount,
            };
          };

          // ── Per-phase timing instrumentation ─────────────────────────────
          // Pubsubmchurn at 25K is slow; before optimising we need data on
          // which phase dominates. Each phase logs `[pubsubmchurn-time]
          // <protocol> <phase>: <ms>ms`. Grep the console for
          // `pubsubmchurn-time` to see the breakdown.
          const t0 = performance.now();
          let tPrev = t0;
          const phase = (label) => {
            const now = performance.now();
            console.log(`[pubsubmchurn-time] ${tag} ${label}: ${(now - tPrev).toFixed(0)}ms`);
            tPrev = now;
          };

          // Phase 1: warmup (let tree stabilise).
          onStart(`${tag} · Pub/Sub+Churn · warmup…`);
          for (let t = 0; t < 3; t++) { if (!this.running) break; await runOneTick(); }
          phase('warmup-3ticks');

          // Phase 2: baseline measurement.
          onStart(`${tag} · Pub/Sub+Churn · baseline…`);
          const baselineTicks = 5;
          const baseline = [];
          for (let t = 0; t < baselineTicks; t++) {
            if (!this.running) break;
            await runOneTick();
            baseline.push(measureDeliveredPct());
          }
          phase('baseline-5ticks');
          const baselineOverlap = measureOverlap();
          phase('baseline-overlap');
          // Snapshot K-sets RIGHT BEFORE churn so stability is measured
          // relative to the steady-state views, not polluted by phase-4
          // rerouting.
          const kSnapshot = snapshotKSets();
          phase('snapshotKSets');

          // Phase 3: kill churnRate% of nodes. Exclude relays so publishes
          // can keep firing (we're testing subscriber/axon churn, not
          // publisher failure — publisher failure is a separate concern).
          const publisherIds = new Set(groups.map(g => g.relay.id));
          const killable = aliveNodes.filter(n => !publisherIds.has(n.id));
          killable.sort(() => Math.random() - 0.5);
          const killTarget = Math.floor(aliveNodes.length * churnRate / 100);
          const numKilled = Math.min(killTarget, killable.length);
          for (let i = 0; i < numKilled; i++) killable[i].alive = false;
          // Network topology just changed (nodes died). Invalidate every
          // AxonaManager's local findKClosest cache so the post-churn
          // refresh rounds compute against the new state. In a real
          // deployment, churn-detection (e.g., heartbeat timeout) would
          // bump each node's cache epoch independently; we do it
          // simulator-side as a one-shot here for speed.
          if (dht._axonsByNode instanceof Map) {
            for (const axon of dht._axonsByNode.values()) {
              axon.invalidateKClosestCache?.();
            }
          }
          onStart(`${tag} · Pub/Sub+Churn · killed ${numKilled} of ${aliveNodes.length}…`);

          // Phase 4: immediate post-churn measurement (no refresh yet).
          const immediate = [];
          for (let t = 0; t < 5; t++) {
            if (!this.running) break;
            await runOneTick();
            immediate.push(measureDeliveredPct());
          }
          phase('immediate-5ticks');
          const immediateOverlap   = measureOverlap();
          phase('immediate-overlap');
          const immediateStability = measureStability(kSnapshot);
          phase('immediate-stability');

          // Phase 5a: first refresh burst (3 rounds). Measures how fast
          // the tree heals under a light cycle count. Yields every 2000
          // node×round iterations to keep the main thread breathing; at
          // 25 K nodes × 10 rounds = 250 K iterations without yielding
          // this block could freeze the tab for tens of seconds.
          //
          // Optimisation: only iterate nodes that have an AxonaManager
          // instance with non-empty subscriptions OR axon roles. The base
          // benchmark pre-creates AxonaManager on every alive node (line
          // ~1007) but most of those have nothing to refresh — they're
          // not subscribers and not axons for any topic. Skipping them
          // turns a 25K-iteration loop per round into a ~3-4K-iteration
          // loop (subscribers + axon hosts only), an order-of-magnitude
          // speedup on the dominant phase.
          const runRefreshRounds = async (rounds) => {
            // Materialise the set of nodes that actually have something to
            // refresh. Done once before the rounds; refreshTick may add new
            // axon roles when it processes overflow, but a fresh axon-role
            // creation only happens via the publish/subscribe handlers, not
            // refreshTick itself, so this snapshot is stable across rounds.
            const refreshSet = [];
            for (const node of aliveNodes) {
              if (!node.alive) continue;
              const axon = dht._axonsByNode?.get(node);
              if (!axon) continue;
              if (axon.mySubscriptions?.size === 0 && axon.axonRoles?.size === 0) continue;
              refreshSet.push(node);
            }
            let opsSinceYield = 0;
            for (let r = 0; r < rounds; r++) {
              for (const node of refreshSet) {
                if (!node.alive) continue;
                await dht.axonFor(node).refreshTick();
                if (++opsSinceYield >= 2000) {
                  await this._yield();
                  opsSinceYield = 0;
                  if (!this.running) return;
                }
              }
            }
          };
          await runRefreshRounds(3);
          phase('refresh-3rounds');

          // Phase 6a: post-recovery measurement after 3 rounds.
          const recovered = [];
          for (let t = 0; t < 5; t++) {
            if (!this.running) break;
            await runOneTick();
            recovered.push(measureDeliveredPct());
          }
          phase('recovered-5ticks');
          const recoveredOverlap   = measureOverlap();
          phase('recovered-overlap');
          const recoveredStability = measureStability(kSnapshot);
          phase('recovered-stability');

          // Phase 5b: run 7 more refresh rounds (cumulative 10). Lets us
          // see whether 3 rounds had converged or whether additional
          // refresh cycles continue to heal the tree. Reported as
          // `recoveredDeep` alongside the 3-round `recovered` number.
          await runRefreshRounds(7);
          phase('refresh-7rounds');

          // Phase 6b: deep-recovery measurement.
          const recoveredDeep = [];
          for (let t = 0; t < 5; t++) {
            if (!this.running) break;
            await runOneTick();
            recoveredDeep.push(measureDeliveredPct());
          }
          phase('recoveredDeep-5ticks');
          const recoveredDeepOverlap   = measureOverlap();
          phase('recoveredDeep-overlap');
          const recoveredDeepStability = measureStability(kSnapshot);
          phase('recoveredDeep-stability');
          console.log(`[pubsubmchurn-time] ${tag} TOTAL: ${(performance.now() - t0).toFixed(0)}ms`);

          // ── Orphan diagnostic ──────────────────────────────────────────
          // For each group, count live subscribers who are in SOME role's
          // children somewhere in the network vs. those who are not
          // attached anywhere. Differentiates:
          //   - orphaned (re-subscribe failed to re-attach them)
          //   - attached-but-not-receiving (fan-out path broken)
          // from the aggregate `recovered%` number.
          //
          // Only iterates LIVE axon nodes — dead-node AxonaManagers stay in
          // _axonsByNode but their roles can't deliver, so they don't count
          // as "attached" for this measurement.
          const attachedDiag = (() => {
            const attachedByGroup = new Map(); // groupId → Set<subId>
            const roleCountByGroup = new Map();
            const deadChildByGroup = new Map();
            if (dht._axonsByNode instanceof Map) {
              for (const [axonNode, axon] of dht._axonsByNode) {
                if (!axonNode?.alive) continue;   // skip dead axon hosts
                for (const [topicId, role] of axon.axonRoles) {
                  // topicId → group index: we stored these per-group so
                  // invert the mapping via the group's topic we built earlier
                  const group = groups.find(g =>
                    topicIdForPrefixed(domainFor(g), 'g' + g.id) === topicId);
                  if (!group) continue;
                  roleCountByGroup.set(group.id, (roleCountByGroup.get(group.id) ?? 0) + 1);
                  let set = attachedByGroup.get(group.id);
                  if (!set) { set = new Set(); attachedByGroup.set(group.id, set); }
                  let deadCount = deadChildByGroup.get(group.id) ?? 0;
                  for (const childId of role.children.keys()) {
                    set.add(childId);
                    // Check if the child is a live node. `childId` is a hex
                    // string (peerId as emitted by the adapter); resolve.
                    const childNode = dht.nodeMap?.get(
                      typeof childId === 'string' ? BigInt('0x' + childId) : childId
                    );
                    if (!childNode || !childNode.alive) deadCount++;
                  }
                  deadChildByGroup.set(group.id, deadCount);
                }
              }
            }
            let liveSubs = 0, attachedSubs = 0, totalDeadChildren = 0, totalRoles = 0;
            for (const group of groups) {
              const set = attachedByGroup.get(group.id) ?? new Set();
              for (const p of group.participants) {
                if (!p.alive) continue;
                liveSubs++;
                // Subscriber IDs in role.children are hex strings via the
                // adapter; compare as hex.
                const pHex = p.id.toString(16).padStart(16, '0');
                if (set.has(pHex) || set.has(p.id)) attachedSubs++;
              }
              totalRoles += roleCountByGroup.get(group.id) ?? 0;
              totalDeadChildren += deadChildByGroup.get(group.id) ?? 0;
            }
            return {
              liveSubs,
              attachedSubs,
              orphanedSubs: liveSubs - attachedSubs,
              attachedPct: liveSubs ? (attachedSubs / liveSubs) * 100 : 0,
              totalRoles,
              totalDeadChildren,
            };
          })();

          data[def.key]['pubsubmchurn'] = {
            baseline:       computeStats(baseline),
            immediate:      computeStats(immediate),
            recovered:      computeStats(recovered),
            recoveredDeep:  computeStats(recoveredDeep),
            baselineOverlap,
            immediateOverlap,
            recoveredOverlap,
            recoveredDeepOverlap,
            immediateStability,
            recoveredStability,
            recoveredDeepStability,
            killedCount:    numKilled,
            totalNodes:     aliveNodes.length,
            churnRate,
            numGroups,
            groupSize,
            orphanDiag:     attachedDiag,
          };
          onStep(`${tag} · Pub/Sub+Churn ✓ (attached ${attachedDiag.attachedSubs}/${attachedDiag.liveSubs} = ${attachedDiag.attachedPct.toFixed(1)}%, roles ${attachedDiag.totalRoles}, dead-children ${attachedDiag.totalDeadChildren})`);
          continue;
        }

        // ── Slice World (network partition with single bridge node) ─────────
        // Adversarial topology: prune every cross-hemisphere edge except those
        // through the Hawaii-equivalent bridge, then run cross-hemisphere
        // lookups.
        //
        // v0.67.07 — single-phase test with rich diagnostics:
        //   • cross-hem synapse count BEFORE the test (should be 0)
        //   • cross-hem synapse count AFTER the test — non-zero means the
        //     protocol's learning rules re-stitched the partition during
        //     the run. This is the smoking gun for whether 94 % is "raw
        //     bridge-finding" or "learning recovery".
        //   • bridge-on-path % per successful lookup
        //   • cross-hem leak-edges (cross-hem hops not touching the bridge)
        //
        // No per-lookup re-partition: that variant was prohibitively slow at
        // 25 K nodes (each re-prune walks every synaptome). The post-Phase
        // cross-hem count gives us the same answer at a fraction of the cost.
        if (spec.type === 'slice') {
          // v0.67.08 — minimal bisection diagnostic. Each step posts a
          // checkpoint to research.log so we can see exactly where the
          // hang occurs.
          const log = (msg) => {
            const entry = `[SLICE-STEP ${def.key}] ${msg}`;
            if (typeof console !== 'undefined') console.log(entry);
            if (typeof fetch !== 'undefined') {
              try {
                fetch('/api/log', {
                  method:  'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body:    JSON.stringify({ entry }),
                }).catch(() => {});
              } catch {}
            }
          };

          log('A: entered slice block');

          const bridge = findNodeNearest(dht, 19.82, -155.47);
          if (!bridge) {
            data[def.key][specKey(spec)] = { unsupported: true, reason: 'no nodes' };
            onStep(`${tag} · Slice World — n/a`);
            continue;
          }
          log(`B: bridge found, applying partition`);

          applySliceWorldPartition(dht, bridge.id);
          log('C: partition applied');

          // Cross-hem count BEFORE any further work.
          let preCount = 0;
          for (const node of dht.nodeMap.values()) {
            if (!node.alive || node.id === bridge.id) continue;
            const nodeWest = node.lng < 0;
            if (node.synaptome) {
              for (const peerId of node.synaptome.keys()) {
                if (peerId === bridge.id) continue;
                const peer = dht.nodeMap.get(peerId);
                if (peer && (peer.lng < 0) !== nodeWest) preCount++;
              }
            }
            if (node.buckets) {
              for (const bucket of node.buckets) {
                for (const peer of bucket.nodes) {
                  if (peer.id === bridge.id) continue;
                  if ((peer.lng < 0) !== nodeWest) preCount++;
                }
              }
            }
          }
          log(`D: pre-test cross-hem count = ${preCount}`);

          const alive   = dht.getNodes().filter(n => n.alive);
          const western = alive.filter(n => n.lng <  0 && n.id !== bridge.id);
          const eastern = alive.filter(n => n.lng >= 0 && n.id !== bridge.id);
          log(`E: pools built (western=${western.length}, eastern=${eastern.length})`);

          // Hard cap of 10 lookups for diagnostic purposes — we just want to
          // know whether each lookup terminates and how long it takes. Will
          // raise to 500 once we know the per-lookup latency profile.
          const SLICE_LIMIT = 10;
          let ok = 0, fail = 0;
          const hops = [];
          const time = [];
          for (let i = 0; i < SLICE_LIMIT; i++) {
            if (!this.running) break;
            const src = western[Math.floor(Math.random() * western.length)];
            const dst = eastern[Math.floor(Math.random() * eastern.length)];
            const t0 = Date.now();
            try {
              const r = await dht.lookup(src.id, dst.id);
              const dt = Date.now() - t0;
              if (r && r.found) {
                ok++;
                hops.push(r.hops);
                time.push(r.time);
                log(`F${i}: lookup ok (wall=${dt}ms, sim-hops=${r.hops}, sim-ms=${r.time?.toFixed(1) ?? '?'})`);
              } else {
                fail++;
                log(`F${i}: lookup FAILED (wall=${dt}ms, found=${r?.found ?? '?'})`);
              }
            } catch (e) {
              const dt = Date.now() - t0;
              fail++;
              log(`F${i}: lookup THREW (wall=${dt}ms, err=${e?.message ?? String(e)})`);
            }
            // Yield to the event loop after EVERY lookup so the heartbeat
            // polling interval has a chance to fire.
            await this._yield();
          }
          log(`G: lookup loop done (ok=${ok}, fail=${fail})`);

          // Cross-hem count AFTER.
          let postCount = 0;
          for (const node of dht.nodeMap.values()) {
            if (!node.alive || node.id === bridge.id) continue;
            const nodeWest = node.lng < 0;
            if (node.synaptome) {
              for (const peerId of node.synaptome.keys()) {
                if (peerId === bridge.id) continue;
                const peer = dht.nodeMap.get(peerId);
                if (peer && (peer.lng < 0) !== nodeWest) postCount++;
              }
            }
            if (node.buckets) {
              for (const bucket of node.buckets) {
                for (const peer of bucket.nodes) {
                  if (peer.id === bridge.id) continue;
                  if ((peer.lng < 0) !== nodeWest) postCount++;
                }
              }
            }
          }
          log(`H: post-test cross-hem count = ${postCount} ${postCount > preCount ? '(re-stitched!)' : '(no re-stitch)'}`);

          const total = ok + fail;
          data[def.key][specKey(spec)] = {
            hops:        computeStats(hops),
            time:        computeStats(time),
            successRate: total > 0 ? ok / total : 0,
            totalRuns:   total,
          };
          onStep(`${tag} · Slice ✓ (ok=${ok}/${total}, cross-hem ${preCount}→${postCount})`);
          continue;
        }

        const cellLabel = `${tag} · ${specLabel(spec)}`;
        onStart(`${cellLabel}…`);
        logBench('TEST-start',
                 `protocol=${def.label}`, `test=${specKey(spec)}`,
                 `n=${dht.getNodes?.().filter(n => n.alive).length ?? '?'}`);

        const result = await this.runLookupTest(dht, {
          numMessages,
          captureLastPath: false,
          regional:        spec.type === 'regional',
          regionalRadius:  spec.type === 'regional' ? spec.radius : 2000,
          destNodes:       sharedDestNodes,    // pre-built pool (null for non-dest/source specs)
          sourceNodes:     sharedSourceNodes,  // pre-built pool (null for non-source specs)
          destRandom:      spec.type === 'continent' || spec.type === 'slice',
          hotPct:          100,
          managed:         true,  // don't let runLookupTest reset this.running
        });

        data[def.key][specKey(spec)] = {
          hops:        result.hops,
          time:        result.time,
          successRate: result.successRate,
          totalRuns:   result.totalRuns,
        };

        onStep(`${cellLabel} ✓`);
        logBench('TEST-done',
                 `protocol=${def.label}`, `test=${specKey(spec)}`,
                 `hops=${result.hops?.toFixed?.(2) ?? '?'}`,
                 `ms=${result.time?.toFixed?.(1) ?? '?'}`,
                 `success=${((result.successRate ?? 0) * 100).toFixed(1)}%`);
      }

      // Explicitly release all node/synapse memory before building the next
      // protocol's DHT.  Without this, V8 may not GC the old DHT before the
      // new one is fully built, briefly doubling memory usage — fatal at 50k+
      // nodes where a single protocol's synaptome can approach the heap limit.
      logBench('PROTOCOL-dispose-start', `protocol=${def.label}`);
      dht.dispose?.();
      await this._yield(); // give the GC a chance to collect before next build
      logBench('PROTOCOL-dispose-done', `protocol=${def.label}`);
    }

    this.running = false;
    return { protocolDefs, testSpecs, data, deltaBaseline: this._deltaBaseline ?? null };
  }

  // ── Churn Test ───────────────────────────────────────────────────────────

  /**
   * Simulate node churn while continuously running lookups.
   *
   * @param {import('../dht/DHT.js').DHT} dht
   * @param {object} params
   * @param {number} params.churnRate         - Fraction of nodes replaced per interval (0–1)
   * @param {number} params.intervals         - Number of churn intervals to simulate
   * @param {number} params.lookupsPerInterval
   * @param {Function} params.landFn          - (lat,lng)=>bool  land detector
   * @param {number[]} params.landBbox        - [minLat, maxLat, minLng, maxLng]
   * @returns {Promise<ChurnTestResult>}
   */
  async runChurnTest(dht, params = {}) {
    const {
      churnRate = 0.05,
      intervals = 10,
      lookupsPerInterval = 100,
      landFn = null,
    } = params;

    this.running = true;
    const timeSeries = [];

    for (let interval = 0; interval < intervals; interval++) {
      if (!this.running) break;

      // ── Apply churn ────────────────────────────────────────────────────
      const nodes = dht.getNodes().filter(n => n.alive);
      const numToReplace = Math.max(1, Math.floor(nodes.length * churnRate));

      // Remove random nodes
      const toRemove = shuffleSample(nodes, numToReplace);
      for (const node of toRemove) {
        await dht.removeNode(node.id);
      }

      // Add replacement nodes — realistic iterative bootstrap join
      const liveAfterRemoval = dht.getNodes().filter(n => n.alive);
      for (let i = 0; i < numToReplace; i++) {
        const { lat, lng } = randomLandPoint(landFn);
        const newNode = await dht.addNode(lat, lng);
        const sponsor = liveAfterRemoval[
          Math.floor(Math.random() * liveAfterRemoval.length)
        ];
        if (sponsor && typeof dht.bootstrapJoin === 'function') {
          dht.bootstrapJoin(newNode.id, sponsor.id);
        }
      }

      // ── Run lookups ────────────────────────────────────────────────────
      const hopsArr = [];
      const timeArr = [];
      let failures = 0;

      for (let i = 0; i < lookupsPerInterval; i++) {
        const source = this._randomNode(dht);
        if (!source) { failures++; continue; }
        try {
          const receiver = this._randomOtherNode(dht, source.id);
          const result = await dht.lookup(source.id, receiver ? receiver.id : randomU64());
          if (result && result.found) {
            hopsArr.push(result.hops);
            timeArr.push(result.time);
          } else {
            failures++;
          }
        } catch {
          failures++;
        }
      }

      const entry = {
        interval,
        nodeCount: dht.getNodes().filter(n => n.alive).length,
        nodesReplaced: numToReplace,
        hops: computeStats(hopsArr),
        time: computeStats(timeArr),
        successRate: hopsArr.length / lookupsPerInterval,
        failures,
      };
      timeSeries.push(entry);

      await this._yield();
      if (this.onProgress) {
        this.onProgress((interval + 1) / intervals, { timeSeries });
      }
    }

    const result = { type: 'churn', timeSeries };
    if (this.onComplete) this.onComplete(result);
    this.running = false;
    return result;
  }

  // ── Pair Learning Session ────────────────────────────────────────────────

  /**
   * Run one pair-learning session: every source node routes a lookup to its
   * fixed assigned target.  Repeated sessions drive neuromorphic shortcut
   * formation so hop counts trend toward 1.
   *
   * @param {object}   dht
   * @param {Array<{srcId:number, dstId:number}>} pairs  – fixed pairings built at test start
   * @returns {Promise<{hops, time, hopsRaw, timeRaw, successCount}>}
   */
  async runPairSession(dht, pairs) {
    const hopsArr  = [];
    const timeArr  = [];
    const nodeMap  = new Map(dht.getNodes().map(n => [n.id, n]));
    const YIELD_EVERY = 50;

    for (let i = 0; i < pairs.length; i++) {
      const { srcId, dstId } = pairs[i];
      const src = nodeMap.get(srcId);
      if (!src?.alive) continue;                  // skip dead senders

      try {
        const r = await dht.lookup(srcId, dstId);
        if (r?.found) {
          hopsArr.push(r.hops);
          timeArr.push(r.time);
        }
      } catch { /* skip failed lookups */ }

      if ((i + 1) % YIELD_EVERY === 0) await this._yield();
    }

    return {
      hops:         computeStats(hopsArr),
      time:         computeStats(timeArr),
      hopsRaw:      hopsArr,
      timeRaw:      timeArr,
      successCount: hopsArr.length,
    };
  }

  // ── Pub/Sub Tick ─────────────────────────────────────────────────────────

  /**
   * Run one pub/sub message cycle across a set of concordance groups.
   * A random participant from a random group sends to its relay; the relay
   * broadcasts back to all participants in that group.
   *
   * @param {object}   dht    – the active DHT instance
   * @param {object[]} groups – array of { id, relay, participants[] }
   * @returns {Promise<object|null>} tick stats, or null if no alive nodes found
   */
  async runPubSubTick(dht, groups) {
    const YIELD_EVERY = 8;

    // Pick a random group with a live relay
    const liveGroups = groups.filter(g => g.relay.alive);
    if (!liveGroups.length) return null;
    const group = liveGroups[Math.floor(Math.random() * liveGroups.length)];
    const { relay, participants } = group;

    // Pick a random live participant as message sender
    const alive = participants.filter(p => p.alive);
    if (!alive.length) return null;
    const sender = alive[Math.floor(Math.random() * alive.length)];

    // sender → relay
    let msgHops = null;
    let msgMs   = null;
    try {
      const r = await dht.lookup(sender.id, relay.id);
      if (r?.found) {
        msgHops = r.hops;
        msgMs   = Math.round(r.time);   // per-hop geographic RTT, same as all other tests
      }
    } catch { /* skip */ }

    // relay → all participants (broadcast)
    const bcastHops  = [];
    const bcastMsArr = [];
    const targets    = alive.filter(p => p.id !== sender.id).map(p => p.id);

    let maxNodeLookups = targets.length;  // flat default: relay does all lookups
    let treeDepth      = 0;               // flat default: no tree
    let avgSubsPerNode = targets.length;  // flat default: all on relay

    if (typeof dht.pubsubBroadcast === 'function' && targets.length > 0) {
      // Tree-based broadcast: one call handles the full fan-out
      try {
        const result = await dht.pubsubBroadcast(relay.id, targets);
        bcastHops.push(...result.hops);
        bcastMsArr.push(...result.times);
        if (result.maxNodeLookups != null) maxNodeLookups = result.maxNodeLookups;
        if (result.treeDepth != null) treeDepth = result.treeDepth;
        if (result.avgSubsPerNode != null) avgSubsPerNode = result.avgSubsPerNode;
      } catch { /* skip */ }
    } else {
      // Standard flat broadcast: one lookup per participant
      for (let i = 0; i < alive.length; i++) {
        const p = alive[i];
        if (p.id === sender.id) continue; // sender already reached relay
        try {
          const r = await dht.lookup(relay.id, p.id);
          if (r?.found) {
            bcastHops.push(r.hops);
            bcastMsArr.push(Math.round(r.time));  // per-hop geographic RTT
          }
        } catch { /* skip */ }
        if ((i + 1) % YIELD_EVERY === 0) await this._yield();
      }
    }

    const bcastStats  = computeStats(bcastHops);
    const bcastMsStats = computeStats(bcastMsArr);
    const totalHops   = (msgHops ?? 0) + bcastHops.reduce((a, b) => a + b, 0);

    return {
      groupId:        group.id,
      senderId:       sender.id,
      relayId:        relay.id,
      relayNode:      relay,          // full node object (lat/lng) for globe positioning
      participantNodes: alive,        // alive participants for globe highlighting
      msgHops,
      msgMs,
      bcastStats,
      bcastHops,
      bcastMsArr,    // raw per-participant ms values (used by runPubSubSession)
      bcastMsStats,
      totalHops,
      maxNodeLookups,                 // max lookups by any single node in this broadcast
      treeDepth,                       // dendritic tree depth (0 for flat)
      avgSubsPerNode,                  // avg subscribers per branch node
      simMs: (msgMs ?? 0) + Math.round((bcastMsStats?.mean ?? 0)),
    };
  }

  // ── Pub/Sub Session ───────────────────────────────────────────────────────

  /**
   * Run one pub/sub SESSION consisting of `messagesPerSession` independent
   * message/broadcast cycles. Each cycle picks a random sender from a random
   * group, routes sender → relay, then broadcasts relay → all participants.
   *
   * Returns the grand average across all cycles so callers get a stable,
   * low-noise measurement per session:
   *
   *   relayHops  = mean of messagesPerSession relay hop counts
   *   relayMs    = mean of messagesPerSession relay RTTs
   *   bcastHops  = mean over all (messagesPerSession × groupSize) bcast hops
   *   bcastMs    = mean over all (messagesPerSession × groupSize) bcast RTTs
   *
   * @param {object}   dht               – active DHT instance
   * @param {object[]} groups            – array of { id, relay, participants[] }
   * @param {number}   [messagesPerSession=10]
   * @returns {Promise<object|null>}
   */
  async runPubSubSession(dht, groups, messagesPerSession = 10) {
    const allRelayHops = [];
    const allRelayMs   = [];
    const allBcastHops = [];
    const allBcastMs   = [];
    const allMaxFanout = [];
    const allAvgSubs   = [];
    let   maxTreeDepth  = 0;
    let lastRelayNode        = null;
    let lastParticipantNodes = null;

    for (let m = 0; m < messagesPerSession; m++) {
      const tick = await this.runPubSubTick(dht, groups);
      if (!tick) continue;
      if (tick.msgHops != null) allRelayHops.push(tick.msgHops);
      if (tick.msgMs   != null) allRelayMs.push(tick.msgMs);
      allBcastHops.push(...tick.bcastHops);
      allBcastMs.push(...tick.bcastMsArr);
      if (tick.maxNodeLookups != null) allMaxFanout.push(tick.maxNodeLookups);
      if (tick.avgSubsPerNode != null) allAvgSubs.push(tick.avgSubsPerNode);
      if (tick.treeDepth != null) maxTreeDepth = Math.max(maxTreeDepth, tick.treeDepth);
      lastRelayNode        = tick.relayNode;
      lastParticipantNodes = tick.participantNodes;
    }

    if (!allRelayHops.length) return null;

    const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

    return {
      relayHops:         mean(allRelayHops),
      relayMs:           Math.round(mean(allRelayMs)),
      bcastHops:         allBcastHops.length ? mean(allBcastHops) : 0,
      bcastMs:           allBcastMs.length   ? Math.round(mean(allBcastMs)) : 0,
      maxFanout:         allMaxFanout.length ? Math.round(mean(allMaxFanout)) : null,
      avgSubsPerNode:    allAvgSubs.length   ? mean(allAvgSubs) : null,
      treeDepth:         maxTreeDepth,
      lastRelayNode,
      lastParticipantNodes,
      messagesPerSession,
      totalBcasts:       allBcastHops.length,
    };
  }

  // ── Membership Pub/Sub (live continuous simulation) ─────────────────────
  //
  // Supports a Train-Network-style loop: user clicks Pub/Sub, we run
  // iterative tick-by-tick until they stop. Each tick publishes once on
  // every group and measures delivered %, optionally killing some
  // fraction of nodes and running a refresh pass every N ticks.
  //
  // setupMembershipSession()         — one-time setup (groups, axons, subs)
  // runMembershipPubSubTick()        — one measurement tick

  /**
   * Build groups, pre-register AxonaManagers, subscribe every participant.
   * Publisher-prefix ('@XX/bench') topic naming is used when the DHT
   * advertises dht.usesPublisherPrefix === true (NX-17+).
   *
   * Returns { groups, entries, actualCoverage, domainFor } where
   * `entries` is a Map<nodeId, {node, adapter, deliveries}> that the tick
   * loop uses to issue publishes and read delivery bits.
   */
  async setupMembershipSession(dht, {
    pubsubGroupSize = 32,
    pubsubCoverage  = 10,
    local           = false,
    localRadiusKm   = 2000,
  } = {}) {
    if (typeof dht.axonFor !== 'function') {
      throw Error('membership session: protocol does not expose axonFor() (requires NX-15+)');
    }

    const aliveNodes  = dht.getNodes().filter(n => n.alive);
    const targetNodes = Math.ceil(aliveNodes.length * pubsubCoverage / 100);
    const numGroups   = Math.max(1, Math.ceil(targetNodes / pubsubGroupSize));
    const shuffled    = [...aliveNodes].sort(() => Math.random() - 0.5);
    const stride      = Math.max(1, Math.floor(shuffled.length / numGroups));

    const groups = [];
    if (!local) {
      for (let i = 0; i < numGroups; i++) {
        const base = (i * stride) % shuffled.length;
        const relay = shuffled[base];
        const participants = [];
        for (let j = 1; j <= pubsubGroupSize; j++) {
          participants.push(shuffled[(base + j) % shuffled.length]);
        }
        groups.push({ id: i, relay, participants });
      }
    } else {
      // Clustered mode: each relay picks geographically-nearest peers.
      const relays = [];
      for (let i = 0; i < numGroups; i++) relays.push(shuffled[(i * stride) % shuffled.length]);
      const relaySet = new Set(relays.map(r => r.id));
      for (let i = 0; i < relays.length; i++) {
        const relay = relays[i];
        const cand  = [];
        for (const n of aliveNodes) {
          if (n === relay || relaySet.has(n.id)) continue;
          const d = haversine(relay.lat, relay.lng, n.lat, n.lng);
          if (d <= localRadiusKm) cand.push({ node: n, d });
        }
        cand.sort((a, b) => a.d - b.d);
        groups.push({ id: i, relay, participants: cand.slice(0, pubsubGroupSize).map(x => x.node) });
      }
    }

    // Pre-register axons on every live node so the routed subscribe can
    // land anywhere along a path and find a handler.
    for (const node of aliveNodes) dht.axonFor(node);

    // One adapter per distinct participating node.
    const entries = new Map();
    const getEntry = (node) => {
      let e = entries.get(node.id);
      if (e) return e;
      e = { node, adapter: new PubSubAdapter({ transport: dht.axonFor(node) }),
            deliveries: new Map() };
      entries.set(node.id, e);
      return e;
    };

    const usePrefix = dht.usesPublisherPrefix === true;
    const domainFor = (group) => {
      if (!usePrefix) return 'bench';
      const pfxByte = Number((group.relay.id >> 56n) & 0xffn);
      return `@${pfxByte.toString(16).padStart(2, '0')}/bench`;
    };

    for (const group of groups) {
      const gKey   = 'g' + group.id;
      const domain = domainFor(group);
      for (const p of group.participants) {
        const entry = getEntry(p);
        entry.deliveries.set(group.id, false);
        entry.adapter.subscribe(domain, gKey,
          () => { entry.deliveries.set(group.id, true); }, 'immediate');
      }
      getEntry(group.relay);
    }

    // Short warmup: run a couple of refresh ticks so the tree settles.
    for (let r = 0; r < 2; r++) {
      for (const node of aliveNodes) {
        if (!node.alive) continue;
        await dht.axonFor(node).refreshTick();
      }
    }

    const covered = new Set();
    for (const g of groups) {
      covered.add(g.relay.id);
      for (const p of g.participants) covered.add(p.id);
    }
    const actualCoverage = (covered.size / aliveNodes.length) * 100;

    // Per-group running totals for the cumulative-delivery metric. Each
    // successful publish on a group appends the returned publishId;
    // the tick loop tallies, for each alive subscriber, how many of the
    // group's total publishIds the subscriber's received-set contains.
    // Persists across ticks for the life of this session.
    const publishedByGroup = new Map();   // groupId → Array<publishId>
    for (const g of groups) publishedByGroup.set(g.id, []);

    return { groups, entries, domainFor, actualCoverage, numGroups, publishedByGroup };
  }

  /**
   * Run one tick of the membership pub/sub simulation.
   *
   * Flow:
   *   1. Optionally kill churnPct% of alive non-publisher nodes.
   *   2. Optionally run refreshRounds passes of refreshTick across all
   *      live nodes (subscribers + axons + roots all re-subscribe).
   *   3. Reset per-group delivery bits.
   *   4. Publish once on every live relay.
   *   5. Count delivered / expected across all groups. Dead subscribers
   *      are excluded from the denominator (we measure survivor
   *      delivery, not resurrection).
   *   6. Collect tree-shape metrics (axon-role count, max fan-out,
   *      max tree depth) and, optionally, publisher/subscriber K-overlap.
   *
   * Returns a history row suitable for accumulation.
   */
  async runMembershipPubSubTick(dht, groups, entries, opts = {}) {
    const {
      doChurnThisTick    = false,
      churnPct           = 0,        // percent of alive non-publishers to kill
      refreshRounds      = 0,        // refreshTick passes after churn, before measurement
      measureOverlap     = false,    // optionally compute pub/sub K-overlap
      publishedByGroup   = null,     // map groupId → Array<publishId> across the session
    } = opts;

    let killedThisTick = 0;

    // Step 1 — churn.
    if (doChurnThisTick && churnPct > 0) {
      const aliveNodes   = dht.getNodes().filter(n => n.alive);
      const publisherIds = new Set(groups.map(g => g.relay.id));
      const killable     = aliveNodes.filter(n => !publisherIds.has(n.id));
      killable.sort(() => Math.random() - 0.5);
      const killTarget = Math.floor(aliveNodes.length * churnPct / 100);
      const n = Math.min(killTarget, killable.length);
      for (let i = 0; i < n; i++) killable[i].alive = false;
      killedThisTick = n;
    }

    // Step 2 — refreshTick across all live nodes.
    for (let r = 0; r < refreshRounds; r++) {
      for (const e of entries.values()) {
        if (!e.node.alive) continue;
        await dht.axonFor(e.node).refreshTick();
      }
      // Also refresh axons on any live node that's not in entries
      // (intermediate nodes that captured subscribe traffic):
      for (const node of dht.getNodes()) {
        if (!node.alive || entries.has(node.id)) continue;
        await dht.axonFor(node).refreshTick();
      }
    }

    // Step 3 — reset delivery bits.
    for (const e of entries.values()) {
      if (!e.node.alive) continue;
      for (const gid of e.deliveries.keys()) e.deliveries.set(gid, false);
    }

    // Step 4 — publish on every live relay. Record the returned
    // publishId in publishedByGroup so the cumulative metric below
    // can check which subscribers have ever received it (including
    // via future replay).
    for (const group of groups) {
      if (!group.relay.alive) continue;
      const gKey = 'g' + group.id;
      const entry = entries.get(group.relay.id);
      if (!entry) continue;
      const usePrefix = dht.usesPublisherPrefix === true;
      const domain = usePrefix
        ? `@${Number((group.relay.id >> 56n) & 0xffn).toString(16).padStart(2, '0')}/bench`
        : 'bench';
      const publishId = entry.adapter.publish(domain, gKey, {});
      if (publishedByGroup && publishId) {
        let arr = publishedByGroup.get(group.id);
        if (!arr) { arr = []; publishedByGroup.set(group.id, arr); }
        arr.push(publishId);
      }
    }

    // Step 5 — measure delivery.
    let delivered = 0, expected = 0;
    for (const group of groups) {
      for (const p of group.participants) {
        if (!p.alive) continue;                 // exclude dead subs
        expected++;
        if (entries.get(p.id)?.deliveries.get(group.id)) delivered++;
      }
    }
    const deliveredPct = expected === 0 ? 100 : (delivered / expected) * 100;

    // Step 6 — tree-shape metrics.
    const { topicIdForPrefixed: tIdFor } = await import('../pubsub/PubSubAdapter.js');
    let totalRoles = 0, maxFanout = 0, maxDepth = 1;
    const usePrefix = dht.usesPublisherPrefix === true;
    const domainOf = (group) => usePrefix
      ? `@${Number((group.relay.id >> 56n) & 0xffn).toString(16).padStart(2, '0')}/bench`
      : 'bench';
    for (const group of groups) {
      const topicId = tIdFor(domainOf(group), 'g' + group.id);
      for (const axon of dht._axonsByNode.values()) {
        const role = axon.axonRoles.get(topicId);
        if (!role) continue;
        totalRoles++;
        if (role.children.size > maxFanout) maxFanout = role.children.size;
        if (!role.isRoot) maxDepth = Math.max(maxDepth, 2);
      }
    }

    // Optional: pub/sub K-overlap (costs extra findKClosest calls).
    let overlapPct = null;
    let convergePct = null;
    if (measureOverlap && typeof dht.findKClosest === 'function') {
      const anyAxon = [...dht._axonsByNode.values()][0];
      const K = anyAxon?.rootSetSize || 5;
      const SAMPLE_PER_GROUP = 3;
      let total = 0, samples = 0, full = 0;
      for (const group of groups) {
        if (!group.relay.alive) continue;
        const topicId = tIdFor(domainOf(group), 'g' + group.id);
        const pubK = dht.findKClosest(group.relay, topicId, K).map(n => n.id);
        const pubSet = new Set(pubK);
        const liveSubs = group.participants.filter(p => p.alive).slice(0, SAMPLE_PER_GROUP);
        for (const sub of liveSubs) {
          const subK = dht.findKClosest(sub, topicId, K).map(n => n.id);
          const ov = subK.filter(id => pubSet.has(id)).length;
          total += ov;
          samples++;
          if (ov === K) full++;
        }
      }
      if (samples > 0) {
        overlapPct  = (total / (samples * K)) * 100;
        convergePct = (full / samples) * 100;
      }
    }

    // Cumulative delivery metric — for each alive subscriber, count how
    // many of the group's total published publishIds this subscriber's
    // AxonaManager has in its _receivedPublishIds set for the topic.
    // This counts deliveries made via ordinary fan-out AND via replay
    // on re-subscribe. Subs who miss a live tick but pick the message
    // up via the next refresh's replay-batch are scored as "received."
    let cumReceived = 0, cumExpected = 0;
    if (publishedByGroup) {
      const { topicIdForPrefixed: tIdFor2 } = await import('../pubsub/PubSubAdapter.js');
      const usePrefix2 = dht.usesPublisherPrefix === true;
      const domainOf2 = (group) => usePrefix2
        ? `@${Number((group.relay.id >> 56n) & 0xffn).toString(16).padStart(2, '0')}/bench`
        : 'bench';
      for (const group of groups) {
        const pubs = publishedByGroup.get(group.id);
        if (!pubs || pubs.length === 0) continue;
        const topicId = tIdFor2(domainOf2(group), 'g' + group.id);
        for (const p of group.participants) {
          if (!p.alive) continue;
          const axon = dht.axonFor(p);
          const received = axon._receivedPublishIds?.get(topicId);
          for (const pid of pubs) {
            cumExpected++;
            if (received && received.has(pid)) cumReceived++;
          }
        }
      }
    }
    const cumulativePct = cumExpected === 0 ? null : (cumReceived / cumExpected) * 100;

    return {
      delivered,
      expected,
      deliveredPct,
      killedThisTick,
      axonRoles:     totalRoles,
      maxFanout,
      treeDepth:     maxDepth,
      overlapPct,
      convergePct,
      cumReceived,
      cumExpected,
      cumulativePct,
    };
  }

  /**
   * Bootstrap a newly joined node into the DHT's routing tables.
   * For Kademlia: add the new node to every existing node's bucket (if it fits),
   * and populate the new node's own buckets from existing nodes.
   */
  // sorted: pre-sorted (by id) array of live nodes, built once per churn round.
  _bootstrapNode(newNode, sorted, k = 20) {
    if (typeof newNode.addToBucket !== 'function') return;
    if (!sorted?.length) return;

    // Use buildXorRoutingTable (O(k·log N)) — fills only the K-closest peers
    // per XOR bucket, matching real Kademlia self-lookup semantics.
    // Respect the node's global connection cap when selecting initial peers.
    const maxConn = newNode.maxConnections ?? Infinity;
    for (const peer of buildXorRoutingTable(newNode.id, sorted, k, maxConn)) {
      newNode.addToBucket(peer);
      peer.addToBucket(newNode);
    }
  }

  // ── Hotspot Test ─────────────────────────────────────────────────────────

  /**
   * Gini coefficient of an array of non-negative numbers.
   * 0 = perfectly equal, 1 = one entity holds everything.
   */
  _gini(values) {
    const n = values.length;
    if (!n) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    if (!sum) return 0;
    let num = 0;
    for (let i = 0; i < n; i++) num += (2 * (i + 1) - n - 1) * sorted[i];
    return num / (n * sum);
  }

  /**
   * Build Lorenz curve data from a raw frequency array.
   * Returns { xs, ys } – both 0–100 arrays for Chart.js.
   * Nodes ranked from least-loaded to most-loaded on X axis.
   */
  _lorenz(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const total  = sorted.reduce((s, v) => s + v, 0);
    const n      = sorted.length;
    const xs = [0], ys = [0];
    let cum = 0;
    for (let i = 0; i < n; i++) {
      cum += sorted[i];
      xs.push(((i + 1) / n) * 100);
      ys.push(total ? (cum / total) * 100 : ((i + 1) / n) * 100);
    }
    return { xs, ys };
  }

  /**
   * Snapshot per-node traffic counters and reset them. v0.70.00.
   *
   * Reads `msgsSent`, `msgsReceived`, and `msgsByType` from every live
   * node (populated by SimulatedNetwork.send), summarizes the
   * population, and resets the counters to 0 / {} so the next training
   * cycle starts clean. The returned record is a *delta* — what
   * happened in the cycle that just ended.
   *
   * The hypothesis we are testing: bandwidth is currently unmodeled, so
   * a small number of nodes (highway hubs, hot pub/sub roots,
   * over-trained synapse targets) accumulate physically impossible
   * message rates while the median node sees almost nothing. The
   * snapshot exposes this distribution so we can plot it, summarize
   * it, and use it to set load-balancing goals (red-team Tier 1
   * "bandwidth saturation" deploy blocker).
   *
   * @param {object} dht
   * @returns {{
   *   summary: { N, total, mean, p50, p75, p90, p95, p99, max, gini,
   *              hot10x, hot100x, byType },
   *   topN:    Array<{id, lat, lng, isHighway, total, sent, received, byType}>,
   *   distribution: number[]   // raw per-node total array (sorted ascending)
   * }}
   */
  snapshotTrafficLoad(dht, opts = {}) {
    const { topK = 10, reset = true } = opts;
    const nodes = (typeof dht.getNodes === 'function')
      ? dht.getNodes().filter(n => n.alive)
      : [...(dht.nodeMap?.values?.() ?? [])].filter(n => n.alive);

    const records = nodes.map(n => ({
      id:        n.id,
      lat:       n.lat,
      lng:       n.lng,
      isHighway: !!n.isHighway,
      sent:      n.msgsSent     | 0,
      received:  n.msgsReceived | 0,
      total:    (n.msgsSent | 0) + (n.msgsReceived | 0),
      byType:    n.msgsByType ? { ...n.msgsByType } : {},
    }));

    // ── Aggregate stats over the per-node totals ───────────────────────
    const totals = records.map(r => r.total).sort((a, b) => a - b);
    const N      = totals.length;
    const sum    = totals.reduce((s, v) => s + v, 0);
    const mean   = N ? sum / N : 0;
    const pct = (p) => N ? totals[Math.min(N - 1, Math.floor(N * p))] : 0;

    // Type-level totals across all nodes (each message increments two
    // counters — sent + received — so the per-type sum here is double
    // the wire-level message count by design).
    const byType = {};
    for (const r of records) {
      for (const t of Object.keys(r.byType)) {
        byType[t] = (byType[t] | 0) + r.byType[t];
      }
    }

    const summary = {
      N,
      total:   sum,
      mean,
      p50:     pct(0.50),
      p75:     pct(0.75),
      p90:     pct(0.90),
      p95:     pct(0.95),
      p99:     pct(0.99),
      max:     totals[N - 1] || 0,
      gini:    this._gini(totals),
      hot10x:  totals.filter(v => mean && v > 10  * mean).length,
      hot100x: totals.filter(v => mean && v > 100 * mean).length,
      byType,
    };

    // ── Top-K hottest nodes (by total) for diagnostic display ─────────
    const topN = [...records]
      .sort((a, b) => b.total - a.total)
      .slice(0, topK);

    // ── Reset counters so next cycle starts clean ─────────────────────
    if (reset) {
      for (const n of nodes) {
        n.msgsSent = 0;
        n.msgsReceived = 0;
        n.msgsByType = Object.create(null);
      }
    }

    return { summary, topN, distribution: totals };
  }

  /**
   * Run the two-phase Hotspot Test.
   *
   * Phase 1 — Highway: random lookups; track which nodes act as intermediate
   *   relay hops.  Measures routing-load concentration across nodes.
   *
   * Phase 2 — Storage: Zipf-distributed queries to a fixed content-item set;
   *   tracks destination query concentration.  Models popular-content hotspots.
   *
   * @param {object} dht
   * @param {object} params
   * @param {number} params.warmupLookups    – train neuromorphic nets before measuring
   * @param {number} params.numLookups       – highway-phase query count
   * @param {number} params.contentCount     – number of unique content items
   * @param {number} params.zipfExponent     – Zipf skew (0=uniform, 1=classic, 2=extreme)
   * @param {number} params.contentLookups   – storage-phase query count
   * @returns {Promise<{highway, storage}>}
   */
  async runHotspotTest(dht, params = {}) {
    const {
      warmupLookups  = 0,
      numLookups     = 1000,
      contentCount   = 50,
      zipfExponent   = 1.0,
      contentLookups = 1000,
    } = params;

    this.running = true;
    const YIELD_EVERY = 50;
    const totalOps = warmupLookups + numLookups + contentLookups;

    // ── Warmup ─────────────────────────────────────────────────────────────
    for (let i = 0; i < warmupLookups && this.running; i++) {
      const src = this._randomNode(dht);
      const dst = src ? this._randomOtherNode(dht, src.id) : null;
      if (src && dst) {
        try { await dht.lookup(src.id, dst.id); } catch { /* skip */ }
      }
      if ((i + 1) % YIELD_EVERY === 0) {
        this.onProgress?.((i + 1) / totalOps, { phase: 'warmup', done: i + 1, total: warmupLookups });
        await this._yield();
      }
    }

    // ── Phase 1: Highway hotspot ────────────────────────────────────────────
    const transitCounts  = new Map();   // nodeId → transit-hop count
    let   hwSuccesses    = 0;

    for (let i = 0; i < numLookups && this.running; i++) {
      const src = this._randomNode(dht);
      const dst = src ? this._randomOtherNode(dht, src.id) : null;
      if (!src || !dst) continue;

      try {
        const r = await dht.lookup(src.id, dst.id);
        if (r?.found && r.path?.length > 2) {
          hwSuccesses++;
          // intermediate hops only (not source=path[0], not dest=path[last])
          for (let j = 1; j < r.path.length - 1; j++) {
            const id = r.path[j];
            transitCounts.set(id, (transitCounts.get(id) ?? 0) + 1);
          }
        }
      } catch { /* skip */ }

      if ((i + 1) % YIELD_EVERY === 0) {
        this.onProgress?.((warmupLookups + i + 1) / totalOps,
          { phase: 'highway', done: i + 1, total: numLookups });
        await this._yield();
      }
    }

    const allNodes      = dht.getNodes().filter(n => n.alive);
    const transitValues = allNodes.map(n => transitCounts.get(n.id) ?? 0);
    const totalTransits = transitValues.reduce((s, v) => s + v, 0);
    const sortedTrans   = [...transitValues].sort((a, b) => b - a);
    const n1  = Math.max(1, Math.ceil(allNodes.length * 0.01));
    const n10 = Math.max(1, Math.ceil(allNodes.length * 0.10));
    const top1pctLoad  = totalTransits
      ? sortedTrans.slice(0, n1).reduce((s, v) => s + v, 0)  / totalTransits : 0;
    const top10pctLoad = totalTransits
      ? sortedTrans.slice(0, n10).reduce((s, v) => s + v, 0) / totalTransits : 0;

    const highwayResult = {
      gini:          this._gini(transitValues),
      top1pctLoad,
      top10pctLoad,
      maxLoad:       sortedTrans[0] ?? 0,
      totalTransits,
      successRate:   hwSuccesses / Math.max(1, numLookups),
      lorenz:        this._lorenz(transitValues),
      numNodes:      allNodes.length,
    };

    // ── Phase 2: Storage hotspot ────────────────────────────────────────────
    // Select contentCount random nodes as content holders
    const shuffled = [...allNodes].sort(() => Math.random() - 0.5);
    const contentNodes = shuffled.slice(0, Math.min(contentCount, shuffled.length));

    // Precompute Zipf cumulative weights
    const weights = contentNodes.map((_, i) => 1 / Math.pow(i + 1, Math.max(0.01, zipfExponent)));
    const wSum    = weights.reduce((s, w) => s + w, 0);
    const cumW    = [];
    let acc = 0;
    for (const w of weights) { acc += w / wSum; cumW.push(acc); }

    const destCounts   = new Map();
    let   stSuccesses  = 0;

    for (let i = 0; i < contentLookups && this.running; i++) {
      // Zipf-sample a content target
      const r    = Math.random();
      const idx  = cumW.findIndex(c => c >= r);
      const target = contentNodes[idx >= 0 ? idx : contentNodes.length - 1];
      const src    = this._randomOtherNode(dht, target.id);
      if (!src) continue;

      try {
        const res = await dht.lookup(src.id, target.id);
        if (res?.found) {
          stSuccesses++;
          destCounts.set(target.id, (destCounts.get(target.id) ?? 0) + 1);
        }
      } catch { /* skip */ }

      if ((i + 1) % YIELD_EVERY === 0) {
        this.onProgress?.((warmupLookups + numLookups + i + 1) / totalOps,
          { phase: 'storage', done: i + 1, total: contentLookups });
        await this._yield();
      }
    }

    const destValues       = contentNodes.map(n => destCounts.get(n.id) ?? 0);
    const totalDest        = destValues.reduce((s, v) => s + v, 0);
    const sortedDest       = [...destValues].sort((a, b) => b - a);
    const top10pctItems    = Math.max(1, Math.ceil(contentNodes.length * 0.10));
    const top10pctItemLoad = totalDest
      ? sortedDest.slice(0, top10pctItems).reduce((s, v) => s + v, 0) / totalDest : 0;

    const storageResult = {
      gini:              this._gini(destValues),
      top10pctItemLoad,
      maxLoad:           sortedDest[0] ?? 0,
      totalQueries:      contentLookups,
      successRate:       stSuccesses / Math.max(1, contentLookups),
      lorenz:            this._lorenz(destValues),
      numItems:          contentNodes.length,
      zipfExponent,
    };

    this.running = false;
    this.onComplete?.({ type: 'hotspot', highway: highwayResult, storage: storageResult });
    return { highway: highwayResult, storage: storageResult };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────────────────────────────────────────

function shuffleSample(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/**
 * Generate a random land point using the provided land-detection function.
 * Falls back to a random point if landFn is null or returns false after 200 tries.
 */
function randomLandPoint(landFn) {
  if (!landFn) {
    return {
      lat: Math.random() * 160 - 80,
      lng: Math.random() * 360 - 180,
    };
  }
  for (let i = 0; i < 200; i++) {
    const lat = Math.random() * 160 - 80;
    const lng = Math.random() * 360 - 180;
    if (landFn(lat, lng)) return { lat, lng };
  }
  return { lat: 0, lng: 0 };
}
