import { TransactionRequest, TransactionResponse } from "ethers";
import { ChainManagerConfig } from "./chainManager";
interface TransactionManagerConfig {
    broadcast?: boolean;
    defaultChain?: string;
    chains: {
        [chainName: string]: ChainManagerConfig;
    };
}
export interface ChainManagerConfigPublic extends Omit<ChainManagerConfig, 'privateKey'> {
    privateKey?: string;
}
interface TransactionManagerConfigPublic extends Omit<TransactionManagerConfig, 'chains'> {
    chains: {
        [chainName: string]: ChainManagerConfigPublic;
    };
}
export declare class TransactionManager {
    private broadcast;
    private chainManagers;
    private defaultChain;
    constructor(config: TransactionManagerConfig);
    static fromDotEnv(config: TransactionManagerConfigPublic): TransactionManager;
    /**
     * Prepares and signs a transaction.
     */
    signTransaction(tx: Partial<TransactionRequest>, chain?: string): Promise<string>;
    /**
     * Broadcasts a signed transaction to the network.
     */
    broadcastTransaction(signedTx: string, chain?: string): Promise<TransactionResponse>;
    /**
     * Sends a transaction: Signs and optionally broadcasts it.
     */
    sendTransaction(tx: Partial<TransactionRequest>, chain?: string): Promise<{
        signedTx: string;
        txResponse?: TransactionResponse;
    }>;
    setDefaultChain(chain: string): void;
    private getChainManager;
}
export {};
