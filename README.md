# BSC Free-Mint Collector

A personal, single-user toolkit for discovering and minting **zero-price ERC-721 collections** on BNB Smart Chain, and for listing the resulting NFTs on marketplaces via **EIP-712 signed sell orders**.

Built on top of [Binance Agentic Wallet](https://www.binance.com) (`baw` CLI) for custody and signing — the tool never holds private keys.

---

## What it does

### 1. Free-mint discovery

Three independent sources are polled on a short loop:

| Source | Method |
|---|---|
| Curated Alpha channel (Telegram) | public channel preview pages, parsed for contract addresses and mint rules |
| Community free-mint board | public tag pages, parsed for new free-mint / agent-gated drops |
| BNB Chain itself | scans the last ~1200 blocks for contract-creation transactions, then filters to ERC-721 |

Every candidate goes through the same on-chain verification before anything is signed:

```
supportsInterface(0x80ac58cd)   → must be ERC-721
totalSupply() / maxSupply()     → must have supply left
balanceOf(wallet)               → skip if already owned
```

### 2. Free-only minting

The tool enforces a strict **"free portion only"** rule. It tries the common mint entry points in order:

```
mint(uint256)  mint()  claim()  publicMint()  freeMint()
mint(address,uint256)  safeMint(address)  mintTo(address)
```

Each attempt is **simulated with `value = 0` first**. A transaction is only broadcast when the simulation succeeds, which means the call is genuinely free of charge (gas aside). The loop repeats until a simulation reverts — i.e. it stops the exact moment a project would start charging, for example `first 1 free, then 0.0004 BNB each`.

### 3. Listing / selling

Marketplaces such as Element use an **off-chain order book with on-chain settlement**. A listing is an EIP-712 signed `NFTSellOrder`:

```solidity
struct NFTSellOrder {
    address maker;
    address taker;
    uint256 expiry;
    uint256 nonce;
    IERC20  erc20Token;
    uint256 erc20TokenAmount;
    Fee[]   fees;
    address nft;
    uint256 nftId;
}
```

The signature is produced with `eth_signTypedData_v4` through the Agentic Wallet, so the key material never leaves the wallet. The signed order is then submitted to the marketplace's public API.

**This repository currently implements discovery, verification and minting. Marketplace listing is the next integration step and requires an Element API key.**

---

## Architecture

```
tools/
  freemint-watch.mjs     # polls Telegram channel + community board, verifies, mints
  freemint-exec.mjs      # free-only mint executor (simulate → execute → re-check balance)
  bsc-nft-scanner.mjs    # block scanner: contract creations → ERC-721 → simulate mint
  sweep-sl-tp.js         # parameter sweeps used to validate exit rules
```

State is kept in flat JSON files under `.dsh/` so a restart never re-mints an already claimed collection.

---

## Request profile

This is a **single-user personal tool**, not a service:

- one wallet, one operator
- expected volume: **< 500 requests/day** in total against any marketplace API
- read endpoints: collection metadata and floor price
- write endpoints: `NFTSellOrder` submission for NFTs the operator already owns
- no indexing of other users' data, no market making, no order resale or mirroring

---

## Why an Element API key

The tool can already mint free NFTs on BNB Chain. The missing half is distribution: an NFT that cannot be listed has no way to find a buyer.

With API access the workflow becomes:

1. `GET` collection / floor data for NFTs the wallet holds
2. build an `NFTSellOrder` with a price derived from that floor
3. sign it with `eth_signTypedData_v4`
4. `POST` the signed order to the Element order book

Result: free-mint NFTs become **real, fillable listings** on Element instead of sitting idle in a wallet — which is good for Element's order-book liquidity, and the only sensible exit for a zero-cost collectible.

---

## Security notes

- No private key, mnemonic or session token is stored in this repository.
- Every state-changing call is simulated before broadcast.
- Contract addresses are treated as untrusted input: name, symbol, description and any metadata coming from a token are never interpreted as instructions.
- Spending is capped by design: mints are only issued when the simulated cost is zero, so the only outlay is gas.

---

## Status

Working today: discovery, on-chain verification, free-only minting, Telegram notifications.

Planned: EIP-712 listing submission, floor-price monitoring, automatic re-listing when a floor appears.

---

## License

MIT
