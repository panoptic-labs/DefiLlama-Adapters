const sdk = require('@defillama/sdk')
const { getLogs } = require('../helper/cache/getLogs')
const JSBI = require('jsbi');


const FACTORY = '0x000000000000010a1DEc6c46371A28A071F8bb01'
const SFPM = '0x0000000000000DEdEDdD16227aA3D836C5753194'
const startBlocks = {
  ethereum: 21389983,
}

const Q96 = BigInt(2) ** BigInt(96)

function chainTvl(chain) {
  return async (api) => {
    const START_BLOCK = startBlocks[chain]
    const poolDeployedLogs = (
      await getLogs({
        api,
        target: FACTORY,
        fromBlock: START_BLOCK,
        topic: 'PoolDeployed(address,address,address,address)',
      })
    )

    // can contain SFPM pools that don't have options markets yet
    const poolInitializedLogs = (
      await getLogs({
        api,
        target: SFPM,
        fromBlock: START_BLOCK,
        topic: 'PoolInitialized(address,uint64,int24,int24)',
      })
    )

    const block = api.block

    const poolData = {}

    for (let log of poolDeployedLogs) 
      poolData[`0x${log.topics[2].substr(-40)}`.toLowerCase()] = {marketAddress: `0x${log.topics[1].substr(-40)}`.toLowerCase()}
    

    for (let log of poolInitializedLogs) {
      const V3PoolAddress = `0x${log.topics[1].substr(-40)}`.toLowerCase()
      if (!poolData?.[V3PoolAddress]) poolData[V3PoolAddress] = {marketAddress: '0x3327b4D450fbB3a4b780510489C259D85776D559'.toLowerCase()} // random address
    }

    const token0Calls = Object.keys(poolData).map((V3Pool) => ({ target: V3Pool }))
    const token1Calls = Object.keys(poolData).map((V3Pool) => ({ target: V3Pool }))

    const token0Results = await sdk.api.abi.multiCall({
      abi: "function token0() view returns (address)",
      calls: token0Calls,
      block,
      chain,
    })
    
    token0Results.output.forEach((call, i) => {
      poolData[call.input.target].token0 = call.output
    })

    const token1Results = await sdk.api.abi.multiCall({
      abi: "function token1() view returns (address)",
      calls: token1Calls,
      block,
      chain,
    })
    
    token1Results.output.forEach((call, i) => {
      poolData[call.input.target].token1 = call.output
    })

    // Create balance calls for both tokens of each market
    const balanceCalls = []

    const LiquidityOwnedTokens = []
    
    // Iterate through markets array directly
    for (let [V3Pool, poolDataEntry] of Object.entries(poolData)) {
      const mintLogs = (
        await getLogs({
          api,
          target: V3Pool,
          fromBlock: START_BLOCK,
          extraKey: "mintCache",
          eventAbi: `event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)`,
          topics: ["0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde","0x"+"000000000000000000000000"+SFPM.slice(2)]
        })
      )
      const burnLogs = (
        await getLogs({
          api,
          target: V3Pool,
          fromBlock: START_BLOCK,
          extraKey: "burnCache",
          eventAbi: `event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)`,
          topics: ["0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c","0x"+"000000000000000000000000"+SFPM.slice(2)]
        })
      )

      let sfpmOwnedLiquiditiesForMarket = {}

      mintLogs.forEach((log) => {
        const key = log.args.tickLower.toString()+"-"+log.args.tickUpper.toString()
        sfpmOwnedLiquiditiesForMarket[key] = (sfpmOwnedLiquiditiesForMarket?.[key] ?? 0n) + log.args.amount})
      burnLogs.forEach((log) => sfpmOwnedLiquiditiesForMarket[log.args.tickLower.toString()+"-"+log.args.tickUpper.toString()] -= log.args.amount)
      
      const sqrtPriceX96 = (
        await sdk.api.abi.call({
          target: V3Pool,
          abi: "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
          block,
          chain,
        })
      ).output.sqrtPriceX96

      let extraTokens0 = 0n
      let extraTokens1 = 0n

      for (let [key, liquidity] of Object.entries(sfpmOwnedLiquiditiesForMarket)) {
        const sqrtLower = BigInt(getSqrtRatioAtTick(Number(key.split("-")[0])).toString())
        const sqrtUpper = BigInt(getSqrtRatioAtTick(Number(key.split("-")[1])).toString())

        const [amount0, amount1] = getAmountsForLiquidity(BigInt(sqrtPriceX96), liquidity, sqrtLower, sqrtUpper)
        extraTokens0 += amount0
        extraTokens1 += amount1
      }
      
      LiquidityOwnedTokens.push(extraTokens0)
      LiquidityOwnedTokens.push(extraTokens1)

      balanceCalls.push({
        target: poolDataEntry.token0,
        params: poolDataEntry.marketAddress,
      })
      balanceCalls.push({
        target: poolDataEntry.token1,
        params: poolDataEntry.marketAddress,
      })
    }

    const tokenBalances = await sdk.api.abi.multiCall({
      abi: 'erc20:balanceOf',
      calls: balanceCalls,
      block,
      chain,
    })

    // add tokens held in liquidity positions to TVL
    tokenBalances.output = tokenBalances.output.map((call, i) => ({...call, output: (BigInt(call.output) + LiquidityOwnedTokens[i]).toString()}))

    let transform = id => id
    let balances = {}

    sdk.util.sumMultiBalanceOf(balances, tokenBalances, true, transform)

    return balances
  }
}

