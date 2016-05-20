var rpc = require('../../rpc');

var RpcClient = rpc.createRpcClient();

RpcClient.prototype.create_send = function(source, destination, asset, quantity, options) {
    var params = {
        source: source,
        destination: destination,
        asset: asset,
        quantity: quantity
    };

    for (var k in options) {
        params[k] = options[k];
    }

    return this.call('create_send', params)
        .then(function(result) {
            return result.result;
        })
    ;
};

RpcClient.prototype.get_balances = function(addresses) {
    if (typeof addresses === "string") {
        addresses = [addresses];
    }

    return this.call('get_balances', {filters: [{field: 'address', op: 'IN', value: addresses}]})
        .then(function(result) {
            return result.result;
        })
    ;
};

RpcClient.prototype.get_normalized_balances = function(addresses) {
    if (typeof addresses === "string") {
        addresses = [addresses];
    }

    return this.call('get_normalized_balances', {'addresses': addresses})
        .then(function(result) {
            return result.result;
        })
    ;
};

module.exports = RpcClient;
