require('dotenv').config({ path: process.env.ENV_FILE});
const RefundBot = require('..').RefundBot;
const cron = require('node-cron');

var main = async () => {
  // Load environment variables
  const cronTimer = process.env.CRONTAB;
  const kavaLcdURL = process.env.KAVA_LCD_URL;
  const kavaRpcURL = process.env.KAVA_RPC_URL;
  const kavaMnemonic = process.env.KAVA_MNEMONIC;
  const bnbChainLcdURL = process.env.BINANCE_CHAIN_LCD_URL;
  const bnbChainMnemonic = process.env.BINANCE_CHAIN_MNEMONIC;
  const deputyAddresses = process.env.BINANCE_CHAIN_DEPUTY_ADDRESSES.split(',');

  // Initiate refund bot
  var refundBot = new RefundBot(deputyAddresses);
  await refundBot.initKavaClient(kavaLcdURL, kavaRpcURL, kavaMnemonic);
  await refundBot.initBnbChainClient(
    bnbChainLcdURL,
    bnbChainMnemonic,
    'mainnet'
  );

  // Start cron job
  cron.schedule(cronTimer, () => {
    refundBot.refundSwaps();
  });

  // Print Binance Chain offsets hourly for debugging and future optimization.
  cron.schedule("* 1 * * *", () => {
    refundBot.printOffsets()
  });
};
main();
