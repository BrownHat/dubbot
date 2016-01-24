var DubAPI = require('dubapi');
var fs = require('fs');
var _ = require('underscore');
var S = require('string');
var request = require('request');
var Sequelize = require('sequelize');
var Promise = require('bluebird');
var moment = require('moment');
var Cleverbot = require('cleverbot-node');

var commands = [];
var config = require(__dirname + '/config.js');
var SpamProtection = require(__dirname + '/objects/Spamprotection');
var Duell = require(__dirname + '/objects/Duell');
var langfile = require(__dirname + '/files/language.js');
var autotimer;
var duells = [];

var skipable = true;
var helptimeout = false;

var spamfilterdata = {};

var sequelize = new Sequelize(config.db.database, config.db.username, config.db.password, {
    dialect: config.db.dialect,
    host: config.db.host,
    port: config.db.port,
    logging: false
});

//noinspection JSUnresolvedFunction
sequelize.authenticate().then(function (err) {
    if (err) {
        console.log('[ERROR]Unable to connect to the database:', err);
    }
    else {
        console.log('[SUCCESS]Connected to mysql database');
    }
});

var CustomText = sequelize.import(__dirname + '/models/CustomText');
var Label = sequelize.import(__dirname + '/models/Label');
var RandomMessage = sequelize.import(__dirname + '/models/RandomMessage');
var Track = sequelize.import(__dirname + '/models/Track');
var User = sequelize.import(__dirname + '/models/User');


Track.belongsToMany(Label, {through: 'tracktolabel'});
Label.belongsToMany(Track, {through: 'tracktolabel'});

sequelize.sync();

var cleverbot = new Cleverbot;
cleverbot.prepare();

