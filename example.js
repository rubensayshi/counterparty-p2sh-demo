var bitcoin = require('bitcoinjs-lib');
var counterparty = require('./lib');
var Q = require('q');

var NETWORK = bitcoin.networks.testnet;
var OP_INT_BASE = 80;

// create backend RPC
var cpHost = "" || process.env['CP_RPC_HOST'];
var cpUser = "" || process.env['CP_RPC_USER'];
var cpPass = "" || process.env['CP_RPC_PASSWORD'];
var backend = new counterparty.backends.counterpartyserver.Backend("http://" + cpUser + ":" + cpPass + "@" + cpHost + ":14000/", {timeout: 5000, errPrefix: 'CP '});

// create bitcoind RPC
var bitcoindHost = "" || process.env['BITCOIN_RPC_HOST'];
var bitcoindUser = "" || process.env['BITCOIN_RPC_USER'];
var bitcoindPass = "" || process.env['BITCOIN_RPC_PASSWORD'];
var bitcoindRPC = new (counterparty.rpc.createRpcClient())("http://" + bitcoindUser + ":" + bitcoindPass + "@" + bitcoindHost + ":18332", {errPrefix: 'Bitcoin '});

// init mnemonic
var m = new counterparty.Mnemonic((process.env['XCP_P2SH_MNEMONIC'] || "skin pressure serve only really joke cap okay twenty children alone sanity").split(" "));
var seed = m.toHex();

// derive masterkey
var masterKey = bitcoin.HDNode.fromSeedBuffer(new Buffer(seed, 'hex'), NETWORK);
masterKey = counterparty.utils.deriveByPath(masterKey, "m/0'/0", "m/");

// derive 1st and 2nd address
var privKey1 = masterKey.derive(0).keyPair;
var address1 = privKey1.getAddress();
var privKey2 = masterKey.derive(1).keyPair;
var address2 = privKey2.getAddress();

console.log('address1; ', address1);
console.log('address2; ', address2);

// create a 2-of-2 for 1st and 2nd address
var redeemScript = bitcoin.script.multisigOutput(2, [privKey1.getPublicKeyBuffer(), privKey2.getPublicKeyBuffer()]);
var outputScript = bitcoin.script.scriptHashOutput(bitcoin.crypto.hash160(redeemScript));
var p2shAddress = bitcoin.address.fromOutputScript(outputScript, NETWORK);

console.log('p2shAddress; ', p2shAddress);

// CONFIG
var FORCE_MULTISIG_ENCODING = false; // to test multisig encoding
var USE_NULL_PUBKEY = false;
var FORGET_DUST_RETURN_PUBKEY = false; // to test the error message

// DEFAULT_OPTIONS for params for API calls
var DEFAULT_OPTIONS = {
    allow_unconfirmed_inputs: true
};
// modify DEFAULT_OPTIONS based on config
if (!FORGET_DUST_RETURN_PUBKEY) {
    if (USE_NULL_PUBKEY) {
        DEFAULT_OPTIONS['dust_return_pubkey'] = new Array(33 + 1).join('00');
    } else {
        DEFAULT_OPTIONS['dust_return_pubkey'] = privKey1.getPublicKeyBuffer().toString('hex');
    }
}
if (FORCE_MULTISIG_ENCODING) {
    DEFAULT_OPTIONS['encoding'] = 'multisig';
}

function copy_object(v1, v2, v3) {
    var r = {};
    for (var i in arguments) {
        for (var k in arguments[i]) {
            r[k] = arguments[i][k];
        }
    }

    return r;
}

var options = {};
for (var k in DEFAULT_OPTIONS) {
    options[k] = DEFAULT_OPTIONS[k];
}

var pollForBlock = function(currentHeight) {
    return bitcoindRPC.call('getinfo').then(function(result) {
        var height = result.result.blocks;

        if (!currentHeight) {
            currentHeight = height;
        } else if (height > currentHeight) {
            console.log('NEW BLOCK!!', height);
            return height;
        }

        return Q.delay(1000).then(function() {
            return pollForBlock(currentHeight);
        });
    });
};

var balances = function(addresses) {
    return backend.get_balances(addresses)
        .then(function(balances) {
            return balances
                .filter(function(record) {
                    return record.asset == 'XCP';
                })
                .map(function(record) {
                    return record.address + ": " + record.quantity + " " + record.asset;
                })
            ;
        })
    ;
}