function getAmount0ForLiquidity(
  sqrtRatioAX96,
  sqrtRatioBX96,
  liquidity,
) {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    const temp = sqrtRatioAX96
    sqrtRatioAX96 = sqrtRatioBX96
    sqrtRatioBX96 = temp
  }

  return (liquidity * Q96 * (sqrtRatioBX96 - sqrtRatioAX96)) / sqrtRatioBX96 / sqrtRatioAX96
}

function getAmount1ForLiquidity(
  sqrtRatioAX96,
  sqrtRatioBX96,
  liquidity,
) {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    const temp = sqrtRatioAX96
    sqrtRatioAX96 = sqrtRatioBX96
    sqrtRatioBX96 = temp
  }

  return (liquidity * (sqrtRatioBX96 - sqrtRatioAX96)) / Q96
}

function getAmountsForLiquidity(
  priceX96,
  liquidity,
  sqrtRatioAX96,
  sqrtRatioBX96,
) {
  if (priceX96 <= sqrtRatioAX96) {
    return [getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity), BigInt(0)]
  } else if (priceX96 >= sqrtRatioBX96) {
    return [BigInt(0), getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity)]
  } else {
    return [
      getAmount0ForLiquidity(priceX96, sqrtRatioBX96, liquidity),
      getAmount1ForLiquidity(sqrtRatioAX96, priceX96, liquidity),
    ]
  }
}

function getSqrtRatioAtTick(tick) {
  const MaxUint256 = JSBI.BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
  const Q32 = JSBI.BigInt('0x100000000');
  const ZERO = JSBI.BigInt(0);
  const ONE = JSBI.BigInt(1);
  var absTick = tick < 0 ? tick * -1 : tick;
  var ratio = (absTick & 0x1) !== 0 ? JSBI.BigInt('0xfffcb933bd6fad37aa2d162d1a594001') : JSBI.BigInt('0x100000000000000000000000000000000');
  if ((absTick & 0x2) !== 0) ratio = mulShift(ratio, '0xfff97272373d413259a46990580e213a');
  if ((absTick & 0x4) !== 0) ratio = mulShift(ratio, '0xfff2e50f5f656932ef12357cf3c7fdcc');
  if ((absTick & 0x8) !== 0) ratio = mulShift(ratio, '0xffe5caca7e10e4e61c3624eaa0941cd0');
  if ((absTick & 0x10) !== 0) ratio = mulShift(ratio, '0xffcb9843d60f6159c9db58835c926644');
  if ((absTick & 0x20) !== 0) ratio = mulShift(ratio, '0xff973b41fa98c081472e6896dfb254c0');
  if ((absTick & 0x40) !== 0) ratio = mulShift(ratio, '0xff2ea16466c96a3843ec78b326b52861');
  if ((absTick & 0x80) !== 0) ratio = mulShift(ratio, '0xfe5dee046a99a2a811c461f1969c3053');
  if ((absTick & 0x100) !== 0) ratio = mulShift(ratio, '0xfcbe86c7900a88aedcffc83b479aa3a4');
  if ((absTick & 0x200) !== 0) ratio = mulShift(ratio, '0xf987a7253ac413176f2b074cf7815e54');
  if ((absTick & 0x400) !== 0) ratio = mulShift(ratio, '0xf3392b0822b70005940c7a398e4b70f3');
  if ((absTick & 0x800) !== 0) ratio = mulShift(ratio, '0xe7159475a2c29b7443b29c7fa6e889d9');
  if ((absTick & 0x1000) !== 0) ratio = mulShift(ratio, '0xd097f3bdfd2022b8845ad8f792aa5825');
  if ((absTick & 0x2000) !== 0) ratio = mulShift(ratio, '0xa9f746462d870fdf8a65dc1f90e061e5');
  if ((absTick & 0x4000) !== 0) ratio = mulShift(ratio, '0x70d869a156d2a1b890bb3df62baf32f7');
  if ((absTick & 0x8000) !== 0) ratio = mulShift(ratio, '0x31be135f97d08fd981231505542fcfa6');
  if ((absTick & 0x10000) !== 0) ratio = mulShift(ratio, '0x9aa508b5b7a84e1c677de54f3e99bc9');
  if ((absTick & 0x20000) !== 0) ratio = mulShift(ratio, '0x5d6af8dedb81196699c329225ee604');
  if ((absTick & 0x40000) !== 0) ratio = mulShift(ratio, '0x2216e584f5fa1ea926041bedfe98');
  if ((absTick & 0x80000) !== 0) ratio = mulShift(ratio, '0x48a170391f7dc42444e8fa2');
  if (tick > 0) ratio = JSBI.divide(MaxUint256, ratio);
  // back to Q96
  return JSBI.greaterThan(JSBI.remainder(ratio, Q32), ZERO) ? JSBI.add(JSBI.divide(ratio, Q32), ONE) : JSBI.divide(ratio, Q32);
}

function mulShift(val, mulBy) {
  return JSBI.signedRightShift(JSBI.multiply(val, JSBI.BigInt(mulBy)), JSBI.BigInt(128));
}

module.exports = {
  ethereum: {
    tvl: chainTvl('ethereum'),
    methodology: 'This adapter counts tokens held by all PanopticPool contracts created by the PanopticFactory, as well as the token composition of all Uniswap liquidity held by the SemiFungiblePositionManager (which is used by every PanopticPool to manage liquidity).',
    start: 1734049391,
  },
}