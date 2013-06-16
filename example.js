var utp = require('./index');

var server = utp.createServer();

server.on('connection', function(socket) {
	socket.on('packetresend', function(packet) {
		console.error('[DEBUG] server resending', packet);
	});

	for (var i = 0; i < 5; i++) {
		socket.write('hello client #'+i+'!');
	}

	socket.on('data', function(data) {
		socket.write('server says '+data);
	});
});

server.on('listening', function() {
	var socket = utp.connect(10000);

	socket.on('packetresend', function(packet) {
		console.error('[DEBUG] client resending', packet);
	});

	for (var i = 0; i < 5; i++) {
		socket.write('hello server #'+i+'!');
	}

	socket.on('data', function(data) {
		console.log('client:', data.toString());
	});
});

server.listen(10000);