bitcoindRPC.call('getinfo')
    .then(function(result) {
        console.log('block height; ', result.result.blocks);
    })
    .then(function() {
        // process CLI arg
        switch ((process.argv[2] || "").toLowerCase()) {
            case 'balances':
                return balances([address1, address2, p2shAddress])
                    .then(function(balances) {
                        console.log(balances);
                    });

            // send some BTC to the P2SH address (for paying fees)
            case 'send-btc-to-p2sh':
                return balances([address1, address2, p2shAddress])
                    .then(function(balances) {
                        console.log(balances);
                    })
                    .then(function() {
                        return backend.create_send(address1, p2shAddress, 'BTC', 0.05 * 1e8, DEFAULT_OPTIONS)
                            .then(function(unsignedHex) {
                                console.log('unsignedHex; ', unsignedHex);

                                var txb = bitcoin.TransactionBuilder.fromTransaction(bitcoin.Transaction.fromHex(unsignedHex), NETWORK);

                                txb.inputs.forEach(function(input, idx) {
                                    txb.inputs[idx] = {}; // small hack to undo the fact that CP sets the output script in the input script
                                    txb.sign(idx, privKey1);
                                });

                                var tx = txb.build();
                                var signedHex = tx.toHex();

                                console.log('signedHex; ', signedHex);

                                return bitcoindRPC.call('sendrawtransaction', [signedHex])
                                    .then(function(result) {
                                        console.log('txId; ', result.result);
                                    });
                            });
                    })
                ;

            // send some XCP to P2PKH, just for testing the code
            case 'send-xcp-to-p2pkh':
                return balances([address1, address2, p2shAddress])
                    .then(function(balances) {
                        console.log(balances);
                    })
                    .then(function() {
                        return backend.create_send(address1, address2, 'XCP', 1 * 1e8, DEFAULT_OPTIONS)
                            .then(function(unsignedHex) {
                                console.log('unsignedHex; ', unsignedHex);

                                var txb = bitcoin.TransactionBuilder.fromTransaction(bitcoin.Transaction.fromHex(unsignedHex), NETWORK);

                                txb.inputs.forEach(function(input, idx) {
                                    txb.inputs[idx] = {}; // small hack to undo the fact that CP sets the output script in the input script
                                    txb.sign(idx, privKey1);
                                });

                                var tx = txb.build();
                                var signedHex = tx.toHex();

                                console.log('signedHex; ', signedHex);

                                return bitcoindRPC.call('sendrawtransaction', [signedHex])
                                    .then(function(result) {
                                        console.log('txId; ', result.result);
                                    });
                            });
                    })
                ;

            // send some XCP to P2SH
            case 'send-xcp-to-p2sh':
                return balances([address1, address2, p2shAddress])
                    .then(function(balances) {
                        console.log(balances);
                    })
                    .then(function() {
                        return backend.create_send(address1, p2shAddress, 'XCP', 1 * 1e8, DEFAULT_OPTIONS)
                            .then(function(unsignedHex) {
                                console.log('unsignedHex; ', unsignedHex);

                                var txb = bitcoin.TransactionBuilder.fromTransaction(bitcoin.Transaction.fromHex(unsignedHex), NETWORK);

                                txb.inputs.forEach(function(input, idx) {
                                    txb.inputs[idx] = {}; // small hack to undo the fact that CP sets the output script in the input script
                                    txb.sign(idx, privKey1);
                                });

                                var tx = txb.build();
                                var signedHex = tx.toHex();

                                console.log('signedHex; ', signedHex);

                                return bitcoindRPC.call('sendrawtransaction', [signedHex])
                                    .then(function(result) {
                                        console.log('txId; ', result.result);
                                    });
                            });
                    })
                ;

            // send some XCP from P2SH to address2
            case 'send-xcp-from-p2sh':
                var options = {};
                for (var k in DEFAULT_OPTIONS) {
                    options[k] = DEFAULT_OPTIONS[k];
                }

                return balances([address1, address2, p2shAddress])
                    .then(function(balances) {
                        console.log(balances);
                    })
                    .then(function() {
                        return backend.create_send(p2shAddress, address2, 'XCP', 1 * 1e8, DEFAULT_OPTIONS)
                            .then(function(unsignedHex) {
                                console.log('unsignedHex; ', unsignedHex);

                                var unsignedTx = bitcoin.Transaction.fromHex(unsignedHex);

                                console.log(unsignedTx)

                                var txb = bitcoin.TransactionBuilder.fromTransaction(unsignedTx, NETWORK);

                                txb.inputs.forEach(function(input, idx) {
                                    txb.inputs[idx] = {}; // small hack to undo the fact that CP sets the output script in the input script
                                    txb.sign(idx, privKey1, redeemScript);
                                    txb.sign(idx, privKey2, redeemScript);
                                });

                                var signedTx = txb.build();
                                var signedHex = signedTx.toHex();

                                console.log('signedHex; ', signedHex);

                                return bitcoindRPC.call('sendrawtransaction', [signedHex])
                                    .then(function(result) {
                                        console.log('txId; ', result.result);
                                    });
                            });
                    })
                ;

            // lazy me waiting for a new block ...
            case 'poll-for-block':
                return balances([address1, address2, p2shAddress])
                    .then(function(balances) {
                        console.log(balances);
                    })
                    .then(function() {
                        return pollForBlock().then(function(height) {
                            return balances([address1, address2, p2shAddress])
                                .then(function(balances) {
                                    console.log(balances);
                                })
                                ;
                        });
                    })
                ;

            default:
                console.log('commands are; ' +
                    'send-BTC-to-p2sh, send-XCP-to-p2pkh, send-XCP-to-p2sh, send-XCP-from-p2sh, poll-for-block'
                );
        }
    })
    .catch(function(err) {
        console.log('ERR', err);
    })
;
