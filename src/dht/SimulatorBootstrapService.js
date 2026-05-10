// =====================================================================
// SimulatorBootstrapService — BootstrapService implementation for the
// simulator world.
//
// The production BootstrapService handles WebSocket signaling against a
// known rendezvous server, manifest fetch and signature verification,
// WebRTC offer/answer negotiation, and QR-code-based pairing. The
// simulator equivalent is trivial — every "sponsor" is an in-process
// node, the transport is created via SimulatedNetwork.makeTransport,
// and the first connection is opened synchronously.
//
// Construction binds the bootstrap service to one (simNet, localNodeId)
// pair: each DHT instance gets its own bootstrap service. This mirrors
// the production pattern, where a node has its own keypair, its own
// signaling client, and bootstrap is per-node-instance.
// =====================================================================

import { BootstrapService } from '../contracts/index.js';

export class SimulatorBootstrapService extends BootstrapService {

  /**
   * @param {import('./SimulatedNetwork.js').SimulatedNetwork} simNet
   * @param {bigint} localNodeId
   */
  constructor(simNet, localNodeId) {
    super();
    /** @private */ this._simNet = simNet;
    /** @private */ this._localNodeId = localNodeId;
  }

  /**
   * @param {import('../contracts/types.js').BootstrapEndpoint} sponsor
   * @returns {Promise<{sponsorId: bigint, transport: import('./SimulatedTransport.js').SimulatedTransport}>}
   */
  async bootstrap(sponsor) {
    if (sponsor.kind !== 'simulator') {
      throw new Error(
        `SimulatorBootstrapService: expected sponsor.kind='simulator', got '${sponsor.kind}'`
      );
    }
    const sponsorId = sponsor.sponsorId;
    if (typeof sponsorId !== 'bigint') {
      throw new TypeError(
        `SimulatorBootstrapService: sponsor.sponsorId must be a bigint, got ${typeof sponsorId}`
      );
    }
    const sponsorNode = this._simNet.nodes.get(sponsorId);
    if (!sponsorNode || !sponsorNode.alive) {
      throw new Error(
        `SimulatorBootstrapService: sponsor ${sponsorId} is not in the simulator network or not alive`
      );
    }

    const transport = this._simNet.makeTransport(this._localNodeId);
    await transport.start();

    const opened = await transport.openConnection(sponsorId);
    if (!opened) {
      // In the simulator this only happens if the sponsor disappeared
      // between the liveness check above and openConnection — vanishingly
      // unlikely in single-threaded sim execution, but the contract
      // allows it.
      await transport.stop();
      throw new Error(
        `SimulatorBootstrapService: openConnection to sponsor ${sponsorId} refused`
      );
    }

    return { sponsorId, transport };
  }
}
