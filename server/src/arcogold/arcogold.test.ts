import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { SAVINGS_DEPOSIT_SELECTOR, SAVINGS_SEED_HOLDER, SAVINGS_WITHDRAW_SELECTOR } from "../arcousd/abi.js"
import { NO_PAUSES, toReserveState, type ArcoUSDChainReader } from "../arcousd/reader.js"
import { toSavingsState, type RawPreview, type RawSavings, type SavingsChainReader } from "../arcousd/savings.js"
import { ounceUsd } from "../services/usd-rates.js"
import { ArcoGoldAdmin } from "./admin.js"
import { ARCOGOLD_REGISTRY_DEFAULT_PATH, parseArcoGoldEnv } from "./config.js"
import { arcoGoldPlugin } from "./plugin.js"
import { deployedArcoGold, goldReserveDeployment, goldSavingsDeployment, readArcoGoldRegistry, validateArcoGoldRegistry, type ArcoGoldRegistryFile } from "./registry.js"
import { ArcoGoldService, OUNCE_USD_SOURCE } from "./service.js"
import { createGoldVaultReader, toGoldVaultState, type GoldVaultReader } from "./vault.js"

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const PAXG = A(0xa1)
const XAUT = A(0xa2)
const ONE = 10n ** 18n

/** What deploy-arcogold-giwa.ts writes once it has finished (packages/contracts/scripts/arcogold/arcogold-registry.ts). */
function registry(overrides: Partial<ArcoGoldRegistryFile> = {}): ArcoGoldRegistryFile {
  const contract = (n: number) => ({ proxy: A(n), implementation: A(n + 100), bytecodeHash: "0x01" as const, blockNumber: 1000 + n })
  return {
    schemaVersion: 1,
    product: "arcogold",
    chainId: 91342,
    network: "giwa-sepolia",
    deployed: true,
    deploymentBlock: 1001,
    faucet: A(0xfa),
    unit: { name: "Arco Gold Ounce", symbol: "ArcoXAU", contract: contract(1) },
    reserve: contract(2),
    lens: { address: A(3), bytecodeHash: "0x02" },
    testAssets: [
      { symbol: "tPAXG", name: "Test PAXG", decimals: 18, contract: contract(0xa1) },
      { symbol: "tXAUT", name: "Test XAUT", decimals: 6, contract: contract(0xa2) },
    ],
    reserveAssets: [
      { symbol: "tPAXG", address: PAXG, decimals: 18, instantFeeBps: 0, swapFeeBps: 0, minQueued: "10000000000000000" },
      { symbol: "tXAUT", address: XAUT, decimals: 6, instantFeeBps: 0, swapFeeBps: 0, minQueued: "10000" },
    ],
    params: { mintCap: "100000000000000000000000", mmfTargetBps: 0, bufferFloorBps: 10000, queueMinDelay: 600 },
    savings: { name: "ArcoGOLD", symbol: "ArcoGOLD", vault: contract(4), zap: { address: A(5), bytecodeHash: "0x03" }, distributor: null, seeded: true },
    ...overrides,
  }
}

const readReserve: ArcoUSDChainReader = async (deployment) =>
  toReserveState(
    deployment,
    77n,
    {
      totalBacking: 5n * ONE,
      totalLiabilities: 5n * ONE,
      navOk: true,
      mmfBps: 0n,
      mmfTargetBps: 0n,
      bufferFloorBps: 10000n,
      queueMinDelay: 600n,
      mintCap: 100_000n * ONE,
      assets: [
        { asset: PAXG, decimals: 18, depositEnabled: true, redeemEnabled: true, instantFeeBps: 0, swapFeeBps: 0, balance: 3n * ONE, queued: 0n, available: 3n * ONE, queueLength: 0n, queueHead: 0n },
        { asset: XAUT, decimals: 6, depositEnabled: true, redeemEnabled: true, instantFeeBps: 0, swapFeeBps: 0, balance: 2_000_000n, queued: 0n, available: 0n, queueLength: 0n, queueHead: 0n },
      ],
      strategies: [],
    },
    new Map([
      [PAXG.toLowerCase(), { depositCap: 2n ** 256n - 1n, minQueued: 10n ** 16n }],
      [XAUT.toLowerCase(), { depositCap: 2n ** 256n - 1n, minQueued: 10_000n }],
    ]),
    NO_PAUSES,
  )

