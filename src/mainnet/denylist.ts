// Tokens excluded from the boards: stablecoins, wrapped/staked majors, and
// established DeFi governance tokens. Without this the boards are the same dozen
// blue chips every cycle — USDC, USDT and WBTC alone routinely take three of the
// five v3 slots — which buries exactly the movement the boards exist to surface.
//
// ---------------------------------------------------------------------------
// MATCHED BY ADDRESS, NEVER BY SYMBOL. This is a correctness requirement, not a
// style preference.
//
// A symbol is not unique and is not authenticated: any contract can name itself
// `USDC`. Matching on the string would therefore hide every impostor that picks
// a blue-chip ticker — and a fake `USDC` trading against WETH is precisely the
// thing a Danger Zone board is for. Symbol matching would turn this filter into
// a cloaking device for the scams it should be surfacing.
//
// So the list holds addresses. A token whose symbol reads `USDC` but whose
// address is not the real one stays on the boards, and lands in Danger Zone on
// its market cap like anything else.
// ---------------------------------------------------------------------------
//
// Addresses are lowercase; every one was verified against its symbol()/name()
// on mainnet before being added. WETH is absent deliberately: it is the anchor,
// so it is never the tracked side of a pair.

const STABLECOINS = [
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3', // USDe
  '0xdc035d45d973e3ec169d2276ddab16f1e407384f', // USDS
  '0x6c3ea9036406852006290770bedfcaba0e23a0e8', // PYUSD
  '0x853d955acef822db058eb8505911ed77f175b99e', // FRAX
  '0x0000000000085d4780b73119b644ae5ecd22b376', // TUSD
  '0x8e870d67f660d95d5be530380d0ec0bd388289e1', // USDP
  '0x056fd409e1d7a124bd7017459dfea2f387b6d5cd', // GUSD
  '0x5f98805a4e8be255a32880fdec7f6728c6568ba0', // LUSD
  '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e', // crvUSD
  '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409', // FDUSD
  '0x8292bb45bf1ee4d140127049757c2e0ff06317ed', // RLUSD
  '0x9d39a5de30e57443bff2a8307a4256c8797a3497', // sUSDe
  '0x83f20f44975d03b1b09e64809b757c47f942beea', // sDAI
];

const WRAPPED_MAJORS = [
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // WBTC
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', // cbBTC
  '0x18084fba666a33d37592fa2633fd49a74dd93a88', // tBTC
  '0x8236a87084f8b84306f72007f36f2618a5634494', // LBTC
];

// Liquid-staking and restaking derivatives of ETH. They track the anchor, so
// their "movement" is the anchor's movement plus a basis point of drift.
const ETH_DERIVATIVES = [
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', // stETH
  '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', // wstETH
  '0xae78736cd615f374d3085123a210448e74fc6393', // rETH
  '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee', // weETH
  '0xbf5495efe5db9ce00f80364c8b423567e58d2110', // ezETH
  '0xbe9895146f7af43049ca1c1ae358b0541ea49704', // cbETH
  '0x5e8422345238f34275888049021821e8e08caa1f', // frxETH
  '0xf951e335afb289353dc249e82926178eac7ded78', // swETH
  '0xa1290d69c65a6fe4df752f95823fae25cb99e5a7', // rsETH
  '0xd9a442856c234a39a81a089c06451ebaa4306a72', // pufETH
];

const DEFI_MAJORS = [
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', // UNI
  '0x514910771af9ca656af840dff83e8264ecf986ca', // LINK
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', // AAVE
  '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', // MKR
  '0x56072c95faa701256059aa122697b133aded9279', // SKY
  '0xd533a949740bb3306d119cc777fa900ba034cd52', // CRV
  '0x5a98fcbea516cf06857215779fd812ca3bef1b32', // LDO
  '0xc00e94cb662c3520282e6f5717214004a7f26888', // COMP
  '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f', // SNX
  '0x6b3595068778dd592e39a122f4f5a5cf09c90fe2', // SUSHI
  '0x111111111117dc0aa78b770fa6a738034120c302', // 1INCH
  '0x57e114b691db790c35207b2e685d4a43181e6061', // ENA
  '0x808507121b80c02388fad14726482e061b8da827', // PENDLE
  '0xec53bf9167f50cdeb3ae105f56099aaab9061f83', // EIGEN
  '0xfe0c30065b384f05761f15d0cc899d4f9f9cc0eb', // ETHFI
  '0x58d97b57bb95320f9a05dc918aef65434969c2b2', // MORPHO
  '0xc944e90c64b2c07662a292be6244bdf05cda44a7', // GRT
  '0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0', // FXS
  '0xba100000625a3754423978a60c9317c58a424e3d', // BAL
  '0x92d6c1e31e14520e676a687f0a93788b716beff5', // DYDX
  '0x4691937a7508860f876c9c0a2a617e7d9e945d4b', // WOO
  '0x0bc529c00c6401aef6d220be8c6ea1667f6ad93e', // YFI
  '0xdefa4e8a7bcba345f687a2f1456f5edd9ce97202', // KNC
  '0x6810e776880c02933d47db1b9fc05908e5386b96', // GNO
  '0xd33526068d116ce69f19a9ee46f0bd304f21a51f', // RPL
];

// Large-cap tokens that are none of the above — not a stablecoin, not a wrapped
// or staked asset, not a DeFi protocol — but established enough that their
// appearance on a "movers" board is noise rather than news. Exchange tokens and
// enterprise-chain tokens land here.
const OTHER_MAJORS = [
  '0xf34960d9d60be18cc1d5afc1a6f012a723a28811', // KCS  (KuCoin Token, 6 decimals)
  '0x4a220e6096b25eadb88358cb44068a3248254675', // QNT  (Quant)
];

// Set MOVERS_DENYLIST_ENABLED=0 to show everything.
export const DENYLIST_ENABLED = process.env.MOVERS_DENYLIST_ENABLED !== '0';

// Comma-separated extra addresses to exclude, on top of the built-in list.
const EXTRA = (process.env.MOVERS_DENYLIST ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((s) => /^0x[0-9a-f]{40}$/.test(s));

// Comma-separated addresses to force back ON to the boards, overriding the
// built-in list. Lets a caller keep the curated set while making an exception,
// instead of having to disable the whole thing.
const ALLOW = new Set(
  (process.env.MOVERS_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s))
);

export const DENYLIST: ReadonlySet<string> = new Set(
  [
    ...STABLECOINS,
    ...WRAPPED_MAJORS,
    ...ETH_DERIVATIVES,
    ...DEFI_MAJORS,
    ...OTHER_MAJORS,
    ...EXTRA,
  ].filter((a) => !ALLOW.has(a))
);

// `token` is expected lowercase, as every address in this codebase is — but
// lowercase it anyway rather than trusting the caller: a checksummed address
// slipping through would silently match nothing and quietly disable the filter
// for that token.
export function isDenied(token: string): boolean {
  if (!DENYLIST_ENABLED) return false;
  return DENYLIST.has(token.toLowerCase());
}

// Drop denied rows from a volume-ranked list. Applied BEFORE the market-cap
// walk, so an excluded blue chip does not also consume one of the cycle's
// lookups — on mainnet those tokens were eating a third of the budget for rows
// that were then discarded.
export function filterDenied<T extends { token: string }>(rows: T[]): {
  kept: T[];
  dropped: number;
} {
  if (!DENYLIST_ENABLED) return { kept: rows, dropped: 0 };
  const kept = rows.filter((r) => !isDenied(r.token));
  return { kept, dropped: rows.length - kept.length };
}
