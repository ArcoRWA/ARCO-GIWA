import assert from "node:assert/strict"
import test from "node:test"
import type { GiwaDeploymentRegistry } from "../registry/types.js"
import { DEPOSITOR_CACHE_TTL_MS, EvmMonitoringService } from "./evm-monitoring-service.js"
import {
  createConcurrencyLimiter,
  createTokenBalanceReader,
  MONITORING_BALANCE_READ_CONCURRENCY,
} from "./token-balance-reader.js"

type Deps = ConstructorParameters<typeof EvmMonitoringService>[0]

const CHAIN = 91342
const PRODUCTS = 11
const RECIPIENTS = 200

const hex = (prefix: number, index: number) =>
  `0x${prefix.toString(16).padStart(2, "0")}${index.toString(16).padStart(38, "0")}`

function fakeRegistry(): GiwaDeploymentRegistry {
  return {
    products: Array.from({ length: PRODUCTS }, (_, index) => ({
      productId: `p${index}`,
      symbol: `P${index}`,
      paymentAssetSymbol: "tUSDC",
      productToken: { proxy: hex(0xa0, index) },
      depositVault: { proxy: hex(0xb0, index) },
      redemptionVault: { proxy: hex(0xc0, index) },
    })),
  } as unknown as GiwaDeploymentRegistry
}