const readVault: GoldVaultReader = async () =>
  toGoldVaultState({
    blockNumber: 77n,
    totalAssets: 5n * ONE,
    totalSupply: 4n * ONE,
    sharePrice: (125n * ONE) / 100n,
    seedShares: ONE,
    minShares: ONE,
    vaultPaused: false,
    depositPaused: false,
    withdrawPaused: false,
  })

function service(loadRegistry: () => ArcoGoldRegistryFile | null, extra: Partial<ConstructorParameters<typeof ArcoGoldService>[0]> = {}) {
  return new ArcoGoldService({ chainId: 91342, loadRegistry, readReserve, readVault, ounceUsd: async () => 2400, ...extra })
}

test("env: the registry path defaults to deployments/91342/arcogold-giwa.json; an empty value counts as unset", () => {
  assert.equal(parseArcoGoldEnv({}).registryPath, ARCOGOLD_REGISTRY_DEFAULT_PATH)
  assert.equal(ARCOGOLD_REGISTRY_DEFAULT_PATH, "deployments/91342/arcogold-giwa.json")
  assert.equal(parseArcoGoldEnv({ ARCOGOLD_REGISTRY_PATH: "  " }).registryPath, ARCOGOLD_REGISTRY_DEFAULT_PATH)
  assert.equal(parseArcoGoldEnv({ ARCOGOLD_REGISTRY_PATH: "/tmp/gold.json" }).registryPath, "/tmp/gold.json")
})

test("registry: an absent file is not deployed; an unfinished deploy is not deployed; a finished one must carry every address", () => {
  const dir = mkdtempSync(join(tmpdir(), "arcogold-"))
  assert.equal(readArcoGoldRegistry(join(dir, "missing.json")), null)
  assert.equal(deployedArcoGold(null, 91342), null)
  // The deploy script records deployed=true only after the seed; until then nothing gold is live.
  assert.equal(deployedArcoGold(registry({ deployed: false, deploymentBlock: null }), 91342), null)
  const file = join(dir, "arcogold-giwa.json")
  writeFileSync(file, JSON.stringify(registry()))
  const gold = deployedArcoGold(readArcoGoldRegistry(file), 91342)!
  assert.deepEqual([gold.unitAddress, gold.reserveAddress, gold.lensAddress, gold.vaultAddress, gold.zapAddress, gold.seeded], [A(1), A(2), A(3), A(4), A(5), true])
  assert.deepEqual(validateArcoGoldRegistry(registry({ chainId: 1 }), 91342), ["chainId must be 91342"])
  assert.match(validateArcoGoldRegistry(registry({ product: "arcousd" as "arcogold" }), 91342).join(";"), /product/)
  const pendingZap = registry()
  const broken = { ...pendingZap, savings: { ...pendingZap.savings, zap: { address: A(5), bytecodeHash: null, pending: true } } }
  assert.throws(() => deployedArcoGold(broken, 91342), /savings.zap is still pending/)
  assert.throws(() => deployedArcoGold({ ...registry(), lens: { address: null, bytecodeHash: null } }, 91342), /lens.address/)
})

test("the gold Reserve is read by the ArcoUSD reader: the unit stands for ArcoUSD, no Router, no strategies", () => {
  const deployment = goldReserveDeployment(deployedArcoGold(registry(), 91342)!)
  assert.deepEqual([deployment.arcoUSDAddress, deployment.reserveAddress, deployment.lensAddress], [A(1), A(2), A(3)])
  assert.deepEqual([deployment.routerAddress, deployment.routerProducts, deployment.strategies, deployment.savings], [null, [], [], null])
  assert.deepEqual(deployment.reserveAssets.map((asset) => [asset.symbol, asset.decimals]), [["tPAXG", 18], ["tXAUT", 6]])
})

test("absent registry: both routes answer 200 not-deployed, and nothing is read", async () => {
  let reads = 0
  const counting = service(() => null, {
    readReserve: async (...args) => (reads++, readReserve(...args)),
    readVault: async (...args) => (reads++, readVault(...args)),
    ounceUsd: async () => (reads++, 2400),
  })
  const app = Fastify()
  await app.register(arcoGoldPlugin, { service: counting })
  for (const url of ["/api/v1/arcogold/reserve", "/api/v1/arcogold/savings"]) {
    const response = await app.inject({ method: "GET", url })
    assert.equal(response.statusCode, 200, url)
    assert.equal(response.headers["cache-control"], "no-store")
    assert.equal(response.json().status, "not-deployed")
    assert.equal(response.json().contracts, null)
  }
  const savings = (await app.inject({ method: "GET", url: "/api/v1/arcogold/savings" })).json()
  assert.deepEqual([savings.savings, savings.ounceUsd, savings.sharePriceUsd, savings.apyPercent], [null, null, null, 3.1])
  assert.equal(reads, 0)
  await app.close()
})

