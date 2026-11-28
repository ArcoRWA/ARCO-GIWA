import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, getAddress, http } from 'viem';
import { PrismaArcoUSDAlertStore } from '../../server/dist/arcousd/alerts.js';
import { parseArcoUSDKeeperEnv } from '../../server/dist/arcousd/keeper-config.js';
import { ArcoUSDKeeper, guardedKeeperSigner, keeperHeldRoles, runKeeperLoop, viemKeeperRpc } from '../../server/dist/arcousd/keeper.js';
import { deployedArcoGold, readArcoGoldRegistry } from '../../server/dist/arcogold/registry.js';
import { createArcoUSDChainReader } from '../../server/dist/arcousd/reader.js';
import { deployedArcoUSD, readArcoUSDRegistry } from '../../server/dist/arcousd/registry.js';
import { safeErrorText } from '../../server/dist/arcousd/safe-error.js';
import { createPrismaClient } from '../../server/dist/db/prisma.js';
import {
  FundPriceBot, guardedPriceSigner, parseFundPriceBotEnv, PRICE_BOT_GAS_LIMIT, priceBotFunds, priceBotRoles, runPriceBotLoop, viemPriceBotRpc,
} from '../../server/dist/funds/price-bot.js';
import { readRegistryFile } from '../../server/dist/registry/io.js';
import { GIWA_CHAIN_ID } from '../../server/dist/registry/products.js';
import { createLocalKeystoreCustody } from '../../server/dist/stocks-signer/custody-local.js';
import { readSecretPassword, withPrivateKeystoreCopy } from '../stocks-signer/secret-files.mjs';

// ArcoUSD keeper (docs/operations/arcousd-keeper.md), a Render background worker.
//
//   node scripts/arcousd/run-keeper.mjs [--keystore <abs path> --password-file <abs path>] [--check]
//
// ARCOUSD_KEEPER_MODE=off (default) idles, dry-run simulates and reports, live signs and sends
// Reserve.processQueue and, once Savings is deployed, the distributor's distribute()
// (ARCOUSD_KEEPER_DISTRIBUTE=off leaves distribute to the console). When the ArcoGOLD registry records a
// distributor, the same wallet also sends that distributor's distribute(): one more permissionless call, no new role. Live needs the encrypted keystore and its password as two platform secret
// files (like the Stocks signer service); neither a key nor a password is ever read from the
// environment — the keeper refuses to start if one is there. --check validates the settings, unlocks
// the keystore (live) and checks the RPC chain, then exits without sending anything.
// Failures print one fixed line with the stage only (plus invalid setting NAMES).
//
const FORBIDDEN_ENV = [
  'DEPLOYER_PRIVATE_KEY',
  'GIWA_KEYSTORE_PASSWORD',
  'STOCKS_SIGNER_PRIVATE_KEY',
  'STOCKS_SIGNER_KEYSTORE_PASSWORD',
  'ARCOUSD_KEEPER_PRIVATE_KEY',
  'ARCOUSD_KEEPER_KEYSTORE_PASSWORD',
  'FUND_PRICE_BOT_PRIVATE_KEY',
  'FUND_PRICE_BOT_KEYSTORE_PASSWORD',
];
const PRICE_KEYSTORE_DEFAULT = '/etc/secrets/fund-price-bot-keystore.json';
const PRICE_PASSWORD_DEFAULT = '/etc/secrets/fund-price-bot-password';
// …and anything shaped like one: a key or password belongs in a Secret File, never in the environment.
const FORBIDDEN_ENV_PATTERN = /PRIVATE_KEY|KEYSTORE_PASSWORD|MNEMONIC|SEED_PHRASE|KEEPER_PASSWORD/i;