// In-memory fakes: 11 products × 200 distinct deposit recipients, a balance reader that
// counts reads and the peak number in flight, and a settable clock.
function harness(options: { failOnce?: { productIndex: number } } = {}) {
  const registry = fakeRegistry()
  const counts = { reads: 0, inFlight: 0, maxInFlight: 0, eventQueries: new Map<string, number>() }
  const failOnce = new Set<string>(
    options.failOnce ? [String(registry.products[options.failOnce.productIndex].productToken.proxy)] : [],
  )
  let clock = 1_000_000

  const arco = {
    pendingRedemptions: async () => [],
    redemptionRequestsForChain: async () => [],
    indexedEventsForContracts: async (_chainId: number, contracts: string[]) => {
      const depositVault = contracts[0]
      counts.eventQueries.set(depositVault, (counts.eventQueries.get(depositVault) ?? 0) + 1)
      const index = registry.products.findIndex((product) => product.depositVault.proxy === depositVault)
      return Array.from({ length: RECIPIENTS }, (_, n) => ({
        eventName: "ProductDeposit",
        blockNumber: BigInt(n + 1),
        logIndex: 0,
        args: { recipient: hex(0xd0 + index, n), paymentAssets: "1000000", sharesOut: "1000000000000000000" },
      }))
    },
  } as unknown as Deps["arco"]
  const market = {
    market: async () => [],
    history: async (_chainId: number, productId: string) => ({ productId, apy: null, points: [] }),
  } as unknown as Deps["market"]

  const readTokenBalances = createTokenBalanceReader({
    limit: createConcurrencyLimiter(MONITORING_BALANCE_READ_CONCURRENCY),
    readBalance: async (token, _address) => {
      counts.reads += 1
      counts.inFlight += 1
      counts.maxInFlight = Math.max(counts.maxInFlight, counts.inFlight)
      try {
        await new Promise((resolve) => setTimeout(resolve, 1))
        if (failOnce.has(token)) {
          failOnce.delete(token)
          throw new Error("rpc timeout")
        }
        return 5_000_000_000_000_000_000n
      } finally {
        counts.inFlight -= 1
      }
    },
  })

  const service = new EvmMonitoringService({
    arco,
    market,
    loadRegistry: () => registry,
    readShareSupply: async () => ({ supply: "0", decimals: 18 }),
    readTokenBalances,
    now: () => clock,
  })
  const totalEventQueries = () => [...counts.eventQueries.values()].reduce((sum, value) => sum + value, 0)
  return {
    service,
    registry,
    counts,
    totalEventQueries,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

test("balance reads stay within the shared limit when 11 products × 200 recipients load at once", async () => {
  const { service, counts } = harness()
  const { vaults } = await service.vaults(CHAIN)
  assert.equal(vaults.length, PRODUCTS)
  for (const vault of vaults) assert.equal(vault.depositorCount, RECIPIENTS)
  assert.equal(counts.reads, PRODUCTS * RECIPIENTS)
  assert.ok(counts.maxInFlight <= MONITORING_BALANCE_READ_CONCURRENCY, `peak in flight ${counts.maxInFlight}`)
  // The limit is shared across products, not per product (11 × 25 would be 275).
  assert.equal(counts.maxInFlight, MONITORING_BALANCE_READ_CONCURRENCY)
  assert.equal(counts.inFlight, 0)
})

test("two overlapping vaults() calls perform one set of reads", async () => {
  const { service, counts, totalEventQueries } = harness()
  const [first, second] = await Promise.all([service.vaults(CHAIN), service.vaults(CHAIN)])
  assert.equal(counts.reads, PRODUCTS * RECIPIENTS)
  assert.equal(totalEventQueries(), PRODUCTS)
  assert.deepEqual(first, second)
})

test("a second call within the TTL performs no balance reads; after the TTL it reads again", async () => {
  const { service, counts, advance } = harness()
  await service.vaults(CHAIN)
  assert.equal(counts.reads, PRODUCTS * RECIPIENTS)

  advance(DEPOSITOR_CACHE_TTL_MS - 1)
  const cached = await service.vaults(CHAIN)
  assert.equal(counts.reads, PRODUCTS * RECIPIENTS, "no balance reads inside the TTL")
  for (const vault of cached.vaults) assert.equal(vault.depositorCount, RECIPIENTS)

  advance(1)
  await service.vaults(CHAIN)
  assert.equal(counts.reads, 2 * PRODUCTS * RECIPIENTS, "reads again once the TTL has passed")
})

test("a failed balance read gives depositorCount null and is not served from cache afterwards", async () => {
  const { service, counts } = harness({ failOnce: { productIndex: 3 } })
  const first = await service.vaults(CHAIN)
  assert.equal(first.vaults[3].depositorCount, null)
  for (const vault of first.vaults.filter((_, index) => index !== 3)) assert.equal(vault.depositorCount, RECIPIENTS)
  // After the failure the product's not-yet-started reads were skipped.
  assert.ok(counts.reads < PRODUCTS * RECIPIENTS)
  const readsAfterFirst = counts.reads

  // Same clock: the healthy products come from cache, the failed one is read again.
  const second = await service.vaults(CHAIN)
  assert.equal(second.vaults[3].depositorCount, RECIPIENTS)
  assert.equal(counts.reads - readsAfterFirst, RECIPIENTS)
})

test("flow events are queried once per product per vaults() call", async () => {
  const { service, registry, counts, totalEventQueries, advance } = harness()
  await service.vaults(CHAIN)
  assert.equal(totalEventQueries(), PRODUCTS)
  for (const product of registry.products) assert.equal(counts.eventQueries.get(String(product.depositVault.proxy)), 1)
  advance(DEPOSITOR_CACHE_TTL_MS)
  await service.vaults(CHAIN)
  assert.equal(totalEventQueries(), 2 * PRODUCTS)
})

test("detail() reads events once, goes through the limiter and shares the depositor cache", async () => {
  const { service, counts, totalEventQueries } = harness()
  const detail = await service.detail(CHAIN, "p0")
  assert.equal(detail.depositors.length, RECIPIENTS)
  assert.equal(detail.depositors[0].balanceHuman, 5)
  assert.equal(totalEventQueries(), 1)
  assert.equal(counts.reads, RECIPIENTS)
  assert.ok(counts.maxInFlight <= MONITORING_BALANCE_READ_CONCURRENCY)

  // vaults() right after reuses p0's depositors and reads only the other 10 products.
  await service.vaults(CHAIN)
  assert.equal(counts.reads, PRODUCTS * RECIPIENTS)
})

test("token balance reader keeps input order and returns null on any failure", async () => {
  const limit = createConcurrencyLimiter(2)
  const ok = createTokenBalanceReader({ limit, readBalance: async (_token, address) => BigInt(address.length) })
  assert.deepEqual(Object.keys((await ok("0xt", ["0xccc", "0xa", "0xbb"]))!), ["0xccc", "0xa", "0xbb"])
  assert.deepEqual(await ok("0xt", []), {})

  let started = 0
  const failing = createTokenBalanceReader({
    limit,
    readBalance: async (_token, address) => {
      started += 1
      if (address === "0x1") throw new Error("boom")
      return 1n
    },
  })
  assert.equal(await failing("0xt", Array.from({ length: 50 }, (_, i) => `0x${i}`)), null)
  assert.ok(started < 50, `reads after the failure are skipped (started ${started})`)
  assert.throws(() => createConcurrencyLimiter(0))
})
