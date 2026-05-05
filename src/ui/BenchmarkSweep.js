/**
 * BenchmarkSweep – runs a sequence of benchmark runs with varying parameters.
 *
 * Integration contract (main.js must call these at the right moments):
 *   sweep.notifyInitComplete()           — end of onInit(), after setRunning(false)
 *   sweep.notifyBenchmarkComplete()      — end of onBenchmark(), success path only
 *   sweep.notifyBenchmarkStopped()       — end of onBenchmark(), stopped/error path
 *
 * Claude (or UI) starts a sweep via:
 *   window.__sim.sweep.start(runs)
 *
 * Each run is an object with any subset of:
 *   { nodeCount, pubsubCoverage, pubsubGroupSize, warmupSessions,
 *     protocols: ['kademlia','geo','ngdht10w'],
 *     tests:     ['global','r2000','pubsub'] }
 */
export class BenchmarkSweep {
  constructor() {
    this._running  = false;
    this._runs     = [];
    this._idx      = 0;
    this._results  = [];
    this._onInit   = null;   // resolve callback waiting for init
    this._onBench  = null;   // resolve callback waiting for benchmark
    this._statusEl = null;

    // Poll server for experiments queued by Claude via POST /api/experiment
    setInterval(() => this._pollExperiment(), 3000);
  }

