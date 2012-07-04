var net = require('net'),
    util = require('util'),
    EventEmitter = require('events').EventEmitter,
    crypto = require('crypto');
var fnEmpty = function() {};
var debug = fnEmpty, hexy, inspectMutated = false,
    hexyFormat = {
      caps: 'upper',
      format: 'twos',
      numbering: 'none',
      groupSpacing: 2
    };

function OscarConnection(options) {
  if (!(this instanceof OscarConnection))
    return new OscarConnection(options);
  EventEmitter.call(this);

  this._options = {
    connection: {
      username: '',
      password: '',
      host: SERVER_AOL,
      port: 5190,
      connTimeout: 10000, // connection timeout in msecs
      allowMultiLogin: true,
      debug: false
    }, other: {
      initialStatus: USER_STATUSES.ONLINE,
      initialFlags: USER_FLAGS.DCDISABLED
    }
  };
  this._options = extend(true, this._options, options);
  if (typeof this._options.connection.debug === 'function') {
    debug = this._options.connection.debug;
    if (!inspectMutated) {
      inspectMutated = true;
      hexy = require('./hexy').hexy;
      Buffer.prototype.inspect = function () {
        return hexy(this, hexyFormat);
      };
    }
  }
  this._state = {
    connections: {},
    serviceMap: {},
    reqID: 0, // 32-bit number that identifies a single SNAC request
    status: this._options.other.initialStatus,
    flags: this._options.other.initialFlags,
    requests: {},
    isAOL: (this._options.connection.host.substr(this._options.connection.host.length-7).toUpperCase() === 'AOL.COM'),
    rateLimitGroups: {},
    rateLimits: {},
    svcInfo: {},
    svcPaused: {},
    SSI: {},
    iconQueue: {},
    rndvCookies: { out: {}, in: {} },
    chatrooms: {},
    p2p: {}
  };

  this.icon = { datetime: undefined, data: undefined }; // my 'buddy' icon
  this.me = undefined;
  this.contacts = { lastModified: undefined, list: undefined, permit: undefined, deny: undefined, prefs: undefined, _totalSSICount: 0, _usedIDs: {} };
}
util.inherits(OscarConnection, EventEmitter);

// setIdle only needs to be called once when you are idle and again when you are no longer idle.
// The server will automatically increment the idle time for you, so don't call setIdle every second
// or the evil AOL wizards will come for you!
// Just kidding about the wizards, but it will make OSCAR do funny things.
OscarConnection.prototype.setIdle = function(amount) { // amount is in seconds if an integer is supplied, false disables the idle state
  if (typeof amount === 'boolean' && !amount)
    amount = 0;
  else if (typeof amount !== 'number' || amount <= 0 || amount === true)
    throw new Error('Amount must be boolean false or a positive number > 0');

  this._send(this._createFLAP(this._state.connections.main, FLAP_CHANNELS.SNAC,
    this._createSNAC(SNAC_SERVICES.GENERIC, 0x11, NO_FLAGS,
      [(amount >> 24 & 0xFF), (amount >> 16 & 0xFF), (amount >> 8 & 0xFF), (amount & 0xFF)]
    )
  ));
};

OscarConnection.prototype.sendIM = function(who, message, flags, cb) {
  var msgData, cookie, msgLen, self = this, features = (self._state.isAOL ? [0x01, 0x01, 0x01, 0x02] : [0x01]),
      featLen = features.length, charset = ICBM_MSG_CHARSETS.ASCII, isSMS;
  cb = arguments[arguments.length-1];
  if (typeof flags !== 'number')
    flags = 0x00000000;
  if (typeof who === 'object')
    who = who.name;
  isSMS = /\+[\d]+/.test(who);

  if (isSMS && !self._state.isAOL) {
   var uin = parseInt(this._options.connection.username), len, data,
       req = str2bytes('<icq_sms_message><destination>' + who + '</destination><text>' + message + '</text>'
                       + '<codepage>1252</codepage><senders_UIN>' + uin + '</senders_UIN>'
                       + '<senders_name>' + this.me.fullname + '</senders_name>'
                       + '<delivery_receipt>' + (typeof cb === 'function' ? 'Yes' : 'No') + '</delivery_receipt>'
                       + '<time>' + (new Date).toUTCString() + '</time>'
                       + '</icq_sms_message>');
    data = splitNum(uin, 4).reverse().concat([
      0xD0, 0x07,  (this._state.reqID & 0xFF) << 8, (this._state.reqID >> 8 & 0xFF),  0x82, 0x14,
      0x00, 0x01, 0x00, 0x16, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      (req.length >> 8 & 0xFF), (req.length & 0xFF)
    ]).concat(req);
    data.push(0x00);
    len = data.length;
    data.unshift(len >> 8 & 0xFF);
    data.unshift(len & 0xFF);

    self._send(self._createFLAP(self._state.serviceMap[SNAC_SERVICES.ICQ_EXT], FLAP_CHANNELS.SNAC,
      self._createSNAC(SNAC_SERVICES.ICQ_EXT, 0x02, NO_FLAGS,
        self._createTLV(0x01, data)
      )
    ), cb);
    return;
  } else if (isSMS && (flags & ICBM_MSG_FLAGS.OFFLINE))
    flags -= ICBM_MSG_FLAGS.OFFLINE;

  cookie = splitNum(Date.now(), 4).concat(splitNum(Date.now()+1, 4));

  who = str2bytes(who);
  if (who.length > MAX_SN_LEN) {
    var err = new Error('Screen names cannot be longer than ' + MAX_SN_LEN + ' characters');
    if (typeof cb === 'function')
      cb(err);
    else
      throw err;
    return;
  }

  message = str2bytes(''+message);
  if (message.length > MAX_MSG_LEN) {
    // TODO: try stripping message of any HTML to see if it then fits within the length limit
    var err = new Error('IM messages cannot be longer than ' + MAX_MSG_LEN + ' characters');
    if (typeof cb === 'function')
      cb(err);
    else
      throw err;
    return;
  }

  msgLen = message.length + 4;
  msgData = [0x05, 0x01,  (featLen >> 8 & 0xFF), (featLen & 0xFF)]
            .concat(features)
            .concat([0x01, 0x01, (msgLen >> 8 & 0xFF), (msgLen & 0xFF),
                     (charset >> 8 & 0xFF), (charset & 0xFF), 0x00, 0x00]);
  var content = cookie.concat([0x00, 0x01, who.length])
                      .concat(who)
                      .concat(self._createTLV(0x02, msgData.concat(message)));

  if (flags & ICBM_MSG_FLAGS.AWAY)
    content = content.concat(self._createTLV(0x04));
  else {
    // request that the server send us an ACK that the message was sent ok,
    // but not necessarily immediately received by the destination user (i.e. they are offline)
    if (typeof cb === 'function')
      content = content.concat(self._createTLV(0x03));
    if (flags & ICBM_MSG_FLAGS.OFFLINE)
      content = content.concat(self._createTLV(0x06));
  }
  if (flags & ICBM_MSG_FLAGS.REQ_ICON)
    content = content.concat(self._createTLV(0x09));

  self._send(self._createFLAP(self._state.connections.main, FLAP_CHANNELS.SNAC,
    self._createSNAC(SNAC_SERVICES.ICBM, 0x06, NO_FLAGS,
      content
    )
  ), cb);
};

OscarConnection.prototype.setProfile = function(text) {
  var self = this, maxProfileLen = self._state.svcInfo[SNAC_SERVICES.LOCATION].maxProfileLen;
  if (text.length > maxProfileLen)
    throw new Error('Profile text cannot exceed max profile length of ' + maxProfileLen + ' characters');
  self._send(self._createFLAP(self._state.connections.main, FLAP_CHANNELS.SNAC,
    self._createSNAC(SNAC_SERVICES.LOCATION, 0x04, NO_FLAGS,
              self._createTLV(0x01, str2bytes('text/aolrtf; charset="us-ascii"'))
      .concat(self._createTLV(0x02, str2bytes(text)))
    )
  ));
};

OscarConnection.prototype.warn = function(who, isAnonymous, cb) {
  isAnonymous = (typeof isAnonymous !== 'boolean' ? true : isAnonymous);
  cb = arguments[arguments.length-1];
  if (self._state.isAOL) {
    var msgLen, self = this;
    who = str2bytes(''+who);
    if (who.length > MAX_SN_LEN) {
      var err = new Error('Screen names cannot be longer than ' + MAX_SN_LEN + ' characters');
      if (typeof cb === 'function')
        cb(err);
      else
        throw err;
      return;
    }
    self._send(self._createFLAP(self._state.connections.main, FLAP_CHANNELS.SNAC,
      self._createSNAC(SNAC_SERVICES.ICBM, 0x08, NO_FLAGS,
        [0x00, (isAnonymous ? 0x01 : 0x00), who.length].concat(who)
      )
    ), function(e, gain, newLevel) { if (typeof cb === 'function') cb(e, gain, newLevel); });
  } else {
    var err = new Error('Warn feature only available on AOL');
    if (typeof cb === 'function')
      cb(err);
    else
      throw err;
  }
};

OscarConnection.prototype.notifyTyping = function(who, which) {
  who = str2bytes(''+who);
  if (who.length > MAX_SN_LEN)
    throw new Error('Screen names cannot be longer than ' + MAX_SN_LEN + ' characters');

  var notifyType = [0x00];
  if (typeof which !== 'undefined')
    notifyType.push((which ? 0x02 : 0x00));
  else
    notifyType.push(0x01);

  self._send(self._createFLAP(self._state.connections.main, FLAP_CHANNELS.SNAC,
    self._createSNAC(SNAC_SERVICES.ICBM, 0x14, NO_FLAGS,
      [0x00, 0x00, 0x00, 0x00,  0x00, 0x00, 0x00, 0x00,  0x00, 0x01,  who.length]
      .concat(who)
      .concat(notifyType)
    )
  ));
};

OscarConnection.prototype.addContact = function(who, group, cb) {
  var self = this, check, err, record, skipTrans = (typeof arguments[arguments.length-1] === 'boolean'), contactCount = 0;
  cb = (typeof group === 'function' ? group : cb);

  for (var i=0,groups=Object.keys(self.contacts.list),len=groups.length; i<len; i++)
    contactCount += Object.keys(self.contacts.list[groups[i]].contacts).length;
  if (contactCount < self._state.svcInfo[SNAC_SERVICES.SSI].maxContacts) {
    record = (typeof who !== 'object' ? { name: '' } : who);
    if (typeof group !== 'function')
      record.group = group;
    if (typeof who === 'string')
      record.name = who;

    check = self._SSIFindContact(record.group, record.name);
    if (check[1] > -1)
      err = 'That contact already exists';
    else if (check[0] === -1)
      err = 'Group not found';
  } else
    err = 'Maximum number of contacts reached';
  if (err) {
    err = new Error(err);
    if (typeof cb === 'function')
      cb(err);
    else
      throw err;
    return;
  }

  record.type = 0x00;
  record.group = check[0];
  record.item = -1;

  if (!skipTrans)
    self._SSIStartTrans();
  self._SSIModify(record, 0, function(e) {
    if (e) {
      if (!skipTrans)
        self._SSIEndTrans();
      if (typeof cb === 'function')
        cb(e);
      return;
    }
    self.contacts.list[record.group].contacts[record.item] = record;
    self._SSIModify(self.contacts.list[record.group], 2, function(e) {
      if (!skipTrans)
        self._SSIEndTrans();
      if (!e)
        self.contacts._usedIDs[record.group][record.item] = true;
      if (typeof cb === 'function')
        cb(e);
    });
  });
};

OscarConnection.prototype.delContact = function(who, group, cb) {
  var self = this, check, record, skipTrans = (typeof arguments[arguments.length-1] === 'boolean');
  cb = (typeof group === 'function' ? group : cb);

  record = (typeof who !== 'object' ? { name: '' } : who);
  record.group = (typeof group !== 'function' ? group : undefined);
  if (typeof who === 'string')
    record.name = who;

  check = self._SSIFindContact(record.group, record.name);
  if (check[1] === -1) {
    var err = new Error('That contact doesn\'t exists');
    if (typeof cb === 'function')
      cb(err);
    else
      throw err;
    return;
  }

  record.type = 0x00;
  record.group = check[0];
  record.item = check[1];

  if (!skipTrans)
    self._SSIStartTrans();
  self._SSIModify(record, 1, function(e) {
    if (e) {
      if (!skipTrans)
        self._SSIEndTrans();
      if (typeof cb === 'function')
        cb(e);
      return;
    }
    delete self.contacts.list[record.group].contacts[record.item];
    self._SSIModify(self.contacts.list[record.group], 2, function(e) {
      if (!skipTrans)
        self._SSIEndTrans();
      if (!e)
        delete self.contacts._usedIDs[record.group][record.item];
      if (typeof cb === 'function')
        cb(e);
    });
  });
};

OscarConnection.prototype.moveContact = function(who, newGroup, cb) {
  var self = this, check, err, record;
  cb = arguments[arguments.length-1];

  if (typeof who !== 'object')
    record = { name: '' };
  if (typeof who === 'string')
    record.name = who;

  check = self._SSIFindContact(record.group, record.name);
  newGroup = self._SSIFindGroup(newGroup);
  if (check[1] === -1)
    err = 'That contact doesn\'t exist';
  else if (newGroup === -1)
    err = 'Destination group not found';
  if (err) {
    err = new Error(err);
    if (typeof cb === 'function')
      cb(err);
    else
      throw err;
    return;
  }

  var contact = self.contacts.list[check[0]].contacts[check[1]];
  self.delContact(contact, function(e) {
    if (e) {
      self._SSIEndTrans();
      if (typeof cb === 'function')
        cb(e);
      return;
    }
    self.addContact(contact, newGroup, function(e) {
      self._SSIEndTrans();
      cb(e);
    }, true);
  }, true);
};

OscarConnection.prototype.addGroup = function(group, cb) {
  var self = this, check, record, err;

  if (Object.keys(self.contacts.list).length < self._state.svcInfo[SNAC_SERVICES.SSI].maxGroups) {
    record = (typeof group !== 'object' ? { name: '' } : group);
    record.item = 0x00;
    record.type = 0x01;
    if (typeof group === 'string')
      record.name = group;

    check = self._SSIFindGroup(record.name);
    if (check > -1)
      err = 'That group already exists';
  } else
    err = 'Maximum number of groups reached';
  if (err) {
    err = new Error(err);
    if (typeof cb === 'function')
      cb(err);
    else
      throw err;
    return;
  }

  record.group = -1;

  self._SSIStartTrans();
  self._SSIModify(record, 0, function(e) {
    if (e) {
      self._SSIEndTrans();
      if (typeof cb === 'function')
        cb(e);
      return;
    }
    record.contacts = {};
    self.contacts.list[record.group] = record;
    self._SSIModify(SSI_ROOT_GROUP, 2, function(e) {
      self._SSIEndTrans();
      if (!e)
        self.contacts._usedIDs[record.group] = { 0: true };
      if (typeof cb === 'function')
        cb(e);
    });
  });
};

OscarConnection.prototype.delGroup = function(group, force, cb) {
  var self = this, check, err, record;
  cb = arguments[arguments.length-1];
  if (typeof force !== 'boolean')
    force = false;

  record = (typeof group !== 'object' ? { name: '' } : group);
  record.item = 0x00;
  record.type = 0x01;
  if (typeof group === 'string')
    record.name = group;

  check = self._SSIFindGroup(record.name);
  if (check === -1)
    err = 'That group doesn\'t exist';
  else if (!force && Object.keys(self.contacts.list[check].contacts).length > 0)
    err = 'That group isn\'t empty';
  if (err) {
    err = new Error(err);
    if (typeof cb === 'function')
      cb(err);
    else
      throw err;
    return;
  }

  record.group = check;

  self._SSIStartTrans();
  var fnContinue = function() {
    self._SSIModify(record, 1, function(e) {
      if (e) {
        self._SSIEndTrans();
        if (typeof cb === 'function')
          cb(e);
        return;
      }
      delete self.contacts.list[record.group];
      self._SSIModify(SSI_ROOT_GROUP, 2, function(e) {
        self._SSIEndTrans();
        if (!e)
          delete self.contacts._usedIDs[record.group];
        if (typeof cb === 'function')
          cb(e);
      });
    });
  };
  var children = Object.keys(self.contacts.list[record.group].contacts), chlen = children.length;
  if (force && chlen > 0) {
    var contacts = [];
    for (var i=0; i<chlen; i++)
      contacts.push(self.contacts.list[record.group].contacts[children[i]]);
    self._SSIModify(contacts, 1, function(e) {
      if (e) {
        self._SSIEndTrans();
        if (typeof cb === 'function')
          cb(e);
        return;
      }
      fnContinue();
    });
  } else
    fnContinue();
};

OscarConnection.prototype.renameGroup = function(group, newName, cb) {
  var self = this, check, err, record;

  record = (typeof group !== 'object' ? { name: '' } : group);
  record.item = 0x00;
  record.type = 0x01;
  if (typeof group === 'string')
    record.name = group;

  check = self._SSIFindGroup(record.name);
  if (check === -1)
    err = 'The source group doesn\'t exist';
  else if (self._SSIFindGroup(newName) > -1)
    err = 'The destination group already exists';
  if (err) {
    err = new Error(err);
    if (typeof cb === 'function')
      cb(err);
    else
      throw err;
    return;
  }

  record.group = check;
  record.name = newName;

  self._SSIStartTrans();
  self._SSIModify(record, 2, function(e) {
    self._SSIEndTrans();
    if (!e)
      self.contacts.list[record.group].name = newName;
    if (typeof cb === 'function')
      cb(e);
  });
};

OscarConnection.prototype.getInfo = function(who, cb) {
  // requests profile, away msg, capabilities
  this._send(this._createFLAP(this._state.connections.main, FLAP_CHANNELS.SNAC,
    this._createSNAC(SNAC_SERVICES.LOCATION, 0x15, NO_FLAGS,
      [0x00, 0x00, 0x00, 0x07,  who.length]
      .concat(str2bytes(who))
    )
  ), cb);
};

OscarConnection.prototype.addDeny = function(who, cb) {
  // TODO
};

OscarConnection.prototype.delDeny = function(who) {
  // TODO
};

OscarConnection.prototype.addPermit = function(who, cb) {
  // TODO
};

OscarConnection.prototype.delPermit = function(who) {
  // TODO
};

OscarConnection.prototype.getIcon = function(who, metaData, cb) {
  var icons, self = this,
    fnGetBest = function(list) {
      var idx;
      for (var i=0,best=0; i<list.length; i++) {
        if (list[i].type > best) {
          best = list[i].type;
          idx = i;
        } else if (typeof idx === 'undefined')
          idx = i;
      }
      process.nextTick(function(){ self._downloadIcons((typeof who === 'string' ? who : who.name), list[idx], cb); });
  };
  cb = arguments[arguments.length-1];
  if (typeof metaData !== 'function')
    icons = metaData;

  if (typeof who === 'string') {
    var where = self._SSIFindContact(who);
    if (where[1] === -1 && !metaData) {
      self.getInfo(who, function(e, info) {
        if (e || !info.icons) {
          if (typeof cb === 'function')
            cb(e);
          return;
        }
        fnGetBest(info.icons);
      });
      return;
    } else if (where[1] > -1)
      icons = self.contacts.list[where[0]].contacts[where[1]].icons;
  } else if (typeof who === 'object')
    icons = who.icons;
  if (!icons) {
    if (typeof cb === 'function')
      cb(); // user has no icon set
  } else
    fnGetBest(icons);
};

OscarConnection.prototype.getOfflineMsgs = function() {
  this._send(this._createFLAP(this._state.connections.main, FLAP_CHANNELS.SNAC,
    this._createSNAC(SNAC_SERVICES.ICBM, 0x10, NO_FLAGS
    )
  ));
};

OscarConnection.prototype.joinChat = function(name, cb) {
  var self = this;
  if (!self._state.chatrooms[name]) {
    var exchange = 4;
    this._send(this._createFLAP(self._state.serviceMap[SNAC_SERVICES.CHAT_NAV], FLAP_CHANNELS.SNAC,
      this._createSNAC(SNAC_SERVICES.CHAT_NAV, 0x08, NO_FLAGS,
        [(exchange >> 8) & 0xFF, exchange & 0xFF, 0x06]
          .concat(str2bytes('create')).concat([0xFF, 0xFF, 0x01, 0x00, 0x03])
          .concat(this._createTLV(0xD3, name))
          .concat(this._createTLV(0xD6, 'us-ascii'))
          .concat(this._createTLV(0xD7, 'en'))
      )
    ), function(err, roomInfo) {
      // CHAT_NAV 0x09 activates this callback
      if (err) {
        cb(err);
        return;
      }
      this._addService(SNAC_SERVICES.CHAT, roomInfo, function(err, conn) {
        if (err) {
          cb(err);
          return;
        }
        cb();
      });
    });
  } else
    cb(new Error('You are already in that chat room'));
};

OscarConnection.prototype.inviteChat = function(name, msg, who) {
  if (this._state.chatrooms[name]) {
    if (typeof who === 'undefined') {
      who = msg;
      msg = 'Please join me in this chat';
    }
    return this._chatInvite(who, msg, this._state.chatrooms[name].roomInfo);
  } else
    return false;
};

OscarConnection.prototype.sendChatMsg = function(name, text) {
  if (this._state.chatrooms[name]) {
    var conn = this._state.chatrooms[name],
        cookie = splitNum(Date.now(), 4).concat(splitNum(Date.now()+1, 4));
    if (text.length > conn.roomInfo.maxMsgLen)
      return false;
    this._send(conn, this._createFLAP(conn, FLAP_CHANNELS.SNAC,
      this._createSNAC(SNAC_SERVICES.CHAT, 0x05, NO_FLAGS,
        cookie.concat([0x00, 0x03]) // channel
          .concat(this._createTLV(0x01)) // send to entire chat room
          .concat(this._createTLV(0x06)) // send us our own message
          .concat(this._createTLV(0x05, 
            this._createTLV(0x02, 'us-ascii')
              .concat(this._createTLV(0x03, 'en'))
              .concat(this._createTLV(0x01, str2bytes(text)))
          ))
      )
    ));
    return true;
  } else
    return false;
};

