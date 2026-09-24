import type { ExecutionNetwork } from './market.js';
import type { RpcUrls } from './transaction-verifier.js';

export type ExecutionConfig = {
  network: ExecutionNetwork;
  rpcUrls: RpcUrls;
  maxExecutionUsd: number;
};

// Defaults to devnet no matter what -- going live on mainnet is a deliberate, explicit env change,
// never an accident of a missing variable.
export function executionConfigFromEnvironment(): ExecutionConfig {
  const network: ExecutionNetwork = process.env.EXECUTION_NETWORK === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
  const devnet = process.env.SOLANA_DEVNET_RPC_URL?.trim() || 'https://api.devnet.solana.com';
  const mainnet = process.env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
  const parsedMax = Number(process.env.MAX_EXECUTION_USD);
  const maxExecutionUsd = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 50;
  return { network, rpcUrls: { devnet, mainnet }, maxExecutionUsd };
}

export const previewExecutionConfig: ExecutionConfig = {
  network: 'devnet',
  rpcUrls: { devnet: 'https://api.devnet.solana.com', mainnet: 'https://api.mainnet-beta.solana.com' },
  maxExecutionUsd: 50,
};
