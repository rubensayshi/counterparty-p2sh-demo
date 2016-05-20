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

// CONFIG
var FORCE_MULTISIG_ENCODING = false; // to test multisig encoding
var USE_NULL_PUBKEY = true;
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
};

// setup alice & bob
var alicePrivKey = privKey1;
var bobPrivKey = privKey2;
var aliceAddress = alicePrivKey.getAddress();
var bobAddress = bobPrivKey.getAddress();

console.log('aliceAddress; ', aliceAddress);
console.log('bobAddress; ', bobAddress);

var aliceSecret = require('randombytes')(32);
var aliceSecretHash = bitcoin.crypto.hash160(aliceSecret);

var aliceToBobRedeemScript = bitcoin.script.compile([
    bitcoin.opcodes.OP_IF,
    bitcoin.opcodes.OP_HASH160,
    aliceSecretHash,
    bitcoin.opcodes.OP_EQUALVERIFY,
    bobPrivKey.getPublicKeyBuffer(),
    bitcoin.opcodes.OP_CHECKSIG,
    bitcoin.opcodes.OP_ELSE,
    OP_INT_BASE + 2,
    alicePrivKey.getPublicKeyBuffer(),
    bobPrivKey.getPublicKeyBuffer(),
    OP_INT_BASE + 2,
    bitcoin.opcodes.OP_CHECKMULTISIG,
    bitcoin.opcodes.OP_ENDIF
]);
var aliceToBobOutputScript = bitcoin.script.scriptHashOutput(bitcoin.crypto.hash160(aliceToBobRedeemScript));
var aliceToBobP2SHAddress = bitcoin.address.fromOutputScript(aliceToBobOutputScript, NETWORK);

var bobToAliceRedeemScript = bitcoin.script.compile([
    bitcoin.opcodes.OP_IF,
    bitcoin.opcodes.OP_HASH160,
    aliceSecretHash,
    bitcoin.opcodes.OP_EQUALVERIFY,
    alicePrivKey.getPublicKeyBuffer(),
    bitcoin.opcodes.OP_CHECKSIG,
    bitcoin.opcodes.OP_ELSE,
    OP_INT_BASE + 2,
    alicePrivKey.getPublicKeyBuffer(),
    bobPrivKey.getPublicKeyBuffer(),
    OP_INT_BASE + 2,
    bitcoin.opcodes.OP_CHECKMULTISIG,
    bitcoin.opcodes.OP_ENDIF
]);
var bobToAliceOutputScript = bitcoin.script.scriptHashOutput(bitcoin.crypto.hash160(bobToAliceRedeemScript));
var bobToAliceP2SHAddress = bitcoin.address.fromOutputScript(bobToAliceOutputScript, NETWORK);

console.log('aliceToBobP2SHAddress; ', aliceToBobP2SHAddress);
console.log('bobToAliceP2SHAddress; ', bobToAliceP2SHAddress);


