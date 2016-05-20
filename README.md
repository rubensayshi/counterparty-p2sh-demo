P2SH support for Counterparty
=============================
Aside from the simple P2PKH (Pay to PubKeyHash) Bitcoin has support for P2SH (Pay To ScriptHash) addresses.

P2SH addresses are addresses for output scripts with the following template: `OP_HASH160 <scriptHash> OP_EQUAL`.  
When spending such an output script, you need to place a 'redeemScript' infront it of which the HASH160 matches the <scriptHash>.  
This enables us to have more complex scripts for outputs and have those scripts provided when spending, keeping the output script simple and easily used for an address.

Apart from using this for multisig it can also be used for other opcodes such as:
 - OP_IF / OP_ELSE / OP_ENDIF
 - OP_CHECKLOCKTIMEVERIFY
 - OP_CHECKSEQUENCEVERIFY

For example @F483 has begon work on payment channels for Counterparty here: https://github.com/F483/picopayments  
And this example project also contains an example for atomic swap between XCP and BTC, which is a build block for payments channels and atomic swaps between 2 blockchains.

Sending Counterparty Assets to a P2SH address
---------------------------------------------
Sending to a P2SH address is simple, just use the P2SH address as destination and everything works as before.

Sending Counterparty Assets from a P2SH address
-----------------------------------------------
To send from a P2SH address there's a few things that are different from normal.

#### Data Encoding
Counterparty transactions encode the metadata for the Counterparty protocol in the Bitcoin transaction.  
As long as the amount of data encoded is < 80 bytes we can use OP_RETURN for this, which won't pollute the Bitcoin UTXO set and won't require destroying BTC.  
As soon as the data encoded is > 80 bytes there's a nifty trick that is used to encode the data in 1-of-3 multisig outputs, the first 2 pubkeys of the output script are used to encode the data in
and the 3rd pubkey is the the pubkey of the sender so that the BTC used in the output (5500 satoshis) can be reclaimed and aren't destroyed.

The difference when sending from a P2SH address is that there's no known pubkey for the sender, so to avoid destroying BTC we need to have a pubkey for the 3rd pubkey!  
When constructing a transaction from a P2SH address the `dust_return_pubkey` argument (or `--dust-return-pubkey` from CLI) needs to be set.  
This can be set explicitly to `False`, in which case it falls back to a node-configured `--p2sh-dust-return-pubkey`, however this is an optional configuration for the node, so if you want to use this then you need to know if the node has this set or not.

If you're just getting started with testing out P2SH and/or your implementation has a hard time providing a pubkey for this we recommend you provide a random 32 byte hex or `'00' * 32` (random is better for privacy).

This Example Project
--------------------
The code in this repo is a small demo of using P2SH, all relevant code is found in `example.js` and `atomic-swap.js`, there's a bunch of helper things in `lib/` to do the Mnemonic and RPC stuff.  
You can run the example from CLI easily following the instructions below.  
You can also load the mnemonic from the file into https://testnet.counterwallet.io or put a mnemonic from there in it.

See the files themselves for comments about how things work, or feel free to ask questions on the Counterparty Slack!

Either edit the file to put in your CP and bitcoind info in the `""` or set the following env vars to your info:
```bash
export BITCOIN_RPC_HOST="127.0.0.1"
export BITCOIN_RPC_USER="bitcoin"
export BITCOIN_RPC_PASSWORD="bitcoin"

export CP_RPC_HOST="localhost"
export CP_RPC_USER="rpc"
export CP_RPC_PASSWORD="rpc"
```

#### Simple P2SH Example
```bash
node example.js balances # display balances
node example.js send-BTC-to-P2SH # sends some BTC from the P2PKH address to P2SH
node example.js send-XCP-to-P2SH # sends some XCP from the P2PKH address to P2SH
node example.js poll-for-block # wait for a block
node example.js balances # display balances
node example.js send-XCP-from-P2SH # send XCP back from the P2SH address to the P2PKH address
```

#### Atomic Swap Example
```bash
node example.js fund-bob # sends some BTC and XCP from alice to bob for testing
node example.js poll-for-block # wait for a block
node example.js atomic-swap # MAGIC!
```