function parseArgs(args) {
  const out = { keystore: null, passwordFile: null, priceKeystore: PRICE_KEYSTORE_DEFAULT, pricePasswordFile: PRICE_PASSWORD_DEFAULT, check: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') out.check = true;
    else if (args[i] === '--keystore' && isAbsolute(args[i + 1] ?? '')) out.keystore = args[++i];
    else if (args[i] === '--password-file' && isAbsolute(args[i + 1] ?? '')) out.passwordFile = args[++i];
    else if (args[i] === '--price-keystore' && isAbsolute(args[i + 1] ?? '')) out.priceKeystore = args[++i];
    else if (args[i] === '--price-password-file' && isAbsolute(args[i + 1] ?? '')) out.pricePasswordFile = args[++i];
    else throw Error('INVALID_ARGUMENTS');
  }
  if ((out.keystore === null) !== (out.passwordFile === null)) throw Error('INVALID_ARGUMENTS');
  return out;
}

const log = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
const abort = new AbortController();
process.on('SIGINT', () => abort.abort());
process.on('SIGTERM', () => abort.abort());

let stage = 'ARGUMENTS';
let prisma = null;
let custody = null;
let priceCustody = null;

// The encrypted-keystore loader lives in packages/contracts (ts-node); registered once, on first use.
let unlockLocalDeploymentWallet = null;
function keystoreLoader() {
  if (!unlockLocalDeploymentWallet) {
    const requireContracts = createRequire(new URL('../../packages/contracts/package.json', import.meta.url));
    requireContracts('ts-node').register({ project: fileURLToPath(new URL('../../packages/contracts/tsconfig.json', import.meta.url)) });
    ({ unlockLocalDeploymentWallet } = requireContracts('./scripts/stocks/local-keystore.ts'));
  }
  return unlockLocalDeploymentWallet;
}

