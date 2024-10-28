import { ethers } from 'ethers';

import {
  AccountConfig,
  AggregationIsmConfig,
  ChainMap,
  EV5JsonRpcTxSubmitter,
  EvmIsmModule,
  InterchainAccount,
  IsmConfig,
  IsmType,
  MultiProvider,
  MultisigConfig,
  MultisigIsmConfig,
  defaultMultisigConfigs,
  normalizeConfig,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  assert,
  deepEquals,
  eqAddress,
  objFilter,
  objMap,
} from '@hyperlane-xyz/utils';

import awValidators from '../config/environments/mainnet3/aw-validators/hyperlane.json';
import { DEPLOYER as mainnet3Deployer } from '../config/environments/mainnet3/owners.js';
import {
  IcaArtifact,
  persistAbacusWorksIcas,
  readAbacusWorksIcas,
} from '../src/config/icas.js';
import { isEthereumProtocolChain } from '../src/utils/utils.js';

import {
  getAbacusWorksIcasPath,
  getArgs as getEnvArgs,
  withChains,
} from './agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from './core-utils.js';

function getArgs() {
  return withChains(getEnvArgs())
    .option('ownerChain', {
      type: 'string',
      description: 'Origin chain where the governing owner lives',
      demandOption: true,
    })
    .option('owner', {
      type: 'string',
      description:
        "Address of the owner on the ownerChain. Defaults to the environment's configured owner for the ownerChain.",
      demandOption: false,
    })
    .option('deploy', {
      type: 'boolean',
      description: 'Deploys the ICA if it does not exist',
      default: false,
    })
    .alias('chains', 'destinationChains').argv;
}

interface IcaDeployResult {
  chain: string;
  result?: IcaArtifact;
  error?: string;
  deployed?: string;
  recovered?: string;
}

async function main() {
  const {
    environment,
    ownerChain,
    chains: chainsArg,
    deploy,
    owner: ownerOverride,
  } = await getArgs();
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  let artifacts: ChainMap<IcaArtifact>;
  try {
    artifacts = await readAbacusWorksIcas(environment);
  } catch (err) {
    console.error('Error reading artifacts, defaulting to no artifacts:', err);
    artifacts = {};
  }

  const originOwner = ownerOverride ?? config.owners[ownerChain]?.owner;
  if (!originOwner) {
    throw new Error(`No owner found for ${ownerChain}`);
  }
  // Protect against accidentally using an ICA as the owner
  if (
    artifacts[ownerChain]?.ica &&
    eqAddress(originOwner, artifacts[ownerChain].ica)
  ) {
    throw new Error(`Origin owner ${originOwner} must not be an ICA!`);
  }

  console.log(`Governance owner on ${ownerChain}: ${originOwner}`);

  const { chainAddresses } = await getHyperlaneCore(environment, multiProvider);
  // Filter out non-EVM chains
  const ethereumChainAddresses = objFilter(
    chainAddresses,
    (chain, _addresses): _addresses is Record<string, string> => {
      return isEthereumProtocolChain(chain);
    },
  );
  const ica = InterchainAccount.fromAddressesMap(
    ethereumChainAddresses,
    multiProvider,
  );

  const ownerConfig: AccountConfig = {
    origin: ownerChain,
    owner: originOwner,
  };

  let chains: string[];
  if (chainsArg) {
    chains = chainsArg;
  } else {
    chains = ica.chains().filter((chain) => chain !== ownerChain);
    console.log(
      'Chains not supplied, using all ICA supported chains other than the owner chain:',
      chains,
    );
  }

  const settledResults = await Promise.allSettled(
    chains.map(async (chain) => {
      const chainArtifact = artifacts[chain];

      // If there's an existing ICA artifact, check if it matches the expected config.
      // If it does, consider it recovered and deployed, and we're done on this chain.
      if (
        chainArtifact &&
        !eqAddress(chainArtifact.ism, ethers.constants.AddressZero)
      ) {
        console.log(
          'Attempting ICA recovery on chain',
          chain,
          'with existing artifact',
          chainArtifact,
        );
        const matches = await icaArtifactMatchesExpectedConfig(
          multiProvider,
          ica,
          chainAddresses,
          ownerChain,
          originOwner,
          chain,
          chainArtifact,
        );
        if (matches) {
          console.log('Recovered ICA on chain', chain);
          return {
            chain,
            result: chainArtifact,
            deployed: '✅',
            recovered: '✅',
          };
        } else {
          console.warn(
            `Chain ${chain} ICA artifact does not match expected config, will redeploy`,
          );
        }
      }

      // At this point, we must do some deploy actions, so back out if not allowed.
      if (!deploy) {
        console.log(
          'Skipping required ISM deployment for chain',
          chain,
          ', will not have an ICA',
        );
        return { chain, result: undefined, deployed: '❌', recovered: '❌' };
      }

      return deployNewIca(
        chain,
        multiProvider,
        ica,
        chainAddresses,
        ownerChain,
        originOwner,
        ownerConfig,
      );
    }),
  );

  // User-friendly output for the console.table
  const results: Record<string, Omit<IcaDeployResult, 'chain'>> = {};
  // Map of chain to ICA artifact
  const icaArtifacts: ChainMap<IcaArtifact> = {};
  settledResults.forEach((settledResult) => {
    if (settledResult.status === 'fulfilled') {
      const { chain, result, error, deployed, recovered } = settledResult.value;
      if (error || !result) {
        console.error(`Failed to process ${chain}:`, error);
      } else {
        results[chain] = {
          deployed,
          recovered,
          ...result,
        };
        icaArtifacts[chain] = result;
      }
    } else {
      console.error(`Promise rejected:`, settledResult.reason);
    }
  });

  console.table(results);

  console.log(
    `Writing results to local artifacts: ${getAbacusWorksIcasPath(
      environment,
    )}`,
  );
  persistAbacusWorksIcas(environment, icaArtifacts);
}

