const app = require('express')();
const http = require('http').createServer(app, { cookie:true });
const io = require('socket.io')(http, { pingInterval:50000, pingTimeout:50000 });
app.get('/favicon.ico', (req, res) => res.sendFile(__dirname + '/favicon.ico'));
app.get('/NotoColorEmoji.woff2', (req, res) => res.sendFile(__dirname + '/NotoColorEmoji.woff2'));
app.get('/NotoColorEmoji.ttf', (req, res) => res.sendFile(__dirname + '/NotoColorEmoji.ttf'));
app.get('/settings', (req, res) => res.sendFile(__dirname + '/settings.html'));
require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');
const client = new MongoClient(process.env.URI, { serverApi:{ version:ServerApiVersion.v1, strict:true, deprecationErrors:true } });
const hashes = client.db('ankabuta').collection('hashes');
const logs = client.db('ankabuta').collection('logs');
logs.insertOne({ createdAt:new Date(), cmd:'restart' });
//hashes.createIndex( { createdAt:1 }, { expireAfterSeconds:345600 } ); // 4 days
//logs.createIndex( { createdAt:1 }, { expireAfterSeconds:345600 } );
const crypto = require('crypto');
const cookie = require('cookie');
const users = {};
const makehash = uid => crypto.createHash('sha256').update(uid).digest('base64');
const makeuser = (hash, uid, ip, banneduntil = 0) => {
	if(users[hash]) {
		users[hash].sockets++;
	} else {
		users[hash] = { uid, banneduntil, sockets:1, spam:[] };
	}
	if(ip) {
		users[hash].ip = ip;
	}
}
const makecookie = async (req, res) => {
	let ip = req.headers['x-forwarded-for'];
	let uid;
	let hash;
	if(ip) {
		const doc = await hashes.findOne({ ip });
		if(doc) {
			makeuser(doc._id, doc.uid, doc.ip, doc.banneduntil);
			res.setHeader('Set-Cookie', cookie.serialize('uid', doc.uid, { maxAge:345600, sameSite:'strict', httpOnly:true }));
			return;
		}
	}
	if(req.headers.cookie && cookie.parse(req.headers.cookie).uid) {
		uid = cookie.parse(req.headers.cookie).uid;
		hash = makehash(uid);
		const doc = await hashes.findOne({ _id:hash });
		if(doc) {
			makeuser(hash, doc.uid, doc.ip, doc.banneduntil);
			if(ip) {
				users[hash].ip = ip;
				hashes.updateOne({ _id:hash }, { $set:{ ip } });
			}
			return;
		}
	}
	let doc;
	do {
		uid = crypto.randomBytes(32).toString('base64');
		hash = makehash(uid);
		doc = await hashes.findOne({ _id:hash });
	} while(doc);
	res.setHeader('Set-Cookie', cookie.serialize('uid', uid, { maxAge:345600, sameSite:'strict', httpOnly:true }));
	makeuser(hash, uid, ip, 0);
	const obj = { _id:hash, createdAt:new Date(), uid, banneduntil:0 };
	if(ip) obj.ip = ip;
	hashes.insertOne(obj);
}
app.use(async (req, res) => {
	if(req.path != '/' && req.path != '/blank') {
		res.redirect('/');
		return;
	}
	await makecookie(req, res);
	res.set('Cache-Control', 'no-store');
	if(req.path == '/blank') {
		res.sendFile(__dirname + '/blank.html');
	} else {
		res.sendFile(__dirname + '/index.html');
	}
});
const rooms = {};
let lastaction;
let lockeduntil = 0;
let currentregex;
io.on('connection', async socket => {
	if(!socket.handshake.headers.cookie) return;
	socket.hash = makehash(cookie.parse(socket.handshake.headers.cookie).uid);
	const user = users[socket.hash];
	if(!user) return;
	const logerror = (error, room = socket.room) => {
		io.to('admin').emit('log', { time:Date.now(), room, error });
		logs.insertOne({ time:new Date(), room, error });
	}
	const logaction = (socket, cmd, obj) => {
		obj = { cmd, room:socket.room, name:socket.name, hash:socket.hash, ...obj };
		const json = JSON.stringify(obj);
		if(json == lastaction) return;
		lastaction = json;
		io.to('admin').emit('log', { time:Date.now(), ...obj });
		logs.insertOne({ time:new Date(), ip:user.ip, ...obj });
	}
	socket.onAny(async cmd => {
		if(cmd == 'sendOnly' || cmd == 'sendAll') return;
		user.spam.unshift(Date.now());
		if(user.spam.length <= 20) return;
		user.spam.pop();
		if(user.spam[0] - user.spam[19] > 500) return;
		sockets = await io.in(socket.hash).fetchSockets();
		for(const socket2 of sockets) {
			socket2.msg = 'Kicked for spamming';
			socket2.disconnect();
		}
		hashes.updateOne({ _id:socket.hash }, { $set:{ banneduntil:Date.now() + 60000 } });
	});
	socket.join(socket.hash);
	const validstring = string => string && typeof string == 'string';
	const validnumber = num => num >= 0;
	const validarray = arr => Array.isArray(arr);
	socket.on('LOGIN', async (password, hours) => {
		logaction(socket, 'LOGIN', { password });
		if(password != process.env.PASSWORD) {
			logerror('Invalid password');
			return;
		}
		socket.removeAllListeners('LOGIN');
		const records = await logs.find({ time:{ $gt:new Date(Date.now() - hours*60*60*1000) } },  { projection:{ _id:0, ip:0 } }).toArray();
		socket.emit('log', records, currentregex);
		socket.join('admin');
		socket.on('BAN', async (hash, mins) => {
			logaction(socket, 'BAN', { target:hash, mins });
			if(!validstring(hash)) {
				logerror('Invalid hash');
				return;
			}
			sockets = await io.in(hash).fetchSockets();
			for(const socket2 of sockets) {
				socket2.msg = 'Banned by '+socket.name;
				socket2.disconnect();
			}
			if(validnumber(mins)) {
				hashes.updateOne({ _id:hash }, { $set:{ banneduntil:Date.now() + mins * 60000 } });
			}
		});
		socket.on('LOCK', mins => {
			logaction(socket, 'LOCK', { mins });
			if(validnumber(mins)) {
				logerror('Invalid time');
				return;
			}
			lockeduntil = Date.now() + mins * 60000;
		});
		socket.on('REGEX', regex => {
			logaction(socket, 'REGEX', { regex });
			try {
				new RegExp(regex);
			} catch(error) {
				logerror(error);
				return;
			}
			currentregex = regex;
			regex = new RegExp(regex);
			for(const room in rooms) {
				if(regex.test(room)) {
					rooms[room].admin.msg = 'Kicked by regex:'+regex;
					rooms[room].admin.disconnect();
				}
			}
		});
	});
	const getname = async () => {
		const rand = (arr, num = 1) => Math.random() < num? arr[~~(Math.random()*arr.length)]: '';
		let sockets = await logs.find({ createdAt:{ $gt:new Date(Date.now() - 12*60*60*1000) }, cmd:'join' }, { projection:{ _id:0, name:1 } }).toArray();
		let name;
		const issimilar = name2 => {
			if(name == name2 || name.slice(0, 3) == name2.slice(0, 3)) return true;
			let i = 0;
			while(i < name.length && i < name2.length && name[i] == name2[i]) {
				i++;
			}
			return name.slice(i + (name.length >= name2.length)) == name2.slice(i + (name2.length >= name.length));
		}
		do {
			for(let i = 0; i < 1000; i++) {
				name = rand([...'bfhjklmnpstwxy', 'bl', 'ch', 'fl', 'ny', 'sh', 'sn']) + rand('aeiou');
				if(Math.random() < .9) {
					name = rand([
						name + rand(['bbo', 'ffy', 'ggo', 'mba', 'nka', 'ndy', 'ng', 'ngo', 'nter', 'p', 'pper', 'ppy', 'pster', 'psu', 't', 'tsu', 'tty', 'tzy', 'xter', 'zz']),
						name + rand([...'blmnprtx', 'ch', 'ff', 'kk', 'll', 'pp']) + rand('aiou')
					]);
				} else {
					name = rand([
						rand([...'bdghjklmnpstwxyz', 'tx']) + rand([...'aeiou', 'ai', 'au']) + rand([...'bdghklmnrstwxz', 'ld', 'rr']) + rand('aeiou') + rand([...'lnr', 'ts', 'tz'], .2),
						name + rand('bdfghklmnprstwx') + rand('aeiou') + rand(['ng', 'sh'], .2),
						rand([...'cmnptxy', 'ch', 'hu', 'tz']) + rand('aeio') + rand('cmnpxy') + rand('aeio') + 'tl',
						rand('bkw') + 'a' + rand('hlz') + 'oo',
						rand([...'bhkltwy', 'ch', 'xi']) + 'ao',
						rand('bhkltw') + 'ei',
						rand([...'bdghjklmnpstwxyz', 'ch', 'tx']) + rand([...'aiou', 'ai'])
					]);
				}
				//name = name[0].toUpperCase() + name.slice(1);
				if(sockets.every(socket2 => !issimilar(socket2.name))) break;
			}
		} while(/([bcdfghklmnprstwxz])[aeiou]+\1|l[aeiou]+r|r[aeiou]+l|[aeiou]{2}[^aeiou]{2}|y.+y|[hw]o|[kp][aeiou]+n|[dhtw][aeiou]+ng|b[aeiou]+[cnst]|ch[aeiou]+n|d[aeiou]+[gkm]|f[aeiou]+[cgkptx]|l[aeiou]+[bpz]|m[aeiou]+f|n.+[dgt]|p[aeiou]+[dsz]|pak|p[eou]t|napp|s[hn]?[aeiou]+[gtx]|w.[nk]k|[jy]i|nazi|sep|ild|moro|snob|nye|.w[ei]|wu|huo.+tl/.test(name));
		sockets = [...io.sockets.sockets.values()].filter(socket2 => socket2.name && socket2.room == socket.room);
		if(sockets.some(socket2 => socket2.name == name)) {
			let i = 0;
			do i++;
			while(sockets.some(socket2 => socket2.name == name+i));
			name += i;
		}
		socket.name = name;
		socket.join(name);
	}
	if(socket.handshake.headers.referer?.includes('blank')) {
		getname();
		return;
	}
	if(lockeduntil > Date.now() || user.banneduntil > Date.now()) return;
	const visiblerooms = [];
	for(const room in rooms) {
		if(room.includes('hidden') || rooms[room].timeout != undefined || rooms[room].banned[socket.hash]) continue;
		visiblerooms.push([room, (await io.in(room).fetchSockets()).length+1]);
	}
	socket.emit('start', visiblerooms);
	const updateroom = (room, num) => {
		if(rooms[room].timeout != undefined || room.includes('hidden')) {
			io.to(room).emit('updateroom', room, num);
		} else {
			for(const socket2 of [...io.sockets.sockets.values()]) {
				if(!rooms[room].banned[socket2.hash]) {
					socket2.emit('updateroom', room, num);
				}
			}
		}
	}
	const leave = async (socket, msg1, msg2, msg3) => {
		socket.emit('leaveroom', msg1);
		if(rooms[socket.room].admin == socket) {
			logaction(socket, 'adminleave', { msg:msg3 });
			const sockets = await io.in(socket.room).fetchSockets();
			for(const socket2 of sockets) {
				socket2.emit('leaveroom', 'Admin '+msg2+'!');
				socket2.leave(socket.room);
				delete socket2.room;
				for(const listener of ['say', 'leave']) {
					socket2.removeAllListeners(listener);
				}
			}
			for(const listener of ['say', 'sendOnly', 'sendAll', 'kick', 'lock', 'leave']) {
				socket.removeAllListeners(listener);
			}
			updateroom(socket.room, 0);
			clearTimeout(rooms[socket.room].timeout);
			for(const i in rooms[socket.room].banned) {
				clearTimeout(rooms[socket.room].banned[i]);
			}
			delete rooms[socket.room];
		} else {
			logaction(socket, 'leave', { msg:msg3 });
			rooms[socket.room].admin.emit('leave', msg2, socket.name, socket.hash);
			for(const listener of ['say', 'leave']) {
				socket.removeAllListeners(listener);
			}
			socket.leave(socket.room);
			const num = (await io.in(socket.room).fetchSockets()).length+1;
			updateroom(socket.room, num);
		}
		delete socket.room;
		socket.leave(socket.name);
		delete socket.name;
	}
	socket.on('join', async room => {
		if(!validstring(room)) return;
		room = '#'+(room.trim().replace(/^#+/, '').slice(0, 30).replace(/\s/g, '_'));
		if(socket.room) {
			await leave(socket, '', 'has left');
		}
		if(rooms[room] && (rooms[room].timeout != undefined || rooms[room].banned[socket.name] || rooms[room].banned[socket.hash])) {
			socket.emit('notify', room+' is unavailable', true);
			return;
		}
		socket.room = room;
		await getname();
		logaction(socket, 'join');
		if(rooms[socket.room]) {
			socket.join(socket.room);
			const num = (await io.in(socket.room).fetchSockets()).length+1;
			updateroom(socket.room, num);
			socket.emit('joinroom', socket.room, socket.name);
			rooms[socket.room].admin.emit('join', socket.name, socket.hash);
			socket.on('say', msg => {
				if(!validstring(msg)) return;
				msg = msg.slice(0, 5000).replace(/(hash:)([^ ]+)/, (a, b, c) => b+makehash(c));
				logaction(socket, 'say', { msg });
				rooms[socket.room].admin.emit('hear', msg, socket.name, socket.hash);
			});
		} else {
			rooms[socket.room] = { 'admin':socket, banned:{} };
			if(currentregex && new RegExp(currentregex).test(room)) {
				socket.msg = 'Kicked by regex:'+currentregex;
				socket.disconnect();
				return;
			}
			if(socket.room.includes('hidden')) {
				socket.emit('updateroom', socket.room, 1);
			} else {
				io.emit('updateroom', socket.room, 1);
			}
			socket.emit('joinroom', socket.room, socket.name, socket.hash);
			const send = async (msg1, names, msg2, add) => {
				if(!validarray(names)) return;
				if(add != null) {
					if(!validarray(msg1) || !validarray(msg2)) return;
				}
				const sockets = await io.in(socket.room).fetchSockets();
				for(const socket2 of sockets) {
					if(add != null) {
						if(names.includes(socket2.name)) {
							msg1.length && socket2.emit('updatesidebar', add, msg1);
						} else {
							msg2.length && socket2.emit('updatesidebar', add, msg2);
						}
					} else {
						if(names.includes(socket2.name)) {
							msg1 && socket2.emit('hear', msg1);
						} else {
							msg2 && socket2.emit('hear', msg2);
						}
					}
				}
			}
			socket.on('sendOnly', (...arr) => {
				logaction(socket, 'sendOnly', { arr });
				const add = typeof arr[0] == 'boolean'? arr.shift(): null;
				const [msg1, names, msg2] = arr;
				send(msg1, names, msg2, add);
			});
			socket.on('sendAll', async (...arr) => {
				logaction(socket, 'sendAll', { arr });
				const add = typeof arr[0] == 'boolean'? arr.shift(): null;
				const [msg1, names, msg2] = arr;
				send(msg2, names, msg1, add);
			});
			socket.on('kick', async (name, msg) => {
				logaction(socket, 'kick', { target:name, msg });
				if(socket.name == name) return;
				if(!validstring(name)) {
					socket.emit('notify', 'Invalid name');
					return;
				}
				const socket2 = (await io.in(socket.room).fetchSockets()).find(socket2 => socket2.name == name);
				if(!socket2) {
					socket.emit('notify', 'Name not found');
					return;
				}
				msg = validstring(msg)? ' '+msg: '!';
				leave(socket2, 'You\'ve been kicked'+msg, 'has been kicked'+msg, 'Kicked by host');
			});
			socket.on('ban', async (hash, mins = 0, msg) => {
				logaction(socket, 'ban', { target:hash, mins, msg });
				if(socket.hash == hash) return;
				if(!validstring(hash))  {
					socket.emit('notify', 'Invalid hash');
					return;
				}
				let sockets = await io.in(hash).fetchSockets();
				if(sockets.length) {
					msg = validstring(msg)? ' '+msg: '!';
					for(const socket2 of sockets) {
						if(!socket2.room != socket.room) continue;
						await leave(socket2, 'You\'ve been banned from '+socket.room+msg, 'has been banned'+msg, 'Banned by host');
					}
				}
				if(!validnumber(mins)) return;
				clearTimeout(rooms[socket.room].banned[hash]);
				for(const socket2 of sockets) {
					socket2.emit('updateroom', socket.room, 0);
				}
				rooms[socket.room].banned[hash] = setTimeout(async () => {
					delete rooms[socket.room].banned[hash];
					if(rooms[socket.room].timeout != undefined || socket.room.includes('hidden')) return;
					sockets = await io.in(hash).fetchSockets();
					const num = (await io.in(socket.room).fetchSockets()).length+1;
					for(const socket2 of sockets) {
						socket2.emit('updateroom', socket.room, num);
					}
				}, mins * 60000);
			});
			socket.on('lock', async mins => {
				logaction(socket, 'lock', { mins });
				if(!validnumber(mins)) {
					socket.emit('notify', 'Invalid time');
					return;
				}
				clearTimeout(rooms[socket.room].timeout);
				if(rooms[socket.room].timeout == undefined && !socket.room.includes('hidden')) {
					for(const socket2 of [...io.sockets.sockets.values()]) {
						if(socket2.room == socket.room) {
							socket2.emit('lockroom');
						} else if(!rooms[socket.room].banned[socket2.hash]) {
							socket2.emit('updateroom', socket.room, 0);
						}
					}
				}
				socket.emit('notify', 'Room locked for '+mins+' minutes');
				rooms[socket.room].timeout = setTimeout(async () => {
					delete rooms[socket.room].timeout;
					socket.emit('notify', 'Room unlocked');
					if(socket.room.includes('hidden')) return;
					const num = (await io.in(socket.room).fetchSockets()).length+1;
					for(const socket2 of [...io.sockets.sockets.values()]) {
						if(socket2.room == socket.room) {
							socket2.emit('unlockroom');
						} else if(!rooms[socket.room].banned[socket2.hash]) {
							socket2.emit('updateroom', socket.room, num);
						}
					}
				}, mins * 60000);
			});
		}
		socket.on('leave', () => leave(socket, '', 'has left'));
	});
	socket.on('disconnect', () => {
		if(socket.room) {
			leave(socket, '', 'has disconnected', socket.msg);
		} else if(socket.msg) {
			logaction(socket, 'leave', { msg:socket.msg });
		}
		user.sockets--;
		if(!user.sockets) {
			delete users[socket.hash];
		}
	});
});
http.listen(process.env.PORT ?? 3000);