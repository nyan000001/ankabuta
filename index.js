const app = require('express')();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
app.get('/', (req, res) => {
	res.sendFile(__dirname + '/index.html');
});
app.get('/favicon.ico', (req, res) => {
	res.sendFile(__dirname + '/favicon.ico');
});
const admins = {};
io.on('connection', socket => {
	const rand = arr => arr[~~(Math.random()*arr.length)];
	const sockets = [...io.sockets.sockets.values()];
	socket.ip = socket.request.connection.remoteAddress;
	const socket2 = sockets.find(socket2 => socket2 != socket && socket2.ip == socket.ip);
	let name;
	let taken = true;
	if(socket2) {
		name = socket2.name.replace(/\d+/, '');
	} else {
		for(let i = 0; i < 1000; i++) {
			name = '';
			if(Math.random() < .9) {
				name += rand(['ch', 'f', 'h', 'k', 'l', 'm', 'n', 'ny', 'p', 'r', 's', 't', 'w', 'x', 'y']);
			}
			name += rand('aeiou');
			if(Math.random() < .7) {
				name += rand(['ch', 'f', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 'ss', 't', 'w', 'x', 'zz']) + rand('aeiou');
			} else {
				name += rand(['bbo', 'ggo', 'll', 'mba', 'ndy', 'ng', 'ngo', 'nter', 'pper', 'ppy', 'ster', 'tty']);
			}
			//name = name[0].toUpperCase() + name.slice(1);
			if(sockets.every(socket2 => socket2.name != name)) {
				taken = false;
				break;
			}
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
	socket.emit('start', socket.name, Object.keys(admins));
	const leave = async (socket, msg) => {
		socket.emit('leaveroom', msg);
		if(admins[socket.room] == socket) {
			const sockets = await io.in(socket.room).fetchSockets();
			delete admins[socket.room];
			for(const socket2 of sockets) {
				socket2.emit('leaveroom', 'Disconnected from '+socket.room+'! (Admin has left)');
				socket2.leave(socket.room);
				delete socket2.room;
				for(const listener of ['disconnect', 'leave', 'say']) {
					socket2.removeAllListeners(listener);
				}
			}
			if(/^#hidden/.test(socket.room)) {
				io.to(socket.room).emit('rmvroom', socket.room);
			} else {
				io.emit('rmvroom', socket.room);
			}
		} else {
			admins[socket.room].emit('leave', socket.name);
		}
		for(const listener of ['disconnect', 'leave', 'say', 'sendOnly', 'sendAll', 'change', 'kick']) {
			socket.removeAllListeners(listener);
		}
		socket.leave(socket.room);
		delete socket.room;
	}
	const valid = (...arr) => arr.every(x => x && typeof x == 'string');
	socket.on('join', async room => {
		if(!valid(room)) return;
		room = room.replace(/\s/g, '_').replace(/^#?/, '#');
		if(socket.room) {
			if(socket.room == room) return;
			await leave(socket);
		}
		socket.room = room;
		if(admins[socket.room]) {
			socket.join(socket.room);
			socket.emit('joinroom', socket.room);
			admins[socket.room].emit('join', socket.name);
		} else {
			admins[socket.room] = socket;
			if(/^#hidden/.test(socket.room)) {
				socket.emit('addroom', socket.room);
			} else {
				io.emit('addroom', socket.room);
			}
			socket.emit('joinroom', socket.room, true);
		}
		socket.on('disconnect', () => leave(socket));
		socket.on('leave', () => leave(socket));
		socket.on('say', msg => {
			if(!valid(msg) || admins[socket.room] == socket) return;
			admins[socket.room].emit('hear', msg, socket.name);
		});

		if(admins[socket.room] == socket) {
			socket.on('sendOnly', async (msg1, names, msg2) => {
				if(!valid(msg1)) return;
				if(Array.isArray(names)) {
					const sockets = await io.in(socket.room).fetchSockets();
					for(const socket2 of sockets) {
						if(names.includes(socket2.name)) {
							socket2.emit('hear', msg1);
						} else if(valid(msg2)) {
							socket2.emit('hear', msg2);
						}
					}
				}
			});
			socket.on('sendAll', async (msg1, names, msg2) => {
				if(!valid(msg1)) return;
				if(Array.isArray(names)) {
					const sockets = await io.in(socket.room).fetchSockets();
					for(const socket2 of sockets) {
						if(!names.includes(socket2.name)) {
							socket2.emit('hear', msg1);
						} else if(valid(msg2)) {
							socket2.emit('hear', msg2);
						}
					}
				} else {
					io.to(socket.room).emit('hear', msg1);
				}
			});
			socket.on('change', (index, text) => {
				io.to(socket.room).emit('change', index, text);
			});
			socket.on('kick', async name => {
				if(!valid(name)) return;
				const sockets = await io.in(name).fetchSockets();
				if(sockets[0]?.room == socket.room) {
					leave(sockets[0], 'You\'ve been kicked from '+socket.room+'!');
				}
			});
		}
	});
});
http.listen(process.env.PORT || 3000);