OscarConnection.prototype.leaveChat = function(name) {
  if (this._state.chatrooms[name]) {
    this._state.chatrooms[name].destroy();
    delete this._state.chatrooms[name];
    return true;
  } else
    return false;
};

OscarConnection.prototype.connect = function(cb) {
  var self = this;
  self._addConnection('login', null, self._options.connection.host, self._options.connection.port, function(e) {
    if (self._state.connections.main) {
      self._state.connections.main.authCookie = undefined;
      self._state.connections.main.rateLimitGroups = undefined;
    }
    if (e) {
      if (typeof cb === 'function')
        cb(e);
      return;
    }
    self._addService(SNAC_SERVICES.BART, function(e) {
      if (e) {
        if (typeof cb === 'function')
          cb(e);
        return;
      }
      self._addService(SNAC_SERVICES.CHAT_NAV, cb);
    });
  });
};

OscarConnection.prototype.end = function() {
  var ids = Object.keys(this._state.connections);
  for (var i=0,len=ids.length; i<len; ++i)
    this._state.connections[ids[i]].end();
  this._resetState();
};

// Connection handlers -------------------------------------------------------------------------------

function connect_handler(oscar) {
  var self = oscar, conn = this;
  conn.availServices = {};
  conn.isConnected = true;
  clearTimeout(conn.tmrConn);
  conn.restartKeepAlive();
  if (conn.isTransferring) {
    if (conn.id === 'login') {
      self._state.connections.main = self._state.connections.login;
      delete self._state.connections.login;
      conn.id = 'main';
    }
    conn.serverType = 'BOS';
    conn.isTransferring = false;
  }
  debug('(' + conn.remoteAddress + ') Connected to ' + conn.serverType + ' server');
  conn.write('');
}

function data_handler(oscar, data, cb) {
  var self = oscar, conn = this;
  //debug('(' + conn.remoteAddress + ') RECEIVED: \n' + util.inspect(data)) + '\n';
  if (conn.curData)
    conn.curData = bufferAppend(conn.curData, data);
  else
    conn.curData = data;
  data = conn.curData;

  if (data[0] === 0x2A) {
    switch (data[1]) {
      case FLAP_CHANNELS.CONN_NEW: // new connection negotiation
        debug('(' + conn.remoteAddress + ') RECEIVED FLAP type: New connection negotiation');
        if (conn.serverType === 'login') {
          self._send(conn, self._createFLAP(conn, FLAP_CHANNELS.CONN_NEW, [0x00, 0x00, 0x00, 0x01])); // send FLAP protocol version
          self._login(undefined, conn, cb);
        } else
          self._login(undefined, conn, cb, 2);
        conn.curData = undefined;
      break;
      case FLAP_CHANNELS.SNAC: // SNAC response
        var payloadLen = (data[4] << 8) + data[5];
        if (6+payloadLen > data.length)
          return;
        else
          conn.curData = undefined;
        //debug('(' + conn.remoteAddress + ') RECEIVED FLAP type: SNAC response');
        self._parseSNAC(conn, data.slice(6, 6+payloadLen), cb);
        if (data.length > 6 + payloadLen) {
          // extra bytes -- start of another FLAP message?
          var extra = new Buffer(data.length - (6 + payloadLen));
          data.copy(extra, 0, 6 + payloadLen);
          process.nextTick(function() {
            conn.emit('data', extra);
          });
        }
      break;
      case FLAP_CHANNELS.ERROR: // FLAP-level error
        debug('(' + conn.remoteAddress + ') RECEIVED FLAP type: FLAP error');
        conn.curData = undefined;
      break;
      case FLAP_CHANNELS.CONN_CLOSE: // close connection negotiation
        debug('(' + conn.remoteAddress + ') RECEIVED FLAP type: Close connection negotiation');
        if (conn.serverType === 'BOS') {
          var tlvs = extractTLVs(data, 6);
          if (tlvs[TLV_TYPES.ERROR]) {
            var code = (tlvs[TLV_TYPES.ERROR][0] << 8) + tlvs[TLV_TYPES.ERROR][1];
            var err = new Error(AUTH_ERRORS_TEXT[code]);
            err.code = code;
            if (typeof cb === 'function')
              cb(err);
            else
              throw err;
            return;
          } else if (tlvs[TLV_TYPES.BOS_SERVER])
            self._login(undefined, conn, cb, 1, tlvs[TLV_TYPES.BOS_SERVER].toString(), tlvs[TLV_TYPES.AUTH_COOKIE]);
        }
        conn.curData = undefined;
      break;
      case FLAP_CHANNELS.KEEPALIVE: // keep alive
        debug('(' + conn.remoteAddress + ') RECEIVED FLAP type: Keep-alive');
        conn.curData = undefined;
      break;
      default:
        debug('(' + conn.remoteAddress + ') RECEIVED FLAP type: UNKNOWN (0x' + data[1].toString(16) + ')');
        conn.curData = undefined;
    }
  } else
    debug('(' + conn.remoteAddress + ') RECEIVED Non-FLAP message');
}

function end_handler(oscar) {
  var self = oscar, conn = this;
  conn.isConnected = false;
  if (!conn.isTransferring) {
    if (conn === self._state.connections.main) {
      self._resetState();
      self.emit('end');
    }
    debug('(' + conn.remoteAddress + ') [' + getConnSvcNames(conn) + '] FIN packet received. Disconnecting...');
  }
}

function error_handler(oscar, err, cb) {
  var self = oscar, conn = this;
  clearTimeout(conn.tmrConn);
  if (!conn.isConnected)
    cb(new Error('(' + conn.remoteAddress + ') Unable to connect to ' + conn.serverType + ' server.\n  ' + err.stack));
  if (conn.readyState === 'closed')
    conn.isConnected = false;
  debug('(' + conn.remoteAddress + ') ' + err);
  self.emit('error', err);
}

function close_handler(oscar, had_error) {
  var self = oscar, conn = this;
  conn.isConnected = false;
  if (!conn.isTransferring || had_error) {
    if (conn === self._state.connections.main) {
      self._resetState();
      self.emit('close', had_error);
    }
    debug('(' + conn.remoteAddress + ') [' + getConnSvcNames(conn) + '] Connection forcefully closed.');
  }
}

// Private methods -----------------------------------------------------------------------------------

OscarConnection.prototype._resetState = function() {
  this._state = {
    connections: {},
    serviceMap: {},
    reqID: 0, // 32-bit number that identifies a single SNAC request
    status: this._options.other.initialStatus,
    flags: this._options.other.initialFlags,
    requests: {},
    isAOL: (this._options.connection.host.substr(this._options.connection.host.length-7).toUpperCase() === 'AOL.COM'),
    rateLimitGroups: {},
    rateLimits: {},
    svcInfo: {},
    svcPaused: {},
    SSI: {},
    iconQueue: {},
    rndvCookies: { out: {}, in: {} },
    chatrooms: {},
    p2p: {}
  };
};

OscarConnection.prototype._addConnection = function(id, services, host, port, cb) {
  var self = this;
  self._state.connections[id] = new net.Socket();
  self._state.connections[id].id = id;
  self._state.connections[id].neededServices = services;
  self._state.connections[id].serverType = (id === 'login' ? 'login' : 'BOS');
  self._state.connections[id].isTransferring = false;
  self._state.connections[id].isReady = false;
  self._state.connections[id].isConnected = false;
  self._state.connections[id].seqNum = 0; // 0x0000 to 0x7FFF, wraps to 0x0000 past 0x7FFF
  self._state.connections[id].fnTmrConn = function(cbConn) {
    cbConn(new Error('Connection timed out while connecting to ' + self._state.connections[id].serverType + ' server'));
    self._state.connections[id].destroy();
  };
  self._state.connections[id].tmrConn = setTimeout(self._state.connections[id].fnTmrConn, self._options.connection.connTimeout, cb);
  self._state.connections[id].setTimeout(0);
  self._state.connections[id].setKeepAlive(true);
  self._state.connections[id].restartKeepAlive = function() {
    var conn = this;
    if (conn.keepAliveTimer)
      clearTimeout(conn.keepAliveTimer);
    conn.keepAliveTimer = setInterval(function() { self._sendKeepAlive(conn); }, KEEPALIVE_INTERVAL);
  };
  self._state.connections[id].on('connect', function() { connect_handler.call(this, self); });
  self._state.connections[id].on('data', function(data) { data_handler.call(this, self, data, cb); });
  self._state.connections[id].on('end', function() { end_handler.call(this, self); });
  self._state.connections[id].on('error', function(err) { error_handler.call(this, self, err, cb); });
  self._state.connections[id].on('close', function(had_error) { close_handler.call(this, self, had_error); });
  self._state.connections[id].connect(port, host);
}

OscarConnection.prototype._addService = function(svc, roomInfo, cb) {
  var self = this;
  if (typeof cb === 'undefined') {
    cb = roomInfo;
    roomInfo = undefined;
  }
  if (svc === SNAC_SERVICES.CHAT || !self._state.serviceMap[svc]) {
    var content = [svc >> 8 & 0xFF, svc & 0xFF];
    if (roomInfo) {
      content = content.concat(self._createTLV(0x01,
        [(roomInfo.exchange >> 8) & 0xFF, roomInfo.exchange & 0xFF,
         roomInfo.cookie.length].concat(roomInfo.cookie).concat([0x00, 0x00])
      ));
    }
    self._send(self._createFLAP(self._state.connections.main, FLAP_CHANNELS.SNAC,
      self._createSNAC(SNAC_SERVICES.GENERIC, 0x04, NO_FLAGS,
        content
      )
    ), function(e, address, cookie) {
      if (e) {
        if (typeof cb === 'function')
          cb(e);
        return;
      }
      var services = {}, server, port, id = Date.now();
      if (address.indexOf(':') > -1) {
        server = address.substring(0, address.indexOf(':'));
        port = parseInt(address.substr(address.indexOf(':')+1));
      } else {
        server = address;
        port = self._state.connections.main.remotePort;
      }
      services[svc] = true;
      self._addConnection(id, services, server, port, function(e) {
        self._state.connections[id].authCookie = undefined;
        self._state.connections[id].rateLimitGroups = undefined;
        if (!e && roomInfo) {
          self._state.chatrooms[roomInfo.name] = self._state.connections[id];
          self._state.chatrooms[roomInfo.name].roomInfo = roomInfo;
        }
        if (typeof cb === 'function')
          process.nextTick(function(){ cb(e, self._state.connections[id]); });
      });
      self._state.connections[id].authCookie = cookie;
    });
  } else if (typeof cb === 'function')
    process.nextTick(function(){ cb(); });
};

// action === 0 (add), 1 (delete), 2 (modify)
OscarConnection.prototype._SSIModify = function(items, action, cb) {
  // TODO: check max (and min) name length, etc before hitting the server
  cb = arguments[arguments.length-1];
  var err = '', exists, bytes = [], self = this;
  items = (Array.isArray(items) ? items : [items]);
  for (var i=0,ilen=items.length; i<ilen; i++) {
    bytes.push(items[i].name.length >> 8 & 0xFF);
    bytes.push(items[i].name.length & 0xFF);
    for (var j=0; j<items[i].name.length; j++)
      bytes.push(items[i].name.charCodeAt(j) & 0xFF);
    if (action === 0) {
      if (items[i].type === 0x01) {
        for (var j=0; j<=0x7FFF; j++) {
          if (typeof self.contacts._usedIDs[j] === 'undefined') {
            items[i].group = j;
            break;
          }
        }
      } else if (items[i].group === 0) {
        var groups = Object.keys(self.contacts._usedIDs), groupsLen = groups.length;
        for (var j=0,found; j<=0x7FFF; j++) {
          if (typeof self.contacts._usedIDs[j] === 'undefined') {
            found = false;
            for (var k=0; k<groupsLen; k++) {
              if (typeof self.contacts._usedIDs[groups[k]][j] !== 'undefined')
                found = true;
            }
            if (!found) {
              items[i].item = j;
              break;
            }
          }
        }
      } else {
        for (var j=0; j<=0x7FFF; j++) {
          if (typeof self.contacts._usedIDs[items[i].group][j] === 'undefined') {
            items[i].item = j;
            break;
          }
        }
      }
    }
    bytes.push(items[i].group >> 8 & 0xFF);
    bytes.push(items[i].group & 0xFF);
    bytes.push(items[i].item >> 8 & 0xFF);
    bytes.push(items[i].item & 0xFF);
    bytes.push(items[i].type >> 8 & 0xFF);
    bytes.push(items[i].type & 0xFF);
    var itemBytes = [];

    if (action !== 1) {
      if (items[i].type === 0x00) {
        if (items[i].localInfo) {
          if (items[i].localInfo.alias)
            itemBytes = itemBytes.concat(self._createTLV(0x0131, str2bytes(items[i].localInfo.alias)));
          if (items[i].localInfo.emailAddress)
            itemBytes = itemBytes.concat(self._createTLV(0x0137, str2bytes(items[i].localInfo.emailAddress)));
          if (items[i].localInfo.homePhoneNum)
            itemBytes = itemBytes.concat(self._createTLV(0x0138, str2bytes(items[i].localInfo.homePhoneNum)));
          if (items[i].localInfo.cellPhoneNum)
            itemBytes = itemBytes.concat(self._createTLV(0x0139, str2bytes(items[i].localInfo.cellPhoneNum)));
          if (items[i].localInfo.smsPhoneNum)
            itemBytes = itemBytes.concat(self._createTLV(0x013A, str2bytes(items[i].localInfo.smsPhoneNum)));
          if (items[i].localInfo.workPhoneNum)
            itemBytes = itemBytes.concat(self._createTLV(0x0158, str2bytes(items[i].localInfo.workPhoneNum)));
          if (items[i].localInfo.otherPhoneNum)
            itemBytes = itemBytes.concat(self._createTLV(0x0159, str2bytes(items[i].localInfo.otherPhoneNum)));
          if (items[i].localInfo.notes)
            itemBytes = itemBytes.concat(self._createTLV(0x013C, str2bytes(items[i].localInfo.notes)));
        }
        // TODO: support adding/modifying the alerts for this contact and check maxWatchers first
      } else if (items[i].type === 0x01) {
        if (action === 2) {
          var ids = [],
              children = (Object.keys(items[i].group > 0 ?
                          this.contacts.list[items[i].group].contacts : this.contacts._usedIDs),len2 = children.length);
          for (var j=0; j<len2; j++) {
            if (items[i].group === 0 && children[j] === 0)
              continue;
            ids.push(children[j] >> 8 & 0xFF);
            ids.push(children[j] & 0xFF);
          }
          if (ids.length > 0)
            itemBytes = itemBytes.concat(self._createTLV(0x00C8, ids));
        }
      } else if (items[i].tlvs) {
        for (var j=0,types=Object.keys(items[i].tlvs),len2=types.length; j<len2; j++)
          itemBytes = itemBytes.concat(self._createTLV(parseInt(types[j]), items[i].tlvs[types[j]]));
      }
    }
    bytes.push(itemBytes.length >> 8 & 0xFF);
    bytes.push(itemBytes.length & 0xFF);
    if (itemBytes.length > 0)
      bytes = bytes.concat(itemBytes);
  }
  var subtype = 0x08;
  if (action === 1)
    subtype = 0x0A;
  else if (action === 2)
    subtype = 0x09;

  self._send(self._createFLAP(self._state.connections.main, FLAP_CHANNELS.SNAC,
    self._createSNAC(SNAC_SERVICES.SSI, subtype, NO_FLAGS,
      bytes
    )
  ), function(e) {
    if (typeof cb === 'function')
      cb(e);
  });
};

OscarConnection.prototype._SSIStartTrans = function() {
  var self = this;
  self._send(self._createFLAP(self._state.connections.main, FLAP_CHANNELS.SNAC,
    self._createSNAC(SNAC_SERVICES.SSI, 0x11, NO_FLAGS
    )
  ));
};

OscarConnection.prototype._SSIEndTrans = function() {
  var self = this;
  self._send(self._createFLAP(self._state.connections.main, FLAP_CHANNELS.SNAC,
    self._createSNAC(SNAC_SERVICES.SSI, 0x12, NO_FLAGS
    )
  ));
};

OscarConnection.prototype._SSIFindGroup = function(group) {
  var retVal = -1;
  if (typeof group === 'undefined' || group === null)
    retVal = -1;
  else if (typeof group === 'number') {
    if (typeof this.contacts.list[group] === 'undefined')
      retVal = -1;
  } else {
    group = (''+group).toUpperCase();
    for (var i=0,groups=Object.keys(this.contacts.list),len=groups.length; i<len; i++) {
      if (this.contacts.list[groups[i]].name.toUpperCase() === group) {
        retVal = groups[i];
        break;
      }
    }
  }
  return retVal;
};

OscarConnection.prototype._SSIFindContact = function(group, contact) {
  var retVal = [-1, -1];
  if (arguments.length === 1) {
    contact = arguments[0];
    group = undefined;
  }
  group = this._SSIFindGroup(group);
  if (group > -1)
    retVal[0] = group;
  if (typeof contact === 'number') {
    if (typeof this.contacts.list[group].contacts[contact] !== 'undefined')
      retVal[1] = contact;
  } else {
    contact = (''+contact).toUpperCase().replace(/ /g, '');
    for (var i=0,groups=Object.keys(this.contacts.list),glen=groups.length; i<glen; i++) {
      for (var j=0,contacts=Object.keys(this.contacts.list[groups[i]].contacts),len=contacts.length; j<len; j++) {
        if (this.contacts.list[groups[i]].contacts[contacts[j]].name.toUpperCase().replace(/ /g, '') === contact) {
          retVal[0] = groups[i];
          retVal[1] = contacts[j];
          break;
        }
      }
    }
  }
  return retVal;
};

OscarConnection.prototype._send = function(conn, payload, cb) {
  var self = this, isSNAC, svc;
  if (!(conn instanceof net.Stream)) {
    cb = payload;
    payload = conn;
  }

  isSNAC = (payload[1] === FLAP_CHANNELS.SNAC);
  svc = (isSNAC ? (payload[6] << 8) + payload[7] : undefined);
  if (!(conn instanceof net.Stream) && svc !== 'undefined')
    conn = self._state.serviceMap[svc];

  if (isSNAC) {
    if (Object.keys(conn.availServices).length > 0 && typeof conn.availServices[svc] === 'undefined') {
      var err = new Error('No available server supports the requested SNAC: 0x' + svc.toString(16));
      if (typeof cb === 'function')
        cb(err);
      else
        throw err;
      return;
    }
    if (typeof cb === 'function') { // some requests don't expect a response
      var reqID = (payload[12] << 24) + (payload[13] << 16) + (payload[14] << 8) + payload[15]; // SNAC request ID
      this._state.requests[reqID] = cb;
    }
  }
  payload = new Buffer(payload);
  debug('(' + conn.remoteAddress + ') SENDING: \n' + util.inspect(payload) + '\n');
  conn.write(payload);
  
  conn.restartKeepAlive();
};

OscarConnection.prototype._dispatch = function(reqID) {
  var cb = this._state.requests[reqID];
  if (typeof cb === 'function') {
    this._state.requests[reqID] = undefined;
    cb.apply(this, Array.prototype.slice.call(arguments).slice(1));
  }
};

OscarConnection.prototype._incomingFile = function(data) {
  var fileInfo = {}, i = 0, len;
  fileInfo.subtype = (data[i++] << 8) + data[i++]; // 0x0001 === 'one file', 0x0002 === 'more than one file'
  fileInfo.numFiles = (data[i++] << 8) + data[i++];
  fileInfo.totalSize = (data[i++] << 24) + (data[i++] << 16) + (data[i++] << 8) + data[i++];
  fileInfo.filename = data.toString(i, i+(data.length-1)); // string is null-terminated
  return fileInfo;
};

OscarConnection.prototype._incomingIcon = function(data) {
  var i = 0, hash = (data[i++] << 24) + (data[i++] << 16) + (data[i++] << 8) + data[i++],
      len = (data[i++] << 24) + (data[i++] << 16) + (data[i++] << 8) + data[i++],
      datetime = (data[i++] << 24) + (data[i++] << 16) + (data[i++] << 8) + data[i++];
  return { hash: hash, datetime: datetime, data: data.slice(i, i+len) };
};

OscarConnection.prototype._incomingChat = function(data) {
  var roomInfo = {}, i = 0, len;
  roomInfo.exchange = (data[i++] << 8) + data[i++];
  len = data[i++];
  roomInfo.name = data.toString('utf8', i, i+len);
  i += len;
  roomInfo.instance = (data[i++] << 8) + data[i++];
  return roomInfo;
};

OscarConnection.prototype._incomingList = function(data) {
  var list = {};
  for (var i=0,len=data.length,group,namelen,numContacts; i<len;) {
    namelen = (data[i++] << 8) + data[i++];
    group = data.toString('utf8', i, i+namelen);
    list[group] = [];
    i += namelen;
    numContacts = (data[i++] << 8) + data[i++];
    for (var j=0; j<numContacts; j++) {
      namelen = (data[i++] << 8) + data[i++];
      list[group].push(data.toString('utf8', i, i+namelen));
      i += namelen;
    }
  }
  return list;
};

OscarConnection.prototype._calcIconSum = function(icon) {
  var sum = 0; // 16-bit
  if (Buffer.isBuffer(icon) || Array.isArray(icon)) {
    var iconLen = icon.length, i;
    for (i=0; i+1<iconLen; i+=2)
      sum += (icon[i+1] << 8) + icon[i];
    if (i < iconLen)
      sum += icon[i];
    sum = ((sum & 0xFFFF0000) >> 16) + (sum & 0x0000FFFF);
  }
  return sum;
};