test("a registry that cannot be read or is invalid answers unavailable, never a 500", async () => {
  const app = Fastify()
  await app.register(arcoGoldPlugin, {
    service: service(() => {
      throw new SyntaxError("Unexpected end of JSON input")
    }),
  })
  const reserve = await app.inject({ method: "GET", url: "/api/v1/arcogold/reserve" })
  assert.equal(reserve.statusCode, 200)
  assert.equal(reserve.json().status, "unavailable")
  await app.close()
  const invalid = await service(() => registry({ chainId: 1 })).savingsState()
  assert.equal(invalid.status, "unavailable")
})

test("live: per-coin instant liquidity and totals in ounces; share price, display APY and USD value", async () => {
  const gold = service(() => registry())
  const reserve = await gold.reserveState()
  assert.equal(reserve.status, "live")
  assert.deepEqual(reserve.contracts, { unit: A(1), reserve: A(2), lens: A(3) })
  assert.deepEqual(
    reserve.reserve!.assets.map((asset) => [asset.symbol, asset.decimals, asset.availableHuman]),
    [["tPAXG", 18, "3"], ["tXAUT", 6, "0"]],
  )
  assert.equal(reserve.reserve!.totalBackingOunces, "5")
  const keys = Object.keys(reserve.reserve!)
  for (const dollarField of ["totalBackingUsd", "totalLiabilitiesUsd", "routerPaused", "strategies"]) assert.ok(!keys.includes(dollarField), dollarField)
  assert.equal(reserve.reserve!.redeemInstantOnlyPaused, false)

  const savings = await gold.savingsState()
  assert.equal(savings.status, "live")
  assert.deepEqual(savings.contracts, { arcoGOLD: A(4), zap: A(5), unit: A(1), reserve: A(2), distributor: null })
  assert.equal(savings.savings!.sharePriceHuman, "1.25")
  assert.deepEqual([savings.savings!.depositsOpen, savings.savings!.withdrawalsOpen, savings.savings!.seeded], [true, true, true])
  assert.equal(savings.apyPercent, 3.1)
  assert.deepEqual([savings.ounceUsd, savings.ounceUsdSource, savings.sharePriceUsd, savings.totalAssetsUsd], [2400, OUNCE_USD_SOURCE, 3000, "12000"])
})

test("the ounce source is reported as given: the Kraken fallback says so; a bad quote falls back to null with the primary source", async () => {
  const kraken = await service(() => registry(), { ounceUsd: async () => ({ usd: 2400, source: "kraken:paxg" as const }) }).savingsState()
  assert.deepEqual([kraken.ounceUsd, kraken.ounceUsdSource, kraken.sharePriceUsd], [2400, "kraken:paxg", 3000])
  const bad = await service(() => registry(), { ounceUsd: async () => ({ usd: -1, source: "kraken:paxg" as const }) }).savingsState()
  assert.deepEqual([bad.ounceUsd, bad.ounceUsdSource, bad.sharePriceUsd], [null, OUNCE_USD_SOURCE, null])
})

test("no ounce price: the vault still answers, its USD fields are null (never a made-up price)", async () => {
  for (const ounce of [async () => null, async () => Number.NaN, async () => { throw new Error("rate limited") }]) {
    const savings = await service(() => registry(), { ounceUsd: ounce }).savingsState()
    assert.equal(savings.status, "live")
    assert.equal(savings.savings!.sharePriceHuman, "1.25")
    assert.deepEqual([savings.ounceUsd, savings.sharePriceUsd, savings.totalAssetsUsd], [null, null, null])
  }
})

