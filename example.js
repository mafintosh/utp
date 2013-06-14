var utp = require('./index');

var server = utp.createServer();

server.on('connection', function(socket) {
	socket.on('data', function(data) {
		socket.write('server says '+data);
	});
});

server.on('listening', function() {
	var socket = utp.connect(10000);

	socket.write('hello world!');
	socket.write('hello world2!');
	socket.on('data', function(data) {
		console.log('client:', data.toString());
	});
});

server.listen(10000);