// =====================================================================
// pubsub-sweep.mjs — scalable-pub/sub scaling curve for the REAL kernel.
//
// Spawns harness/pubsub-real-kernel.mjs once per (size × config[, churn])
// scenario — process-per-scenario so each run starts clean (no timer/peer
// leakage between sizes) — parses each run's RESULT_JSON line, and prints a
// scaling table + writes a CSV to results/.
//
//   node harness/pubsub-sweep.mjs                          # default sizes, prod config
//   SIZES=120,300,600,1000 CONFIGS=both node harness/pubsub-sweep.mjs   # compare configs
//   SIZES=300,1000 CHURN_PCT=20 node harness/pubsub-sweep.mjs           # add self-heal test
//
// Env: SIZES (csv of N), SUB_FRAC (subscribers as fraction of N, default .66),
//      CONFIGS (default | pickrelay | both), CHURN_PCT (0=off).
// =====================================================================

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const HARNESS  = new URL('./pubsub-real-kernel.mjs', import.meta.url).pathname;
const SIZES    = (process.env.SIZES || '120,300,600,1000').split(',').map(Number);
const SUB_FRAC = +(process.env.SUB_FRAC || 0.66);
const CONFIGS  = (process.env.CONFIGS || 'default').toLowerCase();
const cfgs     = CONFIGS === 'both' ? ['default', 'pickrelay'] : [CONFIGS];
const CHURN    = +(process.env.CHURN_PCT || 0);

function runOne(env) {
  return new Promise((resolve) => {
    const child = spawn('node', [HARNESS], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', () => {});
    child.on('close', () => {
      const m = out.match(/RESULT_JSON (\{.*\})/);
      resolve(m ? JSON.parse(m[1]) : null);
    });
  });
}

const rows = [];
for (const N of SIZES) {
  const SUBS = Math.max(2, Math.floor(N * SUB_FRAC));
  for (const cfg of cfgs) {
    const env = {
      N: String(N), SUBS: String(SUBS), K: '20', SYN_CAP: '100',
      REFRESH: '2000', SETTLE: String(Math.max(8000, N * 16)),
      PUBS: '4', PUBGAP: '2000', DELIVER: '3500',
      PICK_RELAY: cfg === 'pickrelay' ? '1' : '',
      CHURN_PCT: String(CHURN),
    };
    process.stderr.write(`▶ N=${N} SUBS=${SUBS} cfg=${cfg}${CHURN ? ` churn=${CHURN}%` : ''} …\n`);
    const r = await runOne(env);
    if (r) { r.cfg = cfg; rows.push(r); process.stderr.write(`  ✓ delivery ${r.deliveryPct}% depth ${r.depth}${r.churn ? ` postChurn ${r.churn.pct}%` : ''}\n`); }
    else   { process.stderr.write('  ✗ no RESULT_JSON (run failed)\n'); }
  }
}

console.log('\n=== scalable pub/sub via axonic trees — real kernel ===');
console.log(['N', 'subs', 'cfg', 'deliv%', 'depth', 'maxFan', 'axons', 'subax', 'churn%', 'churnDepth'].join('\t'));
for (const r of rows) {
  console.log([r.N, r.SUBS, r.cfg, r.deliveryPct, r.depth, r.maxFanout, r.roleNodes, r.subaxons,
    r.churn ? r.churn.pct : '-', r.churn ? r.churn.depth : '-'].join('\t'));
}

mkdirSync('results', { recursive: true });
const ts  = new Date().toISOString().replace(/[:.]/g, '-');
const csv = ['N,subs,config,delivery_pct,depth,max_fanout,axons,subaxons,churn_pct,churn_depth',
  ...rows.map(r => [r.N, r.SUBS, r.cfg, r.deliveryPct, r.depth, r.maxFanout, r.roleNodes, r.subaxons,
    r.churn ? r.churn.pct : '', r.churn ? r.churn.depth : ''].join(','))].join('\n');
const path = `results/pubsub-scale_${ts}.csv`;
writeFileSync(path, csv + '\n');
console.log('\nCSV → ' + path);
