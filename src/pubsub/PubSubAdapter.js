/**
 * PubSubAdapter — bridges a Croquet-style PubSubDomain to a DHT transport
 * (the Axonal tree in NX-10) with per-sender ordering guarantees.
 *
 * The adapter adds three layers on top of the raw pubsub.js library:
 *
 *   1. Wire format extension:   every outbound publish is tagged with the
 *      sender's nodeId and a monotonically increasing per-(topic,sender)
 *      sequence number.
 *
 *   2. Reorder buffer:          incoming publishes that arrive out of order
 *      are held briefly (default 100 ms) so a delayed packet can close the
 *      gap before we declare a loss.
 *
 *   3. Gap detection (tier 1):  when a gap cannot be closed within the
 *      reorder window, the adapter fires a system event
 *      `__gap__:<domain>:<event>` on the local domain so the application
 *      can react (log, reconnect indicator, request snapshot, etc.).
 *
 * Tiers 2 (publisher ring buffer + resend) and 3 (snapshot recovery) are
 * stubbed as opt-in hooks and implemented in a follow-up phase once the
 * underlying DHT gains the control-plane RPCs they require.
 *
 * ── DHT transport contract ──────────────────────────────────────────────────
 *
 * The adapter depends only on the following surface; any DHT (real NX-10,
 * mock harness, etc.) that implements it can drive the adapter:
 *
 *   transport.nodeId                            → string — stable node id
 *
 *   transport.pubsubPublish(topicId, json)      → void / Promise<void>
 *       Deliver `json` to every subscriber of `topicId`. The transport is
 *       responsible for knowing who the subscribers are and for invoking
 *       each subscriber's delivery callback. The publisher does NOT receive
 *       its own publish back — local delivery happens inside the adapter.
 *
 *   transport.pubsubSubscribe(topicId)          → void / Promise<void>
 *       Register this node as a subscriber to `topicId`. Idempotent.
 *
 *   transport.pubsubUnsubscribe(topicId)        → void / Promise<void>
 *       Unregister. Idempotent.
 *
 *   transport.onPubsubDelivery(callback)        → void
 *       Register `callback(topicId, jsonString)` to receive delivered
 *       pub/sub payloads. Called exactly once per adapter.
 */

import { PubSubDomain } from './pubsub.js';

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_REORDER_WINDOW_MS = 100;
const DEFAULT_RING_BUFFER_SIZE  = 64;     // tier-2, unused until Phase 2b
const GAP_DOMAIN                = '__gap__';

// ── Topic hashing ───────────────────────────────────────────────────────────

/**
 * Deterministic 64-bit topic id from "domain:event".
 *
 * Uses a streaming FNV-1a → mix with a cheap second hash to spread bits,
 * then concatenates the two 32-bit halves into a 64-bit lowercase hex
 * string. Not cryptographically strong, but stable across processes and
 * collision-resistant enough for topic routing. In the production build
 * this can be swapped for SHA-256-truncated-to-64-bits without changing
 * the adapter contract.
 */
