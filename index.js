const app = require('express')();
const http = require('http').createServer(app, { cookie:true });
const io = require('socket.io')(http, { pingInterval:50000, pingTimeout:50000 });
app.get('/favicon.ico', (req, res) => res.sendFile(__dirname + '/favicon.ico'));
app.get('/NotoColorEmoji.woff2', (req, res) => res.sendFile(__dirname + '/NotoColorEmoji.woff2'));
app.get('/NotoColorEmoji.ttf', (req, res) => res.sendFile(__dirname + '/NotoColorEmoji.ttf'));
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
	if(req.path == '/blank') {
		res.sendFile(__dirname + '/blank.html');
	} else {
		res.sendFile(__dirname + '/index.html');
	}
});
const rooms = {};
let lockeduntil = 0;
let currentregex;
io.on('connection', socket => {
	if(!socket.handshake.headers.cookie) return;
	socket.hash = makehash(cookie.parse(socket.handshake.headers.cookie).uid);
	const user = users[socket.hash];
	const logsys = (msg, room = socket.room) => {
		io.to('admin').emit('log', { time:Date.now(), room, msg });
		logs.insertOne({ createdAt:new Date(), room, msg });
	}
	const loguser = (cmd, ...arr) => {
		io.to('admin').emit('log', { time:Date.now(), room:socket.room, name:socket.name, hash:socket.hash, cmd, arr });
		logs.insertOne({ createdAt:new Date(), ip:user.ip, room:socket.room, name:socket.name, hash:socket.hash, cmd, arr });
	}
	socket.onAny(async cmd => {
		if(cmd == 'sendOnly' || cmd == 'sendAll') return;
		user.spam.unshift(Date.now());
		if(user.spam.length <= 20) return;
		user.spam.pop();
		if(user.spam[0] - user.spam[19] > 500) return;
		sockets = await io.in(socket.hash).fetchSockets();
		for(const socket2 of sockets) {
			logsys('Autokicked '+socket2.name, socket2.room);
			socket2.disconnect();
		}
		hashes.updateOne({ _id:socket.hash }, { $set:{ banneduntil:Date.now() + 60000 } });
	});
	socket.join(socket.hash);
	const validstring = string => string && typeof string == 'string';
	const validnumber = num => num >= 0;
	socket.on('LOGIN', async password => {
		loguser('LOGIN', password);
		if(password != process.env.PASSWORD) {
			logsys('Invalid password');
			return;
		}
		socket.removeAllListeners('LOGIN');
		const records = await logs.find({ createdAt:{ $gt:new Date(Date.now() - 24*60*60*1000) } },  { _id:0, createdAt:1, room:1, name:1, hash:1, cmd:1, arr:1, msg:1 }).toArray();
		for(const i in records) {
			records[i].time = Date.parse(records[i].createdAt);
			delete records[i].createdAt;
		}
		socket.emit('log', records, currentregex);
		socket.join('admin');
		socket.on('BAN', async (hash, mins) => {
			loguser('BAN', hash, mins);
			if(!validstring(hash)) {
				logsys('Invalid hash');
				return;
			}
			sockets = await io.in(hash).fetchSockets();
			for(const socket2 of sockets) {
				logsys('Kicked '+socket2.name);
				socket2.disconnect();
			}
			if(validnumber(mins)) {
				hashes.updateOne({ _id:hash }, { $set:{ banneduntil:Date.now() + mins * 60000 } });
			}
		});
		socket.on('LOCK', mins => {
			loguser('LOCK', mins);
			if(validnumber(mins)) {
				logsys('Invalid time');
				return;
			}
			lockeduntil = Date.now() + mins * 60000;
		});
		socket.on('REGEX', regex => {
			loguser('REGEX', regex);
			try {
				new RegExp(regex);
			} catch(error) {
				logsys(error);
				return;
			}
			currentregex = regex;
			regex = new RegExp(regex);
			io.to('admin').emit('log', { time:Date.now(), room:socket.room, regex:currentregex });
			for(const room in rooms) {
				if(regex.test(room)) {
					logsys('Kicked '+room);
					rooms[room].admin.disconnect();
				}
			}
		});
	});
	const getallsockets = () => [...io.sockets.sockets.values()];
	const getname = name => {
		const sockets = getallsockets().filter(socket2 => socket2.name && socket2.room == socket.room);
		if(sockets.some(socket2 => socket2.name == socket.name)) {
			let i = 0;
			do i++;
			while(sockets.some(socket2 => socket2.name == name+i));
			name += i;
		}
		socket.name = name;
		socket.join(name);
	}
	const getrandomname = () => {
		const rand = (arr, num = 1) => Math.random() < num? arr[~~(Math.random()*arr.length)]: '';
		const sockets = getallsockets();
		let name;
		const issimilar = (name1, name2) => {
			if(!name2) return false;
			if(name1 == name2 || name1.slice(0, 3) == name2.slice(0, 3)) return true;
			if(name1[0] == name2[0] && name1.length == name2.length) return true;
			let i = 0;
			while(i < name1.length && i < name2.length && name1[i] == name2[i]) {
				i++;
			}
			return name1.slice(i + (name1.length >= name2.length)) == name2.slice(i + (name2.length >= name1.length));
		}
		for(let i = 0; i < 1000; i++) {
			name = rand([...'bfhklmnpstwxy', 'ch', 'fl', 'ny', 'sh']) + rand('aeiou');
			if(Math.random() < .9) {
				name = rand([
					name + rand(['bbo', 'ffy', 'ggo', 'll', 'mba', 'nka', 'ndy', 'ng', 'ngo', 'nter', 'pper', 'ppy', 'pster', 'psu', 'tsu', 'tty', 'tzy', 'xter', 'zz']),
					name + rand([...'bmnprtx', 'ch', 'ff', 'kk', 'pp']) + rand('aiou')
				]);
			} else {
				name = rand([
					rand([...'bdghjklmnpstwxyz', 'tx']) + rand([...'aeiou', 'ai', 'au']) + rand([...'bdghklmnrstwxz', 'ld', 'rr']) + rand('aeiou') + rand([...'lnr', 'ts', 'tz'], .2),
					name + rand('dlnrstw') + rand('aeiou') + rand([...'bklmnrsx', 'ch', 'lm', 'nd', 'ng', 'sh']) + rand('aiou'),
					rand([...'cmnptxy', 'ch', 'hu', 'tz']) + rand('aeio') + rand('cmnpxy') + rand('aeio') + 'tl',
					rand('bkw') + 'a' + rand('hlz') + 'oo',
					rand([...'bhkltwy', 'ch', 'xi']) + 'ao',
					rand('bhkltw') + 'ei',
					rand([...'bdghjklmnpstwxyz', 'ch', 'tx']) + rand([...'aiou', 'ai'])
				]);
			}
			if(/([bcdfghklmnprstwxz])[aeiou]+\1|l[aeiou]+r|r[aeiou]+l|[aeiou]{2}[^aeiou]{2}|y.+y|[hw]o|[kp][aeiou]+n|[tw][aeiou]+ng|b[aeiou]+[cnst]|ch[aeiou]+n|d[aeiou]+[gkm]|f[aeiou]+[cgkptx]|l[aeiou]+[bpz]|m[aeiou]+f|n.+[dgt]|p[aeiou]+[dsz]|pak|pet|s[aeiou]+x|sh[aeiou]+[gt]|w.nk|[jy]i|nye|.w[ei]|wu|huo.+tl/.test(name)) continue;
			//name = name[0].toUpperCase() + name.slice(1);
			if(sockets.every(socket2 => !issimilar(name, socket2.name))) break;
		}
		getname(name);
	}
	if(socket.handshake.headers.referer.includes('blank')) {
		getrandomname();
		return;
	}
	if(lockeduntil > Date.now() || user.banneduntil > Date.now()) return;
	socket.emit('start', socket.name, Object.keys(rooms).filter(room => !room.includes('hidden') && rooms[room].timeout == undefined && !rooms[room].banned[socket.hash]));
	const leave = async (socket, msg1, msg2) => {
		socket.emit('leaveroom', msg1);
		if(rooms[socket.room].admin == socket) {
			loguser('leave', true);
			clearTimeout(rooms[socket.room].timeout);
			for(const i in rooms[socket.room].banned) {
				clearTimeout(rooms[socket.room].banned[i]);
			}
			const sockets = await io.in(socket.room).fetchSockets();
			delete rooms[socket.room];
			for(const socket2 of sockets) {
				socket2.emit('leaveroom', 'Admin '+msg2+'!');
				socket2.leave(socket.room);
				delete socket2.room;
				for(const listener of ['say', 'leave']) {
					socket2.removeAllListeners(listener);
				}
			}
			if(socket.room.includes('hidden')) {
				socket.emit('rmvroom', socket.room);
				socket.to(socket.room).emit('rmvroom', socket.room);
			} else {
				io.emit('rmvroom', socket.room);
			}
			for(const listener of ['say', 'sendOnly', 'sendAll', 'kick', 'lock', 'leave']) {
				socket.removeAllListeners(listener);
			}
		} else {
			loguser('leave');
			rooms[socket.room].admin.emit('leave', msg2, socket.name, socket.hash);
			for(const listener of ['say', 'leave']) {
				socket.removeAllListeners(listener);
			}
		}
		socket.leave(socket.room);
		delete socket.room;
		socket.leave(socket.name);
		delete socket.name;
	}
	socket.on('join', async (room, name) => {
		if(!validstring(room)) return;
		room = room.trim().replace(/^#*/, '#').slice(0, 30).replace(/\s/g, '_');
		if(socket.room) {
			if(socket.room == room) return;
			await leave(socket, '', 'has left');
		}
		if(rooms[room] && (rooms[room].timeout != undefined || rooms[room].banned[socket.name] || rooms[room].banned[socket.hash])) {
			socket.emit('notify', room+' is unavailable');
			return;
		}
		if(validstring(name)) {
			getname(name.trim().slice(0, 30).replace(/\s/g, '_'));
		} else {
			name = undefined;
			getrandomname();
		}
		socket.room = room;
		loguser('join');
		if(rooms[socket.room]) {
			socket.join(socket.room);
			socket.emit('joinroom', socket.room, socket.name);
			rooms[socket.room].admin.emit('join', socket.name, socket.hash, !!name);
			socket.on('say', msg => {
				if(!validstring(msg)) return;
				msg = msg.slice(0, 5000).replace(/(hash:)([^ ]+)/, (a, b, c) => b+makehash(c));
				loguser('say', msg);
				rooms[socket.room].admin.emit('hear', msg, socket.name, socket.hash);
			});
		} else {
			rooms[socket.room] = { 'admin':socket, banned:{} };
			if(currentregex && new RegExp(currentregex).test(room)) {
				logsys('Autokicked');
				socket.disconnect();
				return;
			}
			if(!socket.room.includes('hidden')) {
				socket.broadcast.emit('addroom', socket.room);
			}
			socket.emit('joinroom', socket.room, socket.name, socket.hash, !!name);
			const send = async (msg1, names, msg2, only, add) => {
				if(!Array.isArray(names)) return;
				const sockets = await io.in(socket.room).fetchSockets();
				for(const socket2 of sockets) {
					if(add != undefined) {
						if(names.includes(socket2.name) == only) {
							socket2.emit('change', add, msg1);
						} else if(msg2) {
							socket2.emit('change', add, msg2);
						}
					} else {
						if(names.includes(socket2.name) == only) {
							socket2.emit('hear', msg1);
						} else if(msg2) {
							socket2.emit('hear', msg2);
						}
					}
				}
				return true;
			}
			socket.on('sendOnly', (...arr) => {
				loguser('sendOnly', ...arr);
				if(typeof arr[0] == 'boolean') {
					const [add, msg1, names, msg2] = arr;
					send(msg1, names, msg2, true, add);
				} else {
					const [msg1, names, msg2] = arr;
					send(msg1, names, msg2, true);
				}
			});
			socket.on('sendAll', async (...arr) => {
				loguser('sendAll', ...arr);
				if(typeof arr[0] == 'boolean') {
					const [add, msg1, names, msg2] = arr;
					if(!await send(msg1, names, msg2, false, add)) {
						io.to(socket.room).emit('change', add, msg1);
					}
				} else {
					const [msg1, names, msg2] = arr;
					if(!await send(msg1, names, msg2, false)) {
						io.to(socket.room).emit('hear', msg1);
					}
				}
			});
			socket.on('kick', async (name, msg) => {
				loguser('kick', name, msg);
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
				logsys('Kicked '+socket2.name);
				msg = validstring(msg)? ' '+msg: '!';
				leave(socket2, 'You\'ve been kicked'+msg, 'has been kicked'+msg);
			});
			socket.on('ban', async (hash, mins = 0, msg) => {
				loguser('ban', hash, mins, msg);
				if(socket.hash == hash) return;
				if(!validstring(hash))  {
					socket.emit('notify', 'Invalid hash');
					return;
				}
				let sockets = (await io.in(socket.room).fetchSockets()).filter(socket2 => socket2.hash == hash);
				if(sockets.length) {
					msg = validstring(msg)? ' '+msg: '!';
					for(const socket2 of sockets) {
						logsys('Kicked '+socket2.name);
						await leave(socket2, 'You\'ve been banned from '+socket.room+msg, 'has been banned'+msg);
					}
				}
				if(!validnumber(mins)) return;
				clearTimeout(rooms[socket.room].banned[hash]);
				sockets = await io.in(hash).fetchSockets();
				for(const socket2 of sockets) {
					socket2.emit('rmvroom', socket.room);
				}
				rooms[socket.room].banned[hash] = setTimeout(async () => {
					sockets = await io.in(hash).fetchSockets();
					for(const socket2 of sockets) {
						socket2.emit('addroom', socket.room);
					}
					delete rooms[socket.room].banned[hash];
				}, mins * 60000);
			});
			socket.on('lock', async mins => {
				loguser('lock', mins);
				if(!validnumber(mins)) {
					socket.emit('notify', 'Invalid time');
					return;
				}
				clearTimeout(rooms[socket.room].timeout);
				if(rooms[socket.room].timeout == undefined && !socket.room.includes('hidden')) {
					socket.emit('hideroom');
					for(const socket2 of getallsockets()) {
						if(socket2.room == socket.room) {
							socket2.emit('hideroom');
						} else {
							socket2.emit('rmvroom', socket.room);
						}
					}
				}
				socket.emit('notify', 'Room locked for '+mins+' minutes');
				rooms[socket.room].timeout = setTimeout(() => {
					delete rooms[socket.room].timeout;
					socket.emit('notify', 'Room unlocked');
					if(socket.room.includes('hidden')) return;
					socket.emit('showroom');
					for(const socket2 of getallsockets()) {
						if(socket2.room == socket.room) {
							socket2.emit('showroom');
						} else {
							socket2.emit('addroom', socket.room);
						}
					}
				}, mins * 60000);
			});
		}
		socket.on('leave', () => leave(socket, '', 'has left'));
	});
	socket.on('disconnect', () => {
		if(socket.room) {
			leave(socket, '', 'has disconnected');
		}
		user.sockets--;
		if(!user.sockets) {
			delete users[socket.hash];
		}
	});
});
http.listen(process.env.PORT ?? 3000);