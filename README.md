Description
===========

node-oscar is an OSCAR protocol module for [node.js](http://nodejs.org/).


Requirements
============

* [node.js](http://nodejs.org/) -- tested with v0.2.6
* An AIM or ICQ account -- Note: Only ICQ UINs will work and they must be a String when supplied as the username. For new ICQ accounts, they do not give you your ICQ UIN right away (you log in by email address). For these new accounts, you can find your UIN by: logging with the ICQ web client and editing your profile OR by going here (https://www.icq.com/karma/login_page.php), clicking the "Enable Log In With an Email" link, and logging in (your UIN will be displayed on the next page).


Example
=======

See test.js for example API usage.


API
===

node-oscar exposes one object: **OscarConnection**.

#### Data types

* _User_ is an Object representing information about a particular user. The following are all valid properties but may not always be filled in:
    * **name** - A String containing the user (screen) name.
    * **fullname** - A String containing the user's personal full name.
    * **warnLevel** - An Integer representing the user's current warning level.
    * **class** - A bit field indicating the type of user (see the USER\_CLASSES constants).
    * **memberSince** - A Date representing the date and time the user created their account.
    * **onlineSince** - A Date representing the date and time the user logged on.
    * **idleMins** - An Integer containing the number of minutes the user has been marked as idle. Note: the client actually tells AOL when to start and stop counting idle time, so this value could be unreliable.
    * **flags** - A bit field containing various flags for the user (see the USER\_FLAGS constants).
    * **status** - A bit field containing the user's current status (see the USER\_STATUSES constants).
    * **IP** - A String containing the user's IP address.
    * **capabilities** - An Array of Arrays that indicates what the user's client is capable of (see the CAPABILITIES constants).
    * **instanceNum** - An Integer that indicates which instance of the user this is. This is filled in if the user's client is allowing simultaneous log-ons and they are currently logged on more than once.
    * **profileSetOn** - A Date representing the date and time the user set their current profile.
    * **awaySetOn** - A Date representing the date and time the user set themselves as away.
    * **countryCode** - A String of length 2 indicating the user's country of origin.
    * **statusMsg** - A String representing the user's custom status message.
    * **mood** - A String containing a short extended status message for ICQ users.


OscarConnection Events
----------------------

* **warn**(Integer, Integer[, String, Integer]) - Fires when another user warns you. The first argument is your old warning level and the second is your new warning level. If the third and fourth arguments are supplied, then it was a non-anonymous warning, in which case the third and fourth arguments are the user name and user warning level respectively.

* **contactonline**(User) - Fires when someone logs on. The User argument is the user signing on.

* **contactoffline**(User) - Fires when someone logs off. The User argument is the user signing off.

* **contactupdate**(User) - Fires when information about someone changes. The User argument is the user whose details changed.

* **im**(String, User, Integer[, Date]) - Fires when a message is received from another user. The first argument is the text of the message, the second argument is the sender, the third argument is a bit field containing the message flags (see the IM\_FLAGS constants). The fourth argument is supplied for offline messages and indicates the date and time the message was sent.

* **chatinvite**(User, String, String) - Fires when a chat invitation has been received. The first argument is the sender, the second argument is the chat room name, and the third argument is the invitation message (if available).

* **missed**(User, Integer, Integer) - Fires when the server tells us someone failed while sending us a message. The first argument is the sender, the second argument is the number of messages, and the third argument is the reason (see the IM\_MISSED\_REASONS constants).

* **typing**(String, Integer) - Fires when someone starts or stops typing to us or has entered some text. The first argument is the user name and the second argument is the type of notification (see the TYPING\_NOTIFY constants).

* **chatusersjoin**(String, Array) - Fires when someone joins a chat room you are currently in. The first argument is the chat room name and the second argument is the list of _User_ objects joining the chat room.

* **chatusersleave**(String, Array) - Fires when someone leaves a chat room you are currently in. The first argument is the chat room name and the second argument is the list of _User_ objects leaving the chat room.

* **chatmsg**(String, String) - Fires when someone sends a message to a chat room you are currently in. The first argument is the chat room name and the second argument is the message text.

* **icon**(String, Buffer, String) - Fires when a user's buddy icon has been received. The first argument is the user name, the second argument is the raw icon data, and the third argument indicates the icon size ('small' or 'normal' currently).

* **added**(String) - Fires when someone adds you to their buddy list. The argument is the user name.

* **close**(Boolean) - Fires when the connection is completely closed (similar to net.Stream's close event). The specified Boolean indicates whether the connection was terminated due to a transmission error or not.

* **end**() - Fires when the connection is ended (similar to net.Stream's end event).

* **error**(Error) - Fires when an exception/error occurs (similar to net.Stream's error event). The given Error object represents the error raised.


OscarConnection Properties
--------------------------

* **icon** - An Object representing the logged in user's buddy icon:
    * **datetime** - An Integer representing the UNIX timestamp of when the icon was set.
    * **data** - A Buffer containing the raw icon data (must be 7168 bytes or less).

* **me** - A _User_ object for the logged in user.

* **contacts** - An Object containing user-related information, such as your current buddy list, that is populated upon login and updated during the session:
    * **lastModified** - A Date containing the date and time the buddy list was last modified.
    * **list** - An Object containing the logged in user's buddy list. Each value is an Object containing:
        * **name** - A String containing the group's name.
        * **contacts** - An Object containing the users associated with this group. Each value is an Object containing:
            * **name** - A String containing the user's name.
            * **status** - An Integer representing the user's status (see the USER\_STATUSES constants).
            * **awaitingAuth** - A Boolean indicating whether this user is awaiting your authorization to add you to their list.
            * **localInfo** - An Object containing various optional pieces of information you have set about this user. Valid keys are:
                * **alias** - A String containing a nickname or other alias for this user.
                * **emailAddress** - A String containing an email address for this user.
                * **homePhoneNum** - A String containing a home phone number for this user.
                * **cellPhoneNum** - A String containing a cell phone number for this user.
                * **smsPhoneNum** - A String containing an SMS-capable phone number for this user.
                * **workPhoneNum** - A String containing a work phone number for this user.
                * **otherPhoneNum** - A String containing an other phone number for this user.
                * **notes** - A String containing any additional information for this user.

    * **permit** - An Object containing information about users on your permit list. Each value contains an Object with a 'name' property that holds the particular user's name.
    * **deny** - An Object containing information about users on your deny list. Each value contains an Object with a 'name' property that holds the particular user's name.


OscarConnection Functions
-------------------------

* **(constructor)**([Object]) - _OscarConnection_ - Creates and returns a new instance of OscarConnection using the specified configuration object. Valid properties of the passed in object are:
    * **connection** - An Object containing connection settings
      * **username** - A String representing the username for authentication.
      * **password** - A String representing the password for authentication.
      * **host** - A String representing the hostname or IP address of the OSCAR server. **Default:** SERVER_AOL (predefined constants available, see constants list)
      * **port** - An Integer representing the port of the OSCAR server. **Default:** 5190
      * **connTimeout** - An Integer indicating the number of milliseconds to wait for a connection to be established. **Default:** 10000
      * **allowMultiLogin** - A Boolean indicating whether simultaneous sessions should be allowed. **Default:** true
    * **other** - An Object containing other misc. settings
      * **initialStatus** - An Integer representing the status to log on with (see the USER\_STATUSES constants). **Default:** USER\_STATUSES.ONLINE
      * **initialFlags** - An Integer representing the flags to log on with (see the USER\_FLAGS constants). **Default:** USER\_FLAGS.DCDISABLED

* **connect**(Function) - _(void)_ - Connects to the OSCAR server. The Function parameter is the callback with one argument: the error (undefined if none).

* **end**() - _(void)_ - Disconnects from the OSCAR server.

* **setIdle**(Integer/Boolean) - _(void)_ - If an Integer is supplied, your idle time is set to that many seconds. If Boolean false is given, then you are no longer set as idle. Note: setIdle only needs to be called once when you are idle and again when you are no longer idle. The server will automatically increment the idle time for you, so don't call setIdle every second.

* **sendIM**(String, String[, Integer[, Function]]) - _(void)_ - Sends an instant message. The first parameter is the recipient's user name, the second is the message text. The third parameter is an optional bit field containing message flags to use (see the IM\_FLAGS constants). The Function parameter is an optional callback (with one argument: the error (undefined if none) containing relevant code and subcode properties (see the MSG_ERRORS AND MSG_SUBERRORS constants)) that if supplied, will request an acknowledgement from the server that the message was sent ok.

* **setProfile**(String) - _(void)_ - Sets the currently logged in user's profile to the specified String.

* **warn**(String[, Boolean[, Function]]) - _(void)_ - Warns a user (AIM only). The first parameter is the user name of the person to warn, the second indicates whether the warning should be anonymous (defaults to true), and the Function parameter is the callback with three arguments: the error (undefined if none), the warning level delta, and the new warning level for the user.

* **notifyTyping**(String, Integer) - _(void)_ - Sends typing notifications to a user. The first parameter is the recipient's user name and the second parameter is the notification type (see the TYPING\_NOTIFY constants).

* **addContact**(String, String, Function) - _(void)_ - Adds a user to your buddy list. The first parameter is the user name, the second is the group name, and the Function parameter is the callback with one argument: the error (undefined if none).

* **delContact**(String[, String], Function) - _(void)_ - Removes a user from your buddy list. The first parameter is the user name, the second is the optional group name, and the Function parameter is the callback with one argument: the error (undefined if none).

* **moveContact**(String, String, Function) - _(void)_ - Moves a user from one group to another on your buddy list. The first parameter is the user name, the second is the name of the new (existing) group, and the Function parameter is the callback with one argument: the error (undefined if none).

* **addGroup**(String, Function) - _(void)_ - Adds a group to your buddy list. The first parameter is the new group name and the Function parameter is the callback with one parameter: the error (undefined if none).

* **delGroup**(String[, Boolean],Function) - _(void)_ - Removes a group from your buddy list. The first parameter is the group name, the second is an optional Boolean value that indicates whether the group should be forcefully removed (delete the group even if there are users associated with it) (defaults to false), and the Function parameter is the callback with one argument: the error (undefined if none).

* **renameGroup**(String, String, Function) - _(void)_ - Renames an existing group on your buddy list. The first parameter is the old group name, the second is the new group name, and the Function parameter is the callback with one argument: the error (undefined if none).

* **getInfo**(String, Function) - _(void)_ -  Retrieves a _User_ object for the person specified by the given user name. The Function parameter is the callback with two arguments: the error (undefined if none) and a _User_ object containing the user's information.

* **getIcon**(String, Function) - _(void)_ - Retrieves the buddy icon for the user given by the first parameter. The Function parameter is the callback with three arguments: the error (undefined if none), a Buffer containing the raw icon data, and a String describing the icon size (currently 'normal' or 'small').

* **getOfflineMsgs**() - _(void)_ - Tells the server to send any messages that may have been sent to you while you were offline.

* **joinChat**(String, Function) - _(void)_ - Joins a chat room with the name given by the first parameter. The Function parameter is the callback with one parameter: the error (undefined if none).

* **inviteChat**(String[, String], String) - _String_ - Invites a user to an existing chat room. The first parameter is the chat room name, the optional second parameter is a custom invitation message, and the third parameter is the recipient's user name. A special identifier is returned that can be used to later cancel the invitation.

* **sendChatMsg**(String, String) - _(void)_ - Sends the message to a chat room. The first parameter is the chat room name and the second is the message text.

* **leaveChat**(String) - _(void)_ - Leaves the chat room with the given name.


Constants
---------

The following are available as static constants attached to the module (example: require('./oscar').IM\_FLAGS.AWAY):

* **SERVER\_AOL** - A String containing the host name for logging onto AIM.

* **SERVER\_ICQ** - A String containing the host name for logging onto ICQ.

* **IM\_MISSED\_REASONS**
    * **INVALID** - IM data was invalid.
    * **TOO\_BIG** - Sender's message was too large.
    * **RATE\_EXCEEDED** - Sender exceeded the receiver's rate limit.
    * **SENDER\_EVIL** - Message rejected because sender has been warned.
    * **SELF\_EVIL** - Message rejected because receiver has been warned.

* **IM\_FLAGS**
    * **AWAY** - Autoresponse message due to user currently being set as away.
    * **REQ\_ICON** - Buddy icon was requested.
    * **HAS\_ICON** - Buddy icon exists notification.
    * **OFFLINE** - Message was sent while you were offline.

* **TYPING\_NOTIFY**
    * **FINISH** - User finished typing. This is the default state and is only sent if the user was typing but erased the message.
    * **TEXT\_ENTERED** - User has entered text.
    * **START** - User started typing.
    * **CLOSED** - User closed the IM window (Valid value, but nobody seems to use it though).

* **USER\_FLAGS**
    * **WEBAWARE** - User is web aware (ICQ?).
    * **SHOWIP** - User is showing their IP address.
    * **BIRTHDAY** - It's the user's birthday (ICQ?).
    * **WEBFRONT** - User active webfront (ICQ?).
    * **DCDISABLED** - Direct connection not supported.
    * **DCAUTH** - Direct connection available upon authorization.
    * **DCCONT** - Direct connection available only with users on their buddy list.
    * **HOMEPAGE** - User has a homepage set (ICQ only).

* **USER\_STATUSES**
    * **ONLINE** - User is online.
    * **AWAY** - User is away.
    * **DND** - User is set as do-not-disturb (ICQ).
    * **NA** - User is set as not available (ICQ).
    * **OCCUPIED** - User is occupied (ICQ?).
    * **FREE4CHAT** - User is free for chat (ICQ?).
    * **INVISIBLE** - User is set as invisible (ICQ).
    * **EVIL** - User is evil (extended status) (ICQ?).
    * **DEPRESSION** - User is depressed (extended status) (ICQ?).
    * **ATHOME** - User is at home (extended status) (ICQ?).
    * **ATWORK** - User is at work (extended status) (ICQ?).
    * **LUNCH** - User is out to lunch (extended status) (ICQ?).
    * **OFFLINE** - User is offline.

* **USER\_CLASSES**
    * **UNCONFIRMED** - AOL unconfirmed user.
    * **ADMIN** - AOL administrator.
    * **STAFF** - AOL staff user.
    * **COMMERCIAL** - AOL commercial account.
    * **FREE** - AOL non-commercial account.
    * **AWAY** - Away status flag (???).
    * **ICQ** - ICQ user.
    * **WIRELESS** - Mobile device user.
    * **BOT** - Bot like ActiveBuddy (or SmarterChild?).

* **GENERAL\_ERRORS**
    * **BAD\_SNAC\_HEADER** - Invalid SNAC header.
    * **SERVER\_RATE\_LIMIT** - Server rate limit exceeded.
    * **CLIENT\_RATE\_LIMIT** - Client rate limit exceeded.
    * **RECIPIENT\_UNAVAIL** - Recipient is not logged in.
    * **SERVICE\_UNAVAIL** - Requested service unavailable.
    * **SERVICE\_UNDEFINED** - Requested service not defined.
    * **SNAC\_OBSOLETE** - You sent an obsolete SNAC.
    * **SERVER\_UNSUPPORTED** - Not supported by server.
    * **CLIENT\_UNSUPPORTED** - Not supported by client.
    * **CLIENT\_REFUSED** - Refused by client.
    * **REPLY\_OVERSIZED** - Reply too big.
    * **RESPONSES\_LOST** - Responses lost.
    * **REQUEST\_DENIED** - Request denied.
    * **BAD_SNAC_FORMAT** - Incorrect SNAC format.
    * **NOT\_PRIVILEGED** - Insufficient rights.
    * **RECIPIENT\_BLOCKED** - In local permit/deny (recipient blocked).
    * **EVIL\_SENDER** - Sender too evil.
    * **EVIL\_RECEIVER** - Receiver too evil.
    * **USER\_TEMP\_UNAVAIL** - User temporarily unavailable.
    * **NO\_MATCH** - No match.
    * **LIST\_OVERFLOW** - List overflow.
    * **REQUEST\_VAGUE** - Request ambiguous.
    * **SERVER\_QUEUE\_FULL** - Server queue full.
    * **NOT\_ON\_AOL** - Not while on AOL.

* **AUTH\_ERRORS**
    * **LOGIN\_INVALID1** - Invalid nick or password.
    * **SERVICE\_DOWN1** - Service temporarily unavailable.
    * **OTHER** - All other errors.
    * **LOGIN\_INVALID2** - Incorrect nick or password.
    * **LOGIN\_INVALID3** - Mismatch nick or password.
    * **BAD\_INPUT** - Internal client error (bad input to authorizer).
    * **ACCOUNT\_INVALID** - Invalid account.
    * **ACCOUNT\_DELETED** - Deleted account.
    * **ACCOUNT\_EXPIRED** - Expired account.
    * **NO\_DB\_ACCESS** - No access to database.
    * **NO\_RESOLVER\_ACCESS** - No access to resolver.
    * **DB\_FIELDS\_INVALID** - Invalid database fields.
    * **BAD\_DB\_STATUS** - Bad database status.
    * **BAD\_RESOLVER\_STATUS** - Bad resolver status.
    * **INTERNAL** - Internal error.
    * **SERVICE\_DOWN2** - Service temporarily offline.
    * **ACCOUNT\_SUSPENDED** - Suspended account.
    * **DB\_SEND** - DB send error.
    * **DB\_LINK** - DB link error.
    * **RESERVATION\_MAP** - Reservation map error.
    * **RESERVATION\_LINK** - Reservation link error.
    * **MAX\_IP\_CONN** - The number of users connected from this IP has reached the maximum.
    * **MAX\_IP\_CONN\_RESERVATION** - The number of users connected from this IP has reached the maximum (reservation).
    * **RATE\_RESERVATION** - Rate limit exceeded (reservation). Please try to reconnect in a few minutes.
    * **HEAVILY\_WARNED** - User too heavily warned.
    * **TIMEOUT\_RESERVATION** - Reservation timeout.
    * **CLIENT\_UPGRADE\_REQ** - You are using an older version of ICQ. Upgrade required.
    * **CLINET\_UPGRADE\_REC** - You are using an older version of ICQ. Upgrade recommended.
    * **RATE\_LIMIT\_EXCEED** - Rate limit exceeded. Please try to reconnect in a few minutes.
    * **CANNOT\_REGISTER** - Can't register on the ICQ network. Reconnect in a few minutes.
    * **INVALID\_SECURID** - Invalid SecurID.
    * **ACCOUNT\_SUSPENDED\_AGE** - Account suspended because of your age (age < 13).

* **MSG\_ERRORS**
    * **USER\_OFFLINE** - You are trying to send a message to an offline user.
    * **USER\_UNSUPPORTED\_MSG** - This type of message is not supported by that user.
    * **MSG\_INVALID** - Message is invalid (incorrect format).
    * **BLOCKED** - Receiver/Sender is blocked.

* **MSG\_SUBERRORS**
    * **REMOTE\_IM\_OFF** - User is not accepting incoming IMs.
    * **REMOTE\_RESTRICTED\_BY\_PC** - The user denied the IM because of parental controls.
    * **SMS\_NEED\_LEGAL** - User tried to send a message to an SMS user and is required to accept the legal text first.
    * **SMS\_NO\_DISCLAIMER** - Client tried to send a message to an SMS user without the character counter being displayed.
    * **SMS\_COUNTRY\_UNALLOWED** - Client tried to send a message to an SMS user but the SMS matrix said the country code combination not permitted.
    * **SMS\_UNKNOWN\_COUNTRY** - Client tried to send to an SMS user but the server could not determine the country.
    * **CANNOT\_INIT\_IM** - An IM cannot be initiated by a bot.
    * **IM\_UNALLOWED** - An IM is not allowed by a consumer bot to a user.
    * **USAGE\_LIMIT** - An IM is not allowed by a consumer bot due to reaching a generic usage limit (not common).
    * **DAILY\_USAGE\_LIMIT** - An IM is not allowed by a consumer bot due to reaching the daily usage limit.
    * **MONTHLY\_USAGE\_LIMIT** - An IM is not allowed by consumer bot due to reaching the monthly usage limit.
    * **OFFLINE\_IM\_UNACCEPTED** - User does not accept offline IMs.
    * **OFFLINE\_IM\_EXCEED\_MAX** - User exceeded max offline IM storage limit.