OscarConnection.prototype._sendIcon = function(who) {
  if (Buffer.isBuffer(this.icon.data) || Array.isArray(this.icon.data)) {
    if (this.icon.data.length <= MAX_ICON_LEN) {
      var content = [], cookie;
      who = str2bytes(who);
      cookie = splitNum(Date.now(), 4).concat(splitNum(Date.now()+1, 4));
      content = content.concat(cookie).concat[0x00, 0x02, who.length].concat(who)
                       .concat(this._createTLV(0x05, [0x00, 0x00].concat(cookie).concat(CAPABILITIES.BUDDY_ICON)));
      content = content.concat(this._createTLV(0x0A, [0x00, 0x01]));
      content = content.concat(this._createTLV(0x0F));
      content = content.concat(this._createTLV(0x2711, [0x00].concat(splitNum(this._calcIconSum(this.icon.data), 2))
                                                             .concat(splitNum(this.icon.data.length, 4))
                                                             .concat(splitNum(this.icon.datetime, 4))
      ));
      for (var i=0,len=this.icon.data.length; i<len; i++)
        content.push(this.icon.data[i]);
      content = content.concat(str2bytes('AVT1picture.id'));

      this._send(this._createFLAP(this._state.connections.main, FLAP_CHANNELS.SNAC,
        this._createSNAC(SNAC_SERVICES.ICBM, 0x06, NO_FLAGS,
          content
        )
      ));
    } else
      debug('Uh oh, my icon exceeds the maximum icon size of ' + MAX_ICON_LEN + ' bytes. Cannot send it to: ' + who);
  }
};

OscarConnection.prototype.sendFile = function(who, file, ip, port, cb) {
  
};

OscarConnection.prototype._cancelRendezvous = function(inout, cookie, cb) {
  cookie = ''+cookie;
  var info = rndvCookies[inout][cookie];
  if (typeof info !== 'undefined') {
    var content, type;
    cookie = info.cookie;
    if (info.type === 'chat')
      type = CAPABILITIES.CHAT;
    else if (info.type === 'file')
      type = CAPABILITIES.SEND_FILE;
    if (inout === 'out') {
      content = cookie.concat[0x00, 0x02, who.length].concat(who).concat(this._createTLV(0x03))
                      .concat(this._createTLV(0x05, [0x00, 0x01].concat(cookie).concat(type).concat(this._createTLV(0x0B))));
      this._send(this._createFLAP(this._state.connections.main, FLAP_CHANNELS.SNAC,
        this._createSNAC(SNAC_SERVICES.ICBM, 0x06, NO_FLAGS,
          content
        )
      ), cb);
    } else if (inout === 'in') {
      if (info.type === 'file') {
        
      }
    }
    delete rndvCookies[inout][cookie];
  }
};

OscarConnection.prototype._chatInvite = function(who, msg, roomInfo) {
  var content, cookie;
  who = str2bytes(who);
  msg = str2bytes(msg);
  name = str2bytes(roomInfo.name);
  exchange = splitNum(roomInfo.exchange, 2);
  instance = splitNum(roomInfo.instance, 2);
  cookie = splitNum(Date.now(), 4).concat(splitNum(Date.now()+1, 4));
  this._state.rndvCookies.out[cookie.join('')] = {
    cookie: cookie,
    type: 'chat',
    user: who,
    name: name,
    exchange: exchange,
    instance: instance
  };
  content = cookie.concat([0x00, 0x02, who.length]).concat(who)
                  .concat(this._createTLV(0x05, [0x00, 0x00].concat(cookie).concat(CAPABILITIES.CHAT)
                              .concat(this._createTLV(0x0A, [0x00, 0x01])).concat(this._createTLV(0x0F))
                              .concat(this._createTLV(0x0C, msg))
                              .concat(this._createTLV(0x2711, exchange.concat(name).concat(instance)))));
  this._send(this._createFLAP(this._state.connections.main, FLAP_CHANNELS.SNAC,
    this._createSNAC(SNAC_SERVICES.ICBM, 0x06, NO_FLAGS,
      content
    )
  ));
  return cookie.join('');
};

