var EventEmitter = require('events').EventEmitter
  , util = require('util')
  , assert = require('assert')
  , net = require('net')
  , MPD_SENTINEL = /^(OK|ACK|list_OK)(.*)$/m
  , OK_MPD = /^OK MPD /

module.exports = MpdClient;
MpdClient.Command = Command
MpdClient.cmd = cmd;
MpdClient.parseKeyValueMessage = parseKeyValueMessage;
MpdClient.parseArrayMessage = parseArrayMessage;

MpdClient.ACK_ERROR_CODES = {
  NOT_LIST: 1,
  ARG: 2,
  PASSWORD: 3,
  PERMISSION: 4,
  UNKNOWN: 5,

  NO_EXIST: 50,
  PLAYLIST_MAX: 51,
  SYSTEM: 52,
  PLAYLIST_LOAD: 53,
  UPDATE_ALREADY: 54,
  PLAYER_SYNC: 55,
  EXIST: 56
};

MpdClient.ACK_ERROR_CODES_REVERSED = Object
  .keys(MpdClient.ACK_ERROR_CODES)
  .reduce((memo, reason) => {
    memo[MpdClient.ACK_ERROR_CODES[reason]] = reason
    return memo
  }, {})


function MpdClient() {
  EventEmitter.call(this);

  this.buffer = "";
  this.msgHandlerQueue = [];
  this.idling = false;
}
util.inherits(MpdClient, EventEmitter);

var defaultConnectOpts = {
  host: 'localhost',
  port: 6600
}

MpdClient.connect = function(options) {
  options = options || defaultConnectOpts;
  
  var client = new MpdClient();
  client.socket = net.connect(options, function() {
    client.emit('connect');
  });
  client.socket.setEncoding('utf8');
  client.socket.on('data', function(data) {
    client.receive(data);
  });
  client.socket.on('close', function() {
    client.emit('end');
  });
  client.socket.on('error', function(err) {
    client.emit('error', err);
  });
  return client;
}

MpdClient.prototype.receive = function(data) {
  var m;
  this.buffer += data;
  while (m = this.buffer.match(MPD_SENTINEL)) {
    var msg = this.buffer.substring(0, m.index)
      , line = m[0]
      , code = m[1]
      , str = m[2]
    if (code === "ACK") {
      var err = new Error(str);
      
      // add error code and cmd to
      // the Error
      var err_code = str.match(/\[(.*?)\]/)
      var err_cmd = str.match(/{(.*?)}/)

      if(err_code && err_code.length > 1) {
        err_code = err_code[1].split('@')
        err.err_code = parseInt(err_code[0])
        err.err_list_num = parseInt(err_code[1])

      }
      if(err_cmd && err_cmd.length > 1)
        err.err_cmd = err_cmd[1]

      err.code = MpdClient.ACK_ERROR_CODES_REVERSED[err.err_code] || 'ERR'


      this.handleMessage(err);
    } else if (OK_MPD.test(line)) {
      this.setupIdling();
    } else {
      this.handleMessage(null, msg);
    }

    this.buffer = this.buffer.substring(msg.length + line.length + 1);
  }
};

MpdClient.prototype.handleMessage = function(err, msg) {
  var handler = this.msgHandlerQueue.shift();
  handler(err, msg);
};

MpdClient.prototype.setupIdling = function() {
  var self = this;
  self.sendWithCallback("idle", function(err, msg) {
    self.handleIdleResultsLoop(err, msg);
  });
  self.idling = true;
  self.emit('ready');
};

MpdClient.prototype.sendCommand = function(command, callback) {
  var self = this;
  callback = callback || noop.bind(this);
  assert.ok(self.idling);
  self.send("noidle\n");
  self.sendWithCallback(command, callback);
  self.sendWithCallback("idle", function(err, msg) {
    self.handleIdleResultsLoop(err, msg);
  });
};

MpdClient.prototype.sendCommands = function(commandList, callback) {
  var fullCmd = "command_list_begin\n" + commandList.join("\n") + "\ncommand_list_end";
  this.sendCommand(fullCmd, callback || noop.bind(this));
};

MpdClient.prototype.handleIdleResultsLoop = function(err, msg) {
  var self = this;
  if (err) {
    self.emit('error', err);
    return;
  }
  self.handleIdleResults(msg);
  if (self.msgHandlerQueue.length === 0) {
    self.sendWithCallback("idle", function(err, msg) {
      self.handleIdleResultsLoop(err, msg);
    });
  }
};

MpdClient.prototype.handleIdleResults = function(msg) {
  var self = this;
  msg.split("\n").forEach(function(system) {
    if (system.length > 0) {
      var name = system.substring(9);
      self.emit('system-' + name);
      self.emit('system', name);
    }
  });
};

MpdClient.prototype.sendWithCallback = function(cmd, cb) {
  cb = cb || noop.bind(this);
  this.msgHandlerQueue.push(cb);
  this.send(cmd + "\n");
};

MpdClient.prototype.send = function(data) {
  this.socket.write(data);
};

function Command(name, args) {
  this.name = name;
  this.args = args;
}

Command.prototype.toString = function() {
  return this.name + " " + this.args.map(argEscape).join(" ");
};

function argEscape(arg){
  // replace all " with \"
  return '"' + arg.toString().replace(/"/g, '\\"') + '"';
}

function noop(err) {
  if (err) this.emit('error', err);
}

// convenience
function cmd(name, args) {
  return new Command(name, args);
}

function parseKeyValueMessage(msg) {
  var result = {};

  msg.split('\n').forEach(function(p){
    if(p.length === 0) {
      return;
    }
    var keyValue = p.match(/([^ ]+): (.*)/);
    if (keyValue == null) {
      throw new Error('Could not parse entry "' + p + '"')
    }
    result[keyValue[1]] = keyValue[2];
  });
  return result;
}

function parseArrayMessage(msg) {
  var results = [];
  var obj = {};

  msg.split('\n').forEach(function(p) {
    if(p.length === 0) {
      return;
    }
    var keyValue = p.match(/([^ ]+): (.*)/);
    if (keyValue == null) {
      throw new Error('Could not parse entry "' + p + '"')
    }

    if (obj[keyValue[1]] !== undefined) {
      results.push(obj);
      obj = {};
      obj[keyValue[1]] = keyValue[2];
    }
    else {
      obj[keyValue[1]] = keyValue[2];
    }
  });
  results.push(obj);
  return results;
}


/**
 * There is a problem with the default parseArrayMessage method
 * when parsing song list. If mpd returns
 * MUSICBRAINS_TRACKID: xxx
 * for same song two times (which can be valid as it's found 2 times
 * for the same song) then default parseArrayMessage breaks and
 * returns corrupted entries.
 * Since all songs begin with `file:`
 * this one fits better for song list parsing.
 */
function parseSongArrayMessage(msg) {
  let results = []
  let obj

  msg.split('\n').forEach(p => {
    if (p.length === 0) {
      return
    }
    let keyValue = p.match(/([^ ]+): (.*)/)
    if (keyValue == null) {
      throw new Error('Could not parse entry "' + p + '"')
    }

    let isnew = keyValue[1].toLowerCase().trim() === 'file'
    if (isnew) {
      if (obj) results.push(obj)
      obj = {}
      obj[keyValue[1]] = keyValue[2]
    } else {
      obj[keyValue[1]] = keyValue[2]
    }
  })

  if (obj) results.push(obj)
  return results
}
