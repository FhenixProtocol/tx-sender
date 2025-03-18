"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("@nomicfoundation/hardhat-toolbox");
require("dotenv/config");
const config = {
    solidity: {
        version: "0.8.28",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200,
            },
        },
    },
    networks: {
        hardhat: {
            initialBaseFeePerGas: 1000000000, // Set initial base fee (1 gwei)
            allowUnlimitedContractSize: true, // Avoid contract size issues
            chainId: 420105,
            hardfork: "london",
            mining: {
                auto: false, // Disable auto-mining so transactions stay pending
            },
        },
    },
};
exports.default = config;