OscarConnection.prototype._parseSNAC = function(conn, snac, cb) {
  //debug('(' + conn.remoteAddress + ') SNAC response follows:\n' + util.inspect(snac));
  var serviceID, subtypeID, flags, reqID, tlvs, idx, isServerOrig, moreFollows,
      debugtext, self = this;
  serviceID = (snac[0] << 8) + snac[1];
  subtypeID = (snac[2] << 8) + snac[3];
  flags = (snac[4] << 8) + snac[5];
  reqID = (snac[6] << 24) + (snac[7] << 16) + (snac[8] << 8) + snac[9];
  isServerOrig = (flags < 0); // MSB === 1 indicates the SNAC is not the result of a client request,
                              // (i.e. the server is asking/telling us something)
  moreFollows = (flags & 0x1); // At least one more packet of the same SNAC service and subtype (?) will come after this packet
  idx = 10;
  if (flags & 0x8000) {
    // apparently this means AOL has decided to prepend service version information for the fun of it,
    // so skip it to get to the real data
    idx += 2+((snac[idx] << 8) + snac[idx+1]);
  }
  debugtext = '(' + conn.remoteAddress + ') RECEIVED SNAC: ';
  switch (serviceID) {
    case SNAC_SERVICES.AUTH:
      debugtext += 'AUTH > ';
      switch (subtypeID) {
        case 0x03:
          debugtext += 'MD5 login reply';
          tlvs = extractTLVs(snac);
          if (tlvs[TLV_TYPES.ERROR]) {
            var err = new Error(AUTH_ERRORS_TEXT[(tlvs[TLV_TYPES.ERROR][0] << 8) + tlvs[TLV_TYPES.ERROR][1]]);
            debugtext += ' (error: ' + err + ')';
            if (typeof cb === 'function')
              cb(err);
            else
              throw err;
          } else {
            self._dispatch(reqID, undefined, tlvs[TLV_TYPES.BOS_SERVER].toString(), tlvs[TLV_TYPES.AUTH_COOKIE].toArray());
            debugtext += ' (no error)';
          }
        break;
        case 0x07: // md5 salt
          debugtext += 'MD5 key/salt';
          var saltLen, salt;
          saltLen = (snac[idx++] << 8) + snac[idx++];
          salt = snac.toString('utf8', idx, idx+saltLen);
          self._dispatch(reqID, undefined, salt);
        break;
        default:
          debugtext += 'Unknown (0x' + subtypeID.toString(16) + ')';
      }
    break;
    case SNAC_SERVICES.GENERIC:
      debugtext += 'GENERIC > ';
      switch (subtypeID) {
        case 0x01: // error
          debugtext += 'Error';
          var code = (snac[idx++] << 8) + snac[idx++], msg = GLOBAL_ERRORS_TEXT[code] || 'Unknown error code received: ' + code,
              err = new Error(msg);
          err.code = code;
          debugtext += ': ' + msg;
          self._dispatch(reqID, err);
        break;
        case 0x03:
          debugtext += 'Supported services: ';
          var debugAvail = [], services = flip(SNAC_SERVICES);
          for (var len=snac.length,svc; idx<len;) {
            svc = (snac[idx++] << 8) + snac[idx++];
            conn.availServices[svc] = true;
            if (typeof services[svc] !== 'undefined')
              debugAvail.push(services[svc]);
          }
          debugtext += debugAvail.join(', ');
          self._login(undefined, conn, cb, 3);
        break;
        case 0x05: // redirect info for requested service
          debugtext += 'Service request info';
          var services = flip(SNAC_SERVICES), useSSL;
          tlvs = extractTLVs(snac, idx);
          useSSL = (tlvs[0x8E] && tlvs[0x8E][0] === 0x01);
          if (typeof services[(tlvs[0x0D][0] << 8) + tlvs[0x0D][1]] !== 'undefined')
            debugtext += ' (' + services[(tlvs[0x0D][0] << 8) + tlvs[0x0D][1]] + ')';
          else
            debugtext += ' (Unknown: ' + ((tlvs[0x0D][0] << 8) + tlvs[0x0D][1]).toString(16) + ')';
          debugtext += '. Host: ' + tlvs[0x05].toString();
          self._dispatch(reqID, undefined, tlvs[0x05].toString(), tlvs[0x06].toArray());
        break;
        case 0x07:
          debugtext += 'Rate limit classes and groups';
          var numGroups = 0, classId;
          if (typeof snac[idx] !== 'undefined') {
            numGroups = (snac[idx++] << 8) + snac[idx++];
            for (var i=0, group; i<numGroups; i++) {
              classId = (snac[idx++] << 8) + snac[idx++];
              group = {
                windowSize: (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++],
                levels: {
                  clear: (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++],
                  alert: (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++],
                  limit: (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++],
                  disconnect: (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++],
                  current: (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++],
                  max: (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++],
                },
                delta: 0,
                droppingSNACs: false
              };
              if (conn.availServices[serviceID] >= 3) {
                group.delta = (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++];
                group.droppingSNACs = (snac[idx++] === 0x01 ? true : false);
              }
              if (!self._state.rateLimitGroups[classId])
                self._state.rateLimitGroups[classId] = group;
              if (!conn.rateLimitGroups)
                conn.rateLimitGroups = [];
              if (conn.rateLimitGroups.indexOf(classId) === -1)
                conn.rateLimitGroups.push(classId);
            }
          }
          if (numGroups > 0) {
            for (var i=0,numPairs; i<numGroups; i++) {
              classId = (snac[idx++] << 8) + snac[idx++];
              numPairs = (snac[idx++] << 8) + snac[idx++];
              // Save memory by not storing most SNACs that are in the same rate group
              // and just default to this group if they are not found in the hash
              if (classId === DEFAULT_RATE_GROUP) {
                idx += numPairs*4;
                continue;
              }
              for (var j=0,service,subtype; j<numPairs; j++) {
                service = (snac[idx++] << 8) + snac[idx++];
                subtype = (snac[idx++] << 8) + snac[idx++];
                if (!self._state.rateLimits[service])
                  self._state.rateLimits[service] = {};
                if (!self._state.rateLimits[service][subtype])
                  self._state.rateLimits[service][subtype] = self._state.rateLimitGroups[classId];
              }
            }
          }
          self._dispatch(reqID);
        break;
        case 0x0A: // change in rate limiting
          debugtext += 'Rate limit change';
          var code = (snac[idx++] << 8) + snac[idx++], classId, group;
          classId = (snac[idx++] << 8) + snac[idx++];
          group = {
            windowSize: (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++],
            levels: {
              clear: (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++],
              alert: (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++],
              limit: (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++],
              disconnect: (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++],
              current: (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++],
              max: (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++],
            },
            delta: 0,
            droppingSNACs: 0
          };
          if (conn.availServices[serviceID] >= 3) {
            group.delta = (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++];
            group.droppingSNACs = snac[idx++];
          }
          // TODO: if code === RATE_UPDATES.CHANGED, automatically request new rate limits if not given in this SNAC?
        break;
        case 0x0B: // stop sending packets to the server
          debugtext += '"Stop sending packets"';
          //if (self._state.svcPaused[conn.id])
            self._state.svcPaused[conn.id] = {};
          if (typeof snac[idx] === 'undefined') {
            conn.isReady = false;
            self._send(self._createFLAP(self._state.connections.main, FLAP_CHANNELS.SNAC,
              self._createSNAC(SNAC_SERVICES.GENERAL, 0x0C, NO_FLAGS
              )
            ));
          } else {
            var ack = [];
            for (len=snac.length; idx < len; idx+=2) {
              self._state.svcPaused[conn.id][(snac[idx] << 8) + snac[idx+1]] = true;
              ack.push(snac[idx]);
              ack.push(snac[idx+1]);
            }
            self._send(self._createFLAP(self._state.connections.main, FLAP_CHANNELS.SNAC,
              self._createSNAC(SNAC_SERVICES.GENERAL, 0x0C, NO_FLAGS,
                ack
              )
            ));
          }
        break;
        case 0x0D: // resume sending packets
          debugtext += '"Resume sending packets"';
          if (typeof snac[idx] === 'undefined') {
            //if (self._state.svcPaused[conn.id])
              self._state.svcPaused[conn.id] = {};
            conn.isReady = true;
          } else {
            for (len=snac.length; idx < len; idx+=2) {
              if (self._state.svcPaused[conn.id][(snac[idx] << 8) + snac[idx+1]])
                self._state.svcPaused[conn.id][(snac[idx] << 8) + snac[idx+1]] = undefined;
            }
          }
        break;
        case 0x0F: // user info about self
          debugtext += 'Info about myself';
          self.me = self._parseUserInfo(snac, idx);
        break;
        case 0x10: // somebody warned us
          debugtext += 'Warning received by: ';
          var oldLevel = self.me.warnLevel, newLevel = (snac[idx++] << 8) + snac[idx++], who, whoWarnLevel;
          if (idx < snac.length) {
            // non-anonymous warning
            who = snac.toString('utf8', idx+1, idx+1+snac[idx]);
            idx += 1+snac[idx];
            whoWarnLevel = (snac[idx] << 8) + snac[idx+1];
            debugtext += who + ' (' + whoWarnLevel + ')';
          } else
            debugtext += '<anonymous>';
          self.me.warnLevel = newLevel;
          debugtext += '. Warn level ' + oldLevel + ' -> ' + newLevel;
          if (who)
            self.emit('warn', oldLevel, newLevel, who, whoWarnLevel);
          else
            self.emit('warn', oldLevel, newLevel);
        break;
        case 0x12: // TODO: last step in BOS server migration
          debugtext += 'Last step in server migration';
        break;
        case 0x13: // MOTD
          debugtext += 'MOTD';
          var msgTypes = flip(MOTD_TYPES), type = (snac[idx++] << 8) + snac[idx++], msg;
          tlvs = extractTLVs(snac, idx);
          if (tlvs[0x0B])
            msg = tlvs[0x0B].toString();
          self.emit('motd', type, msg);
        break;
        case 0x15: // 'well known urls' -- no idea to the format of this one
          debugtext += 'Well-known URLs';
        break;
        case 0x18:
          debugtext += 'Service versions';
          for (var len=snac.length; idx<len;)
            conn.availServices[(snac[idx++] << 8) + snac[idx++]] = (snac[idx++] << 8) + snac[idx++];
          self._login(undefined, conn, cb, 4);
        break;
        default:
          debugtext += 'Unknown (0x' + subtypeID.toString(16) + ')';
      }
    break;
    case SNAC_SERVICES.LOCATION:
      debugtext += 'LOCATION > ';
      switch (subtypeID) {
        case 0x01: // error
          debugtext += 'Error';
          var code = (snac[idx++] << 8) + snac[idx++], msg = GLOBAL_ERRORS_TEXT[code] || 'Unknown error code received: ' + code,
              err = new Error(msg);
          err.code = code;
          debugtext += ': ' + msg;
          self._dispatch(reqID, err);
        break;
        case 0x03: // limits response
          debugtext += 'Service limits';
          tlvs = extractTLVs(snac);
          if (!self._state.svcInfo[SNAC_SERVICES.LOCATION]) {
            self._state.svcInfo[SNAC_SERVICES.LOCATION] = {};
            self._state.svcInfo[SNAC_SERVICES.LOCATION].maxProfileLen = (tlvs[0x01][0] << 8) + tlvs[0x01][1];
            self._state.svcInfo[SNAC_SERVICES.LOCATION].maxCapabilities = (tlvs[0x02][0] << 8) + tlvs[0x02][1];
          }
          debugtext += ': maxProfileLen = ' + ((tlvs[0x01][0] << 8) + tlvs[0x01][1]);
          debugtext += ', maxCapabilities = ' + ((tlvs[0x02][0] << 8) + tlvs[0x02][1]);
          self._dispatch(reqID);
        break;
        case 0x06: // user info response
          debugtext += 'User info for ';
          var info = self._parseUserInfo(snac, idx, true);
          idx = info[1];
          info = info[0];
          tlvs = extractTLVs(snac, idx);
          if (tlvs[0x0001]) {
            var encoding = tlvs[0x0001].toString().toLowerCase();
            encoding = (encoding === 'utf8' || encoding === 'utf-8' ? 'utf8' : 'ascii');
            if (tlvs[0x0002])
              info.profile = tlvs[0x0002].toString(encoding);
          }
          if (tlvs[0x0003]) {
            var encoding = tlvs[0x0003].toString().toLowerCase();
            encoding = (encoding !== 'ascii' && encoding !== 'utf8' && encoding !== 'utf-8' ? 'ascii' : encoding);
            if (tlvs[0x0004])
              info.away = tlvs[0x0004].toString(encoding);
          }
          if ((!info.capabilities || info.capabilities.length === 0) && tlvs[0x0005] && tlvs[0x0005].length > 0) {
            info.capabilities = [];
            var caps = tlvs[0x0005].toArray();
            for (var i=0,len=caps.length; i<len; i+=16)
              info.capabilities.push(caps.slice(i, i+16));
          }
          var check = self._SSIFindContact(info.name);
          if (check[1] !== -1)
            self._mergeInfo(info.name, info);
          debugtext += info.name;
          self._dispatch(reqID, undefined, info);
        break;
        default:
          debugtext += 'Unknown (0x' + subtypeID.toString(16) + ')';
      }
    break;
    case SNAC_SERVICES.LIST_MGMT:
      debugtext += 'LIST_MGMT > ';
      switch (subtypeID) {
        case 0x03: // limits response
          debugtext += 'Service limits';
          tlvs = extractTLVs(snac);
          if (!self._state.svcInfo[SNAC_SERVICES.LIST_MGMT]) {
            self._state.svcInfo[SNAC_SERVICES.LIST_MGMT] = {};
            self._state.svcInfo[SNAC_SERVICES.LIST_MGMT].maxContacts = tlvs[0x01][0];
            self._state.svcInfo[SNAC_SERVICES.LIST_MGMT].maxWatchers = tlvs[0x02][0];
            self._state.svcInfo[SNAC_SERVICES.LIST_MGMT].maxNotifications = tlvs[0x03][0];
          }
          debugtext += ': maxContacts = ' + tlvs[0x01][0];
          debugtext += ', maxWatchers = ' + tlvs[0x02][0];
          debugtext += ', maxNotifications = ' + tlvs[0x03][0];
          self._dispatch(reqID);
        break;
        case 0x0B: // contact signed on or changed status notice
        case 0x0C: // contact signed off notice
          if (subtypeID === 0x0B) {
            debugtext += 'Buddy ';
            var info = self._parseUserInfo(snac, idx), check, isSigningOn = false;
            check = self._SSIFindContact(info.name);
            if (check[1] !== -1) {
              if (self.contacts.list[check[0]].contacts[check[1]].status === USER_STATUSES.OFFLINE && info.flags !== 0x0000)
                isSigningOn = true;
              self._mergeInfo(info.name, info);
              self.emit((isSigningOn ? 'contactonline' : 'contactupdate'), self.contacts.list[check[0]].contacts[check[1]]);
            }
            debugtext += '(' + info.name + ') ' + (isSigningOn ? 'logged on' : 'changed their status');
          } else {
            var who = snac.toString('utf8', idx+1, idx+1+snac[idx]), warnLevel, check;
            idx+=1+snac[idx];
            warnLevel = (snac[idx++] << 8) + snac[idx++];
            check = self._SSIFindContact(who);
            if (check[1] !== -1) {
              self.contacts.list[check[0]].contacts[check[1]].status = USER_STATUSES.OFFLINE;
              self.contacts.list[check[0]].contacts[check[1]].warnLevel = warnLevel;
              self.emit('contactoffline', self.contacts.list[check[0]].contacts[check[1]]);
            }
            debugtext += '(' + who + ') logged off';
          }
        break;
        default:
          debugtext += 'Unknown (0x' + subtypeID.toString(16) + ')';
      }
    break;
    case SNAC_SERVICES.ICBM:
      debugtext += 'ICBM > ';
      switch (subtypeID) {
        case 0x01: // error
          debugtext += 'Error';
          var code = (snac[idx++] << 8) + snac[idx++], subcode, err,
              msg = ICBM_ERRORS_TEXT[code] || 'Unknown error code received: ' + code;
          tlvs = extractTLVs(snac, idx);
          if (tlvs[0x08]) {
            subcode = (tlvs[0x08][0] << 8) + tlvs[0x08][1];
            msg += ICBM_SUBCODE_ERRORS_TEXT[subcode] || 'Unknown sub error code';
          } else
            msg += 'Unknown error';
          msg += ' (code: ' + code + ', subcode: ' + subcode + ')';
          err = new Error(msg);
          err.code = code;
          err.subcode = subcode;
          debugtext += ': ' + msg;
          self._dispatch(reqID, err);
        break;
        case 0x05: // limits response
          debugtext += 'Service limits';
          if (!self._state.svcInfo[SNAC_SERVICES.ICBM]) {
            self._state.svcInfo[SNAC_SERVICES.ICBM] = {};
            self._state.svcInfo[SNAC_SERVICES.ICBM].channel = (snac[idx++] << 8) + snac[idx++];
            self._state.svcInfo[SNAC_SERVICES.ICBM].flags = (snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++];
            self._state.svcInfo[SNAC_SERVICES.ICBM].maxMsgLen = (snac[idx++] << 8) + snac[idx++];
            self._state.svcInfo[SNAC_SERVICES.ICBM].maxSenderWarn = (snac[idx++] << 8) + snac[idx++];
            self._state.svcInfo[SNAC_SERVICES.ICBM].maxReceiverWarn = (snac[idx++] << 8) + snac[idx++];
            self._state.svcInfo[SNAC_SERVICES.ICBM].minMsgInterval = (snac[idx++] << 8) + snac[idx++];
          }
          debugtext += ': channel = ' + self._state.svcInfo[SNAC_SERVICES.ICBM].channel;
          debugtext += ', flags = ' + self._state.svcInfo[SNAC_SERVICES.ICBM].flags;
          debugtext += ', maxMsgLen = ' + self._state.svcInfo[SNAC_SERVICES.ICBM].maxMsgLen;
          debugtext += ', maxSenderWarn = ' + self._state.svcInfo[SNAC_SERVICES.ICBM].maxSenderWarn;
          debugtext += ', maxReceiverWarn = ' + self._state.svcInfo[SNAC_SERVICES.ICBM].maxReceiverWarn;
          debugtext += ', minMsgInterval = ' + self._state.svcInfo[SNAC_SERVICES.ICBM].minMsgInterval;
          self._dispatch(reqID);
        break;
        case 0x07: // received a chat/im/file/dc message
          debugtext += 'Incoming ';
          var cookie, channel, sender, numFixedTLVs;
          cookie = [snac[idx++], snac[idx++], snac[idx++], snac[idx++],
                    snac[idx++], snac[idx++], snac[idx++], snac[idx++]];
          channel = (snac[idx++] << 8) + snac[idx++];
          sender = self._parseUserInfo(snac, idx, true);
          idx = sender[1];
          sender = sender[0];
          tlvs = extractTLVs(snac, idx);
          if (channel === 1) { // normal IMs
            debugtext += 'IM. Sender: ' + util.inspect(sender.name);
            var msgText, charset, msgData = tlvs[0x02], flags = 0, datetime;
            for (var i=0,len=msgData.length,fragID,fragLen; i<len;) {
              fragID = msgData[i++];
              i++;
              fragLen = (msgData[i++] << 8) + msgData[i++];
              if (fragID === 0x05) { // features -- constant?
                //features = msgData.slice(i, i+fragLen);
                i += fragLen;
              } else if (fragID === 0x01) { // message text
                charset = (msgData[i++] << 8) + msgData[i++];
                i += 2;
                fragLen -= 4;
                msgText = msgData.toString('utf8', i, i+fragLen);
                i += fragLen;
                break;
              }
            }
            // must check keys since TLV values are set to undefined
            // for zero-length TLVs
            var keys = Object.keys(tlvs).map(function(x){return parseInt(x)});
            if (keys.indexOf(0x03) > -1)
              flags |= ICBM_MSG_FLAGS.ACK;
            if (keys.indexOf(0x04) > -1)
              flags |= ICBM_MSG_FLAGS.AWAY;
            if (keys.indexOf(0x06) > -1) {
              flags |= ICBM_MSG_FLAGS.OFFLINE;
              if (tlvs[0x16]) // _should_ always be set for offline messages
                datetime = new Date(((tlvs[0x16][0] << 24) + (tlvs[0x16][1] << 16) + (tlvs[0x16][2] << 8) + tlvs[0x16][3]) * 1000);
            }
            if (tlvs[0x08]) {
              var len = (tlvs[0x08][0] << 24) + (tlvs[0x08][1] << 16) + (tlvs[0x08][2] << 8) + tlvs[0x08][3],
                  type = (tlvs[0x08][4] << 8) + tlvs[0x08][5],
                  hash = (tlvs[0x08][6] << 8) + tlvs[0x08][7], // a constant 2 bytes for a hash???
                  icndatetime = ((tlvs[0x08][8] << 24) + (tlvs[0x08][9] << 16) + (tlvs[0x08][10] << 8) + tlvs[0x08][11]) * 1000;
              if (len)
                flags |= ICBM_MSG_FLAGS.HAS_ICON;
            }
            if (keys.indexOf(0x09) > -1) {
              flags |= ICBM_MSG_FLAGS.REQ_ICON;
              self._sendIcon(sender.name); // automatically send our icon if we have one set
            }
            self.emit('im', msgText, sender, flags, datetime);
          } else if (channel === 2) { // special messages
            debugtext += 'Rendezvous';
            var msgData = tlvs[0x05], i=0;
            if (msgData) {
              var status = (msgData[i++] << 8) + msgData[i++], // one of ICBM_RENDEZVOUS_STATUSES
                  rndvCookie = [msgData[i++], msgData[i++], msgData[i++], msgData[i++],
                               msgData[i++], msgData[i++], msgData[i++], msgData[i++]];
              if (arraysEqual(rndvCookie, cookie)) { // cookie values _should_ match
                if (status === ICBM_RENDEZVOUS_STATUSES.REQUEST) {
                  var type = msgData.slice(idx, idx+16).toArray(), info = {};
                  idx += 16;
                  tlvs = extractTLVs(msgData, idx);
                  if (tlvs[0x02] && tlvs[0x02].length === 4)
                    info.proxyIP = tlvs[0x02][0] + '.' + tlvs[0x02][1] + '.' + tlvs[0x02][2] + '.' + tlvs[0x02][3];
                  if (tlvs[0x03] && tlvs[0x03].length === 4)
                    info.clientIP = tlvs[0x03][0] + '.' + tlvs[0x03][1] + '.' + tlvs[0x03][2] + '.' + tlvs[0x03][3];
                  if (tlvs[0x04] && tlvs[0x04].length === 4)
                    info.verifiedIP = tlvs[0x04][0] + '.' + tlvs[0x04][1] + '.' + tlvs[0x04][2] + '.' + tlvs[0x04][3];
                  if (tlvs[0x05])
                    info.port = (tlvs[0x05][0] << 8) + tlvs[0x05][1];
                  if (tlvs[0x0A]) {
                    info.reqNum = (tlvs[0x0A][0] << 8) + tlvs[0x0A][1];
                    // reqNum === 1 -> Initial file xfer request for no/stage 1 proxy
                    // reqNum === 2 -> reply request for stage 2 proxy (receiver wants to use a proxy)
                    // reqNum === 3 -> third request -- only for stage 3 proxy
                  }
                  if (tlvs[0x0B])
                    info.err = (tlvs[0x0B][0] << 8) + tlvs[0x0B][1];
                  if (tlvs[0x0C])
                    info.msg = tlvs[0x0C].toString();
                  if (tlvs[0x0D])
                    info.charset = tlvs[0x0D].toString();
                  if (tlvs[0x0E])
                    info.lang = tlvs[0x0E].toString();
                  if (typeof tlvs[0x10] !== 'undefined')
                    info.useProxy = true;

                  if (tlvs[0x2711]) {
                    if (arraysEqual(type, CAPABILITIES.SEND_FILE)) {
                      if (tlvs[0x2712])
                        info.fnameCharset = tlvs[0x2712].toString(); // i.e. 'us-ascii'
                      var fileInfo = self._incomingFile(tlvs[0x2711]);
                      //debug('Incoming file transfer request ... Sender: ' + util.inspect(sender) + ' File info: ' + util.inspect(fileInfo));
                      debugtext += ': File xfer request. Sender: ' + util.inspect(sender.name) + ' File info: ' + util.inspect(fileInfo);
                      info.fileInfo = fileInfo;
                      self._state.rndvCookies.in[rndvCookie] = {
                        cookie: rndvCookie,
                        type: 'file',
                        user: sender.name,
                        info: info
                      };
                      self.emit('filexfer', sender, rndvCookie, fileInfo);
                    } else if (arraysEqual(type, CAPABILITIES.BUDDY_ICON)) {
                      var iconInfo = self._incomingIcon(tlvs[0x2711]);
                      //debug('Incoming icon data ... Sender: ' + util.inspect(sender) + ' Icon info: ' + util.inspect(iconInfo));
                      debugtext += ': Icon data. Sender: ' + util.inspect(sender.name) + ' Icon info: ' + util.inspect(iconInfo);
                      info.iconInfo = iconInfo;
                      self.emit('icon', sender, iconInfo.data);
                    } else if (arraysEqual(type, CAPABILITIES.CHAT)) {
                      var roomInfo = self._incomingChat(tlvs[0x2711]);
                      //debug('Incoming chat invitation ... Sender: ' + util.inspect(sender) + ' Chat room info: ' + util.inspect(roomInfo));
                      debugtext += ': Chat invitation. Sender: ' + util.inspect(sender.name) + ' Chat room info: ' + util.inspect(roomInfo);
                      info.roomInfo = roomInfo;
                      self._state.rndvCookies.in[rndvCookie] = {
                        cookie: rndvCookie,
                        type: 'chat',
                        user: sender.name,
                        info: info
                      };
                      self.emit('chatinvite', sender, roomInfo.name, info.msg);
                    } else if (arraysEqual(type, CAPABILITIES.SEND_CONTACT_LIST)) {
                      var list = self._incomingList(tlvs[0x2711]);
                      //debug('Incoming contact list ... Sender: ' + util.inspect(sender) + ' List: ' + util.inspect(list));
                      debugtext += ': Contact list. Sender: ' + util.inspect(sender.name) + ' List: ' + util.inspect(list);
                      info.listInfo = list;
                      self.emit('contactlist', sender, list);
                    }
                  }
                } else if (status === ICBM_RENDEZVOUS_STATUSES.ACCEPT) {
                } else if (status === ICBM_RENDEZVOUS_STATUSES.CANCEL) {
                  if (self._state.p2p[rndvCookie]) {
                    self._state.p2p[rndvCookie].conn.end();
                    delete self._state.p2p[rndvCookie];
                    // TODO: emit event or let the module user that the other side canceled?
                  }
                }
              }
            }
          } else if (channel === 4)
            debugtext += 'Unknown (channel 4). Sender: ' + util.inspect(sender.name);
        break;
        case 0x08: // warn request ACK
          debugtext += 'Warn request ACK';
          self._dispatch(reqID, undefined, (snac[idx++] << 8) + snac[idx++], (snac[idx++] << 8) + snac[idx++]);
        break;
        case 0x0A: // someone tried to send us a message but it wasn't able to be delivered
          debugtext += 'Missed message(s)';
          var channel, sender, numMissed, reason, len = snac.length;
          while (idx < len) {
            channel = (snac[idx++] << 8) + snac[idx++];
            sender = self._parseUserInfo(snac, idx, true);
            idx = sender[1];
            sender = sender[0];
            numMissed = (snac[idx++] << 8) + snac[idx++];
            reason = (snac[idx++] << 8) + snac[idx++];
            self.emit('missed', sender, numMissed, reason, channel);
          }
        break;
        case 0x0B:
          debugtext += '0x0B -- TODO';
          // TODO
        break;
        case 0x0C: // (optional) ack for sendIM
          debugtext += 'IM sent ACK';
          self._dispatch(reqID);
        break;
        case 0x14: // typing notification
          debugtext += 'Typing notification';
          idx += 10;
          var who = snac.toString('utf8', idx+1, idx+1+snac[idx]), notifyType;
          idx += 1+snac[idx];
          notifyType = (snac[idx++] << 8) + snac[idx];
          self.emit('typing', who, notifyType);
        break;
        default:
          debugtext += 'Unknown (0x' + subtypeID.toString(16) + ')';
      }
    break;
    case SNAC_SERVICES.INVITATION:
      debugtext += 'INVITATION > ';
      debugtext += 'Unknown (0x' + subtypeID.toString(16) + ')';
    break;
    case SNAC_SERVICES.ADMIN:
      debugtext += 'ADMIN > ';
      debugtext += 'Unknown (0x' + subtypeID.toString(16) + ')';
    break;
    case SNAC_SERVICES.POPUP:
      debugtext += 'POPUP > ';
      switch (subtypeID) {
        case 0x01: // error
          debugtext += 'Error';
        break;
        case 0x02: // popup message
          debugtext += 'URL: ';
          tlvs = extractTLVs(snac);
          var url = (tlvs[2] ? tlvs[2].toString() : undefined),
              msg = (tlvs[1] ? tlvs[1].toString() : undefined);
          debugtext += url + ', Message: ' + msg;
          self.emit('popup', msg, url);
        break;
        default:
          debugtext += 'Unknown (0x' + subtypeID.toString(16) + ')';
      }
    break;
    case SNAC_SERVICES.PRIVACY_MGMT:
      debugtext += 'PRIVACY_MGMT > ';
      switch (subtypeID) {
        case 0x03: // limits response
          debugtext += 'Service limits';
          tlvs = extractTLVs(snac);
          if (!self._state.svcInfo[SNAC_SERVICES.PRIVACY_MGMT]) {
            self._state.svcInfo[SNAC_SERVICES.PRIVACY_MGMT] = {};
            self._state.svcInfo[SNAC_SERVICES.PRIVACY_MGMT].maxVisibleSize = (tlvs[0x01][0] << 8) + tlvs[0x01][1];
            self._state.svcInfo[SNAC_SERVICES.PRIVACY_MGMT].maxInvisibleSize = (tlvs[0x02][0] << 8) + tlvs[0x02][1];
          }
          debugtext += ': maxVisibleSize = ' + ((tlvs[0x01][0] << 8) + tlvs[0x01][1]);
          debugtext += ', maxInivisibleSize = ' + ((tlvs[0x02][0] << 8) + tlvs[0x02][1]);
          self._dispatch(reqID);
        break;
        default:
          debugtext += 'Unknown (0x' + subtypeID.toString(16) + ')';
      }
    break;
    case SNAC_SERVICES.USAGE_STATS:
      debugtext += 'USAGE_STATS > ';
      debugtext += 'Unknown (0x' + subtypeID.toString(16) + ')';
    break;
    case SNAC_SERVICES.CHAT_NAV:
      debugtext += 'CHAT_NAV >';
      switch (subtypeID) {
        case 0x01:
          debugtext += ' Error';
          var code = (snac[idx++] << 8) + snac[idx++], subcode,
              msg = 'Could not join chat room: ', err;
          tlvs = extractTLVs(snac, idx);
          if (tlvs[0x08]) {
            subcode = (tlvs[0x08][0] << 8) + tlvs[0x08][1];
            msg += 'Invalid chat room name';
          } else
            msg += 'Unknown error';
          msg += ' (code: ' + code + ', subcode: ' + subcode + ')';
          err = new Error(msg);
          err.code = code;
          err.subcode = subcode;
          debugtext += ': ' + msg;
          self._dispatch(reqID, err);
        break;
        case 0x09: // single response for any request for this service ... UGH!
          tlvs = extractTLVs(snac);
          if (tlvs[0x02]) {
            debugtext += ' Service limits';
            if (!self._state.svcInfo[SNAC_SERVICES.CHAT_NAV])
              self._state.svcInfo[SNAC_SERVICES.CHAT_NAV] = {};
            self._state.svcInfo[SNAC_SERVICES.CHAT_NAV].maxRooms = tlvs[0x02][0];
            debugtext += ': maxRooms = ' + tlvs[0x02][0];
            debugtext += ';';
          }
          if (tlvs[0x03]) { // exchange info
            debugtext += ' Exchange info';
            if (!self._state.svcInfo[SNAC_SERVICES.CHAT_NAV].exchanges)
              self._state.svcInfo[SNAC_SERVICES.CHAT_NAV].exchanges = {};
            if (!Array.isArray(tlvs[0x03]))
              tlvs[0x03] = [tlvs[0x03]];
            for (var i=0,len=tlvs[0x03].length,id,exgTLVs; i<len; i++) {
              id = (tlvs[0x03][i][0] << 8) + tlvs[0x03][i][1];
              if (!self._state.svcInfo[SNAC_SERVICES.CHAT_NAV].exchanges[id])
                self._state.svcInfo[SNAC_SERVICES.CHAT_NAV].exchanges[id] = {};
              exgTLVs = extractTLVs(tlvs[0x03][i], 4);
              if (exgTLVs[0x02])
                self._state.svcInfo[SNAC_SERVICES.CHAT_NAV].exchanges[id].forClass = (exgTLVs[0x02][0] << 8) + exgTLVs[0x02][1];
              if (exgTLVs[0x03])
                self._state.svcInfo[SNAC_SERVICES.CHAT_NAV].exchanges[id].maxRooms = exgTLVs[0x03][0];
              if (exgTLVs[0xC9])
                self._state.svcInfo[SNAC_SERVICES.CHAT_NAV].exchanges[id].flags = (exgTLVs[0xC9][0] << 8) + exgTLVs[0xC9][1];
              if (exgTLVs[0xD3])
                self._state.svcInfo[SNAC_SERVICES.CHAT_NAV].exchanges[id].description = exgTLVs[0xD3].toString();
              if (exgTLVs[0xD5])
                self._state.svcInfo[SNAC_SERVICES.CHAT_NAV].exchanges[id].createPerms = exgTLVs[0xD5][0];
              if (exgTLVs[0xD6])
                self._state.svcInfo[SNAC_SERVICES.CHAT_NAV].exchanges[id].charset1 = exgTLVs[0xD6].toString();
              if (exgTLVs[0xD7])
                self._state.svcInfo[SNAC_SERVICES.CHAT_NAV].exchanges[id].lang1 = exgTLVs[0xD7].toString();
              if (exgTLVs[0xD8])
                self._state.svcInfo[SNAC_SERVICES.CHAT_NAV].exchanges[id].charset2 = exgTLVs[0xD8].toString();
              if (exgTLVs[0xD9])
                self._state.svcInfo[SNAC_SERVICES.CHAT_NAV].exchanges[id].lang2 = exgTLVs[0xD9].toString();
            }
            //debug('exchange info: ' + util.inspect(self._state.svcInfo[SNAC_SERVICES.CHAT_NAV].exchanges, false, 4));
            debugtext += ';';
          }
          if (tlvs[0x04]) { // room info
            debugtext += ' Room info';
            var i = 0, roomInfo = {}, roomTLVs;
            roomInfo.exchange = (tlvs[0x04][i++] << 8) + tlvs[0x04][i++];
            roomInfo.cookie = tlvs[0x04].slice(++i, i+tlvs[0x04][i-1]).toArray();
            i += tlvs[0x04][i-1];
            roomInfo.instance = (tlvs[0x04][i++] << 8) + tlvs[0x04][i++];
            roomInfo.detailLevel = tlvs[0x04][i++];
            i += 2;
            roomTLVs = extractTLVs(tlvs[0x04], i);
            if (roomTLVs[0x6A])
              roomInfo.fqn = roomTLVs[0x6A].toString();
            if (roomTLVs[0xC9])
              roomInfo.flags = (roomTLVs[0xC9][0] << 8) + roomTLVs[0xC9][1];
            if (roomTLVs[0xCA])
              roomInfo.created = (roomTLVs[0xCA][0] << 24) + (roomTLVs[0xCA][1] << 16) + (roomTLVs[0xCA][2] << 8) + roomTLVs[0xCA][3];
            if (roomTLVs[0xD1])
              roomInfo.maxMsgLen = (roomTLVs[0xD1][0] << 8) + roomTLVs[0xD1][1];
            if (roomTLVs[0xD2])
              roomInfo.maxUsers = (roomTLVs[0xD2][0] << 8) + roomTLVs[0xD2][1];
            if (roomTLVs[0xD3])
              roomInfo.name = roomTLVs[0xD3].toString();
            if (roomTLVs[0xD5])
              roomInfo.createPerms = roomTLVs[0xD5][0];
            if (roomTLVs[0xD6])
              roomInfo.charset1 = roomTLVs[0xD6].toString();
            if (roomTLVs[0xD7])
              roomInfo.lang1 = roomTLVs[0xD7].toString();
            if (roomTLVs[0xD8])
              roomInfo.charset2 = roomTLVs[0xD8].toString();
            if (roomTLVs[0xD9])
              roomInfo.lang2 = roomTLVs[0xD9].toString();
            roomInfo.users = {};

            if (self._state.chatrooms[roomInfo.name] &&
                self._state.chatrooms[roomInfo.name].roomInfo)
              extend(true, self._state.chatrooms[roomInfo.name].roomInfo, roomInfo);
            else {
              self._state.chatrooms[roomInfo.name] = conn;
              conn.roomInfo = roomInfo;
            }
            self._dispatch(reqID, undefined, roomInfo);
            return;
          }
          self._dispatch(reqID);
        break;
        default:
          debugtext += ' Unknown (0x' + subtypeID.toString(16) + ')';
      }
    break;
    case SNAC_SERVICES.CHAT:
      debugtext += 'CHAT > ';
      switch (subtypeID) {
        case 0x02:
          debugtext += 'General room info -- Purposefully ignored';
          /*var roomInfo = {}, len, tlvcount, tlvs;
          roomInfo.exchange = (snac[idx++] << 8) + snac[idx++];
          len = snac[idx++];
          roomInfo.name = snac.slice(idx, idx+len).toString();
          idx += len;
          roomInfo.instance = (snac[idx++] << 8) + snac[idx++];
          roomInfo.detailLevel = snac[idx++];
          tlvcount = (snac[idx++] << 8) + snac[idx++];
          tlvs = extractTLVs(snac, idx, tlvcount);

          if (tlvs[0xD1])
            roomInfo.maxMsgLen = (tlvs[0xD1][0] << 8) + tlvs[0xD1][1];

          if (self._state.chatrooms[roomInfo.name] &&
              self._state.chatrooms[roomInfo.name].roomInfo)
            extend(true, self._state.chatrooms[roomInfo.name].roomInfo, roomInfo);
          else {
            self._state.chatrooms[roomInfo.name] = conn;
            conn.roomInfo = roomInfo;
          }*/
        break;
        case 0x03:
          debugtext += 'User(s) joined chat room (' + conn.roomInfo.name + '): ';
        case 0x04:
          var isJoin = (subtypeID === 0x03);
          if (!isJoin)
            debugtext += 'User(s) left a chat room (' + conn.roomInfo.name + '): ';
          var users = [], result;
          while (idx < snac.length) {
            result = self._parseUserInfo(snac, idx, true);
            users.push(result[0]);
            idx = result[1];
          }
          debugtext += users.map(function(u){return u.name}).join(', ');
          self.emit('chatusers' + (isJoin ? 'join' : 'leave'), conn.roomInfo.name, users);
        break;
        case 0x06:
          debugtext += 'Chat room message';
          var cookie, chan, sender, message, isWhisper;
          cookie = [snac[idx++], snac[idx++], snac[idx++], snac[idx++],
                    snac[idx++], snac[idx++], snac[idx++], snac[idx++]];
          chan = (snac[idx++] << 8) + snac[idx++];
          if (chan === 3) {
            var tlvs = extractTLVs(snac, idx);
            isWhisper = (typeof tlvs[0x01] === undefined);
            if (tlvs[0x03])
              sender = self._parseUserInfo(tlvs[0x03]);
            if (tlvs[0x05]) {
              message = {};
              var msgTLVs = extractTLVs(tlvs[0x05], 0);
              if (msgTLVs[0x02])
                message.charset = msgTLVs[0x02].toString();
              if (msgTLVs[0x03])
                message.lang = msgTLVs[0x03].toString();
              if (msgTLVs[0x01])
                message.text = msgTLVs[0x01].toString();
            }
            debugtext += ' on (' + conn.roomInfo.name + ') by (' + sender.name + '): ' + message.text;
            self.emit('chatmsg', conn.roomInfo.name, sender, message.text);
          } else
            debugtext += ' on unexpected channel (' + chan + ')';
        break;
        case 0x08:
          debugtext += 'Warning level changed for chat room';
        break;
        case 0x09:
          debugtext += 'Chat room error';
        break;
        default:
          debugtext += 'Unknown (0x' + subtypeID.toString(16) + ')';
      }
    break;
    case SNAC_SERVICES.DIR_SEARCH:
      debugtext += 'DIR_SEARCH > ';
      debugtext += 'Unknown (0x' + subtypeID.toString(16) + ')';
    break;
    case SNAC_SERVICES.BART:
      debugtext += 'BART > ';
      switch (subtypeID) {
        case 0x01: // error
          debugtext += 'Error';
          var code = (snac[idx++] << 8) + snac[idx++], msg = GLOBAL_ERRORS_TEXT[code] || 'Unknown error code received: ' + code,
              err = new Error(msg);
          err.code = code;
          debugtext += ': ' + msg;
          self._dispatch(reqID, err);
        break;
        case 0x03: // icon upload ack
          debugtext += 'Icon upload ACK';
        break;
        case 0x05: // icon/media response
          debugtext += 'Incoming buddy icon for ';
          var who = snac.toString('utf8', idx+1, idx+1+snac[idx]), flags, type, hash, len, icon;
          idx += 1+snac[idx];
          type = (snac[idx++] << 8) + snac[idx++];
          flags = snac[idx++];
          len = snac[idx++];
          hash = snac.slice(idx, idx+len);
          idx += len;
          len = (snac[idx++] << 8) + snac[idx++];
          icon = snac.slice(idx, idx+len);
          debugtext += who;
          self._dispatch(reqID, undefined, icon, (type === 0x0000 ? 'small' : 'normal'));
          self.emit('icon', who, icon, (type === 0x0000 ? 'small' : 'normal'));
        break;
        default:
          debugtext += 'Unknown (0x' + subtypeID.toString(16) + ')';
      }
    break;
    case SNAC_SERVICES.SSI:
      debugtext += 'SSI > ';
      switch (subtypeID) {
        case 0x01: // error
          debugtext += 'Error';
          var code = (snac[idx++] << 8) + snac[idx++], msg = GLOBAL_ERRORS_TEXT[code] || 'Unknown error code received: ' + code,
              err = new Error(msg);
          err.code = code;
          debugtext += ': ' + msg;
          self._dispatch(reqID, err);
        break;
        case 0x03: // limits response
          debugtext += 'Service limits';
          var tlvIdx = 0;
          tlvs = extractTLVs(snac);
          if (!self._state.svcInfo[SNAC_SERVICES.SSI]) {
            self._state.svcInfo[SNAC_SERVICES.SSI] = {};
            self._state.svcInfo[SNAC_SERVICES.SSI].maxContacts = (tlvs[0x04][tlvIdx++] << 8) + tlvs[0x04][tlvIdx++];
            self._state.svcInfo[SNAC_SERVICES.SSI].maxGroups = (tlvs[0x04][tlvIdx++] << 8) + tlvs[0x04][tlvIdx++];
            self._state.svcInfo[SNAC_SERVICES.SSI].maxPermitContacts = (tlvs[0x04][tlvIdx++] << 8) + tlvs[0x04][tlvIdx++];
            self._state.svcInfo[SNAC_SERVICES.SSI].maxDenyContacts = (tlvs[0x04][tlvIdx++] << 8) + tlvs[0x04][tlvIdx++];
            self._state.svcInfo[SNAC_SERVICES.SSI].maxBitmasks = (tlvs[0x04][tlvIdx++] << 8) + tlvs[0x04][tlvIdx++];
            self._state.svcInfo[SNAC_SERVICES.SSI].maxPresenceFields = (tlvs[0x04][tlvIdx++] << 8) + tlvs[0x04][tlvIdx++];
            self._state.svcInfo[SNAC_SERVICES.SSI].maxIgnores = (tlvs[0x04][28] << 8) + tlvs[0x04][29];
          }
          debugtext += ': maxContacts = ' + self._state.svcInfo[SNAC_SERVICES.SSI].maxContacts;
          debugtext += ', maxGroups = ' + self._state.svcInfo[SNAC_SERVICES.SSI].maxGroups;
          debugtext += ', maxPermitContacts = ' + self._state.svcInfo[SNAC_SERVICES.SSI].maxPermitContacts;
          debugtext += ', maxDenyContacts = ' + self._state.svcInfo[SNAC_SERVICES.SSI].maxDenyContacts;
          debugtext += ', maxBitmasks = ' + self._state.svcInfo[SNAC_SERVICES.SSI].maxBitmasks;
          debugtext += ', maxPresenceFields = ' + self._state.svcInfo[SNAC_SERVICES.SSI].maxPresenceFields;
          debugtext += ', maxIgnores = ' + self._state.svcInfo[SNAC_SERVICES.SSI].maxIgnores;
          self._dispatch(reqID);
        break;
        case 0x06: // response to contact list request -- should only happen once (upon login)
          debugtext += 'My buddy list';
          if (self._state.SSI.activated)
            break;
          idx++; // skip SSI protocol version number for now
          var numItems = (snac[idx++] << 8) + snac[idx++], item;
          // _totalSSICount + lastModified are used for verifying SSI list without actually having to
          // retrieve the entire list again from the server -- useful if module users want to keep a
          // local copy of their contact list on some persistent medium
          self.contacts._totalSSICount += numItems;
          for (var i=0; i<numItems; i++) {
            item = self._parseSSIItem(snac, idx);

            // keep track of which group and item IDs are currently in use -- contact list or otherwise
            if (typeof self.contacts._usedIDs[item.groupID] === 'undefined')
              self.contacts._usedIDs[item.groupID] = {};
            if (typeof self.contacts._usedIDs[item.groupID][item.itemID] === 'undefined')
              self.contacts._usedIDs[item.groupID][item.itemID] = true;

            if (item.type === 0x00 || item.type === 0x01 || item.type === 0x02 || item.type === 0x03
                || item.type === 0x04 || item.type === 0x05)
              self._state.SSI._temp.push(item);
            idx = item.nextIdx;
          }

          if (!moreFollows) { // buffer the entire SSI list before continuing
            var items = {};
            for (var i=0,len=self._state.SSI._temp.length; i<len; i++) {
              item = self._state.SSI._temp[i];
              if (item.type === 0x02) // permitted contacts
                self.contacts.permit[item.itemID] = { name: item.name, item: item.itemID, group: item.groupID };
              else if (item.type === 0x03) // denied contacts
                self.contacts.deny[item.itemID] = { name: item.name, item: item.itemID, group: item.groupID };
              else if (item.type === 0x04) { // permit/deny preferences
                if (item.tlvs[0xCA]) // permit/deny mode
                  self.contacts.prefs.pdmode = item.tlvs[0xCA][0];
              } else if (item.type === 0x05 && item.tlvs[0xD6] && item.tlvs[0xC9]) { // contact list preferences
              } else if (item.type === 0x00 || (item.groupID > 0x00 && item.type === 0x01)) { // groups and contacts
                if (typeof items[item.type] === 'undefined')
                  items[item.type] = {};
                if (item.type === 0x01)
                  items[item.type][item.groupID] = item;
                else {
                  if (typeof items[item.type][item.groupID] === 'undefined')
                    items[item.type][item.groupID] = {};
                  items[item.type][item.groupID][item.itemID] = item;
                }
              }
            }
            for (var i=0,groups=Object.keys(items[0x01]),len=groups.length,group; i<len; i++) {
              group = groups[i];
              self.contacts.list[group] = {
                name: items[0x01][group].name,
                contacts: {},
                group: group,
                item: items[0x01][group].itemID,
                type: 0x01
              };
              if (items[0x01][group].tlvs && items[0x01][group].tlvs[0x00C8]) {
                // add contacts
                for (var j=0,len2=items[0x01][group].tlvs[0x00C8].length,contact; j<len2; j+=2) {
                  contact = (items[0x01][group].tlvs[0x00C8][j] << 8) + items[0x01][group].tlvs[0x00C8][j+1];
                  self.contacts.list[group].contacts[contact] = {
                    name: items[0x00][group][contact].name,
                    status: USER_STATUSES.OFFLINE,
                    localInfo: {
                      alias: (items[0x00][group][contact].tlvs && items[0x00][group][contact].tlvs[0x0131]
                              ? items[0x00][group][contact].tlvs[0x0131].toString() : undefined),
                      emailAddress: (items[0x00][group][contact].tlvs && items[0x00][group][contact].tlvs[0x0137]
                                     ? items[0x00][group][contact].tlvs[0x0137].toString() : undefined),
                      homePhoneNum: (items[0x00][group][contact].tlvs && items[0x00][group][contact].tlvs[0x0138]
                                     ? items[0x00][group][contact].tlvs[0x0138].toString() : undefined),
                      cellPhoneNum: (items[0x00][group][contact].tlvs && items[0x00][group][contact].tlvs[0x0139]
                                     ? items[0x00][group][contact].tlvs[0x0139].toString() : undefined),
                      smsPhoneNum: (items[0x00][group][contact].tlvs && items[0x00][group][contact].tlvs[0x013A]
                                    ? items[0x00][group][contact].tlvs[0x013A].toString() : undefined),
                      workPhoneNum: (items[0x00][group][contact].tlvs && items[0x00][group][contact].tlvs[0x0158]
                                     ? items[0x00][group][contact].tlvs[0x0158].toString() : undefined),
                      otherPhoneNum: (items[0x00][group][contact].tlvs && items[0x00][group][contact].tlvs[0x0159]
                                      ? items[0x00][group][contact].tlvs[0x0159].toString() : undefined),
                      notes: (items[0x00][group][contact].tlvs && items[0x00][group][contact].tlvs[0x013C]
                              ? items[0x00][group][contact].tlvs[0x013C].toString() : undefined)
                    },
                    awaitingAuth: (items[0x00][group][contact].tlvs && items[0x00][group][contact].tlvs[0x0066] ? true : false),
                    alert: (items[0x00][group][contact].tlvs && items[0x00][group][contact].tlvs[0x013D]
                            ? { when: items[0x00][group][contact].tlvs[0x013D][0],
                                how: items[0x00][group][contact].tlvs[0x013D][1],
                                sound: (items[0x00][group][contact].tlvs[0x013D][0] === 0x02
                                        ? items[0x00][group][contact].tlvs[0x013E] : undefined)
                              } : undefined),
                    group: group,
                    item: contact,
                    type: 0x00
                  };
                }
              }
            }
            self.contacts.lastModified = new Date(((snac[idx++] << 24) + (snac[idx++] << 16) + (snac[idx++] << 8) + snac[idx++]) * 1000);
            self._dispatch(reqID);
          }
        break;
        case 0x0E: // SSI modification ack (add/delete/other modification)
          debugtext += 'Modification ACK';
          var result = (snac[idx++] << 8) + snac[idx++];
          if (result === SSI_ACK_RESULTS.SUCCESS)
            self._dispatch(reqID);
          else {
            var err = new Error(SSI_ACK_RESULTS_TEXT[result]);
            err.code = result;
            self._dispatch(reqID, err);
          }
        break;
        case 0x13: // 'you were added' message
          debugtext += 'You were added to the buddy list of ';
          var who = snac.toString('utf8', idx+1, idx+1+snac[idx]);
          debugtext += who;
          self.emit('added', who);
        break;
        case 0x19: // authorization request
          debugtext += 'Authorization request';
          // use SSI (0x13) 0x1A to send reply
        break;
        case 0x1B: // authorization reply
          debugtext += 'Authorization reply';
        break;
        default:
          debugtext += 'Unknown (0x' + subtypeID.toString(16) + ')';
      }
    break;
    case SNAC_SERVICES.ICQ_EXT:
      debugtext += 'ICQ_EXT > ';
      debugtext += 'Unknown (0x' + subtypeID.toString(16) + ')';
    break;
    default:
      debugtext += 'UNKNOWN (0x' + serviceID.toString(16) + ')';
  }
  debug(debugtext);
};

