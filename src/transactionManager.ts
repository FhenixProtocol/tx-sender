import { TransactionRequest, TransactionResponse } from "ethers";
import { ChainManagerConfig, ChainManager } from "./chainManager";

interface TransactionManagerConfig {
  broadcast?: boolean;                    // Whether to automatically broadcast transactions
  defaultChain?: string;                  // Chain to interact with if not specified
  chains: {                               // Map of chain names to their configurations
    [chainName: string]: ChainManagerConfig
  };
}

export class TransactionManager {
  private broadcast: boolean;
  private chainManagers: Map<string, ChainManager>;
  private defaultChain: string | null;

  constructor(config: TransactionManagerConfig) {
    const { chains, broadcast = false, defaultChain = null } = config;

    this.broadcast = broadcast;
    this.chainManagers = new Map();
    this.defaultChain = defaultChain;

    // Initialize chain configurations
    for (const [chainName, config] of Object.entries(chains)) {
      this.chainManagers.set(chainName, new ChainManager(config));
    }
  }

  /**
   * Prepares and signs a transaction.
   */
  public async signTransaction(tx: Partial<TransactionRequest>, chain?: string): Promise<string> {
    let chainManager = this.getChainManager(chain);

    return chainManager.signTransaction(tx);
  }

  /**
   * Broadcasts a signed transaction to the network.
   */
  public async broadcastTransaction(signedTx: string, chain?: string): Promise<TransactionResponse> {
    let chainManager = this.getChainManager(chain);
    return chainManager.broadcastTransaction(signedTx);
  }

  /**
   * Sends a transaction: Signs and optionally broadcasts it.
   */
  public async sendTransaction(
    tx: Partial<TransactionRequest>,
    chain?: string
  ): Promise<{ signedTx: string; txResponse?: TransactionResponse }> {
    let chainManager = this.getChainManager(chain);

    // Sign the transaction
    const signedTx = await chainManager.signTransaction(tx);

    // Broadcast the transaction if specified
    if (this.broadcast) {
      const txResponse = await chainManager.broadcastTransaction(signedTx);
      return { signedTx, txResponse };
    }

    return { signedTx };
  }

  public setDefaultChain(chain: string): void {
    this.defaultChain = chain;
  }

  private getChainManager(chain?: string): ChainManager {
    let chainName: string;
    if (chain === undefined) {
      if (this.defaultChain === null) {
        throw new Error("Chain must be specified or a default chain must be set");
      }
      chainName = this.defaultChain;
    } else {
      chainName = chain;
    }

    const chainManager = this.chainManagers.get(chainName);
    if (!chainManager) {
      throw new Error(`No configuration found for chain "${chainName}".`);
    }

    return chainManager;
  }
}
