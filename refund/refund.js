require('dotenv').config();
require('log-timestamp');
const _ = require('lodash');
const Kava = require('@kava-labs/javascript-sdk');
const BnbChain = require('@binance-chain/javascript-sdk');
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
      throw new Error('must specify at least one Binance Chain deputy address');
    }
    this.deputyAddresses = deputyAddresses;
    this.limit = limit;
    this.offsetIncoming = offsetIncoming;
    this.offsetOutgoing = offsetOutgoing;
  }

  /**
   * Initialize the Kava client
   * @param {String} lcdURL api endpoint for Kava's rest-server
   * @param {String} mnemonic Kava address mnemonic
   * @return {Promise}
   */
  async initKavaClient(lcdURL, mnemonic) {
    if (!lcdURL) {
      throw new Error("Kava's chain's rest-server url is required");
    }
    if (!mnemonic) {
      throw new Error('Kava address mnemonic is required');
    }

    // Initiate and set Kava client
    this.kavaClient = new Kava.KavaClient(lcdURL);
    this.kavaClient.setWallet(mnemonic);
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
  async initBnbChainClient(lcdURL, mnemonic, network = 'testnet') {
    if (!lcdURL) {
      throw new Error("Binance Chain's rest-server url is required");
    }
    if (!mnemonic) {
      throw new Error('Binance Chain address mnemonic is required');
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
    const bnbAddrPrefix = network == 'mainnet' ? 'bnb' : 'tbnb';
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
    await this.refundKavaSwaps()
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
    for (var i = 0; i < swapIDs.length; i++) {
      const sequence = String(Number(accountData.sequence) + i);
      try {
        console.log(`\tRefunding swap ${swapIDs[i]}`);
        const txHash = await this.kavaClient.refundSwap(swapIDs[i], sequence);
        console.log('\tTx hash:', txHash);
      } catch (e) {
        console.log(`\tCould not refund swap ${swapIDs[i]}`);
        console.log(e);
      }
      await sleep(7000); // Wait for the block to be confirmed
    }
  }

  /**
   * Gets the swap IDs of all incoming and outgoing expired swaps on Kava
   */
  async getRefundableKavaSwaps() {
    let expiredSwaps = [];
    let checkNextBatch = true;
    let page = 1; // After refunding swaps paginated query results will always start from page 1

    while (checkNextBatch) {
      let swapBatch;
      const args = { status: 'Expired', page: page, limit: this.limit };
      try {
        swapBatch = await this.kavaClient.getSwaps(5000, args);
      } catch (e) {
        console.log(`couldn't query swaps on Kava...`);
        return;
      }
      // If swaps in batch, save them and increment page count
      if (swapBatch.length > 0) {
        expiredSwaps = expiredSwaps.concat(swapBatch);
        page++;
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
    for (const swapID of swapIDs) {
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
      await sleep(3000); // Wait for the block to be confirmed
    }
  }

  /**
   * Gets the swap IDs of all incoming and outgoing open swaps on Binance Chain
   * @param {Boolean} incoming swap direction, defaults to incoming
   */
  async getRefundableBinanceSwaps(incoming = true) {
    let openSwaps = [];

    let offsetIncoming = this.offsetIncoming;
    let offsetOutgoing = this.offsetOutgoing;

    for (var deputyAddress of this.deputyAddresses) {
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
          swapBatch = _.get(res, 'result.atomicSwaps');
        } catch (e) {
          console.log(
            `couldn't query ${
              incoming ? 'incoming' : 'outgoing'
            } swaps on Binance Chain...`
          );
          return;
        }

        // If swaps in batch, filter for expired swaps
        if (swapBatch.length > 0) {
          const refundableSwapsInBatch = swapBatch.filter(
            (swap) => swap.status == 1
          );
          openSwaps = openSwaps.concat(refundableSwapsInBatch);

          // If it's a full batch, increment offset by limit for next iteration
          if (swapBatch.length <= this.limit) {
            if (incoming) {
              offsetIncoming = offsetIncoming + this.limit;
            } else {
              offsetOutgoing = offsetOutgoing + this.limit;
            }
          }
          // If no swaps in batch, don't check the next batch
        } else {
          checkNextBatch = false;
        }
      }
    }

    return openSwaps.map((swap) => swap.swapId);
  }

  /**
   * Print the current Binance Chain offsets to console
   */
  printOffsets() {
    console.log('\nCurrent Binance Chain offsets:');
    console.log(`Offset incoming: ${this.offsetIncoming}`);
    console.log(`Offset outgoing: ${this.offsetOutgoing}\n`);
  }
}

// Sleep is a wait function
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports.RefundBot = RefundBot;