OscarConnection.prototype._mergeInfo = function(who, info) {
  var check = this._SSIFindContact(who);
  if (check[1] !== -1) {
    var contact = this.contacts.list[check[0]].contacts[check[1]];
    if (typeof info.status !== 'undefined')
      contact.status = info.status;
    if (typeof info.awaitingAuth !== 'undefined')
      contact.awaitingAuth = info.awaitingAuth;
    if (typeof info.localInfo !== 'undefined')
      contact.localInfo = extend(true, contact.localInfo || {}, info.localInfo);
    if (typeof info.alert !== 'undefined')
      contact.alert = extend(true, contact.alert || {}, info.alert);
    if (typeof info.name !== 'undefined')
      contact.name = info.name;
    if (typeof info.fullname !== 'undefined')
      contact.fullname = info.fullname;
    if (typeof info.warnLevel !== 'undefined')
      contact.warnLevel = info.warnLevel;
    if (typeof info.class !== 'undefined')
      contact.class = info.class;
    if (typeof info.memberSince !== 'undefined')
      contact.memberSince = info.memberSince;
    if (typeof info.onlineSince !== 'undefined')
      contact.onlineSince = info.onlineSince;
    contact.idleMins = info.idleMins;
    if (typeof info.flags  !== 'undefined')
      contact.flags = info.flags;
    if (typeof info.IP !== 'undefined')
      contact.IP = info.IP;
    if (typeof info.capabilities !== 'undefined')
      contact.capabilities = info.capabilities;
    if (typeof info.instanceNum !== 'undefined')
      contact.instanceNum = info.instanceNum;
    contact.profileSetOn = info.profileSetOn;
    contact.awaySetOn = info.awaySetOn;
    if (typeof info.countryCode !== 'undefined')
      contact.countryCode = info.countryCode;
    if (typeof info.icons !== 'undefined')
      contact.icons = info.icons;
    contact.statusMsg = info.statusMsg;
    contact.mood = info.mood;
  }
};

OscarConnection.prototype._parseSSIItem = function(data, idx) {
  var name, groupID, itemID, type, dataLen, tlvs;
  name = data.toString('utf8', idx+2, idx+2+((data[idx] << 8) + data[idx+1]));
  idx += 2+((data[idx] << 8) + data[idx+1]);
  groupID = (data[idx++] << 8) + data[idx++];
  itemID = (data[idx++] << 8) + data[idx++];
  type = (data[idx++] << 8) + data[idx++];
  dataLen = (data[idx] << 8) + data[idx+1];

  if (dataLen > 0) {
    var itemdata = data.slice(idx+2, idx+2+dataLen);
    tlvs = extractTLVs(itemdata, 0);
  }
  return { name: name, groupID: groupID, itemID: itemID, type: type, tlvs: tlvs, nextIdx: idx+2+dataLen };
};

OscarConnection.prototype._parseUserInfo = function(data, idx, skipExtra) {
  var info = {
    name: undefined,
    fullname: undefined,
    warnLevel: undefined,
    class: undefined,
    memberSince: undefined,
    onlineSince: undefined,
    idleMins: undefined, // the client actually tells AOL when to start and stop counting idle time, so this value could be unreliable
    flags: undefined,
    status: undefined,
    IP: undefined,
    capabilities: undefined,
    instanceNum: undefined,
    profileSetOn: undefined,
    awaySetOn: undefined,
    countryCode: undefined,
    icons: undefined,
    statusMsg: undefined,
    mood: undefined
  }, tlvs, extraTLVs, numTLVs, lastIdx;
  idx = idx || 0;
  info.name = data.toString('ascii', idx+1, idx+1+data[idx]);
  idx += 1+data[idx];
  info.warnLevel = (data[idx] << 8) + data[idx+1];
  idx += 2;
  numTLVs = (data[idx] << 8) + data[idx+1];
  idx += 2;
  tlvs = extractTLVs(data, idx, numTLVs);
  idx = tlvs[1];
  tlvs = tlvs[0];
  if (!skipExtra && idx < data.length) {
    idx += 1+data[idx]+2;
    numTLVs = (data[idx] << 8) + data[idx+1];
    idx += 2;
    extraTLVs = extractTLVs(data, idx, numTLVs)[0];
    for (var i=0,keys=Object.keys(extraTLVs),len=keys.length; i<len; i++) {
      if (typeof tlvs[keys[i]] === 'undefined' || tlvs[keys[i]].length === 0)
        tlvs[keys[i]] = extraTLVs[keys[i]];
    }
  }
  if (tlvs[0x0001])
    info.class = (tlvs[0x0001][0] << 8) + tlvs[0x0001][1];
  if (tlvs[0x0002])
    info.memberSince = new Date(((tlvs[0x0002][0] << 24) + (tlvs[0x0002][1] << 16) + (tlvs[0x0002][2] << 8) + tlvs[0x0002][3]) * 1000);
  else if (tlvs[0x0005])
    info.memberSince = new Date(((tlvs[0x0005][0] << 24) + (tlvs[0x0005][1] << 16) + (tlvs[0x0005][2] << 8) + tlvs[0x0005][3]) * 1000);
  if (tlvs[0x0003])
    info.onlineSince = new Date(((tlvs[0x0003][0] << 24) + (tlvs[0x0003][1] << 16) + (tlvs[0x0003][2] << 8) + tlvs[0x0003][3]) * 1000);
  if (tlvs[0x0004])
    info.idleMins = (tlvs[0x0004][0] << 8) + tlvs[0x0004][1];
  if (tlvs[0x0006]) {
    info.flags = (tlvs[0x0006][0] << 8) + tlvs[0x0006][1];
    info.status = (tlvs[0x0006][2] << 8) + tlvs[0x0006][3];
  }
  if (tlvs[0x000A])
    info.IP = '' + tlvs[0x000A][0] + '.' + tlvs[0x000A][1] + '.' + tlvs[0x000A][2] + '.' + tlvs[0x000A][3];
  if (tlvs[0x000D] && tlvs[0x000D].length > 0) {
    var cap;
    info.capabilities = [];
    for (var i=0,len=tlvs[0x000D].length,cap; i<len; i+=16)
      info.capabilities.push(tlvs[0x000D].slice(i, i+16).toArray());
  }
  if (tlvs[0x0014])
    info.instanceNum = tlvs[0x0014][0];
  if (tlvs[0x0018])
    info.fullname = tlvs[0x0018].toString();
  if (tlvs[0x001D]) {
    for (var i=0,len=tlvs[0x001D].length,datalen,media; i<len;) {
      datalen = tlvs[0x001D][i+3];
      media = {
        type: (tlvs[0x001D][i++] << 8) + tlvs[0x001D][i++],
        flags: tlvs[0x001D][i++],
        data: tlvs[0x001D].slice(++i, i+datalen)
      };
      i+=datalen;
      if (media.type === 0x02) { // a status/available message
        if (media.data.length >= 4) {
          var encoding = 'utf8', pos = 0;
          datalen = (media.data[pos++] << 8) + media.data[pos++];
          pos += datalen;
          if ((media.data[pos++] << 8) + media.data[pos++] === 0x0001) {
            pos += 2;
            media.encoding = media.data.toString('ascii', pos+2, pos+2+((media.data[pos] << 8) + media.data[pos+1])).toLowerCase();
          }
          // ignore media.encoding for now, until we can get some more common encodings for Buffer
          media.data = media.data.toString('utf8', 2, 2+datalen);
        } else
          media.data = null;
        info.statusMsg = media.data;
      } else if (media.type === 0x0E) { // ICQ mood
        var moodMap = {
          icqmood0: 'shopping',
          icqmood1: 'bathing',
          icqmood2: 'sleepy',
          icqmood3: 'party',
          icqmood4: 'beer',
          icqmood5: 'thinking',
          icqmood6: 'plate',
          icqmood7: 'tv',
          icqmood8: 'meeting',
          icqmood9: 'coffee',
          icqmood10: 'music',
          icqmood11: 'suit',
          icqmood12: 'cinema',
          icqmood13: 'smile-big',
          icqmood14: 'phone',
          icqmood15: 'console',
          icqmood16: 'studying',
          icqmood17: 'sick',
          icqmood18: 'sleeping',
          icqmood19: 'surfing',
          icqmood20: 'internet',
          icqmood21: 'working',
          icqmood22: 'typing',
          icqmood23: 'angry'
        };
        media.data = media.data.toString().toLowerCase();
        info.mood = (typeof moodMap[media.data] !== 'undefined' ? moodMap[media.data] : undefined);
      } else if (media.type === 0x00 || media.type === 0x01) { // icon
        if (media.data.length > 0) {
          media.data = media.data.toArray();
          if (media.data.length === 5 && media.data[0] === 0x02 && media.data[1] === 0x01
              && media.data[2] === 0xD2 && media.data[3] === 0x04 && media.data[4] === 0x72) {
            // according to AOL's short-lived oscar docs, this magic number indicates the user has explicitly chosen to have no icon
          } else if (media.flags === 0x0000 || media.flags === 0x0001) {
            // GIF/JPG/BMP (flags === 0 -> <=32 pixels && 2k size OR flags === 1 -> <=64 pixels && 7k size)
            if (!info.icons)
              info.icons = [];
            info.icons.push(media);
          }
        }
      }
    }
  }
  if (tlvs[0x0026])
    info.profileSetOn = new Date(((tlvs[0x0026][0] << 24) + (tlvs[0x0026][1] << 16) + (tlvs[0x0026][2] << 8) + tlvs[0x0026][3]) * 1000);
  if (tlvs[0x0027])
    info.awaySetOn = new Date(((tlvs[0x0027][0] << 24) + (tlvs[0x0027][1] << 16) + (tlvs[0x0027][2] << 8) + tlvs[0x0027][3]) * 1000);
  if (tlvs[0x002A])
    info.countryCode = tlvs[0x0002A].toString();

  if (skipExtra)
    return [info, idx];
  else
    return info;
};

