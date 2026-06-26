# Complete Multi-Chain ABI Library — 2026

All addresses and ABIs verified from official documentation as of March 2026.

## Structure

```
abi/
├── CHAIN_CONFIGS.json              ← All chain IDs, RPCs, native tokens
├── evm/
│   ├── tokens/
│   │   ├── ERC20_standard.json    ← Universal ERC-20 ABI + major token addresses
│   │   └── Multichain_Token_Addresses.json ← WETH/USDC/USDT/WBTC/DAI/LINK/UNI/AAVE/PEAQ/STRK across all chains
│   ├── weth/
│   │   └── WETH9.json             ← WETH9 ABI + addresses on all chains
│   ├── uniswap_v2/
│   │   ├── UniswapV2_Factory.json
│   │   ├── UniswapV2_Router02.json
│   │   └── UniswapV2_Pair.json
│   ├── uniswap_v3/
│   │   ├── UniswapV3_Factory.json
│   │   ├── UniswapV3_SwapRouter.json        ← v1 router
│   │   ├── UniswapV3_SwapRouter02.json      ← v2 router (current recommended)
│   │   ├── UniswapV3_Pool.json
│   │   ├── UniswapV3_NonfungiblePositionManager.json
│   │   └── UniswapV3_QuoterV2.json
│   ├── uniswap_v4/
│   │   ├── UniswapV4_PoolManager.json       ← Deployed Jan 2025. Singleton holds ALL V4 pools.
│   │   ├── UniswapV4_UniversalRouter.json   ← Routes V2+V3+V4
│   │   ├── UniswapV4_PositionManager.json
│   │   └── UniswapV4_StateView.json
│   ├── pancakeswap/
│   │   ├── PancakeSwap_V2_Factory.json
│   │   ├── PancakeSwap_V3_Factory.json
│   │   ├── PancakeSwap_V3_SmartRouter.json
│   │   └── PancakeSwap_V3_NonfungiblePositionManager.json
│   ├── sushiswap/
│   │   ├── SushiSwap_V2_Router.json
│   │   ├── SushiSwap_V3_Router.json
│   │   └── SushiSwap_MasterChefV2.json
│   ├── curve/
│   │   ├── Curve_StableSwap_Pool.json
│   │   └── Curve_Router.json
│   ├── aave/
│   │   └── Aave_V3_Pool.json
│   ├── 1inch/
│   │   └── 1inch_AggregationRouterV6.json
│   ├── balancer/
│   │   └── Balancer_V2_Vault.json
│   ├── permit2/
│   │   └── Permit2.json                     ← Same address on ALL EVM chains: 0x000000000022D473030F116dDEE9F6B43aC78BA3
│   └── chainlink/
│       └── Chainlink_PriceFeed.json
├── starknet/
│   ├── tokens/
│   │   └── StarkNet_ERC20.json              ← Cairo felt types. ETH, USDC, USDT, WBTC, STRK, DAI, wstETH
│   ├── jediswap/
│   │   ├── JediSwap_V1_Router.json
│   │   └── JediSwap_V1_Pair.json
│   ├── avnu/
│   │   └── AVNU_Exchange.json               ← Leading aggregator on StarkNet. Powers AVNU, Nostra swap, etc.
│   └── ekubo/
│       └── Ekubo_Core.json                  ← #1 AMM on StarkNet by TVL. Singleton architecture.
├── solana/
│   ├── Solana_SPL_Token.json                ← NEP-141 equivalent. USDC, USDT, WSOL, BONK, JUP, RAY mints.
│   ├── Jupiter_V6_Aggregator.json           ← Largest Solana DEX aggregator
│   └── Raydium_V4_AMM.json                  ← Major Solana AMM
├── near/
│   ├── NEAR_FungibleToken.json              ← NEP-141 standard. USDC, USDT, WNEAR. REF Finance addresses.
│   └── REF_Finance_Exchange.json            ← Largest NEAR DEX
└── polkadot_peaq/
    ├── Peaq_ERC20_Native_Precompile.json    ← PEAQ token as ERC-20. chain_id 3338.
    └── Peaq_DID_Precompile.json             ← Machine Identity (DID) — core DePIN primitive

```

## Key Notes

### EVM Chains
- **Uniswap V4**: Deployed January 2025. ALL pools in ONE PoolManager contract (singleton). Use UniversalRouter for swaps.
- **Permit2**: `0x000000000022D473030F116dDEE9F6B43aC78BA3` — exact same address on every EVM chain.
- **V3 vs V4**: V3 pools still have majority of liquidity for blue-chip pairs. V4 growing fast ($1B TVL in 177 days).
- **PancakeSwap**: Factory and NonfungiblePositionManager use same address on ETH/BSC/Base/Arbitrum/Linea.
- **1inch**: RouterV6 uses same address on almost all EVM chains.

