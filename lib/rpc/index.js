'use strict';

var Q = require('q');
var http = require('http');
var https = require('https');

var cl = console.log.bind(console);

var noop = function() {};

function rpc(request, callback) {
    var self = this;

    request = JSON.stringify(request);
    var auth = new Buffer(self.user + ':' + self.pass).toString('base64');

    var options = {
        host: self.host,
        path: self.path,
        method: 'POST',
        port: self.port,
        rejectUnauthorized: self.rejectUnauthorized,
        agent: self.disableAgent ? false : undefined
    };

    if (self.httpOptions) {
        for (var k in self.httpOptions) {
            options[k] = self.httpOptions[k];
        }
    }

    var called = false;
    var errorMessage = (self.errPrefix || '') + 'JSON-RPC: host=' + self.host + ' port=' + self.port + ': ';
    var req = this.protocol.request(options, function(res) {
        var buf = '';
        res.on('data', function(data) {
            buf += data;
        });

        res.on('end', function() {
            if (called) {
                return;
            }
            called = true;

            if (res.statusCode === 401) {
                callback(new Error(errorMessage + 'Connection Rejected: 401 Unnauthorized'));
                return;
            }
            if (res.statusCode === 403) {
                callback(new Error(errorMessage + 'Connection Rejected: 403 Forbidden'));
                return;
            }

            var parsedBuf;
            try {
                parsedBuf = JSON.parse(buf);
            } catch(e) {
                self.log.err(e.stack);
                self.log.err(buf);
                self.log.err('HTTP Status code:' + res.statusCode);
                var err = new Error(errorMessage + 'Error Parsing JSON: ' + e.message);
                callback(err);
                return;
            }

            callback(parsedBuf.error, parsedBuf);

        });
    });

    req.on('error', function(e) {
        var err = new Error(errorMessage + 'Request Error: ' + e.message);
        self.log.err(err);
        if (!called) {
            called = true;
            callback(err);
        }
    });

    req.setTimeout(self.timeout);
    req.setHeader('Content-Length', request.length);
    req.setHeader('Content-Type', 'application/json');
    req.setHeader('Authorization', 'Basic ' + auth);
    req.write(request);
    req.end();
}

function getRandomId() {
    return parseInt(Math.random() * 100000);
}

function createRpcClient() {
    function RpcClient(opts) {
        if (typeof opts === "string") {
            var url = opts;
            if (arguments.length > 1) {
                opts = arguments[1];
            } else {
                opts = {};
            }

            var urlParsed = require('url').parse(url);

            var username = null, password = null;
            if (urlParsed.auth) {
                var auth = urlParsed.auth.split(':')
                username = auth[0];
                password = auth.length > 1 ? auth[1] : null;
            }

            opts.protocol = urlParsed.protocol.slice(0, -1);
            opts.user = username;
            opts.pass = password;
            opts.host = urlParsed.hostname;
            opts.path = urlParsed.path;
            opts.port = urlParsed.port || (opts.protocol === 'http' ? 80 : 443);
        }

        opts = opts || {};
        this.host = opts.host || '127.0.0.1';
        this.path = opts.path || '/';
        this.port = opts.port || 8332;
        this.user = opts.user || 'user';
        this.pass = opts.pass || 'pass';
        this.protocol = opts.protocol === 'http' ? http : https;
        this.batchedCalls = null;
        this.errPrefix = opts.errPrefix || '';
        this.disableAgent  = opts.disableAgent || false;
        this.timeout = opts.timeout || 20000;

        var isRejectUnauthorized = typeof opts.rejectUnauthorized !== 'undefined';
        this.rejectUnauthorized = isRejectUnauthorized ? opts.rejectUnauthorized : true;

        if(RpcClient.config.log) {
            this.log = RpcClient.config.log;
        } else {
            this.log = RpcClient.loggers[RpcClient.config.logger || 'normal'];
        }
    }

    RpcClient.loggers = {
        none: {info: noop, warn: noop, err: noop, debug: noop},
        normal: {info: cl, warn: cl, err: cl, debug: noop},
        debug: {info: cl, warn: cl, err: cl, debug: cl}
    };

    RpcClient.config = {
        logger: 'normal' // none, normal, debug
    };

    RpcClient.prototype.call = function(methodName, params) {
        var def = Q.defer();

        rpc.call(this, {
            jsonrpc: '2.0',
            method: methodName,
            params: params,
            id: this.getId()
        }, function(err, result) {
            if (err) {
                def.reject(err);
            } else {
                def.resolve(result);
            }
        });

        return def.promise;
    };

    RpcClient.prototype.batchCall = function(methodName, params) {
        this.batchedCalls.push({
            jsonrpc: '2.0',
            method: methodName,
            params: params,
            id: this.getId()
        });
    };

    RpcClient.prototype.doBatch = function() {
        var def = Q.defer();

        rpc.call(this, this.batchedCalls, function(err, result) {
            if (err) {
                def.reject(err);
            } else {
                def.resolve(result);
            }
        });

        this.batchedCalls = null;

        return def.promise;
    };

    RpcClient.prototype.getId = function() {
        return getRandomId();
    };

    return RpcClient;
}

module.exports = {
    createRpcClient: createRpcClient
};