bitcoindRPC.call('getinfo')
    .then(function(result) {
        console.log('block height; ', result.result.blocks);
    })
    .then(function() {
        // process CLI arg
        switch ((process.argv[2] || "").toLowerCase()) {

            /*
              atomic swap of 0.01 BTC from alice for 10 XCP from bob
              mostly following; https://www.coincer.org/2015/02/06/atomic-protocol-3-final/

              this would require segwit to avoid malleability when creating refund TXs,
              for demo purposes we skip doing the refund stuff completely

                - alice creates secret
                - alice creates 0.01 BTC TX to `OP_IF OP_HASH160 <HASH160(secret)> OP_EQUALVERIFY <bobpubkey> OP_CHECKSIG OP_ELSE 2of2 alice & bob`
                - alice creates refund from first tx with locktime (not in this demo!)
                - alice lets bob sign refund TX
                - alice tells bob the hash of the secret
                - bob creates 0.01 BTC TX to `OP_IF OP_HASH160 <HASH160(secret)> OP_EQUALVERIFY <alicepubkey> OP_CHECKSIG OP_ELSE 2of2 alice & bob`
                - bob creates refund from first tx with locktime (not in this demo!)
                - bob lets alice sign refund TX
                - both broadcast the P2SH TXs locking the funds for nlocktime
                - alice can spend bob's 0.01 BTC because she has the secret
                - as soon as alice shares the secret with bob, bob can spend his BTC

               if alice isn't very nice and refuses to share the secret with bob,
                - either once she uses the secret to get her XCP bob get's access to the secret too
                - or when the nlocktime is over both can use the refund TXs to reclaim
             */
            case 'atomic-swap':
                var options = {};
                for (var k in DEFAULT_OPTIONS) {
                    options[k] = DEFAULT_OPTIONS[k];
                }
                var aliceToBobTxId, bobToAliceTxId;

                /**
                 * function used to sign tx with privkey and secret
                 */
                var signClaimTxWithSecret = function(txb, privKey, redeemScript, secret) {
                    var signatureScript = redeemScript;
                    var signatureHash = txb.tx.hashForSignature(0, signatureScript, bitcoin.Transaction.SIGHASH_ALL);
                    var signature = privKey.sign(signatureHash);

                    var tx = txb.buildIncomplete();

                    var scriptSig = bitcoin.script.compile([
                        signature.toScriptSignature(bitcoin.Transaction.SIGHASH_ALL),
                        secret,
                        bitcoin.opcodes.OP_TRUE
                    ]);

                    var scriptSig = bitcoin.script.scriptHashInput(scriptSig, redeemScript);
                    tx.setInputScript(0, scriptSig);

                    return tx;
                };

                /**
                 * function used to sign tx with both privkeys (to create a refund TX)
                 *  normally this would actually be 2 steps, privKey1 signs and shares partially signed TX with other party
                 *  then privKey2 signs and has the fully signed TX
                 */
                var signClaimTxWithMultisig = function(txb, privKey1, privKey2, redeemScript) {
                    var signatureScript = redeemScript;
                    var signatureHash = txb.tx.hashForSignature(0, signatureScript, bitcoin.Transaction.SIGHASH_ALL);
                    var signature1 = privKey1.sign(signatureHash);
                    var signature2 = privKey2.sign(signatureHash);

                    var tx = txb.buildIncomplete();

                    var scriptSig = bitcoin.script.compile([
                        bitcoin.opcodes.OP_O,
                        signature1.toScriptSignature(bitcoin.Transaction.SIGHASH_ALL),
                        signature2.toScriptSignature(bitcoin.Transaction.SIGHASH_ALL),
                        bitcoin.opcodes.OP_FALSE
                    ]);

                    var scriptSig = bitcoin.script.scriptHashInput(scriptSig, redeemScript);
                    tx.setInputScript(0, scriptSig);

                    return tx;
                };

                return balances([aliceAddress, bobAddress])
                    .then(function(balances) {
                        console.log(balances);
                    })
                    .then(function() {
                        return Q.when(true)
                            .then(function() {
                                // send 0.0005 as dust size to use for fee for next TX
                                var params = copy_object(DEFAULT_OPTIONS, {regular_dust_size: parseInt(0.0005 * 1e8)});

                                console.log({regular_dust_size: parseInt(0.0005 * 1e8)}, params);

                                // create 0.01 BTC from alice into locked P2SH
                                return backend.create_send(aliceAddress, aliceToBobP2SHAddress, 'BTC', 0.01 * 1e8, params)
                                    .then(function (unsignedHex) {
                                        console.log('alice to aliceToBobP2SHAddress unsignedHex; ', unsignedHex);

                                        var unsignedTx = bitcoin.Transaction.fromHex(unsignedHex);

                                        var txb = bitcoin.TransactionBuilder.fromTransaction(unsignedTx, NETWORK);

                                        txb.inputs.forEach(function (input, idx) {
                                            txb.inputs[idx] = {}; // small hack to undo the fact that CP sets the output script in the input script
                                            txb.sign(idx, alicePrivKey);
                                        });

                                        var signedTx = txb.build();
                                        return signedTx.toHex();
                                    })
                                    .then(function (signedHex) {
                                        return bitcoindRPC.call('sendrawtransaction', [signedHex])
                                            .then(function (result) {
                                                console.log('alice to aliceToBobP2SHAddress txId; ', result.result);

                                                aliceToBobTxId = result.result;
                                                return result.result;
                                            });
                                    })
                                ;
                            })
                            .then(function() {
                                // send 0.0005 as dust size to use for fee for next TX
                                var params = copy_object(DEFAULT_OPTIONS, {regular_dust_size: parseInt(0.0005 * 1e8)});

                                // create 10 XCP from bob into locked P2SH
                                return backend.create_send(bobAddress, bobToAliceP2SHAddress, 'XCP', 10 * 1e8, params)
                                    .then(function(unsignedHex) {
                                        console.log('bob to bobToAliceP2SHAddress unsignedHex; ', unsignedHex);

                                        var unsignedTx = bitcoin.Transaction.fromHex(unsignedHex);

                                        var txb = bitcoin.TransactionBuilder.fromTransaction(unsignedTx, NETWORK);

                                        txb.inputs.forEach(function(input, idx) {
                                            txb.inputs[idx] = {}; // small hack to undo the fact that CP sets the output script in the input script
                                            txb.sign(idx, bobPrivKey);
                                        });

                                        var signedTx = txb.build();
                                        return signedTx.toHex();
                                    })
                                    .then(function(signedHex) {
                                        return bitcoindRPC.call('sendrawtransaction', [signedHex])
                                            .then(function(result) {
                                                console.log('bob to bobToAliceP2SHAddress txId; ', result.result);

                                                bobToAliceTxId = result.result;
                                                return result.result;
                                            });
                                    })
                            })
                            .then(function() {
                                // need to wait for a block for the XCP to settle
                                console.log('waiting for new block ....');
                                var waitForConfirmations = function() {
                                    return balances([aliceAddress, bobAddress, aliceToBobP2SHAddress, bobToAliceP2SHAddress])
                                        .then(function(balances) {
                                            console.log(balances);
                                        })
                                        .then(function() {
                                            return pollForBlock();
                                        })
                                        .then(function() {
                                            var aliceToBobConfirmed = false;
                                            var bobToAliceConfirmed = false;

                                            Q.when(true)
                                                .then(function() {
                                                    return bitcoindRPC.call('getrawtransaction', [aliceToBobTxId, true])
                                                        .then(function (result) {
                                                            var txJSON = result.result;

                                                            aliceToBobConfirmed = txJSON.confirmations > 0;
                                                            console.log('aliceToBobConfirmed?', aliceToBobConfirmed);
                                                            return aliceToBobConfirmed;
                                                        })
                                                    ;
                                                })
                                                .then(function(aliceToBobConfirmed) {
                                                    if (!aliceToBobConfirmed) {
                                                        return aliceToBobConfirmed;
                                                    }

                                                    return bitcoindRPC.call('getrawtransaction', [bobToAliceTxId, true])
                                                        .then(function (result) {
                                                            var txJSON = result.result;

                                                            bobToAliceConfirmed = txJSON.confirmations > 0;
                                                            console.log('bobToAliceConfirmed?', bobToAliceConfirmed);
                                                            return bobToAliceConfirmed;
                                                        })
                                                    ;
                                                })
                                                .then(function(bothConfirmed) {
                                                    if (!bothConfirmed) {
                                                        return waitForConfirmations();
                                                    }
                                                });
                                            ;
                                        })
                                        .then(function() {
                                            // wait 30s for things to settle in the CP node (extra long cuz I run cp with --backend-poll-interval=10
                                            return Q.delay(30 * 1000);
                                        })
                                        .then(function() {
                                            return balances([aliceAddress, bobAddress, aliceToBobP2SHAddress, bobToAliceP2SHAddress])
                                                .then(function(balances) {
                                                    console.log(balances);
                                                })
                                                ;
                                        })
                                    ;
                                };

                                return waitForConfirmations();
                            })
                            .then(function() {
                                // alice claims 10 XCP from bob  with the secret
                                return backend.create_send(bobToAliceP2SHAddress, aliceAddress, 'XCP', 10 * 1e8, DEFAULT_OPTIONS)
                                    .then(function(unsignedHex) {
                                        console.log('alice claims XCP unsignedHex; ', unsignedHex);

                                        var unsignedTx = bitcoin.Transaction.fromHex(unsignedHex);

                                        var txb = bitcoin.TransactionBuilder.fromTransaction(unsignedTx, NETWORK);

                                        var signedTx = signClaimTxWithSecret(txb, alicePrivKey, bobToAliceRedeemScript, aliceSecret);

                                        return signedTx.toHex();
                                    })
                                    .then(function(signedHex) {
                                        return bitcoindRPC.call('sendrawtransaction', [signedHex])
                                            .then(function(result) {
                                                console.log('alice claims XCP txId; ', result.result);

                                                bobToAliceTxId = result.result;
                                                return result.result;
                                            });
                                    })
                            })
                            .then(function() {
                                // force fixed fee
                                var fee = 0.0001;
                                var params = copy_object(DEFAULT_OPTIONS, {fee: parseInt(fee * 1e8)});

                                // bob claims 0.01 BTC from alice with the secret
                                return backend.create_send(aliceToBobP2SHAddress, bobAddress, 'BTC', 0.008 * 1e8, params)
                                    .then(function(unsignedHex) {
                                        console.log('bob claims BTC unsignedHex; ', unsignedHex);

                                        var unsignedTx = bitcoin.Transaction.fromHex(unsignedHex);

                                        var txb = bitcoin.TransactionBuilder.fromTransaction(unsignedTx, NETWORK);

                                        var signedTx = signClaimTxWithSecret(txb, bobPrivKey, aliceToBobRedeemScript, aliceSecret);

                                        return signedTx.toHex();
                                    })
                                    .then(function(signedHex) {
                                        return bitcoindRPC.call('sendrawtransaction', [signedHex])
                                            .then(function(result) {
                                                console.log('bob claims BTC txId; ', result.result);

                                                bobToAliceTxId = result.result;
                                                return result.result;
                                            });
                                    })
                                ;
                            })
                        ;
                    })
                ;

            case 'fund-bob':
                // give bob some XPC and BTC for testing, because alice is much richer than bob
                // or really just because testnet faucets block my IP after 1 withdrawal
                return Q.when(true)
                    .then(function () {
                        // give bob some BTC
                        return backend.create_send(aliceAddress, bobAddress, 'BTC', 0.5 * 1e8, DEFAULT_OPTIONS)
                            .then(function (unsignedHex) {
                                console.log('fundBob unsignedHex; ', unsignedHex);

                                var unsignedTx = bitcoin.Transaction.fromHex(unsignedHex);

                                var txb = bitcoin.TransactionBuilder.fromTransaction(unsignedTx, NETWORK);

                                txb.inputs.forEach(function (input, idx) {
                                    txb.inputs[idx] = {}; // small hack to undo the fact that CP sets the output script in the input script
                                    txb.sign(idx, alicePrivKey);
                                });

                                var signedTx = txb.build();
                                return signedTx.toHex();
                            })
                            .then(function (signedHex) {
                                return bitcoindRPC.call('sendrawtransaction', [signedHex])
                                    .then(function (result) {
                                        console.log('fundBob txId; ', result.result);

                                        return result.result;
                                    })
                                ;
                            })
                            ;
                    })
                    .then(function () {
                        // give bob some XCP
                        return backend.create_send(aliceAddress, bobAddress, 'XCP', 500 * 1e8, DEFAULT_OPTIONS)
                            .then(function (unsignedHex) {
                                console.log('fundBob unsignedHex; ', unsignedHex);

                                var unsignedTx = bitcoin.Transaction.fromHex(unsignedHex);

                                var txb = bitcoin.TransactionBuilder.fromTransaction(unsignedTx, NETWORK);

                                txb.inputs.forEach(function (input, idx) {
                                    txb.inputs[idx] = {}; // small hack to undo the fact that CP sets the output script in the input script
                                    txb.sign(idx, alicePrivKey);
                                });

                                var signedTx = txb.build();
                                return signedTx.toHex();
                            })
                            .then(function (signedHex) {
                                return bitcoindRPC.call('sendrawtransaction', [signedHex])
                                    .then(function (result) {
                                        console.log('fundBob txId; ', result.result);

                                        return result.result;
                                    })
                                ;
                            })
                        ;
                    })
                ;

            // staging/dev case for atomic swap P2SH script
            case 'atomic-swap-dev':
                var fee = 0.0001;
                var val = 0.001;

                // load P2SH address with 0.001
                var utxo = 0.63648972;
                var utxo = utxo - fee - val;
                var utxo = utxo - fee - val;
                var txb = new bitcoin.TransactionBuilder(NETWORK);
                txb.addInput('5d3a253d0ec8d21ba383c192916e4382a01bb774fb94b8682df78f198a5fe53b', 1);
                txb.addOutput(aliceToBobP2SHAddress, parseInt(val * 1e8));
                txb.addOutput("miDAc4uBw6X2cD41iRtfrPzQT2MezD8SNz", parseInt((utxo - fee - val) * 1e8));
                txb.sign(0, privKey1);
                console.log(txb.build().toHex());

                return bitcoindRPC.call('sendrawtransaction', [txb.build().toHex()])
                    .then(function(result) {
                        console.log('txId; ', result.result);

                        return result.result;
                    })
                    .then(function(txId) {
                        var txb = new bitcoin.TransactionBuilder(NETWORK);
                        txb.addInput(txId, 0);
                        txb.addOutput("miDAc4uBw6X2cD41iRtfrPzQT2MezD8SNz", parseInt((val - fee) * 1e8));

                        var signatureScript = aliceToBobRedeemScript;
                        var signatureHash = txb.tx.hashForSignature(0, signatureScript, bitcoin.Transaction.SIGHASH_ALL);
                        var aliceSignature = alicePrivKey.sign(signatureHash);
                        var bobSignature = bobPrivKey.sign(signatureHash);

                        console.log('build');
                        var tx = txb.buildIncomplete();
                        console.log(tx.toHex());

                        ///*
                        // with secret
                        console.log('----')
                        var scriptSig = bitcoin.script.compile([
                            aliceSignature.toScriptSignature(bitcoin.Transaction.SIGHASH_ALL),
                            aliceSecret,
                            bitcoin.opcodes.OP_TRUE
                        ]);
                        console.log('scriptSig', bitcoin.script.toASM(scriptSig));

                        var scriptSig = bitcoin.script.scriptHashInput(scriptSig, aliceToBobRedeemScript);
                        console.log('setInputScript', bitcoin.script.toASM(scriptSig));
                        tx.setInputScript(0, scriptSig);
                        //*/

                        /*
                         // multisig
                         console.log('----')
                         var scriptSig = bitcoin.script.compile([
                         bitcoin.opcodes.OP_O,
                         aliceSignature.toScriptSignature(bitcoin.Transaction.SIGHASH_ALL),
                         bobSignature.toScriptSignature(bitcoin.Transaction.SIGHASH_ALL),
                         bitcoin.opcodes.OP_FALSE
                         ]);
                         console.log('scriptSig', bitcoin.script.toASM(scriptSig));
                         var scriptSig = bitcoin.script.scriptHashInput(scriptSig, aliceToBobRedeemScript);
                         console.log('setInputScript', bitcoin.script.toASM(scriptSig));
                         tx.setInputScript(0, scriptSig);
                         //*/

                        console.log(tx.toHex());

                        return bitcoindRPC.call('sendrawtransaction', [tx.toHex()])
                            .then(function(result) {
                                console.log('txId; ', result.result);

                                return result.result;
                            })
                        ;
                    })
                ;

            // lazy me waiting for a new block ...
            case 'poll-for-block':
                return balances([aliceAddress, bobAddress])
                    .then(function(balances) {
                        console.log(balances);
                    })
                    .then(function() {
                        return pollForBlock().then(function(height) {
                            return balances([aliceAddress, bobAddress])
                                .then(function(balances) {
                                    console.log(balances);
                                })
                                ;
                        });
                    })
                ;

            default:
                console.log('commands are; ' +
                    'poll-for-block, ' +
                    'atomic-swap, fund-bob, atomic-swap-dev')
        }
    })
    .catch(function(err) {
        console.log('ERR', err);
    })
;
