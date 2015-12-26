var utp = require('../src');
var assert = require('assert');

var onclose = function() {
	process.exit(0);
};

var server = utp.createServer(function(socket) {
	socket.resume();
	socket.end();
	server.close(onclose);
})

server.listen(53454, function () {
  var socket = utp.connect(53454);

  socket.once('connect', function () {
    socket.end();
  });
});