async function deployNewIca(
  chain: string,
  multiProvider: MultiProvider,
  ica: InterchainAccount,
  chainAddresses: ChainMap<Record<string, string>>,
  ownerChain: string,
  originOwner: string,
  ownerConfig: AccountConfig,
): Promise<IcaDeployResult> {
  // First, set the deployer key as the owner of the routing ISM.
  // This is because we don't yet know the ICA address, which depends
  // on the ISM address.
  const initialIsmConfig = getIcaIsm(chain, mainnet3Deployer, mainnet3Deployer);

  console.log('Deploying ISM for ICA on chain', chain);
  const ismModule = await EvmIsmModule.create({
    chain,
    config: initialIsmConfig,
    proxyFactoryFactories: chainAddresses[chain] as any,
    multiProvider,
    mailbox: chainAddresses[chain].mailbox,
  });

  const chainOwnerConfig = {
    ...ownerConfig,
    ismOverride: ismModule.serialize().deployedIsm,
  };

  console.log(
    'Deploying ICA on chain',
    chain,
    'with owner config',
    chainOwnerConfig,
  );

  const deployedIca = await ica.deployAccount(chain, chainOwnerConfig);

  console.log(`Deployed ICA on chain: ${chain}: ${deployedIca}`);

  const finalIsmConfig = getIcaIsm(chain, mainnet3Deployer, deployedIca);

  const submitter = new EV5JsonRpcTxSubmitter(multiProvider);
  const updateTxs = await ismModule.update(finalIsmConfig);
  console.log(
    `Updating routing ISM owner on ${chain} with transactions:`,
    updateTxs,
  );
  await submitter.submit(...updateTxs);

  const newChainArtifact = {
    ica: deployedIca,
    ism: chainOwnerConfig.ismOverride,
  };

  const matches = await icaArtifactMatchesExpectedConfig(
    multiProvider,
    ica,
    chainAddresses,
    ownerChain,
    originOwner,
    chain,
    newChainArtifact,
  );

  if (!matches) {
    console.log(
      `Somehow after everything, the ICA artifact on chain ${chain} still does not match the expected config! There's probably a bug.`,
    );
    return {
      chain,
      result: undefined,
      error: 'Mismatch after deployment',
    };
  }

  return { chain, result: newChainArtifact, deployed: '✅', recovered: '❌' };
}

