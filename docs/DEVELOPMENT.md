# Development guide

Standalone GIWA product: the Vite/React app, the Fastify API with its indexer, and the
Hardhat contracts package. Contracts on GIWA Sepolia (chain 91342) are live; do not
redeploy them. Deployed addresses live in `deployments/91342/*.json`.

## Layout

| Path | What |
|---|---|
| `src/demo/giwa/` | The app: investor list, savings, portfolio, product detail |
| `server/` | Fastify API, indexer and keeper (Prisma on Postgres, `arco_evm` schema) |
| `packages/contracts/` | Solidity sources, tests and scripts (yarn 4 via corepack) |
| `deployments/91342/` | Live registry for GIWA Sepolia |

## Setup

```sh
npm ci
cp .env.example .env          # fill in your own local values
cd packages/contracts && corepack yarn install && corepack yarn compile
```

## Run

```sh
npm run dev            # Vite on http://localhost:5173 (must match CORS_ALLOWED_ORIGINS)
npm run start:server   # API on :8080
npm run indexer:giwa   # indexer worker (needs INDEXER_RPC_URL, DATABASE_URL and compiled artifacts)
```

The indexer loads the registry at startup only.

## Verify

```sh
npm run typecheck && npm run build
npm run test:frontend && npm run test:server && npm run test:security
cd packages/contracts && corepack yarn test
```

`test:server` reads compiled ABIs from `packages/contracts/artifacts/` and needs the Prisma
client, so run `npm run evm:build` and `npm run prisma:generate` first (no database needed).