OscarConnection.prototype._downloadIcons = function(who, hashes, skipCheck, cb) {
  cb = arguments[arguments.length-1];
  if (typeof skipCheck === 'function')
    skipCheck = false;
  var self = this;
  var newHashes = [];
  if (!Array.isArray(hashes)) {
    if (typeof hashes === 'string')
      hashes = [{ type: 0x0001, flags: 0x00, data: hashes }];
    else
      hashes = [hashes];
  }
  /*
  // check for duplicate items
  for (var i=0,hlen=hashes.length,found,hexhash; i<hlen; i++) {
    hexhash = (typeof hashes[i].data !== 'string' ? toHexStr(hashes[i].data) : hashes[i].data);
    if (!found) {
      for (var j=0,nhlen=newHashes.length; j<nhlen; j++) {
        if ((typeof newHashes[j].data !== 'string' ? toHexStr(newHashes[j].data) : newHashes[j].data) === hexhash) {
          found = true;
          break;
        }
      }
    }
    if (!found)
      newHashes.push(hashes[i]);
  }
  if (newHashes.length === 0) {
    if (typeof cb === 'function')
      cb(new Error('No icons to get'));
    return;
  }

  // WORKAROUND: Use HTTP to download icons instead of from a second BOS server until the ECONNRESET issue is resolved
  var client = http.createClient('80', 'o.aimcdn.net');
  (function(toFetch) {
    var hash = toFetch.pop(), strhash = (typeof hash.data !== 'string' ? toHexStr(hash.data) : hash.data),
        thisFn = this, iconData, url, hashLen;
    hashLen = (typeof hash.data !== 'string' ? hash.data.length : hash.data.length/2);
    url = '/e/1/' + (hash.flags < 16 ? '0' : '') + hash.flags.toString(16) + (hashLen < 16 ? '0' : '') + hashLen.toString(16) + strhash;
    var req = client.request(url, { 'Host': 'o.aimcdn.net' });
    req.end();
    req.on('response', function (res) {
      debug('Attempting to download an icon for ' + who + ' ...');
      if (res.statusCode === 200) {
        res.on('data', function(data) {
          iconData = (!iconData ? data : bufferAppend(iconData, data);
        });
        res.on('end', function() {
          debug('Icon download successful for ' + who);
          process.nextTick(function() {
            if (typeof cb === 'function')
              cb(undefined, iconData, (hash.type === 0x0000 ? 'small' : 'normal'));
            else
              self.emit('icon', who, iconData, (hash.type === 0x0000 ? 'small' : 'normal'));
          });
          if (toFetch.length)
            process.nextTick(function() { thisFn.call(toFetch); });
        });
      } else {
        debug('Failed to download icon for ' + who + '. HTTP status === ' + res.statusCode);
        if (typeof cb === 'function')
          cb(new Error('No icon found'));
      }
    });
  })(newHashes);*/

  if (!skipCheck) {
    for (var i=0,hlen=hashes.length,found,hexhash; i<hlen; i++) {
      hexhash = (typeof hashes[i].data !== 'string' ? toHexStr(hashes[i].data) : hashes[i].data);
      found = (typeof self._state.iconQueue[hexhash] !== undefined);
      if (found && self._state.iconQueue[hexhash].users.indexOf(who) === -1)
        self._state.iconQueue[hexhash].users.push(who);
      if (!found) {
        found = newHashes.some(function(h) { return ((typeof h.data !== 'string' ? toHexStr(h.data) : h.data) === hexhash); });
        /*for (var j=0,nhlen=newHashes.length; j<nhlen; j++) {
          if ((typeof newHashes[j].data !== 'string' ? toHexStr(newHashes[j].data) : newHashes[j].data) === hexhash) {
            found = true;
            break;
          }
        }*/
      }
      if (!found)
        newHashes.push(hashes[i]);
    }
  } else
    newHashes = hashes;
  if (newHashes.length === 0) {
    if (typeof cb === 'function')
      cb(new Error('No icons to get or icons for ' + who + ' are already in the icon queue'));
    return;
  }

  if (self._state.serviceMap[SNAC_SERVICES.BART]) {
    debug('BART connection available ... retrieving ' + newHashes.length + ' icon(s) for \'' + who + '\' ....');
    var request = [who.length];
    request = request.concat(str2bytes(who));
    request.push(newHashes.length);
    for (var i=0,data; i<newHashes.length; i++) {
      if (!Array.isArray(newHashes[i].data)) {
        if (typeof newHashes[i].data === 'string')
          data = newHashes[i].data.match(/.{1,2}/g).map(function(x) { return parseInt(x, 16); });
        else
          data = newHashes[i].data.toArray();
      }
      request.push(newHashes[i].type >> 8 & 0xFF);
      request.push(newHashes[i].type & 0xFF);
      request.push(newHashes[i].flags);
      request.push(newHashes[i].data.length);
      request = request.concat(data);
    }
    self._send(self._createFLAP(self._state.serviceMap[SNAC_SERVICES.BART], FLAP_CHANNELS.SNAC,
      self._createSNAC(SNAC_SERVICES.BART, 0x04, NO_FLAGS,
        request
      )
    ), cb);
  } else {
    debug('No BART connection available -- adding ' + newHashes.length + ' icon retrieval(s) for ' + who + ' to the queue ...');
    for (var i=0,hexhash; i<newHashes.length; i++) {
      hexhash = (typeof newHashes[i].data === 'string' ? newHashes[i].data : toHexStr(newHashes[i].data));
      if (typeof self._state.iconQueue[hexhash] === 'undefined')
        self._state.iconQueue[hexhash] = { obj: newHashes[i], users: [who] };
    }
  }
};

OscarConnection.prototype._login = function(error, conn, loginCb, reentry) {
  var self = this;
  if (error) {
    if (typeof loginCb === 'function')
      process.nextTick(function(){ loginCb(error); });
    else
      throw error;
    return;
  }
  if (typeof reentry === 'undefined') {
    reentry = -1;
    // request salt from server for md5 hashing for password
    self._send(conn, self._createFLAP(conn, FLAP_CHANNELS.SNAC,
      self._createSNAC(SNAC_SERVICES.AUTH, 0x06, NO_FLAGS,
        self._createTLV(TLV_TYPES.SCREEN_NAME, self._options.connection.username)
      )
    ), function(e, salt) { process.nextTick(function(){ self._login(e, conn, loginCb, reentry + 1, salt); }); });
  } else {
    switch (reentry) {
      case 0: // server sent us the salt ('key') for our md5 password hashing
        // TODO: truncate password if necessary
        var salt = arguments[4], hash = [], oldhash, clientInfo = {};
        if (self._state.isAOL) {
          clientInfo.str = 'AOL Instant Messenger, version 5.9.3702/WIN32';
          clientInfo.id = [0x01, 0x09];
          clientInfo.vMajor = [0x00, 0x05];
          clientInfo.vMinor = [0x00, 0x09];
          clientInfo.vLesser = [0x00, 0x00];
          clientInfo.vBuild = [0x0E, 0x76];
        } else {
          clientInfo.str = 'ICQ Inc. - Product of ICQ (TM).2003a.5.45.1.3777.85';
          clientInfo.id = [0x01, 0x0A];
          clientInfo.vMajor = [0x00, 0x14];
          clientInfo.vMinor = [0x00, 0x34];
          clientInfo.vLesser = [0x00, 0x00];
          clientInfo.vBuild = [0x0C, 0x18];
        }
        oldhash = crypto.createHash('md5').update(salt).update(self._options.connection.password).update('AOL Instant Messenger (SM)').digest();
        for (var i=0,len=oldhash.length; i<len; i++)
          hash[i] = oldhash.charCodeAt(i);
        self._send(conn, self._createFLAP(conn, FLAP_CHANNELS.SNAC,
          self._createSNAC(SNAC_SERVICES.AUTH, 0x02, NO_FLAGS,
                    self._createTLV(TLV_TYPES.SCREEN_NAME, self._options.connection.username)
            .concat(self._createTLV(TLV_TYPES.CLIENT_ID_STR, clientInfo.str))
            .concat(self._createTLV(TLV_TYPES.PASSWORD_HASH, hash))
            .concat(self._createTLV(TLV_TYPES.CLIENT_ID, clientInfo.id))
            .concat(self._createTLV(TLV_TYPES.CLIENT_VER_MAJOR, clientInfo.vMajor))
            .concat(self._createTLV(TLV_TYPES.CLIENT_VER_MINOR, clientInfo.vMinor))
            .concat(self._createTLV(TLV_TYPES.CLIENT_VER_LESSER, clientInfo.vLesser))
            .concat(self._createTLV(TLV_TYPES.CLIENT_VER_BUILD, clientInfo.vBuild))
            .concat(self._createTLV(TLV_TYPES.DISTRIB_NUM, [0x00, 0x00, 0x01, 0x11]))
            .concat(self._createTLV(TLV_TYPES.CLIENT_LANG, 'en'))
            .concat(self._createTLV(TLV_TYPES.CLIENT_COUNTRY, 'us'))
            .concat(self._createTLV(TLV_TYPES.MULTI_CONN, [(self._options.connection.allowMultiLogin ? 0x01 : 0x03)]))
          )
        ), function(e, server, cookie) { process.nextTick(function(){ self._login(e, conn, loginCb, reentry + 1, server, cookie); }); });
      break;
      case 1: // server sent us the BOS server to connect to
        var server = arguments[4].substring(0, arguments[4].indexOf(':')), port = parseInt(arguments[4].substring(arguments[4].indexOf(':')+1));
        debug('Connecting to BOS server @ ' + server + ':' + port);
        conn.authCookie = arguments[5];
        conn.isTransferring = true;
        //conn.end();
        conn.destroy();
        process.nextTick(function() {
          conn.tmrConn = setTimeout(self._fnTmrConn, self._options.connection.connTimeout, loginCb);
          conn.connect(port, server);
        });
      break;
      case 2: // server asked us for our auth cookie
        self._send(conn, self._createFLAP(conn, FLAP_CHANNELS.CONN_NEW,
          [0x00, 0x00, 0x00, 0x01].concat(self._createTLV(TLV_TYPES.AUTH_COOKIE, conn.authCookie))
        ), function(e) { process.nextTick(function(){self._login(e, conn, loginCb, reentry + 1);}); });
      break;
      case 3: // server sent us their list of supported services
        var serVers = [], defServices = flip(SNAC_SERVICES),
            services = Object.keys(conn.availServices).map(function(x){return parseInt(x);}).filter(function(svc) {
              return (typeof defServices[svc] !== 'undefined'
                      && (conn.neededServices === null || typeof conn.neededServices[svc] !== 'undefined'));
        });
        if (services.indexOf(SNAC_SERVICES.GENERIC) === -1)
          services.unshift(SNAC_SERVICES.GENERIC);
        for (var i=0,len=services.length; i<len; i++) {
          if (typeof self._state.serviceMap[services[i]] === 'undefined' && services[i] !== SNAC_SERVICES.CHAT)
            self._state.serviceMap[services[i]] = conn;
          serVers.push(services[i] >> 8 & 0xFF);
          serVers.push(services[i] & 0xFF);
          serVers.push(SNAC_SERVICE_VERSIONS[services[i]] >> 8 & 0xFF);
          serVers.push(SNAC_SERVICE_VERSIONS[services[i]] & 0xFF);
        }
        self._send(conn, self._createFLAP(conn, FLAP_CHANNELS.SNAC,
          self._createSNAC(SNAC_SERVICES.GENERIC, 0x17, NO_FLAGS,
            serVers
          )
        ), function(e) { process.nextTick(function(){ self._login(e, conn, loginCb, reentry + 1); }); });
      break;
      case 4: // server acked our service versions
        self._send(conn, self._createFLAP(conn, FLAP_CHANNELS.SNAC,
          self._createSNAC(SNAC_SERVICES.GENERIC, 0x06, NO_FLAGS
          )
        ), function(e) { process.nextTick(function(){ self._login(e, conn, loginCb, reentry + 1); }); });
      break;
      case 5: // server sent us rate limit groups, if available
        // only ack if the server actually sent us groups
        var groups = conn.rateLimitGroups;
        if (groups.length > 0) {
          for (var i=0,len=groups.length*2,group; i<len; i+=2) {
            group = groups[i];
            groups[i] = (group & 0xFF);
            groups.splice(i, 0, (group >> 8 & 0xFF));
          }
          self._send(conn, self._createFLAP(conn, FLAP_CHANNELS.SNAC,
            self._createSNAC(SNAC_SERVICES.GENERIC, 0x08, NO_FLAGS,
              groups
            )
          ));
        }

        conn.respCount = 0;
        if (!conn.neededServices || typeof conn.neededServices[SNAC_SERVICES.LOCATION] !== 'undefined') {
          conn.respCount++;
          self._send(self._createFLAP(conn, FLAP_CHANNELS.SNAC,
            self._createSNAC(SNAC_SERVICES.LOCATION, 0x02, NO_FLAGS
            )
          ), function(e) { process.nextTick(function(){ self._login(e, conn, loginCb, reentry + 1); }); });
        }

        /*if (!conn.neededServices || typeof conn.neededServices[SNAC_SERVICES.LIST_MGMT] !== 'undefined') {
          conn.respCount++;
          self._send(self._createFLAP(conn, FLAP_CHANNELS.SNAC,
            self._createSNAC(SNAC_SERVICES.LIST_MGMT, 0x02, NO_FLAGS
            )
          ), function(e) { process.nextTick(function(){ self._login(e, conn, loginCb, reentry + 1); }); });
        }*/

        if (!conn.neededServices || typeof conn.neededServices[SNAC_SERVICES.ICBM] !== 'undefined') {
          conn.respCount++;
          self._send(self._createFLAP(conn, FLAP_CHANNELS.SNAC,
            self._createSNAC(SNAC_SERVICES.ICBM, 0x04, NO_FLAGS
            )
          ), function(e) { process.nextTick(function(){ self._login(e, conn, loginCb, reentry + 1); }); });
        }

        if (self._state.serviceMap[SNAC_SERVICES.CHAT_NAV] === conn) {
          conn.respCount++;
          self._send(self._createFLAP(conn, FLAP_CHANNELS.SNAC,
            self._createSNAC(SNAC_SERVICES.CHAT_NAV, 0x02, NO_FLAGS
            )
          ), function(e) { process.nextTick(function(){ self._login(e, conn, loginCb, reentry + 1); }); });
        }

        /*if (!conn.neededServices || typeof conn.neededServices[SNAC_SERVICES.SSI] !== 'undefined') {
          conn.respCount++;
          self._send(self._createFLAP(conn, FLAP_CHANNELS.SNAC,
            self._createSNAC(SNAC_SERVICES.PRIVACY_MGMT, 0x02, NO_FLAGS
            )
          ), function(e) { process.nextTick(function(){ self._login(e, conn, loginCb, reentry + 1); }); });
        }*/

        if (!conn.neededServices || typeof conn.neededServices[SNAC_SERVICES.SSI] !== 'undefined') {
          conn.respCount++;
          self._send(self._createFLAP(conn, FLAP_CHANNELS.SNAC,
            self._createSNAC(SNAC_SERVICES.SSI, 0x02, NO_FLAGS
            )
          ), function(e) { process.nextTick(function(){ self._login(e, conn, loginCb, reentry + 1); }); });
        }

        if (conn.respCount === 0)
          process.nextTick(function() { self._login(undefined, conn, loginCb, reentry + 1); });
      break;
      case 6: // server sent us limits for some service
        if (conn.respCount > 0)
          conn.respCount--;
        if (conn.respCount === 0) {
          // set new ICBM settings for all channels (even though we only use channel 1 right now):
          //   * Flags note: Digsby sends a crazy value like 0x000003DB ....
          //   * max msg size === 8000 (0x1F40) characters?
          //   * min msg interval === 0 seconds
          if ((!conn.neededServices || typeof conn.neededServices[SNAC_SERVICES.ICBM] !== 'undefined')
               && conn.availServices[SNAC_SERVICES.ICBM]) {
            var warnRecv = 0xE703,//self._state.svcInfo[SNAC_SERVICES.ICBM].maxReceiverWarn,// \
                warnSend = 0x8403,//self._state.svcInfo[SNAC_SERVICES.ICBM].maxSenderWarn, // -- use defaults for these
                flags = ICBM_FLAGS.CHANNEL_MSGS_ALLOWED
                        | ICBM_FLAGS.MISSED_CALLS_ENABLED
                        | ICBM_FLAGS.TYPING_NOTIFICATIONS
                        | ICBM_FLAGS.EVENTS_ALLOWED
                        | ICBM_FLAGS.SMS_SUPPORTED
                        | ICBM_FLAGS.OFFLINE_MSGS_ALLOWED
                        | ICBM_FLAGS.USE_HTML_FOR_ICQ;
            self._send(self._createFLAP(conn, FLAP_CHANNELS.SNAC,
              self._createSNAC(SNAC_SERVICES.ICBM, 0x02, NO_FLAGS,
                [0x00, 0x00,  (flags >> 24 & 0xFF), (flags >> 16 & 0xFF), (flags >> 8 & 0xFF), (flags & 0xFF),  0x1F, 0x40,
                 (warnSend >> 8 & 0xFF), (warnSend & 0xFF),  (warnRecv >> 8 & 0xFF), (warnRecv & 0xFF),
                 0x00, 0x00, 0x00, 0x00]
              )
            ));
          }
          // send privacy settings
          /*if (self._state.serviceMap[SNAC_SERVICES.GENERIC] === conn) {
            self._send(self._createFLAP(conn, FLAP_CHANNELS.SNAC,
              self._createSNAC(SNAC_SERVICES.GENERIC, 0x14, NO_FLAGS,
                [0x00, 0x00, 0x00, (self._options.privacy.showIdle ? 0x01 : 0x00) | (self._options.privacy.showMemberSince ? 0x02 : 0x00)]
              )
            ));
          }*/
          // send client capabilities
          if ((!conn.neededServices || typeof conn.neededServices[SNAC_SERVICES.LOCATION] !== 'undefined')
               && conn.availServices[SNAC_SERVICES.LOCATION]) {
            self._send(self._createFLAP(conn, FLAP_CHANNELS.SNAC,
              self._createSNAC(SNAC_SERVICES.LOCATION, 0x04, NO_FLAGS,
                self._createTLV(0x05, CAPABILITIES.INTEROPERATE.concat(CAPABILITIES.TYPING))
              )
            ));
          }
          // send flags and status
          if (self._state.serviceMap[SNAC_SERVICES.GENERIC] === conn) {
            var status = self._state.status, flags = self._state.flags;
            self._send(conn, self._createFLAP(conn, FLAP_CHANNELS.SNAC,
              self._createSNAC(SNAC_SERVICES.GENERIC, 0x1E, NO_FLAGS,
                self._createTLV(0x06, [(flags >> 8 & 0xFF), (flags & 0xFF), (status >> 8 & 0xFF), (status & 0xFF)])
              )
            ));
          }
          // request current SSI data
          if (!self.contacts.list && (conn.neededServices === null || typeof conn.neededServices[SNAC_SERVICES.SSI] !== 'undefined')) {
            self.contacts.list = {};
            self.contacts.permit = {};
            self.contacts.deny = {};
            self.contacts.prefs = {};
            self._state.SSI = { activated: false, _temp: [] };
            self._send(self._createFLAP(conn, FLAP_CHANNELS.SNAC,
              self._createSNAC(SNAC_SERVICES.SSI, 0x04, NO_FLAGS
              )
            ), function(e) { process.nextTick(function(){ self._login(e, conn, loginCb, reentry + 1); }); });
          } else
            process.nextTick(function(){ self._login(undefined, conn, loginCb, reentry + 1); });
        }
      break;
      case 7:
          if (conn.neededServices === null || typeof conn.neededServices[SNAC_SERVICES.SSI] !== 'undefined') {
            // start receiving contact list notifications
            self._state.SSI.activated = true;
            self._send(conn, self._createFLAP(conn, FLAP_CHANNELS.SNAC,
              self._createSNAC(SNAC_SERVICES.SSI, 0x07, NO_FLAGS
              )
            ));
          }
          // ... and then send the client ready message
          var data = [], services = Object.keys(conn.neededServices ? conn.neededServices : SNAC_SERVICE_VERSIONS).map(function(x){return parseInt(x);});
          if (services.indexOf(SNAC_SERVICES.GENERIC) === -1)
            services.unshift(SNAC_SERVICES.GENERIC);
          for (var i=0,len=services.length; i<len; i++) {
            data = data.concat([
              services[i] >> 8, services[i] & 0xFF,
              SNAC_SERVICE_VERSIONS[services[i]] >> 8, SNAC_SERVICE_VERSIONS[services[i]] & 0xFF,
              SNAC_SERVICE_TOOL_IDS[services[i]] >> 8, SNAC_SERVICE_TOOL_IDS[services[i]] & 0xFF,
              SNAC_SERVICE_TOOL_VERSIONS[services[i]] >> 8, SNAC_SERVICE_TOOL_VERSIONS[services[i]] & 0xFF
            ]);
          }
          self._send(conn, self._createFLAP(conn, FLAP_CHANNELS.SNAC,
            self._createSNAC(SNAC_SERVICES.GENERIC, 0x02, NO_FLAGS,
              data
            )
          ));
          conn.isReady = true;
          if (typeof loginCb === 'function')
            process.nextTick(function(){ loginCb(); });
      break;
      default:
        var err = new Error('Bad _login() state');
        if (typeof loginCb === 'function')
          process.nextTick(function(){ loginCb(err); });
        else
          throw err;
    }
  }
};

