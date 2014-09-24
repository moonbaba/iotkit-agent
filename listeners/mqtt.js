/*
Copyright (c) 2014, Intel Corporation

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Neither the name of Intel Corporation nor the names of its contributors
      may be used to endorse or promote products derived from this software
      without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

var mqtt = require('mqtt'),
    fs = require('fs'),
    common = require('../lib/common'),
    utils = require("../lib/utils").init(),
    crypto = require('crypto'),
    path = require("path");

/**
 * @description Build a path replacing patter {} by the data arguments
 * if more the one {} pattern is present it shall be use Array
 * @param path string the represent a URL path
 * @param data Array or string,
 * @returns {*}
 */
var buildPath = function (path, data) {
    var re = /{\w+}/;
    var pathReplace = path;
    if (Array.isArray(data)) {
        data.forEach(function (value) {
            pathReplace = pathReplace.replace(re, value);
        });
    } else {
        pathReplace = pathReplace.replace(re, data);
    }
    return pathReplace;
};

exports.init = function(conf, logger, onMessage, deviceId) {

  var mqttServerPort = conf.listeners.mqtt_port || 1883;

  var filename = conf.token_file || "token.json";
  var fullFilename = path.join(__dirname, '../certs/' +  filename);
  var secret = { };
    if (fs.existsSync(fullFilename)) {
        secret = common.readFileToJson(fullFilename);
    } else {
        //consider from system folder /usr/share/iotkit-agent/certs
        fullFilename = '/usr/share/iotkit-agent/certs/' +  filename;
        secret = common.readFileToJson(fullFilename);
    }

  var metric_topic = conf.connector.mqtt.topic.metric_topic || "server/metric/{accountid}/{gatewayid}";

  var connOptions = {
        username: '',
        password: secret.deviceToken,
        clientId: ''
  };
    utils.getDeviceId(function (id) {
//        logger.info("My OWN Device ID: %s", id);
        connOptions.username = id;
    });



  var mqttServer = mqtt.createServer(function(client) {

      // store the client objects created for subscription and their topics
      var self = this;
      if (!self.clients) self.clients = {};

    client.on('connect', function(packet) {
      client.connack({returnCode: 0});
      client.id = packet.clientId;
      logger.debug('MQTT Client connected: ', packet.clientId);
    });

    client.on('publish', function(packet) {
      logger.debug('MQTT Topic: %s Payload: %s', packet.topic, packet.payload);
      try {
        onMessage(JSON.parse(packet.payload));
      } catch (ex) {
        logger.error('MQTT Error on message: %s', ex);
      }
  });

    client.on('subscribe', function(packet) {
        try {
            // create a new client object to the new online broker
            // subscribe

            var newclient;
            var topic = packet.subscriptions[0].topic;

            var granted = [];
            for (var i = 0; i < packet.subscriptions.length; i++) {
                granted.push(packet.subscriptions[i].qos);
            }

            // create unique client IDs for each subscription
            connOptions.clientId = "mqttjs_client_" + crypto.randomBytes(8).toString('hex');
            if(conf.connector.mqtt.secure){
                self.clients[client.id + '_sub'] = mqtt.createSecureClient(conf.connector.mqtt.port, conf.connector.mqtt.host, connOptions);
            } else {
                self.clients[client.id + '_sub'] = mqtt.createClient(conf.connector.mqtt.port, conf.connector.mqtt.host, connOptions);
            }

            if(topic === '' || topic === 'data'){
                self.clients[client.id + '_sub_topic'] = buildPath(metric_topic, [secret.accountId, deviceId]);
                self.clients[client.id + '_sub'].subscribe(buildPath(metric_topic, [secret.accountId, deviceId]));
                logger.info('Subscribed to topic:' + buildPath(metric_topic, [secret.accountId, deviceId]));
            } else {
                // subscribe to another device under the same account
                self.clients[client.id + '_sub_topic'] = buildPath(metric_topic, [secret.accountId, topic]);
                self.clients[client.id + '_sub'].subscribe(buildPath(metric_topic, [secret.accountId, topic]));
                logger.info('Subscribed to topic:' + buildPath(metric_topic, [secret.accountId, topic]));
            }

            client.suback({granted: granted, messageId: packet.messageId});

            self.clients[client.id + '_sub'].on('message', function (topic, message) {
                logger.debug('Received a message on subscribed topic: ' + topic);
                client.publish({"topic": topic, "payload": message});
            });
        } catch (ex) {
            logger.error('Error on message: %s', ex.message);
            logger.error(ex.stack);
        }
    });

    client.on('pingreq', function() {
      client.pingresp();
    });

    client.on('disconnect', function() {
        // remove subscription topic and subscription client
        if(self.clients[client.id + '_sub_topic']) {
            self.clients[client.id + '_sub'].unsubscribe(self.clients[client.id + '_sub_topic'], console.log);
            delete self.clients[client.id + '_sub_topic'];

            self.clients[client.id + '_sub'].end();
            delete self.clients[client.id + '_sub'];
        }

      client.stream.end();
    });

      client.on('close', function(err) {
          // remove subscription topic and subscription client
          if(self.clients[client.id + '_sub_topic']) {
              self.clients[client.id + '_sub'].unsubscribe(self.clients[client.id + '_sub_topic'], console.log);
              delete self.clients[client.id + '_sub_topic'];

              self.clients[client.id + '_sub'].end();
              delete self.clients[client.id + '_sub'];
          }
      });

    client.on('error', function(err) {
        //client.stream.end();
        logger.error('MQTT Error: ', err);

        // remove subscription topic and subscription client
        if(self.clients[client.id + '_sub_topic']) {
            self.clients[client.id + '_sub'].unsubscribe(self.clients[client.id + '_sub_topic'], console.log);
            delete self.clients[client.id + '_sub_topic'];

            self.clients[client.id + '_sub'].end();
            delete self.clients[client.id + '_sub'];
        }

        client.stream.end();
    });

  }).listen(mqttServerPort);

  logger.info("MQTT listener started on port: ", mqttServerPort);

  return mqttServer;

};


