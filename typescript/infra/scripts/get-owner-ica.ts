import { ethers } from 'ethers';

import {
  AccountConfig,
  AggregationIsmConfig,
  ChainMap,
  EvmIsmModule,
  InterchainAccount,
  IsmConfig,
  IsmType,
  MultisigConfig,
  MultisigIsmConfig,
  defaultMultisigConfigs,
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
    (chain, addresses): addresses is Record<string, string> => {
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

  const results: Record<
    string,
    {
      ica: Address;
      ism: Address;
      deployed?: string;
      recovered?: string;
      ismRequiredNewDeploy?: string;
    }
  > = {};
  for (const chain of chains) {
    console.log('Checking ICA for', chain);

    const chainArtifact = artifacts[chain];
    const chainOwnerConfig = {
      ...ownerConfig,
      ismOverride: chainArtifact?.ism ?? (await ica.ism(chain, ownerChain)),
    };

    let deployNewIsm = true;

    // Let's confirm the ISM config is correct

    // For now, hardcode Celo
    const deployedIsm = eqAddress(
      chainOwnerConfig.ismOverride,
      ethers.constants.AddressZero,
    )
      ? '0xa6f4835940dbA46E295076D0CD0411349C33789f'
      : chainOwnerConfig.ismOverride;

    const desiredIsmConfig = getIcaIsm(
      chain,
      '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
      '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
    );
    const ismModule = new EvmIsmModule(multiProvider, {
      chain,
      config: desiredIsmConfig,
      addresses: {
        ...(chainAddresses[chain] as any),
        deployedIsm: deployedIsm,
      },
    });

    const actualIsmConfig = await ismModule.read();

    console.log('deployedIsm:', deployedIsm);
    console.log('Actual ISM config:', JSON.stringify(actualIsmConfig, null, 2));
    console.log(
      'Desired ISM config:',
      JSON.stringify(desiredIsmConfig, null, 2),
    );
    console.log('eq?', deepEquals(actualIsmConfig, desiredIsmConfig));

    if (deepEquals(actualIsmConfig, desiredIsmConfig)) {
      deployNewIsm = false;
    } else {
      console.log('Must deploy a new ISM, ignoring any existing ICA artifacts');
    }

    const account = await ica.getAccount(chain, chainOwnerConfig);
    results[chain] = { ica: account, ism: chainOwnerConfig.ismOverride };

    if (chainArtifact && !deployNewIsm) {
      // Try to recover the account
      if (eqAddress(account, chainArtifact.ica)) {
        results[chain].recovered = '✅';
      } else {
        console.error(
          `⚠️⚠️⚠️ Failed to recover ICA for ${chain}. Expected: ${
            chainArtifact.ica
          }, got: ${account}. Chain owner config: ${JSON.stringify(
            chainOwnerConfig,
          )} ⚠️⚠️⚠️`,
        );
        results[chain].recovered = '❌';
        continue;
      }
    }

    results[chain].ismRequiredNewDeploy = deployNewIsm ? '✅' : '❌';

    if (deploy) {
      const deployedAccount = await ica.deployAccount(chain, ownerConfig);
      assert(
        eqAddress(account, deployedAccount),
        'Fatal mismatch between account and deployed account',
      );
      results[chain].deployed = '✅';
    }
  }

  console.table(results);

  const icaArtifacts = objMap(results, (_chain, { ica, ism }) => ({
    ica,
    ism,
  }));

  console.log(
    `Writing results to local artifacts: ${getAbacusWorksIcasPath(
      environment,
    )}`,
  );
  persistAbacusWorksIcas(environment, icaArtifacts);
}

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

// Plan:
//

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