test("a failed chain read is unavailable with the contracts named; one sweep serves concurrent callers and the cache window", async () => {
  const down = service(() => registry(), {
    readReserve: async () => {
      throw new Error("rpc down")
    },
    readVault: async () => {
      throw new Error("rpc down")
    },
  })
  const reserve = await down.reserveState()
  assert.deepEqual([reserve.status, reserve.contracts?.reserve, reserve.reserve], ["unavailable", A(2), null])
  const savings = await down.savingsState()
  assert.deepEqual([savings.status, savings.contracts?.zap, savings.savings], ["unavailable", A(5), null])

  let reads = 0
  let now = 0
  const cached = service(() => registry(), { readVault: async (...args) => (reads++, readVault(...args)), now: () => now })
  await Promise.all([cached.savingsState(), cached.savingsState(), cached.savingsState()])
  assert.equal(reads, 1)
  now = 14_000
  await cached.savingsState()
  assert.equal(reads, 1)
  now = 16_000
  await cached.savingsState()
  assert.equal(reads, 2)
})

test("vault reader: one block for every read; seeded from the 0x…dEaD holder; the deposit and withdraw switches", async () => {
  const calls: { functionName: string; args: readonly unknown[]; blockNumber?: bigint; address: string }[] = []
  const values: Record<string, unknown> = {
    totalAssets: 2n * ONE,
    totalSupply: 2n * ONE,
    convertToAssets: ONE,
    balanceOf: ONE,
    MIN_SHARES: ONE,
    paused: false,
  }
  const client = {
    getBlockNumber: async () => 900n,
    readContract: async (call: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint; address: string }) => {
      calls.push({ functionName: call.functionName, args: call.args ?? [], blockNumber: call.blockNumber, address: call.address })
      if (call.functionName === "fnPaused") return call.args?.[0] === SAVINGS_WITHDRAW_SELECTOR
      return values[call.functionName]
    },
  }
  const state = await createGoldVaultReader(client as never)(deployedArcoGold(registry(), 91342)!)
  assert.ok(calls.every((call) => call.blockNumber === 900n && call.address === A(4)))
  assert.deepEqual(calls.find((call) => call.functionName === "balanceOf")!.args, [SAVINGS_SEED_HOLDER])
  assert.ok(calls.some((call) => call.functionName === "fnPaused" && call.args[0] === SAVINGS_DEPOSIT_SELECTOR))
  assert.deepEqual([state.seeded, state.depositsOpen, state.withdrawPaused, state.withdrawalsOpen, state.sharePriceHuman], [true, true, true, false, "1"])
  // Not seeded: deposits stay closed whatever the switches say.
  assert.equal(toGoldVaultState({ blockNumber: 1n, totalAssets: 0n, totalSupply: 0n, sharePrice: ONE, seedShares: 0n, minShares: ONE, vaultPaused: false, depositPaused: false, withdrawPaused: false }).depositsOpen, false)
})

test("usd rates: the ounce is PAX Gold's price; unknown or bad values are null", () => {
  assert.equal(ounceUsd({ USDC: 1, BTC: 1, ETH: 1, XRP: 1, XAU: 2412.5 }), 2412.5)
  for (const XAU of [Number.NaN, 0, -1]) assert.equal(ounceUsd({ USDC: 1, BTC: 1, ETH: 1, XRP: 1, XAU }), null)
  assert.equal(ounceUsd(null), null)
})

// ─────────────────────────────── the distributor: real yield ───────────────────────────────

const DISTRIBUTOR = A(6)
function withDistributor(distributor: ArcoGoldRegistryFile["savings"]["distributor"] = { address: DISTRIBUTOR, bytecodeHash: "0x04", blockNumber: 2000 }): ArcoGoldRegistryFile {
  const base = registry()
  return { ...base, savings: { ...base.savings, distributor } }
}

const YEAR = 365n * 86_400n
function rawYield(over: Partial<RawSavings> = {}): RawSavings {
  return {
    blockNumber: 77n,
    totalAssets: 100n * ONE,
    totalSupply: 100n * ONE,
    sharePrice: ONE,
    unvested: 0n,
    vestingAmount: 0n,
    vestingStart: 0n,
    vestingPeriod: 86_400n,
    rewardRate: 0n,
    seedShares: ONE,
    minShares: ONE,
    vaultPaused: false,
    depositPaused: false,
    withdrawPaused: false,
    rewardsPaused: false,
    distributorPaused: false,
    minInterval: 86_400n,
    maxAprBps: 310n,
    reserveMarginBps: 50n,
    lastDistribution: 1_800_000_000n,
    reservePaused: false,
    arcoUSDMintPaused: false,
    ...over,
  }
}
const PREVIEW: RawPreview = [ONE / 1000n, ONE / 4n, ONE / 1000n, 5n * ONE, 1_800_086_400n, true]
/** 3% APR vesting now: rewardRate × 1 year = 3 oz on 100 oz. */
const paying = () => rawYield({ vestingAmount: ONE / 100n, unvested: ONE / 200n, vestingStart: 1_800_000_000n, rewardRate: (3n * ONE) / YEAR })

