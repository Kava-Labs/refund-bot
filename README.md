# Refund Bot

Automated service for processing BEP3 refunds on Kava and Binance Chain.

## Set up

Clone the example env file

```bash
cp ./refund/example-env ./refund/.env
```

## Running

Running the refund bot is straightforward. Simply declare a new RefundBot, initialize its Kava client and Binance Chain client, then refund swaps on a cron job. Here's a working example:

```javascript
var main = async () => {
  // Load environment variables
  const cronTimer = process.env.CRONTAB;
  const kavaLcdURL = process.env.KAVA_LCD_URL;
  const kavaMnemonic = process.env.KAVA_MNEMONIC;
  const bnbChainLcdURL = process.env.BINANCE_CHAIN_LCD_URL;
  const bnbChainMnemonic = process.env.BINANCE_CHAIN_MNEMONIC;
  const bnbChainDeputy = process.env.BINANCE_CHAIN_DEPUTY_ADDRESS;

  // Initiate refund bot
  refundBot = new RefundBot(bnbChainDeputy);
  await refundBot.initKavaClient(kavaLcdURL, kavaMnemonic);
  await refundBot.initBnbChainClient(
    bnbChainLcdURL,
    bnbChainMnemonic,
    "mainnet"
  );

  // Start cron job
  cron.schedule(cronTimer, () => {
    refundBot.refundSwaps();
  });

  // Optional: print Binance Chain offsets hourly for debugging
  cron.schedule("* 1 * * *", () => {
    refundBot.printOffsets();
  });
};
```
