const app = require('express')();
const http = require('http').createServer(app, { cookie:true });
const io = require('socket.io')(http);
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/blank', (req, res) => res.sendFile(__dirname + '/blank.html'));
//app.get('/', (req, res) => res.cookie('test', 'test', { maxAge:300000, httpOnly:true, sameSite:'strict' }).sendFile(__dirname + '/index.html'));
//app.get('/blank', (req, res) => res.cookie('test', 'test', { maxAge:300000, httpOnly:true, sameSite:'strict' }).sendFile(__dirname + '/blank.html'));
app.get('/favicon.ico', (req, res) => res.sendFile(__dirname + '/favicon.ico'));
app.get('/NotoColorEmoji.woff2', (req, res) => res.sendFile(__dirname + '/NotoColorEmoji.woff2'));
app.get('/NotoColorEmoji.ttf', (req, res) => res.sendFile(__dirname + '/NotoColorEmoji.ttf'));
app.use((req, res) => res.redirect('/'));
require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');
const client = new MongoClient(process.env.URI, { serverApi:{ version:ServerApiVersion.v1, strict:true, deprecationErrors:true } });
const collection = client.db('Cluster0').collection('hashes');
//collection.createIndex( { createdAt:1 }, { expireAfterSeconds:604800 } );
const crypto = require('crypto');
const cookie = require('cookie');
const users = {};
const makehash = uid => crypto.createHash('sha256').update(uid).digest('base64');
let promise = new Promise(resolve => {
	io.engine.on('initial_headers', async (headers, request) => {
		//if(!request.headers.cookie) return;
		let ip = request.headers['x-forwarded-for']; //request.connection.remoteAddress; //request.connection._peername.address;
		let uid;
		let hash;
		if(ip) {
			const doc = await collection.findOne({ ip:ip });
			if(doc) {
				users[doc._id] = { uid:doc.uid, ip:doc.ip, bannedUntil:doc.bannedUntil };
				headers['set-cookie'] = request.headers.cookie = cookie.serialize('uid', doc.uid, { maxAge:604800, sameSite:'strict' });
				resolve();
				return;
			}
		}
		if(request.headers.cookie && cookie.parse(request.headers.cookie).uid) {
			uid = cookie.parse(request.headers.cookie).uid;
			hash = makehash(uid);
			const doc = await collection.findOne({ _id:hash });
			users[hash] = { uid:doc.uid, ip:doc.ip, bannedUntil:doc.bannedUntil };
			if(doc) {
				if(ip) {
					users[hash].ip = ip;
					collection.updateOne({ _id:hash }, { $set: { ip:ip } });
				}
				resolve();
				return;
			}
		}
		let doc;
		do {
			uid = crypto.randomBytes(32).toString('base64');
			hash = makehash(uid);
			doc = await collection.findOne({ _id:hash });
		} while(doc);
		headers['set-cookie'] = request.headers.cookie = cookie.serialize('uid', uid, { maxAge:604800, sameSite:'strict' });
		users[hash] = { uid:uid, bannedUntil:0 };
		if(ip) users[hash].ip = ip;
		collection.insertOne({ _id:hash, createdAt:new Date(), ...users[hash] });
		resolve();
	});
});
const rooms = {};
const records = [];
let lockedUntil = 0;
let regexstring;
io.on('connection', async socket => {
	await promise;
	//if(!socket.handshake.headers.cookie) return;
	socket.hash = makehash(cookie.parse(socket.handshake.headers.cookie).uid);
	socket.join(socket.hash);
	console.log(socket.hash);
	const validstring = string => string && typeof string == 'string';
	const validnumber = num => num >= 0;
	socket.on('LOGIN', password => {
		if(password != process.env.PASSWORD) {
			io.to('admin').emit('log', socket.room, 'Invalid password');
			return;
		}
		socket.removeAllListeners('LOGIN');
		socket.emit('log', records, Object.keys(rooms).map(room => [room, rooms[room].admin.name, rooms[room].admin.hash]), regexstring);
		socket.join('admin');
		socket.on('BAN', async (hash, mins) => {
			if(!validstring(hash)) return;
			if(!users[hash]) {
				io.to('admin').emit('log', socket.room, 'Hash not found');
				return;
			}
			sockets = await io.in(hash).fetchSockets();
			for(const socket2 of sockets) {
				io.to('admin').emit('log', socket.room, 'Kicked '+socket2.name);
				socket2.disconnect();
			}
			if(validnumber(mins)) {
				const time = Date.now() + mins * 60000;
				users[hash].bannedUntil = time;
				collection.updateOne({ _id:hash }, { $set: { bannedUntil:time } });
			}
		});
		socket.on('LOCK', mins => {
			if(validnumber(mins)) {
				io.to('admin').emit('log', socket.room, 'Invalid time');
				return;
			}
			lockedUntil = Date.now() + mins * 60000;
		});
		socket.on('REGEX', regex => {
			try {
				new RegExp(regex);
			} catch(error) {
				io.to('admin').emit('log', socket.room, error);
				return;
			}
			regexstring = regex;
			regex = new RegExp(regex);
			io.to('admin').emit('log', socket.room, 'New regex', regexstring);
			for(const room in rooms) {
				if(regex.test(room)) {
					io.to('admin').emit('log', socket.room, 'Kicked '+rooms[room].admin.name);
					rooms[room].admin.disconnect();
				}
			}
		});
	});
	const log = (...arr) => {
		arr = [socket.room, socket.name, socket.hash, ...arr];
		io.to('admin').emit('log', ...arr);
		if(records.length >= 200) {
			records.shift();
		}
		records.push(arr);
		const date = new Date();
		get = unit => date['getUTC'+unit]().toString().padStart(2, '0');
		console.log(date.getUTCDate()+'.'+date.getUTCMonth()+'.'+date.getUTCFullYear()+' '+get('Hours')+':'+get('Minutes')+':'+get('Seconds'), ...arr);
	}
	socket.onAny((...arr) => {
		if(arr[0] == 'join') return;
		log(...arr);
	});
	const getallsockets = () => [...io.sockets.sockets.values()];
	const getname = () => {
		const rand = (arr, num = 1) => Math.random() < num? arr[~~(Math.random()*arr.length)]: '';
		const sockets = getallsockets();
		let name;
		let taken = true;
		const issimilar = (name1, name2) => {
			if(!name2) return false;
			if(name1 == name2) return true;
			if(name1.length == 3) return false;
			let i = 0;
			while(i < name1.length && i < name2.length && name1[i] == name2[i]) {
				i++;
			}
			return name1.slice(i + (name1.length >= name2.length)) == name2.slice(i + (name2.length >= name1.length))
		}
		for(let i = 0; i < 1000; i++) {
			name = rand([...'bfhklmnpstwxy', 'ch', 'sh', 'ny']) + rand('aeiou');
			if(Math.random() < .9) {
				name = rand([
					name + rand(['bbo', 'ggo', 'll', 'mba', 'nker', 'ndy', 'ng', 'ngo', 'nter', 'ppy', 'pster', 'psu', 'tsu', 'tty', 'tzy', 'xter', 'zz']),
					name + rand([...'mnprtx', 'ch', 'ff', 'kk', 'pp']) + rand('aiou'),
					name + rand([rand('dlnrstw') + rand('aeiou')], .2) + rand([...'bklmnrsx', 'ch', 'lm', 'nd', 'ng', 'sh']) + rand('aiou'),
					rand([...'bdghjklmnpstwxyz', 'tx']) + rand([...'aeiou', 'ai', 'au']) + rand([...'bdghklmnrstwxz', 'ld', 'rr']) + rand('aeiou') + rand([...'lnr', 'ts', 'tz'], 2)
				]);
			} else {
				name = rand([
					rand([...'cmnptxy', 'ch', 'hu', 'tz']) + rand('aeio') + rand('cmnpxy') + rand('aeio') + 'tl',
					rand('bkw') + 'a' + rand('hlz') + 'oo',
					rand([...'bhkltwy', 'ch', 'xi']) + 'ao',
					rand('bhkltw') + rand(['ai', 'ei'])
				]);
			}
			if(/([bcdfghklmnprstwxz])[aeiou]+\1|l[aeiou]+r|r[aeiou]+l|[aeiou]{2}[^aeiou]{2}|[hw]o|[kp][aeiou]+n|[tw][aeiou]+ng|b[aeiou]+[cnt]|ch[aeiou]+n|d[aeiou]+[gkm]|f[aeiou]+[cgkptx]|l[aeiou]+[bpz]|m[aeiou]+f|n[aeiou]+g|p[aeiou]+[sz]|pak|pet|s[aeiou]+x|sh[aeiou]+[gt]|w.nk|yi|nye|.w[ei]|huo.+tl/.test(name)) continue;
			//name = name[0].toUpperCase() + name.slice(1);
			if(sockets.every(socket2 => socket2 == socket || !issimilar(name, socket2.name))) {
				taken = false;
				break;
			}
		}
		if(taken) {
			let i;
			do i = ~~(Math.random()*1000);
			while(sockets.some(socket2 => socket2 != socket && socket2.name == name+i));
			name += i;
		}
		socket.name = name;
		socket.join(name);
	}
	getname();
	if(lockedUntil > Date.now() || users[socket.hash].bannedUntil > Date.now()) return;
	socket.emit('start', socket.name, Object.keys(rooms).filter(room => !room.includes('hidden') && rooms[room].timeout == undefined && !rooms[room].banned[socket.hash]));
	const leave = async (socket, msg1, msg2) => {
		socket.emit('leaveroom', msg1);
		if(rooms[socket.room].admin == socket) {
			clearTimeout(rooms[socket.room].timeout);
			for(const i in rooms[socket.room].banned) {
				clearTimeout(rooms[socket.room].banned[i]);
			}
			const sockets = await io.in(socket.room).fetchSockets();
			delete rooms[socket.room];
			for(const socket2 of sockets) {
				socket2.emit('leaveroom', 'Disconnected from '+socket.room+'! (Admin '+msg2+')');
				socket2.leave(socket.room);
				delete socket2.room;
				for(const listener of ['say', 'leave', 'disconnect']) {
					socket2.removeAllListeners(listener);
				}
			}
			if(socket.room.includes('hidden')) {
				socket.emit('rmvroom', socket.room);
				socket.to(socket.room).emit('rmvroom', socket.room);
			} else {
				io.emit('rmvroom', socket.room);
			}
			for(const listener of ['say', 'sendOnly', 'sendAll', 'kick', 'lock', 'leave', 'disconnect']) {
				socket.removeAllListeners(listener);
			}
		} else {
			rooms[socket.room].admin.emit('leave', msg2, socket.name, socket.hash);
			for(const listener of ['say', 'leave', 'disconnect']) {
				socket.removeAllListeners(listener);
			}
		}
		socket.leave(socket.room);
		delete socket.room;
	}
	socket.on('join', async (room, name) => {
		if(!validstring(room)) return;
		room = room.trim().replace(/\s/g, '_').replace(/^#*/, '#').slice(0, 30);
		if(regexstring && new RegExp(regexstring).test(room)) {
			io.to('admin').emit('log', room, 'Kicked '+socket.name);
			socket.disconnect();
			return;
		}
		if(socket.room) {
			if(socket.room == room) return;
			await leave(socket, '', 'has left');
		}
		if(rooms[room] && (rooms[room].timeout != undefined || rooms[room].banned[socket.name] || rooms[room].banned[socket.hash])) {
			socket.emit('notify', room+' is unavailable');
			return;
		}
		socket.leave(socket.name);
		if(name) {
			name = name.trim().slice(0, 30);
			let i = '';
			const sockets = getallsockets().filter(socket2 => socket2.room == room);
			while(sockets.some(socket2 => socket2.name == name+i)) {
				i = (i || 1) + 1;
			}
			socket.name = name+i;
			socket.join(name+i);
		} else {
			getname();
		}
		socket.room = room;
		log('join');
		if(rooms[socket.room]) {
			socket.join(socket.room);
			socket.emit('joinroom', socket.room, socket.name);
			rooms[socket.room].admin.emit('join', socket.name, socket.hash);
			socket.on('say', msg => {
				if(!validstring(msg)) return;
				rooms[socket.room].admin.emit('hear', msg.slice(0, 5000), socket.name, socket.hash)
			});
		} else {
			rooms[socket.room] = { 'admin':socket, banned:{} };
			if(!socket.room.includes('hidden')) {
				socket.broadcast.emit('addroom', socket.room);
			}
			socket.emit('joinroom', socket.room, socket.name, socket.hash);
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
				if(typeof arr[0] == 'boolean') {
					const [add, msgs1, names, msgs2] = arr;
					send(msgs1, names, msgs2, true, add);
				} else {
					const [msg1, names, msg2] = arr;
					send(msg1, names, msg2, true);
				}
			});
			socket.on('sendAll', async (...arr) => {
				if(typeof arr[0] == 'boolean') {
					const [add, msgs1, names, msgs2] = arr;
					if(!await send(msgs1, names, msgs2, false, add)) {
						io.to(socket.room).emit('change', add, msgs1);
					}
				} else {
					const [msg1, names, msg2] = arr;
					if(!await send(msg1, names, msg2, false)) {
						io.to(socket.room).emit('hear', msg1);
					}
				}
			});
			socket.on('kick', async (name, msg) => {
				if(!validstring(name) || socket.name == name) return;
				const socket2 = (await io.in(socket.room).fetchSockets()).find(socket2 => socket2.name == name);
				if(!socket2) {
					socket.emit('notify', 'Name not found');
					return;
				}
				io.to('admin').emit('log', socket.room, 'Kicked '+socket2.name);
				msg = validstring(msg)? ' '+msg: '!';
				leave(socket2, 'You\'ve been kicked'+msg, 'has been kicked'+msg);
			});
			socket.on('ban', async (hash, mins = 0, msg) => {
				if(!validstring(hash) || socket.hash == hash) return;
				let sockets = (await io.in(socket.room).fetchSockets()).filter(socket2 => socket2.hash == hash);
				if(!sockets.length) {
					socket.emit('notify', 'Hash not found');
					return;
				}
				msg = validstring(msg)? ' '+msg: '';
				for(const socket2 of sockets) {
					io.to('admin').emit('log', socket.room, 'Kicked '+socket2.name);
					await leave(socket2, 'You\'ve been banned from '+socket.room+msg, 'has been banned'+msg);
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
		socket.on('disconnect', () => {
			log('disconnect');
			leave(socket, '', 'has disconnected');
		});
	});
});
http.listen(process.env.PORT ?? 3000);