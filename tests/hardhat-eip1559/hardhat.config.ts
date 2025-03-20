import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

// Default to this private key if none is provided
const DEFAULT_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const config: HardhatUserConfig = {
  networks: {
    hardhat: {
      initialBaseFeePerGas: 1000000000, // Set initial base fee (1 gwei)
      allowUnlimitedContractSize: true, // Avoid contract size issues
      chainId: 420105,
      accounts: [
        {
          privateKey: process.env.HARDHAT_PRIVATE_KEY || DEFAULT_PRIVATE_KEY,
          balance: "100000000000000000000", // 100 ETH for testing
        },
      ],
      mining: {
        auto: false, // Disable auto-mining so transactions stay pending
      },
    },
    // Configuration for connecting to a local node (like Ganache or a local blockchain)
    localhost: {
      url: "http://127.0.0.1:8545",
      timeout: 60000,
    },
    // Configuration for connecting to an external node
    externalNode: {
      url: process.env.EXTERNAL_NODE_URL || "http://localhost:8545",
      accounts: [process.env.EXTERNAL_PRIVATE_KEY || DEFAULT_PRIVATE_KEY],
      timeout: 60000,
    },
  },
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
};

export default config;