export function topicIdFor(domain, event) {
  const s = domain + ':' + event;
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xcbf29ce4 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c * 0x9e3779b1), 0x85ebca6b) >>> 0;
  }
  // avalanche. Each step must end with `>>> 0` so the final value is a
  // uint32 — otherwise toString(16) emits a "-" for negative int32 and
  // downstream consumers (xorDistance → BigInt('0x' + …)) blow up.
  h1 ^= h1 >>> 16; h1 = Math.imul(h1, 0x7feb352d); h1 ^= h1 >>> 15; h1 >>>= 0;
  h2 ^= h2 >>> 16; h2 = Math.imul(h2, 0x846ca68b); h2 ^= h2 >>> 16; h2 >>>= 0;
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// ── Geographic-prefix topic IDs (NX-17+ addressing scheme) ──────────────────
//
// DHT node IDs are 64-bit with the top 8 bits encoding an S2 Hilbert cell
// prefix (GEO_BITS=8 default). Because S2 Hilbert indices always start
// with bit 0, every node GID is in the range [0, 2^63). A hash target
// whose top bit is 1 lies OUTSIDE the reachable address space — legal
// for XOR distance math, but wasteful (every node differs from it in the
// top bit) and semantically undefined.
//
// This scheme keeps topic IDs inside the valid node address space by
// constructing them as (8-bit cell prefix) || (56-bit hash of the topic
// name), which also pins all K replicas for a given topic into a single
// specific S2 cell. Both publisher and subscribers compute the same
// topic ID, so findKClosest (full-XOR, unchanged) converges reliably.
//
// The convention for carrying the prefix is a leading '@XX/' (2 hex
// chars, lowercase) on either the `domain` or the `event` string:
//
//   subscribe('@a3/chat', 'room42', cb)       → prefix a3, hash(chat:room42)
//   subscribe('chat',     '@a3/room42', cb)   → prefix a3, hash(chat:room42)
//
// Absent an '@XX/' sentinel, we fall back to the legacy unprefixed
// 64-bit hash so existing NX-15 code and tests keep working.

const PREFIX_RE = /^@([0-9a-fA-F]{2})\//;

/**
 * Extract an '@XX/' prefix sentinel from a (domain, event) pair. Returns
 * { prefix: number|null, domain, event } with the sentinel stripped from
 * whichever field carried it (domain takes precedence if both).
 */
function extractPrefix(domain, event) {
  const md = domain.match(PREFIX_RE);
  if (md) return { prefix: parseInt(md[1], 16), domain: domain.slice(md[0].length), event };
  const me = event.match(PREFIX_RE);
  if (me) return { prefix: parseInt(me[1], 16), domain, event: event.slice(me[0].length) };
  return { prefix: null, domain, event };
}

/**
 * Construct a topic ID honoring any '@XX/' cell prefix. If a prefix is
 * present, the returned 16-hex-char ID has XX as its top 2 chars and the
 * bottom 14 chars from hash_56(domain:event). If no prefix is present,
 * behaviour matches topicIdFor() exactly.
 */
export function topicIdForPrefixed(domain, event) {
  const { prefix, domain: d, event: e } = extractPrefix(domain, event);
  if (prefix === null) return topicIdFor(d, e);
  const full = topicIdFor(d, e);          // 16 hex chars
  const prefixHex = (prefix & 0xff).toString(16).padStart(2, '0');
  return prefixHex + full.slice(2);       // replace top 8 bits with prefix
}

// ── Per-topic reorder buffer ────────────────────────────────────────────────

/**
 * Tracks last-seen sequence and holds pending out-of-order events for a
 * single (topic, senderId) pair. Releases events in order when the gap
 * closes, or fires a gap signal when the reorder window expires.
 */
class SenderSeqTracker {
  constructor({ windowMs, onInOrder, onGap }) {
    this.lastSeen   = 0;           // highest contiguous seq delivered (0 = none yet; first expected is 1)
    this.pending    = new Map();   // seq -> { data, arrivedAt }
    this.windowMs   = windowMs;
    this.onInOrder  = onInOrder;   // (seq, data) => void — adapter delivers
    this.onGap      = onGap;       // (fromSeq, toSeq) => void — adapter emits __gap__
    this._timer     = null;
  }

  /** Ingest an arriving event with the given sequence number. */
  ingest(seq, data) {
    if (seq <= this.lastSeen) return;                 // stale / duplicate

    if (seq === this.lastSeen + 1) {
      // In-order delivery. Flush any contiguous pending events too.
      this.onInOrder(seq, data);
      this.lastSeen = seq;
      let next = seq + 1;
      while (this.pending.has(next)) {
        const { data: d2 } = this.pending.get(next);
        this.pending.delete(next);
        this.onInOrder(next, d2);
        this.lastSeen = next;
        next++;
      }
      this._maybeClearTimer();
      return;
    }

    // seq > lastSeen + 1 → arrived ahead of a missing predecessor.
    // Hold it and arm the timer if not already running.
    this.pending.set(seq, { data, arrivedAt: Date.now() });
    this._armTimer();
  }

