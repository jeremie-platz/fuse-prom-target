import client, { Gauge, register } from "prom-client";
client.collectDefaultMetrics();

import express from "express";
import fetch from "node-fetch";

import Fuse from "./fuse.node.commonjs2.js";

const fuse = new Fuse("https://turbogeth.crows.sh");

let userLeverage = new Gauge({
  name: "fuse_userLeverage",
  help: "Stores how many users are at different levels of leverage.",
  // Levels: at_risk, liquidatable
  labelNames: ["id", "level"] as const,
});

let poolAssetsInterestRate = new Gauge({
  name: "fuse_pool_assets_interest_rate",
  help: "Stores the interest rates of each asset in each pool.",
  // Side: borrow, supply
  labelNames: ["id", "symbol", "side"] as const,
});

let poolRSS = new Gauge({
  name: "fuse_pool_rss",
  help: "Stores the RSS score of each pool.",
  labelNames: ["id"] as const,
});

let poolSuppliedAssetsAmount = new Gauge({
  name: "fuse_pool_assets_supply_amount",
  help: "Stores how much of each asset is supplied in each pool.",
  labelNames: ["id", "symbol"] as const,
});

let poolBorrowedAssetsAmount = new Gauge({
  name: "fuse_pool_assets_borrow_amount",
  help: "Stores how much of each asset is borrowed in each pool.",
  labelNames: ["id", "symbol"] as const,
});

let poolSuppliedAssetsUSD = new Gauge({
  name: "fuse_pool_assets_supply_usd",
  help: "Stores how much of each asset is supplied in each pool.",
  labelNames: ["id", "symbol"] as const,
});

let poolBorrowedAssetsUSD = new Gauge({
  name: "fuse_pool_assets_borrow_usd",
  help: "Stores how much of each asset is borrowed in each pool.",
  labelNames: ["id", "symbol"] as const,
});

let poolAssetsLiquidations = new Gauge({
  name: "fuse_pool_assets_liquidations",
  help: "Stores how many liquidations occur for each asset in each pool.",
  labelNames: ["id", "symbol"] as const,
});

function fetchUsersWithHealth(
  fuse: any,
  comptroller: string,
  maxHealth: number
) {
  return fuse.contracts.FusePoolLens.methods
    .getPoolUsersWithData(comptroller, fuse.web3.utils.toBN(maxHealth))
    .call()
    .then((result: { account: string }[][]) =>
      result[0].map((data) => data.account)
    ) as Promise<string[]>;
}

function removeDoubleCounts(array1: any[], array2: any[]) {
  return array1.filter(function (val) {
    return array2.indexOf(val) == -1;
  });
}

export interface FuseAsset {
  cToken: string;

  borrowBalance: number;
  supplyBalance: number;
  liquidity: number;

  membership: boolean;

  underlyingName: string;
  underlyingSymbol: string;
  underlyingToken: string;
  underlyingDecimals: number;
  underlyingPrice: number;

  collateralFactor: number;
  reserveFactor: number;

  adminFee: number;
  fuseFee: number;

  borrowRatePerBlock: number;
  supplyRatePerBlock: number;

  totalBorrow: number;
  totalSupply: number;
}

let runs = 0;
function runsEndsIn(num: number) {
  // We want all tasks to run on the first run.
  if (runs === 1) {
    console.log("It's our first run, forcing a true.");
    return true;
  }

  const lastDigit = runs % 10;

  console.log(
    "Run ends with:",
    lastDigit,
    " and this part will only run if it ends with",
    num
  );
  return lastDigit === num;
}