  async _pollExperiment() {
    if (this._running) return;
    try {
      // Include the currently-loaded version in every poll so the server
      // (and Claude, via /api/status) can detect a stale-cache tab before
      // queueing a benchmark whose output schema depends on new code.
      const legend = document.getElementById('legend')?.textContent ?? '';
      const v = (legend.match(/Version:\s*([\w.+-]+)/i)?.[1] || '').slice(0, 31);
      const qs = v ? `?v=${encodeURIComponent(v)}` : '';
      const r   = await fetch('/api/experiment' + qs);
      const exp = await r.json();
      if (exp?.runs?.length) {
        console.log(`[Sweep] Picked up experiment from server: "${exp.label}"`);
        this.start(exp.runs);
      }
    } catch { /* server may not be up yet */ }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get running()  { return this._running; }
  get progress() { return { idx: this._idx, total: this._runs.length, results: this._results.length }; }
  get results()  { return this._results; }

  /**
   * Start a sweep.
   * @param {Array<Object>} runs  Array of param-override objects.
   * @returns {boolean} false if a sweep is already running.
   */
  start(runs) {
    if (this._running) {
      console.warn('[Sweep] Already running — call stop() first');
      return false;
    }
    if (!runs?.length) {
      console.warn('[Sweep] No runs provided');
      return false;
    }
    this._running = true;
    this._runs    = runs;
    this._idx     = 0;
    this._results = [];
    this._log(`Starting ${runs.length} run(s)`);
    this._updateSweepStatus();
    this._next();
    return true;
  }

  /** Abort the current sweep after the running step finishes. */
  stop() {
    if (!this._running) return;
    this._log('Sweep aborted by user');
    this._running = false;
    this._onInit  = null;
    this._onBench = null;
    this._updateSweepStatus();
  }

  // ── Called by main.js ────────────────────────────────────────────────────

  notifyInitComplete() {
    const cb = this._onInit;
    this._onInit = null;
    if (cb) cb();
  }

  notifyBenchmarkComplete() {
    const cb = this._onBench;
    this._onBench = null;
    if (cb) cb(true);
  }

  notifyBenchmarkStopped() {
    const cb = this._onBench;
    this._onBench = null;
    if (this._running) {
      this._log(`Benchmark stopped on run ${this._idx + 1} — aborting sweep`);
      this._running = false;
      this._updateSweepStatus();
    }
    if (cb) cb(false);
  }

  /**
   * v0.70.02 — training-mode handshake. main.js's onTrainNetwork calls this
   * after pushResult('training', …) finishes so the sweep can advance.
   */
  notifyTrainingComplete() {
    const cb = this._onTrain;
    this._onTrain = null;
    if (cb) cb(true);
  }

  // ── Internal state machine ────────────────────────────────────────────────

  _next() {
    if (!this._running) return;

    if (this._idx >= this._runs.length) {
      this._running = false;
      this._log(`All ${this._runs.length} run(s) complete — ${this._results.length} result(s) collected`);
      this._updateSweepStatus();
      return;
    }

    const run = this._runs[this._idx];
    this._log(`Run ${this._idx + 1}/${this._runs.length}: ${JSON.stringify(run)}`);
    this._updateSweepStatus();

    // Apply this run's parameters to the DOM
    this._applyParams(run);

    // Register init callback then click Init
    this._onInit = () => {
      if (!this._running) return;

      // Re-apply after init in case anything reset (e.g. pubsubCoverage)
      this._applyParams(run);

      // v0.70.02 — dispatch on run.mode. 'training' drives the Train
      // Network loop (used for traffic-load distribution sweeps); the
      // default ('benchmark') keeps the existing Init→Benchmark flow.
      if (run.mode === 'training') {
        // Honour run.maxSessions via the global flag main.js reads.
        window.__sim ??= {};
        window.__sim._trainingMaxSessions =
          Number.isFinite(run.maxSessions) ? run.maxSessions : 20;
        // v0.70.04 — per-cycle churn injection (0 = off).
        window.__sim._trainingChurnPct =
          Number.isFinite(run.churnPctPerCycle) ? run.churnPctPerCycle : 0;

        this._onTrain = (success) => {
          if (!this._running) return;
          if (!success) return;
          this._results.push({ runIdx: this._idx, params: { ...run } });
          this._idx++;
          // Clear training-mode flags so a subsequent manual training run
          // isn't accidentally bounded or churning.
          if (window.__sim) {
            delete window.__sim._trainingMaxSessions;
            delete window.__sim._trainingChurnPct;
          }
          setTimeout(() => this._next(), 1500);
        };
        document.getElementById('btnTrainNetwork')?.click();
        return;
      }

      // Register benchmark callback then click Benchmark
      this._onBench = (success) => {
        if (!this._running) return;
        if (!success) return;          // sweep already aborted in notifyBenchmarkStopped
        this._results.push({ runIdx: this._idx, params: { ...run } });
        this._idx++;
        // Small gap so the UI settles before next init
        setTimeout(() => this._next(), 1500);
      };

      document.getElementById('btnBenchmark')?.click();
    };

    document.getElementById('btnInit')?.click();
  }

  _applyParams(run) {
    const setNum = (id, val) => {
      if (val === undefined || val === null) return;
      const el = document.getElementById(id);
      if (!el) return;
      el.value = val;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const setChk = (id, val) => {
      if (val === undefined || val === null) return;
      const el = document.getElementById(id);
      if (!el) return;
      el.checked = Boolean(val);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const setMultiSelect = (id, values, storageKey) => {
      if (!values) return;
      const sel = document.getElementById(id);
      if (!sel) return;
      const set = new Set(values);
      [...sel.options].forEach(o => { o.selected = set.has(o.value); });
      // Persist so Controls.js snapshot() reads correctly
      if (storageKey) {
        const payload = { v: 2, sel: [...set], known: [...sel.options].map(o => o.value) };
        localStorage.setItem(storageKey, JSON.stringify(payload));
      }
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // v0.70.02 — single-protocol selector for training-mode runs.
    // Training reads from #dhtProtocol (one protocol per run), unlike
    // benchmark which uses the #benchProtocols multiselect. When run.mode
    // is 'training', expect run.protocol = 'kademlia' | 'geob' | 'ngdhtnx17'
    // | 'ngdhtnh1' etc.
    if (run.protocol) {
      const sel = document.getElementById('dhtProtocol');
      if (sel) {
        sel.value = run.protocol;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    setNum('nodeCount',           run.nodeCount);
    setNum('msgCount',            run.msgCount);   // lookups per training session
    setNum('geoBits',             run.geoBits);
    setNum('pubsubCoverage',      run.pubsubCoverage);
    setNum('pubsubGroupSize',     run.pubsubGroupSize);
    setNum('benchWarmupSessions', run.warmupSessions);
    setNum('churnRate',           run.benchChurnPct);
    setChk('webLimit',            run.webLimit);
    setChk('benchBootstrap',      run.benchBootstrap);
    setNum('highwayPct',          run.highwayPct);
    setNum('maxConnections',      run.maxConnections);
    setMultiSelect('benchProtocols', run.protocols, 'dht-bench-protocols');
    setMultiSelect('benchTests',     run.tests,     'dht-bench-tests');

    // Apply NX-1W rule parameters when present
    if (run.nx1wRules) {
      const r = run.nx1wRules;

      // Bootstrap
      setNum('nx-kBootFactor', r.bootstrap?.kBootFactor);

      // Two-Tier Synaptome
      setChk('nx-twoTier-en',       r.twoTier?.enabled);
      setNum('nx-maxSynaptomeSize',  r.twoTier?.maxSynaptomeSize);
      setNum('nx-highwaySlots',      r.twoTier?.highwaySlots);

      // AP Routing
      setNum('nx-lookaheadAlpha',      r.apRouting?.lookaheadAlpha);
      setNum('nx-weightScale',         r.apRouting?.weightScale);
      setNum('nx-geoRegionBits',       r.apRouting?.geoRegionBits);
      setNum('nx-explorationEpsilon',  r.apRouting?.explorationEpsilon);
      setNum('nx-maxGreedyHops',       r.apRouting?.maxGreedyHops);

      // LTP Reinforcement
      setChk('nx-ltp-en',          r.ltp?.enabled);
      setNum('nx-inertiaDuration', r.ltp?.inertiaDuration);

      // Triadic Closure
      setChk('nx-triadic-en',             r.triadic?.enabled);
      setNum('nx-introductionThreshold',  r.triadic?.introductionThreshold);

      // Hop Caching + Cascade
      setChk('nx-hopCaching-en',   r.hopCaching?.enabled);
      setNum('nx-cascadeWeight',   r.hopCaching?.cascadeWeight);

      // Lateral Spread
      setChk('nx-lateralSpread-en',  r.lateralSpread?.enabled);
      setNum('nx-lateralK',          r.lateralSpread?.lateralK);
      setNum('nx-lateralK2',         r.lateralSpread?.lateralK2);
      setNum('nx-lateralMaxDepth',   r.lateralSpread?.lateralMaxDepth);

      // Stratified Eviction
      setChk('nx-stratified-en',  r.stratified?.enabled);
      setNum('nx-strataGroups',   r.stratified?.strataGroups);
      setNum('nx-stratumFloor',   r.stratified?.stratumFloor);

      // Simulated Annealing
      setChk('nx-annealing-en',   r.annealing?.enabled);
      setNum('nx-tInit',          r.annealing?.tInit);
      setNum('nx-tMin',           r.annealing?.tMin);
      setNum('nx-annealCooling',  r.annealing?.annealCooling);
      setNum('nx-globalBias',     r.annealing?.globalBias);

      // Relay Pinning
      setChk('nx-relayPinning-en',    r.relayPinning?.enabled);
      setNum('nx-relayPinThreshold',  r.relayPinning?.relayPinThreshold);
      setNum('nx-relayPinWindow',     r.relayPinning?.relayPinWindow);
      setNum('nx-relayPinMax',        r.relayPinning?.relayPinMax);
      setNum('nx-relayPinWeight',     r.relayPinning?.relayPinWeight);

      // Markov Pre-learning
      setChk('nx-markov-en',           r.markov?.enabled);
      setNum('nx-markovWindow',        r.markov?.markovWindow);
      setNum('nx-markovHotThreshold',  r.markov?.markovHotThreshold);
      setNum('nx-markovBaseWeight',    r.markov?.markovBaseWeight);
      setNum('nx-markovMaxWeight',     r.markov?.markovMaxWeight);

      // Adaptive Decay
      setChk('nx-adaptiveDecay-en',        r.adaptiveDecay?.enabled);
      setNum('nx-decayInterval',           r.adaptiveDecay?.decayInterval);
      setNum('nx-pruneThreshold',          r.adaptiveDecay?.pruneThreshold);
      setNum('nx-decayGammaMin',           r.adaptiveDecay?.decayGammaMin);
      setNum('nx-decayGammaMax',           r.adaptiveDecay?.decayGammaMax);
      setNum('nx-useSaturation',           r.adaptiveDecay?.useSaturation);
      setNum('nx-decayGammaHighwayActive', r.adaptiveDecay?.decayGammaHighwayActive);
      setNum('nx-decayGammaHighwayIdle',   r.adaptiveDecay?.decayGammaHighwayIdle);
      setNum('nx-highwayRenewalWindow',    r.adaptiveDecay?.highwayRenewalWindow);
      setNum('nx-highwayFloor',            r.adaptiveDecay?.highwayFloor);
      setNum('nx-synaptomeFloor',          r.adaptiveDecay?.synaptomeFloor);

      // Highway Refresh
      setChk('nx-highwayRefresh-en',  r.highwayRefresh?.enabled);
      setNum('nx-hubRefreshInterval', r.highwayRefresh?.hubRefreshInterval);
      setNum('nx-hubScanCap',         r.highwayRefresh?.hubScanCap);
      setNum('nx-hubMinDiversity',    r.highwayRefresh?.hubMinDiversity);
      setNum('nx-hubNoise',           r.highwayRefresh?.hubNoise);

      // Load Balancing (optional)
      setChk('nx-loadBalancing-en', r.loadBalancing?.enabled);
      setNum('nx-loadDecay',        r.loadBalancing?.loadDecay);
      setNum('nx-loadPenalty',      r.loadBalancing?.loadPenalty);
      setNum('nx-loadFloor',        r.loadBalancing?.loadFloor);
      setNum('nx-loadSaturation',   r.loadBalancing?.loadSaturation);
    }

    // ── NH-1 rule overrides (no UI; passed directly to constructor) ──
    // The NH-1 protocol's rule-set is small enough that we don't expose a
    // UI panel for it. Experiments can still drive ablations by passing
    // `nh1Rules` in the run object — this stash is read by main.js
    // createDHT so each run can override defaults like
    // `triadicThreshold: Infinity` to disable a single rule cleanly.
    if (run.nh1Rules !== undefined) {
      window.__sim ??= {};
      window.__sim._nh1RulesOverride = run.nh1Rules;
    } else {
      // Clear any prior override so subsequent runs use defaults
      if (window.__sim) delete window.__sim._nh1RulesOverride;
    }

    // v0.70.04 — NX rules override path with deep-merge onto a snapshot
    // of the DOM-derived rules. The previous v0.70.03 implementation
    // wrote the partial override directly into _nx1wRulesEffective,
    // which silently dropped every `enabled: true` flag and disabled
    // rules the run didn't intend to touch (anneal, hop caching, lateral
    // spread, triadic, LTP all came up off — invalidated NX-17 ablation
    // runs). Now we snapshot the full structured rules from Controls
    // and merge the override on top, preserving every default flag.
    if (run.nx1wRulesOverride !== undefined) {
      window.__sim ??= {};
      const base = window.__sim?.controls?.getNX1WRules?.() ?? {};
      window.__sim._nx1wRulesEffective = this._deepMerge(base, run.nx1wRulesOverride);
    } else if (window.__sim) {
      delete window.__sim._nx1wRulesEffective;
    }

    // Directional sub-caps (v0.67.02). Same override pattern — main.js
    // reads window.__sim._max{Outgoing,Incoming}Override before falling
    // back to params from Controls. Default Infinity means "no directional
    // gate", preserving backward-compat with single-cap experiments.
    if (run.maxOutgoing !== undefined) {
      window.__sim ??= {};
      window.__sim._maxOutgoingOverride = run.maxOutgoing;
    } else if (window.__sim) {
      delete window.__sim._maxOutgoingOverride;
    }
    if (run.maxIncoming !== undefined) {
      window.__sim ??= {};
      window.__sim._maxIncomingOverride = run.maxIncoming;
    } else if (window.__sim) {
      delete window.__sim._maxIncomingOverride;
    }

    // initMode override (v0.68.00). 'canonical' forces every protocol's
    // buildRoutingTables down a single shared XOR-fill path, eliminating
    // bootstrap-strategy variance from cross-protocol comparisons.
    if (run.initMode !== undefined) {
      window.__sim ??= {};
      window.__sim._initModeOverride = run.initMode;
    } else if (window.__sim) {
      delete window.__sim._initModeOverride;
    }
  }

  _updateSweepStatus() {
    const el     = document.getElementById('sweepStatus');
    const stopBtn = document.getElementById('btnSweepStop');
    if (!el) return;

    if (!this._running && this._idx === 0 && this._results.length === 0) {
      el.textContent = '';
      el.style.display = 'none';
      if (stopBtn) stopBtn.style.display = 'none';
      return;
    }

    el.style.display = '';
    if (this._running) {
      el.textContent = `Sweep: run ${this._idx + 1}/${this._runs.length}`;
      el.className = 'sweep-status sweep-running';
      if (stopBtn) stopBtn.style.display = '';
    } else if (this._results.length === this._runs.length) {
      el.textContent = `Sweep complete — ${this._results.length} run(s) done ✓`;
      el.className = 'sweep-status sweep-done';
      if (stopBtn) stopBtn.style.display = 'none';
    } else {
      el.textContent = `Sweep stopped (${this._results.length}/${this._runs.length} done)`;
      el.className = 'sweep-status sweep-stopped';
      if (stopBtn) stopBtn.style.display = 'none';
    }
  }

  _log(msg) {
    console.log(`[Sweep] ${msg}`);
  }

  /**
   * Deep-merge `override` onto `base` and return a fresh object. Plain
   * objects (own enumerable keys) recurse; every other value type
   * (numbers, strings, booleans, arrays, null) replaces wholesale.
   *
   * Used to layer per-run nx1wRulesOverride onto the DOM-derived
   * Controls.getNX1WRules() snapshot so partial overrides (e.g.
   * `{ annealing: { annealRateScale: 0.1 } }`) don't drop unrelated
   * `enabled: true` flags from sibling sections.
   */
  _deepMerge(base, override) {
    const isPlain = (v) =>
      v != null && typeof v === 'object' && !Array.isArray(v);
    if (!isPlain(base))     return isPlain(override) ? this._deepMerge({}, override) : override;
    if (!isPlain(override)) return base;
    const out = { ...base };
    for (const k of Object.keys(override)) {
      out[k] = isPlain(override[k]) && isPlain(base[k])
        ? this._deepMerge(base[k], override[k])
        : override[k];
    }
    return out;
  }
}