  _armTimer() {
    if (this._timer) return;
    this._timer = setTimeout(() => this._expire(), this.windowMs);
  }

  _maybeClearTimer() {
    if (this._timer && this.pending.size === 0) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _expire() {
    this._timer = null;
    if (this.pending.size === 0) return;

    // Walk pending sequences in order, advancing lastSeen past each gap
    // once the oldest pending event has outlived the window.
    const now = Date.now();
    const seqs = [...this.pending.keys()].sort((a, b) => a - b);
    let stillWaiting = false;

    for (const seq of seqs) {
      const { data, arrivedAt } = this.pending.get(seq);
      if (now - arrivedAt < this.windowMs) {
        // This entry is still inside its window; defer further expirations.
        stillWaiting = true;
        break;
      }
      const gapFrom = this.lastSeen + 1;
      const gapTo   = seq - 1;
      if (gapTo >= gapFrom) this.onGap(gapFrom, gapTo);
      this.onInOrder(seq, data);
      this.pending.delete(seq);
      this.lastSeen = seq;
    }

    if (stillWaiting || this.pending.size > 0) this._armTimer();
  }

  /** Stop all timers — call when adapter shuts down. */
  dispose() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.pending.clear();
  }
}

// ── PubSubAdapter ───────────────────────────────────────────────────────────

export class PubSubAdapter {
  /**
   * @param {Object}  opts
   * @param {Object}  opts.transport        — DHT transport (see contract above)
   * @param {number} [opts.reorderWindowMs] — reorder buffer window (default 100 ms)
   * @param {number} [opts.ringBufferSize]  — publisher-side retention for tier-2 resend
   */
  constructor({ transport, reorderWindowMs = DEFAULT_REORDER_WINDOW_MS, ringBufferSize = DEFAULT_RING_BUFFER_SIZE } = {}) {
    if (!transport) throw Error('PubSubAdapter: transport is required');
    if (!transport.nodeId) throw Error('PubSubAdapter: transport.nodeId is required');

    this.transport      = transport;
    this.nodeId         = String(transport.nodeId);
    this.reorderWindowMs = reorderWindowMs;
    this.ringBufferSize  = ringBufferSize;

    // Local pub/sub engine — subscriber bookkeeping, handler dispatch.
    this.domain = new PubSubDomain();

    // Outbound hook: route serialized actions through the DHT transport.
    this.domain.sendMessage = (json) => this._sendToTransport(json);

    // Inbound hook: the DHT delivers payloads here.
    this.transport.onPubsubDelivery((topicId, json) => this._onDelivery(topicId, json));

    // Per-(domain:event) state.
    //   outSeq[topic]              = next seq to assign when publishing
    //   trackers[topic][senderId]  = SenderSeqTracker
    //   ringBuf[topic]             = Array<{seq, data}> (tier-2, unused for now)
    this.outSeq   = new Map();
    this.trackers = new Map();
    this.ringBuf  = new Map();

    // domain:event -> topicId hash cache.
    this.topicIdCache = new Map();
  }

  // ── Public API — mirrors PubSubNode shape but adapter-scoped ────────────

