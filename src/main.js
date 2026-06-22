/**
 * main.js – application bootstrap and event wiring.
 *
 * Responsibilities:
 *   - Load world GeoJSON and initialise the 3D globe.
 *   - Respond to UI button clicks (Init / Lookup Test / Churn Test / Stop).
 *   - Instantiate the correct DHT protocol and run simulations.
 *   - Push results to the Results panel and path visualisations to the globe.
 */

// ── Heartbeat indicator ─────────────────────────────────────────────────────
// A small colour-pulsing dot next to the app title tells the user the app is
// alive AND what it is doing. The pulse is JS-driven (setInterval toggles a
// CSS class) — deliberately not a compositor-layer @keyframes — so that a
// blocked main thread causes a VISIBLE freeze of the pulse. If the light
// stops blinking, JS is stuck.
//
// States: 'idle' | 'init' | 'benchmark' | 'training' | 'pubsub' | 'sweep' | 'error'.
// Colour comes from CSS rules keyed on the data-state attribute; pulse rate
// (how often we toggle the `.beat` class) comes from this timer.
export function setAppState(state) {
  const el = document.getElementById('heartbeat');
  if (el) el.setAttribute('data-state', state);
}

// Kick off the JS-driven pulse as soon as this module loads. A 400 ms
// interval gives a visible "tick" around 2.5 Hz — fast enough to make a
// freeze obvious, slow enough not to waste frames. Timer callbacks queue
// when JS is blocked, so a recovering main thread will fire a burst of
// queued toggles and then resume regular cadence.
(() => {
  let on = false;
  setInterval(() => {
    const el = document.getElementById('heartbeat');
    if (!el) return;
    on = !on;
    el.classList.toggle('beat', on);
  }, 400);
})();

import { Globe }              from './globe/Globe.js';
import { applySliceWorldPartition, findNodeNearest } from './dht/sliceWorld.js';
import { KademliaDHT }        from './dht/kademlia/KademliaDHT.js';
import { GeographicDHT, GeographicDHTa, GeographicDHTb } from './dht/geographic/GeographicDHT.js';
import { NeuromorphicDHT }    from './dht/neuromorphic/NeuromorphicDHT.js';
import { NeuromorphicDHT15W }  from './dht/neuromorphic/NeuromorphicDHT15W.js';
import { NeuromorphicDHTNX1W } from './dht/neuromorphic/NeuromorphicDHTNX1W.js';
import { NeuromorphicDHTNX2W } from './dht/neuromorphic/NeuromorphicDHTNX2W.js';
import { NeuromorphicDHTNX3 }  from './dht/neuromorphic/NeuromorphicDHTNX3.js';
import { NeuromorphicDHTNX4 }  from './dht/neuromorphic/NeuromorphicDHTNX4.js';
import { NeuromorphicDHTNX5 }  from './dht/neuromorphic/NeuromorphicDHTNX5.js';
import { NeuromorphicDHTNX6 }  from './dht/neuromorphic/NeuromorphicDHTNX6.js';
import { NeuromorphicDHTNX7 }  from './dht/neuromorphic/NeuromorphicDHTNX7.js';
import { NeuromorphicDHTNX8 }  from './dht/neuromorphic/NeuromorphicDHTNX8.js';
import { NeuromorphicDHTNX9 }  from './dht/neuromorphic/NeuromorphicDHTNX9.js';
import { NeuromorphicDHTNX10 } from './dht/neuromorphic/NeuromorphicDHTNX10.js';
import { NeuromorphicDHTNX13 } from './dht/neuromorphic/NeuromorphicDHTNX13.js';
import { NeuromorphicDHTNX15 } from './dht/neuromorphic/NeuromorphicDHTNX15.js';
import { NeuromorphicDHTNX17 } from './dht/neuromorphic/NeuromorphicDHTNX17.js';
import { AxonaEngine }         from './dht/neuromorphic/AxonaEngine.js';
import { TransportAxonaEngine } from './dht/neuromorphic/TransportAxonaEngine.js';
import { SimulationEngine }   from './simulation/Engine.js';
import { Controls }           from './ui/Controls.js';
import { Results }            from './ui/Results.js';
import { BenchmarkSweep }    from './ui/BenchmarkSweep.js';
import { setLatencyParams,
         getLatencyParams,
         haversine }          from './utils/geo.js';
import { requestNotifyPermission,
         notifyEnabled,
         notify }             from './utils/notify.js';

// ─────────────────────────────────────────────────────────────────────────────
// Result push — POST CSV + metadata to server so Claude can read it
// ─────────────────────────────────────────────────────────────────────────────

async function pushResult(type, csv, meta = {}) {
  try {
    await fetch('/complete', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type, csv, meta }),
    });
  } catch (e) {
    console.warn('pushResult: server not reachable', e);
  }
}

/** Max nodes to render on the globe.  Above this the globe is cleared.
 *  Uses InstancedMesh for >10k so 25k is performant. */
const GLOBE_NODE_LIMIT = 25_000;

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

let globe    = null;
let dht      = null;
let engine   = null;
const sweep  = new BenchmarkSweep();

// ─────────────────────────────────────────────────────────────────────────────
// Theme management — follows prefers-color-scheme; manual toggle overrides
// ─────────────────────────────────────────────────────────────────────────────

const _themeQuery = window.matchMedia('(prefers-color-scheme: light)');

function applyTheme(isLight) {
  document.body.classList.toggle('light', isLight);
  globe?.setTheme(isLight);
  const btn = document.getElementById('btnThemeToggle');
  if (btn) btn.textContent = isLight ? '\u2600 Light' : '\u263D Dark';
}

// System preference changes (e.g. Claude Preview panel toggle):
// clear any manual override so the app follows the system going forward.
_themeQuery.addEventListener('change', e => {
  localStorage.removeItem('dht-theme');
  applyTheme(e.matches);
});

const controls = new Controls();

