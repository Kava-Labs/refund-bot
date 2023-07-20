require("dotenv").config();
require("log-timestamp");
const _ = require("lodash");
const Kava = require("@kava-labs/javascript-sdk");
const BnbChain = require("@binance-chain/javascript-sdk");
const bnbCrypto = BnbChain.crypto;

/**
 * Automatically refunds any refundable swaps on both Kava and Binance Chain
 */
class RefundBot {
  constructor(
    deputyAddresses,
    limit = 100,
    offsetIncoming = 0,
    offsetOutgoing = 0
  ) {
    if (deputyAddresses.length == 0) {
      throw new Error("must specify at least one Binance Chain deputy address");
    }
    this.deputyAddresses = deputyAddresses;
    this.limit = limit;
    this.offsetIncoming = offsetIncoming;
    this.offsetOutgoing = offsetOutgoing;
  }

  /**
   * Initialize the Kava client
   * @param {String} lcdURL api endpoint for Kava's rest-server
   * @param {String} rpcURL api endpoint for Kava's rpc server
   * @param {String} mnemonic Kava address mnemonic
   * @return {Promise}
   */
  async initKavaClient(lcdURL, kavaRpcURL, mnemonic) {
    if (!lcdURL) {
      throw new Error("Kava's chain's rest-server url is required");
    }
    if (!kavaRpcURL) {
      throw new Error("Kava's chain's rpc-server url is required");
    }
    if (!mnemonic) {
      throw new Error("Kava address mnemonic is required");
    }

    // Initiate and set Kava client
    this.kavaClient = new Kava.KavaClient(lcdURL, kavaRpcURL);
    this.kavaClient.setWallet(mnemonic);
    await this.kavaClient.setNewWallet(mnemonic);
    try {
      await this.kavaClient.initChain();
    } catch (e) {
      console.log("Cannot connect to Kava's lcd server:", e);
      return;
    }
    return this;
  }

  /**
   * Initialize the Binance Chain client
   * @param {String} lcdURL api endpoint for Binance Chain's rest-server
   * @param {String} mnemonic Binance Chain address mnemonic
   * @param {String} network "testnet" or "mainnet"
   * @return {Promise}
   */
  async initBnbChainClient(lcdURL, mnemonic, network = "testnet") {
    if (!lcdURL) {
      throw new Error("Binance Chain's rest-server url is required");
    }
    if (!mnemonic) {
      throw new Error("Binance Chain address mnemonic is required");
    }

    // Start Binance Chain client
    this.bnbClient = await new BnbChain(lcdURL);
    this.bnbClient.chooseNetwork(network);
    const privateKey = bnbCrypto.getPrivateKeyFromMnemonic(mnemonic);
    this.bnbClient.setPrivateKey(privateKey);
    try {
      await this.bnbClient.initChain();
    } catch (e) {
      console.log("Cannot connect to Binance Chain's lcd server:", e);
      return;
    }

    // Load our Binance Chain address (required for refunds)
    const bnbAddrPrefix = network == "mainnet" ? "bnb" : "tbnb";
    this.bnbChainAddress = bnbCrypto.getAddressFromPrivateKey(
      privateKey,
      bnbAddrPrefix
    );

    return this;
  }

  /**
   * Manages swap refunds
   */
  async refundSwaps() {
    await this.refundKavaSwaps();
    await this.refundBinanceChainSwaps();
  }

  /**
   * Refund any expired swaps on Kava
   */
  async refundKavaSwaps() {
    const swapIDs = await this.getRefundableKavaSwaps();
    console.log(`Kava refundable swap count: ${swapIDs.length}`);

    // Fetch account data so we can manually manage sequence when posting
    let accountData;
    try {
      accountData = await Kava.tx.loadMetaData(
        this.kavaClient.wallet.address,
        this.kavaClient.baseURI
      );
    } catch (e) {
      console.log(e);
      return;
    }

    // Refund each swap
    let i = 0;
    await asyncForEach(swapIDs, async (swapID) => {
      const sequence = String(Number(accountData.sequence) + i);
      try {
        console.log(`\tRefunding swap ${swapID}`);
        const fee = {
          amount: [{ denom: "ukava", amount: "50000" }],
          gas: String(300000),
        };
        const txHash = await this.kavaClient.refundSwap(swapID, fee, sequence);
        console.log("\tTx hash:", txHash);
      } catch (e) {
        console.log(`\tCould not refund swap ${swapID}`);
        console.log(e);
      }
      await sleep(25000); // Wait for the block to be confirmed
      i++;
    });
  }

