// =====================================================================
// root-election-sweep.mjs — stress the v3.10.0 root-election fix across
// a grid of (nodes × subscribers), with and without churn.
//
// For each cell it spawns the production-faithful pubsub-real-kernel harness
// (real kernel peers over SimNetwork, the file-linked v3.10.0 source), parses
// its RESULT_JSON, and judges the cell against the invariants the fix must hold:
//
//   • root set is canonical: every isRoot/in-root-set node is in the topic's
//     true K-closest  (rootsInTrue === roots, spuriousRootsWithChildren === 0)
//   • recruitment fires when SUBS > maxDirectSubs (sub-axons > 0)
//   • per-axon fan-out respects the cap (maxFanout ≤ 20)
//   • delivery ≥ 95% steady, ≥ 90% post-churn — and the invariants STILL hold
//     after a 20% kill (the fix is churn-resilient, not just cold-start)
//
//   node harness/root-election-sweep.mjs                 # default grid
//   GRID=quick node harness/root-election-sweep.mjs      # small/fast grid
//
// Writes results/root-election-sweep_<n>.csv.
// =====================================================================

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const HARNESS = new URL('./pubsub-real-kernel.mjs', import.meta.url).pathname;

// (N, SUBS) cells — subscribers span sparse → dense for each size.
const GRID = process.env.GRID === 'quick'
  ? [[300, 30], [300, 150], [1000, 100], [1000, 600]]
  : [
      [300, 30], [300, 150], [300, 280],
      [1000, 50], [1000, 300], [1000, 900],
      [3000, 100], [3000, 800], [3000, 2500],
      [8000, 200], [8000, 2000],
    ];
const CHURNS = [0, 20];   // % killed (0 = steady-state)

const runCell = (N, SUBS, churn) => new Promise((resolve) => {
  // Convergence budget scales with size; refresh tick 1s; cap settle so the
  // sweep stays tractable at 8k.
  const SETTLE = Math.min(9000, Math.max(3000, Math.round(N * 1.2)));
  const env = {
    ...process.env,
    N: String(N), SUBS: String(SUBS), K: '20',
    REFRESH: '1000', SETTLE: String(SETTLE), DELIVER: '3000', PUBS: '1',
    CHURN_PCT: String(churn),
  };
  const t0 = Date.now();
  const child = spawn('node', [HARNESS], { env });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', () => {});
  child.on('close', () => {
    const line = out.split('\n').find(l => l.startsWith('RESULT_JSON'));
    if (!line) { resolve({ N, SUBS, churn, error: 'no RESULT_JSON', secs: ((Date.now()-t0)/1000).toFixed(0) }); return; }
    try { resolve({ ...JSON.parse(line.slice('RESULT_JSON '.length)), churnPct: churn, secs: ((Date.now()-t0)/1000).toFixed(0) }); }
    catch (e) { resolve({ N, SUBS, churn, error: String(e), secs: ((Date.now()-t0)/1000).toFixed(0) }); }
  });
});

const verdict = (r) => {
  if (r.error) return 'ERR';
  const fails = [];
  if (r.spuriousRootsWithChildren > 0) fails.push(`spurious=${r.spuriousRootsWithChildren}`);
  if (r.rootsInTrue !== r.roots)        fails.push(`rootsOffCanonical(${r.rootsInTrue}/${r.roots})`);
  if (r.maxFanout > 20)                 fails.push(`fanout=${r.maxFanout}`);
  if (r.deliveryPct < 95)               fails.push(`deliv=${r.deliveryPct}%`);
  if (r.SUBS > 20 && r.subaxons === 0)  fails.push('no-recruit');
  if (r.churn) {
    if (r.churn.pct < 90)                       fails.push(`churnDeliv=${r.churn.pct}%`);
    if (r.churn.spuriousRootsWithChildren > 0)  fails.push(`churnSpurious=${r.churn.spuriousRootsWithChildren}`);
    if (r.churn.rootsInTrue !== r.churn.roots)  fails.push(`churnRootsOff(${r.churn.rootsInTrue}/${r.churn.roots})`);
  }
  return fails.length ? 'FAIL: ' + fails.join(',') : 'PASS';
};

console.log(`\n── root-election sweep — grid=${process.env.GRID||'full'} (${GRID.length} sizes × ${CHURNS.length} churn) ──\n`);
const rows = [];
for (const [N, SUBS] of GRID) {
  for (const churn of CHURNS) {
    const r = await runCell(N, SUBS, churn);
    const v = verdict(r);
    rows.push({ ...r, verdict: v });
    if (r.error) { console.log(`N=${N} SUBS=${SUBS} churn=${churn}%  → ERR ${r.error}`); continue; }
    const c = r.churn ? ` | churn ${r.churn.pct}% roots=${r.churn.roots}(true ${r.churn.rootsInTrue},spur ${r.churn.spuriousRootsWithChildren})` : '';
    console.log(
      `N=${String(N).padStart(4)} SUBS=${String(SUBS).padStart(4)} churn=${String(churn).padStart(2)}%  `
      + `deliv=${String(r.deliveryPct).padStart(5)}% roots=${r.roots}(true ${r.rootsInTrue},spur ${r.spuriousRootsWithChildren}) `
      + `subax=${String(r.subaxons).padStart(3)} fan=${r.maxFanout} depth=${r.depth}${c}  [${r.secs}s]  ${v}`
    );
  }
}

// CSV
mkdirSync(new URL('../results/', import.meta.url).pathname, { recursive: true });
const cols = ['N','SUBS','churnPct','deliveryPct','roots','rootsInTrue','spuriousRootsWithChildren','subaxons','maxFanout','depth','churnDeliveryPct','churnRoots','churnRootsInTrue','churnSpurious','secs','verdict'];
const csv = [cols.join(',')].concat(rows.map(r => [
  r.N, r.SUBS, r.churnPct, r.deliveryPct ?? '', r.roots ?? '', r.rootsInTrue ?? '', r.spuriousRootsWithChildren ?? '',
  r.subaxons ?? '', r.maxFanout ?? '', r.depth ?? '',
  r.churn?.pct ?? '', r.churn?.roots ?? '', r.churn?.rootsInTrue ?? '', r.churn?.spuriousRootsWithChildren ?? '',
  r.secs ?? '', JSON.stringify(r.verdict),
].join(','))).join('\n');
const path = new URL(`../results/root-election-sweep_${rows.length}.csv`, import.meta.url).pathname;
writeFileSync(path, csv + '\n');

const passes = rows.filter(r => r.verdict === 'PASS').length;
console.log(`\n${passes}/${rows.length} cells PASS.  CSV: ${path}`);
const bad = rows.filter(r => r.verdict !== 'PASS');
if (bad.length) console.log('NON-PASS:\n' + bad.map(r => `  N=${r.N} SUBS=${r.SUBS} churn=${r.churnPct}% → ${r.verdict}`).join('\n'));
process.exit(bad.length ? 1 : 0);
