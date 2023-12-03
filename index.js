const app = require('express')();
const http = require('http').createServer(app, { cookie:true });
const io = require('socket.io')(http);
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/favicon.ico', (req, res) => res.sendFile(__dirname + '/favicon.ico'));
app.get('/blank', (req, res) => res.sendFile(__dirname + '/blank.html'));
app.use((req, res) => res.redirect('/'));
require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');
const client = new MongoClient(process.env.URI, { serverApi:{ version:ServerApiVersion.v1, strict:true, deprecationErrors:true } });
const collection = client.db('Cluster0').collection('hashes');
//collection.createIndex( { createdAt:1 }, { expireAfterSeconds:604800 } );
const crypto = require('crypto');
const cookie = require('cookie');
const start = async () => {
	const bannedUntil = {};
	const docs = await collection.find({}).toArray();
	for(const doc of docs) {
		bannedUntil[doc._id] = doc.bannedUntil;
	}
	const makehash = uid => crypto.createHash('sha256').update(uid).digest('base64');
	io.engine.on('initial_headers', (headers, request) => {
		let uid;
		let hash;
		if(request.headers.cookie && cookie.parse(request.headers.cookie).uid) {
			uid = cookie.parse(request.headers.cookie).uid;
			hash = makehash(uid);
			if(bannedUntil[hash] != undefined) return;
		} else {
			do {
				uid = crypto.randomBytes(32).toString('base64');
				hash = makehash(uid);
			} while(bannedUntil[hash] != undefined);
			headers['set-cookie'] = request.headers.cookie = cookie.serialize('uid', uid, { maxAge:604800, sameSite:'strict' });
		}
		collection.insertOne({ _id:hash, createdAt:new Date(), bannedUntil:0 });
		bannedUntil[hash] = 0;
	});
	const rooms = {};
	const records = [];
	let lockedUntil = 0;
	let regexstring;
	io.on('connection', socket => {
		socket.hash = makehash(cookie.parse(socket.handshake.headers.cookie).uid);
		socket.join(socket.hash);
		const validstring = string => string && typeof string == 'string';
		const validnumber = num => num > 0;
		const login = password => {
			if(password != process.env.PASSWORD) {
				io.to('admin').emit('log', socket.room, 'Invalid password');
				return false;
			}
			if(!socket.rooms.has('admin')) {
				socket.emit('log', records, Object.keys(rooms), regexstring);
				socket.join('admin');
			}
			return true;
		}
		socket.on('LOGIN', login);
		socket.on('KICK', async (password, name, mins) => {
			if(!login(password)) return;
			if(!validstring(name)) {
				io.to('admin').emit('log', socket.room, 'Invalid name');
				return;
			}
			let hash;
			if(name[0] == '#') {
				if(rooms[name]) {
					hash = rooms[name].admin.hash;
					io.to('admin').emit('log', socket.room, 'Kicked', name);
					rooms[name].admin.disconnect();
				}
			} else {
				const sockets = await io.in(name).fetchSockets();
				hash = sockets[0]?.hash;
				for(const socket2 of sockets) {
					io.to('admin').emit('log', socket.room, 'Kicked', socket2.name);
					await socket2.disconnect();
				}
			}
			if(validnumber(mins)) {
				if(bannedUntil[hash] == undefined) {
					io.to('admin').emit('log', socket.room, 'Invalid hash');
					return;
				}
				const time = Date.now() + mins * 60000;
				bannedUntil[hash] = time;
				collection.updateOne({ _id:hash }, { $set: { bannedUntil:time } });
			}
		});
		socket.on('LOCK', (password, mins) => {
			if(!login(password)) return;
			if(!validnumber(mins)) {
				io.to('admin').emit('log', socket.room, 'Invalid time');
				return;
			}
			lockedUntil = Date.now() + mins * 60000;
		});
		socket.on('REGEX', (password, regex) => {
			if(!login(password)) return;
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
					io.to('admin').emit('log', socket.room, 'Kicked', rooms[room].admin.name);
					rooms[room].admin.disconnect();
				}
			}
		});
		socket.onAny((...arr) => {
			arr = [socket.room, socket.name, socket.hash, ...arr];
			io.to('admin').emit('log', ...arr);
			if(!records.length) {
				records.push(arr);
				console.log(...arr);
			} else {
				if(records.length == 100) {
					records.shift();
				}
				let index = -1;
				for(let i = 0; i < arr.length; i++) {
					if(JSON.stringify(arr[i]) != JSON.stringify(records.at(-1)[i])) {
						index = index > -1? -2: i;
					}
				}
				if(index == -1) return;
				if(index != -2 && Array.isArray(records.at(-1)[index]) && Array.isArray(arr[index])) {
					records.at(-1)[index].push(...arr[index]);
				} else {
					records.push(arr);
				}
				console.log(...arr);
			}
		});
		if(lockedUntil > Date.now() || bannedUntil[socket.hash] > Date.now()) return;
		const rand = (arr, num = 1) => Math.random() < num? arr[~~(Math.random()*arr.length)]: '';
		const getallsockets = () => [...io.sockets.sockets.values()];
		const sockets = getallsockets();
		let name;
		let taken = true;
		const issimilar = (name1, name2) => {
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
			if(Math.random() < .8) {
				name = rand([
					name + rand(['bbo', 'ggo', 'll', 'mba', 'nker', 'ndy', 'ng', 'ngo', 'nter', 'ppy', 'pster', 'psu', 'tsu', 'tty', 'tzy', 'xter', 'zz']),
					name + rand([...'mnprtx', 'ch', 'ff', 'kk', 'pp']) + rand('aiou'),
					name + rand([rand('dlnrst') + rand('aeiou')], .2) + rand([...'bklmnrsx', 'ch', 'lm', 'nd', 'ng', 'sh']) + rand('aiou'),
					rand('bhklmnptwxy') + rand([...'aeiou', 'ai']) + rand('bklmntwx') + rand('aeiou')
				]);
			} else {
				name = rand([
					rand([...'bdghjklnstz', 'tx'], .9) + rand([...'aeiou', 'ai', 'au']) + rand([...'bdghklnrstz', 'rr']) + rand('aeiou') + rand([...'lnr', '#ts', '#tz']).replace('#', rand('lnr', .3)),
					rand([...'bdghjklnstz', 'tx'], .9) + rand([...'aeiou', 'ai', 'au']) + rand([...'bdghklnrstz', 'rr', '#ts', '#tz']).replace('#', rand('lnr', .3)) + rand('aeiou'),
					rand([...'cmnptxy', 'ch', 'hu', 'tz']) + rand('aeio') + rand('cmnpxy') + rand('aeio') + rand(['tl', 'ztli', 'htli']),
					rand('bkw') + 'a' + rand('hlz') + 'oo',
					rand([...'bhkltwy', 'xi']) + 'ao',
					rand('bhkltw') + rand(['ai', 'ei'])
				]);
			}
			if(/([bcdfghklmnprstwxz]).+\1|huo.+tl|l.+r|r.+l|n.+g|f.+[gk]|d.+k|b.+t|p.+s|h.+t|[bd].+c|ch.+n|[kp].+n|ank|[hw]o|yi|nye|.w[ei]/.test(name)) continue;
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
		socket.join(socket.name);
		socket.emit('start', socket.name, Object.keys(rooms).filter(room => !room.includes('hidden') && rooms[room].timeout == undefined && !rooms[room].banned[socket.hash]));
		const leave = async (socket, msg1, msg2) => {
			socket.emit('leaveroom', msg1);
			if(rooms[socket.room].admin == socket) {
				clearTimeout(rooms[socket.room].timeout);
				for(const timeout in rooms[socket.room].banned) {
					clearTimeout(rooms[socket.room].banned[i]);
				}
				const sockets = await io.in(socket.room).fetchSockets();
				delete rooms[socket.room];
				for(const socket2 of sockets) {
					socket2.emit('leaveroom', 'Disconnected from '+socket.room+'! (Admin '+msg2+')');
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
				rooms[socket.room].admin.emit('leave', msg2, socket.name, socket.hash);
				for(const listener of ['say', 'leave']) {
					socket.removeAllListeners(listener);
				}
			}
			socket.leave(socket.room);
			delete socket.room;
		}
		socket.on('join', async room => {
			if(!validstring(room)) return;
			room = room.replace(/\s/g, '_').replace(/^#?/, '#').slice(0, 30);
			if(regexstring && new RegExp(regexstring).test(room)) {
				io.to('admin').emit('log', room, 'Kicked', socket.name);
				socket.disconnect();
				return;
			}
			if(socket.room) {
				if(socket.room == room) return;
				await leave(socket, '', 'has left');
			}
			if(rooms[room] && (rooms[room].timeout != undefined || rooms[room].banned[socket.name] || rooms[room].banned[socket.hash])) {
				socket.emit('joinroom', room, false, true);
				return;
			}
			socket.room = room;
			if(rooms[socket.room]) {
				socket.join(socket.room);
				socket.emit('joinroom', socket.room);
				rooms[socket.room].admin.emit('join', socket.name, socket.hash);
				socket.on('say', msg => rooms[socket.room].admin.emit('hear', msg, socket.name, socket.hash));
			} else {
				rooms[socket.room] = { 'admin':socket, banned:{} };
				if(!socket.room.includes('hidden')) {
					socket.broadcast.emit('addroom', socket.room);
				}
				socket.emit('joinroom', socket.room, true);
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
				socket.on('kick', async (name, mins = 0) => {
					if(!validstring(name)) return;
					if(name == socket.room) {
						io.to('admin').emit('log', socket.room, 'Kicked', name);
						await leave(socket, '', 'has kicked the room');
					} else if(name == socket.name || name == socket.hash) {
						io.to('admin').emit('log', socket.room, 'Kicked', name);
						await leave(socket, 'You\'ve been kicked from '+socket.room+'!', 'has kicked themself');
					} else {
						const getsockets = () => getallsockets().filter(socket2 => socket2.room == socket.room && (socket2.name == name || socket2.hash == hash));
						for(const socket2 of getsockets()) {
							io.to('admin').emit('log', socket.room, 'Kicked', socket2.name);
							await leave(socket2, 'You\'ve been kicked from '+socket.room+'!', 'has been kicked');
						}
						if(!validnumber(mins)) return;
						clearTimeout(rooms[socket.room].banned[name]);
						for(const socket2 of sockets) {
							socket2.emit('rmvroom', socket.room);
						}
						rooms[socket.room].banned[name] = setTimeout(() => {
							for(const socket2 of getsockets()) {
								socket2.emit('addroom', socket.room);
							}
							delete rooms[socket.room].banned[name];
						});
					}
				});
				socket.on('lock', async mins => {
					if(!validnumber(mins)) return;
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
					rooms[socket.room].timeout = setTimeout(() => {
						delete rooms[socket.room].timeout;
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
			const arr = [socket.room, socket.name, socket.hash, 'disconnect'];
			records.push(arr);
			io.to('admin').emit('log', ...arr);
			if(socket.room) {
				leave(socket, '', 'has disconnected');
			}
		});
	});
}
start();
http.listen(process.env.PORT ?? 3000);