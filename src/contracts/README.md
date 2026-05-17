# N-DHT contracts

This directory defines the architectural boundaries between the three
layers of the N-DHT system: the **application** above, the **protocol**
in the middle, and the **transport** below.

The protocol layer (`src/dht/neuromorphic/...`, `src/dht/kademlia/...`,
`src/pubsub/...`) is intended to ship to production *unchanged* from
the form it lives in inside the simulator. To make that possible, the
protocol code talks only to the contracts in this directory — never to
simulator-specific types, never directly to a peer registry, never to
synchronous in-process state on remote peers.

## Layer map

```
   ┌────────────────────────────────────────────────────────────┐
   │                       Application                          │
   │   simulator.Engine    chat client    storage layer    ...  │
   │                                                            │
   │     ┌──────────────────────────────────────────────────┐   │
   │     │             DHT  (src/contracts/DHT.js)          │   │
   │     │  start  stop  join  leave                        │   │
   │     │  lookup  subscribe  unsubscribe  publish         │   │
   │     │  getNodeId  getSynaptome  getMetrics  onEvent    │   │
   │     └──────────────────────────────────────────────────┘   │
   │                                                            │
   │                       Protocol                             │
   │   AxonaEngine   NeuronNode   AxonManager   ...      │
   │                                                            │
   │     ┌──────────────────────────────────────────────────┐   │
   │     │       Transport  (src/contracts/Transport.js)    │   │
   │     │  start  stop  getLocalNodeId                     │   │
   │     │  openConnection  closeConnection  isConnected    │   │
   │     │  send  notify                                    │   │
   │     │  onRequest  onNotification                       │   │
   │     │  onPeerDied  getLatency                          │   │
   │     └──────────────────────────────────────────────────┘   │
   │                                                            │
   │     ┌──────────────────────────────────────────────────┐   │
   │     │   BootstrapService (src/contracts/Bootstrap...)  │   │
   │     │  bootstrap                                       │   │
   │     └──────────────────────────────────────────────────┘   │
   │                                                            │
   │                       Transport                            │
   │       SimulatedNetwork (sim)    WebRTCTransport (prod)     │
   └────────────────────────────────────────────────────────────┘
```

## Files

| File                    | Role                                                     |
|-------------------------|----------------------------------------------------------|
| `Transport.js`          | Downward contract — protocol → transport                 |
| `DHT.js`                | Upward contract — application → protocol                 |
| `BootstrapService.js`   | Initial peer-connection contract (production: WebRTC signaling; sim: in-process pointer) |
| `types.js`              | Shared JSDoc typedefs — `NodeId`, `LookupResult`, `Metrics`, `BootstrapEndpoint`, `ProtocolEvent`, ... |
| `index.js`              | Barrel export                                            |

## How implementations conform

Each abstract base class throws "not implemented" from every method.
Concrete implementations extend the class and override every method:

```js
import { Transport } from '../contracts/index.js';

export class SimulatedNetwork extends Transport {
  async start(localNodeId) { ... }
  async stop()              { ... }
  async send(peerId, type, payload) { ... }
  // ... etc
}
```

Forgetting to override a method produces a clear runtime error
(`Transport.send: not implemented`) rather than silent misbehavior.

## Refactor sequence

These contracts are the *signed agreement* for the simulator-to-production
refactor. The plan:

1. **Audit pass (no code changes).** Walk the protocol code and flag
   every contract violation — every `nodeMap.get(peerId)`, every
   `peer.synaptome.values()` reach, every synchronous transport call.
   Output: a punch list.
2. **`SimulatedNetwork` → conforming Transport.** The simulator's
   transport implements the new interface. No protocol changes yet.
3. **Protocol refactor.** Walk the punch list. Replace each violation
   with the contract-compliant equivalent. Tests pass at every commit.
4. **Sim-side parity.** Existing benchmarks (the v0.70.05 / v0.3.49
   reference data) reproduce within noise.
5. **Production transport.** New WebRTC + heartbeat implementation of
   the same `Transport` interface. Protocol code does not change; the
   bottom layer is swapped.

See whitepaper Part IV (the simulator) and Part VI (deployment) for
the architectural rationale; see the implementation plan in
`documents/implementation/N-DHT-Implementation-Plan-*.md` for the
production-pathway sequencing.
