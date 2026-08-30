import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Wallet } from 'ethers';
import {
  CORE_CONTRACT_NAMES,
  parseV3DeploymentArguments,
  reserveV3Manifest,
  runV3Preflight,
  validateV3DeploymentConfig,
} from '../scripts/lib/v3-deployment.mjs';

function fixtureConfig(deployer) {
  return {
    generation: 'v3-core',
    chainId: 102031,
    verifier: '0x0000000000000000000000000000000000000FD2',
    asset: {
      address: '0x1000000000000000000000000000000000000001',
      decimals: 6,
    },
    roles: {
      deployer,
      lender: '0x2000000000000000000000000000000000000002',
      borrower: '0x3000000000000000000000000000000000000003',
      guardian: '0x4000000000000000000000000000000000000004',
    },
    pilotBounds: {
      maximumFacilityLimit: '100000000000',
      maximumTotalLimit: '300000000000',
      minimumBondBps: 2000,
      maximumDrawFeeBps: 400,
      maximumMaturityBlocks: 100000,
      maximumDrawDelayBlocks: 50,
      maximumFacilityCount: 3,
    },
    requirements: {
      nativeBalances: [{ role: 'deployer', minimumWei: '1000' }],
      assetBalances: [{ role: 'lender', minimumBaseUnits: '2000' }],
      assetAllowances: [
        {
          ownerRole: 'lender',
          spender: '0x5000000000000000000000000000000000000005',
          minimumBaseUnits: '3000',
        },
      ],
    },
  };
}

function artifacts() {
  return Object.fromEntries(
    CORE_CONTRACT_NAMES.map((name) => [name, { abi: [], bytecode: { object: '0x6000' } }]),
  );
}

test('V3 deployment arguments are dry-run by default and require an explicit broadcast flag', () => {
  assert.deepEqual(parseV3DeploymentArguments([]), {
    broadcast: false,
    configPath: 'config/v3-cc3.json',
    manifestPath: 'deployments-v3.json',
  });
  assert.deepEqual(parseV3DeploymentArguments(['--broadcast', '--config', 'pilot.json', '--manifest', 'record.json']), {
    broadcast: true,
    configPath: 'pilot.json',
    manifestPath: 'record.json',
  });
  assert.throws(() => parseV3DeploymentArguments(['--send']), /Unknown argument: --send/);
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(packageJson.scripts['deploy:v3'], 'node scripts/deploy-v3.mjs');
});

test('V3 manifest reservation fails closed across concurrent and interrupted broadcasts', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'recourse-v3-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, 'deployments-v3.json');
  const temporaryPath = `${manifestPath}.tmp`;

  writeFileSync(temporaryPath, 'interrupted write');
  assert.throws(() => reserveV3Manifest(manifestPath), /temporary manifest already exists/);
  rmSync(temporaryPath);

  const release = reserveV3Manifest(manifestPath);
  assert.equal(existsSync(`${manifestPath}.lock`), true);
  assert.throws(() => reserveV3Manifest(manifestPath), /deployment lock already exists/);
  release();
  assert.equal(existsSync(`${manifestPath}.lock`), false);

  writeFileSync(manifestPath, '{}');
  assert.throws(() => reserveV3Manifest(manifestPath), /manifest already exists/);
});

test('V3 deployment config requires separated roles and coherent pilot bounds', () => {
  const signer = Wallet.createRandom();
  const valid = fixtureConfig(signer.address);
  assert.equal(validateV3DeploymentConfig(valid).roles.deployer, signer.address);

  assert.throws(
    () =>
      validateV3DeploymentConfig({
        ...valid,
        roles: {
          ...valid.roles,
          guardian: '0x0000000000000000000000000000000000000000',
        },
      }),
    /guardian must not be the zero address/,
  );
  assert.throws(
    () => validateV3DeploymentConfig({ ...valid, roles: { ...valid.roles, guardian: valid.roles.lender } }),
    /roles must be distinct/,
  );
  assert.throws(
    () =>
      validateV3DeploymentConfig({
        ...valid,
        pilotBounds: { ...valid.pilotBounds, maximumTotalLimit: '99999999999' },
      }),
    /maximumTotalLimit must be at least maximumFacilityLimit/,
  );
});

test('V3 preflight validates chain, verifier, signer, asset, balances, allowances, and artifacts', async () => {
  const signer = Wallet.createRandom();
  const config = fixtureConfig(signer.address);
  const normalized = validateV3DeploymentConfig(config);
  const provider = {
    getNetwork: async () => ({ chainId: 102031n }),
    getCode: async () => '0x6000',
    getBalance: async () => 1000n,
  };
  const asset = {
    decimals: async () => 6n,
    balanceOf: async () => 2000n,
    allowance: async () => 3000n,
  };
  const verifier = { calculateTxIndex: async () => 0n };

  const result = await runV3Preflight({
    provider,
    signer,
    verifier,
    asset,
    config: normalized,
    artifacts: artifacts(),
  });
  assert.deepEqual(result, {
    chainId: 102031,
    deployer: signer.address,
    verifierPrecompileResponsive: true,
    assetCodePresent: true,
    checkedNativeBalances: 1,
    checkedAssetBalances: 1,
    checkedAssetAllowances: 1,
    checkedArtifacts: CORE_CONTRACT_NAMES.length,
  });

  await assert.rejects(
    () =>
      runV3Preflight({
        provider,
        signer,
        verifier,
        asset: { ...asset, allowance: async () => 2999n },
        config: normalized,
        artifacts: artifacts(),
      }),
    /Insufficient asset allowance for lender/,
  );
});
