import { AccountConfig, ChainMap, InterchainAccount } from '@hyperlane-xyz/sdk';
import {
  Address,
  assert,
  eqAddress,
  objFilter,
  objMap,
} from '@hyperlane-xyz/utils';

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

  const originOwner = ownerOverride ?? config.owners[ownerChain]?.owner;
  if (!originOwner) {
    throw new Error(`No owner found for ${ownerChain}`);
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
    console.log(
      'Chains not supplied, using all ICA supported chains:',
      ica.chains(),
    );
    chains = ica.chains();
  }

  let artifacts: ChainMap<IcaArtifact>;
  try {
    artifacts = readAbacusWorksIcas(environment);
  } catch (err) {
    console.error('Error reading artifacts, defaulting to no artifacts:', err);
    artifacts = {};
  }

  const results: Record<
    string,
    { ica: Address; ism: Address; deployed?: string; recovered?: string }
  > = {};
  for (const chain of chains) {
    console.log('Checking ICA for', chain);

    const chainArtifact = artifacts[chain];
    const chainOwnerConfig = {
      ...ownerConfig,
      ismOverride: chainArtifact?.ism ?? (await ica.ism(chain, ownerChain)),
    };

    const account = await ica.getAccount(chain, chainOwnerConfig);
    results[chain] = { ica: account, ism: chainOwnerConfig.ismOverride };

    if (chainArtifact) {
      // Try to recover the account
      const recoveredAccount = await ica.getAccount(chain, chainOwnerConfig);
      if (eqAddress(recoveredAccount, chainArtifact.ica)) {
        results[chain].recovered = '✅';
        continue;
      } else {
        console.error(
          `⚠️⚠️⚠️ Failed to recover ICA for ${chain}. Expected: ${
            chainArtifact.ica
          }, got: ${recoveredAccount}. Chain owner config: ${JSON.stringify(
            chainOwnerConfig,
          )} ⚠️⚠️⚠️`,
        );
        results[chain].recovered = '❌';
      }
    }

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

main()
  .then()
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