OscarConnection.prototype._createFLAP = function(conn, channel, value) {
  if (typeof channel !== 'number' || channel > 0x05 || channel < 0x01)
    throw new Error('Invalid channel');

  if (typeof value === 'undefined')
    value = [];
  else {
    if (!Array.isArray(value)) {
      if (typeof value === 'number')
        value = splitNum(value);
      else
        value = str2bytes(''+value);
    } else {
      for (var i=0,len=value.length; i<len; i++) {
        if (typeof value[i] !== 'number') {
          if (!isNaN(parseInt(''+value[i])))
            value[i] = parseInt(''+value[i]);
          else
            throw new Error('_createFLAP :: Only numbers can be in an Array value. Found a(n) ' + typeof value[i] + ' at index ' + i + ': ' + util.inspect(value[i]));
        }
        if (value[i] > 0xFF)
          Array.prototype.splice.apply(value, [i, 1].concat(splitNum(value[i])));
      }
    }
  }

  var seqNum = conn.seqNum = (conn.seqNum === 0x7FFF ? 0 : conn.seqNum + 1);
  return [0x2A,  channel,  (seqNum >> 8 & 0xFF), (seqNum & 0xFF),  (value.length >> 8 & 0xFF), (value.length & 0xFF)].concat(value);
};

OscarConnection.prototype._createSNAC = function(serviceID, subtypeID, flags, value) {
  if (!(Object.keys(SNAC_SERVICES).some(function(x){return SNAC_SERVICES[x] === serviceID;})))
    throw new Error('Invalid SNAC service id');
  else if (typeof subtypeID !== 'number' || subtypeID < 1 || subtypeID > 0xFFFF)
    throw new Error('Invalid service subtype id');
  else if (typeof flags !== 'number' || flags > 0xFFFF)
    throw new Error('Invalid flags');

  if (typeof value === 'undefined')
    value = [];
  else {
    if (!Array.isArray(value)) {
      if (typeof value === 'number')
        value = splitNum(value);
      else
        value = str2bytes(''+value);
    } else {
      for (var i=0,len=value.length; i<len; i++) {
        if (typeof value[i] !== 'number') {
          if (!isNaN(parseInt(''+value[i])))
            value[i] = parseInt(''+value[i]);
          else
            throw new Error('_createSNAC :: Only numbers can be in an Array value. Found a(n) ' + typeof value[i] + ' at index ' + i + ': ' + util.inspect(value[i]));
        }
        if (value[i] > 0xFF)
          Array.prototype.splice.apply(value, [i, 1].concat(splitNum(value[i])));
      }
    }
  }
  var reqID;
  // HACK: Retrieving offline messages requires a SNAC request ID of 0 (??!)
  if (serviceID === SNAC_SERVICES.ICBM && subtypeID === 0x10)
    reqID = 0;
  else
    reqID = this._state.reqID = (this._state.reqID === 0x7FFFFFFF ? 1 : this._state.reqID + 1);
  return [(serviceID >> 8 & 0xFF), (serviceID & 0xFF),  (subtypeID >> 8 & 0xFF), (subtypeID & 0xFF),
          (flags >> 8 & 0xFF), (flags & 0xFF),  (reqID >> 24 & 0xFF), (reqID >> 16 & 0xFF), (reqID >> 8 & 0xFF), (reqID & 0xFF)].concat(value);
};

OscarConnection.prototype._createTLV = function(type, value) {
  if (typeof type !== 'number' || type < 1 || type > 0xFFFF)
    throw new Error('Invalid type');

  if (typeof value === 'undefined')
    value = [];
  else {
    if (!Array.isArray(value)) {
      if (typeof value === 'number')
        value = splitNum(value);
      else
        value = str2bytes(''+value);
    } else {
      for (var i=0,len=value.length; i<len; i++) {
        if (typeof value[i] !== 'number') {
          if (!isNaN(parseInt(''+value[i])))
            value[i] = parseInt(''+value[i]);
          else
            throw new Error('_createTLV :: Only numbers can be in an Array value. Found a(n) ' + typeof value[i] + ' at index ' + i + ': ' + util.inspect(value[i]));
        }
        if (value[i] > 0xFF)
          Array.prototype.splice.apply(value, [i, 1].concat(splitNum(value[i])));
      }
    }
  }

  return [(type >> 8 & 0xFF), (type & 0xFF),  (value.length >> 8 & 0xFF), (value.length & 0xFF)].concat(value);
};

OscarConnection.prototype._sendKeepAlive = function(conn) {
  if (!conn)
    conn = this._state.connections.main;
  if (conn && conn.isConnected)
    this._send(conn, this._createFLAP(conn, FLAP_CHANNELS.KEEPALIVE));
  else
    clearTimeout(conn.keepAliveTimer);
};

/**
 * Adopted from jquery's extend method. Under the terms of MIT License.
 *
 * http://code.jquery.com/jquery-1.4.2.js
 *
 * Modified by Brian White to use Array.isArray instead of the custom isArray method
 */
function extend() {
  // copy reference to target object
  var target = arguments[0] || {}, i = 1, length = arguments.length, deep = false, options, name, src, copy;

  // Handle a deep copy situation
  if (typeof target === 'boolean') {
    deep = target;
    target = arguments[1] || {};
    // skip the boolean and the target
    i = 2;
  }

  // Handle case when target is a string or something (possible in deep copy)
  if (typeof target !== 'object' && !typeof target === 'function')
    target = {};

  var isPlainObject = function(obj) {
    // Must be an Object.
    // Because of IE, we also have to check the presence of the constructor property.
    // Make sure that DOM nodes and window objects don't pass through, as well
    if (!obj || toString.call(obj) !== '[object Object]' || obj.nodeType || obj.setInterval)
      return false;
    
    var has_own_constructor = hasOwnProperty.call(obj, 'constructor');
    var has_is_property_of_method = hasOwnProperty.call(obj.constructor.prototype, 'isPrototypeOf');
    // Not own constructor property must be Object
    if (obj.constructor && !has_own_constructor && !has_is_property_of_method)
      return false;
    
    // Own properties are enumerated firstly, so to speed up,
    // if last one is own, then all properties are own.

    var last_key;
    for (key in obj)
      last_key = key;
    
    return typeof last_key === 'undefined' || hasOwnProperty.call(obj, last_key);
  };


  for (; i < length; i++) {
    // Only deal with non-null/undefined values
    if ((options = arguments[i]) !== null) {
      // Extend the base object
      for (name in options) {
        src = target[name];
        copy = options[name];

        // Prevent never-ending loop
        if (target === copy)
            continue;

        // Recurse if we're merging object literal values or arrays
        if (deep && copy && (isPlainObject(copy) || Array.isArray(copy))) {
          var clone = src && (isPlainObject(src) || Array.isArray(src)) ? src : Array.isArray(copy) ? [] : {};

          // Never move original objects, clone them
          target[name] = extend(deep, clone, copy);

        // Don't bring in undefined values
        } else if (typeof copy !== 'undefined')
          target[name] = copy;
      }
    }
  }

  // Return the modified object
  return target;
};

function extractTLVs(buffer, idxStart, tlvTotal) {
  var tlvs = {}, added = 0;
  for (var i=(typeof idxStart !== 'undefined' ? idxStart : 10),dataLen=buffer.length,tlvType,tlvLen; i<dataLen;) {
    tlvType = (buffer[i++] << 8) + buffer[i++];
    tlvLen = (buffer[i++] << 8) + buffer[i++];
    //debug('extractTLVs(buffer,' + (idxStart || 10) + ',' + tlvTotal + ') :: i == ' + i + ', buffer[i] === 0x' + buffer[i].toString(16) + ', tlvType == 0x' + tlvType.toString(16) + ', tlvLen == ' + tlvLen + ' (0x' + tlvLen.toString(16) + '), dataLen == ' + dataLen);
    if (tlvs[tlvType]) {
      if (!Array.isArray(tlvs[tlvType]))
        tlvs[tlvType] = [tlvs[tlvType]];
      tlvs[tlvType].push((tlvLen > 0 ? buffer.slice(i, i+tlvLen) : undefined));
    } else
      tlvs[tlvType] = (tlvLen > 0 ? buffer.slice(i, i+tlvLen) : undefined);
    i += tlvLen;
    if (tlvTotal && ++added === tlvTotal)
      return [tlvs, i];
  }
  return tlvs;
}

function splitNum(num, size) {
  var newval = [];
  size = size || 0;
  while (num > 0 || size > 0) {
    newval.unshift(num & 0xFF);
    num >>= 8;
    if (size)
      size--;
  }
  return newval;
}

function str2bytes(str) {
  return (''+str).split('').map(function(x){return x.charCodeAt(0);});
}

function flip(obj) {
  var result = {}, keys = Object.keys(obj);
  for (var i=0,len=keys.length; i<len; i++)
    result[obj[keys[i]]] = keys[i];
  return result;
};

function toHexStr(o) {
  return (Buffer.isBuffer(o) ? o.toArray() : o).reduce(function(p,c) {
    return p.toString(16) + (c.toString(16).length === 1 ? '0' : '') + c.toString(16);
  })
}

function arraysEqual(a, b) {
  var equal = false;
  if (a.length === b.length)
    equal = a.every(function(value,index) { return value === b[index]; });
  return equal;
}

function bufferAppend(buf1, buf2) {
  var newBuf = new Buffer(buf1.length + buf2.length);
  buf1.copy(newBuf, 0, 0);
  if (Buffer.isBuffer(buf2))
    buf2.copy(newBuf, buf1.length, 0);
  else if (Array.isArray(buf2)) {
    for (var i=buf1.length, len=buf2.length; i<len; i++)
      newBuf[i] = buf2[i];
  }

  return newBuf;
};

Buffer.prototype.toArray = function() {
  return Array.prototype.slice.call(this);
};

function getConnSvcNames(conn) {
  if (conn.id === 'login')
    return 'login';

  var svcTypes = Object.keys(SNAC_SERVICES),
      availServices = Object.keys(conn.availServices).map(function(x) {
        return parseInt(x);
      }),
      services = [];

  for (var i=0,len=availServices.length; i<len; ++i) {
    for (var j=0,len2=svcTypes.length; j<len2; ++j) {
      if (availServices[i] === SNAC_SERVICES[svcTypes[j]]) {
        services.push(svcTypes[j]);
        break;
      }
    }
  }

  return services.join(', ');
}