// The fund price bot, set up apart from the keeper: returns null (after one fixed line on stderr) when it is off or
// cannot start, and never throws.
async function setUpPriceBot({ args, client, store }) {
  let botStage = 'CONFIG';
  try {
    const config = parseFundPriceBotEnv(process.env);
    if (config.invalid.length) {
      process.stderr.write(`FUND_PRICE_BOT_CONFIG_INVALID ${config.invalid.join(',')}\n`);
      throw Error('CONFIG_INVALID');
    }
    if (config.mode === 'off') {
      // One "off" heartbeat, so a bot switched off after running is not reported as stopped (watcher, console).
      // An off round reads nothing and signs nothing; tick() never throws.
      if (store) await new FundPriceBot({ chainId: GIWA_CHAIN_ID, config, loadFunds: () => [], rpc: viemPriceBotRpc(client), signer: null, store }).tick();
      return null;
    }
    const loadFunds = () => priceBotFunds(readRegistryFile());
    botStage = 'REGISTRY';
    const funds = loadFunds();
    let signer = null;
    if (config.mode === 'live') {
      botStage = 'KEYSTORE';
      const unlock = keystoreLoader();
      const wallet = await withPrivateKeystoreCopy(args.priceKeystore, (copy) =>
        unlock(copy, config.address, () => readSecretPassword(args.pricePasswordFile)));
      priceCustody = createLocalKeystoreCustody({
        signerAddress: config.address,
        fees: { gas: PRICE_BOT_GAS_LIMIT, maxFeePerGas: config.maxFeePerGas, maxPriorityFeePerGas: config.maxPriorityFeePerGas },
        limits: { maxGas: PRICE_BOT_GAS_LIMIT, maxFeePerGas: config.maxFeePerGas, maxTotalFeeWei: PRICE_BOT_GAS_LIMIT * config.maxFeePerGas },
        signTransaction: wallet.signTransaction,
      });
      signer = guardedPriceSigner({
        address: getAddress(config.address),
        feeds: () => loadFunds().map((fund) => fund.feed),
        chainId: GIWA_CHAIN_ID,
        signOriginal: (request) => priceCustody.signOriginal(request),
      });
    }
    botStage = 'ROLES';
    // Only FEED_ADMIN_ROLE on its feeds: an admin or vault role has no business on a hosted worker. Live also
    // needs the role on every feed; a dry run without it just reports that each post would revert.
    const roles = await priceBotRoles(client, funds, getAddress(config.address));
    if (roles.extra.length) {
      process.stderr.write(`FUND_PRICE_BOT_PRIVILEGED_WALLET ${roles.extra.join(',')}\n`);
      throw Error('PRIVILEGED_WALLET');
    }
    if (config.mode === 'live' && roles.missing.length) {
      process.stderr.write(`FUND_PRICE_BOT_ROLE_MISSING ${roles.missing.join(',')}\n`);
      throw Error('ROLE_MISSING');
    }
    return {
      config,
      bot: store ? new FundPriceBot({ chainId: GIWA_CHAIN_ID, config, loadFunds, rpc: viemPriceBotRpc(client), signer, store }) : null,
    };
  } catch (error) {
    priceCustody?.close();
    priceCustody = null;
    const named = ['CONFIG_INVALID', 'PRIVILEGED_WALLET', 'ROLE_MISSING'].includes(error?.message);
    const detail = (botStage === 'ROLES' || botStage === 'REGISTRY') && !named ? ` error=${JSON.stringify(safeErrorText(error))}` : '';
    process.stderr.write(`FUND_PRICE_BOT_START_FAILED stage=${botStage}${detail}\n`);
    return null;
  }
}
try {
  const args = parseArgs(process.argv.slice(2));
  stage = 'ENVIRONMENT';
  if (FORBIDDEN_ENV.some((name) => process.env[name] !== undefined)
    || Object.keys(process.env).some((name) => FORBIDDEN_ENV_PATTERN.test(name))) throw Error('SECRET_ENV_FORBIDDEN');
  stage = 'CONFIG';
  // Only what the keeper uses: the RPC (same as the indexer) and, when running, the database.
  const rpcUrl = process.env.INDEXER_RPC_URL?.trim() ?? '';
  if (!/^https?:\/\/[^\s]+$/.test(rpcUrl)) throw Error('INDEXER_RPC_URL_REQUIRED');
  const config = parseArcoUSDKeeperEnv(process.env);
  if (config.invalid.length) {
    process.stderr.write(`ARCOUSD_KEEPER_CONFIG_INVALID ${config.invalid.join(',')}\n`);
    throw Error('CONFIG_INVALID');
  }
  const registryPath = process.env.ARCOUSD_REGISTRY_PATH?.trim() || 'deployments/91342/arcousd-giwa.json';
  const loadRegistry = () => readArcoUSDRegistry(registryPath);
  // ArcoGOLD (optional): absent file or no distributor → no gold step. An invalid file throws: the keeper reports
  // it each round and the signer allows nothing extra.
  const goldRegistryPath = process.env.ARCOGOLD_REGISTRY_PATH?.trim() || 'deployments/91342/arcogold-giwa.json';
  const loadGoldStack = () => deployedArcoGold(readArcoGoldRegistry(goldRegistryPath), GIWA_CHAIN_ID);
  const loadGold = () => {
    const gold = loadGoldStack();
    return gold?.distributorAddress ? { distributorAddress: gold.distributorAddress } : null;
  };

  let signer = null;
  if (config.mode === 'live') {
    stage = 'KEYSTORE';
    if (!args.keystore) throw Error('KEYSTORE_REQUIRED');
    const unlock = keystoreLoader();
    const wallet = await withPrivateKeystoreCopy(args.keystore, (copy) =>
      unlock(copy, config.address, () => readSecretPassword(args.passwordFile)));
    custody = createLocalKeystoreCustody({
      signerAddress: config.address,
      fees: { gas: config.gasLimit, maxFeePerGas: config.maxFeePerGas, maxPriorityFeePerGas: config.maxPriorityFeePerGas },
      limits: { maxGas: config.gasLimit, maxFeePerGas: config.maxFeePerGas, maxTotalFeeWei: config.gasLimit * config.maxFeePerGas },
      signTransaction: wallet.signTransaction,
    });
    signer = guardedKeeperSigner({
      address: getAddress(config.address),
      loadRegistry,
      loadGold,
      chainId: GIWA_CHAIN_ID,
      signOriginal: (request) => custody.signOriginal(request),
    });
  }

  stage = 'RPC';
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 1, timeout: 10_000 }) });
  const rpc = viemKeeperRpc(client);
  if ((await rpc.chainId()) !== GIWA_CHAIN_ID) throw Error('WRONG_CHAIN');
  // The keeper needs no role. A wallet holding one on the ArcoUSD or Savings contracts (a deployer, an
  // operator, a pauser, a rewarder) must not sit on a hosted worker: refuse it and name the roles. (Wallets privileged only
  // elsewhere are not detectable here: the runbook says to use a new, dedicated wallet.)
  const deployment = config.address ? deployedArcoUSD(loadRegistry(), GIWA_CHAIN_ID) : null;
  if (deployment) {
    stage = 'ROLES';
    // An unreadable gold file does not stop the ArcoUSD keeper: the signer then allows no gold call either.
    let goldStack = null;
    try { goldStack = loadGoldStack(); } catch { goldStack = null; }
    const held = await keeperHeldRoles(client, deployment, getAddress(config.address), goldStack);
    if (held.length) {
      process.stderr.write(`ARCOUSD_KEEPER_PRIVILEGED_WALLET ${held.join(',')}\n`);
      throw Error('PRIVILEGED_WALLET');
    }
  }
  if (args.check) {
    process.stdout.write(`ARCOUSD_KEEPER_CHECK_PASSED mode=${config.mode}${config.address ? ` address=${config.address}` : ''}\n`);
    const price = await setUpPriceBot({ args, client, store: null });
    if (price) process.stdout.write(`FUND_PRICE_BOT_CHECK_PASSED mode=${price.config.mode} address=${price.config.address}\n`);
  } else {
    stage = 'RUN';
    prisma = createPrismaClient();
    const store = new PrismaArcoUSDAlertStore(prisma);
    const keeper = new ArcoUSDKeeper({
      chainId: GIWA_CHAIN_ID,
      config,
      loadRegistry,
      loadGold,
      readState: createArcoUSDChainReader(client),
      rpc,
      signer,
      store,
    });
    log({ service: 'arco-arcousd-keeper', mode: config.mode, address: config.address, started: true });
    const price = await setUpPriceBot({ args, client, store });
    if (price?.bot) log({ service: 'fund-price-bot', mode: price.config.mode, address: price.config.address, started: true });
    await Promise.all([
      runKeeperLoop({ keeper, intervalMs: config.intervalMs, signal: abort.signal, log }),
      // The bot's rounds never throw; should the loop itself fail, the keeper keeps running.
      price?.bot
        ? runPriceBotLoop({ bot: price.bot, intervalMs: price.config.intervalMs, signal: abort.signal, log })
          .catch((error) => process.stderr.write(`FUND_PRICE_BOT_STOPPED error=${JSON.stringify(safeErrorText(error))}\n`))
        : Promise.resolve(),
    ]);
  }
} catch (error) {
  // Never the error text itself at the key/config stages (it could quote paths or values).
  const detail = (stage === 'RUN' || stage === 'RPC' || stage === 'ROLES') && error?.message !== 'PRIVILEGED_WALLET'
    ? ` error=${JSON.stringify(safeErrorText(error))}` : '';
  process.stderr.write(`ARCOUSD_KEEPER_START_FAILED stage=${stage}${detail}\n`);
  process.exitCode = 1;
} finally {
  custody?.close();
  priceCustody?.close();
  await prisma?.$disconnect?.().catch(() => undefined);
}
