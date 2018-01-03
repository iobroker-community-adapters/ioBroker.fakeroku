/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

var dgram = require('dgram');
var http = require('http');
var httpHeaders = require('http-headers');

var utils =    require(__dirname + '/lib/utils'); // Get common adapter utils
var adapter = utils.Adapter('fakeroku');
var configChanged = false;

var MULTICAST_IP;
var BIND;
var socket;

var devices = {};
var devArray = [];

adapter.on('unload', function (callback) {
    try {
        adapter.log.info('cleaned everything up...');
        stopDiscovery();
        for (let j = 0; j < devArray.length; j++) {
            stopServer(devArray[j]);
        }
        callback();
    } catch (e) {
        callback();
    }
});

adapter.on('ready', function () {
    init();
});

function init() {
    MULTICAST_IP = adapter.config.MULTICAST_IP || "239.255.255.250";
    BIND = adapter.config.BIND || "0.0.0.0";

    for (var i = 0; i < adapter.config.devices.length; i++) {
        var dev = adapter.config.devices[i];
        var UUID = dev.uuid || genUUID(dev.name);
        var HTTP_PORT = Math.min(65535, Math.max(0, parseInt(dev.port, 10) || 9093));
        var SSDP_RESPONSE = new Buffer(
            "HTTP/1.1 200 OK\r\nCache-Control: max-age=300\r\nST: roku:ecp\r\nUSN: uuid:roku:ecp:" +
            UUID + "\r\nExt: \r\nServer: Roku UPnP/1.0 MiniUPnPd/1.4\r\nLOCATION: http://" +
            BIND + ":" + HTTP_PORT + "/\r\n\r\n"
        );
        var DESCXML = `<?xml version="1.0" encoding="UTF-8" ?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <device>
    <deviceType>urn:roku-com:device:player:1-0</deviceType>
    <friendlyName>${dev.name}</friendlyName>
    <manufacturer>Pmant</manufacturer>
    <manufacturerURL>https://github.com/Pmant/</manufacturerURL>
    <modelDescription>ioBroker fake Roku player</modelDescription>
    <modelName>${dev.name}</modelName>
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
        var APPSXML = `<apps>
  <app id="11">Roku Channel Store</app>
  <app id="12">Netflix</app>
  <app id="13">Amazon Video on Demand</app>
  <app id="837">YouTube</app>
  <app id="2016">Crackle</app>
  <app id="3423">Rdio</app>
  <app id="21952">Blockbuster</app>
  <app id="31012">MGO</app>  
  <app id="43594">CinemaNow</app>
  <app id="46041">Sling TV</app>
  <app id="50025">GooglePlay</app>
</apps>`;
        devices[dev.name.replace(/[.\s]+/g, '_')] = {
            UUID: UUID,
            HTTP_PORT: HTTP_PORT,
            SSDP_RESPONSE: SSDP_RESPONSE,
            DESCXML: DESCXML,
            APPSXML: APPSXML,
            server: null,
            objects: [],
            sync: false
        };
        devArray.push(dev.name.replace(/[.\s]+/g, '_'));
    }
    //sync devices and channels
    adapter.getDevices(function (err, devs) {
        for (let d = 0; d < devs.length; d++) {
            //delete old device
            if (!devices[devs[d].common.name]) {
                adapter.deleteDevice(devs[d].common.name);
                adapter.log.debug('deleting old device ' + devs[d]._id);
            } else {
                devices[devs[d].common.name].sync = true;
                adapter.log.debug('found device ' + devs[d]._id);
            }
        }

        // create device and channels for new devices
        var devCreate = [];
        for (let j = 0; j < devArray.length; j++) {
            if (!devices[devArray[j]].sync) {
                devCreate.push(devArray[j]);
            }
        }

        if (devCreate.length) {
            for (let k = 0; k < devCreate.length; k++) {
                if (k === devCreate.length - 1) {
                    createDevice(devCreate[k], true);
                } else {
                    createDevice(devCreate[k], false);
                }
            }
        } else {
            if (configChanged) {
                updateConfig();
            }
            main();
        }
    });
}

function createDevice(device, last) {
    adapter.log.debug("creating device: " + device);
    adapter.createDevice(device, {name: device}, function () {
        adapter.log.debug("creating channels for " + device);
        adapter.createChannel(device, 'keys', {name: 'keys'}, function () {
            adapter.createChannel(device, 'apps', {name: 'apps'}, function () {
                devices[device].sync = true;
                if (last) main();
            });
        });
    });
}

function main() {
    for (let j = 0; j < devArray.length; j++) {
        startServer(devArray[j]);
    }
    startDiscovery();
}

function startServer(device, callback) {
    devices[device].server = http.createServer(function (request, response) {
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
                response.end(devices[device].DESCXML, function () {
                    request.connection.unref();
                });
            } else {
                if (method === "GET") {
                    var message = parseQuery(device, url);
                    response.statusCode = 200;
                    response.setHeader('Content-Type', 'text/xml; charset=utf-8');
                    response.setHeader('Connection', 'close');
                    adapter.log.debug("responding to get request");
                    response.end(message, function () {
                        request.connection.unref();
                    });
                } else {
                    parseCommand(device, url);
                    response.end(function () {
                        request.connection.unref();
                    });
                }
            }
        });
    });
    devices[device].server.on('connection', function (socket) {
        socket.unref();
    });
    devices[device].server.on("error", function (err) {
        adapter.log.error(err);
        stopServer(device);
    });
    devices[device].server.listen(devices[device].HTTP_PORT, BIND, function () {
        adapter.log.debug("HTTP-Server started on " + BIND + ":" + devices[device].HTTP_PORT);
    });
    if (typeof callback === 'function') callback();
}

function stopServer(device) {
    if (devices[device].server) devices[device].server.close();
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
                    adapter.log.debug("responding to " + rinfo.address + ":" + rinfo.port);
                    for (let j = 0; j < devArray.length; j++) {
                        socket.send(devices[devArray[j]].SSDP_RESPONSE, 0, devices[devArray[j]].SSDP_RESPONSE.length, rinfo.port, rinfo.address);
                    }
                }
            } else if (msg.toString().match(/^(NOTIFY) \* HTTP\/1.\d/)) {
                //@todo
            }
        }
    );
    socket.bind(1900, "0.0.0.0", function () {
        socket.addMembership(MULTICAST_IP);
        adapter.log.debug("listening on 0.0.0.0:1900");
    });
}

function stopDiscovery() {
    if (socket && socket._bindState) socket.close();
}

function parseCommand(device, command) {
    var m;
    if (m = command.match(/^\/([^\/]+)\/(\S+)$/)) {
        switch (m[1]) {
            case "keypress":
                //key is pressed once => set state to true for 50ms
                setState(device, "keys", m[2].replace(".", "_"), true, function (err) {
                    if (err) return;
                    setTimeout(function () {
                        setState(device, "keys", m[2].replace(".", "_"), false);
                    }, 50);
                });
                break;
            case "keydown":
                //key is pressed => set state to true
                setState(device, "keys", m[2].replace(".", "_"), true);
                break;
            case "keyup":
                //key is released => set state to false
                setState(device, "keys", m[2].replace(".", "_"), false);
                break;
            case "launch":
                //launch app => set state to true for 50ms
                setState(device, "apps", m[2].replace(".", "_"), true, function (err) {
                    if (err) return;
                    setTimeout(function () {
                        setState(device, "apps", m[2].replace(".", "_"), false);
                    }, 50);
                });
                break;
            case "install":
                //install app => set state to true for 50ms
                setState(device, "apps", m[2].replace(".", "_"), true, function (err) {
                    if (err) return;
                    setTimeout(function () {
                        setState(device, "apps", m[2].replace(".", "_"), false);
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

function parseQuery(device, query) {
    var message = "";
    switch (query) {
        case "/query/apps":
            message = devices[device].APPSXML;
            break;
        default:
            break;
    }
    return message;
}

function setState(device, channel, state, val, callback) {
    var id = device + "." + channel + "." + state;
    if (devices[device].objects[id]) {
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
                adapter.createState(device, channel, state, {
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
                    devices[device].objects[id] = true;
                    if (typeof callback === 'function') callback();
                });
                return;
            }
            adapter.log.debug('state found -> writing value');
            adapter.setState(id, {val: val, ack: true});
            devices[device].objects[id] = true;
            if (typeof callback === 'function') callback();
        });
    }
}

function genUUID(device) {
    var crypto = require('crypto');
    var uuid = crypto.createHash('md5').update(crypto.randomBytes(256)).digest("hex");
    for (var i = 0; i < adapter.config.devices.length; i++) {
        if (adapter.config.devices[i].name === device) {
            adapter.config.devices[i].uuid = uuid;
        }
    }
    configChanged = true;
    return uuid;
}

function updateConfig() {
    adapter.getForeignObject('system.adapter.fakeroku.' + adapter.instance, function (err, obj) {
        if (err || !obj) {
            adapter.log.warn("adapter config object not found!");
            return;
        }
        obj.native = adapter.config;
        adapter.log.debug("updating config with new uuid");
        adapter.setForeignObject('system.adapter.fakeroku.' + adapter.instance, obj, function () {
            
        });
    });
}