test("registry: a recorded distributor is read; null, absent or pending is a stack without one; a broken record is invalid", () => {
  assert.equal(deployedArcoGold(registry(), 91342)!.distributorAddress, null)
  assert.equal(goldSavingsDeployment(deployedArcoGold(registry(), 91342)!), null)
  const gold = deployedArcoGold(withDistributor(), 91342)!
  assert.equal(gold.distributorAddress, DISTRIBUTOR)
  // The sArcoUSD reader and the keeper take it as Savings: ArcoXAU where ArcoUSD stands, the gold Reserve as the Reserve.
  assert.deepEqual(goldSavingsDeployment(gold), {
    vaultAddress: A(4),
    distributorAddress: DISTRIBUTOR,
    zapAddress: A(5),
    reserveAddress: A(2),
    arcoUSDAddress: A(1),
    startBlock: 1001,
    seeded: true,
  })
  // A file written before the field existed, and a deploy still waiting for its receipt.
  const { distributor: _gone, ...older } = registry().savings
  assert.equal(deployedArcoGold({ ...registry(), savings: older as ArcoGoldRegistryFile["savings"] }, 91342)!.distributorAddress, null)
  assert.equal(deployedArcoGold(withDistributor({ address: DISTRIBUTOR, bytecodeHash: null, pending: true }), 91342)!.distributorAddress, null)
  assert.throws(() => deployedArcoGold(withDistributor({ address: null, bytecodeHash: null }), 91342), /savings.distributor.address/)
  assert.throws(() => deployedArcoGold(withDistributor({ address: "0x12" as `0x${string}`, bytecodeHash: null }), 91342), /savings.distributor.address/)
})

test("no distributor: the display rate, no yield, and the distributor is never read", async () => {
  let reads = 0
  const readYield: SavingsChainReader = async () => (reads++, toSavingsState(paying(), PREVIEW))
  const savings = await service(registry, { readYield }).savingsState()
  assert.deepEqual([savings.apyPercent, savings.apySource, savings.yield, savings.contracts?.distributor, reads], [3.1, "display", null, null, 0])
})

test("a distributor that has not distributed yet keeps the display rate; after the first distribution the rate is the real one", async () => {
  const asked: unknown[] = []
  const before = await service(withDistributor, {
    readYield: async (deployment) => (asked.push(deployment), toSavingsState(rawYield(), PREVIEW)),
  }).savingsState()
  assert.deepEqual([before.status, before.apyPercent, before.apySource, before.yield?.distributed, before.yield?.currentApyBps], ["live", 3.1, "display", false, 0])
  assert.equal(before.contracts?.distributor, DISTRIBUTOR.toLowerCase())
  assert.deepEqual(asked, [goldSavingsDeployment(deployedArcoGold(withDistributor(), 91342)!)])
  assert.deepEqual(
    [before.yield?.distributor.minIntervalSeconds, before.yield?.distributor.maxAprBps, before.yield?.distributor.reserveMarginBps, before.yield?.distributor.unitMintPaused],
    [86_400, 310, 50, false],
  )
  assert.deepEqual(
    [before.yield?.distributor.preview?.amountOunces, before.yield?.distributor.preview?.surplusOunces, before.yield?.distributor.preview?.navOk],
    ["0.001", "0.25", true],
  )
  assert.equal(before.yield?.distributor.nextDistributionAt, new Date(1_800_086_400_000).toISOString())

  const after = await service(withDistributor, { readYield: async () => toSavingsState(paying(), PREVIEW) }).savingsState()
  const apr = after.yield!.currentAprBps
  assert.ok(apr === 299 || apr === 300, String(apr)) // 3 oz a year on 100 oz (integer division of the per-second rate)
  assert.deepEqual([after.apySource, after.apyPercent, after.yield?.distributed, after.yield?.unvestedOunces, after.yield?.stale], ["distributor", after.yield!.currentApyBps / 100, true, "0.005", false])
  assert.ok(after.apyPercent! > 3 && after.apyPercent! < 3.1)

  // Distributed before, nothing vesting now (the surplus ran out): the real rate is 0, not the display rate.
  const dry = await service(withDistributor, { readYield: async () => toSavingsState(rawYield({ vestingAmount: ONE / 100n }), PREVIEW) }).savingsState()
  assert.deepEqual([dry.apySource, dry.apyPercent], ["distributor", 0])
})