  /**
   * Gets the swap IDs of all incoming and outgoing expired swaps on Kava
   */
  async getRefundableKavaSwaps() {
    let expiredSwaps = [];
    let checkNextBatch = true;
    let offset = 0; // After refunding swaps paginated query results will always start from page 1

    while (checkNextBatch) {
      let swapBatch;
      const args = {
        status: 3,
        "pagination.offset": offset,
        "pagination.limit": this.limit,
      };
      try {
        swapBatch = await this.kavaClient.getSwaps(args, 5000);
      } catch (e) {
        console.log(`couldn't query swaps on Kava...`);
        return [];
      }
      // If swaps in batch, save them and increment page count
      if (swapBatch && swapBatch.length > 0) {
        expiredSwaps = expiredSwaps.concat(swapBatch);
        offset += this.limit;
        // If no swaps in batch, don't check the next batch
      } else {
        checkNextBatch = false;
      }
    }

    // Calculate each swap's ID as it's not stored in the struct (it's on the interface)
    let swapIDs = [];
    for (const expiredSwap of expiredSwaps) {
      const swapID = Kava.utils.calculateSwapID(
        expiredSwap.random_number_hash,
        expiredSwap.sender,
        expiredSwap.sender_other_chain
      );
      swapIDs.push(swapID);
    }
    return swapIDs;
  }

  /**
   * Refund any expired swaps on Binance Chain
   */
  async refundBinanceChainSwaps() {
    const incomingSwaps = await this.getRefundableBinanceSwaps(true);
    const outgoingSwaps = await this.getRefundableBinanceSwaps(false);
    const swapIDs = incomingSwaps.concat(outgoingSwaps);

    console.log(`Binance Chain refundable swap count: ${swapIDs.length}`);

    // Refund each swap
    await asyncForEach(swapIDs, async (swapID) => {
      console.log(`\tRefunding swap ${swapID}`);
      try {
        const res = await this.bnbClient.swap.refundHTLT(
          this.bnbChainAddress,
          swapID
        );
        if (res && res.status == 200) {
          console.log(`\tTx hash: ${res.result[0].hash}`);
        }
      } catch (e) {
        console.log(`\t${e}`);
      }
      await sleep(5000); // Wait for the block to be confirmed
    });
  }

  /**
   * Gets the swap IDs of all incoming and outgoing open swaps on Binance Chain
   * @param {Boolean} incoming swap direction, defaults to incoming
   */
  async getRefundableBinanceSwaps(incoming = true) {
    let openSwaps = [];

    let offsetIncoming = this.offsetIncoming;
    let offsetOutgoing = this.offsetOutgoing;

    const bnbInfo = await this.bnbClient._httpClient.request(
      "get",
      "/api/v1/node-info"
    );
    const latestBnbBlockHeight = Number.parseInt(
      bnbInfo.result.sync_info.latest_block_height
    );
    // console.log(`Binance chain block height ${latestBnbBlockHeight}`)

    await asyncForEach(this.deputyAddresses, async (deputyAddress) => {
      let checkNextBatch = true;
      while (checkNextBatch) {
        let swapBatch;
        try {
          let res;
          if (incoming) {
            res = await this.bnbClient.getSwapByCreator(
              deputyAddress,
              this.limit,
              offsetIncoming
            );
          } else {
            res = await this.bnbClient.getSwapByRecipient(
              deputyAddress,
              this.limit,
              offsetOutgoing
            );
          }
          swapBatch = _.get(res, "result.atomicSwaps");
        } catch (e) {
          console.log(
            `couldn't query ${
              incoming ? "incoming" : "outgoing"
            } swaps on Binance Chain...`
          );
          return;
        }

        // If swaps in batch, filter for expired swaps
        if (swapBatch && swapBatch.length > 0) {
          const refundableSwapsInBatch = swapBatch.filter((swap) => {
            return (
              swap.status == 1 &&
              Number.parseInt(swap.expireHeight) <= latestBnbBlockHeight
            );
          });
          openSwaps = openSwaps.concat(refundableSwapsInBatch);

          // If it's a full batch, increment offset by limit for next iteration
          if (swapBatch.length <= this.limit) {
            if (incoming) {
              offsetIncoming = offsetIncoming + this.limit;
            } else {
              offsetOutgoing = offsetOutgoing + this.limit;
            }
          }
          // If no swaps in batch, don't check the next batch, reset offsets
        } else {
          checkNextBatch = false;
          offsetIncoming = this.offsetIncoming;
          offsetOutgoing = this.offsetOutgoing;
        }
      }
    });

    return openSwaps.map((swap) => swap.swapId);
  }

  /**
   * Print the current Binance Chain offsets to console
   */
  printOffsets() {
    console.log("\nCurrent Binance Chain offsets:");
    console.log(`Offset incoming: ${this.offsetIncoming}`);
    console.log(`Offset outgoing: ${this.offsetOutgoing}\n`);
  }
}

// Sleep is a wait function
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * performs an event-loop blocking callback function on each item in the input array
 * @param {object} array the array to perform the callback on
 * @param {*} callback the callback function to perform
 * @returns {Promise<boolean>}
 */
var asyncForEach = async (array, callback) => {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
};

module.exports.RefundBot = RefundBot;
