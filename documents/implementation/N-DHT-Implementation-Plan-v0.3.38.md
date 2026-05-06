# N-DHT Implementation Plan

## A Complete Specification for Building the Production NH-1 Bootstrap and Routing System

**Document version:** v0.3.38
**Companion to:** NH-1 Whitepaper v0.3.38, Red Team v0.3.38
**Author:** David A. Smith — YZ.social
**Date:** 2026-04-30
**Target deployment:** Mobile (iOS/Android), browser, and server-class peers

---

## Front Matter

### Purpose

This document specifies the complete implementation of the N-DHT system as a deployable platform. It is intended for engineers who will build the protocol library, the supporting infrastructure (connection servers, bootstrap servers, monitoring), and the reference application. After reading this document, an engineering team should have unambiguous direction on:

- What modules need to exist
- What each module is responsible for
- What APIs each module exposes
- What state is persisted, where, and how
- What network protocols are spoken
- What infrastructure is required
- In what order to build and validate everything

The goal is a system that **applications can integrate into seamlessly** — drop in a library, configure an entry point, and the app is part of the network. This requires a clean separation between protocol logic and application concerns.

### Scope

This document covers:

- **The protocol library** — `nh1-core`, the routing and pub/sub engine
- **The transport layer** — `nh1-transport`, abstracting WebRTC, WebSockets, libp2p
- **The persistence layer** — `nh1-storage`, abstracting platform-specific storage
- **The bootstrap subsystem** — `nh1-bootstrap`, sponsor flow + hardcoded servers + QR
- **The cryptographic layer** — `nh1-crypto`, Ed25519, signatures, key management
- **The infrastructure** — bootstrap servers, TURN relays, monitoring backends
- **The reference application** — `nh1-demo`, validating the integration path
- **The development sequence** — build order, validation gates, deployment milestones

This document does **not** cover:

- The detailed mathematics of the NH-1 routing algorithm (see whitepaper §3-5)
- The simulator (`dht-sim`) — that is a research artifact, not a deployment artifact
- Application-level features built on top (chat UX, social graphs, content discovery)
- Operational runbooks beyond the build phase (see whitepaper §13 for steady-state ops)

### Non-Negotiable Design Principles

These principles drive every architectural decision below:

1. **The protocol library is platform-agnostic.** Core logic ships as portable code (TypeScript, with bindings) that runs identically on Node.js, browsers, iOS (via WebKit JS bridge or native port), and Android (similar).

2. **Every layer has a clean interface.** Transport, storage, crypto are *abstractions*; the protocol depends on the interface, not the implementation. This is what makes mobile and browser deployments possible from a single core.

3. **Persistence is mandatory, not optional.** Every node persists its synaptome and identity by default. Sessions resume; they do not restart.

4. **Cryptographic verification is non-skippable.** Every peer-to-peer message is signed; every signature is verified. There is no "trust mode" that bypasses signatures.

5. **Failure modes are first-class.** Every operation has explicit timeout, retry, and fallback. The system degrades gracefully.

6. **Observability is built-in, not bolted-on.** Every operation emits structured events; metrics are produced from those events; no separate instrumentation layer is needed.

7. **The integration surface is small.** An application embeds the library by initializing one object and calling 4-5 methods. The library handles everything else.

### Intended Reader

