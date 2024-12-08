import { TransactionRequest, TransactionResponse } from "ethers";
export interface ChainManagerConfig {
    rpcUrl: string;
    chainId?: number;
    broadcast?: boolean;
    privateKey: string;
}
export declare class ChainManager {
    private provider;
    private wallet;
    private nonce;
    private nonceSyncing;
    private broadcast;
    private chainId;
    private balance;
    constructor(config: ChainManagerConfig);
    /**
     * Fetches and syncs the current wallet balance.
     */
    private syncBalance;
    /**
     * Initializes the Nonce according to the chain state.
     */
    private syncNonce;
    /**
     * Initializes and tracks the nonce for the account.
     */
    private getNonce;
    /**
     * Increments the nonce after a transaction.
     */
    private incrementNonce;
    /**
     * Prepares and signs a transaction.
     */
    signTransaction(tx: Partial<TransactionRequest>): Promise<string>;
    /**
     * Adds the chain ID to the transaction if not set.
     */
    private addChainId;
    /**
     * Estimates the gas cost for a transaction and validates the wallet balance.
     */
    private validateFunds;
    /**
     * Broadcasts a signed transaction to the network.
     */
    broadcastTransaction(signedTx: string): Promise<TransactionResponse>;
    /**
     * Sends a transaction: Signs and optionally broadcasts it.
     */
    sendTransaction(tx: Partial<TransactionRequest>): Promise<{
        signedTx: string;
        txResponse?: TransactionResponse;
    }>;
}