### StarkNet
- Uses **Cairo** language with `felt`/`felt252` types — NOT Solidity ABI types.
- **Ekubo** is the dominant DEX (60%+ AMM TVL), uses singleton architecture + till pattern.
- **AVNU** is the dominant aggregator routing through Ekubo, JediSwap, etc.
- Token addresses are long hex felt values, not 20-byte addresses.

### Solana
- Uses **Program IDs** not contract addresses. State stored in separate accounts.
- **Jupiter V6** is the go-to aggregator — use REST API for quotes, on-chain for execution.
- SPL Token program: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`

### NEAR
- Uses **account IDs** (e.g. `v2.ref-finance.near`) not hex addresses.
- Native token methods: `ft_transfer`, `ft_transfer_call`, `ft_balance_of`
- **REF Finance** is the primary DEX on NEAR.

### Peaq (DePIN Chain)
- EVM-compatible Polkadot parachain, **chain_id 3338**.
- Native PEAQ token accessible as ERC-20 via precompile at `0x...0802`.
- **MachineX** is the native DEX for DePIN tokens.
- Core primitives: Machine DIDs, mNFTs, pay-per-use access.

## NEW IN THIS VERSION — March 2026

### Flash Loans
- `evm/flash_loans/Aave_V3_FlashLoan_Receiver.json` — IFlashLoanSimpleReceiver + IFlashLoanReceiver interfaces. Includes Solidity template. Fee: 0.05%. All pool addresses.
- `evm/flash_loans/Uniswap_V3_FlashSwap.json` — V3 pool flash() + uniswapV3FlashCallback(). Fee = pool tier.
- `evm/flash_loans/Balancer_V2_FlashLoan.json` — FREE 0% fee flash loans via Vault.flashLoan(). Implement receiveFlashLoan().

### Liquid Staking
- `evm/staking/Lido_stETH.json` — Rebasing stETH. submit() to stake. sharesOf(), getPooledEthByShares(). Ethereum only.
- `evm/staking/Lido_wstETH.json` — Non-rebasing wstETH. USE THIS for DeFi. wrap()/unwrap(). 12+ chains.
- `evm/staking/RocketPool_rETH.json` — Decentralized LST. burn() to redeem. getExchangeRate(). ETH+L2.
- `evm/staking/RocketPool_DepositPool.json` — Send ETH to deposit(), receive rETH. Min 0.01 ETH.

### Restaking (EigenLayer)
- `evm/restaking/EigenLayer_StrategyManager.json` — depositIntoStrategy() for LSTs. All strategy addresses (stETH, rETH, cbETH, EIGEN...).
- `evm/restaking/EigenLayer_DelegationManager.json` — delegateTo() operators, queueWithdrawals(), completeQueuedWithdrawal(). 7-day escrow.

### Bridges (Cross-Chain)
- `evm/bridges/Stargate_V2_Pool.json` — IOFT interface. quoteSend()+send(). Acquired by LayerZero Aug 2025. 80+ chains.
- `evm/bridges/LayerZero_Endpoint_V2.json` — Same address on ALL chains: 0x1a44...Fe728c. 85% market share cross-chain messaging.
- `evm/bridges/Circle_CCTP_V2.json` — Native USDC burn+mint. Zero slippage. 10 chains. depositForBurn().

### Perps / Derivatives
- `evm/perps/GMX_V2_ExchangeRouter.json` — createOrder() for market/limit increase/decrease. Arbitrum + Avalanche. Up to 100x leverage. 70+ tokens.

### NFT Standards
- `evm/nft/ERC721_Standard.json` — Full ERC-721 ABI. Notable contracts: BAYC, CryptoPunks, Azuki, Uniswap V3 positions.
- `evm/nft/ERC1155_Standard.json` — Full ERC-1155 multi-token ABI.

## Flash Loan Comparison

| Protocol | Fee | Multi-asset | Chains |
|---|---|---|---|
| Balancer V2 | 0% | YES | ETH, ARB, OP, POLY, AVAX, BASE, GNOSIS |
| Aave V3 | 0.05% | YES (flashLoan) / NO (flashLoanSimple) | ETH, ARB, OP, POLY, AVAX, BASE, BNB |
| Uniswap V3 | Pool fee tier 0.01%-1% | NO (per pool) | All V3 chains |

## EigenLayer Flow

```
1. approve(StrategyManager, amount)         — on token (stETH, rETH, etc.)
2. depositIntoStrategy(strategy, token, amt) — on StrategyManager
3. delegateTo(operator, sig, salt)          — on DelegationManager
4. queueWithdrawals(params)                 — on DelegationManager (starts 7-day timer)
5. completeQueuedWithdrawal(withdrawal, ...) — after 7 days
```

## Stargate V2 Bridge Flow

```
1. approve(stargatePool, amount)   — on token contract
2. quoteSend(sendParam, false)     — get fee estimate
3. send(sendParam, fee, refundAddr) — with {value: fee.nativeFee}
   • dstEid = LayerZero chain ID (ETH=30101, ARB=30110, etc.)
   • to = bytes32(uint256(uint160(recipient)))
```
