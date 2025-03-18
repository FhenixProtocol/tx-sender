import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";


const config: HardhatUserConfig = {
  networks: {
    hardhat: {
      initialBaseFeePerGas: 1000000000, // Set initial base fee (1 gwei)
      allowUnlimitedContractSize: true, // Avoid contract size issues
      chainId: 420105,
      accounts: [
        {
          privateKey: process.env.HARDHAT_PRIVATE_KEY as string,
          balance: "100000000000000000000", // 100 ETH for testing
        },
      ],
      mining: {
        auto: false, // Disable auto-mining so transactions stay pending
      },
    },
  },
  solidity: "0.8.28",
};

export default config;
