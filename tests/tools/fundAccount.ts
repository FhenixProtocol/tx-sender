import axios from 'axios';
import { Provider } from 'ethers';
import baseLogger from './logger.js';

const logger = baseLogger.child({ module: 'AccountFunding' });

export async function fundAccount(
    address: string,
    url: string | undefined,
    provider: Provider
): Promise<void> {
    logger.info("Funding account if necessary", { address, url });
    const balance = await provider.getBalance(address);
    if (balance.toString() === "0") {
        await getFunds(address, url);
        const newBalance = await provider.getBalance(address);
        logger.info("Account successfully funded", { address, newBalance: newBalance.toString() });
    } else {
        logger.info("Account already has funds", { address, balance: balance.toString() });
    }
}

async function getFunds(address: string, url: string | undefined): Promise<void> {
    const faucetUrl = url || `http://localhost:42000`;
    logger.info("Getting funds from faucet", { address, faucetUrl });

    const response = await axios.get(`${faucetUrl}/faucet?address=${address}`);

    if (response.status !== 200) {
        logger.error("Failed to get funds from faucet", {
            address,
            statusCode: response.status,
            statusText: response.statusText
        });
        throw new Error(
            `Failed to get funds from faucet: ${response.status}: ${response.statusText}`,
        );
    }

    if (!response.data?.message?.includes("ETH successfully sent to address")) {
        logger.error("Failed to get funds from faucet", {
            address,
            response: response.data
        });
        throw new Error(
            `Failed to get funds from faucet: ${JSON.stringify(response.data)}`,
        );
    }
}