This document assumes the reader is:
- Familiar with the NH-1 whitepaper (especially §3-6: foundational mechanics, vitality model, axonal pub/sub)
- Familiar with the red team document (especially Issues #1-4: friction items)
- Comfortable with TypeScript, async/await, cryptographic primitives, and distributed systems concepts
- Building either the protocol library, the infrastructure, or an application on top of it

### Document Structure

| Section | Content |
|---|---|
| **1. System Architecture Overview** | The 7-layer stack, module responsibilities, dependency graph |
| **2. The Protocol Library: `nh1-core`** | Routing, pub/sub, learning rules — the brain |
| **3. The Transport Layer: `nh1-transport`** | WebRTC, WebSocket, libp2p abstractions |
| **4. The Persistence Layer: `nh1-storage`** | Platform-specific storage adapters |
| **5. The Cryptographic Layer: `nh1-crypto`** | Keys, signatures, hashes, secure random |
| **6. The Bootstrap Subsystem: `nh1-bootstrap`** | Sponsor flow, QR codes, fallback servers |
| **7. The Application API: `nh1-app`** | The integration surface for application developers |
| **8. Infrastructure Components** | Bootstrap servers, TURN relays, monitoring |
| **9. Wire Protocol Specification** | Message formats, encoding, signatures |
| **10. State Persistence Format** | Disk schemas, migration, integrity |
| **11. Development Sequence** | Build order, validation gates, milestones |
| **12. Testing Strategy** | Unit, integration, simulation, deployment |
| **13. Deployment Phases** | Testnet, staging, limited release, production |
| **14. Reference Application** | The integration validator |
| **15. Operational Handoff** | What ops needs from engineering |

---

## 1. System Architecture Overview

### 1.1 The Seven-Layer Stack

```
┌───────────────────────────────────────────────────────┐
│  Layer 7: Application                                 │
│  (User-facing app: chat, social, file-share, etc.)    │
└───────────────────────────────────────────────────────┘
                           ▲
                           │ uses
                           ▼
┌───────────────────────────────────────────────────────┐
│  Layer 6: Application API (`nh1-app`)                 │
│  Public API surface: connect(), publish(), subscribe()│
└───────────────────────────────────────────────────────┘
                           ▲
                           │ orchestrates
                           ▼
┌───────────────────────────────────────────────────────┐
│  Layer 5: Protocol Core (`nh1-core`)                  │
│  Routing, pub/sub, learning, axonal trees             │
└───────────────────────────────────────────────────────┘
        ▲             ▲             ▲             ▲
        │             │             │             │
        ▼             ▼             ▼             ▼
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ Layer 4  │  │ Layer 3  │  │ Layer 2  │  │ Layer 1  │
│ Bootstrap│  │ Transport│  │ Storage  │  │ Crypto   │
│ Sponsor  │  │ WebRTC,  │  │ Platform-│  │ Ed25519, │
│ flow,    │  │ WebSocket│  │ specific │  │ Blake3,  │
│ QR codes │  │ libp2p   │  │ disk +   │  │ HMAC     │
│          │  │          │  │ keychain │  │          │
└──────────┘  └──────────┘  └──────────┘  └──────────┘
```

**Layer rules:**
- Higher layers may depend on lower layers
- Layers do not skip (e.g., `nh1-app` does not directly call `nh1-crypto`; it goes through `nh1-core`)
- Within a layer, modules are siblings — they may be aware of each other but should not have hard dependencies
- The transport, storage, and crypto layers are *interfaces with adapter implementations*. The protocol depends only on the interfaces.

### 1.2 Module Inventory

| Module | Layer | Lines (est.) | Owns |
|---|---|---:|---|
| `nh1-crypto` | 1 | 800 | Ed25519 keypairs, signatures, Blake3, HMAC, secure RNG |
| `nh1-storage` | 2 | 1200 | Platform-specific disk + keychain adapters |
| `nh1-transport` | 3 | 2500 | WebRTC, WebSocket, libp2p adapters |
| `nh1-bootstrap` | 4 | 1500 | Sponsor flow, QR generation/parsing, hardcoded fallback |
| `nh1-core` | 5 | 4000 | Synaptome, AP routing, axonal tree, vitality, learning |
| `nh1-app` | 6 | 800 | Public API, lifecycle hooks, observability events |
| `nh1-demo` | 7 | 2000 | Reference chat application validating integration |
| **Total** | | **~12,800** | |

For comparison, the simulator's NH-1 is ~270 lines. The 4000-line estimate for `nh1-core` reflects the production reality: error handling, observability, persistence integration, telemetry, edge cases that the simulator does not face.

### 1.3 The Integration Surface

An application using NH-1 sees this much code:

```typescript
import { NH1App } from '@yz-social/nh1-app';

const app = new NH1App({
  identity: 'auto',              // Generate or load from disk
  bootstrap: 'auto',             // Use stored sponsor or fallback to hardcoded
  storage: 'platform-default',   // Use platform-appropriate storage
  observability: 'console',      // Or 'metrics-endpoint', 'silent'
});

await app.connect();             // Joins the network — blocking until ready

// Publish to a topic
await app.publish('chat.general', { text: 'hello world' });

// Subscribe to a topic
app.subscribe('chat.general', (message) => {
  console.log('Received:', message);
});

// Lookup a peer
const result = await app.lookup(peerId);

// Disconnect (automatic on process exit)
await app.disconnect();
```

**That's it.** Six methods: `connect`, `publish`, `subscribe`, `unsubscribe`, `lookup`, `disconnect`. Everything else — the synaptome, the learning, the axonal tree, the bootstrap, the persistence — is hidden.

This is the design target. If an application developer has to think about synapses, vitality, or temperature, the abstraction has failed.

---

## 2. The Protocol Library: `nh1-core`

### 2.1 Responsibilities

`nh1-core` owns the routing logic. It is the implementation of the NH-1 protocol from the whitepaper, adapted for production constraints:

- The synaptome data structure
- AP routing with two-hop lookahead and iterative fallback
- All five learning operations (LTP, hop caching, triadic closure, incoming promotion, annealing)
- Vitality-based eviction
- Temperature management
- Axonal tree construction and delivery
- Replay cache for pub/sub history

It does **not** own:
- Network I/O (delegated to `nh1-transport`)
- Disk I/O (delegated to `nh1-storage`)
- Cryptographic operations (delegated to `nh1-crypto`)
- Bootstrap orchestration (delegated to `nh1-bootstrap`)

### 2.2 Public Interface

```typescript
// Main core class — everything else lives inside
class NH1Core {
  // Initialization
  constructor(opts: NH1CoreOptions);
  
  // Lifecycle
  async start(): Promise<void>;
  async stop(): Promise<void>;
  
  // Routing
  async lookup(targetId: NodeId): Promise<LookupResult>;
  async route(targetId: NodeId, payload: Bytes): Promise<RouteResult>;
  
  // Pub/sub
  async publish(topicId: TopicId, message: Bytes): Promise<PublishResult>;
  async subscribe(topicId: TopicId, handler: SubscribeHandler): Promise<Subscription>;
  async unsubscribe(subscription: Subscription): Promise<void>;
  
  // Synapse management (internal, exposed for diagnostics)
  getSynaptomeSize(): number;
  getSynaptomeStats(): SynaptomeStats;
  
  // Inspection (for tests and observability)
  on(event: NH1CoreEvent, handler: (data: any) => void): void;
  off(event: NH1CoreEvent, handler: (data: any) => void): void;
}

interface NH1CoreOptions {
  myNodeId: NodeId;
  myPublicKey: PublicKey;
  myPrivateKey: PrivateKey;          // Used for signing only
  s2Cell: S2Cell;
  
  transport: ITransport;              // Injected
  storage: IStorage;                  // Injected
  crypto: ICrypto;                    // Injected
  
  parameters: NH1Parameters;          // 12 protocol parameters
  highwayMode: boolean;               // True if server-class capacity
}
```

### 2.3 Internal Module Structure

```
nh1-core/
├── src/
│   ├── index.ts                    // NH1Core class
│   ├── synaptome/
│   │   ├── Synapse.ts              // Synapse data structure
│   │   ├── Synaptome.ts            // Bounded collection of synapses
│   │   ├── vitality.ts             // _addByVitality, vitality scoring
│   │   ├── stratification.ts       // XOR stratum calculation
│   │   └── persistence.ts          // Serialize/deserialize
│   ├── routing/
│   │   ├── ap-scoring.ts           // Action Potential formula
│   │   ├── two-hop-lookahead.ts    // Look-ahead probe logic
│   │   ├── iterative-fallback.ts   // Greedy-fail fallback
│   │   ├── lookup.ts               // Top-level lookup state machine
│   │   └── route.ts                // General-purpose routing
│   ├── learning/
│   │   ├── ltp.ts                  // Long-Term Potentiation reinforcement
│   │   ├── hop-cache.ts            // Hop caching + lateral spread
│   │   ├── triadic-closure.ts      // Co-transit detection + introduction
│   │   ├── incoming-promotion.ts   // Promote useful incoming peers
│   │   └── annealing.ts            // Temperature management
│   ├── axonal/
│   │   ├── topic-id.ts             // Deterministic topic ID derivation
│   │   ├── tree.ts                 // Axonal tree construction
│   │   ├── delivery.ts             // Publish fan-out via tree
│   │   ├── re-subscribe.ts         // Periodic refresh
│   │   ├── replay-cache.ts         // Bounded ring buffer per topic
│   │   └── publisher-auth.ts       // Publisher signature verification
│   ├── network/
│   │   ├── liveness.ts             // Probing, suspicion, dead-peer detection
│   │   ├── timeouts.ts             // RPC timeout management
│   │   └── connection-state.ts     // Pending/Connecting/Ready state
│   ├── parameters/
│   │   ├── defaults.ts             // The 12 parameter defaults
│   │   └── adapters.ts             // Per-node adaptation (Issue #6)
│   ├── observability/
│   │   ├── events.ts               // Event types
│   │   ├── metrics.ts              // Metric aggregation
│   │   └── tracing.ts              // Distributed trace context
│   └── types/
│       ├── ids.ts                  // NodeId, TopicId, PeerId types
│       └── messages.ts             // Wire message types
└── tests/
    └── ...
```

### 2.4 Key Data Structures

**Synapse** (the heart of the protocol):

```typescript
interface Synapse {
  // Identity
  peerId: NodeId;                    // Target peer's Node ID
  publicKey: PublicKey;              // Target's public key (for verifying signatures)
  s2Cell: S2Cell;                    // Target's claimed location
  
  // Learned state
  weight: number;                    // [0.0, 1.0] — LTP-reinforced
  latencyEMA: number;                // Milliseconds — exponential moving average
  latencyVar: number;                // Variance for jitter handling (Issue #4)
  stratum: number;                   // XOR distance band [0-63]
  
  // Recency
  lastSuccessfulUse: number;         // Unix ms
  lastAttemptedUse: number;          // Unix ms (even on failure)
  consecutiveFailures: number;       // For dead-peer detection
  
  // Lifecycle
  createdAt: number;                 // When first added
  inertiaUntil: number;              // Eviction-protected until this epoch
  source: SynapseSource;             // bootstrap, sponsor, hop-cache, triadic, incoming
  
  // Connection state (for friction handling — Issue #1)
  connectionState: ConnectionState;  // PENDING, CONNECTING, READY, FAILED, CLOSED
  pendingSince: number;              // When CONNECTING began
  
  // Reputation (for Byzantine resistance — Issue #5)
  reputation: number;                // [0.0, 1.0]
  badSignatures: number;             // Cumulative signature failures
  
  // Asymmetric reachability (Issue #8)
  forwardReachable: boolean;
  reverseReachable: boolean;
  
  // Metadata
  totalSuccessfulUses: number;
  totalAttempts: number;
}

enum ConnectionState {
  PENDING = 'pending',           // Not yet attempted
  CONNECTING = 'connecting',     // Setup in progress
  READY = 'ready',               // Usable for routing
  FAILED = 'failed',             // Setup failed
  CLOSED = 'closed',             // Was ready, now closed
}

enum SynapseSource {
  BOOTSTRAP = 'bootstrap',
  SPONSOR_SNAPSHOT = 'sponsor_snapshot',
  HOP_CACHE = 'hop_cache',
  TRIADIC_CLOSURE = 'triadic_closure',
  INCOMING_PROMOTION = 'incoming_promotion',
  ANNEALING = 'annealing',
  PERSISTED = 'persisted',
}
```

The **vitality** function and admission gate:

```typescript
function vitality(s: Synapse, now: number, params: NH1Parameters): number {
  // Decay-based recency
  const timeSinceUse = now - s.lastSuccessfulUse;
  const recency = Math.exp(-timeSinceUse / params.RECENCY_HALF_LIFE);
  
  // Connection state factor (Issue #1)
  const connectionFactor = 
    s.connectionState === ConnectionState.READY ? 1.0 :
    s.connectionState === ConnectionState.CONNECTING ? 0.3 :
    0.0;
  
  // Reputation factor (Issue #5)
  const reputationFactor = s.reputation;
  
  // Inertia (LTP-locked synapses get a boost)
  const inertiaBoost = (now < s.inertiaUntil) ? 1.5 : 1.0;
  
  // Failure penalty
  const failurePenalty = s.consecutiveFailures > 3 ? 0.1 : 1.0;
  
  return s.weight * recency * connectionFactor * reputationFactor * inertiaBoost * failurePenalty;
}

function _addByVitality(synaptome: Synaptome, newSyn: Synapse, now: number): boolean {
  if (synaptome.size < synaptome.maxSize) {
    synaptome.add(newSyn);
    return true;
  }
  
  // Find lowest-vitality non-locked synapse
  const newVitality = vitality(newSyn, now);
  let weakest = null;
  let weakestVitality = Infinity;
  
  for (const s of synaptome) {
    if (s.inertiaUntil > now) continue;  // Locked, can't evict
    const v = vitality(s, now);
    if (v < weakestVitality) {
      weakest = s;
      weakestVitality = v;
    }
  }
  
  // Only evict if new is better
  if (weakest && newVitality > weakestVitality) {
    synaptome.remove(weakest);
    synaptome.add(newSyn);
    return true;
  }
  
  return false;  // Refused
}
```

### 2.5 Implementation Notes

**Concurrency model:** All `nh1-core` operations are async. The library uses a single logical event loop per `NH1Core` instance. State mutations are serialized through an internal command queue to prevent race conditions on synaptome updates.

**Memory model:** A single synaptome at 50 synapses occupies ~25 KB (each synapse ~500 bytes after overhead). Replay caches per topic at 100 messages × 1 KB = 100 KB per topic. A typical app subscribed to 5 topics: ~525 KB total state. Acceptable for mobile.

**CPU model:** Per-lookup cost is O(synaptome.size) for AP scoring + O(LOOKAHEAD_ALPHA × synaptome.size) for two-hop. At 50 synapses and α=5: ~250 score evaluations per lookup, each ~5 microseconds, total ~1.25 ms. Well within mobile budget.

**Error handling:** Every async operation has explicit error handling. Errors propagate via typed result objects (`{ ok: true, value: X }` / `{ ok: false, error: E }`), not exceptions, except for unrecoverable bugs.

---

## 3. The Transport Layer: `nh1-transport`

### 3.1 Responsibilities

`nh1-transport` abstracts away the differences between transport protocols. The protocol core doesn't care whether it's talking via WebRTC, WebSocket, or libp2p — it sees the same interface.

The transport layer is responsible for:
- Establishing connections to peers
- Sending and receiving messages
- Detecting connection failures
- Measuring latency (RTT)
- Handling NAT traversal (where applicable)
- Implementing setup-throttling (Issue #1, #12)

### 3.2 The Transport Interface

```typescript
interface ITransport {
  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;
  
  // Connection management
  connect(peer: PeerEndpoint): Promise<Connection>;
  disconnect(connection: Connection): Promise<void>;
  
  // Message I/O
  send(connection: Connection, message: Bytes): Promise<void>;
  
  // Listeners
  onMessage(handler: (connection: Connection, message: Bytes) => void): void;
  onConnect(handler: (connection: Connection) => void): void;
  onDisconnect(handler: (connection: Connection, reason: string) => void): void;
  
  // Liveness
  ping(connection: Connection, timeoutMs: number): Promise<{ rtt: number }>;
  
  // Diagnostics
  getStats(): TransportStats;
}

interface PeerEndpoint {
  peerId: NodeId;
  addresses: PeerAddress[];          // List of candidate addresses
}

interface PeerAddress {
  protocol: 'webrtc' | 'websocket' | 'libp2p-tcp' | 'libp2p-quic' | 'relay';
  endpoint: string;                  // URL or multiaddr
  hint?: string;                     // E.g., ICE candidate, mDNS hostname
}
```

### 3.3 Adapter Implementations

#### 3.3.1 WebRTC Adapter

The default browser/mobile adapter:

```typescript
class WebRTCTransport implements ITransport {
  private connections: Map<NodeId, RTCPeerConnection> = new Map();
  private dataChannels: Map<NodeId, RTCDataChannel> = new Map();
  private setupQueue: SetupQueue;     // Concurrency control (Issue #12)
  
  async connect(peer: PeerEndpoint): Promise<Connection> {
    return this.setupQueue.enqueue(async () => {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      
      // ICE gathering — this is the slow part (Issue #1)
      // Uses Trickle ICE for faster setup
      
      // DTLS handshake
      // Data channel creation
      
      // ... full WebRTC setup
      
      return new Connection(peer.peerId, pc);
    });
  }
  
  // ... rest of interface
}

class SetupQueue {
  // Bounded concurrency to prevent connection storm (Issue #12)
  private maxConcurrent: number;
  private inFlight: number = 0;
  private queue: Array<() => Promise<void>> = [];
  
  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }
  
  async enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.inFlight < this.maxConcurrent) {
      return this.runImmediate(work);
    }
    
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await work());
        } catch (e) {
          reject(e);
        }
      });
    });
  }
  
  private async runImmediate<T>(work: () => Promise<T>): Promise<T> {
    this.inFlight++;
    try {
      return await work();
    } finally {
      this.inFlight--;
      this.checkQueue();
    }
  }
  
  private checkQueue() {
    while (this.queue.length > 0 && this.inFlight < this.maxConcurrent) {
      const task = this.queue.shift()!;
      this.inFlight++;
      task().finally(() => {
        this.inFlight--;
        this.checkQueue();
      });
    }
  }
}
```

**Browser concurrency caps** (Issue #12):

```typescript
function getConcurrencyCap(): number {
  // Detect browser environment
  if (isMobileSafari) return 2;
  if (isChromeMobile) return 2;
  if (isFirefoxMobile) return 2;
  if (isMobileBrowser) return 2;       // Generic mobile
  
  if (isChromeDesktop) return 4;
  if (isFirefoxDesktop) return 4;
  if (isSafariDesktop) return 4;
  
  return 4;                             // Default desktop
}
```

#### 3.3.2 WebSocket Adapter

Used as a fallback when direct P2P (WebRTC) fails, or for relay-mediated connections:

```typescript
class WebSocketTransport implements ITransport {
  // Direct connection via relay server
  // Used for clients that can't establish direct WebRTC due to NAT
  
  async connect(peer: PeerEndpoint): Promise<Connection> {
    const relayUrl = peer.addresses.find(a => a.protocol === 'relay')?.endpoint;
    if (!relayUrl) throw new Error('No relay address');
    
    const ws = new WebSocket(relayUrl);
    
    // Wait for relay handshake
    await this.relayHandshake(ws, peer.peerId);
    
    return new Connection(peer.peerId, ws);
  }
}
```

#### 3.3.3 libp2p Adapter

Used for the production deployment in `yz.p2pnetwork`:

```typescript
class LibP2PTransport implements ITransport {
  private node: Libp2p;
  
  constructor(libp2pInstance: Libp2p) {
    this.node = libp2pInstance;
  }
  
  async connect(peer: PeerEndpoint): Promise<Connection> {
    const multiaddr = peer.addresses.find(a => a.protocol.startsWith('libp2p'))?.endpoint;
    const stream = await this.node.dialProtocol(
      multiaddrFromString(multiaddr!),
      '/nh1/1.0.0'
    );
    return new Connection(peer.peerId, stream);
  }
}
```

### 3.4 Connection State Machine

The transport tracks each connection through a clear state machine:

```
    NEW
     │
     ▼
  GATHERING ──────┐
     │            │
     │            ▼
     │         FAILED
     │            
     ▼
  CONNECTING ────┐
     │           │
     │           ▼
     │        FAILED
     │
     ▼
   READY ──────► CLOSING ──► CLOSED
     ▲             ▲
     │             │
     ▼             │
   STALE ─────────►
     (no recent activity)
```

**State transitions:**
- `NEW`: Just created, no work begun
- `GATHERING`: ICE candidates being collected (WebRTC) or DNS resolution
- `CONNECTING`: Actively establishing transport
- `READY`: Usable for sending messages
- `STALE`: No recent activity, likely needs reconnection
- `CLOSING`: Graceful close in progress
- `CLOSED`: Done, no longer usable
- `FAILED`: Setup failed; the synapse should be marked dead

### 3.5 Implementation Notes

**RPC timeout handling (Issue #2):** Every send is wrapped with an explicit timeout. If no response within `RPC_TIMEOUT_MS = 3000`, the connection is marked SUSPECTED and the synapse's suspicion count increases.

**RTT measurement:** Each ping/pong exchange records the round-trip time. The transport reports the raw RTT; `nh1-core` integrates it into the synapse's `latencyEMA` via exponential moving average.

**Connection multiplexing:** A single transport connection (e.g., one WebRTC peer connection) carries all messages between two nodes — lookups, publishes, probes, axonal tree messages. The transport doesn't know what these messages mean; it just delivers bytes.

**Message framing:** All transports use length-prefixed framing for messages: `[4 bytes length][N bytes payload]`. This is uniform across WebRTC, WebSocket, libp2p.

---

## 4. The Persistence Layer: `nh1-storage`

### 4.1 Responsibilities

`nh1-storage` abstracts platform-specific storage. On iOS, it uses Core Data + Keychain. On Android, EncryptedSharedPreferences + KeyStore. On browsers, IndexedDB + Web Crypto API. On Node.js, filesystem + OS keychain.

The protocol core writes structured data; the storage layer makes it durable and recoverable.

### 4.2 The Storage Interface

```typescript
interface IStorage {
  // Lifecycle
  open(): Promise<void>;
  close(): Promise<void>;
  
  // Synaptome persistence
  saveSynaptome(synaptome: SerializedSynaptome): Promise<void>;
  loadSynaptome(): Promise<SerializedSynaptome | null>;
  
  // Identity persistence
  saveIdentity(identity: IdentityRecord): Promise<void>;
  loadIdentity(): Promise<IdentityRecord | null>;
  
  // Replay caches per topic
  saveReplayCache(topicId: TopicId, cache: SerializedReplayCache): Promise<void>;
  loadReplayCache(topicId: TopicId): Promise<SerializedReplayCache | null>;
  
  // Subscriptions
  saveSubscriptions(subscriptions: Subscription[]): Promise<void>;
  loadSubscriptions(): Promise<Subscription[]>;
  
  // Atomic operations
  saveAtomicState(state: NodeState): Promise<void>;
  loadAtomicState(): Promise<NodeState | null>;
  
  // Maintenance
  vacuum(): Promise<void>;
  
  // Debug
  getStorageStats(): StorageStats;
}
```

### 4.3 Schema

#### 4.3.1 NodeState

```typescript
interface NodeState {
  version: 1;                          // Schema version, for migrations
  identity: IdentityRecord;
  synaptome: SerializedSynaptome;
  axonalRoles: AxonalRole[];          // Topics this node is an axon for
  subscriptions: Subscription[];
  
  // Temperature and exploration state
  temperature: number;
  temperatureUpdatedAt: number;
  
  // Session counters
  totalLookups: number;
  totalLookupSuccesses: number;
  totalLTPEvents: number;
  
  // Network observations
  estimatedNetworkSize: number;
  lastBootstrapAt: number;
  lastNetworkChangeAt: number;
  
  // Integrity
  serializedAt: number;                // Unix ms
  hmac: string;                        // HMAC-SHA256 of serialized contents
}
```

#### 4.3.2 IdentityRecord

```typescript
interface IdentityRecord {
  nodeId: NodeId;                      // Public, derived from publicKey + s2Cell
  publicKey: string;                   // Hex-encoded Ed25519 public key
  // privateKey is NOT in this record — stored in Keychain separately
  s2Cell: string;                      // Hex-encoded S2 cell ID
  createdAt: number;                   // Unix ms
}
```

#### 4.3.3 SerializedSynaptome

```typescript
interface SerializedSynaptome {
  synapses: SerializedSynapse[];      // Array of all synapses
  capacity: number;                    // Max size (50 default)
  highwayMode: boolean;
}

interface SerializedSynapse {
  peerId: string;
  publicKey: string;
  s2Cell: string;
  weight: number;
  latencyEMA: number;
  latencyVar: number;
  stratum: number;
  
  lastSuccessfulUse: number;
  lastAttemptedUse: number;
  consecutiveFailures: number;
  
  createdAt: number;
  inertiaUntil: number;
  source: string;
  
  reputation: number;
  badSignatures: number;
  
  forwardReachable: boolean;
  reverseReachable: boolean;
  
  totalSuccessfulUses: number;
  totalAttempts: number;
}
```

### 4.4 Adapter Implementations

#### 4.4.1 Browser (IndexedDB)

```typescript
class BrowserStorage implements IStorage {
  private db: IDBDatabase | null = null;
  
  async open(): Promise<void> {
    this.db = await openIndexedDB('nh1-storage', 1, (db) => {
      db.createObjectStore('synaptome', { keyPath: 'id' });
      db.createObjectStore('identity', { keyPath: 'id' });
      db.createObjectStore('replayCaches', { keyPath: 'topicId' });
      db.createObjectStore('subscriptions', { keyPath: 'id' });
    });
  }
  
  async saveSynaptome(synaptome: SerializedSynaptome): Promise<void> {
    const tx = this.db!.transaction('synaptome', 'readwrite');
    const store = tx.objectStore('synaptome');
    await promiseFromIDBRequest(store.put({ id: 'main', ...synaptome }));
    await promiseFromIDBRequest(tx.complete);
  }
  
  // ... rest of interface
}
```

#### 4.4.2 iOS (CoreData + Keychain)

```typescript
// JS bridge to native iOS storage
class IOSStorage implements IStorage {
  private bridge: NSObject;            // Native bridge object
  
  async open(): Promise<void> {
    // Sets up CoreData stack
    await this.bridge.callMethod('openStorage');
  }
  
  async saveSynaptome(synaptome: SerializedSynaptome): Promise<void> {
    // Serialize to JSON
    const json = JSON.stringify(synaptome);
    
    // Write to CoreData (encrypted at rest by iOS)
    await this.bridge.callMethod('saveSynaptome', { json });
  }
}
```

#### 4.4.3 Node.js (Filesystem)

```typescript
class FilesystemStorage implements IStorage {
  private storageDir: string;
  
  constructor(storageDir: string) {
    this.storageDir = storageDir;
  }
  
  async open(): Promise<void> {
    await fs.mkdir(this.storageDir, { recursive: true });
  }
  
  async saveSynaptome(synaptome: SerializedSynaptome): Promise<void> {
    const path = path.join(this.storageDir, 'synaptome.json');
    const tempPath = path + '.tmp';
    
    // Write to temp file then rename (atomic)
    await fs.writeFile(tempPath, JSON.stringify(synaptome));
    await fs.rename(tempPath, path);
  }
}
```

### 4.5 Integrity and Migration

**Integrity:** Every saved file includes an HMAC-SHA256 computed over its contents using a key derived from the node's private key. On load, the HMAC is verified. Tampered or corrupted files are rejected; the system falls back to bootstrap.

**Migration:** The `version` field in `NodeState` allows schema migrations. When loading, if `version` doesn't match the current code, run migration logic. For now, version 1; future versions might add fields without breaking compatibility.

**Atomicity:** Saves use the temp-file-then-rename pattern (or transactional equivalent) to ensure the file is never half-written. If the save crashes mid-operation, the previous version is intact.

---

## 5. The Cryptographic Layer: `nh1-crypto`

### 5.1 Responsibilities

`nh1-crypto` provides cryptographic primitives. Every signature, hash, and random number used by the protocol comes through this layer.

The reasons to abstract: different platforms have different best-available implementations (libsodium on iOS, Web Crypto on browsers, libsodium-wasm in Node.js). The protocol depends on the interface, not the implementation.

### 5.2 The Crypto Interface

```typescript
interface ICrypto {
  // Random
  randomBytes(n: number): Promise<Bytes>;
  randomUUID(): string;
  
  // Hashing
  blake3(data: Bytes): Promise<Hash>;
  sha256(data: Bytes): Promise<Hash>;
  hmacSha256(key: Bytes, data: Bytes): Promise<Hash>;
  
  // Ed25519 signatures
  generateKeypair(): Promise<{ publicKey: Bytes; privateKey: Bytes }>;
  sign(privateKey: Bytes, data: Bytes): Promise<Signature>;
  verify(publicKey: Bytes, data: Bytes, signature: Signature): Promise<boolean>;
  
  // Key derivation (e.g., from a phrase or passcode)
  deriveKey(salt: Bytes, password: string): Promise<Bytes>;
  
  // Symmetric encryption (for e2e message bodies, optional)
  encrypt(key: Bytes, plaintext: Bytes): Promise<Bytes>;
  decrypt(key: Bytes, ciphertext: Bytes): Promise<Bytes>;
}
```

### 5.3 Adapter Implementations

```typescript
class WebCryptoAdapter implements ICrypto {
  // Uses browser's window.crypto / Node's webcrypto
  async generateKeypair(): Promise<{ publicKey: Bytes; privateKey: Bytes }> {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,  // Extractable
      ['sign', 'verify']
    );
    return {
      publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)),
      privateKey: new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.privateKey)),
    };
  }
  // ... rest
}

class LibsodiumAdapter implements ICrypto {
  // Uses libsodium-wrappers for Node and platforms without WebCrypto Ed25519
  async generateKeypair(): Promise<{ publicKey: Bytes; privateKey: Bytes }> {
    const keypair = sodium.crypto_sign_keypair();
    return { publicKey: keypair.publicKey, privateKey: keypair.privateKey };
  }
}

class IOSCryptoAdapter implements ICrypto {
  // Native iOS bridge using CryptoKit
  async generateKeypair(): Promise<{ publicKey: Bytes; privateKey: Bytes }> {
    return await this.bridge.callMethod('generateKeypair');
  }
}
```

### 5.4 Performance Notes

- Ed25519 signing: ~50 microseconds per signature on mobile
- Ed25519 verification: ~150 microseconds per verification
- Blake3 hashing: ~5 microseconds for typical message sizes
- Key generation: ~1 ms

For a typical NH-1 deployment, signing happens on every outbound message and verification on every inbound message. At 100 lookups/min, that's ~200 cryptographic operations per minute = trivial CPU cost.

---

## 6. The Bootstrap Subsystem: `nh1-bootstrap`

### 6.1 Responsibilities

`nh1-bootstrap` orchestrates the join process. It owns:
- QR code generation and parsing
- Sponsor flow (peer-to-peer bootstrap)
- Hardcoded bootstrap server fallback
- Token validation and consumption
- Synaptome snapshot exchange

It does **not** own the synaptome itself; it produces a populated synaptome that `nh1-core` then takes over.

### 6.2 The Bootstrap Interface

```typescript
interface IBootstrap {
  // Identity setup
  generateOrLoadIdentity(): Promise<IdentityRecord>;
  
  // QR code operations
  generateInviteQR(token: InviteToken): Promise<QRCodeData>;
  parseInviteQR(qrData: string): Promise<InviteData>;
  
  // Bootstrap operations
  bootstrapFromInvite(invite: InviteData): Promise<BootstrapResult>;
  bootstrapFromHardcoded(): Promise<BootstrapResult>;
  bootstrapFromPersisted(): Promise<BootstrapResult | null>;
  
  // Sponsor operations (for nodes that have already joined)
  acceptSponsorRequest(request: BootstrapRequest): Promise<BootstrapResponse>;
  generateInviteToken(opts: InviteOptions): Promise<InviteToken>;
  revokeInviteToken(token: InviteToken): Promise<void>;
  
  // Diagnostics
  getBootstrapState(): BootstrapState;
}
```

### 6.3 The QR Code Format

QR codes contain a URL with these fields:

```
nh1://join?
  sponsor=<base58-encoded NodeId>
  pubkey=<base58-encoded public key>
  s2cell=<hex S2 cell ID>
  conninfo=<base64-encoded connection info>
  token=<base58-encoded invite token>
  sig=<base58-encoded signature>
  
  optional:
  expires=<Unix timestamp>
  use_count=<max uses, default 1>
```

The signature is over `sponsor || pubkey || s2cell || conninfo || token || expires || use_count`.

The `nh1://` URI scheme is registered by the app for deep-linking, allowing scan → app handoff.

### 6.4 The Sponsor Flow Wire Protocol

When you scan a QR code:

```
Step 1: Parse QR
  - Decode URL
  - Extract sponsor, pubkey, s2cell, conninfo, token, sig
  - Validate signature: Ed25519_verify(sponsor.pubkey, [signed_data], sig)
  - Check expires (if present)
  
Step 2: Connect to sponsor
  - Try direct connection via conninfo
  - If fails, try relay if hint provided
  - Establish encrypted transport
  - Verify sponsor's public key matches the one in QR
  
Step 3: Send BOOTSTRAP_REQUEST
  Message format:
  {
    type: "BOOTSTRAP_REQUEST",
    version: 1,
    fromNodeId: <my NodeId>,
    fromPublicKey: <my public key>,
    fromS2Cell: <my S2 cell>,
    token: <token from QR>,
    timestamp: <Unix ms>,
    nonce: <random 16 bytes>,
    signature: Ed25519_sign(my_priv, ...above fields)
  }

Step 4: Sponsor processes request
  - Verify token hasn't been consumed
  - Mark token as consumed (atomic operation)
  - Verify timestamp is recent
  - Verify signature
  - Generate response

Step 5: Receive BOOTSTRAP_RESPONSE
  Message format:
  {
    type: "BOOTSTRAP_RESPONSE",
    version: 1,
    fromNodeId: <sponsor NodeId>,
    timestamp: <Unix ms>,
    synaptome: [
      {
        peerId: ...,
        publicKey: ...,
        s2Cell: ...,
        weight: ...,
        latency: ...,
        stratum: ...,
        lastSeen: ...,
        signature: <signed by sponsor>
      },
      ... 49 more
    ],
    serverMetadata: {
      estimatedNetworkSize: ...,
      timestamp: ...,
      signature: <signed by sponsor>
    },
    signature: Ed25519_sign(sponsor_priv, ...everything above)
  }

Step 6: Validate response
  - Verify outer signature using sponsor's public key
  - For each synapse in synaptome, verify per-peer signature
  - Drop any synapses with invalid signatures (log warning)

Step 7: Import into local synaptome
  - Discount weights by 0.7 (inheritance penalty)
  - Set source = SPONSOR_SNAPSHOT
  - Set sourceNodeId = sponsor's NodeId
  - Set createdAt = now
  - lastSuccessfulUse = 0 (will be set on first probe)

Step 8: Spawn liveness probe (in nh1-transport)
  - Probe all synapses in parallel with 3-second timeout
  - Mark dead ones for fast eviction

Step 9: Notify nh1-core that synaptome is ready
  - nh1-core takes over; bootstrap is complete
```

### 6.5 The Hardcoded Fallback

When QR is not available:

```typescript
const HARDCODED_BOOTSTRAP_SERVERS: BootstrapServer[] = [
  {
    nodeId: 'z5he6z4y...',
    publicKey: 'ed25519_...',
    s2Cell: '0x1a4c',
    addresses: [
      'wss://bootstrap1-us-east.example.com:8080',
      'tcp://1.2.3.4:8080',
    ],
    region: 'us-east',
    operator: 'YZ.social',
    addedAt: 1704067200,
  },
  {
    nodeId: 'z7kp2m3x...',
    publicKey: 'ed25519_...',
    s2Cell: '0x1b5d',
    addresses: [
      'wss://bootstrap2-eu.example.com:8080',
      'tcp://5.6.7.8:8080',
    ],
    region: 'eu-west',
    operator: 'YZ.social',
    addedAt: 1704067200,
  },
  {
    nodeId: 'z9qr5n8w...',
    publicKey: 'ed25519_...',
    s2Cell: '0x2c7e',
    addresses: [
      'wss://bootstrap3-apac.example.com:8080',
      'tcp://9.10.11.12:8080',
    ],
    region: 'apac',
    operator: 'YZ.social',
    addedAt: 1704067200,
  },
];

async function bootstrapFromHardcoded(): Promise<BootstrapResult> {
  // Try all three in parallel
  const promises = HARDCODED_BOOTSTRAP_SERVERS.map(async server => {
    try {
      const conn = await connect(server, timeout: 5000);
      const response = await sendBootstrapRequest(conn);
      return { server, response };
    } catch (err) {
      return { server, error: err };
    }
  });
  
  // Wait for all (or 15 second timeout)
  const results = await Promise.allSettled(promises);
  
  const succeeded = results
    .filter(r => r.status === 'fulfilled' && !r.value.error)
    .map(r => (r as any).value);
  
  if (succeeded.length === 0) {
    throw new Error('All bootstrap servers unreachable');
  }
  
  // Merge synaptomes from successful servers
  return mergeSynaptomes(succeeded.map(s => s.response));
}
```

### 6.6 The Persisted Bootstrap

When the app has been launched before:

```typescript
async function bootstrapFromPersisted(): Promise<BootstrapResult | null> {
  const state = await storage.loadAtomicState();
  if (!state) return null;
  
  // Verify integrity (HMAC)
  if (!verifyHMAC(state)) {
    log.warn('Persisted state integrity check failed');
    return null;
  }
  
  // Recompute recency for each synapse
  const now = Date.now();
  const synaptome = state.synaptome.synapses.map(s => ({
    ...s,
    recency: Math.exp(-(now - s.lastSuccessfulUse) / RECENCY_HALF_LIFE),
  }));
  
  return {
    synaptome,
    sourceOfBootstrap: 'persisted',
    bootstrapTime: now,
    confidence: computeConfidence(state),
  };
}
```

The persisted bootstrap is the fastest path to functional. It's tried first; if state is corrupted or missing, the bootstrap subsystem falls through to QR or hardcoded.

---

## 7. The Application API: `nh1-app`

### 7.1 Responsibilities

`nh1-app` is the public-facing surface for application developers. It hides the protocol internals and exposes a clean lifecycle.

### 7.2 The App API

```typescript
class NH1App extends EventEmitter {
  // Construction
  constructor(opts: NH1AppOptions);
  
  // Lifecycle
  async connect(): Promise<void>;
  async disconnect(): Promise<void>;
  
  // State
  isConnected(): boolean;
  getStatus(): AppStatus;
  
  // Operations
  async lookup(targetId: NodeId | PeerIdentifier): Promise<LookupResult>;
  async publish(topic: string, message: any): Promise<PublishResult>;
  async subscribe(topic: string, handler: SubscribeHandler): Promise<Subscription>;
  async unsubscribe(subscription: Subscription): Promise<void>;
  
  // Identity
  getMyIdentity(): IdentityRecord;
  
  // Bootstrap helpers
  async generateInvite(opts?: InviteOptions): Promise<InviteData>;
  async joinViaInvite(qrData: string): Promise<void>;
  
  // Diagnostics
  getStats(): AppStats;
  on(event: 'connected' | 'disconnected' | 'lookup' | 'publish' | 'subscribe' | 'error', handler: any): void;
}

interface NH1AppOptions {
  // Identity
  identity?: 'auto' | { publicKey: string; privateKey: string };
  s2Cell?: string;                     // Optional override; auto-detected otherwise
  
  // Bootstrap strategy
  bootstrap?: 'auto' | 'persisted-only' | 'hardcoded-only' | { servers: BootstrapServer[] };
  
  // Storage
  storage?: 'platform-default' | { adapter: IStorage };
  
  // Network
  transport?: 'webrtc' | 'websocket' | 'libp2p' | 'auto';
  
  // Observability
  observability?: 'silent' | 'console' | { metricsEndpoint: string };
  
  // Advanced
  parameters?: Partial<NH1Parameters>;
  highwayMode?: 'auto' | true | false;
}
```

### 7.3 Application Integration Examples

#### 7.3.1 Minimal Browser App

```typescript
import { NH1App } from '@yz-social/nh1-app/browser';

const app = new NH1App({});
await app.connect();

await app.publish('hello', { text: 'world' });
app.subscribe('hello', (msg) => console.log(msg));
```

#### 7.3.2 iOS App (via WebKit JS bridge)

```swift
let webView = WKWebView()
webView.loadHTMLString("""
<script src="nh1-bundle.js"></script>
<script>
  const app = new NH1App({
    transport: 'webrtc',
    storage: { adapter: nativeStorage }
  });
  await app.connect();
</script>
""", baseURL: nil)
```

#### 7.3.3 Node.js Server

```typescript
import { NH1App } from '@yz-social/nh1-app/node';

const app = new NH1App({
  highwayMode: true,                   // Server-class capacity
  storage: 'platform-default',         // Filesystem
  parameters: {
    MAX_SYNAPTOME_SIZE: 256,          // Large capacity
  },
});

await app.connect();
console.log('Server is now part of the network');
```

### 7.4 Lifecycle Events

Applications should subscribe to these events for UI feedback:

```typescript
app.on('connected', (info) => {
  // Network is ready
  // info: { synaptomeSize, bootstrapMethod, durationMs }
});

app.on('disconnected', (reason) => {
  // We're offline
  // reason: 'user' | 'network-failure' | 'timeout'
});

app.on('lookup', (event) => {
  // event: { targetId, success, hops, latency }
  // Useful for showing routing visualization
});

app.on('publish', (event) => {
  // event: { topic, messageId, recipientCount }
});

app.on('subscribe', (event) => {
  // event: { topic, messageId, sender }
});

app.on('error', (error) => {
  // Errors that occurred during operations
  // Application should handle gracefully
});
```

---

## 8. Infrastructure Components

### 8.1 Bootstrap Servers

The hardcoded bootstrap servers are dedicated NH-1 nodes that run on operator infrastructure. They are deployed as containers.

**Specifications:**

- **Hardware:** 2 vCPU, 4 GB RAM, 50 GB SSD
- **Network:** Public IP, reachable on port 8080 (TCP) and 8443 (WSS for WebSocket)
- **OS:** Linux (Ubuntu LTS recommended)
- **Storage:** Persistent volume for synaptome state and logs

**Deployment:**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY nh1-bootstrap-server/ .
RUN npm install --production
CMD ["node", "server.js"]
```

```yaml
version: '3.8'
services:
  bootstrap:
    image: yz-social/nh1-bootstrap:latest
    ports:
      - "8080:8080/tcp"
      - "8443:8443/tcp"
    volumes:
      - bootstrap-data:/data
    environment:
      - NH1_NODE_ID=z5he6z4y...
      - NH1_PRIVATE_KEY=<keychain reference>
      - NH1_PUBLIC_KEY=<from binary>
      - NH1_S2_CELL=0x1a4c
      - NH1_HIGHWAY_MODE=true
      - NH1_LISTEN_TCP=0.0.0.0:8080
      - NH1_LISTEN_WSS=0.0.0.0:8443

volumes:
  bootstrap-data:
```

**Operational requirements:**

- 99.9% uptime target
- Periodic synaptome refresh (every 6 hours, the bootstrap server runs its own self-lookup to discover new peers)
- Health check endpoint: `GET /health` returns 200 if synaptome is fresh and reachable
- Metrics endpoint: `GET /metrics` returns Prometheus-formatted metrics
- Log retention: 30 days

### 8.2 TURN Relay Servers

For nodes behind symmetric NATs that cannot establish direct WebRTC connections, TURN servers are required.

**Recommended:** [Coturn](https://github.com/coturn/coturn)

**Specifications:**

- **Hardware:** 4 vCPU, 8 GB RAM, 100 GB SSD
- **Network:** High bandwidth (TURN relays multiplex many connections)
- **TLS:** Required for browser connections

**Deployment:**

```yaml
version: '3.8'
services:
  turn:
    image: instrumentisto/coturn:latest
    ports:
      - "3478:3478/udp"
      - "3478:3478/tcp"
      - "5349:5349/tcp"
    volumes:
      - ./turnserver.conf:/etc/turnserver.conf:ro
    command: ["-c", "/etc/turnserver.conf"]
```

**Operational requirements:**

- Public IP, reachable on UDP 3478 and TCP 3478/5349
- Authenticated via short-lived credentials (issued by the application)
- Bandwidth budget: estimate 1-5 GB/day per 1000 active users
- Geographic distribution: ideally one TURN server per major region

### 8.3 Monitoring Backend

Production deployments need observability. We recommend:

- **Metrics:** Prometheus or Cloud-native equivalent (Grafana Cloud, Datadog, etc.)
- **Logs:** Centralized log aggregation (ELK, Loki, or Cloud logging)
- **Traces:** OpenTelemetry-compatible distributed tracing

The library emits structured events; the application's monitoring stack consumes them.

```typescript
// Library emits these events
{
  event: 'lookup.success',
  timestamp: 1704067200000,
  duration: 245,
  hops: 3,
  synaptomeSize: 47,
  // ... more context
}

// Aggregated as metrics
nh1_lookups_total{outcome="success",region="us-east"} 1234
nh1_lookups_total{outcome="failure",region="us-east"} 12
nh1_lookup_latency_p95{region="us-east"} 245.3
nh1_synaptome_size_avg{region="us-east"} 47.2
```

### 8.4 Update Distribution

When the app has updates (new bootstrap server addresses, parameter tunings, security fixes), they need to reach users.

**Approach:** Apps check for updates on connect via a signed manifest:

```typescript
async function checkForUpdates() {
  try {
    const manifest = await fetch('https://updates.yz.social/nh1/manifest.json');
    const data = await manifest.json();
    
    // Verify manifest is signed by trusted key
    if (!verifyManifestSignature(data)) {
      log.warn('Manifest signature invalid');
      return;
    }
    
    // Apply updates
    if (data.bootstrapServers) {
      updateHardcodedBootstrapServers(data.bootstrapServers);
    }
    
    if (data.parameters) {
      updateParameterDefaults(data.parameters);
    }
  } catch (err) {
    // Update check failed; that's OK, continue with built-in defaults
  }
}
```

The manifest is pinned, signed by an offline cold key, and served over HTTPS.

---

## 9. Wire Protocol Specification

### 9.1 Message Framing

All messages between peers use length-prefixed framing:

```
[4 bytes: u32 little-endian length of message]
[N bytes: message content]
```

Maximum message size: 64 KB. Larger payloads are fragmented at the application layer (above the protocol).

### 9.2 Message Types

```typescript
enum MessageType {
  // Discovery
  PROBE = 1,                    // Liveness check
  PROBE_RESPONSE = 2,
  
  // Bootstrap
  BOOTSTRAP_REQUEST = 10,       // Request for synaptome snapshot
  BOOTSTRAP_RESPONSE = 11,
  
  // Routing
  LOOKUP_REQUEST = 20,          // Find a peer
  LOOKUP_RESPONSE = 21,
  ROUTE_MESSAGE = 22,           // Send a message to a peer
  ROUTE_RESPONSE = 23,
  
  // Pub/Sub (Axonal)
  AXONAL_PUBLISH = 30,          // Publish a message to a topic
  AXONAL_SUBSCRIBE = 31,        // Subscribe to a topic
  AXONAL_UNSUBSCRIBE = 32,      // Unsubscribe from a topic
  AXONAL_RE_SUBSCRIBE = 33,     // Periodic refresh
  AXONAL_BRANCH = 34,           // Tree branching: handover subscribers
  AXONAL_REPLAY = 35,           // Request missing message replay
  
  // Learning
  LEARN_INTRODUCE = 40,         // Triadic closure introduction
  
  // Diagnostics (informational)
  GOSSIP_NETWORK_SIZE = 50,
}
```

### 9.3 Common Header

Every message has a common header:

```typescript
interface MessageHeader {
  type: MessageType;
  version: number;              // Protocol version (1)
  fromNodeId: NodeId;
  toNodeId?: NodeId;            // Target (some messages are broadcasts)
  messageId: string;            // UUID for request/response correlation
  timestamp: number;            // Unix ms
}
```

### 9.4 Specific Message Formats

#### 9.4.1 PROBE (liveness check)

```json
{
  "type": 1,
  "version": 1,
  "fromNodeId": "z5he6z4y...",
  "toNodeId": "a7f3d9c2...",
  "messageId": "uuid-1234",
  "timestamp": 1704067200000,
  "signature": "<signed by from>"
}
```

**Response (PROBE_RESPONSE):**

```json
{
  "type": 2,
  "version": 1,
  "fromNodeId": "a7f3d9c2...",
  "toNodeId": "z5he6z4y...",
  "messageId": "uuid-1234",  // Same ID as request
  "timestamp": 1704067200042,
  "signature": "<signed by from>"
}
```

#### 9.4.2 LOOKUP_REQUEST

```json
{
  "type": 20,
  "version": 1,
  "fromNodeId": "z5he6z4y...",
  "messageId": "uuid-5678",
  "timestamp": 1704067200000,
  "targetNodeId": "x9j7m2k4...",
  "requesterPath": ["z5he6z4y...", "intermediate1", "intermediate2"],
  "hopBudget": 8,                // How many more hops are allowed
  "signature": "<signed by initiator>"
}
```

**Response (LOOKUP_RESPONSE):**

```json
{
  "type": 21,
  "version": 1,
  "fromNodeId": "intermediate2",
  "toNodeId": "z5he6z4y...",
  "messageId": "uuid-5678",
  "timestamp": 1704067200084,
  "outcome": "found" | "redirect" | "failed",
  "result": {
    "peerId": "x9j7m2k4...",
    "publicKey": "...",
    "addresses": [...]
  },
  "hopsTaken": 3,
  "signature": "<signed by responder>"
}
```

#### 9.4.3 AXONAL_PUBLISH

```json
{
  "type": 30,
  "version": 1,
  "fromNodeId": "z5he6z4y...",
  "messageId": "uuid-publish-1",
  "timestamp": 1704067200000,
  "topicId": "<32 byte hash>",
  "publisherPublicKey": "...",
  "sequenceNumber": 42,
  "payload": "<bytes>",
  "publishSignature": "<signed by publisher key>",
  "messageSignature": "<signed by relay>"
}
```

#### 9.4.4 AXONAL_SUBSCRIBE

```json
{
  "type": 31,
  "version": 1,
  "fromNodeId": "subscriber",
  "messageId": "uuid-subscribe-1",
  "timestamp": 1704067200000,
  "topicId": "<32 byte hash>",
  "lastSeenTs": 1704066800000,    // For replay
  "wantsReplay": true,
  "subscription_signature": "<signed by subscriber>"
}
```

### 9.5 Signatures

Every message that affects another node's state is signed:

```typescript
function signMessage(privateKey: Bytes, message: Object): Signature {
  // Canonical serialization (sorted keys, no whitespace)
  const canonicalBytes = canonicalize(message);
  
  // Sign with Ed25519
  return ed25519_sign(privateKey, canonicalBytes);
}

function verifyMessage(publicKey: Bytes, message: Object, signature: Signature): boolean {
  const canonicalBytes = canonicalize(message);
  return ed25519_verify(publicKey, canonicalBytes, signature);
}
```

Signatures are verified at three points:
1. **At the receiver's transport layer** — does this message claim to be from someone I have a public key for?
2. **At the routing layer** — for `LOOKUP_REQUEST`, is the requesterPath consistent?
3. **At the application layer** — for `AXONAL_PUBLISH`, does the publisher signature match?

### 9.6 Error Responses

Errors are returned in response messages, not raised as exceptions. Each error has a code and a reason:

```json
{
  "type": 21,
  "outcome": "error",
  "errorCode": "TARGET_NOT_FOUND",
  "errorReason": "Lookup hop budget exhausted",
  "signature": "..."
}
```

Error codes are documented in the protocol spec; clients log them for diagnostics.

---

## 10. State Persistence Format

### 10.1 The Persistence Layout

```
nh1-storage/
├── identity.bin          # IdentityRecord (encrypted at rest)
├── synaptome.bin         # SerializedSynaptome
├── subscriptions.bin     # Active subscriptions
├── replay-cache-{topic}/ # One folder per subscribed topic
│   ├── messages.log     # Append-only log of received messages
│   ├── messages.idx     # Index for fast lookup
│   └── meta.bin         # Topic metadata
├── axonal-roles.bin      # Topics this node serves as axon
├── temperature.bin       # Current exploration temperature
├── stats.bin             # Session statistics
└── checksum.hmac         # HMAC over all above files
```

Each file is independently checksummed. If any are corrupt, the system falls back to bootstrap.

### 10.2 Save Strategy

**On graceful shutdown:**
- All state saved to disk
- Connections closed gracefully
- Last-known-good stats recorded

**On unexpected termination:**
- Periodic checkpoints (every 60 seconds during active use)
- Synaptome saved when significant changes occur (10+ new synapses, 5+ evictions)
- Replay caches saved every 30 seconds during pub/sub activity

**On app launch:**
- Verify integrity of all files
- Compute time elapsed since last save
- Apply recency decay to all synapses
- If integrity fails: discard, fall back to bootstrap

### 10.3 Migration Strategy

Schema versions are tagged in each file. When loading:

```typescript
function loadSynaptome(): SerializedSynaptome | null {
  const data = await storage.read('synaptome.bin');
  if (!data) return null;
  
  if (!verifyHMAC(data)) {
    log.warn('Synaptome integrity check failed');
    return null;
  }
  
  if (data.version !== CURRENT_VERSION) {
    return migrateSynaptome(data);
  }
  
  return data as SerializedSynaptome;
}

function migrateSynaptome(data: any): SerializedSynaptome {
  // Apply migrations 1 → 2 → 3 → ...
  // Each migration is a function: (vN) => vN+1
  let current = data;
  while (current.version < CURRENT_VERSION) {
    const migration = migrations[current.version];
    current = migration(current);
    current.version += 1;
  }
  return current;
}
```

---

## 11. Development Sequence

This is the recommended build order. Each phase has explicit gates that must be passed before moving to the next.

### 11.1 Phase 0 — Foundation (Weeks 1-3)

**Goal:** Get the foundation right before building protocol logic.

**Tasks:**
- Set up TypeScript monorepo with `nh1-crypto`, `nh1-storage`, `nh1-transport`, `nh1-core`, `nh1-bootstrap`, `nh1-app`
- Define interfaces for ICrypto, IStorage, ITransport
- Implement WebCrypto-based crypto adapter
- Implement IndexedDB storage adapter (browser)
- Implement filesystem storage adapter (Node.js)
- Implement WebSocket transport adapter (simplest first)
- Set up testing infrastructure (Vitest, Playwright for browser tests)
- Set up CI/CD pipeline

**Validation gates:**
- All adapters have ≥80% test coverage
- Cross-platform tests pass on macOS, Linux, Windows
- Browser tests pass in Chrome, Firefox, Safari
- Node.js tests pass on Node 20

**Outcome:** Reusable plumbing that's ready for protocol logic to be built on top.

### 11.2 Phase 1 — Core Protocol (Weeks 4-7)

**Goal:** Implement the NH-1 protocol, isolated from production concerns.

**Tasks:**
- Implement Synapse and Synaptome data structures with all fields
- Implement vitality function and `_addByVitality`
- Implement AP routing
- Implement two-hop lookahead
- Implement iterative fallback
- Implement LTP, hop caching, triadic closure, incoming promotion, annealing
- Implement axonal tree construction and delivery
- Implement re-subscribe and replay cache
- Build a fake transport for unit testing
- Build a fake storage for unit testing

**Validation gates:**
- Unit tests cover all 12 NH-1 rules with their behavioral contracts
- Integration test: spawn 100 instances on a single machine using fake transport, verify routing succeeds
- Behavioral parity test: a small simulated network on the protocol library matches NH-1 simulator output to within 5%

**Outcome:** A correct NH-1 implementation that can be hooked up to real I/O.

### 11.3 Phase 2 — Real I/O (Weeks 8-11)

**Goal:** Hook the protocol up to actual network and storage.

**Tasks:**
- Implement WebRTC transport adapter with full ICE/STUN/TURN
- Implement libp2p transport adapter
- Implement iOS native crypto and storage bridge
- Implement Android native crypto and storage bridge
- Implement connection state tracking and friction handling (Issue #1)
- Implement RPC timeouts and suspicion (Issue #2)
- Implement variance-aware AP scoring (Issue #4)
- Run on real testnet (5-10 nodes on different machines)

**Validation gates:**
- 5-node real testnet sustains 99%+ lookup success over 1 hour
- WebRTC connection setup succeeds in < 5 seconds for typical NAT environments
- Synaptome state persists across restarts; no re-bootstrap needed
- Mobile (iOS) integration test: app connects, performs lookup, persists state

**Outcome:** Real network integration; the brain is talking to the body.

### 11.4 Phase 3 — Bootstrap System (Weeks 12-15)

**Goal:** Polish the join experience, including QR codes, sponsor flow, and hardcoded fallback.

**Tasks:**
- Implement QR code generation and parsing
- Implement sponsor flow and bootstrap request/response messages
- Implement hardcoded bootstrap server fallback
- Implement persisted bootstrap (resume from disk)
- Implement liveness probe in parallel
- Build first bootstrap server (deployable container)
- Deploy 3 bootstrap servers in different regions
- Implement TURN integration for WebRTC

**Validation gates:**
- QR-based bootstrap completes in < 7 seconds end-to-end on real mobile devices
- Hardcoded bootstrap completes in < 7 seconds end-to-end
- Persisted bootstrap completes in < 1 second on rejoin
- Bootstrap servers handle 100 concurrent join requests without degradation
- TURN successfully relays connections for 95% of NAT scenarios

**Outcome:** Joinable network. New users can install and connect from anywhere.

### 11.5 Phase 4 — Hardening (Weeks 16-19)

**Goal:** Address red-team Tier 1 issues for production readiness.

**Tasks:**
- Implement bandwidth saturation handling and load-aware AP scoring (Issue #3)
- Implement replay cache integrity (HMAC, signature verification)
- Implement reputation tracking and decay
- Implement asymmetric reachability tracking (Issue #8)
- Implement load-aware relay selection
- Add Vivaldi-style RTT validation as secondary check on S2 prefix (Issue #5)
- Build comprehensive observability: events → metrics → dashboards
- Build alerting rules per the operational handoff

**Validation gates:**
- Synthetic Zipf workload (α=1.0): no relay saturates beyond 80% load
- Synthetic Sybil attack (10% nodes in one cell): lookup success > 90% in that cell
- Real WebRTC measurements: latency within 30% of simulator predictions
- Observability dashboard shows all critical metrics in real-time

**Outcome:** Production-grade protocol that survives real-world adversarial conditions.

### 11.6 Phase 5 — Testnet & Staging (Weeks 20-23)

**Goal:** Validate at scale on dedicated infrastructure.

**Tasks:**
- Deploy 100-node testnet on dedicated VMs
- Deploy 1,000-node testnet
- Deploy 5,000-node staging environment
- Run 1-week soak test
- Calibrate alert thresholds
- Document operational runbooks
- Train operations team on diagnosis playbooks

**Validation gates:**
- 1K-node testnet: 99% lookup success, p95 latency < 500ms
- 5K-node staging: 99% lookup success, p95 latency < 800ms
- Pub/sub baseline delivery: 100% under no churn
- Pub/sub recovered delivery: > 95% under simulated 5% churn
- Operations team confident on dashboards and playbooks

**Outcome:** Production-validated system, ready for limited release.

### 11.7 Phase 6 — Limited Production Release (Weeks 24-25)

**Goal:** Ship to early adopters with active monitoring.

**Tasks:**
- Deploy reference application (`nh1-demo`) — chat or social-style
- Open to ~500 invited users
- Monitor all Tier 1, 2, 3 metrics continuously
- Establish incident response playbook
- Daily review of operational data
- Iterate on bugs found in production

**Validation gates:**
- 24-hour soak: all critical metrics within target
- 1-week run: any issue addressed within 48 hours
- User-reported friction: collected and triaged
- Before scaling to 2K: all open issues classified and prioritized

**Outcome:** Validated production system with real users, ready for wider release.

### 11.8 Phase 7 — Scale and Refine (Weeks 26+)

Following phases follow the deployment timeline in the whitepaper §16.

---

## 12. Testing Strategy

### 12.1 Unit Tests

Each module has unit tests with ≥80% coverage. Tests run in CI on every PR.

```typescript
// Example: Vitality function
describe('vitality', () => {
  it('returns 0 for synapses with weight 0', () => {
    const s = mockSynapse({ weight: 0 });
    expect(vitality(s, Date.now())).toBe(0);
  });
  
  it('decays with recency over time', () => {
    const past = Date.now() - 7200000; // 2 hours ago
    const s = mockSynapse({
      weight: 1.0,
      lastSuccessfulUse: past,
    });
    
    expect(vitality(s, Date.now())).toBeLessThan(1.0);
    expect(vitality(s, Date.now())).toBeCloseTo(0.5, 1);
  });
  
  // ... more tests
});
```

### 12.2 Integration Tests

Run the full stack against real I/O and check end-to-end behavior:

```typescript
describe('Bootstrap and Lookup', () => {
  it('successfully bootstraps via QR code', async () => {
    // Setup: a sponsor node with 50 synapses
    const sponsor = await spawnNode({ initialSynaptome: createMock50Peers() });
    
    // New node receives QR
    const qr = await sponsor.generateInviteQR();
    
    // Newjoiner uses QR
    const newJoiner = await spawnNode();
    await newJoiner.joinViaInvite(qr.url);
    
    // Verify
    const synaptome = newJoiner.getSynaptome();
    expect(synaptome.size).toBeGreaterThan(35);  // Most peers alive
    expect(synaptome.size).toBeLessThan(51);     // Capped
    
    // Verify lookup works
    const result = await newJoiner.lookup(arbitraryPeerId);
    expect(result.success).toBe(true);
  });
});
```

### 12.3 Network Simulation Tests

Verify behavior at scale using deterministic simulators:

```typescript
describe('Slice World Recovery', () => {
  it('recovers from partition through bridge', async () => {
    // Setup: 1000 nodes split into East/West, with 1 bridge in Hawaii
    const network = await spawnNetwork({
      nodes: 1000,
      partitionStrategy: 'east-west-bridge'
    });
    
    // Run 100 lookups across partition
    const results = await Promise.all(
      Array.from({length: 100}, () =>
        network.east[0].lookup(network.west[0].id)
      )
    );
    
    // Most should succeed
    const successRate = results.filter(r => r.success).length / 100;
    expect(successRate).toBeGreaterThan(0.9);
    
    // Verify cross-hemisphere synapses formed
    const eastNode = network.east[0];
    const crossHemSynapses = eastNode.synaptome.filter(s => isWestern(s.s2Cell));
    expect(crossHemSynapses.length).toBeGreaterThan(5);
  });
});
```

### 12.4 Chaos Tests

Inject failures and verify the system handles them:

```typescript
describe('Chaos Engineering', () => {
  it('survives 25% churn', async () => {
    const network = await spawnNetwork({ nodes: 1000 });
    
    // Run baseline lookups
    const baseline = await runLookups(network, 100);
    
    // Inject 25% churn
    await network.killRandomNodes(250);
    
    // Run lookups again
    const postChurn = await runLookups(network, 100);
    
    // Should mostly succeed
    expect(postChurn.successRate).toBeGreaterThan(0.95);
    expect(postChurn.avgLatency).toBeLessThan(baseline.avgLatency * 1.5);
  });
});
```

### 12.5 Real-World Tests

End-to-end tests against real infrastructure:

```typescript
describe('Real WebRTC Bootstrap', () => {
  it('bootstraps via WebRTC over real ICE in <10 seconds', async () => {
    const sponsor = await deployBootstrapServer({
      address: 'public-test-server.example.com:8080'
    });
    
    const joiner = new NH1App({
      bootstrap: { servers: [sponsor.endpoint] },
    });
    
    const start = Date.now();
    await joiner.connect();
    const duration = Date.now() - start;
    
    expect(duration).toBeLessThan(10000);
  });
});
```

---

## 13. Deployment Phases

The deployment timeline maps to the development phases above:

| Week | Phase | Milestone | Deployment Target |
|---|---|---|---|
| 0-3 | 0 | Foundation built | Internal dev |
| 4-7 | 1 | Protocol library complete | Internal dev |
| 8-11 | 2 | Real I/O integration | Engineering testnet (5 nodes) |
| 12-15 | 3 | Bootstrap system complete | Engineering testnet (50 nodes) |
| 16-19 | 4 | Hardening complete | Open testnet (100 nodes) |
| 20-23 | 5 | Scale validation | Staging (5K nodes) |
| 24-25 | 6 | Limited release | Production (500 users) |
| 26+ | 7 | Scaled release | Production (5K+ users) |

Total: 26 weeks (~6 months) from kickoff to limited production release.

---

## 14. Reference Application: `nh1-demo`

To validate that the API is genuinely simple and integrable, we ship a reference application.

**Choice:** A decentralized chat application — minimum viable to exercise pub/sub, lookup, and persistence.

```typescript
// nh1-demo/src/app.ts

import { NH1App } from '@yz-social/nh1-app';

class ChatApp {
  private app: NH1App;
  private myUsername: string;
  
  async start() {
    this.app = new NH1App({
      observability: 'console',
    });
    
    await this.app.connect();
    
    // Subscribe to my own messages topic
    this.app.subscribe(`@${this.myUsername}`, (message) => {
      this.displayMessage(message);
    });
    
    // Subscribe to general
    this.app.subscribe('general', (message) => {
      this.displayMessage(message);
    });
    
    console.log(`Connected as ${this.app.getMyIdentity().nodeId}`);
  }
  
  async sendMessage(toUser: string, text: string) {
    await this.app.publish(`@${toUser}`, {
      from: this.myUsername,
      text,
      timestamp: Date.now(),
    });
  }
  
  async sendToGeneral(text: string) {
    await this.app.publish('general', {
      from: this.myUsername,
      text,
      timestamp: Date.now(),
    });
  }
  
  async generateInvite() {
    const invite = await this.app.generateInvite({ expiresIn: 3600 });
    return invite;
  }
  
  async joinViaQR(qrData: string) {
    await this.app.joinViaInvite(qrData);
  }
}
```

**This application validates:**
- The simple 6-method API works
- Lookup works
- Pub/sub publish/subscribe works
- QR code generation/parsing works
- Lifecycle events work
- Persistence across restarts works

**It is shipped to early adopters as the reference for what a real app looks like.**

---

## 15. Operational Handoff

When the protocol library is production-ready, the engineering team hands off to operations. Required artifacts:

### 15.1 Documentation

- This implementation plan (you are reading it)
- The whitepaper (architectural reference)
- The red team document (failure mode catalog)
- API documentation for `nh1-app` (TypeDoc-generated)
- Internal architecture documentation
- Runbooks for each operational scenario

### 15.2 Observability

- Pre-configured Grafana dashboards
- Alert rules in Prometheus or equivalent
- Log queries for common diagnostic scenarios
- Performance baselines per environment

### 15.3 Tooling

- Bootstrap server deployment automation (Terraform or equivalent)
- TURN server deployment automation
- Synaptome inspection CLI (`nh1-cli synaptome inspect <node>`)
- Performance profiling tools

### 15.4 Knowledge Transfer

- Engineering walkthrough of each module
- Operations training on diagnosis playbooks (whitepaper §13)
- Incident response simulations (chaos days)
- On-call rotation handoff with active engineering shadowing for first 4 weeks

---

## Summary

This implementation plan describes a complete production NH-1 system in seven layers: Crypto → Storage → Transport → Bootstrap → Core → App → Application. Each layer has clean interfaces, multiple adapter implementations for different platforms, and is independently testable.

**The development sequence** is 26 weeks across 8 phases. Each phase has explicit validation gates that must be passed before moving forward. The reference application (`nh1-demo`) validates the integration surface throughout development.

**The infrastructure** consists of 3 hardcoded bootstrap servers, regional TURN relays, and observability backends. All are off-the-shelf or trivially custom.

**The integration surface** is intentionally minimal: 6 methods on a single class. Application developers don't need to understand the protocol internals; they just call `connect()`, `publish()`, `subscribe()`, `lookup()`, and `disconnect()`.

The result, when complete, is a system where:
- A new user can install the app, scan a QR code, and be functional in 7 seconds
- A returning user can resume in 1 second
- Pub/sub messages reliably reach all subscribers, even under churn
- Bootstrap survives bootstrap server failures (3 redundant + persisted state)
- The protocol learns and adapts as it runs
- Operations can diagnose and respond to issues with documented playbooks

The brain is the algorithm. The body is everything in this document. Together, they ship the N-DHT.

---

## References

- NH-1 Whitepaper v0.3.38 (`NH1-Whitepaper.md`)
- Red Team Analysis v0.3.38 (`NH1-RedTeam-v0.3.38.md`)
- Research Deck v0.3.38 (`deck.md`)
- Source Repository: `github.com/YZ-social/dht-sim`

---

*End of implementation plan. Total length ≈ 90 pages typeset.*

*Suggested next steps for the engineering team:*
1. *Review and align on architectural decisions in §1-7*
2. *Establish team structure and assign module ownership*
3. *Begin Phase 0: Foundation (week 1-3) work*
4. *Schedule Phase 1 design review at end of week 3*
