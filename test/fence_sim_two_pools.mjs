#!/usr/bin/env node
// =====================================================================
// fence_sim_two_pools.mjs — G7 of the two-pool packet (axona-docs ca52384;
// Aster v1.1 bc4fe433 §8, v1.2 b395fe8f G7): THE SIMULATOR CARRIES THE
// SAME MODEL.
//
// DHTNode (the simulator's physical-link model behind every engine) gains
// disjoint M and I ceilings and a physical H, classes at each end of every
// link (M at the initiator, I at the acceptor), promotion I→M as a class
// move, and M-only swap victims. Nothing labelled "50+50" may come from
// the legacy `maxConnections` plus directional dial caps: an unarmed node
// says so in poolStats().
//
// Oracle suite (v1.2 G7): last-slot inbound and outbound races; refusal
// close; crossed offers; promotion deadlock; union of classes; suspension
// and reconnect; legacy refusal; profile shortfall.
//
// Mutant: let `_trySwapIn` ignore `victimClass` → check 5b fails (an I
// link is evicted for a managed candidate).
// Run: node test/fence_sim_two_pools.mjs
// =====================================================================
import { DHTNode } from '../src/dht/DHTNode.js';

let passed = 0, failed = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' ' + extra}`); ok ? passed++ : failed++; };
const J = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString(16).slice(0, 8) : x));

/** A tiny god's-eye network so `_trySwapIn` can reach the victim's side. */
function mkNet() {
  const nodes = new Map();
  const add = (id, pools = null) => { const n = new DHTNode({ id, lat: 0, lng: 0 }); n._network = { nodes }; if (pools) n.setPools(pools); nodes.set(id, n); return n; };
  return { nodes, add };
}
// ids stay under 2^64: the simulator's stratum rule reads clz64. Distinct
// leading bits give distinct strata; a shared leading bit shares one.
const ID = (i) => (1n << BigInt(i)) | 1n;

console.log('fence_sim_two_pools: G7 — disjoint M / I / H on the simulator\'s link model');

// 1. profile shortfall
{
  const { add } = mkNet();
  const n = add(ID(0));
  let threw = null; try { n.setPools({ M: 50, I: 50, H: 99 }); } catch (e) { threw = e; }
  check('1 a profile with M + I > H is refused (no borrowing, no 101st allocation); the node stays unarmed', threw instanceof RangeError && n.pools === null && n.poolStats().armed === false, String(threw));
  check('1b 50+50 arms with H = 100 and lifts the legacy total cap to H', n.setPools({ M: 50, I: 50 }) && n.pools.H === 100 && n.maxConnections >= 100);
}
// 2. the 101st allocation is refused at every node
{
  const { add } = mkNet();
  const P = { M: 50, I: 50, H: 100 };
  const hub = add(ID(0), P);
  const dialers = []; for (let i = 1; i <= 60; i++) dialers.push(add(ID(i), P));
  let accepted = 0; for (const d of dialers) if (d.tryConnect(hub)) accepted++;
  check('2 sixty managed dials at a 50+50 hub: fifty accepted as I at the hub, ten refused (I full), none reclassified', accepted === 50 && hub.chargedOf('I') === 50 && hub.chargedOf('M') === 0 && hub.poolCounters.refusedI === 10, J(hub.poolStats()));
  for (let i = 61; i <= 115; i++) { const m = add(ID(i), P); hub.tryConnect(m); }
  const s = hub.poolStats();
  check('2b the hub\'s own fifty managed dials fill M; the 101st link is refused by H at the hub, M and I never exceed their ceilings', s.chargedM === 50 && s.chargedI === 50 && s.links === 100 && s.refusedH >= 1 && s.refusedM >= 0, J(s));
}
// 3. last-slot races, outbound and inbound
{
  const { add } = mkNet();
  const a = add(ID(0), { M: 1, I: 5 }), b = add(ID(1), { M: 5, I: 5 }), c = add(ID(2), { M: 5, I: 5 });
  const r1 = a.tryConnect(b), r2 = a.tryConnect(c);
  check('3 outbound last slot: with M = 1 the second managed dial is refused and the first is kept', r1 === true && r2 === false && a.chargedOf('M') === 1 && a.classOf(b.id) === 'M' && !a.connections.has(c.id) && !c.connections.has(a.id));
  const h = add(ID(3), { M: 5, I: 1 }), d1 = add(ID(4), { M: 5, I: 5 }), d2 = add(ID(5), { M: 5, I: 5 });
  const i1 = d1.tryConnect(h), i2 = d2.tryConnect(h);
  check('3b inbound last slot: with I = 1 at the acceptor the second dialer is refused; refusal allocates nothing on EITHER side', i1 === true && i2 === false && h.chargedOf('I') === 1 && !d2.connections.has(h.id) && !h.connections.has(d2.id) && d2.chargedOf('M') === 0);
}
// 4. crossed offers: one link, M at the initiator, I at the acceptor; the second direction is a promotion
{
  const { add } = mkNet();
  const a = add(ID(0), { M: 5, I: 5 }), b = add(ID(1), { M: 5, I: 5 });
  a.tryConnect(b);
  check('4 after A dials B: one link; A holds it as M, B holds it as I', a.connections.size === 1 && b.connections.size === 1 && a.classOf(b.id) === 'M' && b.classOf(a.id) === 'I');
  const r = b.tryConnect(a);
  check('4b B then selecting A is a PROMOTION, not a second link: still one link, both ends M, promoted counted', r === true && b.connections.size === 1 && b.classOf(a.id) === 'M' && b.poolCounters.promoted === 1 && a.classOf(b.id) === 'M');
}
// 5. promotion deadlock and M-only victims
{
  // 5a: the two M links sit in DIFFERENT strata (one each), so no swap can
  // improve coverage (the rule needs evict-count ≥ candidate-count + 2).
  const { add } = mkNet();
  const h = add(ID(20), { M: 2, I: 5 });
  const m1 = add(ID(21), { M: 5, I: 5 }), m2 = add(ID(22), { M: 5, I: 5 });
  h.tryConnect(m1); h.tryConnect(m2);                       // M full at h: 2 of 2
  const inc = add(ID(23), { M: 5, I: 5 }); inc.tryConnect(h); // h holds inc as I
  check('5 setup: h holds two M links and one I link', h.chargedOf('M') === 2 && h.chargedOf('I') === 1);
  const p = h.promote(inc.id);
  check('5a promotion at M full with no stratum-improving M victim ends in DEFICIT: the link stays I, nothing closes', p === false && h.classOf(inc.id) === 'I' && h.poolCounters.promotionDeficit === 1 && h.connections.size === 3, J(h.poolStats()));
}
{
  // 5b: the two M links SHARE a stratum (bit 21 leads both xors), the I link
  // sits in a stratum of its own, and a managed candidate arrives from a
  // sparser stratum: the swap evicts one M link and never the I link.
  const { add } = mkNet();
  const h = add(ID(20), { M: 2, I: 5 });
  // The I link is FIRST in h's connection order and shares the M links'
  // stratum, so a victim choice that ignored class would take it.
  const inc = add((1n << 21n) | (1n << 18n) | 1n, { M: 5, I: 5 }); inc.tryConnect(h);
  const m1 = add((1n << 21n) | 1n, { M: 5, I: 5 }), m2 = add((1n << 21n) | (1n << 19n) | 1n, { M: 5, I: 5 });
  h.tryConnect(m1); h.tryConnect(m2);
  const far = add(ID(10), { M: 5, I: 5 });                  // h ^ far leads at bit 20: a stratum nothing else holds
  const before = new Set(h.connections);
  const r = h.tryConnect(far);
  const evicted = [...before].filter((id) => !h.connections.has(id));
  check('5b at M full a managed dial that improves stratum coverage swaps out an M link and never the I link', r === true && h.classOf(far.id) === 'M' && h.classOf(inc.id) === 'I' && evicted.length === 1 && [m1.id, m2.id].includes(evicted[0]) && h.poolCounters.swapsM === 1 && h.chargedOf('M') === 2, J({ r, evicted: evicted.map(String), stats: h.poolStats() }));
}
// 6. the union: classes are visible per link, and counted once each
{
  const { add } = mkNet();
  const a = add(ID(0), { M: 5, I: 5 });
  const b = add(ID(1), { M: 5, I: 5 }), c = add(ID(2), { M: 5, I: 5 });
  a.tryConnect(b); c.tryConnect(a);
  const classes = [...a.connections].map((id) => a.classOf(id)).sort();
  check('6 every link at an armed end has exactly one class: M for the one a selected, I for the one it accepted', classes.join(',') === 'I,M' && a.poolStats().chargedM + a.poolStats().chargedI === a.connections.size);
}
// 7. suspension and reconnect
{
  const { add } = mkNet();
  const a = add(ID(0), { M: 5, I: 5 }), b = add(ID(1), { M: 5, I: 5 });
  a.tryConnect(b); a.disconnect(b);
  check('7 disconnect clears the link and its class at both ends', !a.connections.has(b.id) && !b.connections.has(a.id) && a.classOf(b.id) === null && b.classOf(a.id) === null);
  b.tryConnect(a);
  check('7b reconnect from the other side reassigns the classes afresh: b M, a I', b.classOf(a.id) === 'M' && a.classOf(b.id) === 'I');
}
// 8. legacy refusal: an unarmed node beside an armed one
{
  const { add } = mkNet();
  const armed = add(ID(0), { M: 5, I: 1 });
  const legacy1 = add(ID(1)), legacy2 = add(ID(2));
  const r1 = legacy1.tryConnect(armed), r2 = legacy2.tryConnect(armed);
  check('8 a legacy (unarmed) dialer is charged I at the armed end and holds no class itself; the second is refused by the armed end\'s I = 1', r1 === true && r2 === false && armed.classOf(legacy1.id) === 'I' && legacy1.classOf(armed.id) === null && legacy1.poolStats().armed === false);
  legacy1.maxConnections = 1;
  const r3 = armed.tryConnect(legacy1);
  check('8b an armed dialer meets the legacy end\'s own total cap: already linked → a promotion at the armed end (I→M), no second link', r3 === true && armed.classOf(legacy1.id) === 'M' && armed.connections.size === 1);
}
// 9. unarmed is byte-identical: the legacy caps alone, and the stats say so
{
  const { add } = mkNet();
  const a = add(ID(0)), b = add(ID(1));
  a.maxConnections = 1; b.maxConnections = 1;
  const c = add(ID(2));
  check('9 unarmed: the bilateral total cap refuses as 0.130.0 did; poolStats reports armed:false — a matrix from such nodes is not "50+50"', a.tryConnect(b) === true && a.tryConnect(c) === false && a.poolStats().armed === false && a.classOf(b.id) === null);
}

console.log(`\nfence_sim_two_pools: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