  /**
   * Subscribe to `domain:event`.
   *
   * @param {String}   domain
   * @param {String}   event
   * @param {Function} callback     (data, meta) => void
   *                                meta = { senderId, seq, domain, event, topicId }
   * @param {Object|"immediate"|"queued"} [options]
   *   If a string, treated as handling mode (backwards-compat).
   *   If an object:
   *     handling: "immediate" | "queued"           default "queued"
   *     onGap:    (info)=>void                     tier-1 per-topic gap handler
   *                                                info = { senderId, fromSeq, toSeq, domain, event }
   */
  subscribe(domain, event, callback, options = 'queued') {
    const handling = typeof options === 'string' ? options : (options.handling || 'queued');
    const onGap    = typeof options === 'string' ? null    : (options.onGap || null);

    // Wrap user callback to strip wire metadata before delivery.
    const wrapped = (payload) => {
      // payload is the inner { data, senderId, seq } unpacked by _onDelivery
      try { callback(payload.data, {
        senderId: payload.senderId, seq: payload.seq,
        domain, event, topicId: this._topicIdFor(domain, event),
      }); } catch (err) {
        console.error(`PubSubAdapter: handler error for ${domain}:${event}`, err);
      }
    };
    wrapped.unbound = callback;

    // Hook per-topic gap listener if the app wants one.
    if (onGap) {
      const gapTopic = `${domain}:${event}`;
      this.domain.addSubscription(GAP_DOMAIN, gapTopic, '__app__', (info) => onGap(info), 'immediate');
    }

    this.domain.addSubscription(domain, event, '__app__', wrapped, handling);

    // Upstream: tell the DHT we're a subscriber for this topic.
    const topicId = this._topicIdFor(domain, event);
    try { this.transport.pubsubSubscribe(topicId); }
    catch (err) { console.warn(`PubSubAdapter: transport.pubsubSubscribe failed for ${domain}:${event}`, err); }
  }

  /**
   * Unsubscribe a previously-registered callback (or all handlers if omitted).
   */
  unsubscribe(domain, event, callback = null) {
    this.domain.removeSubscription(domain, event, '__app__', callback);
    // If the local domain no longer has any handlers for the topic, tell the
    // transport. _subscriptionsFor returns null when the topic is empty.
    const topic = `${domain}:${event}`;
    if (!this.domain.subscriptions[topic]) {
      const topicId = this._topicIdFor(domain, event);
      try { this.transport.pubsubUnsubscribe(topicId); }
      catch (err) { console.warn(`PubSubAdapter: transport.pubsubUnsubscribe failed for ${domain}:${event}`, err); }
    }
  }

  /**
   * Publish an event. Local handlers fire synchronously via the underlying
   * PubSubDomain. The outbound path adds (senderId, seq) and routes via
   * transport.pubsubPublish.
   *
   * v0.70.16 (refactor commit 10) — stays SYNC.  AxonManager's
   * pubsubPublish allocates publishId synchronously and fires the
   * underlying DHT primitives in the background, so we keep the
   * old sync API even though the underlying transport is async.
   */
  publish(domain, event, data) {
    const topic   = `${domain}:${event}`;
    const seq     = (this.outSeq.get(topic) ?? 0) + 1;
    this.outSeq.set(topic, seq);

    // Fire local handlers directly with the wrapped-callback contract:
    // they expect { data, senderId, seq } so metadata is available even for
    // self-delivered events.
    const localPayload = { data, senderId: this.nodeId, seq };
    this._fireLocal(domain, event, localPayload);

    // Retain for tier-2 retransmit (unused until control plane is wired).
    if (this.ringBufferSize > 0) {
      let buf = this.ringBuf.get(topic);
      if (!buf) { buf = []; this.ringBuf.set(topic, buf); }
      buf.push({ seq, data });
      while (buf.length > this.ringBufferSize) buf.shift();
    }

    // Send over the transport. Return the transport-assigned publishId
    // (opaque to the adapter; used by instrumentation that needs to
    // correlate per-publish delivery across subscribers — see the
    // Engine.runMembershipPubSubTick cumulative metric).
    let publishId = null;
    try {
      const json = JSON.stringify({
        action:   'publish',
        domain, event, data,
        senderId: this.nodeId,
        seq,
      });
      const topicId = this._topicIdFor(domain, event);
      publishId = this.transport.pubsubPublish(topicId, json) ?? null;
    } catch (err) {
      console.error(`PubSubAdapter: publish failed for ${domain}:${event}`, err);
    }
    return publishId;
  }

  /** Drain queued handlers (forwards to the underlying domain). */
  processEvents() { return this.domain.processEvents(); }

