// Real, sourced facts about each tokenized-stock asset -- not live-fetched (this kind of issuer/
// custody/regulatory information doesn't change minute to minute the way a price does), but every
// field here was independently verified against a primary source before being written down, the
// same discipline used to verify the mint addresses on-chain. Anything the primary sources didn't
// state is left explicitly as "not publicly specified" rather than invented.
export type AssetRegistryEntry = {
  symbol: string;
  name: string;
  underlyingSymbol: string;
  mint: string;
  tokenProgram: string;
  issuer: string;
  custody: string;
  backingRatio: string;
  redemption: string;
  jurisdictionRestrictions: string;
  regulatoryFramework: string;
  tradingVenues: string[];
  sources: { label: string; url: string }[];
};

const ISSUER = 'Backed Assets (JE) Limited, a Jersey company registered with the Jersey Financial Services Commission (JFSC), holding COBO/CGPO consents to issue security tokens.';
const CUSTODY = 'Collateral held with regulated custodians and brokers in dedicated, segregated sub-accounts per product; the issuer states no commingling of collateral occurs. Specific custodian entity not publicly named.';
const BACKING = '1:1 -- one token issued per one real underlying share held in custody.';
const REDEMPTION = 'Primary-market issuance/redemption requires onboarding directly with the issuer, including KYC/AML and wallet whitelisting. Three redemption mechanisms exist (atomic RFQ, market flow, in-kind flow); exact fees, minimums, and settlement times are not published on the issuer\'s overview documentation.';
const JURISDICTION = 'Not marketed, offered, or solicited in the United States, to U.S. Persons, or in any other prohibited jurisdiction, per the issuer\'s own statement. No affirmative list of permitted jurisdictions was found in the primary sources checked.';
const REGULATORY = 'Governed by a base prospectus approved by the Liechtenstein Financial Market Authority (FMA) under the EU Prospectus Regulation, passportable across the European Economic Area.';
const VENUES = ['Raydium (primary AMM liquidity)', 'Jupiter (aggregator)'];
const SOURCES = [
  { label: 'xStocks — Product & Legal Overview', url: 'https://docs.xstocks.fi/docs/product-legal-overview' },
  { label: 'xStocks — Issuance and Redemption', url: 'https://docs.xstocks.fi/docs/issuance-and-redemption' },
];

export const assetRegistry: AssetRegistryEntry[] = [
  {
    symbol: 'AAPLX', name: 'Apple xStock', underlyingSymbol: 'AAPL',
    mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    issuer: ISSUER, custody: CUSTODY, backingRatio: BACKING, redemption: REDEMPTION,
    jurisdictionRestrictions: JURISDICTION, regulatoryFramework: REGULATORY, tradingVenues: VENUES, sources: SOURCES,
  },
  {
    symbol: 'TSLAX', name: 'Tesla xStock', underlyingSymbol: 'TSLA',
    mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    issuer: ISSUER, custody: CUSTODY, backingRatio: BACKING, redemption: REDEMPTION,
    jurisdictionRestrictions: JURISDICTION, regulatoryFramework: REGULATORY, tradingVenues: VENUES, sources: SOURCES,
  },
  {
    symbol: 'NVDAX', name: 'NVIDIA xStock', underlyingSymbol: 'NVDA',
    mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    issuer: ISSUER, custody: CUSTODY, backingRatio: BACKING, redemption: REDEMPTION,
    jurisdictionRestrictions: JURISDICTION, regulatoryFramework: REGULATORY, tradingVenues: VENUES, sources: SOURCES,
  },
];

export function getRegistryEntry(symbol: string): AssetRegistryEntry | undefined {
  return assetRegistry.find((entry) => entry.symbol.toLowerCase() === symbol.toLowerCase());
}
