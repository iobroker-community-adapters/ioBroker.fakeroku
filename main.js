/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

var dgram = require('dgram');
var http = require('http');
var httpHeaders = require('http-headers');

var utils =    require(__dirname + '/lib/utils'); // Get common adapter utils
var adapter = utils.adapter('fakeroku');

var MULTICAST_IP,
    HTTP_PORT,
    BIND,
    UUID,
    SSDP_RESPONSE,
    DESCXML,
    socket,
    server,
    objects;

adapter.on('unload', function (callback) {
    try {
        adapter.log.info('cleaned everything up...');
        stopDiscovery();
        stopServer();
        callback();
    } catch (e) {
        callback();
    }
});

adapter.on('ready', function () {
    init();
    main();
});

function init() {
    MULTICAST_IP = adapter.config.MULTICAST_IP || "239.255.255.250";
    UUID = adapter.config.UUID || getUUID();
    HTTP_PORT = Math.min(65535, Math.max(0, parseInt(adapter.config.HTTP_PORT, 10) || 9093));
    BIND = adapter.config.BIND || "0.0.0.0";
    SSDP_RESPONSE = new Buffer(
        "HTTP/1.1 200 OK\r\nCache-Control: max-age=300\r\nST: roku:ecp\r\nUSN: uuid:roku:ecp:" +
        UUID + "\r\nExt: \r\nServer: Roku UPnP/1.0 MiniUPnPd/1.4\r\nLOCATION: http://" +
        BIND + ":" + HTTP_PORT + "/\r\n\r\n"
    );
    DESCXML = `<?xml version="1.0" encoding="UTF-8" ?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <device>
    <deviceType>urn:roku-com:device:player:1-0</deviceType>
    <friendlyName>ioBroker${adapter.instance}</friendlyName>
    <manufacturer>Pmant</manufacturer>
    <manufacturerURL>https://github.com/Pmant/</manufacturerURL>
    <modelDescription>ioBroker fake Roku player</modelDescription>
    <modelName>ioBroker${adapter.instance}</modelName>
    <modelNumber>4200X</modelNumber>
    <modelURL>https://github.com/Pmant/ioBroker.fakeroku</modelURL>
    <serialNumber>${UUID}</serialNumber>
    <UDN>uuid:roku:ecp:${UUID}</UDN>
    <serviceList>
      <service>
        <serviceType>urn:roku-com:service:ecp:1</serviceType>
        <serviceId>urn:roku-com:serviceId:ecp1-0</serviceId>
        <controlURL/>
        <eventSubURL/>
        <SCPDURL>ecp_SCPD.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`;
    objects = [];
}

function main() {
    startServer(function () {
        startDiscovery();
    });
}

function startServer(callback) {
    server = http.createServer(function (request, response) {
        request.connection.ref();
        var method = request.method;
        var url = request.url;
        var body = [];
        request.on('error', function (err) {
            adapter.log.warn(err);
        }).on('data', function (chunk) {
            body.push(chunk);
        }).on('end', function () {
            response.on('error', function (err) {
                adapter.log.warn(err);
            });
            adapter.log.debug(method + "-request to " + url + " from " + request.connection.remoteAddress);
            if (method === 'GET' && url == '/') {
                response.statusCode = 200;
                response.setHeader('Content-Type', 'text/xml; charset=utf-8');
                response.setHeader('Connection', 'close');
                adapter.log.debug("sending service description");
                response.end(DESCXML, function () {
                    request.connection.unref();
                });
            } else {
                if (method === "GET") {
                    var message = parseQuery(url);
                    response.end(message, function () {
                        request.connection.unref();
                    });
                } else {
                    parseCommand(url);
                    response.end(function () {
                        request.connection.unref();
                    });
                }
            }
        });
    });
    server.on('connection', function (socket) {
        socket.unref();
    });
    server.on("error", function (err) {
        adapter.log.error(err);
        stopServer();
    });
    server.listen(HTTP_PORT, BIND, function () {
        adapter.log.debug("HTTP-Server started on " + BIND + ":" + HTTP_PORT);
    });
    if (typeof callback === 'function') callback();
}

