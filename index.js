const app = require('express')();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/favicon.ico', (req, res) => res.sendFile(__dirname + '/favicon.ico'));
app.use((req, res) => res.redirect('/'));
const admins = {};
let time = 0;
io.on('connection', socket => {
	if(time > Date.now() - 600000) return; // 10 minutes
	const rand = arr => arr[~~(Math.random()*arr.length)];
	const sockets = [...io.sockets.sockets.values()];
	let name;
	let taken = true;
	for(let i = 0; i < 1000; i++) {
		name = rand(['b', 'ch', 'f', 'h', 'k', 'l', 'm', 'n', 'ny', 'p', 'r', 's', 'sh', 't', 'w', 'x', 'y']) + rand('aeiou');
		if(Math.random() < .8) {
			name = rand([
				name + rand(['ch', 'ff', 'h', 'ck', 'll', 'm', 'n', 'p', 'r', 'ss', 't', 'w', 'x', 'zz']) + rand(['', '', '', 'a', 'e', 'i', 'o', 'u']),
				name + rand(['bbo', 'ggo', 'kku', 'll', 'mba', 'ndy', 'ng', 'ngo', 'nter', 'ppy', 'pster', 'psu', 'tty', 'tzy', 'xter']),
				rand(['ch', 'hu', 'tz', 'c', 'm', 'n', 'p', 't', 'x', 'y']) + rand('aeio') + rand('cmnpxy') + rand('aeio') + rand(['tl', 'ztli', 'htli'])
			]);
		} else {
			name = rand([
				name + rand('dnrst') + rand('aei') + rand(['lm', 'nd', 'nk', 'll', 'ss']) + 'a',
				rand('bkw') + 'a' + rand('hlz') + 'oo',
				rand(['b', 'h', 'k', 'l', 't', 'w', 'xi', 'y']) + 'ao',
				rand('bhkltw') + 'ai'
			]);
		}
		if(/^[^cxz]+tl|huo.+tl|x.+x|c.+c/.test(name)) continue;
		//name = name[0].toUpperCase() + name.slice(1);
		if(sockets.every(socket2 => socket2.name != name)) {
			taken = false;
			break;
		}
	}
	if(taken) {
		let i = 1;
		while(sockets.some(socket2 => socket2 != socket && socket2.name == name+i)) {
			i++;
		}
		name += i;
	}
	socket.name = name;
	socket.join(socket.name);
	socket.emit('start', socket.name, Object.keys(admins).filter(room => !/^#hidden/.test(room)));
	const leave = async (socket, msg1, msg2) => {
		socket.emit('leaveroom', msg1);
		if(admins[socket.room] == socket) {
			const sockets = await io.in(socket.room).fetchSockets();
			delete admins[socket.room];
			for(const socket2 of sockets) {
				socket2.emit('leaveroom', 'Disconnected from '+socket.room+'! (Admin has left)');
				socket2.leave(socket.room);
				delete socket2.room;
				for(const listener of ['say', 'leave', 'disconnect']) {
					socket2.removeAllListeners(listener);
				}
			}
			if(/^#hidden/.test(socket.room)) {
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
			await leave(socket);
		}
		socket.room = room;
		if(admins[socket.room]) {
			socket.join(socket.room);
			socket.emit('joinroom', socket.room);
			admins[socket.room].emit('join', socket.name);
			socket.on('say', msg => admins[socket.room].emit('hear', msg, socket.name));
		} else {
			admins[socket.room] = socket;
			if(/^#hidden/.test(socket.room)) {
				socket.emit('addroom', socket.room);
			} else {
				io.emit('addroom', socket.room);
			}
			socket.emit('joinroom', socket.room, true);
			const send = async (msg1, names, msg2, only, add) => {
				if(Array.isArray(names)) {
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
						io.to(socket.room).emit('change', msgs1);
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
					leave(socket);
				} else {
					if(sockets[0]?.room != socket.room) return;
					leave(sockets[0], 'You\'ve been kicked from '+socket.room+'!', socket.name+' has been kicked');
				}
			});
		}
		socket.on('leave', () => leave(socket, null, socket.name+' has left'));
		socket.on('disconnect', () => leave(socket, null, socket.name+' has disconnected'));
	});
	socket.onAny((...arr) => {
		arr = [socket.ip, socket.name, socket.room, ...arr];
		console.log(arr);
		io.to('admin').emit('log', arr);
	});
	socket.once('sudo', password => {
		if(password != process.env.PASSWORD) return;
		socket.join('admin');
		socket.on('ban', async (name, password) => {
			if(name[0] == '#') {
				admins[name]?.disconnect();
			} else {
				const sockets = await io.in(name).fetchSockets();
				sockets[0]?.disconnect();
			}
			time = Date.now();
		});
	});
});
http.listen(process.env.PORT ?? 3000);