new DubAPI(config.login, function (err, bot) {
    if (err) {
        return console.error(err);
    }
    console.log('Using DubApi ' + bot.version);
    loadCommands();

    bot.connect(config.options.room);

    bot.on('connected', function (data) {
        console.log('Connected: ', data);


        autotimer = setTimeout(function () {
            timings();
        }, _.random(0, 3) * 60 * 1000);

        User.update({removed_for_afk: false, warned_for_afk: false}, {where: {}});

        bot.getUsers().forEach(function (user) {
            spamfilterdata[user.id] = new SpamProtection(user.id);

            var userdata = {
                username: user.username,
                userid: user.id,
                dubs: user.dubs,
                last_active: new Date(),
                afk: false,
                status: true,
                warned_for_afk: false,
                removed_for_afk: false
            };

            User.findOrCreate({where: {userid: userdata.userid}, defaults: userdata}).spread(function (usr) {
                usr.updateAttributes(userdata);
            });
        });
    });

    bot.on('chat-message', function (data) {
        if (data.user !== undefined) {
            console.log('[CHAT]', data.user.username, ':', data.message);
            spamfilterdata[data.user.id].setMuted(false);

            if (data.user.username !== bot.getSelf().username) {
                handleCommand(data);
                if (S(data.message).contains(config.afkremoval.chat_ignore_phrase) === false) {
                    User.update({
                        last_active: new Date(),
                        afk: false,
                        warned_for_afk: false,
                        removed_for_afk: false
                    }, {where: {userid: data.user.id}});
                }

                if (config.chatfilter.enabled === true) {
                    if(config.chatfilter.link_protection.enabled === true && spamfilterdata[data.user.id].canpostLinks() === false && (S(data.message).contains('http://') || S(data.message).contains('https://'))){
                        bot.moderateDeleteChat(data.id);
                        bot.sendChat(S(langfile.chatfilter.link_protection).replaceAll('&{username}', data.user.username).s);
                        return;
                    }
                    if (config.chatfilter.spam.enabled === true) {
                        if (spamfilterdata[data.user.id] !== undefined) {
                            if (spamfilterdata[data.user.id].checkforspam() === true) {
                                if (spamfilterdata[data.user.id].getWarnings() === config.chatfilter.spam.aggressivity.mute && spamfilterdata[data.user.id].getMuted() === false) {
                                    bot.moderateMuteUser(data.user.id);
                                    bot.sendChat(S(langfile.chatfilter.spam.mute).replaceAll('&{username}', data.user.username).s);
                                    cleanchat(data.user.id);
                                    spamfilterdata[data.user.id].setMuted(true);
                                    spamfilterdata[data.user.id].reset();
                                    return;
                                } else if (spamfilterdata[data.user.id].getScore() === config.chatfilter.spam.aggressivity.delete) {
                                    spamfilterdata[data.user.id].increaseSpamWarnings();
                                    cleanchat(data.user.id);
                                    bot.sendChat(S(langfile.chatfilter.spam.warning).replaceAll('&{username}', data.user.username).s);
                                    return;
                                } else {
                                    spamfilterdata[data.user.id].increaseScore();
                                }
                            } else {
                                spamfilterdata[data.user.id].updateMessage(data.message);
                            }
                        } else {
                            spamfilterdata[data.user.id] = new SpamProtection(data.user.id);
                        }
                    }
                    if (config.chatfilter.dubtrackroom === true) {
                        if (S(data.message).contains('dubtrack.fm/join/') === true) {
                            bot.moderateDeleteChat(data.id);
                            bot.sendChat(S(langfile.chatfilter.dubtrackroom).replaceAll('&{username}', data.user.username).s);
                            spamfilterdata[data.user.id].increaseScore();
                            return;
                        }
                    }
                    if (config.chatfilter.youtube === true) {
                        if (S(data.message).contains('youtu.be') === true || (S(data.message).contains('http') === true && S(data.message).contains('youtube.') === true)) {
                            bot.moderateDeleteChat(data.id);
                            bot.sendChat(S(langfile.chatfilter.youtube).replaceAll('&{username}', data.user.username).s);
                            spamfilterdata[data.user.id].increaseScore();
                            return;
                        }
                    }
                    if (config.chatfilter.word_blacklist.enabled === true) {
                        var found = false;
                        config.chatfilter.word_blacklist.words.forEach(function (word) {
                            if (S(data.message).contains(word) === true) {
                                found = true;
                            }
                        });
                        if (found === true) {
                            bot.moderateDeleteChat(data.id);
                            bot.sendChat(S(langfile.chatfilter.word_blacklist).replaceAll('&{username}', data.user.username).s);
                            spamfilterdata[data.user.id].increaseScore();
                            return;
                        }
                    }
                }

                if (config.cleverbot.enabled === true && S(data.message).contains('@' + bot.getSelf().username) === true) {
                    cleverbot.write(S(data.message).replaceAll('@' + bot.getSelf().username, '').s, function (res) {
                        bot.sendChat('@' + data.user.username + ' ' + res.message);
                    });
                }
            }
        } else {
            console.log('[CHAT]', 'undefined', ':', data.message);
        }

    });

    bot.on('room_playlist-update', function (data) {
        try {
            console.log('[ADVANCE]', data.user.username, ': [', data.media.name, '|', data.media.id, '|', data.media.fkid, '|', data.media.type, '|', data.media.songLength, ']');
        } catch (e) {

        }

        if (data.lastPlay !== undefined) {
            Track.update({last_played: new Date()}, {where: {dub_id: data.lastPlay.media.id}});
        }

        if (data.media !== undefined) {
            checksong(data.media, data.id);

            if (config.autoskip.stucksongs === true) {
                setTimeout(function () {
                    if (data.id === bot.getPlayID()) {
                        bot.moderateSkip();
                        bot.sendChat(S(langfile.autoskip.stuck_song).replaceAll('&{track}', data.media.name));
                    }
                }, (data.media.songLength + 10) * 1000);
            }
        }

        if (config.options.room_state_file === true) {
            var usrs = [];
            var stff = [];
            bot.getUsers().forEach(function (user) {
                if (user.id !== bot.getSelf().id) {
                    usrs.push(user);
                }
            });
            bot.getStaff().forEach(function (user) {
                if (user.id !== bot.getSelf().id) {
                    stff.push(user);
                }
            });
            var stats = {
                room: config.options.room,
                media: bot.getMedia(),
                users: usrs,
                staff: stff,
                bot: bot.getSelf()
            };
            fs.writeFile(__dirname + '/stats.json', JSON.stringify(stats, null, '\t'), 'utf8');
        }
    });

    bot.on('error', function (err) {
        console.log('[ERROR]', err);
        clearTimeout(autotimer);
        bot.reconnect();
    });

    bot.on('user-join', function (data) {
        console.log('[JOIN]', '[', data.user.username, '|', data.user.id, '|', data.user.dubs, ']');
        if (spamfilterdata[data.user.id] === undefined) {
            spamfilterdata[data.user.id] = new SpamProtection(data.user.id);
            spamfilterdata[data.user.id].setpostLink(false);
            setTimeout(function(){
                spamfilterdata[data.user.id].setpostLink(true)
            }, config.chatfilter.link_protection.timeout * 60 * 1000);
        }

        var userdata = {
            username: data.user.username,
            userid: data.user.id,
            dubs: data.user.dubs,
            last_active: new Date(),
            afk: false,
            status: true,
            warned_for_afk: false,
            removed_for_afk: false
        };

        setTimeout(function () {
            User.findOrCreate({where: {userid: userdata.userid}, defaults: userdata}).spread(function (usr, created) {
                if (created) {
                    bot.sendChat(S(langfile.welcome_users.new).replaceAll('&{username}', data.user.username).s);
                } else {
                    bot.sendChat(S(langfile.welcome_users.default).replaceAll('&{username}', data.user.username).s);
                }
                usr.updateAttributes(userdata);
            });
        }, 10 * 1000)
    });

    bot.on('user-leave', function (data) {
        console.log('[LEAVE]', '[', data.user.username, '|', data.user.id, '|', data.user.dubs, ']');
        User.update({
            last_active: new Date(),
            afk: false,
            warned_for_afk: false,
            removed_for_afk: false,
            status: false
        }, {where: {userid: data.user.id}});
    });

    bot.on('room-update', function (data) {
        console.log('[ROOM-UPDATE]');
    });


    bot.on('user-unmute', function (data) {
        spamfilterdata[data.user.id].setMuted(false);
    });

    bot.on('room_playlist-dub', function (data) {
        if (config.autoskip.votes.enabled) {
            var dj = bot.getDJ();
            var track = bot.getMedia();
            if (typeof config.autoskip.votes.condition === 'number') {
                if (bot.getScore().downdubs > config.autoskip.votes.condition) {
                    bot.moderateSkip();
                    bot.sendChat(S(langfile.autoskip.vote.reach_limit).replaceAll('&{username}', dj.username).replaceAll('&{track}', track.name).s);
                }
            } else if (typeof config.autoskip.votes.condition === 'object') {
                var score = bot.getScore();
                if (score.downdubs >= config.autoskip.votes.condition.max) {
                    bot.moderateSkip();
                    bot.sendChat(S(langfile.autoskip.vote.reach_limit).replaceAll('&{username}', dj.username).replaceAll('&{track}', track.name).s);
                } else if (score.downdubs >= config.autoskip.votes.condition.min && (bot.getUsers().length) / score.downdubs > config.autoskip.votes.condition.ratio) {
                    bot.moderateSkip();
                    bot.sendChat(S(langfile.autoskip.vote.reach_limit).replaceAll('&{username}', dj.username).replaceAll('&{track}', track.name).s);
                }
            } else if (typeof config.autoskip.votes.condition === 'function') {
                score.usercount = bot.getUsers.length;
                score.users = bot.getUsers();
                score.staff = bot.getStaff();
                if (config.autoskip.votes.condition(score) === true) {
                    bot.moderateSkip();
                    bot.sendChat(S(langfile.autoskip.vote.reach_limit).replaceAll('&{username}', dj.username).replaceAll('&{track}', track.name).s);
                }
            }
        }
    });


    //functions

    function handleCommand(data) {
        var command = commands.filter(function (cmd) {
            var found = false;
            for (i = 0; i < cmd.names.length; i++) {
                if (!found) {
                    found = (cmd.names[i] == data.message.toLowerCase() || (cmd.matchStart && data.message.toLowerCase().indexOf(cmd.names[i]) == 0));
                }
            }
            return found;
        })[0];
        if (command && command.enabled) {
            command.handler(data, bot);
            console.log('[COMMAND] Executed command ' + command.names[0] + ' (' + data.message + ')');
        }

        if (S(data.message).startsWith(config.options.customtext_trigger) === true) {
            CustomText.find({where: {trigger: S(data.message).chompLeft(config.options.customtext_trigger).s}}).then(function (row) {
                if (row !== undefined && row !== null) {
                    bot.sendChat(S(row.response).replaceAll('&{username}', data.user.username).s);
                }
            });
        }
    }

    function loadCommands() {
        //moderation commands
        commands.push({
            names: ['!fs', '!skip'],
            handler: function (data) {
                if (bot.hasPermission(data.user, 'skip') && skipable) {
                    var dj = bot.getDJ();
                    bot.moderateSkip();
                    skipable = false;
                    setTimeout(function () {
                        skipable = true;
                    }, 3 * 1000);
                    var split = data.message.split(' ');
                    if (split.length > 1 && dj !== undefined) {
                        var msg = split[1].trim();
                        setTimeout(function () {
                            bot.sendChat(S(_.findWhere(langfile.skipreasons, {reason: msg}).msg).replaceAll('&{dj}', dj.username).s);
                        }, 3 * 1000);
                    }
                }
            },
            hidden: true,
            enabled: true,
            matchStart: true
        });

        commands.push({
            names: ['!bl', '!blacklist'],
            hidden: true,
            enabled: true,
            matchStart: true,
            handler: function (data) {
                if (bot.hasPermission(data.user, 'ban')) {
                    var track = bot.getMedia();
                    var dj = bot.getDJ();
                    bot.moderateSkip();
                    skipable = false;
                    setTimeout(function () {
                        skipable = true;
                    }, 3 * 1000);
                    var split = data.message.trim().split(' ');
                    if (split.length === 1) {
                        Track.update({blacklisted: true}, {where: {dub_id: track.id}});
                        bot.sendChat(S(S(langfile.blacklist.blacklisted).replaceAll('&{track}', track.name).s).replaceAll('&{moderator}', data.user.username).replaceAll('&{dj}', dj.username).s);
                    } else {
                        var reason = _.rest(split, 1).join(' ').trim();
                        Track.update({blacklisted: true, bl_reason: reason}, {where: {dub_id: track.id}});
                        bot.sendChat(S(S(langfile.blacklist.blacklisted_reason).replaceAll('&{track}', track.name).s).replaceAll('&{moderator}', data.user.username).replaceAll('&{dj}', dj.username).replaceAll('&{reason}', reason).s);
                    }
                    console.log('[BLACKLIST]', data.user.username, ': [', track.name, '|', track.id, '|', track.fkid, ']');
                }
            }
        });

        commands.push({
            names: ['!qbl', '!queueblacklist'],
            hidden: true,
            enabled: true,
            matchStart: true,
            handler: function (data) {
                if (bot.hasPermission(data.user, 'ban')) {
                    var split = data.message.trim().split(' ');
                    if (split.length > 1) {
                        var pos = parseInt(split[1]);
                        if (pos !== undefined && bot.getQueue().length > pos) {
                            var queueobj = bot.getQueue()[pos - 1];
                            Track.findOrCreate({
                                where: {dub_id: queueobj.media.id}, defaults: {
                                    name: queueobject.media.name,
                                    dub_id: queueobject.media.id,
                                    type: queueobject.media.type,
                                    source_id: queueobject.media.fkid,
                                    thumbnail: queueobject.media.thumbnail,
                                    blacklisted: true,
                                    songLength: queueobject.media.songLength
                                }
                            }).then(function (track, created) {
                                if (split.length > 2) {
                                    track[0].updateAttributes({bl_reason: _.rest(split, 2).join(' ').trim()});
                                    bot.moderateRemoveSong(queueobj.user.id);
                                    bot.sendChat(S(langfile.blacklist.queueblacklist_reason).replaceAll('&{dj}', queueobj.user.username).replaceAll('&{track}', queueobj.media.name).replaceAll('&{moderator}', data.user.username).replaceAll('&{reason}', _.rest(split, 2).join(' ').trim()).s);
                                } else {
                                    bot.moderateRemoveSong(queueobj.user.id);
                                    bot.sendChat(S(langfile.blacklist.queueblacklist_reason).replaceAll('&{dj}', queueobj.user.username).replaceAll('&{track}', queueobj.media.name).replaceAll('&{moderator}', data.user.username).s);
                                }
                            });
                        } else {
                            bot.sendChat(langfile.error.argument);
                        }
                    }

                }
            }
        });

        commands.push({
            names: ['!unbl', '!unblacklist'],
            hidden: true,
            enabled: true,
            matchStart: true,
            handler: function (data) {
                if (bot.hasPermission(data.user, 'ban')) {
                    var msg = data.message.split(' ');
                    var trackid;
                    try {
                        trackid = parseInt(msg[1]);
                    } catch (e) {
                        bot.sendChat(langfile.errors.argument);
                        return;
                    }
                    Track.find({where: {id: trackid}}).then(function (row) {
                        Track.update({blacklisted: false, bl_reason: null}, {where: {id: trackid}});
                        bot.sendChat(S(S(langfile.blacklist.unblacklisted).replaceAll('&{track}', row.name).s).replaceAll('&{username}', data.user.username).s);
                        console.log('[UNBLACKLIST]', data.user.username, ': [', row.name, '|', row.id, '|', row.fkid, ']');
                    });
                }
            }
        });


        //todo fix sequelize errors
        /*commands.push({
         names: ['!label', '!lbl'],
         hidden: true,
         enabled: true,
         matchStart: true,
         handler: function (data) {
         if (bot.hasPermission(data.user, 'ban')) {
         var media = bot.getMedia();
         var playid = bot.getPlayID();
         var split = data.message.trim().split(' ');
         if (split.length === 1) {
         Track.find({where: {dub_id: media.id}}).then(function (track) {
         track.getLabels().then(function (labels) {
         var lab = '';
         labels.forEach(function (label, index) {
         lab += label.name;
         if (index !== labels.length - 1) {
         lab += ', ';
         }
         });
         bot.sendChat(S(langfile.labels.labels_found).replaceAll('&{track}', track.name).replaceAll('&{labels}', lab).s);
         });
         });
         } else if (split.length === 3) {
         if (split[1] === 'add') {
         Label.findOrCreate({
         where: {name: split[2]},
         defaults: {name: split[2]}
         }).then(function (label) {
         Track.find({where: {dub_id: media.id}}).then(function (track) {
         label.addTracks(track);
         checksong(media, playid);
         });
         });
         } else if (split[1] === 'set') {
         Label.findOrCreate({
         where: {name: split[2]},
         defaults: {name: split[2]}
         }).then(function (label) {
         Track.find({where: {dub_id: media.id}}).then(function (track) {
         track.setLabels([label]);
         checksong(media, playid);
         });
         });
         }
         }
         }
         }
         });*/

        commands.push({
            names: ['!move'],
            hidden: true,
            enabled: true,
            matchStart: true,
            handler: function (data) {
                if (bot.hasPermission(data.user, 'queue-order')) {
                    var split = data.message.split(' ');
                    var user = bot.getUserByName(S(split[1].trim()).chompLeft('@').s);
                    var pos = parseInt(split[2].trim());
                    if (user !== undefined && pos !== undefined) {
                        bot.moderateMoveDJ(user.id, pos - 1);
                    } else {
                        bot.sendChat(langfile.errors.argument);
                    }
                }
            }
        });

        commands.push({
            names: ['!clearchat'],
            hidden: true,
            enabled: true,
            matchStart: false,
            handler: function (data) {
                if (bot.hasPermission(data.user, 'delete-chat')) {
                    var chathistory = bot.getChatHistory();
                    chathistory.forEach(function (chat) {
                        setTimeout(function () {
                            bot.moderateDeleteChat(chat.id);
                        }, _.random(1, 3) * _.random(1 * 5) * 1000);
                    });
                    setTimeout(function () {
                        bot.sendChat(S(langfile.clearchat.default).replaceAll('&{username}', data.user.username).s);
                    }, 16 * 1000);
                }
            }
        });

        commands.push({
            names: ['!delchat'],
            hidden: true,
            enabled: true,
            matchStart: true,
            handler: function (data) {
                if (bot.hasPermission(data.user, 'delete-chat')) {
                    var split = data.message.trim().split(' ');
                    var user = bot.getUserByName(S(split[1]).replaceAll('@', '').s);
                    if (user !== undefined) {
                        cleanchat(user.id);
                    }
                }
            }
        });

        commands.push({
            names: ['!sudo'],
            hidden: true,
            enabled: true,
            matchStart: true,
            handler: function (data) {
                if (bot.hasPermission(data.user, 'set-roles')) {
                    bot.sendChat(S(data.message).chompLeft('!sudo').s.trim());
                }
            }
        });

        commands.push({
            names: ['!addcustomtext', '!addct'],
            hidden: true,
            enabled: true,
            matchStart: true,
            handler: function (data) {
                if (bot.hasPermission(data.user, 'set-roles')) {
                    var texts = data.message.trim().split(' ');
                    var newtrigger = S(texts[1].trim()).chompLeft(config.options.customtext_trigger).s;
                    var newresponse = _.rest(texts, 2).join(' ').trim();
                    CustomText.findOrCreate({
                        where: {trigger: newtrigger},
                        defaults: {trigger: newtrigger, response: newresponse}
                    }).spread(function (customtext) {
                        customtext.updateAttributes({trigger: newtrigger, response: newresponse})
                    });
                    console.log('[CUSTOMTEXT]', data.user.username, ': [', texts[1], '|', texts[2], ']');
                }
            }
        });

        commands.push({
            names: ['!randommessage', '!rndmsg'],
            hidden: true,
            enabled: true,
            matchStart: true,
            handler: function (data) {
                if (bot.hasPermission(data.user, 'set-roles')) {
                    var split = data.message.trim().split(' ');
                    if (split.length === 2) {
                        if (split[1] === 'list') {
                            RandomMessage.findAll().then(function (rows) {
                                rows.forEach(function (row) {
                                    bot.sendChat('[' + row.id + '|' + row.status + '] ' + row.message);
                                });
                            });
                        }
                    } else if (split.length === 3) {
                        if (split[1] === 'del') {
                            var msg = parseInt(split[2]);
                            if (msg !== undefined) {
                                RandomMessage.destroy({where: {id: msg}});
                                bot.sendChat(S(langfile.randommessage.delete).replaceAll('&{id}', msg).s);
                            } else {
                                bot.sendChat(langfile.errors.argument);
                            }
                        } else if (split[1] === 'disable') {
                            var msg = parseInt(split[2]);
                            if (msg !== undefined) {
                                RandomMessage.update({status: false}, {where: {id: msg}});
                                bot.sendChat(S(langfile.randommessage.disable).replaceAll('&{id}', msg).s);
                            } else {
                                bot.sendChat(langfile.errors.argument);
                            }
                        } else if (split[1] === 'enable') {
                            var msg = parseInt(split[2]);
                            if (msg !== undefined) {
                                RandomMessage.update({status: true}, {where: {id: msg}});
                                bot.sendChat(S(langfile.randommessage.enable).replaceAll('&{id}', msg).s);
                            } else {
                                bot.sendChat(langfile.errors.argument);
                            }
                        }
                    } else if (split.length > 2) {
                        if (split[1] === 'add') {
                            RandomMessage.create({message: _.rest(split, 2).join(' ').trim()});
                            bot.sendChat(langfile.randommessage.add);
                        }
                    }
                }
            }
        });

        commands.push({
            names: ['!afkcheck'],
            hidden: true,
            enabled: true,
            matchStart: false,
            handler: function (data) {
                if (bot.hasPermission(data.user, 'skip')){
                    afkcheck();
                    User.findAll({where: {afk: true}}).then(function (rows) {
                        var afks = '';
                        rows.forEach(function (user, index, array) {
                            afks += user.username;
                            if (index !== rows.length - 1) {
                                afks += ', ';
                            }
                            if (afks.length > 2) {
                                bot.sendChat(S(langfile.afk.check).replaceAll('&{afks}', afks).s);
                            }
                        });

                    });
                }
            }
        });

        commands.push({
            names: ['!lottery'],
            hidden: true,
            enabled: true,
            matchStart: true,
            handler: function (data) {
                if (bot.hasPermission(data.user, 'queue-order')) {
                    var split = data.message.split(' ');
                    var time = 2;
                    if (split.lenght === 2) {
                        time = parseInt(split[1].trim());
                    }
                    setTimeout(function () {
                        var queue = bot.getQueue();
                        var mover = queue[_.random(0, queue.lenght - 1)];
                        if (mover === undefined) {
                            bot.sendChat(langfile.lottery.no_winner);
                            return;
                        }
                        bot.sendChat(S(langfile.lottery.victory).replaceAll('&{username}', mover.user.username));
                        bot.moderateMoveDJ(mover.uid, 0);
                    }, time * 60 * 1000);
                    bot.sendChat(S(langfile.lottery.started).replaceAll('&{time}', time).s);
                }
            }
        });

        commands.push({
            names: ['!roulette'],
            hidden: true,
            enabled: true,
            matchStart: true,
            handler: function (data) {
                if (bot.hasPermission(data.user, 'queue-order')) {
                    var split = data.message.split(' ');
                    var time = 2;
                    if (split.lenght === 2) {
                        time = parseInt(split[1].trim());
                    }
                    setTimeout(function () {
                        var queue = bot.getQueue();
                        var moverpos = _.random(1, queue.lenght - 1);
                        var mover = queue[moverpos];
                        if (mover === undefined) {
                            bot.sendChat(langfile.roulette.no_winner);
                            return;
                        }

                        bot.sendChat(S(langfile.roulette.victory).replaceAll('&{username}', mover.user.username));
                        bot.moderateMoveDJ(mover.uid, _.random(0, moverpos));
                    }, time * 60 * 1000);
                    bot.sendChat(S(langfile.roulette.started).replaceAll('&{time}', time).s);
                }
            }
        });

        //tech commands
        commands.push({
            names: ['!ping'],
            handler: function (data) {
                if (bot.hasPermission(data.user, 'skip')) {
                    bot.sendChat(langfile.ping.default);
                }
            },
            hidden: true,
            enabled: true,
            matchStart: false
        });


        //user commands
        commands.push({
            names: ['!help'],
            handler: function (data) {
                if (helptimeout === false) {
                    var mods = '';
                    bot.getStaff().forEach(function (mod, index, array) {
                        if (mod.id !== bot.getSelf().id) {
                            mods += '@' + mod.username + ' '
                        }
                    });
                    if (mods.length > 2) {
                        bot.sendChat(S(langfile.help.default).replaceAll('&{mods}', mods).s);
                    } else {
                        bot.sendChat(langfile.help.no_one_here);
                    }
                    helptimeout = true;
                    setTimeout(function () {
                        helptimeout = false
                    }, 10 * 1000);
                }
            },
            hidden: true,
            enabled: true,
            matchStart: false
        });

        commands.push({
            names: ['!link'],
            handler: function (data) {
                if (bot.getRoomMeta().roomType === 'room') {
                    var media = bot.getMedia();
                    if (media !== undefined) {
                        if (media.type === 'youtube') {
                            bot.sendChat(S(langfile.link.default).replaceAll('&{link}', 'https://youtu.be/' + media.fkid).s);
                        } else if (media.type === 'soundcloud') {
                            request.get('http://api.soundcloud.com/tracks/' + media.fkid + '?client_id=' + config.apiKeys.soundcloud, function (err, head, body) {
                                if (!err && head.statusCode === 200) {
                                    var sdata = JSON.parse(body);
                                    bot.sendChat(S(langfile.link.default).replaceAll('&{link}', sdata.permalink_url).s);
                                } else {
                                    bot.sendChat(langfile.error.default);
                                }
                            });
                        } else {
                            bot.sendChat(langfile.error.default);
                        }
                    } else {
                        bot.sendChat(langfile.link.no_media);
                    }
                } else if (bot.getRoomMeta().roomType === 'iframe') {
                    bot.sendChat(S(langfile.link.iframe).replaceAll('&{link}', bot.getRoomMeta().roomEmbed).s);
                } else {
                    bot.sendChat(langfile.error.default);
                }
            },
            hidden: true,
            enabled: true,
            matchStart: false
        });

        commands.push({
            names: ['!define'],
            hidden: true,
            enabled: true,
            matchStart: true,
            handler: function (data) {
                var msg = _.rest(data.message.split(' '), 1).join(' ').trim();
                if (msg.length > 0 && config.apiKeys.wordnik) {
                    var uri = "http://api.wordnik.com:80/v4/word.json/" + msg + "/definitions?limit=200&includeRelated=true&useCanonical=true&includeTags=false&api_key=" + config.apiKeys.wordnik;
                    request.get(uri, function (error, response, body) {
                        if (!error && response.statusCode == 200) {
                            var definition = JSON.parse(body);
                            if (definition.length === 0) {
                                bot.sendChat(S(langfile.define.no_definition_found).replaceAll('&{word}', msg).s);
                            } else {
                                bot.sendChat(S(S(langfile.define.definition_found).replaceAll('&{word}', msg).s).replaceAll('&{definition}', definition[0].text).s);
                            }
                        }
                    });
                }
            }
        });


        commands.push({
            names: ['!duell'],
            hidden: true,
            enabled: true,
            matchStart: true,
            handler: function (data) {
                var split = data.message.trim().split(' ');
                if (split.length === 2) {
                    if (split[1] === 'accept') {
                        var duell = _.findWhere(duells, {active: true, c_id: data.user.id});
                        if (duell) {
                            var result = duell.start();
                            if (result.status === true) {
                                bot.sendChat(S(langfile.duell.winner).replaceAll('&{winner}', result.winner.username).replaceAll('&{loser}', result.loser.username).s);
                                bot.moderateRemoveDJ(result.loser.id);
                            } else {
                                bot.sendChat(langfile.duell.no_open_duells);
                            }
                        } else {
                            bot.sendChat(langfile.duell.no_open_duells);
                        }
                    } else if (split[1] === 'decline') {
                        var duell = _.findWhere(duells, {active: true, c_id: data.user.id});
                        if (duell) {
                            duell.setStatus(false);
                            bot.sendChat(S(langfile.duell.decline).replaceAll('&{challenged}', duell.challenged.username).s);
                        } else {
                            bot.sendChat(langfile.duell.no_open_duells);
                        }
                    } else {
                        var user = bot.getUserByName(S(split[1]).replace('@', '').s);
                        if (user) {
                            if (user.id === data.user.id) {
                                bot.sendChat(langfile.error.argument);
                                return;
                            }
                            duells.push(new Duell(data.user, user));
                            bot.sendChat(S(langfile.duell.start).replaceAll('&{challenged}', user.username).replaceAll('&{challenger}', data.user.username).s);
                        } else {
                            bot.sendChat(langfile.error.argument);
                        }
                    }
                } else {
                    bot.sendChat(langfile.error.argument);
                }
            }
        });
    }

    function timings() {
        if (config.afkremoval.enabled === true) {
            afkcheck();
            if (config.afkremoval.kick === true) {
                kickforafk();
            }
            warnafk();
            removeafk();
        }

        if (config.queuecheck.enabled === true) {
            checkQueue(bot.getQueue());
        }
        var minutes = _.random(2, 10);
        autotimer = setTimeout(function () {
            timings();
        }, minutes * 60 * 1000);

        if (config.options.random_messages) {
            RandomMessage.findAll({where: {status: true}}).then(function (rows) {
                if (rows.length !== 0) {
                    bot.sendChat(rows[_.random(0, rows.length - 1)].message);
                }
            });
        }
    }

    function afkcheck() {
        bot.getUsers().forEach(function (user) {
            User.find({where: {userid: user.id}}).then(function (row) {
                var now = moment();
                if (row !== undefined && row !== null) {
                    if (now.diff(row.last_active, 'seconds') > config.afkremoval.timeout) {
                        User.update({afk: true}, {where: {userid: user.id}});
                    }
                }
            });
        });
    }

    function warnafk() {
        User.findAll({where: {afk: true, warned_for_afk: false}}).then(function (users) {
            var afks = [];
            var queue = bot.getQueue();
            users.forEach(function (user) {
                if (_.contains(queue, bot.getUser(user.userid))) {
                    afks.push('@' + user.username);
                    User.update({warned_for_afk: true}, {where: {id: user.id}});
                }
            });
            if (afks.length !== 0) {
                bot.sendChat(afks.join(' ').trim() + langfile.afk.warning);
            }
        });
    }

    function removeafk() {
        User.findAll({where: {warned_for_afk: true}}).then(function (users) {
            var afks = [];
            var queue = bot.getQueue();
            users.forEach(function (user) {
                if (_.contains(queue, bot.getUser(user.userid))) {
                    afks.push('@' + user.username);
                    bot.moderateRemoveDJ(user.userid);
                    User.update({removed_for_afk: true}, {where: {id: user.id}});
                }
            });

            if (afks.length !== 0) {
                bot.sendChat(afks.join(' ').trim() + langfile.afk.remove);
            }
        });
    }

    function kickforafk() {
        User.findAll({where: {removed_for_afk: true}}).then(function (users) {
            var afks = [];
            var afk_names = [];
            var queue = bot.getQueue();
            users.forEach(function (user) {
                if (_.contains(queue, bot.getUser(user.userid)) && bot.hasPermission(bot.getUser(user.userid), 'queue-order') === false) {
                    afks.push(bot.getUser(user.userid));
                    afk_names.push('@' + user.username);
                }
            });

            if (afks.length > 0) {
                bot.sendChat(afk_names.join(' ').trim() + langfile.afk.kick)

                afks.forEach(function (user) {
                    if (bot.isStaff(user)) {
                        var role = user.role;
                        bot.moderateUnsetRole(user.id, role, function (err, body) {
                            if (!err) {
                                bot.moderateKickUser(user.id, langfile.afk.kick_msg, function (err) {
                                    if (!err) {
                                        bot.moderateSetRole(user.id, role);
                                    }
                                });
                            }
                        });
                    }
                });
            }
        });
    }

    function checksong(media, playid) {
        if (media.songLength > config.autoskip.timelimit.limit * 1000 && config.autoskip.timelimit.enabled) {
            bot.moderateSkip();
            bot.sendChat(langfile.autoskip.timelimit.default);
        }

        var trackdata = {
            name: media.name,
            dub_id: media.id,
            type: media.type,
            source_id: media.fkid,
            thumbnail: media.thumbnail,
            songLength: media.songLength
        };

        Track.findOrCreate({where: {dub_id: trackdata.dub_id}, defaults: trackdata}).then(function (trackl, created) {
            if (!created && bot.getPlayID() === playid) {
                var track = trackl[0];
                var dj = bot.getDJ();
                if (track.blacklisted) {
                    bot.moderateSkip();
                    if (track.bl_reason !== undefined && track.bl_reason !== null) {
                        bot.sendChat(S(langfile.blacklisted.is_blacklisted).replaceAll('&{track}', track.name).replaceAll('&{dj}', dj.username).replaceAll('&{reason}', track.bl_reason).s);
                    } else {
                        bot.sendChat(S(langfile.blacklisted.is_blacklisted).replaceAll('&{track}', track.name).replaceAll('&{dj}', dj.username).s);
                    }
                } else if (config.autoskip.history.enabled === true && moment().diff(track.last_played, 'minutes') < config.autoskip.history.time && track.last_played !== undefined) {
                    bot.moderateSkip();
                    bot.sendChat(S(langfile.autoskip.history).replaceAll('&{username}', dj.username).replaceAll('&{track}', track.name).s);
                }
                /*track.getLabels().then(function (tracks) {
                 if (playid === bot.getPlayID()) {
                 var moderated = false;
                 tracks.forEach(function (trck) {
                 if(moderated === false){
                 if (config.autoskip.history.enabled === true && moment().diff(trck.last_played, 'minutes') < config.autoskip.history.time && trck.last_played !== undefined) {
                 bot.moderateSkip();
                 bot.sendChat(langfile.autoskip.history);
                 moderated = true;
                 }
                 }
                 });
                 }
                 });*/
            }
        });
    }

    function checkQueue(queue) {
        queue.forEach(function (queueobject) {
            var trackdata = {
                name: queueobject.media.name,
                dub_id: queueobject.media.id,
                type: queueobject.media.type,
                source_id: queueobject.media.fkid,
                thumbnail: queueobject.media.thumbnail,
                songLength: queueobject.media.songLength
            };

            Track.findOrCreate({
                where: {dub_id: queueobject.media.id},
                defaults: trackdata
            }).then(function (tracks, created) {
                var track = tracks[0];
                if (!created) {
                    if (track.blacklisted) {
                        if (config.queuecheck.action === 'REMOVESONG') {
                            bot.moderateRemoveSong(queueobject.user.id);
                        } else if (config.queuecheck.action === 'REMOVEDJ') {
                            bot.moderateRemoveDJ(queueobject.user.id);
                        }
                        if (track.bl_reason !== undefined && track.bl_reason !== null) {
                            bot.sendChat(S(langfile.queuecheck.blacklisted_reason).replaceAll('&{username}', queueobject.user.username).replaceAll('&{track}', track.name).replaceAll('&{reason}', track.bl_reason).s);
                        } else {
                            bot.sendChat(S(langfile.queuecheck.blacklisted).replaceAll('&{username}', queueobject.user.username).replaceAll('&{track}', track.name).s);
                        }
                    } else if (config.autoskip.history.enabled === true && moment().diff(track.last_played, 'minutes') < config.autoskip.history.time && track.last_played !== undefined) {
                        if (config.queuecheck.action === 'REMOVESONG') {
                            bot.moderateRemoveSong(queueobject.user.id);
                        } else if (config.queuecheck.action === 'REMOVEDJ') {
                            bot.moderateRemoveDJ(queueobject.user.id);
                        }
                        bot.sendChat(S(langfile.queuecheck.history).replaceAll('&{username}', queueobject.user.username).replaceAll('&{track}', track.name).s);
                    }

                    //todo add label when working
                }
            });
        });
    }

    function cleanchat(userid) {
        if (userid === undefined) {

        } else {
            bot.getChatHistory().forEach(function (chat) {
                if (chat.user.id === userid) {
                    setTimeout(function () {
                        bot.moderateDeleteChat(chat.id);
                    }, _.random(2, 4) * 1000);
                }
            });
        }
    }


});