function stopServer() {
    if (server) server.close();
}

function startDiscovery() {
    socket = dgram.createSocket({type: 'udp4', reuseAddr: true});
    socket.on("error", function (error) {
            adapter.log.error(error);
            stopDiscovery();
        }
    );
    socket.on("message", function (msg, rinfo) {
            if (msg.toString().match(/^(M-SEARCH) \* HTTP\/1.\d/)) {
                var headers = httpHeaders(msg);
                if (headers.man === '"ssdp:discover"') {
                    adapter.log.debug("response sent to " + rinfo.address + ":" + rinfo.port);
                    socket.send(SSDP_RESPONSE, rinfo.port, rinfo.address);
                }
            } else if (msg.toString().match(/^(NOTIFY) \* HTTP\/1.\d/)) {
                //@todo
            }
        }
    );
    socket.bind(1900, BIND, function () {
        socket.addMembership(MULTICAST_IP);
        adapter.log.debug("listening on " + BIND + ":1900");
    });
}

function stopDiscovery() {
    if (socket && socket._bindState) socket.close();
}

function parseCommand(command) {
    var m;
    if (m = command.match(/^\/([^\/]+)\/(\S+)$/)) {
        switch (m[1]) {
            case "keypress":
                //key is pressed once => set state to true for 50ms
                setState("key", m[2].replace(".", "_"), true, function (err) {
                    if (err) return;
                    setTimeout(function () {
                        setState("key", m[2].replace(".", "_"), false);
                    }, 50);
                });
                break;
            case "keydown":
                //key is pressed => set state to true
                setState("key", m[2].replace(".", "_"), true);
                break;
            case "keyup":
                //key is released => set state to false
                setState("key", m[2].replace(".", "_"), false);
                break;
            case "launch":
                //launch app => set state to true for 50ms
                setState("launch", m[2].replace(".", "_"), true, function (err) {
                    if (err) return;
                    setTimeout(function () {
                        setState("key", m[2].replace(".", "_"), false);
                    }, 50);
                });
                break;
            case "install":
                //install app => set state to true for 50ms
                setState("install", m[2].replace(".", "_"), true, function (err) {
                    if (err) return;
                    setTimeout(function () {
                        setState("key", m[2].replace(".", "_"), false);
                    }, 50);
                });
                break;
            default:
                adapter.log.debug("unknown command: " + command);
        }
    } else {
        adapter.log.debug("unknown command: " + command);
    }
}

function parseQuery(query) {
    var message = "";
    //@todo
    return message;
}

function setState(channel, state, val, callback) {
    var id = channel + "." + state;
    if (objects[id]) {
        adapter.log.debug('state cached -> writing value');
        adapter.setState(id, {val: val, ack: true});
        if (typeof callback === 'function') callback();
    } else {
        adapter.getObject(id, function (err, obj) {
            if (err) {
                adapter.log.debug(err);
                if (typeof callback === 'function') callback(err);
                return;
            }
            if (!obj) {
                adapter.log.debug('creating new state');
                //create object first
                adapter.createState('', channel, state, {
                    name:   state,
                    def:    false,
                    type:   'boolean',
                    read:   'true',
                    write:  'false',
                    role:   'indicator.state',
                }, {
                    url: channel + "/" + state,
                }, function () {
                    adapter.log.debug('created new state -> writing value');
                    adapter.setState(id, {val: val, ack: true});
                    objects[id] = true;
                    if (typeof callback === 'function') callback();
                });
                return;
            }
            adapter.log.debug('state found -> writing value');
            adapter.setState(id, {val: val, ack: true});
            objects[id] = true;
            if (typeof callback === 'function') callback();
        });
    }
}

function getUUID() {
    var crypto = require('crypto');
    var uuid = crypto.createHash('md5').update(crypto.randomBytes(256)).digest("hex");
    var obj = {
        native: {
            UUID: uuid
        }
    };
    adapter.extendForeignObject('system.adapter.fakeroku.' + adapter.instance, obj);
    return uuid;
}

