/**
 * Results – renders test outcomes into the results panel.
 * Uses Chart.js (loaded globally as `Chart`) for histograms and time-series.
 */
export class Results {
  constructor(panelId = 'resultsOverlay') {
    this.panel = document.getElementById(panelId);
    this._charts = {};
    this._trainingHistory    = null;
    this._pubsubHistory = null;
    this._pairHistory        = null;
    this._benchmarkRows      = null;  // set by showBenchmarkResults
    this._lastLookupResult   = null;
    this._lastChurnResult    = null;
    this._hotspotData        = null;
    this._lastRunParams      = null;  // set before every test via setRunParams()
    this._lastRunTs          = null;  // ISO timestamp of most recent test
  }

  /**
   * Call this immediately before starting any test so the params are
   * captured and included in every CSV export for that test.
   */
  setRunParams(params) {
    this._lastRunParams = params ?? null;
    this._lastRunTs     = new Date().toISOString();
  }

  /**
   * Returns a standardised "Run Parameters" CSV block that is appended to
   * every exported file.  `extraRows` is an optional array of [key, value]
   * pairs for test-specific fields that aren't in params.
   */
  _paramsSection(params, extraRows = []) {
    const p = params ?? this._lastRunParams;
    const ts = this._lastRunTs ?? new Date().toISOString();
    const rows = [];
    rows.push('');
    rows.push('# Run Parameters');
    rows.push('Parameter,Value');
    rows.push(`Timestamp,${ts}`);
    rows.push(`Bidirectional,${p?.bidirectional ? 'yes' : 'no'}`);
    if (p) {
      rows.push(`Nodes,${p.nodeCount ?? ''}`);
      rows.push(`Protocol,${p.protocol ?? ''}`);
      rows.push(`K (bucket size),${p.k ?? ''}`);
      rows.push(`Alpha (parallel queries),${p.alpha ?? ''}`);
      rows.push(`ID bits,${p.bits ?? ''}`);
      rows.push(`Node delay (ms),${p.nodeDelay ?? ''}`);
      if (p.webLimit != null) rows.push(`Web limit,${p.webLimit ? 'yes' : 'no'}`);
      if (p.maxConnections != null && p.webLimit) rows.push(`Max connections,${p.maxConnections}`);
      if (p.highwayPct  != null) rows.push(`Highway %,${p.highwayPct}`);
      if (p.geoBits  != null) rows.push(`G-DHT Bits,${p.geoBits}`);
      // Directional sub-caps (v0.67.02). Only emitted when set via sweep
      // override or future UI control.
      const _maxOutOv = (typeof window !== 'undefined') ? window.__sim?._maxOutgoingOverride : null;
      const _maxInOv  = (typeof window !== 'undefined') ? window.__sim?._maxIncomingOverride  : null;
      if (_maxOutOv != null) rows.push(`Max outgoing,${_maxOutOv}`);
      if (_maxInOv  != null) rows.push(`Max incoming,${_maxInOv}`);
      // Init mode (v0.68.00). 'canonical' forces shared XOR-fill bootstrap
      // for cross-protocol comparison; 'native' lets each protocol use its
      // own bootstrap strategy (G-DHT 50/50, NX-11 80/20, etc.).
      const _initOv = (typeof window !== 'undefined') ? window.__sim?._initModeOverride : null;
      if (_initOv != null) rows.push(`Init mode,${_initOv}`);
    }
    for (const [k, v] of extraRows) rows.push(`${k},${v}`);
    return rows.join('\r\n');
  }

  // ── CSV download helpers ──────────────────────────────────────────────────

