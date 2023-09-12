import { ChainMap, ChainMetadata, chainMetadata } from '@hyperlane-xyz/sdk';

import { AgentChainNames, Role } from '../../../src/roles';

// Blessed
export const ethereumTestnetConfigs: ChainMap<ChainMetadata> = {
  alfajores: chainMetadata.alfajores,
  fuji: chainMetadata.fuji,
  mumbai: {
    ...chainMetadata.mumbai,
    transactionOverrides: {
      maxFeePerGas: 70 * 10 ** 9, // 70 gwei
      maxPriorityFeePerGas: 40 * 10 ** 9, // 40 gwei
    },
  },
  bsctestnet: chainMetadata.bsctestnet,
  goerli: chainMetadata.goerli,
  sepolia: chainMetadata.sepolia,
  moonbasealpha: chainMetadata.moonbasealpha,
  optimismgoerli: chainMetadata.optimismgoerli,
  arbitrumgoerli: chainMetadata.arbitrumgoerli,
};

// Blessed
export const nonEthereumTestnetConfigs: ChainMap<ChainMetadata> = {
  solanadevnet: chainMetadata.solanadevnet,
};

export const testnetConfigs: ChainMap<ChainMetadata> = {
  ...ethereumTestnetConfigs,
  ...nonEthereumTestnetConfigs,
};

// "Blessed" chains that we want core contracts for.
export type TestnetChains = keyof typeof testnetConfigs;
export const supportedChainNames = Object.keys(
  testnetConfigs,
) as TestnetChains[];

export const ethereumChainNames = Object.keys(
  ethereumTestnetConfigs,
) as TestnetChains[];

export const environment = 'testnet3';

// Chains that we want to run agents for.
const validatorChainNames = [
  ...supportedChainNames,
  chainMetadata.proteustestnet.name,
];

const relayerChainNames = validatorChainNames;

export const agentChainNames: AgentChainNames = {
  [Role.Validator]: validatorChainNames,
  [Role.Relayer]: relayerChainNames,
  [Role.Scraper]: ethereumChainNames,
};