test("a failed distributor read never hides the vault: the last good yield is served as stale, else the display rate", async () => {
  let fail = true
  let now = 1_000_000
  const gold = service(withDistributor, {
    now: () => now,
    readYield: async () => {
      if (fail) throw new Error("rpc down https://rpc.example/key")
      return toSavingsState(paying(), null)
    },
  })
  const first = await gold.savingsState()
  assert.deepEqual([first.status, first.savings?.sharePriceHuman, first.yield, first.apySource, first.apyPercent], ["live", "1.25", null, "display", 3.1])
  fail = false
  now += 20_000
  const good = await gold.savingsState()
  assert.deepEqual([good.apySource, good.yield?.stale, good.yield?.distributor.preview], ["distributor", false, null])
  fail = true
  now += 20_000
  const blip = await gold.savingsState()
  assert.deepEqual([blip.status, blip.apySource, blip.apyPercent, blip.yield?.stale], ["live", "distributor", good.apyPercent, true])
})

test("add surplus: one transfer of a gold coin to the gold Reserve, in the coin's own decimals; refusals say why", async () => {
  const wallet = A(0xee)
  const admin = (loadRegistry: () => ArcoGoldRegistryFile | null, balance = 2_500_000n, surplus: string | null = "100000000000000000") =>
    new ArcoGoldAdmin({ chainId: 91342, loadRegistry, readWallet: async () => ({ balance, allowance: 0n, blockNumber: 1n }), liveSurplus: async () => surplus })
  const built = await admin(withDistributor).addSurplusTransaction({ asset: "tXAUT", amount: "1.5", from: wallet })
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.deepEqual(
    [built.symbol, built.decimals, built.amount, built.amountHuman, built.balanceHuman, built.surplusBeforeOunces, built.surplusAfterOunces],
    ["tXAUT", 6, "1500000", "1.5", "2.5", "0.1", "1.6"], // 6-decimal coin: 1.5 tXAUT is 1.5 oz of surplus
  )
  assert.deepEqual([built.transaction.to.toLowerCase(), built.reserve.toLowerCase(), built.transaction.data.slice(0, 10)], [XAUT, A(2), "0xa9059cbb"])
  // By address too; an unread Reserve does not stop the transfer.
  const byAddress = await admin(withDistributor, 2_500_000n, null).addSurplusTransaction({ asset: XAUT.toUpperCase().replace("0X", "0x"), amount: "1", from: wallet })
  assert.deepEqual(byAddress.ok && [byAddress.symbol, byAddress.surplusBeforeOunces, byAddress.surplusAfterOunces], ["tXAUT", null, null])

  const refusal = async (promise: ReturnType<ArcoGoldAdmin["addSurplusTransaction"]>) => {
    const result = await promise
    return result.ok ? null : [result.status, result.error]
  }
  assert.deepEqual(await refusal(admin(() => null).addSurplusTransaction({ asset: "tXAUT", amount: "1", from: wallet })), [409, "ArcoGOLD is not deployed"])
  // Without a distributor nothing could pay it out: the coins would only sit in the Reserve.
  assert.match((await refusal(admin(registry).addSurplusTransaction({ asset: "tXAUT", amount: "1", from: wallet })))![1] as string, /no distributor/)
  assert.equal((await refusal(admin(() => registry({ chainId: 1 })).addSurplusTransaction({ asset: "tXAUT", amount: "1", from: wallet })))![0], 503)
  assert.equal((await refusal(admin(withDistributor).addSurplusTransaction({ asset: "tXAUT", amount: "1", from: null })))![0], 400)
  assert.equal((await refusal(admin(withDistributor).addSurplusTransaction({ asset: "tUSDC", amount: "1", from: wallet })))![0], 400)
  for (const amount of ["0", "-1", "1.1234567", "10001", undefined]) {
    assert.equal((await refusal(admin(withDistributor).addSurplusTransaction({ asset: "tXAUT", amount, from: wallet })))![0], 400, String(amount))
  }
  assert.deepEqual(await refusal(admin(withDistributor).addSurplusTransaction({ asset: "tXAUT", amount: "3", from: wallet })), [
    409,
    "The wallet holds 2.5 tXAUT, less than the 3 tXAUT of this transfer",
  ])
})
