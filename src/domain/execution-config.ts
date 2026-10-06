import type { ExecutionNetwork } from "./market.js";
import type { RpcUrls } from "./transaction-verifier.js";

export type ExecutionConfig = {
  network: ExecutionNetwork;
  rpcUrls: RpcUrls;
  maxExecutionUsd: number;
};

// Execution is mainnet-only. Real swaps move real funds, so there is no testnet mode to fall back to.
export function executionConfigFromEnvironment(): ExecutionConfig {
  const mainnet =
    process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
  const parsedMax = Number(process.env.MAX_EXECUTION_USD);
  const maxExecutionUsd =
    Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 50;
  return { network: "mainnet-beta", rpcUrls: { mainnet }, maxExecutionUsd };
}

export const previewExecutionConfig: ExecutionConfig = {
  network: "mainnet-beta",
  rpcUrls: { mainnet: "https://api.mainnet-beta.solana.com" },
  maxExecutionUsd: 50,
};
