# cpeg-contracts

Smart contracts for the CPEG protocol on Base.

> **Status: Testnet (Base Sepolia)**
> Mainnet deployment pending audit completion.

---

## What is CPEG

CPEG (Commit Photographic Experts Group) is a dynamic soulbound ERC-1155 NFT protocol on Base. Every wallet that holds CPEG tokens automatically receives a pixel art NFT. The NFT tier evolves based on how many tokens the wallet holds. No manual minting required.

- Buy tokens. NFT mints automatically.
- Accumulate more. NFT upgrades automatically.
- Sell. NFT burns or downgrades automatically.
- Earn. Higher tiers earn a larger share of protocol trading fees.

---

## Contracts

| Contract | Address (Base Sepolia) | Description |
|---|---|---|
| MockCPEG | `0x975eef6b0518d17fF300cd17D845bb3034C535CB` | ERC-20 test token for testnet |
| CPEG NFT | `0x2E0033cBEf75c07c145080CC759cB04BAf0876E2` | Main ERC-1155 soulbound NFT contract |

Chainlink Forwarder (keeper): `0xf4132ae120793308157c0fd3F32b23B2E43819dd`

---

## NFT Tiers

| Tier | Balance Required | Reward Multiplier |
|---|---|---|
| Common | 10M to 50M CPEG | 1.0x |
| Uncommon | 50M to 100M CPEG | 1.5x |
| Rare | 100M to 500M CPEG | 2.0x |
| Epic | 500M to 1B CPEG | 2.5x |
| Legendary | 1B to 2B CPEG | 4.0x |
| Mythic | 2B+ CPEG | 6.0x |

---

## Architecture

The CPEG contract integrates with Chainlink Automation using two upkeep types:

**Log Trigger** (primary)
- Listens to Transfer events on the CPEG token contract
- Auto-detects every new buyer instantly
- Calls `performUpkeep` to register and sync tier

**Custom Logic** (safety net)
- Periodically scans the watchlist for stale tiers
- Batch-syncs up to 50 holders per run
- Catches any tier drift not caught by the log trigger

---

## Setup

```bash
cd contracts
pnpm install --ignore-workspace
cp .env.example .env
# fill in .env values
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```
PRIVATE_KEY=                    # deployer wallet private key
BASESCAN_API_KEY=               # from basescan.org
BASE_SEPOLIA_RPC_URL=           # Alchemy or Infura Base Sepolia endpoint
BASE_RPC_URL=                   # Alchemy or Infura Base mainnet endpoint
CPEG_TOKEN_ADDRESS=             # ERC-20 token address
CPEG_ADDRESS=                   # CPEG NFT contract address (after deploy)
KEEPER_ADDRESS=                 # Chainlink forwarder address
NFT_BASE_URI=                   # e.g. https://cpeg.io/api/token/{id}.json
```

---

## Scripts

```bash
# Deploy to Base Sepolia (mock token + NFT contract)
pnpm deploy:mock

# Deploy to Base mainnet
pnpm deploy:mainnet

# Set keeper address
pnpm set-keeper

# Manual sync test
pnpm sync

# Check upkeep status
pnpm check-upkeep

# Run 5-wallet log trigger simulation
pnpm test5

# Run 10-cycle E2E test
pnpm e2e
```

---

## Tests

```bash
pnpm test
```

40 unit tests covering:
- Tier minting and burning
- Tier upgrades and downgrades
- Soulbound transfer restrictions
- Masterchef reward accounting
- Chainlink upkeep logic (checkLog, checkUpkeep, performUpkeep)

---

## Chainlink Automation Setup

Register two upkeeps at [automation.chain.link](https://automation.chain.link):

**Upkeep 1: Log Trigger**
- Target contract: CPEG NFT contract address
- Log emitter: CPEG token address
- Topic 0: `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`

**Upkeep 2: Custom Logic**
- Target contract: CPEG NFT contract address
- checkData: `abi.encode(0, 50)`

---

## Stack

- Solidity 0.8.28
- Hardhat
- OpenZeppelin Contracts
- Chainlink Automation (Log Trigger + Custom Logic)
- ERC-1155 soulbound NFT
- Masterchef-style reward distribution

---

## Links

- Website: https://cpeg.io
- NFT Registry: https://github.com/CPEGdev/cpeg-nft-registry
- GitHub: https://github.com/CPEGdev
