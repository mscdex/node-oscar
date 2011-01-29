var oscar = require('./oscar');

var aim = new oscar.OscarConnection({
  connection: {
    username: 'xxxxxx',
    password: 'xxxxxx'
  }
});

aim.on('typing', function(who, type) {
  if (type === oscar.TYPING_NOTIFY.START)
    type = 'started typing';
  else if (type === oscar.TYPING_NOTIFY.FINISH)
    type = 'finished typing';
  else if (type === oscar.TYPING_NOTIFY.TEXT_ENTERED)
    type = 'entered text';
  else
    type = 'closed the IM';
  console.log('test.js :: typing notification: ' + who + ' ' + type);
});
aim.on('im', function(text, sender, flags, when) {
  console.log('test.js :: received ' + (when ? 'offline ' : '')
              + 'IM from ' + sender.name + (when ? ' (on ' + when + ')' : '')
              + ': ' + text);
  if (when)
    return;
  aim.sendIM(sender.name, 'I got your IM!');
});
aim.on('missed', function(sender, numMissed, reason, channel) {
  console.log('test.js :: missed ' + numMissed + ' messages from ' + sender.name
              + '. Reason: ' + reason + '. Channel: ' + channel);
});
aim.on('contactonline', function(user) {
  var status = 'other';
  if (user.idleMins)
    status = 'idle (' + user.idleMins + ' mins)';
  else if (user.status === oscar.USER_STATUSES.ONLINE)
    status = 'available';
  else if (user.status === oscar.USER_STATUSES.AWAY)
     status = 'away';
  console.log('test.js :: ' + user.name + ' is now online and ' + status
              + (user.statusMsg ? ': ' + user.statusMsg : ''));
});
aim.on('contactupdate', function(user) {
  var status = 'other';
  if (user.idleMins)
    status = 'idle (' + user.idleMins + ' mins)';
  else if (user.status === oscar.USER_STATUSES.ONLINE)
    status = 'available';
  else if (user.status === oscar.USER_STATUSES.AWAY)
     status = 'away';
  console.log('test.js :: ' + user.name + ' is now ' + status
              + (user.statusMsg ? ': ' + user.statusMsg : ''));
});
aim.on('contactoffline', function(user) {
  console.log('test.js :: ' + user.name + ' is now offline');
});
aim.on('icon', function(who, icon, size) {
  console.log('test.js :: Got ' + size + ' buddy icon for ' + who);
});
aim.connect(function(err) {
  if (err)
    console.log('test.js :: Encountered error: ' + err);
  else {
    console.log('test.js :: ready!');
    // automatically check for offline messages
    aim.getOfflineMsgs();
  }
});