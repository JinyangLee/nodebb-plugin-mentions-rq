'use strict';

var	async = require('async'),
	XRegExp = require('xregexp').XRegExp,

	nconf = module.parent.require('nconf'),
	Topics = module.parent.require('./topics'),
	User = module.parent.require('./user'),
	Groups = module.parent.require('./groups'),
	Notifications = module.parent.require('./notifications'),
	Utils = module.parent.require('../public/src/utils'),
	Emailer = module.parent.require('./emailer'),
	Meta = module.parent.require('./meta'),

	SocketPlugins = module.parent.require('./socket.io/plugins'),

	regex = XRegExp('(@[\\p{L}\\d\\-_.]+)', 'g'),
	isLatinMention = /@[\w\d\-_.]+$/,
	removePunctuationSuffix = function(string) {
		return string.replace(/[!?.]*$/, '');
	},

	Mentions = {};

SocketPlugins.mentions = {};

Mentions.notify = function(postData) {
	function filter(matches, method, callback) {
		async.filter(matches, function(match, next) {
			method(match, function(err, exists) {
				next(!err && exists);
			});
		}, function(matches) {
			callback(null, matches);
		});
	}

	var cleanedContent = Mentions.clean(postData.content, true, true, true);
	var matches = cleanedContent.match(regex);

	if (!matches) {
		return;
	}

	var noMentionGroups = ['registered-users', 'guests'];

	matches = matches.map(function(match) {
		var slugReg = new RegExp('<a href="/community/user/([^"]*)">(' + match + ')</a>');
		return cleanedContent.match(slugReg) ? cleanedContent.match(slugReg)[1] : null;
	}).filter(function(match, index, array) {
		return match && array.indexOf(match) === index && noMentionGroups.indexOf(match) === -1;
	});

	async.parallel({
		userRecipients: function(next) {
			filter(matches, User.exists, next);
		},
		groupRecipients: function(next) {
			filter(matches, Groups.exists, next);
		}
	}, function(err, results) {
		if (err) {
			return;
		}

		async.parallel({
			topic: function(next) {
				Topics.getTopicFields(postData.tid, ['title'], next);
			},
			author: function(next) {
				User.getUserField(postData.uid, 'username', next);
			},
			uids: function(next) {
				async.map(results.userRecipients, function(slug, next) {
					User.getUidByUserslug(slug, next);
				}, next);
			},
			groupsMembers: function(next) {
				getGroupMemberUids(results.groupRecipients, next);
			}
		}, function(err, results) {
			if (err) {
				return;
			}

			var uids = results.uids.concat(results.groupsMembers).filter(function(uid, index, array) {
				return array.indexOf(uid) === index && parseInt(uid, 10) !== parseInt(postData.uid, 10);
			});

			if (uids.length > 0) {
				Notifications.create({
					bodyShort: '[[notifications:user_mentioned_you_in, ' + results.author + ', ' + results.topic.title + ']]',
					bodyLong: postData.content,
					nid: 'tid:' + postData.tid + ':pid:' + postData.pid + ':uid:' + postData.uid,
					pid: postData.pid,
					tid: postData.tid,
					from: postData.uid,
					importance: 6
				}, function(err, notification) {
					if (err || !notification) {
						return;
					}
					Notifications.push(notification, results.uids);
				});

				var display_url = nconf.get('display_url'),
					base_url = display_url ? display_url : nconf.get('url'),
					site_url = nconf.get('site_url'),
					static_site_url = nconf.get('static_site_url'),
					email_recent_days = 5;

				uids.forEach(function(uid){
					User.getUserFields(uid, ['username', 'lastonline'], function(err, userData){
						if( userData.lastonline > ( new Date().getTime() - (email_recent_days * 86400000) ) )	return;
						Emailer.send('notif_mention', uid, {
							pid: postData.pid,
							subject: results.author + '在《'+ results.topic.title +'》中提到了您',
							intro: '[[notifications:user_mentioned_you_in, ' + results.author + ', ' + results.topic.title + ']]',
							postBody: postData.content,
							site_title: Meta.config.title || 'NodeBB',
							username: userData.username,
							url: base_url + '/topic/' + postData.tid,
							base_url: base_url,
							site_url: site_url,
							static_site_url: static_site_url
						});
					});
				});
			}
		});
	});
};