  /** Tear down all subscriptions and timers. */
  destroy() {
    // Tell the transport we're no longer subscribed to anything. Walk the
    // local subscription table rather than re-hashing from cached keys —
    // this also catches programmatic subscriptions added outside subscribe().
    for (const topic of Object.keys(this.domain.subscriptions)) {
      if (topic.startsWith(GAP_DOMAIN + ':')) continue;  // local-only topic
      const [domain, event] = topic.split(':');
      const topicId = this._topicIdFor(domain, event);
      try { this.transport.pubsubUnsubscribe(topicId); }
      catch (err) { /* transport already gone — fine */ }
    }
    for (const sendersMap of this.trackers.values()) {
      for (const tracker of sendersMap.values()) tracker.dispose();
    }
    this.trackers.clear();
    this.domain.removeAllSubscriptionsFor('__app__');
  }

  // ── Internals ───────────────────────────────────────────────────────────

  _topicIdFor(domain, event) {
    const key = `${domain}:${event}`;
    let id = this.topicIdCache.get(key);
    // Always use the prefix-aware constructor — it degenerates to the
    // legacy topicIdFor() when no '@XX/' sentinel is present, so old
    // callers (NX-15 benchmarks, tests) are byte-for-byte compatible.
    if (!id) { id = topicIdForPrefixed(domain, event); this.topicIdCache.set(key, id); }
    return id;
  }

  /**
   * Called by `domain.sendMessage` — serialized control messages
   * (subscribe/unsubscribe) from the underlying PubSubDomain. Publish
   * payloads do NOT pass through this path because adapter.publish()
   * calls the transport directly (so it can attach seq/senderId).
   */
  _sendToTransport(json) {
    // We need the json only to decide which transport call to make.
    try {
      const parsed = JSON.parse(json);
      if (parsed.action === 'subscribe' || parsed.action === 'unsubscribe') {
        // Already handled in subscribe()/unsubscribe() — no-op here to avoid
        // duplicate transport calls from library-internal bookkeeping.
        return;
      }
      // Legacy publish path (shouldn't occur — we bypass domain.publish).
      if (parsed.action === 'publish') {
        const topicId = this._topicIdFor(parsed.domain, parsed.event);
        this.transport.pubsubPublish(topicId, json);
      }
    } catch (err) {
      console.warn('PubSubAdapter: _sendToTransport parse failure', err);
    }
  }

  /**
   * Called by the DHT transport when a pub/sub payload arrives.
   * Strips the wire envelope, enforces per-sender ordering, and hands
   * the inner payload to the underlying domain.
   */
  _onDelivery(topicId, json) {
    let parsed;
    try { parsed = JSON.parse(json); }
    catch (err) { console.warn('PubSubAdapter: malformed delivery payload', err); return; }

    if (parsed.action !== 'publish') return;
    const { domain, event, data, senderId, seq } = parsed;
    if (!domain || !event || senderId == null || seq == null) {
      console.warn('PubSubAdapter: delivery missing required fields', parsed);
      return;
    }

    // Drop our own publishes if the transport echoes them back.
    if (senderId === this.nodeId) return;

    const topic = `${domain}:${event}`;
    let sendersMap = this.trackers.get(topic);
    if (!sendersMap) { sendersMap = new Map(); this.trackers.set(topic, sendersMap); }

    let tracker = sendersMap.get(senderId);
    if (!tracker) {
      tracker = new SenderSeqTracker({
        windowMs:  this.reorderWindowMs,
        onInOrder: (_seq, d) => this._fireLocal(domain, event, { data: d, senderId, seq: _seq }),
        onGap:     (from, to) => this.domain.publish(GAP_DOMAIN, topic, {
          senderId, fromSeq: from, toSeq: to, domain, event,
        }),
      });
      sendersMap.set(senderId, tracker);
    }

    tracker.ingest(seq, data);
  }

  /**
   * Deliver a fully-resolved publish to local handlers. We route through
   * the domain's internal handler dispatch so immediate/queued semantics
   * are preserved. Wire-level seq/senderId are carried as the "data" so
   * the wrapped callback can unpack them.
   */
  _fireLocal(domain, event, wirePayload) {
    this.domain._handleLocalEvent(domain, event, wirePayload);
  }
}