// Expose for browser console / Claude debugging.
// `controls` is published so BenchmarkSweep can read the DOM-derived
// structured rule objects (getNX1WRules) when deep-merging per-run
// ablation overrides — without that, partial overrides drop every
// `enabled: true` flag and silently disable rules we didn't intend to
// touch (the v0.70.03 bug that invalidated NX-17 ablation runs).
window.__sim = {
  get globe()    { return globe;    },
  get dht()      { return dht;      },
  get sweep()    { return sweep;    },
  get controls() { return controls; },

  // Build a pub/sub AXON TREE on the current `axona` network and draw it in
  // bright green on the globe (the real kernel role.children delivery tree, not
  // the routing mesh). Usage: select the Axona protocol, Initialize a network,
  // then `await window.__sim.showAxonTree({ subscribers: 2000 })`.
  //
  // View options:
  //   `backbone` (default true) — draw only the axon→sub-axon relay tree (the tree
  //     ITSELF: roots forwarding to sub-axons). false adds the subscriber-leaf
  //     attachments too (~one per sub, ≫ backbone, so the picture gets dense).
  //   `primary`  (default true) — collapse the K-closest root-set redundancy to one
  //     parent per node. false draws the full ~5× overlapping mesh.
  async showAxonTree({ subscribers = 2000, topicName = 'viz', primary = true, backbone = true } = {}) {
    if (!dht || typeof dht.buildAxonTree !== 'function') {
      controls.setStatus('Axon tree needs the `axona` protocol — select Axona + Initialize first.', 'warn');
      return null;
    }
    controls.setStatus(`Building axon tree (subscribing ${subscribers})…`, 'info');
    const { topicBig, subscribed } = await dht.buildAxonTree({
      subscribers,
      onProgress: (n, t) => controls.setStatus(`Subscribing ${n}/${t}…`, 'info'),
    });
    return this._drawAxonTree(topicBig, { primary, backbone }, subscribed);
  },

  // Re-draw the CURRENT topic's tree without re-subscribing — for instantly
  // switching views, e.g. `window.__sim.redrawAxonTree({ backbone:false })` to
  // overlay the subscriber leaves, or `{ primary:false }` for the full mesh.
  redrawAxonTree({ primary = true, backbone = true } = {}) {
    if (!dht || dht._vizTopicBig == null) {
      controls.setStatus('No axon tree built yet — run showAxonTree first.', 'warn');
      return null;
    }
    return this._drawAxonTree(dht._vizTopicBig, { primary, backbone }, null);
  },

  _drawAxonTree(topicBig, { primary, backbone }, subscribed) {
    const { edges, roots, subaxons, depth } = dht.axonTreeEdges(topicBig, { primary, backbone });
    const nodeMap = new Map(dht.getNodes().map(n => [n.id, n]));
    globe.showAxonTree(edges, nodeMap, { roots });
    const subs = subscribed != null ? `${subscribed} subs · ` : '';
    const view = `${backbone ? 'backbone' : 'with-leaves'}${primary ? '' : ' · full-mesh'}`;
    const msg = `Axon tree (${view}): ${subs}${edges.length} edges · ${roots.size} roots · ${subaxons.size} sub-axons · depth ${depth}`;
    controls.setStatus(msg, 'success');
    console.log('[axon-tree] ' + msg);
    return { subscribed, primary, backbone, edges: edges.length, roots: roots.size, subaxons: subaxons.size, depth };
  },
};
const results  = new Results('resultsOverlay');

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  controls.setStatus('Loading world map…', 'info');

  // Apply theme before globe starts rendering (localStorage overrides system pref)
  const _savedTheme = localStorage.getItem('dht-theme');
  const _startLight = _savedTheme ? _savedTheme === 'light' : _themeQuery.matches;
  document.body.classList.toggle('light', _startLight);
  const _tb = document.getElementById('btnThemeToggle');
  if (_tb) _tb.textContent = _startLight ? '\u2600 Light' : '\u263D Dark';

  // Initialise Three.js globe
  const canvas = document.getElementById('globeCanvas');
  globe = new Globe(canvas);

  // Globe always uses light-mode colours — call unconditionally.
  globe.setTheme(_startLight);

  // Load countries (TopoJSON via CDN, converted to GeoJSON by topojson-client)
  try {
    const topoData = await fetch(
      'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json'
    ).then(r => r.json());

    // topojson-client is loaded as a global <script> tag
    const geoJSON = topojson.feature(topoData, topoData.objects.countries);
    await globe.loadCountries(geoJSON);
    globe.setTheme(_startLight);   // re-apply after texture is built
    controls.setStatus('Ready – configure parameters and click Init Network.', 'info');
  } catch (err) {
    console.error('Failed to load world map:', err);
    controls.setStatus('Map load failed; node placement will be random.', 'warn');
  }

  engine = new SimulationEngine();

  // Wire buttons
  document.getElementById('btnInit')?.addEventListener('click', onInit);
  document.getElementById('btnBootstrap')?.addEventListener('click', onBootstrap);
  document.getElementById('btnLookupTest')?.addEventListener('click', onLookupTest);
  document.getElementById('btnAddNodes')?.addEventListener('click', onAddNodes);
  document.getElementById('btnThemeToggle')?.addEventListener('click', () => {
    const isLight = !document.body.classList.contains('light');
    localStorage.setItem('dht-theme', isLight ? 'light' : 'dark');
    applyTheme(isLight);
  });
  document.getElementById('btnSliceWorld')?.addEventListener('click', onSliceWorld);
  document.getElementById('btnChurnTest')?.addEventListener('click', onChurnTest);
  document.getElementById('btnDemoLookup')?.addEventListener('click', onDemoLookup);
  document.getElementById('btnTrainNetwork')?.addEventListener('click', onTrainNetwork);
  document.getElementById('btnPubSub')?.addEventListener('click', onPubSub);
  document.getElementById('btnPairLearning')?.addEventListener('click', onPairLearning);
  document.getElementById('btnHotspotTest')?.addEventListener('click', onHotspotTest);
  document.getElementById('btnBenchmark')?.addEventListener('click', onBenchmark);
  document.getElementById('btnSweepStop')?.addEventListener('click', () => sweep.stop());

  // Notification bell button
  const btnNotify = document.getElementById('btnNotify');
  function _refreshNotifyBtn() {
    if (!btnNotify) return;
    const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
    btnNotify.classList.remove('notify-on', 'notify-off', 'notify-denied');
    if (perm === 'denied') {
      btnNotify.classList.add('notify-denied');
      btnNotify.setAttribute('data-tip', 'Notifications blocked — change in browser settings');
    } else if (perm !== 'granted') {
      btnNotify.classList.add('notify-off');
      btnNotify.setAttribute('data-tip', 'Click to enable desktop notifications when tests complete');
    } else {
      btnNotify.classList.add('notify-on');
      btnNotify.setAttribute('data-tip', 'Notifications enabled — click to send a test notification');
    }
  }
  btnNotify?.addEventListener('click', async () => {
    if (notifyEnabled()) {
      notify('DHT Globe', 'Notifications are working ✓');
    } else {
      const granted = await requestNotifyPermission();
      if (granted) notify('DHT Globe', 'Notifications enabled — you will be alerted when tests complete ✓');
    }
    _refreshNotifyBtn();
  });
  _refreshNotifyBtn();

  // Auto-rotate toggle
  document.getElementById('autoRotate')?.addEventListener('change', e => {
    globe?.setAutoRotate(e.target.checked);
  });

  // Fullscreen button — fullscreens the whole page so the sidebar stays visible
  const fsBtn = document.getElementById('globeFullscreenBtn');
  fsBtn?.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  });
  document.addEventListener('fullscreenchange', () => {
    if (fsBtn) fsBtn.textContent = document.fullscreenElement ? '✕' : '⛶';
  });

  // Node click → show routing table connections
  canvas.addEventListener('nodeclicked', (e) => {
    const { nodeId } = e.detail;
    if (nodeId === null || !dht) {
      globe.clearConnections();
      controls.setStatus('Selection cleared.', 'info');
      return;
    }
    // Get routing table entries from the clicked node
    const node = dht.nodeMap?.get(nodeId);
    if (!node || typeof node.getRoutingTableEntries !== 'function') return;

    const entries = node.getRoutingTableEntries();
    const nodeMap = new Map(dht.getNodes().map(n => [n.id, n]));
    globe.clearArcs();
    globe.showNodeConnections(nodeId, nodeMap, entries.map(n => n.id));

    const hex = nodeId.toString(16).padStart(16, '0').toUpperCase();
    controls.setStatus(
      `Node 0x${hex} — ${entries.length} routing-table contacts. Click elsewhere to deselect.`,
      'info'
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Network Initialisation
// ─────────────────────────────────────────────────────────────────────────────

async function onInit() {
  trainingActive = false;
  controls.setTraining(false);
  pubsubActive = false;
  setAppState('init');
  controls.setPubSub(false);
  pairActive = false;
  controls.setPairLearning(false);
  hotspotActive = false;
  controls.setHotspotTesting(false);
  controls.setRunning(true);
  controls.setProgress(0);
  results.clear();
  results.clearTraining();
  results.clearPubSub();
  results.clearPairLearning(); results.clearMembershipSim();
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();

  const params = controls.snapshot();
  controls.setStatus(`Building ${params.nodeCount}-node ${params.protocol} network…`, 'info');

  // Apply latency parameters before building the network
  const { maxPropagation } = getLatencyParams();
  setLatencyParams(maxPropagation, params.nodeDelay);

  // Dispose the previous DHT before allocating the new one.
  // With large node counts the old network can hold hundreds of MB; releasing
  // it explicitly (and yielding so the GC can reclaim it) prevents OOM during
  // the double-allocation window that would otherwise occur.
  if (dht) {
    dht.dispose();
    dht = null;
    await yieldUI();  // let GC run before the new allocation
  }

  // Instantiate the selected DHT protocol
  dht = createDHT(params);

  // Generate nodes on land
  const nodes = [];
  for (let i = 0; i < params.nodeCount; i++) {
    const { lat, lng } = globe.randomLandPoint();
    const node = await dht.addNode(lat, lng);
    nodes.push(node);

    if ((i + 1) % 50 === 0) {
      controls.setProgress((i + 1) / params.nodeCount * 0.7);
      await yieldUI();
    }
  }

  controls.setStatus('Building routing tables…', 'info');
  controls.setProgress(0.8);
  await yieldUI();

  dht.buildRoutingTables({
    bidirectional:  params.bidirectional,
    maxConnections: params.webLimit ? (params.maxConnections ?? 100) : Infinity,
    highwayPct:     params.highwayPct ?? 0,
  });

  // Bilateral-cap invariant check. No-op when web limit is off (cap=Infinity).
  // Logs to console for visibility; surfaces violations as console.error so
  // they're impossible to miss when iterating on a new protocol.
  dht.verifyConnectionCap?.('post-init');

  controls.setProgress(1);
  await yieldUI();  // let GC settle after routing table build before globe work

  // Skip WebGL globe rendering for very large networks.
  // Uses InstancedMesh for >10k nodes; hidden above GLOBE_NODE_LIMIT.
  if (nodes.length <= GLOBE_NODE_LIMIT) {
    globe.setNodes(dht.getNodes());
  } else {
    globe.setNodes([]);  // clear any leftover nodes from a previous smaller run
  }
  globe.clearSliceMode?.();   // v0.68.01: leaving Slice World palette on a fresh init
  controls.setStatus(
    `Network ready: ${nodes.length} nodes, ${params.protocol} ` +
    `(k=${params.k}, α=${params.alpha}, ${params.bits}-bit IDs)` +
    (nodes.length > GLOBE_NODE_LIMIT ? ' — globe hidden for large network' : ''),
    'success'
  );
  controls.updateNodeCount(nodes.length);
  controls.setRunning(false);
  setAppState('idle');
  controls.setProgress(0);
  sweep.notifyInitComplete();
}

// ─────────────────────────────────────────────────────────────────────────────
// Slice World — East/West hemisphere partition with Hawaii bridge
// ─────────────────────────────────────────────────────────────────────────────
// Partition logic moved to src/dht/sliceWorld.js (v0.67.03) so the
// simulation engine can reuse it as a benchmark test type.

async function onSliceWorld() {
  trainingActive = false;
  controls.setTraining(false);
  pubsubActive = false;
  setAppState('idle');
  controls.setPubSub(false);
  pairActive = false;
  controls.setPairLearning(false);
  hotspotActive = false;
  controls.setHotspotTesting(false);
  controls.setRunning(true);
  controls.setProgress(0);
  results.clear();
  results.clearTraining();
  results.clearPubSub();
  results.clearPairLearning(); results.clearMembershipSim();
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();

  const params = controls.snapshot();
  controls.setStatus(`Building Slice World: ${params.nodeCount}-node ${params.protocol} network…`, 'info');

  const { maxPropagation } = getLatencyParams();
  setLatencyParams(maxPropagation, params.nodeDelay);

  if (dht) {
    dht.dispose();
    dht = null;
    await yieldUI();
  }

  dht = createDHT(params);

  // ── Place Hawaii node first (the sole bridge) ──────────────────────────────
  const hawaiiNode = await dht.addNode(19.82, -155.47);
  const hawaiiId   = hawaiiNode.id;

  // ── Generate remaining nodes on land ───────────────────────────────────────
  const nodes = [hawaiiNode];
  for (let i = 1; i < params.nodeCount; i++) {
    const { lat, lng } = globe.randomLandPoint();
    const node = await dht.addNode(lat, lng);
    nodes.push(node);

    if ((i + 1) % 50 === 0) {
      controls.setProgress((i + 1) / params.nodeCount * 0.6);
      await yieldUI();
    }
  }

  controls.setStatus('Building routing tables…', 'info');
  controls.setProgress(0.7);
  await yieldUI();

  // ── Build full routing tables, then prune cross-hemisphere links ───────────
  dht.buildRoutingTables({
    bidirectional:  params.bidirectional,
    maxConnections: params.webLimit ? (params.maxConnections ?? 100) : Infinity,
    highwayPct:     params.highwayPct ?? 0,
  });
  dht.verifyConnectionCap?.('post-init-slice-world');

  controls.setStatus('Pruning cross-hemisphere connections (Hawaii bridge only)…', 'info');
  controls.setProgress(0.85);
  await yieldUI();

  applySliceWorldPartition(dht, hawaiiId);

  controls.setProgress(1);
  await yieldUI();

  // ── Count hemisphere stats ─────────────────────────────────────────────────
  let westCount = 0, eastCount = 0;
  for (const n of nodes) {
    if (n.lng < 0) westCount++; else eastCount++;
  }

  if (nodes.length <= GLOBE_NODE_LIMIT) {
    globe.setNodes(dht.getNodes());
    // v0.68.03 — Slice World coloring: yellow = West, white = East,
    // green = node has at least one NON-BRIDGE peer in the opposite
    // hemisphere. Initially only Hawaii itself meets this; merely
    // *knowing* Hawaii doesn't make a non-bridge node a bridge.
    // Refreshed periodically in onLookupTest as learning re-stitches
    // the partition with new direct cross-hem synapses.
    globe.setSliceWorldColors(dht, hawaiiId);
  } else {
    globe.setNodes([]);
  }

  controls.setStatus(
    `Slice World ready: ${nodes.length} nodes (${westCount} West, ${eastCount} East), ` +
    `Hawaii bridge, ${params.protocol}. Yellow = West, white = East, green tint = ` +
    `non-bridge cross-hem peers (intensity scales with count; partition dissolves as routing learns).`,
    'success'
  );
  controls.updateNodeCount(nodes.length);
  controls.setRunning(false);
  setAppState('idle');
  controls.setProgress(0);
  sweep.notifyInitComplete();
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap Network — build incrementally via sponsor-based join
// ─────────────────────────────────────────────────────────────────────────────

async function onBootstrap() {
  trainingActive = false;
  controls.setTraining(false);
  pubsubActive = false;
  setAppState('idle');
  controls.setPubSub(false);
  pairActive = false;
  controls.setPairLearning(false);
  hotspotActive = false;
  controls.setHotspotTesting(false);
  controls.setRunning(true);
  controls.setProgress(0);
  results.clear();
  results.clearTraining();
  results.clearPubSub();
  results.clearPairLearning(); results.clearMembershipSim();
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();

  const params = controls.snapshot();
  controls.setStatus(
    `Bootstrapping ${params.nodeCount}-node ${params.protocol} network…`, 'info'
  );

  const { maxPropagation } = getLatencyParams();
  setLatencyParams(maxPropagation, params.nodeDelay);

  // Dispose previous DHT
  if (dht) {
    dht.dispose();
    dht = null;
    await yieldUI();
  }

  dht = createDHT(params);

  // Physical-connection caps. Each node decides its own capacity at join
  // time so bootstrapJoin sees the correct cap from the first call:
  //   - webLimit on  → cap set by params.maxConnections (default 100)
  //   - webLimit off → unrestricted
  //   - highwayPct % of nodes randomly promoted to unrestricted (server-class)
  const baseCap    = params.webLimit ? (params.maxConnections ?? 100) : Infinity;
  const highwayPct = params.highwayPct ?? 0;
  dht.maxConnections = baseCap;
  dht.bidirectional  = params.bidirectional;
  dht.highwayPct     = highwayPct;

  // Build incrementally: first node has no peers, each subsequent node
  // joins through the live network via a sponsor.
  const nodes = [];
  for (let i = 0; i < params.nodeCount; i++) {
    const { lat, lng } = globe.randomLandPoint();
    const node = await dht.addNode(lat, lng);
    // Per-node capacity decision.
    const isHighway = (Math.random() * 100) < highwayPct;
    node.maxConnections = isHighway ? Infinity : baseCap;
    node.isHighway      = isHighway;
    nodes.push(node);

    // Every node after the first joins via sponsor
    if (i > 0) {
      const sponsor = findSponsor(dht, node);
      if (sponsor && dht.bootstrapJoin) {
        dht.bootstrapJoin(node.id, sponsor.id);
      }
    }

    if ((i + 1) % 50 === 0) {
      controls.setProgress((i + 1) / params.nodeCount * 0.8);
      await yieldUI();
    }
  }

  // Refresh phase — early joiners have sparse tables because few peers existed
  // when they joined.  A single self-lookup per node (as real Kademlia does
  // periodically) lets every node discover the full set of peers now available.
  controls.setStatus('Refreshing routing tables…', 'info');
  controls.setProgress(0.85);
  await yieldUI();

  if (dht.bootstrapJoin) {
    const allIds = [...dht.nodeMap.keys()];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      // Pick a random existing node as refresh sponsor (not self)
      let sponsorId = node.id;
      while (sponsorId === node.id) {
        sponsorId = allIds[Math.floor(Math.random() * allIds.length)];
      }
      dht.bootstrapJoin(node.id, sponsorId);

      if ((i + 1) % 100 === 0) {
        controls.setProgress(0.85 + (i + 1) / nodes.length * 0.15);
        await yieldUI();
      }
    }
  }

  controls.setProgress(1);
  await yieldUI();

  if (nodes.length <= GLOBE_NODE_LIMIT) {
    globe.setNodes(dht.getNodes());
  } else {
    globe.setNodes([]);
  }
  globe.clearSliceMode?.();   // v0.68.01: leaving Slice World palette
  controls.setStatus(
    `Network bootstrapped: ${nodes.length} nodes, ${params.protocol} ` +
    `(k=${params.k}, α=${params.alpha}, ${params.bits}-bit IDs)` +
    (nodes.length > GLOBE_NODE_LIMIT ? ' — globe hidden for large network' : ''),
    'success'
  );
  controls.updateNodeCount(nodes.length);
  controls.setRunning(false);
  setAppState('idle');
  controls.setProgress(0);
  sweep.notifyInitComplete();
}

// ─────────────────────────────────────────────────────────────────────────────
// Add Nodes — organic join via sponsor
// ─────────────────────────────────────────────────────────────────────────────

/** Find the existing alive node with the smallest XOR distance to newNode. */
function findSponsor(dht, newNode) {
  if (!dht.nodeMap) return null;
  let best = null, bestDist = null;
  for (const [id, node] of dht.nodeMap) {
    if (id === newNode.id || !node.alive) continue;
    const dist = newNode.id ^ id;
    if (bestDist === null || dist < bestDist) { best = node; bestDist = dist; }
  }
  return best;
}

async function onAddNodes() {
  if (!dht) {
    controls.setStatus('Initialise the network first.', 'warn');
    return;
  }
  controls.setRunning(true);
  controls.setProgress(0);

  const params   = controls.snapshot();
  const count    = params.addNodeCount;
  const warmup   = params.addNodeWarmup;
  const newNodes = [];

  controls.setStatus(
    `Adding ${count} node${count > 1 ? 's' : ''} via organic join…`, 'info'
  );

  // Phase 1 — create and sponsor-join each node
  for (let i = 0; i < count; i++) {
    const { lat, lng } = globe.randomLandPoint();
    const newNode = await dht.addNode(lat, lng);
    newNodes.push(newNode);

    const sponsor = findSponsor(dht, newNode);
    if (sponsor && dht.bootstrapJoin) {
      dht.bootstrapJoin(newNode.id, sponsor.id);
    }

    controls.setProgress((i + 1) / count * (warmup > 0 ? 0.4 : 1.0));
    if ((i + 1) % 10 === 0) await yieldUI();
  }

  // Phase 2 — warmup lookups from each new node to integrate via LTP / annealing
  if (warmup > 0 && newNodes.length > 0) {
    const allIds = dht.nodeMap
      ? [...dht.nodeMap.keys()]
      : dht.getNodes().map(n => n.id);
    let done = 0;
    const totalWarmup = newNodes.length * warmup;
    for (const newNode of newNodes) {
      for (let w = 0; w < warmup; w++) {
        const targetId = allIds[Math.floor(Math.random() * allIds.length)];
        if (targetId !== newNode.id) await dht.lookup(newNode.id, targetId);
        controls.setProgress(0.4 + (++done / totalWarmup) * 0.6);
        if (done % 25 === 0) await yieldUI();
      }
    }
  }

  const allNodes = dht.getNodes();
  const total = dht.nodeMap?.size ?? allNodes.length;
  if (total <= GLOBE_NODE_LIMIT) {
    globe.setNodes(allNodes);
  } else {
    globe.setNodes([]);
  }
  controls.updateNodeCount(total);
  controls.setStatus(
    `Added ${count} node${count > 1 ? 's' : ''} — network now has ${total} active nodes.`,
    'success'
  );
  controls.setRunning(false);
  controls.setProgress(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookup Test
// ─────────────────────────────────────────────────────────────────────────────

async function onLookupTest() {
  if (!dht) {
    controls.setStatus('Initialise the network first.', 'warn');
    return;
  }
  controls.setRunning(true);
  controls.setProgress(0);
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();

  const params = controls.snapshot();
  results.setRunParams(params);
  controls.setStatus(`Running ${params.msgCount} random lookups…`, 'info');

  // Draw regional boundary ring so the user can see the constraint is active
  if (params.regional) {
    const nodes = dht.getNodes().filter(n => n.alive);
    if (nodes.length) {
      const src = nodes[Math.floor(Math.random() * nodes.length)];
      globe.drawRegionalBoundary(src.lat, src.lng, params.regionalRadius);
    }
  }

  engine.onProgress = (frac, partial) => {
    controls.setProgress(frac);
    if (partial?.hops?.mean != null) {
      controls.setStatus(
        `Progress ${(frac * 100).toFixed(0)}% — ` +
        `avg hops: ${partial.hops.mean.toFixed(2)}, ` +
        `avg time: ${partial.time.mean.toFixed(1)} ms`,
        'info'
      );
    }
    // v0.68.01 — Slice World live recolor. As routing progresses, learning
    // rules (hop caching, triadic closure, lateral spread) deposit new
    // cross-hem synapses on path-touched nodes; those nodes turn green.
    // Visualizes the partition dissolving in real time.
    if (globe.isSliceMode?.() && dht) {
      globe.setSliceWorldColors(dht);
    }
  };

  engine.onPathFound = (path, d) => {
    const nodeMap = new Map(d.getNodes().map(n => [n.id, n]));
    globe.showPath(path, nodeMap);
  };

  const result = await engine.runLookupTest(dht, {
    numMessages:    params.msgCount,
    captureLastPath: true,
    regional:       params.regional,
    regionalRadius: params.regionalRadius,
    hotPct:         params.hotPct,
    sourcePct:      params.sourceMode ? params.sourcePct : 0,
    destPct:        params.destMode   ? params.destPct   : 0,
  });

  results.showLookupResults(result);
  const _ltStatus = `Done. Avg hops: ${result.hops?.mean.toFixed(2)}, ` +
    `avg time: ${result.time?.mean.toFixed(1)} ms, ` +
    `success: ${(result.successRate * 100).toFixed(1)}%`;
  controls.setStatus(_ltStatus, 'success');
  notify('Lookup Test complete', _ltStatus);
  await pushResult('lookup', results.getLookupCSV(), { avgHops: result.hops?.mean, avgMs: result.time?.mean, successRate: result.successRate });
  controls.setRunning(false);
  controls.setProgress(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Demo (looping animated lookup — toggle start / stop)
// ─────────────────────────────────────────────────────────────────────────────

let _demoRunning = false;

async function onDemoLookup() {
  // Second click → stop the loop
  if (_demoRunning) {
    _demoRunning = false;
    return;
  }

  if (!dht) {
    controls.setStatus('Initialise the network first.', 'warn');
    return;
  }

  _demoRunning = true;
  controls.setDemo(true);

  const { randomU64 } = await import('./utils/geo.js');

  while (_demoRunning) {
    globe.clearArcs();
    globe.clearConnections();
    globe.clearRegionalBoundary();

    const nodes = dht.getNodes().filter(n => n.alive);
    if (nodes.length < 2) {
      controls.setStatus('Not enough nodes for a demo lookup.', 'warn');
      break;
    }
    const params = controls.snapshot();

    // ── Select sender ────────────────────────────────────────────────────────
    // In regional mode, only consider senders that have at least one other
    // live node within the radius — guarantees nearby is never empty.
    let source, nearby = [];
    if (params.regional) {
      const eligible = nodes.filter(n =>
        nodes.some(m => m.id !== n.id &&
          haversine(n.lat, n.lng, m.lat, m.lng) <= params.regionalRadius)
      );
      if (!eligible.length) {
        controls.setStatus(
          `No node pairs within ${params.regionalRadius} km — try a larger radius or more nodes.`, 'warn'
        );
        break;
      }
      source = eligible[Math.floor(Math.random() * eligible.length)];
      nearby = nodes.filter(n =>
        n.id !== source.id &&
        haversine(source.lat, source.lng, n.lat, n.lng) <= params.regionalRadius
      );
      globe.drawRegionalBoundary(source.lat, source.lng, params.regionalRadius);
    } else {
      source = nodes[Math.floor(Math.random() * nodes.length)];
    }

    controls.setStatus(
      `Demo lookup from node 0x${source.id.toString(16).padStart(16,'0').toUpperCase().slice(0,8)}` +
      `${params.regional ? ` (regional ≤${params.regionalRadius} km)` : ''}…`,
      'info'
    );

    // ── Run lookup ───────────────────────────────────────────────────────────
    const nodeMap = new Map(dht.getNodes().map(n => [n.id, n]));
    let result = null;

    if (params.regional) {
      const receiver = nearby[Math.floor(Math.random() * nearby.length)];
      result = await dht.lookup(source.id, receiver.id);
    } else {
      // Pick a random live node as the target (not the source).
      // Using a real node ID ensures the lookup has a meaningful destination
      // and the path animation terminates at an actual node on the globe.
      let target = source;
      while (target.id === source.id) {
        target = nodes[Math.floor(Math.random() * nodes.length)];
      }
      result = await dht.lookup(source.id, target.id);
    }

    if (!_demoRunning) break;

    // Sanity-check: destination should be within the regional ring.
    if (params.regional && result?.path?.length > 1) {
      const destNode = nodeMap.get(result.path.at(-1));
      if (!destNode ||
          haversine(source.lat, source.lng, destNode.lat, destNode.lng) > params.regionalRadius) {
        controls.setStatus(
          'Regional path ended outside the ring — no nearby nodes reachable. Try more nodes or a larger radius.',
          'warn'
        );
        break;
      }
    }

    if (result?.path?.length > 1) {
      controls.setStatus(
        `Demo: ${result.hops} hops, ${result.time.toFixed(1)} ms — animating…`,
        'info'
      );
      await globe.animatePath(result.path, nodeMap, 800);
      if (!_demoRunning) break;
      results.showDemoResults(result);
      controls.setStatus(
        `Demo: ${result.hops} hops, ${result.time.toFixed(1)} ms — next in 1 s…`,
        'success'
      );
    } else {
      controls.setStatus('Demo: lookup returned no path — retrying…', 'warn');
    }

    // 1-second pause before next demo
    await new Promise(r => setTimeout(r, 1000));
  }

  _demoRunning = false;
  controls.setDemo(false);
  globe.clearArcs();
  globe.clearRegionalBoundary();
  controls.setStatus('Demo stopped.', 'info');
}

// ─────────────────────────────────────────────────────────────────────────────
// Churn Test
// ─────────────────────────────────────────────────────────────────────────────

async function onChurnTest() {
  if (!dht) {
    controls.setStatus('Initialise the network first.', 'warn');
    return;
  }
  controls.setRunning(true);
  controls.setProgress(0);
  globe.clearArcs();
  globe.clearConnections();

  const params = controls.snapshot();
  results.setRunParams(params);
  controls.setStatus(
    `Churn test: ${params.churnIntervals} intervals, ` +
    `${(params.churnRate * 100).toFixed(0)}% churn/interval, ` +
    `${params.lookupsPerInterval} lookups/interval…`,
    'info'
  );

  engine.onProgress = (frac, data) => {
    controls.setProgress(frac);
    if (data?.timeSeries) {
      results.updateChurnProgress(data.timeSeries);
      const last = data.timeSeries[data.timeSeries.length - 1];
      if (last) {
        controls.setStatus(
          `Interval ${last.interval + 1}/${params.churnIntervals} — ` +
          `avg hops: ${last.hops?.mean?.toFixed(2) ?? '—'}, ` +
          `success: ${(last.successRate * 100).toFixed(1)}%`,
          'info'
        );
      }
    }
    // Refresh node colours after churn
    globe.setNodes(dht.getNodes());
  };

  const result = await engine.runChurnTest(dht, {
    churnRate: params.churnRate,
    intervals: params.churnIntervals,
    lookupsPerInterval: params.lookupsPerInterval,
    landFn: (lat, lng) => globe.isLand(lat, lng),
  });

  results.showChurnResults(result);
  globe.setNodes(dht.getNodes());
  controls.updateNodeCount(dht.nodeMap?.size ?? dht.getNodes().length);
  controls.setStatus('Churn test complete.', 'success');
  notify('Churn Test complete', `${params.churnIntervals} intervals · ${(params.churnRate * 100).toFixed(0)}% churn/interval`);
  await pushResult('churn', results.getChurnCSV(), { intervals: params.churnIntervals, churnRate: params.churnRate });
  controls.setRunning(false);
  controls.setProgress(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Train Network (Neuromorphic only)
// ─────────────────────────────────────────────────────────────────────────────

let trainingActive  = false;
let trainingHistory = [];
let trainingEpoch   = 0;   // cumulative lookups processed across all sessions
let pubsubActive = false;
let pairActive = false;
let hotspotActive = false;

async function onTrainNetwork() {
  if (trainingActive) {
    // Toggle off: stop training loop
    trainingActive = false;
    return;
  }

  if (pubsubActive) return;
  if (pairActive) return;

  if (!dht) {
    controls.setStatus('Initialise the network first.', 'warn');
    return;
  }

  trainingActive  = true;
  setAppState('training');
  trainingHistory = [];
  trainingEpoch   = 0;
  results.clearTraining();
  results.clearHotspot();
  controls.setTraining(true);
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();

  const params = controls.snapshot();
  results.setRunParams(params);

  // Draw regional boundary ring once so user can see the constraint is active
  if (params.regional) {
    const nodes = dht.getNodes().filter(n => n.alive);
    if (nodes.length) {
      const src = nodes[Math.floor(Math.random() * nodes.length)];
      globe.drawRegionalBoundary(src.lat, src.lng, params.regionalRadius);
    }
  }

  // ── Session 0: baseline measurement (pre-training state) ──────────────
  // v0.70.00 — reset traffic counters before the baseline so the snapshot
  // taken after this session reflects exactly the baseline workload (any
  // bootstrap / build-routing-table traffic that ran before training is
  // discarded).
  engine.snapshotTrafficLoad(dht, { topK: 0, reset: true });

  controls.setStatus('Running baseline measurement (session 0)…', 'info');
  const baseResult = await engine.runLookupTest(dht, {
    numMessages:     params.msgCount,
    captureLastPath: false,
    regional:        params.regional,
    regionalRadius:  params.regionalRadius,
    hotPct:          params.hotPct,
    sourcePct:       params.sourceMode ? params.sourcePct : 0,
    destPct:         params.destMode   ? params.destPct   : 0,
  });
  if (trainingActive) {
    const baseNodes = dht.getNodes().filter(n => n.alive);
    const baseAvgSyn = baseNodes.length > 0 && typeof baseNodes[0].synaptome !== 'undefined'
      ? baseNodes.reduce((s, n) => s + n.synaptome.size, 0) / baseNodes.length
      : null;

    // v0.70.00 — capture baseline-cycle traffic distribution
    const baseTraffic = engine.snapshotTrafficLoad(dht, { topK: 10 });

    trainingHistory.push({
      session: 0,
      epoch:       0,
      avgSynapses: baseAvgSyn,
      successRate: baseResult.successRate,
      hops:        baseResult.hops,
      time:        baseResult.time,
      traffic:     baseTraffic,
      isBaseline:  true,
    });
    results.showTrainingResults(trainingHistory);
    await yieldUI();
  }

  // v0.70.02 — sweep-mode session cap. When the sweep harness drives
  // training (run.mode === 'training', run.maxSessions = N), it sets
  // window.__sim._trainingMaxSessions before clicking Train. The loop
  // exits cleanly after N completed sessions (excluding baseline) so
  // the harness can advance to the next run without user intervention.
  const maxSessions = (typeof window !== 'undefined'
    && window.__sim
    && Number.isFinite(window.__sim._trainingMaxSessions))
    ? window.__sim._trainingMaxSessions
    : Infinity;

  while (trainingActive) {
    const session = trainingHistory.length; // 1-based after baseline
    controls.setStatus(`Training session ${session}…`, 'info');

    // v0.70.04 — sweep-driven per-cycle churn. When window.__sim._trainingChurnPct
    // is set, replace that % of live nodes (kill + bootstrap-join + heal) before
    // each training cycle's lookup test. Skipped on session 1 so the baseline
    // is the pre-churn steady state. Lets the harness drive sustained-churn
    // load-distribution tests through the same training infrastructure.
    const churnPct = (typeof window !== 'undefined'
      && window.__sim
      && Number.isFinite(window.__sim._trainingChurnPct))
      ? window.__sim._trainingChurnPct : 0;
    if (churnPct > 0 && session > 1) {
      controls.setStatus(`Training session ${session}: applying ${churnPct}% churn…`, 'info');
      await engine.applyChurnRound(dht, churnPct);
      // Reset traffic counters so the bootstrap/heal traffic from churn
      // isn't attributed to this cycle's routing.
      engine.snapshotTrafficLoad(dht, { topK: 0, reset: true });
    }

    const result = await engine.runLookupTest(dht, {
      numMessages:     params.msgCount,
      captureLastPath: false,
      regional:        params.regional,
      regionalRadius:  params.regionalRadius,
      hotPct:          params.hotPct,
      sourcePct:       params.sourceMode ? params.sourcePct : 0,
      destPct:         params.destMode   ? params.destPct   : 0,
    });

    if (!trainingActive) break;   // stopped during the run

    // v0.68.06 — live recolor in Slice World mode. Each session of training
    // runs ~msgCount lookups; for neuromorphic protocols, those lookups
    // deposit cross-hem synapses (hop caching, triadic closure, lateral
    // spread) that should turn nodes green. For Kademlia / G-DHT the
    // count should stay at 1 (Hawaii) forever — no learning to deposit
    // anything. Either way, refreshing here makes the dynamic visible.
    if (globe.isSliceMode?.()) {
      globe.setSliceWorldColors(dht);
    }

    trainingEpoch += params.msgCount;

    // Compute avg synapses per node (Neuromorphic only)
    let avgSynapses = null;
    const nodes = dht.getNodes().filter(n => n.alive);
    if (nodes.length > 0 && typeof nodes[0].synaptome !== 'undefined') {
      avgSynapses = nodes.reduce((s, n) => s + n.synaptome.size, 0) / nodes.length;
    }

    // v0.70.00 — per-cycle traffic-load snapshot (and counter reset).
    // This is the raw delta of messages every node sent + received in
    // the just-completed training session. Used to test the hypothesis
    // that the system is concentrating load on a small minority of
    // nodes (success-disaster / hot-axon-root / over-promoted highway).
    // Captured before we yield, so the snapshot reflects exactly the
    // session we just measured.
    const traffic = engine.snapshotTrafficLoad(dht, { topK: 10 });

    trainingHistory.push({
      session,
      epoch:       trainingEpoch,
      avgSynapses,
      successRate: result.successRate,
      hops:        result.hops,
      time:        result.time,
      traffic,                       // { summary, topN, distribution }
    });

    results.updateTrainingProgress(trainingHistory);

    controls.setStatus(
      `Session ${session} — hops: ${result.hops?.mean.toFixed(2) ?? '—'}, ` +
      `time: ${result.time?.mean.toFixed(1) ?? '—'} ms, ` +
      `success: ${(result.successRate * 100).toFixed(1)}%`,
      'info'
    );

    await yieldUI();

    // v0.70.02 — sweep-mode auto-stop. Count non-baseline completed
    // sessions and break out cleanly once we hit the requested cap.
    const completed = trainingHistory.filter(s => !s.isBaseline).length;
    if (completed >= maxSessions) {
      trainingActive = false;
      break;
    }
  }

  trainingActive = false;
  setAppState('idle');
  controls.setTraining(false);
  const trainedSessions = trainingHistory.filter(s => !s.isBaseline).length;
  const _trainMsg = `Training stopped after ${trainedSessions} session(s).`;
  controls.setStatus(_trainMsg, 'success');
  notify('Train Network complete', _trainMsg);
  await pushResult('training', results.getTrainingCSV(), { sessions: trainedSessions });

  // v0.70.02 — notify sweep harness so it can advance to the next run.
  // Mirrors the benchmark-side notifyBenchmarkComplete handshake.
  if (typeof window !== 'undefined' && window.__sim?.sweep?.notifyTrainingComplete) {
    window.__sim.sweep.notifyTrainingComplete();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pub/Sub — multi-group overlay network test
// ─────────────────────────────────────────────────────────────────────────────

async function onPubSub() {
  if (pubsubActive) {
    pubsubActive = false;
    return;
  }

  if (trainingActive || pairActive || hotspotActive || !dht) {
    if (!dht) controls.setStatus('Initialise the network first.', 'warn');
    return;
  }

  // Route to the live Membership simulation when the active protocol has
  // the AxonaManager-based membership transport (NX-15 and descendants).
  // Older neuromorphic protocols (NX-6/9/10/13) still run the original
  // one-shot inherited pubsubBroadcast below.
  if (typeof dht.axonFor === 'function') {
    return onMembershipPubSub();
  }

  const params     = controls.snapshot();
  results.setRunParams(params);
  const aliveNodes = dht.getNodes().filter(n => n.alive);
  const groupSize  = params.pubsubGroupSize;

  if (aliveNodes.length < groupSize + 1) {
    controls.setStatus(`Need at least ${groupSize + 1} nodes for Pub/Sub. Init a larger network.`, 'warn');
    return;
  }

  // ── Build pub/sub groups ──────────────────────────────────────────────────
  // Target: pubsubCoverage% of nodes in ≥1 group.
  // In regional mode, participants in each group are drawn only from nodes
  // within regionalRadius km of that group's relay.
  const targetNodes = Math.ceil(aliveNodes.length * params.pubsubCoverage / 100);
  const numGroups   = Math.max(1, Math.ceil(targetNodes / groupSize));
  const shuffled    = [...aliveNodes].sort(() => Math.random() - 0.5);
  const stride      = Math.max(1, Math.floor(shuffled.length / numGroups));

  if (params.regional) {
    // Verify at least one node has enough regional neighbours to form a group
    const minNeeded = Math.min(groupSize, 2);
    const hasRegion = aliveNodes.some(n =>
      aliveNodes.filter(m => m.id !== n.id &&
        haversine(n.lat, n.lng, m.lat, m.lng) <= params.regionalRadius).length >= minNeeded
    );
    if (!hasRegion) {
      controls.setStatus(
        `No node has ${minNeeded}+ neighbours within ${params.regionalRadius} km — try a larger radius or more nodes.`, 'warn'
      );
      return;
    }
  }

  const groups = [];
  for (let i = 0; i < numGroups; i++) {
    const base  = (i * stride) % shuffled.length;
    const relay = shuffled[base];

    let pool;
    if (params.regional) {
      // Participants must be within regionalRadius km of the relay
      pool = aliveNodes.filter(n =>
        n.id !== relay.id &&
        haversine(relay.lat, relay.lng, n.lat, n.lng) <= params.regionalRadius
      );
    } else {
      // Global mode: stride through the full shuffled array
      pool = [];
      for (let j = 1; j <= groupSize; j++) {
        pool.push(shuffled[(base + j) % shuffled.length]);
      }
    }

    // Shuffle the pool and take up to groupSize participants
    pool = pool.sort(() => Math.random() - 0.5).slice(0, groupSize);
    if (!pool.length) continue;   // no neighbours in range — skip this relay

    groups.push({ id: i, relay, participants: pool });
  }

  if (!groups.length) {
    controls.setStatus(
      `Could not form any groups within ${params.regionalRadius} km — try a larger radius.`, 'warn'
    );
    return;
  }

  // Actual coverage (unique nodes across all groups)
  const covered = new Set();
  for (const g of groups) {
    covered.add(g.relay.id);
    for (const p of g.participants) covered.add(p.id);
  }
  const actualCoverage = ((covered.size / aliveNodes.length) * 100).toFixed(1);

  pubsubActive = true;
  setAppState('pubsub');
  controls.setPubSub(true);
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();

  // Pan the globe to the first relay; ring only shown in regional mode
  const ringRadius = params.regional ? params.regionalRadius : 0;
  if (params.regional) {
    globe.drawRegionalBoundary(groups[0].relay.lat, groups[0].relay.lng, ringRadius);
  }
  globe.panToLatLng(groups[0].relay.lat, groups[0].relay.lng);

  const history = [];
  let tick = 0;

  results.clearPubSub();
  controls.setStatus(
    `Pub/Sub: ${groups.length} groups · ${actualCoverage}% coverage · ${aliveNodes.length} nodes` +
    (params.regional ? ` · regional ≤${params.regionalRadius} km` : ''),
    'info'
  );

  while (pubsubActive) {
    tick++;
    const result = await engine.runPubSubSession(dht, groups);

    if (!pubsubActive) break;
    if (!result) continue;

    // Move the globe ring (regional only), pan the camera, and highlight relay + participants
    if (result.lastRelayNode) {
      const { lat, lng } = result.lastRelayNode;
      if (params.regional) {
        globe.drawRegionalBoundary(lat, lng, ringRadius);
      }
      globe.panToLatLng(lat, lng);
      const participantIds = result.lastParticipantNodes
        ? result.lastParticipantNodes.map(n => n.id)
        : [];
      globe.highlightPubSubGroup(result.lastRelayNode.id, participantIds);
    }

    history.push({
      tick,
      groups:    numGroups,
      coverage:  actualCoverage,
      msgHops:   result.relayHops,
      bcastAvg:  result.bcastHops,
      totalHops: result.relayHops + result.bcastHops,
      relayMs:   result.relayMs,
      bcastMs:   result.bcastMs,
      maxFanout:      result.maxFanout,
      treeDepth:      result.treeDepth,
      avgSubsPerNode: result.avgSubsPerNode,
    });

    results.showPubSubResults(history, numGroups, actualCoverage);

    controls.setStatus(
      `Pub/Sub session #${tick} — relay: ${result.relayHops.toFixed(1)} hops · bcast avg: ` +
      `${result.bcastHops.toFixed(1)} hops · relay ${result.relayMs} ms · bcast ${result.bcastMs} ms` +
      ` (${result.messagesPerSession} msgs/session)`,
      'info'
    );

    await yieldUI();
  }

  pubsubActive = false;
  setAppState('idle');
  controls.setPubSub(false);
  globe.clearPubSubHighlights();
  const _psMsg = `Pub/Sub stopped after ${tick} session(s).`;
  controls.setStatus(_psMsg, 'success');
  notify('Pub/Sub Test stopped', _psMsg);
  await pushResult('pubsub', results.getPubSubCSV(), { sessions: tick, groups: numGroups, coverage: actualCoverage });
}

// ─────────────────────────────────────────────────────────────────────────────
// Membership Pub/Sub — live continuous simulation (NX-15+).
//
// Tick-by-tick loop. Each tick publishes once on every relay and measures
// delivery. Every `ticksPerChurnRound` ticks, a slice of the network is
// killed, all live nodes run refreshTick (so subs, axons, and roots all
// re-subscribe), then measurement resumes. The run continues until the
// user hits Stop. Used to study how the pure axonal tree heals itself
// under continuous churn.
// ─────────────────────────────────────────────────────────────────────────────

async function onMembershipPubSub() {
  const params = controls.snapshot();
  results.setRunParams(params);

  // Default knobs (Phase 2 moves these to UI).
  const churnPct            = params.pubsubChurnPct            ?? 1.0;
  const ticksPerChurnRound  = params.pubsubTicksPerChurnRound  ?? 5;
  const refreshRoundsPerKill = params.pubsubRefreshRoundsPerKill ?? 3;
  const overlapEveryN       = params.pubsubOverlapEveryN       ?? 10;  // measure K-overlap every N ticks

  controls.setStatus('Building pub/sub groups…', 'info');

  let session;
  try {
    session = await engine.setupMembershipSession(dht, {
      pubsubGroupSize: params.pubsubGroupSize,
      pubsubCoverage:  params.pubsubCoverage,
      local:           false,
    });
  } catch (err) {
    controls.setStatus(`Pub/Sub setup failed: ${err.message}`, 'warn');
    return;
  }

  pubsubActive = true;
  setAppState('pubsub');
  controls.setPubSub(true);
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();
  if (session.groups[0]?.relay) globe.panToLatLng(session.groups[0].relay.lat, session.groups[0].relay.lng);

  const initialAliveCount = dht.getNodes().filter(n => n.alive).length;
  const history = [];
  let tick = 0;
  let cumulativeKilled = 0;

  controls.setStatus(
    `Membership Pub/Sub: ${session.numGroups} groups · ${session.actualCoverage.toFixed(1)}% coverage · ` +
    `${churnPct}% churn every ${ticksPerChurnRound} ticks`,
    'info'
  );

  while (pubsubActive) {
    tick++;
    // Churn on scheduled ticks; skip the very first tick so the baseline
    // measurement reflects the pre-churn steady state.
    const doChurn = tick > 1 && (tick % ticksPerChurnRound === 0);
    const wantOverlap = (tick % overlapEveryN) === 0 || tick === 1;

    const result = await engine.runMembershipPubSubTick(dht, session.groups, session.entries, {
      doChurnThisTick: doChurn,
      churnPct,
      refreshRounds: doChurn ? refreshRoundsPerKill : 0,
      measureOverlap: wantOverlap,
      publishedByGroup: session.publishedByGroup,
    });

    if (!pubsubActive) break;

    cumulativeKilled += result.killedThisTick;
    const cumulativeKilledPct = initialAliveCount > 0
      ? (cumulativeKilled / initialAliveCount) * 100
      : 0;

    history.push({
      tick,
      deliveredPct:      result.deliveredPct,
      delivered:         result.delivered,
      expected:          result.expected,
      killedThisTick:    result.killedThisTick,
      cumulativeKilled,
      cumulativeKilledPct,
      axonRoles:         result.axonRoles,
      maxFanout:         result.maxFanout,
      treeDepth:         result.treeDepth,
      overlapPct:        result.overlapPct,
      convergePct:       result.convergePct,
      cumulativePct:     result.cumulativePct,
      cumReceived:       result.cumReceived,
      cumExpected:       result.cumExpected,
      didChurn:          doChurn,
    });

    // For Phase 1: update status line with a compact summary. Phase 3
    // will wire this up to the live chart + stats table.
    if (typeof results.showMembershipSimProgress === 'function') {
      results.showMembershipSimProgress(history, session.numGroups, session.actualCoverage);
    }
    controls.setStatus(
      `Tick ${tick} · deliv ${result.deliveredPct.toFixed(1)}% ` +
      `(${result.delivered}/${result.expected}) ` +
      (result.cumulativePct != null ? `· cum ${result.cumulativePct.toFixed(1)}% ` : '') +
      `· axons ${result.axonRoles} · ` +
      `killed ${cumulativeKilled} (${cumulativeKilledPct.toFixed(1)}%)` +
      (doChurn ? ' · ⚠ churn' : '') +
      (result.overlapPct != null ? ` · K-ov ${result.overlapPct.toFixed(1)}%` : ''),
      'info'
    );

    await yieldUI();
  }

  pubsubActive = false;
  setAppState('idle');
  controls.setPubSub(false);
  const finalMsg = `Membership Pub/Sub stopped after ${tick} tick(s); cumulative kill ${cumulativeKilled} (${((cumulativeKilled/initialAliveCount)*100).toFixed(1)}%).`;
  controls.setStatus(finalMsg, 'success');
  notify('Membership Pub/Sub stopped', finalMsg);
  // CSV export (optional — Phase 3 will wire a richer format)
  if (typeof results.getMembershipSimCSV === 'function') {
    await pushResult('pubsub-membership', results.getMembershipSimCSV(),
                     { ticks: tick, killed: cumulativeKilled, churnPct, ticksPerChurnRound });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pair Learning — fixed one-to-one routing test
// ─────────────────────────────────────────────────────────────────────────────

async function onPairLearning() {
  if (pairActive) {
    pairActive = false;
    return;
  }

  if (trainingActive || pubsubActive || !dht) {
    if (!dht) controls.setStatus('Initialise the network first.', 'warn');
    return;
  }

  const aliveNodes = dht.getNodes().filter(n => n.alive);
  if (aliveNodes.length < 2) {
    controls.setStatus('Need at least 2 nodes for pair learning.', 'warn');
    return;
  }

  pairActive = true;
  controls.setPairLearning(true);
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();
  results.setRunParams(controls.snapshot());

  // Assign each node a fixed random target (different from itself).
  // Targets are chosen once and stay fixed across all sessions so the
  // neuromorphic synaptome can build dedicated shortcuts for each pair.
  const pairs = aliveNodes.map((src, i) => {
    let dstIdx;
    do { dstIdx = Math.floor(Math.random() * aliveNodes.length); }
    while (dstIdx === i);
    return { srcId: src.id, dstId: aliveNodes[dstIdx].id };
  });

  results.clearPairLearning(); results.clearMembershipSim();
  const history = [];
  let session = 0;

  controls.setStatus(
    `Pair Learning: ${pairs.length.toLocaleString()} fixed pairs — running…`,
    'info'
  );

  while (pairActive) {
    session++;
    controls.setStatus(`Pair Learning session ${session} (${pairs.length.toLocaleString()} pairs)…`, 'info');
    controls.setProgress(0);

    const sess = await engine.runPairSession(dht, pairs);

    if (!pairActive) break;

    history.push({
      session,
      pairs:   pairs.length,
      hops:    sess.hops,
      time:    sess.time,
      success: sess.successCount,
    });

    results.showPairResults(history);
    results.updatePairProgress(history);

    controls.setProgress(0);
    controls.setStatus(
      `Pair #${session} — avg hops: ${sess.hops?.mean?.toFixed(2) ?? '—'}, ` +
      `avg time: ${sess.time?.mean?.toFixed(1) ?? '—'} ms, ` +
      `routed: ${sess.successCount}/${pairs.length}`,
      'info'
    );

    await yieldUI();
  }

  pairActive = false;
  controls.setPairLearning(false);
  controls.setProgress(0);
  const _plMsg = `Pair Learning stopped after ${session} session(s) · ${pairs.length.toLocaleString()} pairs.`;
  controls.setStatus(_plMsg, 'success');
  notify('Pair Learning stopped', _plMsg);
  await pushResult('pair-learning', results.getPairCSV(), { sessions: session, pairs: pairs.length });
}

// ─────────────────────────────────────────────────────────────────────────────
// Hotspot Test
// ─────────────────────────────────────────────────────────────────────────────

async function onHotspotTest() {
  if (!dht) { controls.setStatus('Initialise the network first.', 'warn'); return; }
  if (hotspotActive) {
    engine.stop();
    hotspotActive = false;
    controls.setHotspotTesting(false);
    controls.setStatus('Hotspot test stopped.', 'warn');
    return;
  }
  if (trainingActive || pubsubActive || pairActive) {
    controls.setStatus('Stop the running test first.', 'warn');
    return;
  }

  hotspotActive = true;
  controls.setHotspotTesting(true);
  results.clearHotspot();
  globe.clearArcs();

  const params    = controls.snapshot();
  results.setRunParams(params);
  const warmup    = params.benchWarmupSessions * 500;

  controls.setStatus('Hotspot test — warming up…', 'info');
  controls.setProgress(0);

  const protoName = dht.constructor.protocolName ?? params.protocol;
  engine.onProgress = (frac, info) => {
    controls.setProgress(frac);
    if (info?.phase === 'warmup') {
      controls.setStatus(`[${protoName}] Hotspot warmup: ${info.done}/${info.total} lookups…`, 'info');
    } else if (info?.phase === 'highway') {
      controls.setStatus(`[${protoName}] Highway phase: ${info.done}/${info.total} lookups…`, 'info');
    } else if (info?.phase === 'storage') {
      controls.setStatus(`[${protoName}] Storage phase: ${info.done}/${info.total} queries…`, 'info');
    }
  };

  engine.onComplete = async (result) => {
    if (result?.type === 'hotspot') {
      results.showHotspotResults(result);
      const hw = result.highway;
      const st = result.storage;
      const _hsMsg = `Hotspot done — Highway Gini: ${hw.gini.toFixed(3)} ` +
        `(top 1% = ${(hw.top1pctLoad*100).toFixed(1)}%),  ` +
        `Storage Gini: ${st.gini.toFixed(3)} ` +
        `(top 10% items = ${(st.top10pctItemLoad*100).toFixed(1)}%)`;
      controls.setStatus(_hsMsg, 'success');
      notify('Hotspot Test complete', `Highway Gini: ${hw.gini.toFixed(3)} · Storage Gini: ${st.gini.toFixed(3)}`);
      await pushResult('hotspot', results.getHotspotCSV(), { hwGini: hw.gini, stGini: st.gini });
    }
    hotspotActive = false;
    controls.setHotspotTesting(false);
    controls.setProgress(0);
  };

  await engine.runHotspotTest(dht, {
    warmupLookups:  warmup,
    numLookups:     params.hotspotLookups,
    contentCount:   params.contentCount,
    zipfExponent:   params.zipfExponent,
    contentLookups: params.hotspotLookups,
  });

  if (hotspotActive) {
    hotspotActive = false;
    controls.setHotspotTesting(false);
    controls.setProgress(0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark — all-protocol × multi-radius comparison
// ─────────────────────────────────────────────────────────────────────────────

let benchmarkActive = false;

async function onBenchmark() {
  // Cannot start a benchmark while training is running.
  if (trainingActive) return;
  if (pubsubActive) return;
  if (pairActive) return;

  // Toggle: clicking while running stops the benchmark.
  if (benchmarkActive) {
    benchmarkActive = false;
    engine.stop();
    return;
  }

  benchmarkActive = true;
  setAppState('benchmark');
  controls.setBenchmarking(true);
  controls.setProgress(0);
  globe.clearArcs();
  globe.clearConnections();

  const params = controls.snapshot();
  results.setRunParams(params);

  const PROTOCOL_DEFS = [
    { key: 'kademlia', label: 'Kademlia' },
    { key: 'geob',     label: 'G-DHT' },          // retired: 'geo' (G-DHT-8), 'geoa' (G-DHT-a); geob is the SOTA variant and now the only G-DHT in benchmarks
    // Neuromorphic protocols need a warmup burst so synaptic shortcuts form
    // before measurement.  Without warmup their weights are identical to G-DHT.
    { key: 'ngdht',     label: 'N-1',     warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht15w',  label: 'N-15W',   warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdhtnx1w', label: 'NX-1W',   warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdhtnx2w', label: 'NX-2W',   warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdhtnx3',  label: 'NX-3',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdhtnx4',  label: 'NX-4',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdhtnx5',  label: 'NX-5',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnx6',  label: 'NX-6',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnx7',  label: 'NX-7',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnx8',  label: 'NX-8',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnx9',  label: 'NX-9',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnx10', label: 'NX-10',   warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnx13', label: 'NX-13',  warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnx15', label: 'NX-15',  warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnx17', label: 'NX-17',  warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnh1',  label: 'NH-1',   warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    // I1: 'axona' is the v1.0 kernel-driven protocol key.  Falls through
    // to AxonaEngine for now; transport-based adapter is a follow-up.
    { key: 'axona',     label: 'Axona',  warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
  ].filter(def => !params.benchProtocols || params.benchProtocols.has(def.key));

  // Build the full ordered test list, then filter by user selection.
  // 'churn' is always kept last if selected (it modifies DHT state).
  const ALL_TEST_SPECS = [
    { key: 'global',    type: 'global' },
    { key: 'r500',      type: 'regional', radius: 500  },
    { key: 'r1000',     type: 'regional', radius: 1000 },
    { key: 'r2000',     type: 'regional', radius: 2000 },
    { key: 'r5000',     type: 'regional', radius: 5000 },
    { key: 'src',       type: 'source',   pct: params.sourcePct },
    { key: 'dest',      type: 'dest',     pct: params.destPct },
    { key: 'srcdest',   type: 'srcdest',  srcPct: params.sourcePct, destPct: params.destPct },
    { key: 'continent', type: 'continent', src: 'NA', dst: 'AS' },
    { key: 'pubsub',    type: 'pubsub',   groupSize: params.pubsubGroupSize, coverage: params.pubsubCoverage },
    { key: 'pubsubm',   type: 'pubsubm',  groupSize: params.pubsubGroupSize, coverage: params.pubsubCoverage },
    { key: 'pubsubm-local', type: 'pubsubm-local', groupSize: params.pubsubGroupSize, coverage: params.pubsubCoverage, radius: params.pubsubLocalRadius ?? 2000 },
    { key: 'pubsubmchurn', type: 'pubsubmchurn', groupSize: params.pubsubGroupSize, coverage: params.pubsubCoverage, rate: params.benchChurnPct },
    // 'slice' modifies routing tables in place (prunes cross-hemisphere edges).
    // Place after non-mutating tests but before churn (which destroys state).
    { key: 'slice',     type: 'slice'    },
    { key: 'churn',     type: 'churn',    rate: params.benchChurnPct },
  ];
  const testSpecs = ALL_TEST_SPECS
    .filter(s => !params.benchTests || params.benchTests.has(s.key))
    .map(({ key: _key, ...rest }) => rest);  // strip the key before passing to engine

  const N           = params.nodeCount;
  const NUM_LOOKUPS = params.msgCount;

  // Total work units: for each protocol — 1 build step + one step per test spec.
  const TOTAL_STEPS      = PROTOCOL_DEFS.length * (1 + testSpecs.length);
  const YIELD_EVERY      = Math.max(100, Math.floor(N / 200));
  let   completedSteps   = 0;

  // Build a progress fraction from completed steps plus partial progress inside
  // the current build.
  const stepFrac = (done, partial = 0) => (done + partial) / TOTAL_STEPS;

  const protocolDefs = [];
  const TOTAL_PROTOCOLS = PROTOCOL_DEFS.length;

  for (let defIdx = 0; defIdx < TOTAL_PROTOCOLS; defIdx++) {
    const def = PROTOCOL_DEFS[defIdx];
    const tag = `${def.label} (${defIdx + 1}/${TOTAL_PROTOCOLS})`;

    const buildFn = async () => {
      if (!benchmarkActive) return null;

      controls.setStatus(`${tag} — building network (${N.toLocaleString()} nodes)…`, 'bench');
      const benchDHT = createDHT({ ...params, protocol: def.key });

      for (let i = 0; i < N; i++) {
        if (!benchmarkActive) return null;   // stop during node addition
        const { lat, lng } = globe.randomLandPoint();
        await benchDHT.addNode(lat, lng);
        if ((i + 1) % YIELD_EVERY === 0) {
          controls.setProgress(stepFrac(completedSteps, (i + 1) / N * 0.8));
          await yieldUI();
        }
      }

      if (!benchmarkActive) return null;

      if (params.benchBootstrap && benchDHT.bootstrapJoin) {
        // Propagate connection cap + bidirectional flag (normally done by
        // buildRoutingTables, which the bootstrap path skips).
        const maxConn = params.webLimit ? (params.maxConnections ?? 100) : Infinity;
        const highwayPct = params.highwayPct ?? 0;
        // Directional caps (v0.67.02): read from BenchmarkSweep window
        // override first, fall back to params (no UI control yet — sweep
        // is the only producer). Infinity means "no directional gate".
        const maxOutOverride = window.__sim?._maxOutgoingOverride;
        const maxInOverride  = window.__sim?._maxIncomingOverride;
        const maxOut = (params.webLimit && (maxOutOverride ?? params.maxOutgoing) != null)
          ? (maxOutOverride ?? params.maxOutgoing) : Infinity;
        const maxIn  = (params.webLimit && (maxInOverride  ?? params.maxIncoming) != null)
          ? (maxInOverride  ?? params.maxIncoming) : Infinity;
        benchDHT.maxConnections = maxConn;
        benchDHT.maxOutgoing    = maxOut;
        benchDHT.maxIncoming    = maxIn;
        benchDHT.bidirectional  = params.bidirectional;
        benchDHT.highwayPct     = highwayPct;
        // Mixed-capacity model: promote a random `highwayPct` fraction of
        // nodes to unrestricted (server-class transit hubs). The rest keep
        // the normal web cap. Mirrors the logic in DHT.buildRoutingTables.
        const allNodesArr = [...benchDHT.nodeMap.values()];
        const highwayCount = Math.floor(allNodesArr.length * (highwayPct / 100));
        const shuffled = [...allNodesArr].sort(() => Math.random() - 0.5);
        const highwaySet = new Set(shuffled.slice(0, highwayCount).map(n => n.id));
        for (const node of allNodesArr) {
          const isHw = highwaySet.has(node.id);
          node.maxConnections = isHw ? Infinity : maxConn;
          node.maxOutgoing    = isHw ? Infinity : maxOut;
          node.maxIncoming    = isHw ? Infinity : maxIn;
          node.isHighway      = isHw;
        }

        // Bootstrapped init: each node joins via sponsor + refresh pass
        controls.setStatus(`${tag} — bootstrap joining…`, 'bench');
        const allNodes = [...benchDHT.nodeMap.values()];
        for (let i = 1; i < allNodes.length; i++) {
          if (!benchmarkActive) return null;
          const sponsor = findSponsor(benchDHT, allNodes[i]);
          if (sponsor) benchDHT.bootstrapJoin(allNodes[i].id, sponsor.id);
          if ((i + 1) % 100 === 0) {
            controls.setProgress(stepFrac(completedSteps, (0.8 + (i + 1) / allNodes.length * 0.1)));
            await yieldUI();
          }
        }
        // Refresh pass — early joiners had sparse tables
        controls.setStatus(`${tag} — refreshing routing tables…`, 'bench');
        const allIds = [...benchDHT.nodeMap.keys()];
        for (let i = 0; i < allNodes.length; i++) {
          if (!benchmarkActive) return null;
          let sponsorId = allNodes[i].id;
          while (sponsorId === allNodes[i].id) {
            sponsorId = allIds[Math.floor(Math.random() * allIds.length)];
          }
          benchDHT.bootstrapJoin(allNodes[i].id, sponsorId);
          if ((i + 1) % 100 === 0) {
            controls.setProgress(stepFrac(completedSteps, (0.9 + (i + 1) / allNodes.length * 0.1)));
            await yieldUI();
          }
        }
      } else {
        // Bulk routing-table construction (default)
        controls.setStatus(`${tag} — building routing tables…`, 'bench');
        const maxOutOv     = window.__sim?._maxOutgoingOverride;
        const maxInOv      = window.__sim?._maxIncomingOverride;
        const initModeOv   = window.__sim?._initModeOverride;
        benchDHT.buildRoutingTables({
          bidirectional:  params.bidirectional,
          maxConnections: params.webLimit ? (params.maxConnections ?? 100) : Infinity,
          maxOutgoing:    (params.webLimit && (maxOutOv ?? params.maxOutgoing) != null)
                            ? (maxOutOv ?? params.maxOutgoing) : Infinity,
          maxIncoming:    (params.webLimit && (maxInOv  ?? params.maxIncoming) != null)
                            ? (maxInOv  ?? params.maxIncoming) : Infinity,
          highwayPct:     params.highwayPct ?? 0,
          initMode:       initModeOv ?? params.initMode ?? 'native',
        });
      }
      // Bilateral-cap invariant check post-bootstrap. No-op when web limit off.
      benchDHT.verifyConnectionCap?.(`${tag} post-bootstrap`);
      completedSteps++;
      controls.setProgress(stepFrac(completedSteps));
      await yieldUI();

      return benchDHT;
    };

    protocolDefs.push({
      key:           def.key,
      label:         def.label,
      buildFn,
      warmupLookups: def.warmupLookups,
      warmupHotPct:  def.warmupHotPct,
      warmupRadius:  def.warmupRadius,
    });
  }

  const benchResult = await engine.runBenchmark(protocolDefs, {
    testSpecs,
    numMessages: NUM_LOOKUPS,
    landFn: () => globe.randomLandPoint(),
    // onStart: status-only update before each cell (no progress increment)
    onStart: (msg) => {
      controls.setStatus(msg, 'bench');
    },
    // onStep: called once after each cell completes — drives progress bar
    onStep: (msg) => {
      completedSteps++;
      controls.setProgress(stepFrac(completedSteps));
      controls.setStatus(msg, 'bench');
    },
  });

  const stopped = !benchmarkActive;
  benchmarkActive = false;
  setAppState('idle');
  controls.setBenchmarking(false);
  controls.setProgress(0);

  if (stopped) {
    controls.setStatus('Benchmark stopped.', 'warn');
    notify('Benchmark stopped', `Interrupted after partial run · ${N.toLocaleString()} nodes`);
    sweep.notifyBenchmarkStopped();
  } else {
    results.showBenchmarkResults(benchResult, N, params);
    controls.setStatus('Benchmark complete.', 'success');
    notify('Benchmark complete ✓', `${params.benchProtocols?.length ?? '?'} protocols · ${N.toLocaleString()} nodes`);
    await pushResult('benchmark', results.getBenchmarkCSV(benchResult, N, params), { protocols: params.benchProtocols ?? [], nodeCount: N, warmupSessions: params.benchWarmupSessions, testSpecs: params.benchTests ?? [] });
    sweep.notifyBenchmarkComplete();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

function createDHT(params) {
  switch (params.protocol) {
    case 'geo':
      return new GeographicDHT({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits ?? 8,
      });
    case 'geoa':
      return new GeographicDHTa({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits ?? 8,
      });
    case 'geob':
      return new GeographicDHTb({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits ?? 8,
      });
    case 'ngdht':
      return new NeuromorphicDHT({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht15w':
      return new NeuromorphicDHT15W({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdhtnx1w':
      return new NeuromorphicDHTNX1W({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx2w':
      return new NeuromorphicDHTNX2W({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx2wRules,
      });
    case 'ngdhtnx3':
      return new NeuromorphicDHTNX3({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx4':
      return new NeuromorphicDHTNX4({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx5':
      return new NeuromorphicDHTNX5({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx6':
      return new NeuromorphicDHTNX6({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx7':
      return new NeuromorphicDHTNX7({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx8':
      return new NeuromorphicDHTNX8({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx9':
      return new NeuromorphicDHTNX9({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx10':
      return new NeuromorphicDHTNX10({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx13':
      return new NeuromorphicDHTNX13({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx13Rules,
      });
    case 'ngdhtnx15':
      return new NeuromorphicDHTNX15({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
        membership: params.nx15Params,   // UI-tunable pub/sub membership params
      });
    case 'ngdhtnx17':
      // v0.71.0 — NX-17 is now a thin parametric variant of NH-1
      // (extends AxonaEngine). Both protocols share the same
      // Transport contract usage and the same DHT API surface; NX-17
      // distinguishes itself by tuning toward wider exploration
      // (larger synaptome, higher LOOKAHEAD_ALPHA, slower annealing).
      // Caller-supplied `nx17Rules` overrides NX-17's defaults; if
      // absent, NX-17 uses its own four-knob character set.
      return new NeuromorphicDHTNX17({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: window.__sim?._nx17RulesOverride ?? params.nx17Rules ?? {},
        // NX-17 inherits NH-1's _membershipOpts (rootSetSize forced to 0,
        // routed-mode single-root-per-topic).  honours all the same
        // refresh/TTL knobs.
        membership: params.nx17Params ?? params.nh1Params ?? params.nx15Params,
      });
    case 'ngdhtnh1':
      return new AxonaEngine({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        // BenchmarkSweep stashes per-run NH-1 rule overrides on
        // window.__sim._nh1RulesOverride so ablation experiments can drive
        // single-parameter changes without recompiling.
        rules: window.__sim?._nh1RulesOverride ?? params.nh1Rules,
        // Reuse the same membership params as NX-17 — NH-1's AxonaManager
        // is configured identically (rootSetSize forced to 0, NX-17-style
        // single-root-per-topic routed mode) so a head-to-head pubsubm
        // benchmark is apples-to-apples.
        membership: params.nh1Params ?? params.nx17Params ?? params.nx15Params,
      });
    case 'axona':
      // ── v1.0 kernel-driven protocol — Transport.sim end-to-end ──
      //
      // `case 'axona'` constructs a TransportAxonaEngine: every node
      // pairs with a kernel AxonaPeer (`@axona/protocol`), all sharing
      // one AxonaDomain, talking peer-to-peer over kernel SimNetwork +
      // simTransport.  No god's-eye nodeMap access in the routing
      // path — `peer.lookup()` walks the mesh via the same
      // `transport.send('lookup_step', …)` chain a real deployment
      // would use.
      //
      // v1 ships bootstrap-quality routing (buildXorRoutingTable XOR
      // fill).  Engine-side advanced learning that NH-1/NX-17 use to
      // drop latency (anneal, triadic closure, lateral spread, hop
      // cache, EMA reinforcement) is queued for follow-up commits
      // that lift those handlers into the peer.  Until those land,
      // axona is closer to G-DHT-quality than NH-1-quality on this
      // path — useful as a correctness signal, not a perf claim.
      //
      // The kernel itself is verified via:
      //   · test/smoke_kernel_integration.mjs  (18 assertions)
      //   · test/smoke_kernel_regression.mjs   (30 + N×3 at scale)
      //   · axona-protocol/test/smoke_standalone_lookup.mjs (17)
      return new TransportAxonaEngine({
        k:       params.k,
        alpha:   params.alpha,
        bits:    params.bits,
        geoBits: params.geoBits,
      });
    case 'kademlia':
    default:
      return new KademliaDHT({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
  }
}

function yieldUI() {
  return new Promise(r => setTimeout(r, 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
