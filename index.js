const app = require('express')();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/favicon.ico', (req, res) => res.sendFile(__dirname + '/favicon.ico'));
app.get('/blank', (req, res) => res.sendFile(__dirname + '/blank.html'));
app.use((req, res) => res.redirect('/'));
const admins = {};
const records = [];
let time = 0;
io.on('connection', socket => {
	if(time > Date.now()) return; // 10 minutes
	const rand = (arr, num = 1) => Math.random() < num? arr[~~(Math.random()*arr.length)]: '';
	const sockets = [...io.sockets.sockets.values()];
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
				rand('bhklmnptwxy') + rand([...'aeiou', 'ai']) + rand('klmntw') + rand('aeiou')
			]);
		} else {
			name = rand([
				rand([...'bdghjklnstz', 'tx'], .9) + rand([...'aeiou', 'ai', 'au']) + rand([...'bdghklnrstz', 'rr']) + rand('aeiou') + rand([...'lnr', '#ts', '#tz']).replace('#', rand('lnr', .2)),
				rand([...'bdghjklnstz', 'tx'], .9) + rand([...'aeiou', 'ai', 'au']) + rand([...'bdghklnrstz', 'rr', '#ts', '#tz']).replace('#', rand('lnr', .2)) + rand('aeiou'),
				rand([...'cmnptxy', 'ch', 'hu', 'tz']) + rand('aeio') + rand('cmnpxy') + rand('aeio') + rand(['tl', 'ztli', 'htli']),
				rand('bkw') + 'a' + rand('hlz') + 'oo',
				rand([...'bhkltwy', 'xi']) + 'ao',
				rand('bhkltw') + rand(['ai', 'ei'])
			]);
		}
		if(/([bcdfghklmnprstwxz]).+\1|huo.+tl|l.+r|r.+l|n.g|f.[gk]|d.k|b.t|p.s|h.t|[bd].c|ch.n|[kp].n|ank|[hw]o|yi|nye|.w[ei]/.test(name)) continue;
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
	socket.emit('start', socket.name, Object.keys(admins).filter(room => !room.includes('hidden')));
	const leave = async (socket, msg1, msg2) => {
		socket.emit('leaveroom', msg1);
		if(admins[socket.room] == socket) {
			const sockets = await io.in(socket.room).fetchSockets();
			delete admins[socket.room];
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
			for(const listener of ['say', 'sendOnly', 'sendAll', 'kick', 'leave', 'disconnect']) {
				socket.removeAllListeners(listener);
			}
		} else {
			admins[socket.room].emit('leave', msg2, socket.name);
			for(const listener of ['say', 'leave', 'disconnect']) {
				socket.removeAllListeners(listener);
			}
		}
		socket.leave(socket.room);
		delete socket.room;
	}
	const valid = (...arr) => arr.every(x => x && typeof x == 'string');
	socket.on('join', async room => {
		if(!valid(room)) return;
		room = room.replace(/\s/g, '_').replace(/^#?/, '#').slice(0, 30);
		if(socket.room) {
			if(socket.room == room) return;
			await leave(socket, null, 'has gone to another room');
		}
		socket.room = room;
		if(admins[socket.room]) {
			socket.join(socket.room);
			socket.emit('joinroom', socket.room);
			admins[socket.room].emit('join', socket.name);
			socket.on('say', msg => admins[socket.room].emit('hear', msg, socket.name));
		} else {
			admins[socket.room] = socket;
			if(socket.room.includes('hidden')) {
				socket.emit('addroom', socket.room);
			} else {
				io.emit('addroom', socket.room);
			}
			socket.emit('joinroom', socket.room, true);
			const send = async (msg1, names, msg2, only, add) => {
				if(!Array.isArray(names)) return;
				const sockets = await io.in(socket.room).fetchSockets();
				for(const socket2 of sockets) {
					if(add != null) {
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
			socket.on('kick', async name => {
				if(!valid(name)) return;
				const sockets = await io.in(name).fetchSockets();
				if(name == socket.room) {
					leave(socket, null, 'has kicked the room');
				} else {
					if(sockets[0]?.room != socket.room) return;
					leave(sockets[0], 'You\'ve been kicked from '+socket.room+'!', 'has been kicked');
				}
			});
		}
		socket.on('leave', () => leave(socket, null, 'has left'));
		socket.on('disconnect', () => leave(socket, null, 'has disconnected'));
	});
	socket.onAny((...arr) => {
		console.log(socket.name, socket.room, ...arr);
		records.push([socket.name, socket.room, ...arr]);
		if(records.length == 30) {
			records.shift();
		}
		io.to('admin').emit('log', socket.name, socket.room, ...arr);
	});
	socket.on('ban', async (password, name, mins = 1) => {
		if(password != process.env.PASSWORD) return;
		if(name) {
			if(name[0] == '#') {
				if(admins[name]) {
					admins[name].disconnect();
					io.to('admin').emit('log', name, null, 'kicked');
				}
			} else {
				const sockets = await io.in(name).fetchSockets();
				if(sockets[0]) {
					sockets[0].disconnect();
					io.to('admin').emit('log', name, null, 'kicked');
				}
			}
		}
		time = Date.now() + mins * 60000;
	});
	socket.once('login', password => {
		if(password != process.env.PASSWORD) return;
		socket.emit('start2', records, Object.keys(admins));
		socket.join('admin');
	});
});
http.listen(process.env.PORT ?? 3000);