var loadGroupMembers = (function loadGroup(expire = 600000) {
	var cache = {};
	var ts = 0;
	return function(group, next) {
		var now = new Date().getTime(),
			expired = Boolean( (ts + expire) < now );
		if (cache[group] && !expired) {
			next(null, cache[group]);
		} else {
			Groups.getMembers(group, 0, -1, function(err, result){
				if (err) return next(err, result);
				
				ts = new Date().getTime();
				cache[group] = result;
				next(null, result);
			});
		}
	}
})();

function getGroupMemberUids(groupRecipients, callback) {
	async.map(groupRecipients, function(slug, next) {
		Groups.getGroupNameByGroupSlug(slug, next);
	}, function(err, groups) {
		if (err) {
			return callback(err);
		}
		async.map(groups, function(group, next) {
			//Groups.getMembers(group, 0, -1, next);
			loadGroupMembers(group, next);
		}, function(err, results) {
			if (err) {
				return callback(err);
			}

			var uids = [];
			results.forEach(function(members) {
				uids = uids.concat(members);
			});
			uids = uids.filter(function(uid, index, array) {
				return parseInt(uid, 10) && array.indexOf(uid) === index;
			});
			callback(null, uids);
		});
	});
}

Mentions.addMentions = function(data, callback) {
	var relativeUrl = nconf.get('relative_path') || '',
		originalContent, cleanedContent;

	if (data && typeof data === 'string') {
		originalContent = data;
		cleanedContent = Mentions.clean(data, false, false, true);
	} else if (!data || !data.postData || !data.postData.content) {
		return callback(null, data);
	} else {
		originalContent = data.postData.content;
		cleanedContent = Mentions.clean(data.postData.content, false, false, true);
	}

	var matches = cleanedContent.match(regex);

	if (!matches) {
		return callback(null, data);
	}
	// Eliminate duplicates
	matches = matches.filter(function(cur, idx) {
		return idx === matches.indexOf(cur);
	});

	async.each(matches, function(match, next) {
		var slug = Utils.slugify(match.slice(1));

		match = removePunctuationSuffix(match);

		async.parallel({
			groupName: async.apply(Groups.exists, slug),
			uid: async.apply(User.getUidByUserslug, slug)
		}, function(err, results) {
			if (err) {
				return next(err);
			}

			if (results.uid) {
				if (isLatinMention.test(match)) {
					originalContent = originalContent.replace(new RegExp(match + '\\b', 'g'), '<a class="plugin-mentions-a" href="' + relativeUrl + '/user/' + slug + '">' + match + '</a>');
				} else {
					originalContent = originalContent.replace(new RegExp(match, 'g'), '<a class="plugin-mentions-a" href="' + relativeUrl + '/user/' + slug + '">' + match + '</a>');
				}
			} else if (results.groupName) {
				originalContent = originalContent.replace(new RegExp(match + '\\b', 'g'), '<a class="plugin-mentions-a" href="' + relativeUrl + '/groups/' + slug + '">' + match + '</a>');
			}

			if (data && typeof data === 'string') {
				data = originalContent;
			} else {
				data.postData.content = originalContent;
			}

			next();
		});
	}, function(err) {
		callback(err, data);
	});
};

Mentions.clean = function(input, isMarkdown, stripBlockquote, stripCode) {
	var bqMatch = isMarkdown ? /^>.*$/gm : /^<blockquote>.*<\/blockquote>/gm,
		pfMatch = isMarkdown ? /`[^`\n]+`/gm : /<code>.*<\/code>/gm;

	if (stripBlockquote) {
		input = input.replace(bqMatch, '');
	}
	if (stripCode) {
		input = input.replace(pfMatch, '');
	}

	return input;
};

/*
	WebSocket methods
*/

SocketPlugins.mentions.listGroups = function(socket, data, callback) {
	Groups.list({
		removeEphemeralGroups: true,
		truncateUserList: true
	}, function(err, groups) {
		if (err || !Array.isArray(groups)) {
			return callback(null, []);
		}
		callback(null, groups.map(function(groupObj) {
			return groupObj.name;
		}));
	});
};

module.exports = Mentions;
