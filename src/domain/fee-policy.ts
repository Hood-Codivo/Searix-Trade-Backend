export type FeePolicy = {
  enabled: boolean;
  standardFeeBps: number;
  proFeeBps: number;
  treasuryAddress: string | null;
};

const parseBps = (value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
};

export function feePolicyFromEnvironment(): FeePolicy {
  const treasuryAddress = process.env.PHOENIX_TREASURY_ADDRESS?.trim() || null;
  return {
    enabled: process.env.PHOENIX_FEES_ENABLED === 'true' && Boolean(treasuryAddress),
    standardFeeBps: parseBps(process.env.PHOENIX_FEE_BPS, 15),
    proFeeBps: parseBps(process.env.PHOENIX_PRO_FEE_BPS, 5),
    treasuryAddress,
  };
}

export const previewFeePolicy: FeePolicy = {
  enabled: false,
  standardFeeBps: 15,
  proFeeBps: 5,
  treasuryAddress: null,
};
