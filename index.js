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
	let name;
	let taken = true;
	for(let i = 0; i < 1000; i++) {
		name = '';
		if(Math.random() < .9) {
			name += rand(['ch', 'f', 'h', 'k', 'l', 'm', 'n', 'ny', 'p', 'r', 's', 't', 'w', 'x', 'y']);
		}
		name += rand('aeiou');
		if(Math.random() < .7) {
			name += rand(['ch', 'f', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'w', 'x', 'y', 'zz']) + rand('aeiou');
		} else {
			name += rand(['ng', 'ppy', 'tty', 'ndy', 'nter', 'bbo', 'mba', 'll']);
		}
		//name = name[0].toUpperCase() + name.slice(1);
		if(sockets.every(socket2 => socket2.name != name)) {
			taken = false;
			break;
		}
	}
	if(taken) {
		let i = 2;
		while(sockets.some(socket2 => socket2.name == name+i)) i++;
		name += i;
	}
	socket.name = name;
	socket.join(socket.name);
	socket.emit('start', socket.name, Object.keys(admins));
	const leave = async (socket, msg) => {
		if(admins[socket.room] == socket) {
			socket.emit('leaveroom', socket.room, msg, true);
			if(/^#hidden/.test(socket.room)) {
				io.to(socket.room).emit('rmvroom', socket.room);
			} else {
				io.emit('rmvroom', socket.room);
			}
			const sockets = await io.in(socket.room).fetchSockets();
			delete admins[socket.room];
			for(const socket2 of sockets) {
				socket2.emit('leaveroom', socket.room, 'Disconnected from '+socket.room+'! (Admin has left)');
				socket2.leave(socket.room);
				delete socket2.room;
				for(const listener of ['leave', 'disconnect', 'kick', 'pm', 'say']) {
					socket2.removeAllListeners(listener);
				}
			}
		} else {
			socket.emit('leaveroom', socket.room, msg);
			admins[socket.room].emit('leave', socket.name);
		}
		for(const listener of ['leave', 'disconnect', 'kick', 'pm', 'say']) {
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
			await leave(socket, 'You have left '+socket.room);
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

		socket.on('leave', () => leave(socket, 'You have left '+socket.room));

		socket.on('say', msg => {
			if(!valid(msg) || admins[socket.room] == socket) return;
			admins[socket.room].emit('hear', msg, socket.name);
		});

		socket.on('sendOnly', async (msg1, names, msg2) => {
			if(!valid(msg1) || admins[socket.room] != socket) return;
			if(Array.isArray(names) || (names = [names])) {
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
			if(!valid(msg1) || admins[socket.room] != socket) return;
			if(Array.isArray(names) || (names = [names])) {
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

		socket.on('kick', async name => {
			if(!valid(name) || admins[socket.room] != socket) return;
			const sockets = await io.in(name).fetchSockets();
			if(sockets[0]?.room == socket.room) {
				leave(sockets[0], 'You\'ve been kicked from '+socket.room+'!');
			}
		});
	});
});
http.listen(process.env.PORT || 3000);