async function eventLoop() {
  runs++;

  const [{ 0: ids, 1: fusePools }, ethPrice] = await Promise.all([
    fuse.contracts.FusePoolLens.methods
      .getPublicPoolsWithData()
      .call({ gas: 1e18 }),
    fuse.web3.utils.fromWei(await fuse.getEthUsdPriceBN()) as number,
  ]);

  console.log("Fetched base data...");

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];

    console.log("Fetching pool #", id);

    // RSS (Happens every 15 minutes)
    if (runsEndsIn(60)) {
      fetch(`https://app.rari.capital/api/rss?poolID=${id}`)
        .then((res) => res.json())
        .then((data) => {
          console.log(
            "Fetching RSS for pool #",
            id,
            "which was last updated",
            data.lastUpdated
          );

          poolRSS.set({ id }, data.totalScore);
        });
    }

    fuse.contracts.FusePoolLens.methods
      .getPoolAssetsWithData(fusePools[i].comptroller)
      .call({
        from: "0x0000000000000000000000000000000000000000",
        gas: 1e18,
      })
      .then((assets: FuseAsset[]) => {
        assets.forEach((asset) => {
          console.log("Updating general data", asset.underlyingSymbol);

          // Amount

          poolSuppliedAssetsAmount.set(
            { id, symbol: asset.underlyingSymbol },
            asset.totalSupply / 10 ** asset.underlyingDecimals
          );

          poolBorrowedAssetsAmount.set(
            { id, symbol: asset.underlyingSymbol },
            asset.totalBorrow / 10 ** asset.underlyingDecimals
          );

          // USD

          poolSuppliedAssetsUSD.set(
            { id, symbol: asset.underlyingSymbol },
            ((asset.totalSupply * asset.underlyingPrice) / 1e36) * ethPrice
          );

          poolBorrowedAssetsUSD.set(
            { id, symbol: asset.underlyingSymbol },
            ((asset.totalBorrow * asset.underlyingPrice) / 1e36) * ethPrice
          );

          // Interst Rates

          const supplyAPY =
            (Math.pow(
              (asset.supplyRatePerBlock / 1e18) * (4 * 60 * 24) + 1,
              365
            ) -
              1) *
            100;

          const borrowAPY =
            (Math.pow(
              (asset.borrowRatePerBlock / 1e18) * (4 * 60 * 24) + 1,
              365
            ) -
              1) *
            100;

          poolAssetsInterestRate.set(
            { id, symbol: asset.underlyingSymbol, side: "supply" },
            supplyAPY
          );

          poolAssetsInterestRate.set(
            { id, symbol: asset.underlyingSymbol, side: "borrow" },
            borrowAPY
          );

          // Liquidations (Happens every 45 seconds)
          if (runsEndsIn(3)) {
            const cToken = new fuse.web3.eth.Contract(
              JSON.parse(
                fuse.compoundContracts[
                  "contracts/CEtherDelegate.sol:CEtherDelegate"
                ].abi
              ),
              asset.cToken
            );

            cToken
              .getPastEvents("LiquidateBorrow", {
                fromBlock: "12060000",
                toBlock: "latest",
              })
              .then((events) => {
                console.log(
                  "Fetching liquidation data",
                  asset.underlyingSymbol
                );

                poolAssetsLiquidations.set(
                  { id, symbol: asset.underlyingSymbol },
                  events.length
                );
              });
          }
        });
      });

    // User health (Happens every 30 seconds)
    if (runsEndsIn(2)) {
      Promise.all([
        fetchUsersWithHealth(fuse, fusePools[i].comptroller, 1e18),
        fetchUsersWithHealth(fuse, fusePools[i].comptroller, 1.1e18),
      ]).then(([underwaterUsersArray, atRiskUsersArray]) => {
        console.log("Fetching leverage data", id);

        userLeverage.set(
          { id, level: "liquidatable" },
          underwaterUsersArray.length
        );
        userLeverage.set(
          { id, level: "at_risk" },
          removeDoubleCounts(atRiskUsersArray, underwaterUsersArray).length
        );
      });
    }
  }
}

// Event loop (every 15 secs)
setInterval(eventLoop, 15_000);

// Run instantly the first time.
eventLoop();

const app = express();
const port = 1336;

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.listen(port, () => {
  console.log(`Target server started at http://localhost:${port}/metrics`);
});
