import { password } from '@inquirer/prompts';
import {
  BigNumber,
  BigNumberish,
  Wallet,
  constants,
  ethers,
  utils,
} from 'ethers';
import { BytesLike, keccak256 } from 'ethers/lib/utils.js';

import { ECDSAStakeRegistry__factory } from '@hyperlane-xyz/core';
import { ChainName } from '@hyperlane-xyz/sdk';
import { Address, addressToBytes32 } from '@hyperlane-xyz/utils';

import { WriteCommandContext } from '../context/types.js';
import { runPreflightChecksForChains } from '../deploy/utils.js';
import { log, logBlue } from '../logger.js';
import { readFileAtPath, resolvePath } from '../utils/files.js';

import { avsAddresses } from './config.js';

export type SignatureWithSaltAndExpiryStruct = {
  signature: BytesLike;
  salt: BytesLike;
  expiry: BigNumberish;
};

export async function registerOperatorWithSignature({
  context,
  chain,
  operatorKeyPath,
}: {
  context: WriteCommandContext;
  chain: ChainName;
  operatorKeyPath: string;
}) {
  const { multiProvider, signer } = context;

  await runPreflightChecksForChains({
    context,
    chains: [chain],
    minGas: '0',
  });

  const provider = multiProvider.getProvider(chain);
  const connectedSigner = signer.connect(provider);

  // Read the encrypted JSON key from the file
  const encryptedJson = readFileAtPath(resolvePath(operatorKeyPath));

  const keyFilePassword = await password({
    mask: '*',
    message: 'Enter the password for the operator key file: ',
  });

  const operator = await ethers.Wallet.fromEncryptedJson(
    encryptedJson,
    keyFilePassword,
  );

  // TODO: use registry for AVS contract addresses
  const stakeRegistryAddress = avsAddresses[chain].ecdsaStakeRegistry;

  const ecdsaStakeRegistry = ECDSAStakeRegistry__factory.connect(
    stakeRegistryAddress,
    connectedSigner,
  );

  const domainId = multiProvider.getDomainId(chain);
  const operatorSignature = await getOperatorSignature(
    domainId,
    avsAddresses[chain].hyperlaneServiceManager,
    avsAddresses[chain].avsDirectory,
    operator,
  );

  log(`Registering operator ${operator.address} with signature on ${chain}...`);
  await multiProvider.handleTx(
    chain,
    ecdsaStakeRegistry.registerOperatorWithSignature(
      operator.address,
      operatorSignature,
    ),
  );
  logBlue(`Operator ${operator.address} registered to Hyperlane AVS`);
}

export async function deregisterOperator({
  context,
  chain,
  operatorKeyPath,
}: {
  context: WriteCommandContext;
  chain: ChainName;
  operatorKeyPath: string;
}) {
  const { multiProvider } = context;

  await runPreflightChecksForChains({
    context,
    chains: [chain],
    minGas: '0',
  });

  // Read the encrypted JSON key from the file
  const encryptedJson = readFileAtPath(resolvePath(operatorKeyPath));

  const keyFilePassword = await password({
    mask: '*',
    message: 'Enter the password for the operator key file: ',
  });

  const operatorAsSigner = await ethers.Wallet.fromEncryptedJson(
    encryptedJson,
    keyFilePassword,
  );

  const provider = multiProvider.getProvider(chain);
  const connectedSigner = operatorAsSigner.connect(provider);

  // TODO: use registry for AVS contract addresses
  const stakeRegistryAddress = avsAddresses[chain].ecdsaStakeRegistry;

  const ecdsaStakeRegistry = ECDSAStakeRegistry__factory.connect(
    stakeRegistryAddress,
    connectedSigner,
  );

  log(
    `Registering operator ${operatorAsSigner.address} with signature on ${chain}...`,
  );
  await multiProvider.handleTx(chain, ecdsaStakeRegistry.deregisterOperator());
  logBlue(`Operator ${operatorAsSigner.address} registered to Hyperlane AVS`);
}

async function getOperatorSignature(
  domain: number,
  serviceManager: Address,
  avsDirectory: Address,
  operator: Wallet,
): Promise<SignatureWithSaltAndExpiryStruct> {
  const operatorRegistrationTypehash = keccak256(
    ethers.utils.toUtf8Bytes(
      'OperatorAVSRegistration(address operator,address avs,bytes32 salt,uint256 expiry)',
    ),
  );

  const salt = constants.HashZero;

  // give a expiry timestamp 1 week from now
  // const expiry = utils.hexZeroPad(
  //   utils.hexlify(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7),
  //   32,
  // );
  const maxExpiration = utils.hexZeroPad(
    utils.hexlify(BigNumber.from(2).pow(256).sub(1)),
    32,
  );

  const structHash = keccak256(
    ethers.utils.solidityPack(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [
        operatorRegistrationTypehash,
        addressToBytes32(operator.address),
        addressToBytes32(serviceManager),
        salt,
        maxExpiration,
      ],
    ),
  );

  const domainSeparator = getDomainSeparator(domain, avsDirectory);

  const signingHash = ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ['bytes', 'bytes32', 'bytes32'],
      [ethers.utils.toUtf8Bytes('\x19\x01'), domainSeparator, structHash],
    ),
  );

  const signature = await operator.signMessage(
    ethers.utils.arrayify(signingHash),
  );

  return {
    signature,
    salt,
    expiry: maxExpiration,
  };
}

function getDomainSeparator(domain: number, avsDirectory: Address): string {
  if (!avsDirectory) {
    throw new Error(
      'Invalid domain for operator to the AVS, currently only Ethereum Mainnet and Holesky are supported.',
    );
  }

  const domainTypehash = keccak256(
    ethers.utils.toUtf8Bytes(
      'EIP712Domain(string name,uint256 chainId,address verifyingContract)',
    ),
  );
  const domainBN = utils.hexZeroPad(utils.hexlify(domain), 32);
  const eigenlayerDigest = keccak256(ethers.utils.toUtf8Bytes('EigenLayer'));
  const domainSeparator = keccak256(
    ethers.utils.solidityPack(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [
        domainTypehash,
        eigenlayerDigest,
        domainBN,
        addressToBytes32(avsDirectory),
      ],
    ),
  );

  return domainSeparator;
}