// Constants ---------------------------------------------------------------------------------
var FLAP_CHANNELS = {
  CONN_NEW: 0x01,
  SNAC: 0x02,
  ERROR: 0x03,
  CONN_CLOSE: 0x04,
  KEEPALIVE: 0x05
};
var SNAC_SERVICES = {
  GENERIC: 0x0001,
  LOCATION: 0x0002,
  LIST_MGMT: 0x0003,
  ICBM: 0x0004,
  INVITATION: 0x0006,
  ADMIN: 0x0007,
  POPUP: 0x0008,
  PRIVACY_MGMT: 0x0009,
  USER_LOOKUP: 0x000A,
  USAGE_STATS: 0x000B, // used by AOL to gather stats about user
  CHAT_NAV: 0x000D,
  CHAT: 0x000E,
  DIR_SEARCH: 0x000F,
  BART: 0x0010, // server-side buddy icons
  SSI: 0x0013, // server-side info
  ICQ_EXT: 0x0015,
  AUTH: 0x0017
};
var SNAC_SERVICE_VERSIONS = {};
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.GENERIC] = 4;
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.LOCATION] = 1;
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.LIST_MGMT] = 1;
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.ICBM] = 1;
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.INVITATION] = 1;
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.ADMIN] = 1;
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.POPUP] = 1;
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.PRIVACY_MGMT] = 1;
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.USER_LOOKUP] = 1;
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.DIR_SEARCH] = 1;
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.USAGE_STATS] = 1;
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.CHAT_NAV] = 1;
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.CHAT] = 1;
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.BART] = 1;
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.SSI] = 4;
SNAC_SERVICE_VERSIONS[SNAC_SERVICES.ICQ_EXT] = 1;
var SNAC_SERVICE_TOOL_IDS = {};
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.GENERIC] = 0x0110;
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.LOCATION] = 0x0110;
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.LIST_MGMT] = 0x0110;
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.ICBM] = 0x0110;
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.INVITATION] = 0x0110;
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.ADMIN] = 0x0010;
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.POPUP] = 0x0104;
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.PRIVACY_MGMT] = 0x0110;
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.USER_LOOKUP] = 0x0110;
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.DIR_SEARCH] = 0x0010;
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.USAGE_STATS] = 0x0104;
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.CHAT_NAV] = 0x0010;
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.CHAT] = 0x0010;
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.BART] = 0x0010;
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.SSI] = 0x0010;
SNAC_SERVICE_TOOL_IDS[SNAC_SERVICES.ICQ_EXT] = 0x0110;
var SNAC_SERVICE_TOOL_VERSIONS = {};
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.GENERIC] = 0x0629;
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.LOCATION] = 0x0629;
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.LIST_MGMT] = 0x0629;
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.ICBM] = 0x0629;
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.INVITATION] = 0x0629;
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.ADMIN] = 0x0629;
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.POPUP] = 0x0001;
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.PRIVACY_MGMT] = 0x0629;
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.USER_LOOKUP] = 0x0629;
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.DIR_SEARCH] = 0x0629;
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.USAGE_STATS] = 0x0001;
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.CHAT_NAV] = 0x0629;
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.CHAT] = 0x0629;
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.BART] = 0x0629;
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.SSI] = 0x0629;
SNAC_SERVICE_TOOL_VERSIONS[SNAC_SERVICES.ICQ_EXT] = 0x047C;
var TLV_TYPES = {
  SCREEN_NAME: 0x01, // value: string
  PASSWORD_NEW: 0x02, // value: string
  CLIENT_ID_STR: 0x03, // value: string
  ERROR_DESC_URL: 0x04, // value: string
  BOS_SERVER: 0x05, // value: string -- 'server:port'
  AUTH_COOKIE: 0x06, // value: byte array
  SNAC_VER: 0x07, // value: unknown
  ERROR: 0x08, // value: word
  DISCONNECT_REASON: 0x09, // value: word
  REDIRECT_HOST: 0x0A, // value: unknown
  URL: 0x0B, // value: string
  DEBUG: 0x0C, // value: word
  SERVICE_ID: 0x0D, // value: word
  CLIENT_COUNTRY: 0x0E, // value: string (2 chars)
  CLIENT_LANG: 0x0F, // value: string (2 chars)
  SCRIPT: 0x10, // value: unknown
  USER_EMAIL: 0x11, // value: string
  PASSWORD_OLD: 0x12, // value: string
  REG_STATUS: 0x13, // value: word (visibility status -- 'let those who know my email address know ...'(?)) (0x01 -- 'Nothing about me', 0x02 -- 'Only that I have an account', 0x03 -- 'My screen name')
  DISTRIB_NUM: 0x14, // value: dword
  PERSONAL_TEXT: 0x15, // value: unknown
  CLIENT_ID: 0x16, // value: word
  CLIENT_VER_MAJOR: 0x17, // value: word
  CLIENT_VER_MINOR: 0x18, // value: word
  CLIENT_VER_LESSER: 0x19, // value: word
  CLIENT_VER_BUILD: 0x1A, // value: word
  PASSWORD_HASH: 0x25, // value: byte array
  LATEST_BETA_BUILD: 0x40, // value: dword
  LATEST_BETA_INSTALL_URL: 0x41, // value: string
  LATEST_BETA_INFO_URL: 0x42, // value: byte array
  LATEST_BETA_VER: 0x43, // value: string
  LATEST_REL_BUILD: 0x44, // value: dword
  LATEST_REL_INSTALL_URL: 0x45, // value: string
  LATEST_REL_INFO_URL: 0x46, // value: byte array
  LATEST_REL_VER: 0x47, // value: string
  LATEST_BETA_DIGEST: 0x48, // value: string (hex)
  LATEST_REL_DIGEST: 0x49, // value: string (hex)
  MULTI_CONN: 0x4A, // value: byte
  CHANGE_PASS_URL: 0x54 // value: string
};
var DISCONNECT_REASONS = {
  DONE: 0x00, // not really an error
  LOCAL_CLOSED: 0x01, // peer connections only, not really an error
  REMOTE_CLOSED: 0x02,
  REMOTE_REFUSED: 0x03, // peer connections only
  LOST_CONN: 0x04,
  INVALID_DATA: 0x05,
  UNABLE_TO_CONNECT: 0x06,
  RETRYING: 0x07 // peer connections only
};
var GLOBAL_ERRORS = {
  BAD_SNAC_HEADER: 0x01,
  SERVER_RATE_LIMIT: 0x02,
  CLIENT_RATE_LIMIT: 0x03,
  RECIPIENT_UNAVAIL: 0x04,
  SERVICE_UNAVAIL: 0x05,
  SERVICE_UNDEFINED: 0x06,
  SNAC_OBSOLETE: 0x07,
  SERVER_UNSUPPORTED: 0x08,
  CLIENT_UNSUPPORTED: 0x09,
  CLIENT_REFUSED: 0x0A,
  REPLY_OVERSIZED: 0x0B,
  RESPONSES_LOST: 0x0C,
  REQUEST_DENIED: 0x0D,
  BAD_SNAC_FORMAT: 0x0E,
  NOT_PRIVILEGED: 0x0F,
  RECIPIENT_BLOCKED: 0x10,
  EVIL_SENDER: 0x11,
  EVIL_RECEIVER: 0x12,
  USER_TEMP_UNAVAIL: 0x13,
  NO_MATCH: 0x14,
  LIST_OVERFLOW: 0x15,
  REQUEST_VAGUE: 0x16,
  SERVER_QUEUE_FULL: 0x17,
  NOT_ON_AOL: 0x18
};
var GLOBAL_ERRORS_TEXT = {};
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.BAD_SNAC_HEADER] = 'Invalid SNAC header';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.SERVER_RATE_LIMIT] = 'Server rate limit exceeded';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.CLIENT_RATE_LIMIT] = 'Client rate limit exceeded';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.RECIPIENT_UNAVAIL] = 'Recipient is not logged in';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.SERVICE_UNAVAIL] = 'Requested service unavailable';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.SERVICE_UNDEFINED] = 'Requested service not defined';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.SNAC_OBSOLETE] = 'You sent an obsolete SNAC';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.SERVER_UNSUPPORTED] = 'Not supported by server';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.CLIENT_UNSUPPORTED] = 'Not supported by client';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.CLIENT_REFUSED] = 'Refused by client';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.REPLY_OVERSIZED] = 'Reply too big';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.RESPONSES_LOST] = 'Responses lost';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.REQUEST_DENIED] = 'Request denied';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.BAD_SNAC_FORMAT] = 'Incorrect SNAC format';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.NOT_PRIVILEGED] = 'Insufficient rights';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.RECIPIENT_BLOCKED] = 'In local permit/deny (recipient blocked)';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.EVIL_SENDER] = 'Sender too evil';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.EVIL_RECEIVER] = 'Receiver too evil';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.USER_TEMP_UNAVAIL] = 'User temporarily unavailable';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.NO_MATCH] = 'No match';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.LIST_OVERFLOW] = 'List overflow';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.REQUEST_VAGUE] = 'Request ambiguous';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.SERVER_QUEUE_FULL] = 'Server queue full';
GLOBAL_ERRORS_TEXT[GLOBAL_ERRORS.NOT_ON_AOL] = 'Not while on AOL';
var DEFAULT_RATE_GROUP = 1;
var RATE_UPDATES = {
  INVALID: 0x0000,
  CHANGED: 0x0001,
  WARNING: 0x0002,
  LIMIT: 0x0003,
  LIMIT_CLEARED: 0x0004
};
var RATE_UPDATES_TEXT = {};
RATE_UPDATES_TEXT[RATE_UPDATES.INVALID] = 'Invalid rate limit change';
RATE_UPDATES_TEXT[RATE_UPDATES.CHANGED] = 'Rate limits have changed';
RATE_UPDATES_TEXT[RATE_UPDATES.WARNING] = 'Rate limit warning in effect';
RATE_UPDATES_TEXT[RATE_UPDATES.LIMIT] = 'Rate limit in effect';
RATE_UPDATES_TEXT[RATE_UPDATES.LIMIT_CLEARED] = 'Rate limit no longer in effect';
var AUTH_ERRORS = {
  LOGIN_INVALID1: 0x01,
  SERVICE_DOWN1: 0x02,
  OTHER: 0x03,
  LOGIN_INVALID2: 0x04,
  LOGIN_INVALID3: 0x05,
  BAD_INPUT: 0x06,
  ACCOUNT_INVALID: 0x07,
  ACCOUNT_DELETED: 0x08,
  ACCOUNT_EXPIRED: 0x09,
  NO_DB_ACCESS: 0x0A,
  NO_RESOLVER_ACCESS: 0x0B,
  DB_FIELDS_INVALID: 0x0C,
  BAD_DB_STATUS: 0x0D,
  BAD_RESOLVER_STATUS: 0x0E,
  INTERNAL: 0x0F,
  SERVICE_DOWN2: 0x10,
  ACCOUNT_SUSPENDED: 0x11,
  DB_SEND: 0x12,
  DB_LINK: 0x13,
  RESERVATION_MAP: 0x14,
  RESERVATION_LINK: 0x15,
  MAX_IP_CONN: 0x16,
  MAX_IP_CONN_RESERVATION: 0x17,
  RATE_RESERVATION: 0x18,
  HEAVILY_WARNED: 0x19,
  TIMEOUT_RESERVATION: 0x1A,
  CLIENT_UPGRADE_REQ: 0x1B,
  CLINET_UPGRADE_REC: 0x1C,
  RATE_LIMIT_EXCEED: 0x1D,
  CANNOT_REGISTER: 0x1E,
  INVALID_SECURID: 0x20,
  ACCOUNT_SUSPENDED_AGE: 0x22
};
var AUTH_ERRORS_TEXT = {};
AUTH_ERRORS_TEXT[AUTH_ERRORS.LOGIN_INVALID1] = 'Invalid nick or password';
AUTH_ERRORS_TEXT[AUTH_ERRORS.SERVICE_DOWN1] = 'Service temporarily unavailable';
AUTH_ERRORS_TEXT[AUTH_ERRORS.OTHER] = 'All other errors';
AUTH_ERRORS_TEXT[AUTH_ERRORS.LOGIN_INVALID2] = 'Incorrect nick or password';
AUTH_ERRORS_TEXT[AUTH_ERRORS.LOGIN_INVALID3] = 'Mismatch nick or password';
AUTH_ERRORS_TEXT[AUTH_ERRORS.BAD_INPUT] = 'Internal client error (bad input to authorizer)';
AUTH_ERRORS_TEXT[AUTH_ERRORS.ACCOUNT_INVALID] = 'Invalid account';
AUTH_ERRORS_TEXT[AUTH_ERRORS.ACCOUNT_DELETED] = 'Deleted account';
AUTH_ERRORS_TEXT[AUTH_ERRORS.ACCOUNT_EXPIRED] = 'Expired account';
AUTH_ERRORS_TEXT[AUTH_ERRORS.NO_DB_ACCESS] = 'No access to database';
AUTH_ERRORS_TEXT[AUTH_ERRORS.NO_RESOLVER_ACCESS] = 'No access to resolver';
AUTH_ERRORS_TEXT[AUTH_ERRORS.DB_FIELDS_INVALID] = 'Invalid database fields';
AUTH_ERRORS_TEXT[AUTH_ERRORS.BAD_DB_STATUS] = 'Bad database status';
AUTH_ERRORS_TEXT[AUTH_ERRORS.BAD_RESOLVER_STATUS] = 'Bad resolver status';
AUTH_ERRORS_TEXT[AUTH_ERRORS.INTERNAL] = 'Internal error';
AUTH_ERRORS_TEXT[AUTH_ERRORS.SERVICE_DOWN2] = 'Service temporarily offline';
AUTH_ERRORS_TEXT[AUTH_ERRORS.ACCOUNT_SUSPENDED] = 'Suspended account';
AUTH_ERRORS_TEXT[AUTH_ERRORS.DB_SEND] = 'DB send error';
AUTH_ERRORS_TEXT[AUTH_ERRORS.DB_LINK] = 'DB link error';
AUTH_ERRORS_TEXT[AUTH_ERRORS.RESERVATION_MAP] = 'Reservation map error';
AUTH_ERRORS_TEXT[AUTH_ERRORS.RESERVATION_LINK] = 'Reservation link error';
AUTH_ERRORS_TEXT[AUTH_ERRORS.MAX_IP_CONN] = 'The number of users connected from this IP has reached the maximum';
AUTH_ERRORS_TEXT[AUTH_ERRORS.MAX_IP_CONN_RESERVATION] = 'The number of users connected from this IP has reached the maximum (reservation)';
AUTH_ERRORS_TEXT[AUTH_ERRORS.RATE_RESERVATION] = 'Rate limit exceeded (reservation). Please try to reconnect in a few minutes';
AUTH_ERRORS_TEXT[AUTH_ERRORS.HEAVILY_WARNED] = 'User too heavily warned';
AUTH_ERRORS_TEXT[AUTH_ERRORS.TIMEOUT_RESERVATION] = 'Reservation timeout';
AUTH_ERRORS_TEXT[AUTH_ERRORS.CLIENT_UPGRADE_REQ] = 'You are using an older version of ICQ. Upgrade required';
AUTH_ERRORS_TEXT[AUTH_ERRORS.CLINET_UPGRADE_REC] = 'You are using an older version of ICQ. Upgrade recommended';
AUTH_ERRORS_TEXT[AUTH_ERRORS.RATE_LIMIT_EXCEED] = 'Rate limit exceeded. Please try to reconnect in a few minutes';
AUTH_ERRORS_TEXT[AUTH_ERRORS.CANNOT_REGISTER] = 'Can\'t register on the ICQ network. Reconnect in a few minutes';
AUTH_ERRORS_TEXT[AUTH_ERRORS.INVALID_SECURID] = 'Invalid SecurID';
AUTH_ERRORS_TEXT[AUTH_ERRORS.ACCOUNT_SUSPENDED_AGE] = 'Account suspended because of your age (age < 13)';
var MOTD_TYPES = {
  MAND_UPGRADE: 0x01, // Mandatory upgrade needed notice
  REC_UPGRADE: 0x02,  // Recommended upgrade notice
  SYS_ANNOUNCE: 0x03, // AIM/ICQ service system announcements
  NORMAL: 0x04,       // Standard notice
  NEWS: 0x06          // Some news from AOL service
};
var DC_TYPES = { // ICQ only
  DC_DISABLED: 0x00,  // Direct connection disabled / auth required
  DC_HTTPS: 0x01,     // Direct connection through firewall or https proxy
  DC_SOCKS: 0x02,     // Direct connection through socks4/5 proxy server
  DC_NORMAL: 0x04,    // Normal direct connection (no proxy/firewall)
  DC_WEB: 0x06        // Web client - no direct connection possible
};
var DC_PROTOCOLS = { // ICQ only
  DCP_ICQ98: 0x04,    // ICQ98
  DCP_ICQ99: 0x06,    // ICQ99
  DCP_ICQ2000: 0x07,  // ICQ2000
  DCP_ICQ2001: 0x08,  // ICQ2001
  DCP_ICQLITE: 0x09,  // ICQ Lite
  DCP_ICQ2003B: 0x0A  // ICQ2003B
};
var USER_CLASSES = {
  UNCONFIRMED: 0x0001,   // AOL unconfirmed user flag
  ADMIN: 0x0002,         // AOL administrator flag
  STAFF: 0x0004,         // AOL staff user flag
  COMMERCIAL: 0x0008,    // AOL commercial account flag
  FREE: 0x0010,          // AOL non-commercial account flag
  AWAY: 0x0020,          // Away status flag
  ICQ: 0x0040,           // ICQ user sign
  WIRELESS: 0x0080,      // Mobile device user
  UNKNOWN100: 0x0100,    // Unknown bit
  UNKNOWN200: 0x0200,    // Unknown bit
  BOT: 0x0400,           // Bot like ActiveBuddy (or SmarterChild?)
  UNKNOWN800: 0x0800     // Unknown bit
};
var USER_STATUSES = { // 1st two bytes of user status field
  ONLINE: 0x0000,
  AWAY: 0x0001,
  DND: 0x0002,
  NA: 0x0004,
  OCCUPIED: 0x0010,
  FREE4CHAT: 0x0020,
  INVISIBLE: 0x0100,
  EVIL: 0x3000,
  DEPRESSION: 0x4000,
  ATHOME: 0x5000,
  ATWORK: 0x6000,
  LUNCH: 0x2001,
  OFFLINE: 0xFFFF
};
var USER_FLAGS = { // 2nd two bytes of user status field
  WEBAWARE: 0x0001,   // Status webaware flag
  SHOWIP: 0x0002,     // Status show ip flag
  BIRTHDAY: 0x0008,   // User birthday flag
  WEBFRONT: 0x0020,   // User active webfront flag
  DCDISABLED: 0x0100, // Direct connection not supported
  HOMEPAGE: 0x0200,   // Homepage (ICQ-only)
  DCAUTH: 0x1000,     // Direct connection upon authorization
  DCCONT: 0x2000      // Direct connection only with contact users
};
var MESSAGE_TYPES = {
  PLAIN: 0x01,    // Plain text (simple) message
  CHAT: 0x02,     // Chat request message
  FILEREQ: 0x03,  // File request / file ok message
  URL: 0x04,      // URL message (0xFE formatted)
  AUTHREQ: 0x06,  // Authorization request message (0xFE formatted)
  AUTHDENY: 0x07, // Authorization denied message (0xFE formatted)
  AUTHOK: 0x08,   // Authorization given message (empty)
  SERVER: 0x09,   // Message from OSCAR server (0xFE formatted)
  ADDED: 0x0C,    // 'You-were-added' message (0xFE formatted)
  WWP: 0x0D,      // Web pager message (0xFE formatted)
  EEXPRESS: 0x0E, // Email express message (0xFE formatted)
  CONTACTS: 0x13, // Contact list message
  PLUGIN: 0x1A,   // Plugin message described by text string
  AUTOAWAY: 0xE8, // Auto away message
  AUTOBUSY: 0xE9, // Auto occupied message
  AUTONA: 0xEA,   // Auto not available message
  AUTODND: 0xEB,  // Auto do not disturb message
  AUTOFFC: 0xEC   // Auto free for chat message
};
var MESSAGE_FLAGS = {
  NORMAL: 0x01, // Normal message
  AUTO: 0x03,   // Auto-message flag
  MULTI: 0x80   // This is multiple recipients message
};
var ICBM_FLAGS = {
  CHANNEL_MSGS_ALLOWED: 0x00000001,
  MISSED_CALLS_ENABLED: 0x00000002,
  TYPING_NOTIFICATIONS: 0x00000004,
  EVENTS_ALLOWED: 0x00000008,
  SMS_SUPPORTED: 0x00000010,
  OFFLINE_MSGS_ALLOWED: 0x00000100,
  USE_HTML_FOR_ICQ: 0x00000400
};
var ICBM_RENDEZVOUS_STATUSES = {
  REQUEST: 0x0000,
  CANCEL: 0x0001,
  ACCEPT: 0x0002
};
var ICBM_MISSED_REASONS = {
  INVALID: 0x0000,
  TOO_BIG: 0x0001,
  RATE_EXCEEDED: 0x0002,
  SENDER_EVIL: 0x0003,
  SELF_EVIL: 0x0004
};
var ICBM_MSG_FLAGS = {
  AWAY: 0x0001, // auto-reply
  ACK: 0x0002, // request msg ack
  REQ_ICON: 0x0010, // icon requested
  HAS_ICON: 0x0020, // user has an icon
  SUBENC_MACINTOSH: 0x0040, // ???
  CUSTOM_FEATURES: 0x0080, // features field present
  OFFLINE: 0x0800 // offline message
};
var ICBM_MSG_CHARSETS = {
  ASCII: 0x0000, // ISO 646
  UNICODE: 0x0002, // ISO 10646 (UTF-16/UCS-2BE)
  LATIN1: 0x0003 // ISO 8859-1
};
var ICBM_ERRORS = {
  USER_OFFLINE: 0x04,
  USER_UNSUPPORTED_MSG: 0x09,
  MSG_INVALID: 0x0E,
  BLOCKED: 0x10
};
var ICBM_SUBCODE_ERRORS = {
  REMOTE_IM_OFF: 0x01,
  REMOTE_RESTRICTED_BY_PC: 0x02,
  SMS_NEED_LEGAL: 0x03,
  SMS_NO_DISCLAIMER: 0x04,
  SMS_COUNTRY_UNALLOWED: 0x05,
  SMS_UNKNOWN_COUNTRY: 0x08,
  CANNOT_INIT_IM: 0x09,
  IM_UNALLOWED: 0x0A,
  USAGE_LIMIT: 0x0B,
  DAILY_USAGE_LIMIT: 0x0C,
  MONTHLY_USAGE_LIMIT: 0x0D,
  OFFLINE_IM_UNACCEPTED: 0x0E,
  OFFLINE_IM_EXCEED_MAX: 0x0F
};
var ICBM_ERRORS_TEXT = {};
ICBM_ERRORS_TEXT[ICBM_ERRORS.USER_OFFLINE] = 'You are trying to send a message to an offline user';
ICBM_ERRORS_TEXT[ICBM_ERRORS.USER_UNSUPPORTED_MSG] = 'This type of message is not supported by that user';
ICBM_ERRORS_TEXT[ICBM_ERRORS.MSG_INVALID] = 'Message is invalid (incorrect format)';
ICBM_ERRORS_TEXT[ICBM_ERRORS.BLOCKED] = 'Receiver/Sender is blocked';
var ICBM_SUBCODE_ERRORS_TEXT = {};
ICBM_SUBCODE_ERRORS_TEXT[ICBM_SUBCODE_ERRORS.REMOTE_IM_OFF] = 'User is not accepting incoming IMs';
ICBM_SUBCODE_ERRORS_TEXT[ICBM_SUBCODE_ERRORS.REMOTE_RESTRICTED_BY_PC] = 'The user denied the IM because of parental controls';
ICBM_SUBCODE_ERRORS_TEXT[ICBM_SUBCODE_ERRORS.SMS_NEED_LEGAL] = 'User tried to send a message to an SMS user and is required to accept the legal text first';
ICBM_SUBCODE_ERRORS_TEXT[ICBM_SUBCODE_ERRORS.SMS_NO_DISCLAIMER] = 'Client tried to send a message to an SMS user without the character counter being displayed';
ICBM_SUBCODE_ERRORS_TEXT[ICBM_SUBCODE_ERRORS.SMS_COUNTRY_UNALLOWED] = 'Client tried to send a message to an SMS user but the SMS matrix said the country code combination not permitted';
ICBM_SUBCODE_ERRORS_TEXT[ICBM_SUBCODE_ERRORS.SMS_UNKNOWN_COUNTRY] = 'Client tried to send to an SMS user but the server could not determine the country';
ICBM_SUBCODE_ERRORS_TEXT[ICBM_SUBCODE_ERRORS.CANNOT_INIT_IM] = 'An IM cannot be initiated by a bot';
ICBM_SUBCODE_ERRORS_TEXT[ICBM_SUBCODE_ERRORS.IM_UNALLOWED] = 'An IM is not allowed by a consumer bot to a user';
ICBM_SUBCODE_ERRORS_TEXT[ICBM_SUBCODE_ERRORS.USAGE_LIMIT] = 'An IM is not allowed by a consumer bot due to reaching a generic usage limit (not common)';
ICBM_SUBCODE_ERRORS_TEXT[ICBM_SUBCODE_ERRORS.DAILY_USAGE_LIMIT] = 'An IM is not allowed by a consumer bot due to reaching the daily usage limit';
ICBM_SUBCODE_ERRORS_TEXT[ICBM_SUBCODE_ERRORS.MONTHLY_USAGE_LIMIT] = 'An IM is not allowed by consumer bot due to reaching the monthly usage limit';
ICBM_SUBCODE_ERRORS_TEXT[ICBM_SUBCODE_ERRORS.OFFLINE_IM_UNACCEPTED] = 'User does not accept offline IMs';
ICBM_SUBCODE_ERRORS_TEXT[ICBM_SUBCODE_ERRORS.OFFLINE_IM_EXCEED_MAX] = 'User exceeded max offline IM storage limit';
var CAPABILITIES = {
  INTEROPERATE: [0x09, 0x46, 0x13, 0x4D, 0x4C, 0x7F, 0x11, 0xD1,   // AIM<->ICQ support
                 0x82, 0x22, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00],
  XHTML_IM: [0x09, 0x46, 0x00, 0x02, 0x4C, 0x7F, 0x11, 0xD1,
             0x82, 0x22, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00],
  SEND_FILE: [0x09, 0x46, 0x13, 0x43, 0x4C, 0x7F, 0x11, 0xD1,
              0x82, 0x22, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00],
  CHAT: [0x74, 0x8F, 0x24, 0x20, 0x62, 0x87, 0x11, 0xD1,
         0x82, 0x22, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00],
  ICQ_UTF8: [0x09, 0x46, 0x13, 0x4E, 0x4C, 0x7F, 0x11, 0xD1,
             0x82, 0x22, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00],
  BUDDY_ICON: [0x09, 0x46, 0x13, 0x46, 0x4C, 0x7F, 0x11, 0xD1,
               0x82, 0x22, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00],
  SEND_CONTACT_LIST: [0x09, 0x46, 0x13, 0x4B, 0x4C, 0x7F, 0x11, 0xD1,
                      0x82, 0x22, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00],
  TYPING: [0x56, 0x3F, 0xC8, 0x09, 0x0B, 0x6F, 0x41, 0xBD,  // typing notifications?
           0x9F, 0x79, 0x42, 0x26, 0x09, 0xDF, 0xA2, 0xF3]
};
var SSI_ACK_RESULTS = {
  SUCCESS: 0x0000,
  DB_ERROR: 0x0001,
  NOT_FOUND: 0x0002,
  EXISTS: 0x0003,
  UNAVAILABLE: 0x0004,
  BAD_REQUEST: 0x000A,
  DB_TIMEOUT: 0x000B,
  MAX_REACHED: 0x000C,
  NOT_EXECUTED: 0x000D,
  AUTH_REQUIRED: 0x000E,
  BAD_LOGINID: 0x0010,
  OVER_CONTACT_LIMIT: 0x0011,
  INSERT_SMART_GROUP: 0x0014,
  TIMEOUT: 0x001A
};
var SSI_ACK_RESULTS_TEXT = {};
SSI_ACK_RESULTS_TEXT[SSI_ACK_RESULTS.DB_ERROR] = 'A database error occurred';
SSI_ACK_RESULTS_TEXT[SSI_ACK_RESULTS.NOT_FOUND] = 'The item to be modified or deleted could not be found';
SSI_ACK_RESULTS_TEXT[SSI_ACK_RESULTS.EXISTS] = 'The item to be added already exists';
SSI_ACK_RESULTS_TEXT[SSI_ACK_RESULTS.UNAVAILABLE] = 'Server or database is not available';
SSI_ACK_RESULTS_TEXT[SSI_ACK_RESULTS.BAD_REQUEST] = 'The request was malformed';
SSI_ACK_RESULTS_TEXT[SSI_ACK_RESULTS.DB_TIMEOUT] = 'The database timed out';
SSI_ACK_RESULTS_TEXT[SSI_ACK_RESULTS.MAX_REACHED] = 'The maximum number of this item type has been reached';
SSI_ACK_RESULTS_TEXT[SSI_ACK_RESULTS.NOT_EXECUTED] = 'The action failed due to another error in the same request';
SSI_ACK_RESULTS_TEXT[SSI_ACK_RESULTS.AUTH_REQUIRED] = 'This contact requires authorization before adding';
SSI_ACK_RESULTS_TEXT[SSI_ACK_RESULTS.BAD_LOGINID] = 'Bad loginId';
SSI_ACK_RESULTS_TEXT[SSI_ACK_RESULTS.OVER_CONTACT_LIMIT] = 'Too many contacts';
SSI_ACK_RESULTS_TEXT[SSI_ACK_RESULTS.INSERT_SMART_GROUP] = 'Attempted to add a contact to a smart group';
SSI_ACK_RESULTS_TEXT[SSI_ACK_RESULTS.TIMEOUT] = 'The request timed out';
var SSI_ROOT_GROUP = { name: '', group: 0x00, item: 0x00, type: 0x01 };
var SSI_PREFS = {
  PERMIT_ALL: 0x01,
  DENY_ALL: 0x02,
  PERMIT_SOME: 0x03,
  DENY_SOME: 0x04,
  PERMIT_ON_LIST: 0x05
};
var CHAT_PERMS = {
  NONE: 0x00,
  CREATE_ROOM: 0x01,
  CREATE_EXCHG: 0x02
};
var CHAT_FLAGS = {
  EVILABLE: 0x01,
  NAV_ONLY: 0x02,
  CAN_INSTANCE: 0x03,
  CAN_PEEK: 0x04
};
var TYPING_NOTIFY = {
  FINISH: 0x0000,
  TEXT_ENTERED: 0x0001,
  START: 0x0002,
  CLOSED: 0x000F // IM window was closed
};
var NO_FLAGS = 0x0000;
var MAX_SN_LEN = 97;
var MAX_MSG_LEN = 2544;
var MAX_ICON_LEN = 7168;
var KEEPALIVE_INTERVAL = 60*1000;
var SERVER_AOL = 'login.oscar.aol.com';
var SERVER_ICQ = 'login.icq.com';
// End Constants -----------------------------------------------------------------------------


exports.OscarConnection = OscarConnection;
exports.SERVER_AOL = SERVER_AOL;
exports.SERVER_ICQ = SERVER_ICQ;

exports.GENERAL_ERRORS = GLOBAL_ERRORS;
exports.RATE_UPDATES = RATE_UPDATES;
exports.MSG_ERRORS = ICBM_ERRORS;
exports.MSG_SUBERRORS = ICBM_SUBCODE_ERRORS;
exports.AUTH_ERRORS = AUTH_ERRORS;

exports.USER_FLAGS = USER_FLAGS;
exports.USER_STATUSES = USER_STATUSES;
exports.USER_CLASSES = USER_CLASSES;
exports.SSI_RESULTS = SSI_ACK_RESULTS;
exports.CAPABILITIES = CAPABILITIES;
exports.TYPING_NOTIFY = TYPING_NOTIFY;
exports.MOTD_TYPES = MOTD_TYPES;
exports.IM_FLAGS = ICBM_MSG_FLAGS;
exports.IM_MISSED_REASONS = ICBM_MISSED_REASONS;
