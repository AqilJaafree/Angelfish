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
// Addresses are lowercase. WBNB and native BNB are absent deliberately, and so are
// USDT/USDC/USD1 as ANCHORS — but the stablecoins are still listed below, because
// on BSC a stable is routinely the tracked side of a pair (a USDT/USDC pool has an
// anchor on both sides and is dropped upstream, but USDT paired against a non-anchor
// stable such as FDUSD is not). The anchor set and this list overlap on purpose.

const STABLECOINS = [
  '0x55d398326f99059ff775485246999027b3197955', // USDT (BSC-USD, 18 decimals)
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
  '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', // USD1
  '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
  '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409', // FDUSD
  '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', // DAI
  '0x14016e85a25aeb13065688cafb43044c2ef86784', // TUSD
  '0x5c7f8a570d578ed84e63fdfa7b1ee72deae1ae23', // wUSDR
  '0xd17479997f34dd9156deef8f95a52d81d265be9c', // USDD
  '0x3f56e0c36d275367b8c502090edf38289b3dea0d', // MAI
];

// Wrapped and bridged majors. These track an asset that is not this chain's, so
// their "movement" is that asset's movement plus bridge drift.
const WRAPPED_MAJORS = [
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', // BTCB
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8', // ETH (Binance-peg)
  '0x4db5a66e937a9f4473fa95b1caf1d1e1d62e29ea', // WETH
  '0xfb6115445bff7b52feb98650c87f44907e58f802', // AAVE
  '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe', // XRP (peg)
  '0x3ee2200efb3400fabb9aacf31297cbdd1d435d47', // ADA (peg)
  '0x570a5d26f7765ecb712c0924e4de545b89fd43df', // SOL (peg)
  '0xba2ae424d960c26247dd6c32edc70b295c744c43', // DOGE (peg)
  '0x7083609fce4d1d8dc0c979aab8c869ea2c873402', // DOT (peg)
  '0xcf6bb5389c92bdda8a3747ddb454cb7a64626c63', // XVS
];

// PancakeSwap's own tokens and the established BNB-chain DeFi set. Without this
// the boards are CAKE and the same handful of blue chips every cycle.
const DEFI_MAJORS = [
  '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', // CAKE
  '0x52ce071bd9b1c4b00a0b92d298c512478cad67e8', // COMP (peg)
  '0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd', // LINK (peg)
  '0xbf5140a22578168fd562dccf235e5d43a02ce9b1', // UNI (peg)
  '0x947950bcc74888a40ffa2593c5798f11fc9124c4', // SUSHI (peg)
  '0x111111111117dc0aa78b770fa6a738034120c302', // 1INCH (peg)
  '0x88f1a5ae2a3bf98aeaf342d26b30a79438c9142e', // YFI (peg)
  '0x156ab3346823b651294766e23e6cf87254d68962', // LUNA-ish / legacy
  '0xa2120b9e674d3fc3875f415a7df52e382f141225', // ATA
  '0xfd7b3a77848f1c2d67e05e54d78d174a0c850335', // ONT (peg)
];

// The Ethereum build carried two further groups that have no BSC counterpart and
// are deliberately not recreated: ETH_DERIVATIVES (stETH, rETH and the rest of the
// liquid-staking set, which barely exists here) and OTHER_MAJORS (exchange tokens —
// on this chain the exchange token IS the anchor). Use MOVERS_DENYLIST to add any
// that turn up rather than reintroducing an empty category.

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
    ...DEFI_MAJORS,
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
// lookups — those tokens were eating a third of the budget for rows that were
// then discarded.
export function filterDenied<T extends { token: string }>(rows: T[]): {
  kept: T[];
  dropped: number;
} {
  if (!DENYLIST_ENABLED) return { kept: rows, dropped: 0 };
  const kept = rows.filter((r) => !isDenied(r.token));
  return { kept, dropped: rows.length - kept.length };
}