async function icaArtifactMatchesExpectedConfig(
  multiProvider: MultiProvider,
  ica: InterchainAccount,
  chainAddresses: ChainMap<Record<string, string>>,
  originChain: string,
  originOwner: string,
  icaChain: string,
  icaArtifact: IcaArtifact,
) {
  // First, ensure the ISM matches the config we want.
  // The owner of the routing ISM is the ICA itself.
  const desiredIsmConfig = getIcaIsm(
    icaChain,
    mainnet3Deployer,
    icaArtifact.ica,
  );
  const ismModule = new EvmIsmModule(multiProvider, {
    chain: icaChain,
    config: desiredIsmConfig,
    addresses: {
      ...(chainAddresses[icaChain] as any),
      deployedIsm: icaArtifact.ism,
    },
  });
  const actualIsmConfig = await ismModule.read();

  if (
    !deepEquals(
      normalizeConfig(actualIsmConfig),
      normalizeConfig(desiredIsmConfig),
    )
  ) {
    console.log('ISM mismatch for', icaChain);
    console.log('actualIsmConfig:', JSON.stringify(actualIsmConfig));
    console.log('desiredIsmConfig:', JSON.stringify(desiredIsmConfig));
    return false;
  }

  const chainOwnerConfig = {
    origin: originChain,
    owner: originOwner,
    ismOverride: icaArtifact.ism,
  };

  // Then, confirm that the ISM address is recoverable.
  const account = await ica.getAccount(icaChain, chainOwnerConfig);

  // Try to recover the account
  if (eqAddress(account, icaArtifact.ica)) {
    return true;
  } else {
    console.error(
      `⚠️⚠️⚠️ Failed to recover ICA for ${icaChain}. Expected: ${
        icaArtifact.ica
      }, got: ${account}. Chain owner config: ${JSON.stringify(
        chainOwnerConfig,
      )} ⚠️⚠️⚠️`,
    );
    return false;
  }
}

// -- ISM config generation --

const merkleRoot = (multisig: MultisigConfig): MultisigIsmConfig => ({
  type: IsmType.MERKLE_ROOT_MULTISIG,
  ...multisig,
});

const messageIdIsm = (multisig: MultisigConfig): MultisigIsmConfig => ({
  type: IsmType.MESSAGE_ID_MULTISIG,
  ...multisig,
});

const aggregationIsm = (multisig: MultisigConfig): AggregationIsmConfig => ({
  type: IsmType.AGGREGATION,
  modules: [messageIdIsm(multisig), merkleRoot(multisig)],
  threshold: 1,
});

function getIcaIsm(
  originChain: string,
  deployer: string,
  routingIsmOwner: string,
): IsmConfig {
  const multisig = defaultMultisigConfigs[originChain];
  const awValidator =
    awValidators[originChain as keyof typeof awValidators].validators?.[0];
  // Ensure the AW validator was found and is in the multisig.
  if (
    !awValidator ||
    !multisig.validators.find((v) => eqAddress(v, awValidator))
  ) {
    throw new Error(
      `AW validator for ${originChain} (address: ${awValidator}) found in the validator set`,
    );
  }

  // A routing ISM so that the ISM is mutable without requiring a new ICA,
  // as the ICA address depends on the ISM address.
  return {
    type: IsmType.ROUTING,
    owner: routingIsmOwner,
    domains: {
      [originChain]: {
        type: IsmType.AGGREGATION,
        modules: [
          // This will always use the default ISM.
          // We burn ownership and have no domains in the routing table.
          {
            type: IsmType.FALLBACK_ROUTING,
            owner: '0xdead00000000000000000000000000000000dead',
            domains: {},
          },
          {
            type: IsmType.AGGREGATION,
            modules: [
              aggregationIsm(multisig),
              messageIdIsm({
                validators: [awValidator, deployer],
                threshold: 1,
              }),
            ],
            threshold: 1,
          },
        ],
        threshold: 2,
      },
    },
  };
}

main()
  .then()
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