  /**
   * Trigger a browser download of `csvString` as `filename`.
   */
  _downloadCSV(csvString, filename) {
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.style.display = 'none';
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  /**
   * Insert (or replace) a title bar as the FIRST CHILD of the panel div
   * identified by `panelId`.  Title is left-justified; ⬇ CSV button is right.
   * `csvFn` is called at click-time so it always captures current data.
   */
  _attachPanelHeader(panelId, title, csvFn, filename) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    // Remove any previous panel header
    const existing = panel.querySelector(':scope > .panel-title-bar');
    if (existing) existing.remove();
    const bar = document.createElement('div');
    bar.className = 'panel-title-bar';
    const lbl = document.createElement('span');
    lbl.className   = 'panel-title';
    lbl.textContent = title;
    const btn = document.createElement('button');
    btn.className   = 'chart-dl-btn';
    btn.textContent = '⬇ CSV';
    btn.title       = 'Download data as CSV';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const csv = csvFn();
      if (csv) this._downloadCSV(csv, filename);
    });
    bar.appendChild(lbl);
    bar.appendChild(btn);
    panel.insertBefore(bar, panel.firstChild);
  }

  /**
   * Insert (or replace) a small header row immediately BEFORE the chart-box
   * element identified by `beforeId`.  Used for sub-charts inside a panel.
   */
  _attachChartHeader(beforeId, title, csvFn, filename) {
    const target = document.getElementById(beforeId);
    if (!target) return;
    const prev = target.previousElementSibling;
    if (prev?.classList.contains('chart-header')) prev.remove();
    const hdr = document.createElement('div');
    hdr.className = 'chart-header';
    const lbl = document.createElement('span');
    lbl.className   = 'chart-header-title';
    lbl.textContent = title;
    const btn = document.createElement('button');
    btn.className   = 'chart-dl-btn';
    btn.textContent = '⬇ CSV';
    btn.title       = 'Download chart data as CSV';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const csv = csvFn();
      if (csv) this._downloadCSV(csv, filename);
    });
    hdr.appendChild(lbl);
    hdr.appendChild(btn);
    target.parentNode.insertBefore(hdr, target);
  }

  _el(id) { return document.getElementById(id); }

  // ── Lookup Test Results ──────────────────────────────────────────────────

  showLookupResults(result) {
    this._lastLookupResult = result;
    this._attachPanelHeader('lookupResults', 'Lookup Test', () => this._lookupHopsCSV(), `dht-lookup-${Date.now()}.csv`);
    const { hops, time, totalRuns, successes, failures, successRate } = result;

    this._setText('resNodeCount',    this._el('nodeCountVal')?.value ?? '—');
    this._setText('resProtocol',     document.getElementById('dhtProtocol')?.selectedOptions[0]?.text ?? '—');
    this._setText('resTotalRuns',    totalRuns.toLocaleString());
    this._setText('resSuccessRate',  `${(successRate * 100).toFixed(1)}%`);
    this._setText('resFailures',     failures.toLocaleString());
    const regionalOn     = document.getElementById('regionalMode')?.checked ?? false;
    const regionalRadius = parseInt(document.getElementById('regionalRadius')?.value ?? 2000);
    const destOn         = document.getElementById('destMode')?.checked ?? false;
    const destPct        = parseInt(document.getElementById('destPct')?.value ?? 10);
    const modeLabel      = destOn    ? `Dest ${destPct}%`
                         : regionalOn ? `Regional ≤${regionalRadius} km`
                         : 'Global';
    this._setText('resMode', modeLabel);
    const modeEl = this._el('resMode');
    if (modeEl) modeEl.style.color = destOn ? '#44ddff' : regionalOn ? '#ffff44' : '';

    if (hops) {
      this._setText('resAvgHops',  hops.mean.toFixed(2));
      this._setText('resP50Hops',  hops.median.toFixed(1));
      this._setText('resP95Hops',  hops.p95.toFixed(1));
      this._setText('resMaxHops',  hops.max);
    }
    if (time) {
      this._setText('resAvgTime',  `${time.mean.toFixed(1)} ms`);
      this._setText('resP50Time',  `${time.median.toFixed(1)} ms`);
      this._setText('resP95Time',  `${time.p95.toFixed(1)} ms`);
      this._setText('resMaxTime',  `${time.max.toFixed(1)} ms`);
    }

    this._showSection('lookupResults');
    this._hideSection('churnResults');
    this._hideSection('demoResults');
    this._hideSection('benchmarkResults');
    this._hideSection('trainingResults');
    this._hideSection('pubsubResults');
    this._hideSection('pairResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.remove('bench-wide');
    this.panel?.classList.remove('train-wide');

    if (result.hopsRaw && result.timeRaw) {
      requestAnimationFrame(() => {
        this._drawHistogram('hopsHistChart', result.hopsRaw, 'Hop Distribution', '#00ff88');
        this._drawHistogram('timeHistChart', result.timeRaw, 'Time Distribution (ms)', '#ffaa00');
        this._attachChartHeader('hopsChartBox', 'Hop Distribution', () => this._lookupHopsCSV(), `dht-hops-${Date.now()}.csv`);
        this._attachChartHeader('timeChartBox', 'Latency Distribution', () => this._lookupTimeCSV(), `dht-time-${Date.now()}.csv`);
      });
    }
  }

  // ── Demo Lookup Results ──────────────────────────────────────────────────

  showDemoResults(result) {
    this._setText('demoProtocol',  document.getElementById('dhtProtocol')?.selectedOptions[0]?.text ?? '—');
    this._setText('demoNodeCount', document.getElementById('nodeCountVal')?.value ?? '—');
    this._setText('demoHops',      result.hops ?? '—');
    this._setText('demoTime',      result.time != null ? `${result.time.toFixed(1)} ms` : '—');
    this._setText('demoPathLen',   result.path?.length ?? '—');
    this._setText('demoSuccess',   result.found ? 'Found ✓' : 'Failed ✗');

    const successEl = this._el('demoSuccess');
    if (successEl) successEl.style.color = result.found ? '#00ff88' : '#ff4444';

    const regionalOn     = document.getElementById('regionalMode')?.checked ?? false;
    const regionalRadius = parseInt(document.getElementById('regionalRadius')?.value ?? 2000);
    this._setText('demoMode', regionalOn ? `Regional ≤${regionalRadius} km` : 'Global');
    const modeEl = this._el('demoMode');
    if (modeEl) modeEl.style.color = regionalOn ? '#ffff44' : '';

    this._showSection('demoResults');
    this._hideSection('lookupResults');
    this._hideSection('churnResults');
    this._hideSection('benchmarkResults');
    this._hideSection('trainingResults');
    this._hideSection('pubsubResults');
    this._hideSection('pairResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.remove('bench-wide');
    this.panel?.classList.remove('train-wide');
  }

  // ── Training Results ─────────────────────────────────────────────────────

  /**
   * Called once to show the training panel (first session completed).
   * Subsequent sessions call updateTrainingProgress.
   */
  showTrainingResults(history) {
    this._showSection('trainingResults');
    this._hideSection('lookupResults');
    this._hideSection('churnResults');
    this._hideSection('demoResults');
    this._hideSection('benchmarkResults');
    this._hideSection('pubsubResults');
    this._hideSection('pairResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.remove('bench-wide');
    this.panel?.classList.remove('train-wide');
    this.panel?.classList.add('train-wide');
    this._attachPanelHeader('trainingResults', 'Train Network', () => this._trainingCSV(), `dht-training-${Date.now()}.csv`);
    this._updateTrainingStats(history);
    requestAnimationFrame(() => {
      this._drawTrainingChart(history);
      this._drawTrainingTrafficChart(history);
    });
  }

  updateTrainingProgress(history) {
    if (!history.length) return;
    this._updateTrainingStats(history);
    // Call synchronously: chart already exists and canvas has dimensions,
    // so no rAF needed — and rAF batching prevents incremental updates.
    this._drawTrainingChart(history);
    this._drawTrainingTrafficChart(history);
  }

  _updateTrainingStats(history) {
    if (!history.length) return;
    const s = history[history.length - 1];
    this._setText('trainSession',  s.session);
    this._setText('trainEpoch',    s.epoch.toLocaleString());
    this._setText('trainAvgSyn',   s.avgSynapses != null ? s.avgSynapses.toFixed(1) : '—');
    this._setText('trainSuccess',  `${(s.successRate * 100).toFixed(1)}%`);
    this._setText('trainAvgHops',  s.hops?.mean != null ? s.hops.mean.toFixed(2) : '—');
    this._setText('trainAvgTime',  s.time?.mean != null ? `${s.time.mean.toFixed(1)} ms` : '—');

    // v0.70.00 — per-cycle traffic-load tiles
    const t = s.traffic?.summary;
    this._setText('trainMsgsTotal',  t ? t.total.toLocaleString() : '—');
    this._setText('trainMsgsP50',    t ? t.p50.toLocaleString()   : '—');
    this._setText('trainMsgsP99',    t ? t.p99.toLocaleString()   : '—');
    this._setText('trainMsgsMax',    t ? t.max.toLocaleString()   : '—');
    this._setText('trainMsgsGini',   t ? t.gini.toFixed(3)        : '—');
    this._setText('trainMsgsHot10x', t ? t.hot10x.toLocaleString(): '—');

    // Build the row HTML (shared between baseline pin and rolling log)
    const sessionLabel = s.isBaseline ? '◆ base' : `#${s.session}`;
    // v0.70.00 — compact traffic-distribution summary appended to each
    // session row: total messages observed in this cycle, p99 / max
    // per-node, and Gini coefficient. Lets the operator watch the
    // distribution evolve session-by-session in the rolling log
    // without having to open the CSV. (Reuses `t` declared above.)
    const trafficSummary = t
      ? ` · msgs ${t.total.toLocaleString()} (p99 ${t.p99} · max ${t.max} · gini ${t.gini.toFixed(2)})`
      : '';
    const rowHTML =
      `<span class="tl-session">${sessionLabel}</span>` +
      `<span class="tl-hops">hops ${s.hops?.mean != null ? s.hops.mean.toFixed(2) : '—'}</span>` +
      `<span class="tl-time">${s.time?.mean != null ? s.time.mean.toFixed(1) + ' ms' : '—'}</span>` +
      `<span class="tl-success">${(s.successRate * 100).toFixed(1)}%</span>` +
      `<span class="tl-meta">syn ${s.avgSynapses != null ? s.avgSynapses.toFixed(1) : '—'}` +
      (s.isBaseline ? ' · pre-training' : ` · epoch ${s.epoch}`) +
      trafficSummary + '</span>';

    if (s.isBaseline) {
      // Sticky pinned baseline — always visible above the session log
      const pin = this._el('trainingBaseline');
      if (pin) {
        const row = document.createElement('div');
        row.className = 'training-log-row';
        row.innerHTML = rowHTML;
        pin.innerHTML = '';
        pin.appendChild(row);
      }
    } else {
      // Rolling session log
      const log = this._el('trainingLog');
      if (log) {
        const row = document.createElement('div');
        row.className = 'training-log-row';
        row.innerHTML = rowHTML;
        log.appendChild(row);
        log.scrollTop = log.scrollHeight;
      }
    }
  }

  _drawTrainingChart(history) {
    this._trainingHistory = history;
    const canvas = this._el('trainingLineChart');
    if (!canvas || typeof Chart === 'undefined' || history.length < 1) return;

    const labels = history.map(s => s.isBaseline ? '◆ base' : `#${s.session}`);
    const small  = { size: 10, family: "'JetBrains Mono','Fira Mono','Consolas',monospace" };

    // Per-point styling: baseline gets a larger diamond, training gets a circle
    const hopPointStyles  = history.map(s => s.isBaseline ? 'rectRot' : 'circle');
    const hopPointRadii   = history.map(s => s.isBaseline ? 5 : 1);
    const timePointStyles = history.map(s => s.isBaseline ? 'rectRot' : 'circle');
    const timePointRadii  = history.map(s => s.isBaseline ? 5 : 1);

    if (this._charts['trainingLineChart']) {
      // Incremental update — push new point without destroying
      const chart = this._charts['trainingLineChart'];
      chart.data.labels = labels;
      chart.data.datasets[0].data        = history.map(s => s.hops?.mean ?? null);
      chart.data.datasets[0].pointStyle  = hopPointStyles;
      chart.data.datasets[0].pointRadius = hopPointRadii;
      chart.data.datasets[1].data        = history.map(s => s.time?.mean ?? null);
      chart.data.datasets[1].pointStyle  = timePointStyles;
      chart.data.datasets[1].pointRadius = timePointRadii;
      chart.update('none');
      return;
    }

    // Vertical annotation at x=0 (baseline) via a custom plugin
    const baselineLinePlugin = {
      id: 'baselineLine',
      afterDraw(chart) {
        if (chart.data.labels.length < 1) return;
        const ctx    = chart.ctx;
        const xScale = chart.scales.x;
        const yScale = chart.scales.yHops;
        const x      = xScale.getPixelForTick(0);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, yScale.top);
        ctx.lineTo(x, yScale.bottom);
        ctx.strokeStyle = 'rgba(100,130,200,0.35)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.restore();
      },
    };

    this._charts['trainingLineChart'] = new Chart(canvas, {
      type: 'line',
      plugins: [baselineLinePlugin],
      data: {
        labels,
        datasets: [
          {
            label: 'Avg Hops',
            data: history.map(s => s.hops?.mean ?? null),
            borderColor: '#00ff88',
            backgroundColor: '#00ff8818',
            yAxisID: 'yHops',
            tension: 0.3,
            pointStyle:  hopPointStyles,
            pointRadius: hopPointRadii,
            pointBackgroundColor: history.map(s => s.isBaseline ? '#00ff88' : '#00ff8888'),
            borderWidth: 2,
          },
          {
            label: 'Avg Time (ms)',
            data: history.map(s => s.time?.mean ?? null),
            borderColor: '#ffaa00',
            backgroundColor: '#ffaa0018',
            yAxisID: 'yTime',
            tension: 0.3,
            pointStyle:  timePointStyles,
            pointRadius: timePointRadii,
            pointBackgroundColor: history.map(s => s.isBaseline ? '#ffaa00' : '#ffaa0088'),
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#bbccee', font: small, boxWidth: 12, padding: 8 },
          },
          tooltip: {
            callbacks: {
              title: (items) => {
                const s = history[items[0]?.dataIndex];
                return s?.isBaseline ? '◆ Baseline (pre-training)' : `Session #${s?.session}`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: '#99aacc', font: small, maxTicksLimit: 14 },
            grid:  { color: '#1a2a44' },
          },
          yHops: {
            type: 'linear', position: 'left',
            ticks: { color: '#00ff88', font: small },
            grid:  { color: '#1a2a4466' },
            title: { display: true, text: 'Hops', color: '#00ff88', font: small },
          },
          yTime: {
            type: 'linear', position: 'right',
            ticks: { color: '#ffaa00', font: small },
            grid:  { drawOnChartArea: false },
            title: { display: true, text: 'ms', color: '#ffaa00', font: small },
          },
        },
      },
    });
  }

  /**
   * v0.70.00 — Traffic-distribution time-series chart.
   *
   * One line per percentile across training sessions: median (p50) shows
   * what a typical node sees per cycle; p99 and max show the tail.
   * Together they tell us whether the load distribution is staying flat
   * (decentralized) or growing more skewed (clustering on a small number
   * of overloaded nodes).
   *
   * Y-axis is logarithmic: in healthy decentralized regimes p50 and max
   * differ by a small constant factor, but in success-disaster regimes
   * max grows orders of magnitude beyond p50 — log-scale keeps both
   * legible without one curve hiding the other.
   */
  _drawTrainingTrafficChart(history) {
    const canvas = this._el('trainingTrafficChart');
    if (!canvas || typeof Chart === 'undefined' || history.length < 1) return;

    const labels = history.map(s => s.isBaseline ? '◆ base' : `#${s.session}`);
    const small  = { size: 10, family: "'JetBrains Mono','Fira Mono','Consolas',monospace" };

    // Use 1 instead of 0 / null so log scale doesn't break on cycles
    // that somehow recorded zero (won't happen normally — but safer).
    const series = (selector) => history.map(s => {
      const v = selector(s.traffic?.summary);
      return v == null || v === 0 ? null : v;
    });

    const dataMax  = series(t => t?.max);
    const dataP99  = series(t => t?.p99);
    const dataP90  = series(t => t?.p90);
    const dataP50  = series(t => t?.p50);
    const dataMean = series(t => t?.mean);

    if (this._charts['trainingTrafficChart']) {
      const ch = this._charts['trainingTrafficChart'];
      ch.data.labels = labels;
      ch.data.datasets[0].data = dataMax;
      ch.data.datasets[1].data = dataP99;
      ch.data.datasets[2].data = dataP90;
      ch.data.datasets[3].data = dataP50;
      ch.data.datasets[4].data = dataMean;
      ch.update('none');
      return;
    }

    const ctx = canvas.getContext('2d');
    this._charts['trainingTrafficChart'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Max',  data: dataMax,  borderColor: '#d33b3b', backgroundColor: '#d33b3b', tension: 0.15, pointRadius: 1, borderWidth: 1.5 },
          { label: 'p99',  data: dataP99,  borderColor: '#e07b00', backgroundColor: '#e07b00', tension: 0.15, pointRadius: 1, borderWidth: 1.3 },
          { label: 'p90',  data: dataP90,  borderColor: '#c4a500', backgroundColor: '#c4a500', tension: 0.15, pointRadius: 1, borderWidth: 1.3 },
          { label: 'p50',  data: dataP50,  borderColor: '#2d7373', backgroundColor: '#2d7373', tension: 0.15, pointRadius: 1, borderWidth: 1.3 },
          { label: 'Mean', data: dataMean, borderColor: '#888',    backgroundColor: '#888',    tension: 0.15, pointRadius: 1, borderWidth: 1.0, borderDash: [4, 3] },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { font: small, boxWidth: 12, boxHeight: 8 } },
          title:  { display: true, text: 'Per-cycle traffic distribution (msgs / node, log scale)', color: '#666', font: small },
          tooltip: { titleFont: small, bodyFont: small },
        },
        scales: {
          x: { ticks: { color: '#666', font: small, maxRotation: 0 }, grid: { color: 'rgba(0,0,0,0.05)' } },
          y: {
            type: 'logarithmic',
            ticks: { color: '#666', font: small, callback: (v) => Number(v).toLocaleString() },
            grid:  { color: 'rgba(0,0,0,0.05)' },
            title: { display: true, text: 'msgs / node (log)', color: '#666', font: small },
          },
        },
      },
    });
  }

  _trainingCSV() {
    if (!this._trainingHistory?.length) return '';
    // v0.70.00 — traffic-distribution columns appended after the
    // existing training-progress columns. Per cycle: total messages
    // observed (sender + receiver counters), median / 90th / 99th
    // percentile / max / Gini coefficient over the per-node totals,
    // plus counts of nodes that exceeded 10× and 100× the cycle mean.
    // These are the raw inputs for the "is the load distribution
    // clustering or decentralizing?" question.
    //
    // v0.70.02 — per-type breakdown columns. We compute the union of
    // every byType key seen across the training history, ordered by
    // total volume descending so the dominant message types appear
    // first. One column per type, prefixed `Type:` to keep the
    // existing summary columns unambiguous. This lets us decompose the
    // "where is the bandwidth going?" question — e.g. is `lookahead_probe`
    // the dominant tax, or is it pub/sub forwarding?
    const typeTotals = new Map();   // type → total across all sessions
    for (const s of this._trainingHistory) {
      const bt = s.traffic?.summary?.byType;
      if (!bt) continue;
      for (const t of Object.keys(bt)) {
        typeTotals.set(t, (typeTotals.get(t) ?? 0) + bt[t]);
      }
    }
    const typeCols = [...typeTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t);
    const typeHeaders = typeCols.map(t => `Type:${t}`);

    const rows = [
      ['Session', 'Avg Hops', 'Avg Time (ms)',
       'Success Rate', 'Avg Synapses', 'Epoch',
       // traffic columns
       'Msgs total', 'Msgs mean', 'Msgs p50', 'Msgs p90', 'Msgs p99',
       'Msgs max', 'Msgs Gini', 'Hot >10× nodes', 'Hot >100× nodes',
       ...typeHeaders].join(','),
    ];
    for (const s of this._trainingHistory) {
      const t  = s.traffic?.summary;
      const bt = t?.byType ?? {};
      rows.push([
        s.isBaseline ? 'baseline' : s.session,
        s.hops?.mean  != null ? s.hops.mean.toFixed(3)  : '',
        s.time?.mean  != null ? s.time.mean.toFixed(2)  : '',
        s.successRate != null ? (s.successRate * 100).toFixed(2) + '%' : '',
        s.avgSynapses != null ? s.avgSynapses.toFixed(1) : '',
        s.epoch       != null ? s.epoch : '',
        // traffic delta values for this cycle
        t ? t.total   : '',
        t ? t.mean.toFixed(2) : '',
        t ? t.p50     : '',
        t ? t.p90     : '',
        t ? t.p99     : '',
        t ? t.max     : '',
        t ? t.gini.toFixed(4) : '',
        t ? t.hot10x  : '',
        t ? t.hot100x : '',
        // per-type subtotals (each is sender+receiver count, so 2× wire)
        ...typeCols.map(k => bt[k] ?? 0),
      ].join(','));
    }
    rows.push(this._paramsSection(null, [
      ['Sessions', this._trainingHistory.length],
    ]));
    return rows.join('\r\n');
  }

  /** Clear training log and destroy training chart (called on new Init). */
  clearTraining() {
    const pin = this._el('trainingBaseline');
    if (pin) pin.innerHTML = '';
    const log = this._el('trainingLog');
    if (log) log.innerHTML = '';
    if (this._charts['trainingLineChart']) {
      this._charts['trainingLineChart'].destroy();
      delete this._charts['trainingLineChart'];
    }
    if (this._charts['trainingTrafficChart']) {
      this._charts['trainingTrafficChart'].destroy();
      delete this._charts['trainingTrafficChart'];
    }
    this._hideSection('trainingResults');
  }

  /** Clear pub/sub chart and log (called on new Init or new pub/sub run). */
  clearPubSub() {
    const log = this._el('pubsubLog');
    if (log) log.innerHTML = '';
    if (this._charts['pubsubLineChart']) {
      this._charts['pubsubLineChart'].destroy();
      delete this._charts['pubsubLineChart'];
    }
    this._pubsubHistory = null;
    this._hideSection('pubsubResults');
  }

  /** Clear membership-sim chart and log (called on new Init or new run). */
  clearMembershipSim() {
    const log = this._el('membershipSimLog');
    if (log) log.innerHTML = '';
    if (this._charts['membershipSimLineChart']) {
      this._charts['membershipSimLineChart'].destroy();
      delete this._charts['membershipSimLineChart'];
    }
    this._membershipSimHistory = null;
    this._membershipSimShown = false;
    this._hideSection('membershipSimResults');
  }

  // ── Membership Pub/Sub live simulation ───────────────────────────────────

  /**
   * Update the live membership-pub/sub panel — shown on the first call,
   * incrementally updated thereafter. History is an array of tick rows:
   *   { tick, deliveredPct, cumulativeKilled, cumulativeKilledPct,
   *     axonRoles, maxFanout, treeDepth, overlapPct, convergePct,
   *     didChurn, killedThisTick }
   */
  showMembershipSimProgress(history, numGroups = 0, coveragePct = 0) {
    if (!history?.length) return;
    if (!this._membershipSimShown) {
      this._showSection('membershipSimResults');
      this._hideSection('trainingResults');
      this._hideSection('lookupResults');
      this._hideSection('churnResults');
      this._hideSection('demoResults');
      this._hideSection('benchmarkResults');
      this._hideSection('pubsubResults');
      this._hideSection('pairResults');
      this._hideSection('hotspotResults');
      this.panel?.classList.remove('bench-wide');
      this.panel?.classList.remove('train-wide');
      this._attachPanelHeader('membershipSimResults', 'Pub/Sub Membership (Live)',
                              () => this._membershipSimCSV(),
                              `dht-membership-sim-${Date.now()}.csv`);
      this._membershipSimShown = true;
    }

    this._membershipSimHistory = history;
    this._membershipSimMeta    = { numGroups, coveragePct };

    const s = history[history.length - 1];
    this._setText('msTick',      s.tick);
    this._setText('msDelivered', `${s.deliveredPct.toFixed(1)}%`);
    this._setText('msCumulative', s.cumulativePct != null ? `${s.cumulativePct.toFixed(1)}%` : '—');
    this._setText('msKilled',    `${s.cumulativeKilled} (${s.cumulativeKilledPct.toFixed(1)}%)`);
    this._setText('msAxons',     s.axonRoles);
    this._setText('msFanout',    s.maxFanout);
    this._setText('msDepth',     s.treeDepth);
    this._setText('msOverlap',   s.overlapPct != null ? `${s.overlapPct.toFixed(1)}%` : '—');

    // Rolling log — only write rows on CHURN ticks (and the first tick)
    // so the log stays readable across long runs.
    if (s.tick === 1 || s.didChurn) {
      const log = this._el('membershipSimLog');
      if (log) {
        const row = document.createElement('div');
        row.className = 'training-log-row';
        row.innerHTML =
          `<span class="tl-session">t${s.tick}</span>` +
          `<span class="tl-hops">deliv ${s.deliveredPct.toFixed(1)}%</span>` +
          `<span class="tl-time">axons ${s.axonRoles}</span>` +
          `<span class="tl-success">kill ${s.cumulativeKilledPct.toFixed(1)}%</span>` +
          `<span class="tl-meta">` +
            (s.didChurn ? `⚠ +${s.killedThisTick} this round · ` : '') +
            (s.overlapPct != null ? `K-ov ${s.overlapPct.toFixed(1)}% · ` : '') +
            `depth ${s.treeDepth}` +
          `</span>`;
        log.appendChild(row);
        log.scrollTop = log.scrollHeight;
      }
    }

    this._drawMembershipSimChart(history);
  }

  _drawMembershipSimChart(history) {
    const canvas = this._el('membershipSimLineChart');
    if (!canvas || typeof Chart === 'undefined' || history.length < 1) return;
    const small = { size: 10, family: "'JetBrains Mono','Fira Mono','Consolas',monospace" };

    // Bar-style emphasis on churn ticks so churn events are visible.
    const pointStyles = history.map(h => h.didChurn ? 'rectRot' : 'circle');
    const pointRadii  = history.map(h => h.didChurn ? 4 : 1);

    const deliveredData  = history.map(h => h.deliveredPct);
    const cumulativeData = history.map(h => h.cumulativePct);
    const killedData     = history.map(h => h.cumulativeKilledPct);
    const overlapData    = history.map(h => h.overlapPct);
    const labels         = history.map(h => `t${h.tick}`);

    if (this._charts['membershipSimLineChart']) {
      const c = this._charts['membershipSimLineChart'];
      c.data.labels = labels;
      c.data.datasets[0].data = deliveredData;
      c.data.datasets[0].pointStyle  = pointStyles;
      c.data.datasets[0].pointRadius = pointRadii;
      c.data.datasets[1].data = cumulativeData;
      c.data.datasets[2].data = killedData;
      c.data.datasets[3].data = overlapData;
      c.update('none');
      return;
    }

    this._charts['membershipSimLineChart'] = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Delivered %',
            data: deliveredData,
            borderColor: '#00ff88',
            backgroundColor: '#00ff8822',
            yAxisID: 'yPct',
            tension: 0.25,
            pointStyle: pointStyles,
            pointRadius: pointRadii,
            pointBackgroundColor: '#00ff88',
            borderWidth: 2,
          },
          {
            label: 'Cumulative Delivered %',
            data: cumulativeData,
            borderColor: '#ffaa00',
            backgroundColor: '#ffaa0022',
            yAxisID: 'yPct',
            tension: 0.25,
            pointRadius: 0,
            borderWidth: 2,
            spanGaps: true,
          },
          {
            label: 'Cumulative Killed %',
            data: killedData,
            borderColor: '#ff5566',
            backgroundColor: '#ff556622',
            yAxisID: 'yPct',
            tension: 0.25,
            pointRadius: 0,
            borderWidth: 1.5,
            borderDash: [4, 4],
          },
          {
            label: 'K-overlap %',
            data: overlapData,
            borderColor: '#44ddff',
            backgroundColor: '#44ddff22',
            yAxisID: 'yPct',
            tension: 0.25,
            pointRadius: 0,
            borderWidth: 1,
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#bbccee', font: small, boxWidth: 12, padding: 8 } },
          tooltip: {
            callbacks: {
              title: (items) => {
                const h = history[items[0]?.dataIndex];
                return `Tick ${h?.tick}${h?.didChurn ? ' ⚠ churn' : ''}`;
              },
              afterBody: (items) => {
                const h = history[items[0]?.dataIndex];
                if (!h) return '';
                return [
                  `axons=${h.axonRoles}, fan-out=${h.maxFanout}, depth=${h.treeDepth}`,
                  `killed this tick: ${h.killedThisTick}`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: '#99aacc', font: small, maxTicksLimit: 16 },
            grid:  { color: '#1a2a44' },
          },
          yPct: {
            type: 'linear', position: 'left',
            min: 0, max: 100,
            ticks: { color: '#bbccee', font: small, callback: v => `${v}%` },
            grid:  { color: '#1a2a4466' },
          },
        },
      },
    });
  }

  _membershipSimCSV() {
    if (!this._membershipSimHistory?.length) return '';
    const rows = [
      ['Tick', 'Delivered%', 'Delivered', 'Expected',
       'Cumulative%', 'CumReceived', 'CumExpected',
       'KilledThisTick', 'CumulativeKilled', 'CumulativeKilled%',
       'AxonRoles', 'MaxFanout', 'TreeDepth', 'KOverlap%', 'FullConverge%', 'ChurnThisTick'].join(','),
    ];
    for (const h of this._membershipSimHistory) {
      rows.push([
        h.tick,
        h.deliveredPct?.toFixed(2)        ?? '',
        h.delivered                        ?? '',
        h.expected                         ?? '',
        h.cumulativePct != null ? h.cumulativePct.toFixed(2) : '',
        h.cumReceived                     ?? '',
        h.cumExpected                     ?? '',
        h.killedThisTick                   ?? '',
        h.cumulativeKilled                 ?? '',
        h.cumulativeKilledPct?.toFixed(2) ?? '',
        h.axonRoles                        ?? '',
        h.maxFanout                        ?? '',
        h.treeDepth                        ?? '',
        h.overlapPct  != null ? h.overlapPct.toFixed(2)  : '',
        h.convergePct != null ? h.convergePct.toFixed(2) : '',
        h.didChurn ? 'yes' : 'no',
      ].join(','));
    }
    const meta = this._membershipSimMeta || {};
    rows.push(this._paramsSection(null, [
      ['Groups',       meta.numGroups ?? ''],
      ['Coverage %',   meta.coveragePct?.toFixed(1) ?? ''],
      ['Ticks',        this._membershipSimHistory.length],
    ]));
    return rows.join('\r\n');
  }

  /** Clear pair-learning chart and log (called on new Init or new pair run). */
  clearPairLearning() {
    const log = this._el('pairLog');
    if (log) log.innerHTML = '';
    if (this._charts['pairLineChart']) {
      this._charts['pairLineChart'].destroy();
      delete this._charts['pairLineChart'];
    }
    this._hideSection('pairResults');
  }

  // ── Pair Learning Results ────────────────────────────────────────────────

  showPairResults(history) {
    this._showSection('pairResults');
    this._hideSection('lookupResults');
    this._hideSection('churnResults');
    this._hideSection('demoResults');
    this._hideSection('benchmarkResults');
    this._hideSection('trainingResults');
    this._hideSection('pubsubResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.remove('bench-wide');
    this.panel?.classList.remove('train-wide');
    this._attachPanelHeader('pairResults', 'Pair Learning', () => this._pairCSV(), `dht-pair-learning-${Date.now()}.csv`);
    this._updatePairStats(history);
    this._drawPairChart(history);
  }

  updatePairProgress(history) {
    if (!history.length) return;
    this._updatePairStats(history);
    this._drawPairChart(history);
  }

  _updatePairStats(history) {
    if (!history.length) return;
    const s       = history[history.length - 1];
    const base    = history[0];
    const curHops = s.hops?.mean ?? null;
    const basHops = base?.hops?.mean ?? null;
    const delta   = (curHops != null && basHops != null)
      ? (curHops - basHops).toFixed(2)
      : null;
    const deltaStr = delta != null
      ? (parseFloat(delta) <= 0 ? delta : `+${delta}`)
      : '—';

    this._setText('pairSession',  s.session);
    this._setText('pairCount',    s.pairs.toLocaleString());
    this._setText('pairAvgHops',  curHops != null ? curHops.toFixed(2) : '—');
    this._setText('pairBaseline', basHops != null ? basHops.toFixed(2) : '—');
    this._setText('pairDelta',    deltaStr);

    const deltaEl = this._el('pairDelta');
    if (deltaEl && delta != null) {
      deltaEl.style.color = parseFloat(delta) < 0 ? '#00ff88'
                          : parseFloat(delta) > 0 ? '#ff4444'
                          : '#7799cc';
    }

    // Rolling session log
    const log = this._el('pairLog');
    if (log) {
      const row = document.createElement('div');
      row.className = 'pair-log-row';
      row.innerHTML =
        `<span class="pl-session">#${s.session}</span>` +
        `<span class="pl-hops">hops ${curHops != null ? curHops.toFixed(2) : '—'}</span>` +
        `<span class="pl-time">${s.time?.mean != null ? s.time.mean.toFixed(1) + ' ms' : '—'}</span>` +
        `<span class="pl-delta">${deltaStr}</span>`;
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    }
  }

  _drawPairChart(history) {
    this._pairHistory = history;
    const canvas = this._el('pairLineChart');
    if (!canvas || typeof Chart === 'undefined' || history.length < 1) return;

    const labels   = history.map(s => `#${s.session}`);
    const hopData  = history.map(s => s.hops?.mean  ?? null);
    const timeData = history.map(s => s.time?.mean  ?? null);

    // Y-axis: start at 1.0 (theoretical minimum), top at observed max
    const allHops = hopData.filter(v => v != null);
    const yMin = 1;
    const yMax = allHops.length ? Math.ceil(Math.max(...allHops) + 0.5) : 8;

    const small = { size: 10, family: "'JetBrains Mono','Fira Mono','Consolas',monospace" };

    if (this._charts['pairLineChart']) {
      const chart = this._charts['pairLineChart'];
      chart.data.labels = labels;
      chart.data.datasets[0].data = hopData;
      chart.data.datasets[1].data = timeData;
      chart.options.scales.yHops.min = yMin;
      chart.options.scales.yHops.max = yMax;
      chart.update('none');
      return;
    }

    // Dashed goal line at hops = 1
    const goalLinePlugin = {
      id: 'pairGoalLine',
      afterDraw(chart) {
        const ctx    = chart.ctx;
        const yScale = chart.scales.yHops;
        const xScale = chart.scales.x;
        if (!yScale || !xScale) return;
        const y = yScale.getPixelForValue(1);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(xScale.left, y);
        ctx.lineTo(xScale.right, y);
        ctx.strokeStyle = 'rgba(180,220,80,0.35)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.restore();
      },
    };

    this._charts['pairLineChart'] = new Chart(canvas, {
      type: 'line',
      plugins: [goalLinePlugin],
      data: {
        labels,
        datasets: [
          {
            label: 'Avg Hops',
            data: hopData,
            borderColor: '#aaff44',
            backgroundColor: '#aaff4418',
            yAxisID: 'yHops',
            tension: 0.3,
            pointRadius: 3,
            borderWidth: 2,
          },
          {
            label: 'Avg Time (ms)',
            data: timeData,
            borderColor: '#ff8844',
            backgroundColor: '#ff884418',
            yAxisID: 'yTime',
            tension: 0.3,
            pointRadius: 3,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#bbccee', font: small, boxWidth: 12, padding: 8 },
          },
          tooltip: {
            callbacks: {
              title: (items) => `Session ${history[items[0]?.dataIndex]?.session ?? ''}`,
            },
          },
        },
        scales: {
          x: {
            ticks: { color: '#99aacc', font: small, maxTicksLimit: 16 },
            grid:  { color: '#1a2a44' },
          },
          yHops: {
            type: 'linear', position: 'left',
            min: yMin,
            max: yMax,
            ticks: { color: '#aaff44', font: small },
            grid:  { color: '#1a2a4466' },
            title: { display: true, text: 'Avg Hops', color: '#aaff44', font: small },
          },
          yTime: {
            type: 'linear', position: 'right',
            ticks: { color: '#ff8844', font: small },
            grid:  { drawOnChartArea: false },
            title: { display: true, text: 'ms', color: '#ff8844', font: small },
          },
        },
      },
    });
  }

  _pairCSV() {
    if (!this._pairHistory?.length) return '';
    const base = this._pairHistory[0]?.hops?.mean ?? null;
    const rows = [
      ['Session', 'Pairs', 'Avg Hops', 'Avg Time (ms)', 'Delta Hops'].join(','),
    ];
    for (const s of this._pairHistory) {
      const delta = base != null && s.hops?.mean != null
        ? (s.hops.mean - base).toFixed(3) : '';
      rows.push([
        s.session,
        s.pairs ?? '',
        s.hops?.mean != null ? s.hops.mean.toFixed(3) : '',
        s.time?.mean != null ? s.time.mean.toFixed(2) : '',
        delta,
      ].join(','));
    }
    rows.push(this._paramsSection());
    return rows.join('\r\n');
  }

  // ── Pub/Sub Results ──────────────────────────────────────────────────────

  showPubSubResults(history, numGroups, coverage) {
    this._showSection('pubsubResults');
    this._hideSection('lookupResults');
    this._hideSection('churnResults');
    this._hideSection('demoResults');
    this._hideSection('benchmarkResults');
    this._hideSection('trainingResults');
    this._hideSection('pairResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.remove('bench-wide');
    this.panel?.classList.remove('train-wide');
    this._attachPanelHeader('pubsubResults', 'Pub/Sub', () => this._pubsubCSV(), `dht-pubsub-${Date.now()}.csv`);
    this._updatePubSubStats(history, numGroups, coverage);
    requestAnimationFrame(() => this._drawPubSubChart(history));
  }

  _updatePubSubStats(history, numGroups, coverage) {
    if (!history.length) return;
    const s = history[history.length - 1];
    this._setText('psMessages', `${s.tick}`);
    this._setText('psGroups',   `${numGroups}`);
    this._setText('psCoverage', `${coverage}%`);
    this._setText('psMsgHops',   s.msgHops  != null ? s.msgHops.toFixed(1)        : '—');
    this._setText('psRelayMs',   s.relayMs  != null ? `${s.relayMs} ms`           : '—');
    this._setText('psBcastHops', s.bcastAvg != null ? s.bcastAvg.toFixed(2)       : '—');
    this._setText('psBcastMs',   s.bcastMs  != null ? `${s.bcastMs} ms`           : '—');

    // Rolling log
    const log = this._el('pubsubLog');
    if (log) {
      const row = document.createElement('div');
      row.className = 'concordance-log-row';
      row.innerHTML =
        `<span class="cl-session">#${s.tick}</span>` +
        `<span class="cl-to">relay ${s.msgHops != null ? s.msgHops.toFixed(1) : '—'} hops · ${s.relayMs ?? '—'} ms</span>` +
        `<span class="cl-from">bcast ${s.bcastAvg != null ? s.bcastAvg.toFixed(1) : '—'} hops · ${s.bcastMs ?? '—'} ms</span>` +
        (s.maxFanout != null ? `<span class="cl-from" style="opacity:0.7">fan-out ${s.maxFanout}${s.treeDepth ? ` · depth ${s.treeDepth}` : ''}${s.avgSubsPerNode != null ? ` · ${s.avgSubsPerNode.toFixed(1)} subs/n` : ''}</span>` : '');
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    }
  }

  _drawPubSubChart(history) {
    this._pubsubHistory = history;
    const canvas = this._el('pubsubLineChart');
    if (!canvas || typeof Chart === 'undefined' || history.length < 1) return;

    // Keep a rolling window of the last 60 sessions for readability
    const WIN  = 60;
    const view = history.length > WIN ? history.slice(-WIN) : history;

    const labels      = view.map(s => `#${s.tick}`);
    const msgData     = view.map(s => s.msgHops   ?? null);
    const bcastData   = view.map(s => s.bcastAvg  != null ? +s.bcastAvg.toFixed(2) : null);
    const relayMsData = view.map(s => s.relayMs   ?? null);
    const bcastMsData = view.map(s => s.bcastMs   ?? null);

    const allHops = [...msgData, ...bcastData].filter(v => v != null);
    const yHopMin = 1;
    const yHopMax = allHops.length ? Math.ceil(Math.max(...allHops) + 0.5) : 6;
    const allMs   = [...relayMsData, ...bcastMsData].filter(v => v != null);
    const yMsMax  = allMs.length ? Math.ceil(Math.max(...allMs) / 50) * 50 + 50 : 1000;

    const small = { size: 10, family: "'JetBrains Mono','Fira Mono','Consolas',monospace" };

    if (this._charts['pubsubLineChart']) {
      const chart = this._charts['pubsubLineChart'];
      chart.data.labels            = labels;
      chart.data.datasets[0].data  = msgData;
      chart.data.datasets[1].data  = bcastData;
      chart.data.datasets[2].data  = relayMsData;
      chart.data.datasets[3].data  = bcastMsData;
      chart.options.scales.yHops.min = yHopMin;
      chart.options.scales.yHops.max = yHopMax;
      chart.options.scales.yMs.max   = yMsMax;
      chart.update('none');
      return;
    }

    this._charts['pubsubLineChart'] = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Relay avg (hops)',
            data: msgData,
            borderColor: '#44ddff',
            backgroundColor: '#44ddff18',
            yAxisID: 'yHops',
            tension: 0.3,
            pointRadius: 2,
            borderWidth: 2,
          },
          {
            label: 'Broadcast avg (hops)',
            data: bcastData,
            borderColor: '#aa66ff',
            backgroundColor: '#aa66ff18',
            yAxisID: 'yHops',
            tension: 0.3,
            pointRadius: 2,
            borderWidth: 2,
          },
          {
            label: 'Relay ms',
            data: relayMsData,
            borderColor: '#44ddff99',
            backgroundColor: '#44ddff0a',
            yAxisID: 'yMs',
            tension: 0.3,
            pointRadius: 2,
            borderWidth: 1.5,
            borderDash: [3, 3],
          },
          {
            label: 'Bcast ms',
            data: bcastMsData,
            borderColor: '#aa66ff99',
            backgroundColor: '#aa66ff0a',
            yAxisID: 'yMs',
            tension: 0.3,
            pointRadius: 2,
            borderWidth: 1.5,
            borderDash: [3, 3],
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#bbccee', font: small, boxWidth: 12, padding: 8 },
          },
          tooltip: {
            callbacks: {
              title: (items) => `Message ${view[items[0]?.dataIndex]?.tick ?? ''}`,
            },
          },
        },
        scales: {
          x: {
            ticks: { color: '#99aacc', font: small, maxTicksLimit: 12 },
            grid:  { color: '#1a2a44' },
          },
          yHops: {
            type: 'linear', position: 'left',
            min: yHopMin,
            max: yHopMax,
            ticks: { color: '#bbccee', font: small },
            grid:  { color: '#1a2a4466' },
            title: { display: true, text: 'Hops', color: '#bbccee', font: small },
          },
          yMs: {
            type: 'linear', position: 'right',
            min: 0,
            max: yMsMax,
            ticks: { color: '#ffcc44', font: small },
            grid:  { drawOnChartArea: false },
            title: { display: true, text: 'ms', color: '#ffcc44', font: small },
          },
        },
      },
    });
  }

  _pubsubCSV() {
    if (!this._pubsubHistory?.length) return '';
    const last = this._pubsubHistory[this._pubsubHistory.length - 1];
    const rows = [
      ['Tick', 'Groups', 'Coverage%', 'Relay Hops', 'Relay ms', 'Bcast Avg Hops', 'Bcast ms', 'Total Hops'].join(','),
    ];
    for (const s of this._pubsubHistory) {
      rows.push([
        s.tick,
        s.groups    ?? '',
        s.coverage  ?? '',
        s.msgHops   ?? '',
        s.relayMs   ?? '',
        s.bcastAvg  != null ? s.bcastAvg.toFixed(3) : '',
        s.bcastMs   ?? '',
        s.totalHops ?? '',
      ].join(','));
    }
    rows.push(this._paramsSection(null, [
      ['Pub/Sub group size',  this._lastRunParams?.pubsubGroupSize ?? ''],
      ['Pub/Sub coverage %',  last?.coverage ?? this._lastRunParams?.pubsubCoverage ?? ''],
    ]));
    return rows.join('\r\n');
  }

  _lookupHopsCSV() {
    if (!this._lastLookupResult) return '';
    const { hops, totalRuns, successes } = this._lastLookupResult;
    const rows = [
      ['Metric', 'Value'].join(','),
      ['Total Runs', totalRuns],
      ['Successes', successes],
      ['Avg Hops', hops?.mean?.toFixed(3) ?? ''],
      ['Median Hops', hops?.median?.toFixed(3) ?? ''],
      ['Max Hops', hops?.max ?? ''],
    ];
    if (hops?.histogram) {
      rows.push(['', '']);
      rows.push(['Hops', 'Count'].join(','));
      hops.histogram.forEach((count, idx) => {
        if (count > 0) rows.push([idx, count].join(','));
      });
    }
    rows.push(this._paramsSection());
    return rows.join('\r\n');
  }

  _lookupTimeCSV() {
    if (!this._lastLookupResult) return '';
    const { time } = this._lastLookupResult;
    const rows = [
      ['Metric', 'Value'].join(','),
      ['Avg Time (ms)', time?.mean?.toFixed(2) ?? ''],
      ['Median Time (ms)', time?.median?.toFixed(2) ?? ''],
      ['Max Time (ms)', time?.max ?? ''],
    ];
    rows.push(this._paramsSection());
    return rows.join('\r\n');
  }

  _churnCSV() {
    if (!this._lastChurnResult) return '';
    const timeSeries = this._lastChurnResult.timeSeries;
    if (!timeSeries?.length) return '';
    const rows = [
      ['Interval', 'Node Count', 'Nodes Replaced', 'Avg Hops', 'Avg Time (ms)', 'Success Rate'].join(','),
    ];
    for (const e of timeSeries) {
      rows.push([
        e.interval + 1,
        e.nodeCount ?? '',
        e.nodesReplaced ?? '',
        e.hops?.mean?.toFixed(3) ?? '',
        e.time?.mean?.toFixed(2) ?? '',
        e.successRate != null ? (e.successRate * 100).toFixed(2) + '%' : '',
      ].join(','));
    }
    rows.push(this._paramsSection(null, [
      ['Churn rate %',   this._lastRunParams?.churnRate ?? ''],
      ['Churn intervals', this._lastRunParams?.churnIntervals ?? ''],
      ['Lookups/interval', this._lastRunParams?.lookupsPerInterval ?? ''],
    ]));
    return rows.join('\r\n');
  }

  // ── Churn Test Results ───────────────────────────────────────────────────

  showChurnResults(result) {
    this._lastChurnResult = result;
    const { timeSeries } = result;
    this._showSection('churnResults');
    this._hideSection('lookupResults');
    this._hideSection('demoResults');
    this._hideSection('benchmarkResults');
    this._hideSection('trainingResults');
    this._hideSection('pubsubResults');
    this._hideSection('pairResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.remove('bench-wide');
    this.panel?.classList.remove('train-wide');
    this._attachPanelHeader('churnResults', 'Churn Test', () => this._churnCSV(), `dht-churn-${Date.now()}.csv`);
    this._updateChurnStats(timeSeries);
    requestAnimationFrame(() => this._drawChurnChart(timeSeries));
  }

  updateChurnProgress(timeSeries) {
    if (timeSeries.length === 0) return;
    if (this._lastChurnResult) this._lastChurnResult.timeSeries = timeSeries;
    this._updateChurnStats(timeSeries);
    requestAnimationFrame(() => this._drawChurnChart(timeSeries));
  }

  _updateChurnStats(timeSeries) {
    if (!timeSeries.length) return;
    const last  = timeSeries[timeSeries.length - 1];
    const total = parseInt(this._el('churnIntervals')?.value ?? 10);
    this._setText('churnCurInterval', `${last.interval + 1} / ${total}`);
    this._setText('churnCurNodes',    last.nodeCount.toLocaleString());
    this._setText('churnCurReplaced', `−${last.nodesReplaced}`);
    this._setText('churnCurSuccess',  `${(last.successRate * 100).toFixed(1)}%`);
    this._setText('churnCurHops',     last.hops?.mean?.toFixed(2) ?? '—');
    this._setText('churnCurTime',
      last.time?.mean != null ? `${last.time.mean.toFixed(1)} ms` : '—');
  }

  // ── Histogram ────────────────────────────────────────────────────────────

  _drawHistogram(canvasId, data, label, color) {
    const canvas = this._el(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;

    if (this._charts[canvasId]) {
      this._charts[canvasId].destroy();
    }

    const min = Math.min(...data);
    const max = Math.max(...data);
    const bins = Math.min(30, max - min + 1);
    const binSize = Math.max(1, (max - min) / bins);
    const buckets = Array.from({ length: bins }, (_, i) => ({
      label: (min + i * binSize).toFixed(0),
      count: 0,
    }));

    for (const v of data) {
      const idx = Math.min(bins - 1, Math.floor((v - min) / binSize));
      buckets[idx].count++;
    }

    this._charts[canvasId] = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: buckets.map(b => b.label),
        datasets: [{
          label,
          data: buckets.map(b => b.count),
          backgroundColor: color + 'aa',
          borderColor: color,
          borderWidth: 1,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#99aacc', maxTicksLimit: 10 }, grid: { color: '#1a2a44' } },
          y: { ticks: { color: '#99aacc' }, grid: { color: '#1a2a44' } },
        },
      },
    });
  }

  // ── Churn time-series chart ──────────────────────────────────────────────

  _drawChurnChart(timeSeries) {
    const canvas = this._el('churnTimeChart');
    if (!canvas || typeof Chart === 'undefined' || !timeSeries.length) return;

    if (this._charts['churnTimeChart']) {
      this._charts['churnTimeChart'].destroy();
    }

    const labels = timeSeries.map(e => `I${e.interval + 1}`);
    const small  = { size: 10, family: "'JetBrains Mono','Fira Mono','Consolas',monospace" };

    this._charts['churnTimeChart'] = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Avg Hops',
            data: timeSeries.map(e => e.hops?.mean ?? 0),
            borderColor: '#00ff88',
            backgroundColor: '#00ff8818',
            yAxisID: 'yHops',
            tension: 0.3,
            pointRadius: 3,
            borderWidth: 2,
          },
          {
            label: 'Success %',
            data: timeSeries.map(e => e.successRate * 100),
            borderColor: '#44aaff',
            backgroundColor: '#44aaff18',
            yAxisID: 'ySuccess',
            tension: 0.3,
            pointRadius: 3,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#bbccee', font: small, boxWidth: 12, padding: 10 },
          },
          tooltip: {
            callbacks: {
              // Append time + node count to the tooltip body
              afterBody: (items) => {
                const e = timeSeries[items[0]?.dataIndex];
                if (!e) return '';
                const t = e.time?.mean != null ? `${e.time.mean.toFixed(1)} ms` : '—';
                return [`Avg Time: ${t}`, `Nodes: ${e.nodeCount}  (−${e.nodesReplaced})`];
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: '#99aacc', font: small },
            grid:  { color: '#1a2a44' },
          },
          yHops: {
            type: 'linear', position: 'left',
            ticks: { color: '#00ff88', font: small },
            grid:  { color: '#1a2a4466' },
            title: { display: true, text: 'Avg Hops', color: '#00ff88', font: small },
          },
          ySuccess: {
            type: 'linear', position: 'right',
            max: 100,
            ticks: { color: '#44aaff', font: small, callback: v => v + '%' },
            grid:  { drawOnChartArea: false },
            title: { display: true, text: 'Success', color: '#44aaff', font: small },
          },
        },
      },
    });
  }

  // ── Benchmark Results ────────────────────────────────────────────────────

  /**
   * Render a multi-protocol × multi-radius comparison table.
   *
   * @param {object} benchResult  Return value from Engine.runBenchmark().
   * @param {number} nodeCount    Node count for the header.
   */
  showBenchmarkResults(benchResult, nodeCount, params) {
    const { protocolDefs, testSpecs, data } = benchResult;

    const container = this._el('benchmarkResults');
    if (!container) return;

    // Short display names for continent codes used in column headers and tooltips.
    const contName = { NA:'N.Am.', SA:'S.Am.', EU:'Europe', AF:'Africa', AS:'Asia', OC:'Oceania' };

    // Stable key and column label for each test spec.
    const specKey   = s => s.type === 'regional'     ? `r${s.radius}`
                         : s.type === 'dest'          ? `dest_${s.pct}`
                         : s.type === 'source'        ? `src_${s.pct}`
                         : s.type === 'srcdest'       ? `srcdest_${s.srcPct}_${s.destPct}`
                         : s.type === 'churn'         ? `churn_${s.rate}`
                         : s.type === 'continent'     ? `cont_${s.src}_${s.dst}`
                         : s.type === 'slice'         ? 'slice'
                         : s.type === 'pubsub'        ? 'pubsub'
                         : s.type === 'pubsubm'       ? 'pubsubm'
                         : s.type === 'pubsubm-local' ? 'pubsubm-local'
                         : s.type === 'pubsubmchurn'  ? 'pubsubmchurn'
                         : 'global';
    const specLabel = s => s.type === 'regional'     ? `${s.radius} km`
                         : s.type === 'dest'          ? `${s.pct}% dest`
                         : s.type === 'source'        ? `${s.pct}% src`
                         : s.type === 'srcdest'       ? `${s.srcPct}%→${s.destPct}%`
                         : s.type === 'churn'         ? `${s.rate}% churn`
                         : s.type === 'continent'     ? `${contName[s.src]??s.src}→${contName[s.dst]??s.dst}`
                         : s.type === 'slice'         ? 'Slice World'
                         : s.type === 'pubsub'        ? 'Pub/Sub'
                         : s.type === 'pubsubm'       ? 'Pub/Sub (Membership)'
                         : s.type === 'pubsubm-local' ? `Pub/Sub (Local ${s.radius ?? 2000}km)`
                         : s.type === 'pubsubmchurn'  ? `Pub/Sub (M+${s.rate}% Churn)`
                         : 'Global';
    const specTip   = s => s.type === 'regional'
      ? `Regional lookups: source and destination chosen within ${s.radius} km of each other. Tests geographic locality routing.`
      : s.type === 'dest'
      ? `Dest ${s.pct}%: all lookups target the same pool of ${s.pct}% hot destination nodes, from random sources. XOR-nearest selection gives structurally shorter paths, and Neuromorphic protocols learn these popular destinations faster.`
      : s.type === 'source'
      ? `Src ${s.pct}%: all lookups originate from the same pool of ${s.pct}% source nodes, with fully random destinations. No structural shortcut — performance is similar to global.`
      : s.type === 'srcdest'
      ? `Src${s.srcPct}%→Dest${s.destPct}%: lookups always originate from the same ${s.srcPct}% sender pool and target the same ${s.destPct}% receiver pool (non-overlapping). Models real-world traffic where a fixed set of clients sends to a fixed set of servers. N-4 lateral shortcut propagation means the entire sender cluster learns fast routes to receivers simultaneously.`
      : s.type === 'churn'
      ? `Churn ${s.rate}%: ${s.rate}% of nodes are replaced with fresh (state-free) nodes across 5 successive rounds before measurement. Neuromorphic protocols get 100 adaptation lookups between rounds to partially re-learn the changed topology. Tests steady-state routing resilience under ongoing node turnover.`
      : s.type === 'continent'
      ? `Cross-continental: sources drawn from ${contName[s.src]??s.src}, destinations from ${contName[s.dst]??s.dst}. Guaranteed to require at least one long trans-oceanic hop (~150–200 ms one-way). Tests whether long-range XOR strata are preserved after regional specialisation — the exact problem N-5's stratified synaptome was designed to solve. Neuromorphic protocols receive continent-crossing warmup lookups so trans-oceanic shortcuts can form before measurement.`
      : s.type === 'pubsub'
      ? `Pub/Sub overlay: nodes form ${s.coverage ?? 10}% coverage concordance groups (1 relay + ${s.groupSize ?? 32} participants each). Left column (→relay) = avg hops from a random participant to its relay. Right column (bcast) = avg hops from the relay back to each participant. Neuromorphic protocols receive 2× the standard warmup budget using actual pub/sub traffic so synaptomes learn relay-centric routes before measurement.`
      : s.type === 'pubsubm'
      ? `Pub/Sub (Membership): NX-15+ distributed pub/sub via the AxonManager membership protocol. Every participant subscribes through its own PubSubAdapter; subscribes route toward hash(topic) and attach at the first axon on the path. Each tick the relay publishes via its adapter and we measure: (1) delivered % — fraction of subscribers that received the publish, (2) axon roles — total axon nodes holding this topic across the network, (3) max subs/axon — largest axon's child count (capacity = maxDirectSubs), (4) tree depth. Only runs on protocols that implement axonFor() (currently NX-15).`
      : s.type === 'pubsubm-local'
      ? `Pub/Sub (Local ${s.radius ?? 2000}km): same membership protocol as Pub/Sub (Membership), but participants are the nearest-by-haversine alive nodes within ${s.radius ?? 2000} km of each relay. Measures delivery and routing efficiency when subscribers cluster geographically around the publisher — the common real-world case. Groups with fewer than groupSize neighbours in-range run at reduced size rather than padding with far-away nodes, so the numbers are honest about locality.`
      : s.type === 'pubsubmchurn'
      ? `Pub/Sub (Membership+Churn): drives K-closest pub/sub through a kill-and-heal cycle. Phase 1 measures baseline delivery on a stable tree; phase 2 kills ${s.rate}% of nodes (excluding publishers) and measures IMMEDIATE delivery with no protocol repair yet — this tests raw redundancy from K replication alone; phase 3 drives refresh ticks across surviving axons (TTL sweeps dead children, re-STOREs shift subscriptions to the new K-closest set), then measures RECOVERED delivery. Dead subscribers are excluded from the denominator — the question is whether survivors still get messages.`
      : 'Global: both source and destination chosen uniformly at random from all nodes. Worst-case baseline — no locality or hot-spot bias.';

    // Protocol row tooltip descriptions.
    const protoTips = {
      kademlia:  'Classic Kademlia: XOR-metric k-bucket routing with α-parallel iterative node lookups. No geographic awareness.',
      geob:      'G-DHT: XOR routing with an S2 geographic cell prefix embedded in node IDs. Biases routing toward physically nearby nodes. Stratified inter-cell (40%) + intra-cell (30%) + random global (30%) allocation keeps reachability at 100% under the web-connection cap.',
      ngdht:     'Neuromorphic-1 (N-1): Hebbian synapse weighting layered on top of geographic routing. Synapses strengthen on frequently used paths. First-generation adaptive DHT.',
      ngdht15w:  'Neuromorphic-15W (N-15W): Renewal-Based Highway Protection. Highway synapses decay slowly only when recently traversed; idle synapses decay at the cold local rate and are pruned naturally.',
      ngdhtnx1w: 'NX-1W: Configurable research protocol with modular neuromorphic rules (Markov annealing, hop caching, triadic closure, LTP). Rule parameters individually tunable.',
      ngdhtnx2w: 'NX-2W: NX-1W + Rule 15 proximity-ordered fan-out tree for optimised pub/sub broadcast routing.',
      ngdhtnx3:  'NX-3: Dual-path init — three-layer geographic init when uncapped (best latency), flat XOR init when web-limited (reliable coverage). Bootstrap synapse protection for structural synapses.',
      ngdhtnx4:  'NX-4: NX-3 + iterative fallback routing. When greedy AP routing hits a dead end, falls back to Kademlia-style iterative search querying closest unvisited peers, preventing dead-end failures.',
      ngdhtnx5:  'NX-5: NX-4 + stratified bootstrap allocation + global warmup. Bootstrap uses stratum-aware eviction (like K-DHT) so Phase 2 distant-cell peers can displace over-represented close peers. Global warmup lookups exercise long-range learning.',
      ngdhtnx6:  'NX-6: NX-5 + churn-resilience. Dead-peer detection triggers annealing temperature reheat (T_REHEAT=0.5) for aggressive route repair, plus immediate dead-synapse eviction with local-candidate replacement in the same stratum range.',
      ngdhtnx7:  'NX-7: NX-6 + dendritic pub/sub v1 (25% peel-off split). Hierarchical relay tree distributes broadcast across branch nodes. Can produce tall trees at large group sizes.',
      ngdhtnx8:  'NX-8: NX-6 + dendritic pub/sub v2 (balanced binary split). When a branch overflows, ALL subscribers split 50/50 into two new children; parent becomes pure relay. Depth ≈ log₂(N/capacity).',
      ngdhtnx9:  'NX-9: NX-6 + geographic dendritic pub/sub (S2-clustered tree). Groups subscribers by S2 cell, recruits same-cell branch nodes for direct 1-hop delivery. Root→branch: DHT routing; branch→subscriber: direct.',
      ngdhtnx10: 'NX-10: NX-6 + routing-topology forwarding tree. Delegates subscribers to the direct synapse that is the first hop toward them. Tree mirrors routing paths — forwarding hops are free. Fan-out bounded by capacity.',
      ngdhtnx11: 'NX-11: NX-10 + diversified bootstrap (80% stratified + 20% random global). Random peers improve churn resilience and give annealing more diverse exploration material.',
    };

    // Header row
    const initMode = params.benchBootstrap ? 'Bootstrap Init' : 'Omniscient Init';
    let html = `
      <div class="panel-title-bar">
        <span class="panel-title">Benchmark — ${nodeCount.toLocaleString()} nodes · ${initMode} · 500 lookups/cell <span class="bench-title-note">· each cell: mean / p95</span></span>
        <button class="chart-dl-btn" id="benchCsvBtn">&#8595; CSV</button>
      </div>
      <div class="bench-table-wrap">
      <table class="bench-table">
        <thead>
          <tr>
            <th>Protocol</th>`;
    for (const s of testSpecs) {
      const cls = s.type === 'dest'      ? ' class="dest-col"'
                : s.type === 'source'    ? ' class="src-col"'
                : s.type === 'srcdest'   ? ' class="srcdest-col"'
                : s.type === 'churn'     ? ' class="churn-col"'
                : s.type === 'continent' ? ' class="continent-col"'
                : '';
      // pub/sub expands into two separate colspan="2" header cells
      if (s.type === 'pubsub') {
        const tip = specTip(s);
        html += `<th colspan="2" class="pubsub-col"  data-tip="${tip}">Relay Pub/Sub</th>`;
        html += `<th colspan="2" class="pubsub-bcol" data-tip="${tip}">B&#x2019;cast Pub/Sub</th>`;
        html += `<th class="pubsub-bcol" data-tip="Max lookups performed by any single node in one broadcast tick. Flat protocols = group size. Dendritic tree distributes this across branch nodes.">Fan-out</th>`;
        html += `<th class="pubsub-bcol" data-tip="Maximum depth of dendritic relay tree. 0 = flat broadcast (no tree). Higher depth means more routing legs per subscriber.">Depth</th>`;
        html += `<th class="pubsub-bcol" data-tip="Average subscribers per branch node. Lower = better distribution. Flat protocols show group size (all on relay).">Subs/N</th>`;
      } else if (s.type === 'pubsubm') {
        const tip = specTip(s);
        html += `<th colspan="6" class="pubsubm-col" data-tip="${tip}">Pub/Sub (Membership)</th>`;
      } else if (s.type === 'pubsubm-local') {
        const tip = specTip(s);
        html += `<th colspan="6" class="pubsubm-col" data-tip="${tip}">Pub/Sub (Local ${s.radius ?? 2000}km)</th>`;
      } else if (s.type === 'pubsubmchurn') {
        const tip = specTip(s);
        html += `<th colspan="11" class="pubsubm-col" data-tip="${tip}">Pub/Sub (M+${s.rate}% Churn)</th>`;
      } else {
        html += `<th colspan="2"${cls} data-tip="${specTip(s)}">${specLabel(s)}</th>`;
      }
    }
    html += `
          </tr>
          <tr>
            <th></th>`;
    for (const s of testSpecs) {
      const isSrc       = s.type === 'source';
      const isDest      = s.type === 'dest';
      const isSrcDest   = s.type === 'srcdest';
      const isChurn     = s.type === 'churn';
      const isContinent = s.type === 'continent';
      const sub = isSrc ? ' src-sub' : isDest ? ' dest-sub' : isSrcDest ? ' srcdest-sub' : isChurn ? ' churn-sub' : isContinent ? ' continent-sub' : '';
      if (s.type === 'pubsub') {
        html += `<th class="sub pubsub-sub">hops</th><th class="sub pubsub-sub">ms</th>`;
        html += `<th class="sub pubsub-bsub">hops</th><th class="sub pubsub-bsub">ms</th>`;
        html += `<th class="sub pubsub-bsub">max</th>`;
        html += `<th class="sub pubsub-bsub">lvl</th>`;
        html += `<th class="sub pubsub-bsub">avg</th>`;
      } else if (s.type === 'pubsubm' || s.type === 'pubsubm-local') {
        html += `<th class="sub pubsubm-sub" data-tip="Fraction of subscribers that received each tick's publish. 100% = fully healthy tree.">deliv%</th>`;
        html += `<th class="sub pubsubm-sub" data-tip="Total axon nodes in the network holding this topic. 1 = flat tree (root only); > 1 = sub-axons recruited.">axons</th>`;
        html += `<th class="sub pubsubm-sub" data-tip="Largest direct-child count at any single axon. Capped by maxDirectSubs (default 20).">max/ax</th>`;
        html += `<th class="sub pubsubm-sub" data-tip="Rough tree depth: 1 = flat, 2 = has sub-axons.">depth</th>`;
        html += `<th class="sub pubsubm-sub" data-tip="Average overlap between publisher's K-closest set and subscribers' K-closest sets, as % of K. 100% = every publisher/subscriber pair agrees on all K replicas.">K-ov%</th>`;
        html += `<th class="sub pubsubm-sub" data-tip="Fraction of publisher/subscriber pairs where all K entries match exactly. Should be ~100% at steady state; divergence here predicts delivery misses.">conv%</th>`;
      } else if (s.type === 'pubsubmchurn') {
        html += `<th class="sub pubsubm-sub" data-tip="Delivery % BEFORE any nodes die. Should be ~100% at steady state.">base%</th>`;
        html += `<th class="sub pubsubm-sub" data-tip="Delivery % IMMEDIATELY after killing nodes, before any refresh. Measures raw K-closest redundancy.">imm%</th>`;
        html += `<th class="sub pubsubm-sub" data-tip="Delivery % after refresh ticks run across surviving axons. Measures TTL+refresh recovery.">rec%</th>`;
        html += `<th class="sub pubsubm-sub" data-tip="Number of nodes killed during the run.">killed</th>`;
        html += `<th class="sub pubsubm-sub" data-tip="Publisher/subscriber K-closest overlap % BEFORE churn. Should be ~100%.">base-ov%</th>`;
        html += `<th class="sub pubsubm-sub" data-tip="K-closest overlap IMMEDIATELY after churn, before refresh. Quantifies how much publisher/subscriber views diverged when nodes died.">imm-ov%</th>`;
        html += `<th class="sub pubsubm-sub" data-tip="K-closest overlap AFTER refresh. Shows how much convergence recovered as both sides re-computed K-closest over the refreshed node set.">rec-ov%</th>`;
        html += `<th class="sub pubsubm-sub" data-tip="Publisher K-set stability IMMEDIATELY after churn: fraction of pre-churn K-set still in publisher's current K-set (capped by the ~75% survival rate at 25% churn).">imm-pubS%</th>`;
        html += `<th class="sub pubsubm-sub" data-tip="Subscriber K-set stability IMMEDIATELY after churn: same metric from subscribers' viewpoint. Tests the hypothesis that publishers anchor more stable K-sets than subscribers do.">imm-subS%</th>`;
        html += `<th class="sub pubsubm-sub" data-tip="Publisher K-set stability AFTER refresh.">rec-pubS%</th>`;
        html += `<th class="sub pubsubm-sub" data-tip="Subscriber K-set stability AFTER refresh.">rec-subS%</th>`;
      } else {
        html += `<th class="sub${sub}">hops</th><th class="sub${sub}">ms</th>`;
      }
    }
    html += `</tr></thead><tbody>`;

    // Find per-column minimums for winner highlighting
    const minHops = {};
    const minTime = {};
    for (const s of testSpecs) {
      const k = specKey(s);
      minHops[k] = Infinity;
      minTime[k] = Infinity;
      if (s.type !== 'pubsub') {
        for (const def of protocolDefs) {
          const cell = data[def.key]?.[k];
          if (cell?.hops?.mean != null && cell.hops.mean < minHops[k]) minHops[k] = cell.hops.mean;
          if (cell?.time?.mean != null && cell.time.mean < minTime[k]) minTime[k] = cell.time.mean;
        }
      }
    }
    // Pub/sub has four independent min values (msg hops, msg ms, bcast hops, bcast ms)
    const minPS = { msgH: Infinity, msgMs: Infinity, bcastH: Infinity, bcastMs: Infinity };
    for (const def of protocolDefs) {
      const cell = data[def.key]?.['pubsub'];
      if (!cell) continue;
      if (cell.msgHops?.mean != null) minPS.msgH   = Math.min(minPS.msgH,   cell.msgHops.mean);
      if (cell.msgMs?.mean   != null) minPS.msgMs  = Math.min(minPS.msgMs,  cell.msgMs.mean);
      if (cell.bcastHops?.mean != null) minPS.bcastH  = Math.min(minPS.bcastH,  cell.bcastHops.mean);
      if (cell.bcastMs?.mean   != null) minPS.bcastMs = Math.min(minPS.bcastMs, cell.bcastMs.mean);
    }

    // Data rows
    for (const def of protocolDefs) {
      const rowTip = protoTips[def.key] ?? '';
      html += `<tr><td class="proto-name"${rowTip ? ` data-tip="${rowTip}"` : ''}>${def.label}</td>`;
      for (const s of testSpecs) {
        const k           = specKey(s);
        const cell        = data[def.key]?.[k];
        const isSrc       = s.type === 'source';
        const isDest      = s.type === 'dest';
        const isSrcDest   = s.type === 'srcdest';
        const isChurn     = s.type === 'churn';
        const isContinent = s.type === 'continent';
        const isPubSub    = s.type === 'pubsub';
        const isPubSubM   = s.type === 'pubsubm' || s.type === 'pubsubm-local';
        const isPubSubMC  = s.type === 'pubsubmchurn';
        const specCls     = isSrc ? ' src-cell' : isDest ? ' dest-cell' : isSrcDest ? ' srcdest-cell' : isChurn ? ' churn-cell' : isContinent ? ' continent-cell' : isPubSub ? ' pubsub-cell' : (isPubSubM || isPubSubMC) ? ' pubsubm-cell' : '';

        // Pub/Sub: five separate cells — relay hops, relay ms, bcast hops, bcast ms, max fan-out
        if (isPubSub) {
          if (!cell || !cell.msgHops) {
            html += `<td class="no-data pubsub-cell"  colspan="2">—</td>`;
            html += `<td class="no-data pubsub-bcell" colspan="5">—</td>`;
            continue;
          }
          const msgH    = cell.msgHops.mean.toFixed(2);
          const msgMs   = cell.msgMs?.mean   != null ? Math.round(cell.msgMs.mean)   : '—';
          const bcastH  = cell.bcastHops?.mean != null ? cell.bcastHops.mean.toFixed(2) : '—';
          const bcastMs = cell.bcastMs?.mean   != null ? Math.round(cell.bcastMs.mean)  : '—';
          const p95msg    = cell.msgHops.p95    != null ? cell.msgHops.p95.toFixed(1)    : null;
          const p95bcast  = cell.bcastHops?.p95 != null ? cell.bcastHops.p95.toFixed(1)  : null;
          const p95msgMs  = cell.msgMs?.p95     != null ? Math.round(cell.msgMs.p95)      : null;
          const p95bcastMs= cell.bcastMs?.p95   != null ? Math.round(cell.bcastMs.p95)    : null;
          const msgHWin   = cell.msgHops.mean  <= minPS.msgH  + 0.005;
          const msgMsWin  = cell.msgMs?.mean   != null && cell.msgMs.mean   <= minPS.msgMs  + 1;
          const bcastHWin = cell.bcastHops?.mean != null && cell.bcastHops.mean <= minPS.bcastH  + 0.005;
          const bcastMsWin= cell.bcastMs?.mean   != null && cell.bcastMs.mean   <= minPS.bcastMs + 1;
          html += `<td class="hops-cell${msgHWin  ? ' win' : ''} pubsub-cell">${msgH}${p95msg ? `<span class="p95">${p95msg}</span>` : ''}</td>`;
          html += `<td class="time-cell${msgMsWin ? ' win' : ''} pubsub-cell">${msgMs}${p95msgMs ? `<span class="p95">${p95msgMs}</span>` : ''}</td>`;
          html += `<td class="hops-cell${bcastHWin  ? ' win' : ''} pubsub-bcell">${bcastH}${p95bcast ? `<span class="p95">${p95bcast}</span>` : ''}</td>`;
          html += `<td class="time-cell${bcastMsWin ? ' win' : ''} pubsub-bcell">${bcastMs}${p95bcastMs ? `<span class="p95">${p95bcastMs}</span>` : ''}</td>`;
          const fanout = cell.maxFanout?.mean != null ? Math.round(cell.maxFanout.mean) : '—';
          const depth  = cell.treeDepth ?? 0;
          html += `<td class="hops-cell pubsub-bcell">${fanout}</td>`;
          html += `<td class="hops-cell pubsub-bcell">${depth}</td>`;
          const avgSubs = cell.avgSubsPerNode?.mean != null ? cell.avgSubsPerNode.mean.toFixed(1) : '—';
          html += `<td class="hops-cell pubsub-bcell">${avgSubs}</td>`;
          continue;
        }

        // Pub/Sub (M+Churn): four cells — baseline%, immediate%, recovered%, killed.
        if (isPubSubMC) {
          if (!cell) {
            html += `<td class="no-data pubsubm-cell" colspan="11">—</td>`;
            continue;
          }
          if (cell.unsupported) {
            html += `<td class="no-data pubsubm-cell" colspan="11" data-tip="protocol does not support membership pub/sub">n/a</td>`;
            continue;
          }
          const base   = cell.baseline?.mean  != null ? cell.baseline.mean.toFixed(1) + '%'  : '—';
          const imm    = cell.immediate?.mean != null ? cell.immediate.mean.toFixed(1) + '%' : '—';
          const rec    = cell.recovered?.mean != null ? cell.recovered.mean.toFixed(1) + '%' : '—';
          const kill   = cell.killedCount     ?? '—';
          const bOv    = cell.baselineOverlap?.overlapPct   != null ? cell.baselineOverlap.overlapPct.toFixed(1)  + '%' : '—';
          const iOv    = cell.immediateOverlap?.overlapPct  != null ? cell.immediateOverlap.overlapPct.toFixed(1) + '%' : '—';
          const rOv    = cell.recoveredOverlap?.overlapPct  != null ? cell.recoveredOverlap.overlapPct.toFixed(1) + '%' : '—';
          const iPubS  = cell.immediateStability?.pubStabilityPct != null ? cell.immediateStability.pubStabilityPct.toFixed(1) + '%' : '—';
          const iSubS  = cell.immediateStability?.subStabilityPct != null ? cell.immediateStability.subStabilityPct.toFixed(1) + '%' : '—';
          const rPubS  = cell.recoveredStability?.pubStabilityPct != null ? cell.recoveredStability.pubStabilityPct.toFixed(1) + '%' : '—';
          const rSubS  = cell.recoveredStability?.subStabilityPct != null ? cell.recoveredStability.subStabilityPct.toFixed(1) + '%' : '—';
          html += `<td class="hops-cell pubsubm-cell">${base}</td>`;
          html += `<td class="hops-cell pubsubm-cell">${imm}</td>`;
          html += `<td class="hops-cell pubsubm-cell">${rec}</td>`;
          html += `<td class="hops-cell pubsubm-cell">${kill}</td>`;
          html += `<td class="hops-cell pubsubm-cell">${bOv}</td>`;
          html += `<td class="hops-cell pubsubm-cell">${iOv}</td>`;
          html += `<td class="hops-cell pubsubm-cell">${rOv}</td>`;
          html += `<td class="hops-cell pubsubm-cell">${iPubS}</td>`;
          html += `<td class="hops-cell pubsubm-cell">${iSubS}</td>`;
          html += `<td class="hops-cell pubsubm-cell">${rPubS}</td>`;
          html += `<td class="hops-cell pubsubm-cell">${rSubS}</td>`;
          continue;
        }

        // Pub/Sub (Membership): six cells — delivered%, axon roles, max/axon,
        // depth, K-overlap%, full-convergence%.
        if (isPubSubM) {
          if (!cell) {
            html += `<td class="no-data pubsubm-cell" colspan="6">—</td>`;
            continue;
          }
          if (cell.unsupported) {
            html += `<td class="no-data pubsubm-cell" colspan="6" data-tip="${cell.reason ?? 'protocol does not support the membership protocol (no axonFor)'}">n/a</td>`;
            continue;
          }
          const deliv = cell.deliveredPct?.mean != null ? cell.deliveredPct.mean.toFixed(1) + '%' : '—';
          const roles = cell.axonRoles?.mean    != null ? Math.round(cell.axonRoles.mean) + ''   : '—';
          const maxCh = cell.maxChildren?.mean  != null ? Math.round(cell.maxChildren.mean) + '' : '—';
          const depth = cell.treeDepth          ?? 0;
          const ovPct = cell.overlap?.overlapPct  != null ? cell.overlap.overlapPct.toFixed(1)  + '%' : '—';
          const cvPct = cell.overlap?.convergePct != null ? cell.overlap.convergePct.toFixed(1) + '%' : '—';
          html += `<td class="hops-cell pubsubm-cell">${deliv}</td>`;
          html += `<td class="hops-cell pubsubm-cell">${roles}</td>`;
          html += `<td class="hops-cell pubsubm-cell">${maxCh}</td>`;
          html += `<td class="hops-cell pubsubm-cell">${depth}</td>`;
          html += `<td class="hops-cell pubsubm-cell">${ovPct}</td>`;
          html += `<td class="hops-cell pubsubm-cell">${cvPct}</td>`;
          continue;
        }

        if (!cell || !cell.hops) {
          html += `<td class="no-data${specCls}" colspan="2">—</td>`;
          continue;
        }
        const hops    = cell.hops.mean.toFixed(2);
        const ms      = cell.time?.mean  != null ? cell.time.mean.toFixed(1)  : '—';
        const p95hops = cell.hops.p95    != null ? cell.hops.p95.toFixed(1)   : null;
        const p95ms   = cell.time?.p95   != null ? cell.time.p95.toFixed(0)   : null;
        const sr      = cell.successRate < 1.0
          ? ` <span class="sr">${(cell.successRate * 100).toFixed(1)}%</span>` : '';

        const hopsWin = cell.hops.mean <= minHops[k] + 0.005;
        const timeWin = cell.time?.mean != null && cell.time.mean <= minTime[k] + 0.5;
        const lowSr   = cell.successRate < 1.0 ? ' low-sr' : '';

        const p95HopsStr = p95hops ? `<span class="p95">${p95hops}</span>` : '';
        const p95MsStr   = p95ms   ? `<span class="p95">${p95ms}</span>`   : '';

        html += `<td class="hops-cell${hopsWin ? ' win' : ''}${specCls}${lowSr}">${hops}${sr}${p95HopsStr}</td>`;
        html += `<td class="time-cell${timeWin ? ' win' : ''}${specCls}${lowSr}">${ms}${p95MsStr}</td>`;
      }
      html += `</tr>`;
    }

    html += `</tbody></table></div>`;
    container.innerHTML = html;

    // Wire up benchmark CSV button (can't use addEventListener before innerHTML)
    const benchCsvBtn = container.querySelector('#benchCsvBtn');
    if (benchCsvBtn) {
      benchCsvBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const csv = this._benchmarkCSV(benchResult, nodeCount, params);
        if (csv) this._downloadCSV(csv, `dht-benchmark-${Date.now()}.csv`);
      });
    }

    this._showSection('benchmarkResults');
    this._hideSection('lookupResults');
    this._hideSection('churnResults');
    this._hideSection('demoResults');
    this._hideSection('trainingResults');
    this._hideSection('pubsubResults');
    this._hideSection('pairResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.add('bench-wide');
  }

  _benchmarkCSV(benchResult, nodeCount, params) {
    if (!benchResult) return '';
    const { protocolDefs, testSpecs, data } = benchResult;
    const csvSpecLabel = s => s.type === 'regional'  ? `${s.radius}km`
                            : s.type === 'dest'       ? `${s.pct}%dest`
                            : s.type === 'source'     ? `${s.pct}%src`
                            : s.type === 'srcdest'    ? `${s.srcPct}%→${s.destPct}%`
                            : s.type === 'churn'      ? `${s.rate}%churn`
                            : s.type === 'continent'  ? `${s.src}→${s.dst}`
                            : s.type === 'slice'      ? 'slice'
                            : s.type === 'pubsub'     ? 'pubsub'
                            : s.type === 'pubsubm'    ? 'pubsubm'
                            : s.type === 'pubsubm-local' ? `pubsubm-local-${s.radius ?? 2000}km`
                            : s.type === 'pubsubmchurn' ? `pubsubm+${s.rate}%churn`
                            : 'global';
    const csvSpecKey   = s => s.type === 'regional'  ? `r${s.radius}`
                            : s.type === 'dest'       ? `dest_${s.pct}`
                            : s.type === 'source'     ? `src_${s.pct}`
                            : s.type === 'srcdest'    ? `srcdest_${s.srcPct}_${s.destPct}`
                            : s.type === 'churn'      ? `churn_${s.rate}`
                            : s.type === 'continent'  ? `cont_${s.src}_${s.dst}`
                            : s.type === 'slice'      ? 'slice'
                            : s.type === 'pubsub'     ? 'pubsub'
                            : s.type === 'pubsubm'    ? 'pubsubm'
                            : s.type === 'pubsubm-local' ? 'pubsubm-local'
                            : s.type === 'pubsubmchurn' ? 'pubsubmchurn'
                            : 'global';

    // Comment line: init mode
    const initLine = `# DHT Benchmark — ${nodeCount.toLocaleString()} nodes · ${params.benchBootstrap ? 'Bootstrap Init' : 'Omniscient Init'}`;

    // Build header: Protocol, then columns per spec.
    // Non-pub/sub cells emit: hops, ms, success%.
    // Pub/sub cells emit:     relay hops, relay ms, bcast hops, bcast ms.
    const headerCols = ['Protocol'];
    for (const s of testSpecs) {
      const lbl = csvSpecLabel(s);
      if (s.type === 'pubsub') {
        headerCols.push(`${lbl} →relay hops`, `${lbl} →relay ms`, `${lbl} bcast hops`, `${lbl} bcast ms`, `${lbl} max fan-out`, `${lbl} tree depth`, `${lbl} avg subs/node`);
      } else if (s.type === 'pubsubm' || s.type === 'pubsubm-local') {
        headerCols.push(`${lbl} delivered%`, `${lbl} axon roles`, `${lbl} max subs/axon`, `${lbl} tree depth`, `${lbl} K-overlap%`, `${lbl} full-converge%`);
      } else if (s.type === 'pubsubmchurn') {
        headerCols.push(`${lbl} baseline%`, `${lbl} immediate%`, `${lbl} recovered%`, `${lbl} recovered10%`, `${lbl} killed`, `${lbl} baseline-overlap%`, `${lbl} immediate-overlap%`, `${lbl} recovered-overlap%`, `${lbl} recovered10-overlap%`, `${lbl} imm pub-K-stab%`, `${lbl} imm sub-K-stab%`, `${lbl} rec pub-K-stab%`, `${lbl} rec sub-K-stab%`, `${lbl} rec10 pub-K-stab%`, `${lbl} rec10 sub-K-stab%`, `${lbl} attached%`, `${lbl} orphaned`, `${lbl} roles`, `${lbl} dead-children`);
      } else {
        headerCols.push(`${lbl} hops`, `${lbl} ms`, `${lbl} success%`);
      }
    }

    // Data rows — one per protocol
    const rows = [initLine, headerCols.join(',')];
    for (const proto of protocolDefs) {
      const cols = [proto.label ?? proto.key];
      for (const s of testSpecs) {
        const key  = csvSpecKey(s);
        const cell = data?.[proto.key]?.[key];
        if (s.type === 'pubsub') {
          cols.push(
            cell?.msgHops?.mean  != null ? cell.msgHops.mean.toFixed(3)    : '',
            cell?.msgMs?.mean    != null ? Math.round(cell.msgMs.mean) + '' : '',
            cell?.bcastHops?.mean != null ? cell.bcastHops.mean.toFixed(3) : '',
            cell?.bcastMs?.mean   != null ? Math.round(cell.bcastMs.mean) + '' : '',
            cell?.maxFanout?.mean != null ? Math.round(cell.maxFanout.mean) + '' : '',
            cell?.treeDepth != null ? cell.treeDepth + '' : '0',
            cell?.avgSubsPerNode?.mean != null ? cell.avgSubsPerNode.mean.toFixed(1) : '',
          );
        } else if (s.type === 'pubsubm' || s.type === 'pubsubm-local') {
          if (cell?.unsupported) {
            cols.push('n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a');
          } else {
            cols.push(
              cell?.deliveredPct?.mean != null ? cell.deliveredPct.mean.toFixed(1) + '%' : '',
              cell?.axonRoles?.mean    != null ? Math.round(cell.axonRoles.mean) + ''   : '',
              cell?.maxChildren?.mean  != null ? Math.round(cell.maxChildren.mean) + '' : '',
              cell?.treeDepth          != null ? cell.treeDepth + ''                    : '0',
              cell?.overlap?.overlapPct  != null ? cell.overlap.overlapPct.toFixed(1) + '%' : '',
              cell?.overlap?.convergePct != null ? cell.overlap.convergePct.toFixed(1) + '%' : '',
            );
          }
        } else if (s.type === 'pubsubmchurn') {
          if (cell?.unsupported) {
            cols.push('n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a');
          } else {
            cols.push(
              cell?.baseline?.mean      != null ? cell.baseline.mean.toFixed(1) + '%'      : '',
              cell?.immediate?.mean     != null ? cell.immediate.mean.toFixed(1) + '%'     : '',
              cell?.recovered?.mean     != null ? cell.recovered.mean.toFixed(1) + '%'     : '',
              cell?.recoveredDeep?.mean != null ? cell.recoveredDeep.mean.toFixed(1) + '%' : '',
              cell?.killedCount         != null ? cell.killedCount + ''                     : '',
              cell?.baselineOverlap?.overlapPct      != null ? cell.baselineOverlap.overlapPct.toFixed(1) + '%'      : '',
              cell?.immediateOverlap?.overlapPct     != null ? cell.immediateOverlap.overlapPct.toFixed(1) + '%'     : '',
              cell?.recoveredOverlap?.overlapPct     != null ? cell.recoveredOverlap.overlapPct.toFixed(1) + '%'     : '',
              cell?.recoveredDeepOverlap?.overlapPct != null ? cell.recoveredDeepOverlap.overlapPct.toFixed(1) + '%' : '',
              cell?.immediateStability?.pubStabilityPct     != null ? cell.immediateStability.pubStabilityPct.toFixed(1) + '%'     : '',
              cell?.immediateStability?.subStabilityPct     != null ? cell.immediateStability.subStabilityPct.toFixed(1) + '%'     : '',
              cell?.recoveredStability?.pubStabilityPct     != null ? cell.recoveredStability.pubStabilityPct.toFixed(1) + '%'     : '',
              cell?.recoveredStability?.subStabilityPct     != null ? cell.recoveredStability.subStabilityPct.toFixed(1) + '%'     : '',
              cell?.recoveredDeepStability?.pubStabilityPct != null ? cell.recoveredDeepStability.pubStabilityPct.toFixed(1) + '%' : '',
              cell?.recoveredDeepStability?.subStabilityPct != null ? cell.recoveredDeepStability.subStabilityPct.toFixed(1) + '%' : '',
              cell?.orphanDiag?.attachedPct != null ? cell.orphanDiag.attachedPct.toFixed(1) + '%' : '',
              cell?.orphanDiag?.orphanedSubs != null ? cell.orphanDiag.orphanedSubs + '' : '',
              cell?.orphanDiag?.totalRoles   != null ? cell.orphanDiag.totalRoles + ''   : '',
              cell?.orphanDiag?.totalDeadChildren != null ? cell.orphanDiag.totalDeadChildren + '' : '',
            );
          }
        } else {
          cols.push(
            cell?.hops?.mean        != null ? cell.hops.mean.toFixed(3)                     : '',
            cell?.time?.mean        != null ? cell.time.mean.toFixed(2)                     : '',
            cell?.successRate       != null ? (cell.successRate * 100).toFixed(1) + '%'     : '',
          );
        }
      }
      rows.push(cols.join(','));
    }

    // ── Parameter section at the bottom ────────────────────────────────────
    const hasType = t => testSpecs.some(s => s.type === t);
    const extra = [];
    if (params) {
      extra.push(['Lookups per cell',              params.msgCount]);
      extra.push(['Warmup sessions (neuromorphic)', params.benchWarmupSessions]);
      extra.push(['Effective warmup lookups',
        Math.max(params.benchWarmupSessions, Math.round(4 * (nodeCount ?? 0) / 10000)) * 500]);
      if (hasType('source') || hasType('srcdest'))
        extra.push(['Source pool %', params.sourcePct]);
      if (hasType('dest') || hasType('srcdest'))
        extra.push(['Dest pool %', params.destPct]);
      if (hasType('pubsub') || hasType('pubsubm') || hasType('pubsubm-local') || hasType('pubsubmchurn')) {
        extra.push(['Pub/Sub group size',  params.pubsubGroupSize]);
        extra.push(['Pub/Sub coverage %',  params.pubsubCoverage]);
      }
      if ((hasType('pubsubm') || hasType('pubsubm-local') || hasType('pubsubmchurn')) && params.nx15Params) {
        const m = params.nx15Params;
        if (m.rootSetSize          != null) extra.push(['NX-15 rootSetSize (K)',      m.rootSetSize]);
        if (m.maxDirectSubs        != null) extra.push(['NX-15 maxDirectSubs',        m.maxDirectSubs]);
        if (m.minDirectSubs        != null) extra.push(['NX-15 minDirectSubs',        m.minDirectSubs]);
        if (m.refreshIntervalMs    != null) extra.push(['NX-15 refreshIntervalMs',    m.refreshIntervalMs]);
        if (m.maxSubscriptionAgeMs != null) extra.push(['NX-15 maxSubscriptionAgeMs', m.maxSubscriptionAgeMs]);
        if (m.rootGraceMs          != null) extra.push(['NX-15 rootGraceMs',          m.rootGraceMs]);
      }
      if (hasType('churn'))
        extra.push(['Churn rate %', params.benchChurnPct]);
    }
    // δ baseline (Dabek 3δ floor analysis): median pairwise one-way latency
    // for the simulated population, plus the theoretical lookup-latency floor.
    const dB = benchResult?.deltaBaseline;
    if (dB) {
      extra.push(['δ median (one-way ms)', dB.median.toFixed(2)]);
      extra.push(['δ mean (one-way ms)',   dB.mean.toFixed(2)]);
      extra.push(['δ p95 (one-way ms)',    dB.p95.toFixed(2)]);
      extra.push(['3δ floor — median (ms)', (3 * dB.median).toFixed(2)]);
      extra.push(['3δ floor — mean (ms)',   (3 * dB.mean).toFixed(2)]);
    }
    rows.push(this._paramsSection(params, extra));

    rows.unshift(`# DHT Benchmark — ${nodeCount?.toLocaleString()} nodes · ${params?.msgCount ?? 500} lookups/cell`);
    return rows.join('\r\n');
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  _setText(id, val) {
    const el = this._el(id);
    if (el) el.textContent = val;
  }

  _showSection(id) {
    const el = this._el(id);
    if (el) el.style.display = '';
  }

  _hideSection(id) {
    const el = this._el(id);
    if (el) el.style.display = 'none';
  }

  clear() {
    Object.values(this._charts).forEach(c => c.destroy?.());
    this._charts = {};
    this._hideSection('benchmarkResults');
    this._hideSection('pubsubResults');
    this._hideSection('pairResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.remove('bench-wide');
    this.panel?.classList.remove('train-wide');
  }

  // ── Hotspot Results ───────────────────────────────────────────────────────

  _destroyChart(key) {
    if (this._charts[key]) {
      this._charts[key].destroy();
      delete this._charts[key];
    }
  }

  clearHotspot() {
    this._hotspotData = null;
    this._destroyChart('highwayLorenz');
    this._destroyChart('storageLorenz');
    this._hideSection('hotspotResults');
  }

  showHotspotResults(data) {
    this._hotspotData = data;
    // Hide other panels
    ['lookupResults','churnResults','benchmarkResults',
     'trainingResults','pubsubResults','pairResults']
      .forEach(id => this._hideSection(id));

    this._attachPanelHeader('hotspotResults', 'Hotspot Test',
      () => this._hotspotCSV(), 'hotspot.csv');

    this._updateHotspotStats(data);
    this._drawHotspotCharts(data);
    document.getElementById('hotspotResults').style.display = '';
  }

  _updateHotspotStats(data) {
    const hw = data.highway;
    const st = data.storage;
    const fmt = (v, digits = 2) => (v ?? 0).toFixed(digits);
    const pct  = v => (v * 100).toFixed(1) + '%';

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('hsHwGini',      fmt(hw.gini));
    set('hsHwTop1',      pct(hw.top1pctLoad));
    set('hsHwTop10',     pct(hw.top10pctLoad));
    set('hsHwMax',       hw.maxLoad);
    set('hsHwSuccess',   pct(hw.successRate));
    set('hsStGini',      fmt(st.gini));
    set('hsStTop10',     pct(st.top10pctItemLoad));
    set('hsStMax',       st.maxLoad);
    set('hsStSuccess',   pct(st.successRate));
    set('hsStItems',     st.numItems);
    set('hsStZipf',      st.zipfExponent.toFixed(1));
  }

  _drawHotspotCharts(data) {
    this._destroyChart('highwayLorenz');
    this._destroyChart('storageLorenz');

    const GRID   = 'rgba(30,90,160,0.2)';
    const LABEL  = '#7799cc';
    const EQUAL  = 'rgba(255,255,255,0.15)';

    // Shared Lorenz chart builder
    const drawLorenz = (canvasId, key, lorenz, color, title) => {
      const canvas = document.getElementById(canvasId);
      if (!canvas) return;
      const equalLine = [{ x: 0, y: 0 }, { x: 100, y: 100 }];
      const curveData = lorenz.xs.map((x, i) => ({ x, y: lorenz.ys[i] }));
      this._charts[key] = new Chart(canvas.getContext('2d'), {
        type: 'scatter',
        data: {
          datasets: [
            {
              label: 'Perfect equality',
              data: equalLine,
              borderColor: EQUAL,
              borderWidth: 1,
              borderDash: [4, 4],
              pointRadius: 0,
              showLine: true,
              fill: false,
            },
            {
              label: title,
              data: curveData,
              borderColor: color,
              backgroundColor: color.replace(')', ',0.12)').replace('rgb', 'rgba'),
              borderWidth: 1.5,
              pointRadius: 0,
              showLine: true,
              fill: { target: { value: 100 }, below: color.replace(')', ',0.06)').replace('rgb', 'rgba') },
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => `${ctx.parsed.x.toFixed(1)}% of nodes → ${ctx.parsed.y.toFixed(1)}% of load`,
              },
            },
          },
          scales: {
            x: {
              type: 'linear', min: 0, max: 100,
              title: { display: true, text: 'Cumulative % of nodes (least→most loaded)', color: LABEL, font: { size: 10 } },
              ticks: { color: LABEL, font: { size: 9 }, callback: v => v + '%' },
              grid: { color: GRID },
            },
            y: {
              type: 'linear', min: 0, max: 100,
              title: { display: true, text: 'Cumulative % of traffic', color: LABEL, font: { size: 10 } },
              ticks: { color: LABEL, font: { size: 9 }, callback: v => v + '%' },
              grid: { color: GRID },
            },
          },
        },
      });
    };

    drawLorenz('highwayLorenzChart', 'highwayLorenz',
      data.highway.lorenz, 'rgb(255,140,40)',   'Routing relay load');
    drawLorenz('storageLorenzChart', 'storageLorenz',
      data.storage.lorenz, 'rgb(100,200,255)', 'Content query load');
  }

  _hotspotCSV() {
    if (!this._hotspotData) return '';
    const { highway: hw, storage: st } = this._hotspotData;
    const lines = [
      'Section,Metric,Value',
      `Highway,Gini,${hw.gini.toFixed(4)}`,
      `Highway,Top 1% node load,${(hw.top1pctLoad * 100).toFixed(2)}%`,
      `Highway,Top 10% node load,${(hw.top10pctLoad * 100).toFixed(2)}%`,
      `Highway,Max relay count,${hw.maxLoad}`,
      `Highway,Total transits,${hw.totalTransits}`,
      `Highway,Success rate,${(hw.successRate * 100).toFixed(2)}%`,
      `Highway,Nodes measured,${hw.numNodes}`,
      `Storage,Gini,${st.gini.toFixed(4)}`,
      `Storage,Top 10% item load,${(st.top10pctItemLoad * 100).toFixed(2)}%`,
      `Storage,Max item queries,${st.maxLoad}`,
      `Storage,Total queries,${st.totalQueries}`,
      `Storage,Success rate,${(st.successRate * 100).toFixed(2)}%`,
      `Storage,Content items,${st.numItems}`,
      `Storage,Zipf exponent,${st.zipfExponent}`,
      '',
      'Highway Lorenz Curve',
      'Node percentile,Cumulative load %',
      ...hw.lorenz.xs.map((x, i) => `${x.toFixed(2)},${hw.lorenz.ys[i].toFixed(2)}`),
      '',
      'Storage Lorenz Curve',
      'Item percentile,Cumulative queries %',
      ...st.lorenz.xs.map((x, i) => `${x.toFixed(2)},${st.lorenz.ys[i].toFixed(2)}`),
    ];
    lines.push(this._paramsSection(null, [
      ['Hotspot lookups',  this._lastRunParams?.hotspotLookups ?? ''],
      ['Content items',    this._lastRunParams?.contentCount   ?? ''],
      ['Zipf exponent',    this._lastRunParams?.zipfExponent   ?? ''],
    ]));
    return lines.join('\n');
  }

  // ── Public CSV accessors for server push ─────────────────────────────────
  getBenchmarkCSV(benchResult, nodeCount, params) { return this._benchmarkCSV(benchResult, nodeCount, params) ?? ''; }
  getPubSubCSV()   { return this._pubsubCSV()    ?? ''; }
  getLookupCSV()   { return this._lookupHopsCSV() ?? ''; }
  getChurnCSV()    { return this._churnCSV()      ?? ''; }
  getHotspotCSV()  { return this._hotspotCSV()    ?? ''; }
  getPairCSV()     { return this._pairCSV()       ?? ''; }
  getTrainingCSV() { return this._trainingCSV()   ?? ''; }
  getMembershipSimCSV() { return this._membershipSimCSV() ?? ''; }
}
