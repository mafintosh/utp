var dgram = require('dgram');
var cyclist = require('cyclist');
var EventEmitter = require('events').EventEmitter;
var Duplex = require('stream').Duplex;

var noop = function() {};

var EXTENSION = 0;
var VERSION   = 1;
var UINT16    = 0xffff;
var ID_MASK   = 0xf << 4;
var MTU       = 1400;

var PACKET_DATA  = 0 << 4;
var PACKET_FIN   = 1 << 4;
var PACKET_STATE = 2 << 4;
var PACKET_RESET = 3 << 4;
var PACKET_SYN   = 4 << 4;

var CONNECTING = 1;
var CONNECTED  = 2;
var HALF_OPEN  = 3;
var CLOSED     = 4;

var MIN_PACKET_SIZE = 20;
var DEFAULT_WINDOW_SIZE = 1 << 18;
var CLOSE_GRACE = 5000;

var BUFFER_SIZE = 512;

var uint32 = function(n) {
	return n >>> 0;
};

var uint16 = function(n) {
	return n & UINT16;
};

var timestamp = function() {
	var offset = process.hrtime();
	var then = Date.now() * 1000;

	return function() {
		var diff = process.hrtime(offset);
		return uint32(then + 1000000 * diff[0] + ((diff[1] / 1000) | 0));
	};
}();

var bufferToPacket = function(buffer) {
	var packet = {};
	packet.id = buffer[0] & ID_MASK;
	packet.connection = buffer.readUInt16BE(2);
	packet.timestamp = buffer.readUInt32BE(4);
	packet.timediff = buffer.readUInt32BE(8);
	packet.window = buffer.readUInt32BE(12);
	packet.seq = buffer.readUInt16BE(16);
	packet.ack = buffer.readUInt16BE(18);
	packet.data = buffer.length > 20 ? buffer.slice(20) : null;
	return packet;
};

var packetToBuffer = function(packet) {
	var buffer = new Buffer(20 + (packet.data ? packet.data.length : 0));
	buffer[0] = packet.id | VERSION;
	buffer[1] = EXTENSION;
	buffer.writeUInt16BE(packet.connection, 2);
	buffer.writeUInt32BE(packet.timestamp, 4);
	buffer.writeUInt32BE(packet.timediff, 8);
	buffer.writeUInt32BE(packet.window, 12);
	buffer.writeUInt16BE(packet.seq, 16);
	buffer.writeUInt16BE(packet.ack, 18);
	if (packet.data) packet.data.copy(buffer, 20);
	return buffer;
};

var Connection = function(port, host, socket, syn) {
	Duplex.call(this);
	var self = this;

	this.port = port;
	this.host = host;
	this.socket = socket;

	this._outgoing = cyclist(BUFFER_SIZE);
	this._incoming = cyclist(BUFFER_SIZE);

	this._inflightPackets = 0;
	this._stack = [];
	this._ondrain = noop;

	if (syn) {
		this._state = CONNECTED;
		this._recvId = uint16(syn.connection+1);
		this._sendId = syn.connection;
		this._seq = (Math.random() * UINT16) | 0;
		this._ack = syn.seq;
		this._synack = this._packet(PACKET_STATE, null);

		this._send(this._synack);
	} else {
		this._state = CONNECTING;
		this._recvId = 0; // tmp value for v8 opt
		this._sendId = 0; // tmp value for v8 opt
		this._seq = (Math.random() * UINT16) | 0;
		this._ack = 0;
		this._synack = null;

		socket.on('listening', function() {
			self._recvId = socket.address().port; // using the port gives us system wide clash protection
			self._sendId = uint16(self._recvId + 1);
			self._sendOutgoing(self._packet(PACKET_SYN, null));
		});

		socket.on('error', function(err) {
			self.emit('error', err);
		});

		socket.bind();
	}

	var resend = setInterval(this._checkTimeouts.bind(this), 500);
	var tick = 0;

	var closed = function() {
		if (++tick !== 2) return;
		if (!syn) setTimeout(socket.close.bind(socket), CLOSE_GRACE);
		clearInterval(resend);
		self.readyState = CLOSED;
		self.emit('close');
	};

	this.once('finish', function() {
		self._end(function() {
			process.nextTick(closed);
		});
	});

	this.once('end', function() {
		process.nextTick(closed);
	});
};

Connection.prototype.__proto__ = Duplex.prototype;

Connection.prototype.destroy = function() {
	this.end();
};

Connection.prototype.address = function() {
	return {port:this.port, address:this.host};
};

Connection.prototype._read = noop;

Connection.prototype._write = function(data, enc, callback) {
	if (this._state === CONNECTING) return this._stack.push(this._write.bind(this, data, enc, callback));

	if (data.length <= MTU) {
		if (this._writeData(data)) return callback();
		this._ondrain = this._write.bind(this, data, enc, callback);
		return;
	}

	for (var i = 0; i < data.length; i+= MTU) {
		if (this._writeData(data.slice(i, i+MTU))) continue;
		this._ondrain = this._write.bind(this, data.slice(i), enc, callback);
		return;
	}

	callback();
};

Connection.prototype._writeData = function(data) {
	if (this._inflightPackets >= BUFFER_SIZE-1) return false;
	this._sendOutgoing(this._packet(PACKET_DATA, data));
	return true;
};

Connection.prototype._end = function(callback) {
	if (this._state === CONNECTING) return this._stack.push(this._end.bind(this, callback));
	this._sendOutgoing(this._packet(PACKET_FIN, null));
	this._ondrain = callback;
};

Connection.prototype._recvAck = function(ack) {
	var offset = this._seq - this._inflightPackets;
	var acked = uint16(ack - offset)+1;

	if (acked >= BUFFER_SIZE) return; // sanity check

	for (var i = 0; i < acked; i++) {
		this._outgoing.del(offset+i);
		this._inflightPackets--;
	}

	if (this._inflightPackets) return;

	process.nextTick(this._ondrain);
	this._ondrain = noop;
};

Connection.prototype._sendAck = function() {
	this._send(this._packet(PACKET_STATE, null)); // TODO: make this delayed
};

Connection.prototype._recvIncoming = function(packet) {
	if (this._state === CLOSED) return;
	if (this._state === CONNECTED && packet.id === PACKET_SYN) return this._send(this._synack);
	if (this._state === CONNECTING) {
		if (packet.id !== PACKET_STATE) return this._incoming.put(packet.seq, packet);

		this.emit('connect');
		this._ack = uint16(packet.seq-1);
		this._recvAck(packet.ack);
		this._state = CONNECTED;

		while (this._stack.length) this._stack.shift()();

		packet = this._incoming.del(packet.seq);
		if (!packet) return;
	}

	if (uint16(packet.seq - this._ack) >= BUFFER_SIZE) return this._sendAck(); // old packet

	this._recvAck(packet.ack); // TODO: other calcs as well

	if (packet.id === PACKET_STATE) return;
	if (packet.id === PACKET_RESET) {
		this.readyState = CLOSED;
		this.push(null);
		this.end();
		return this._sendAck();
	}

	this._incoming.put(packet.seq, packet);

	while (packet = this._incoming.del(this._ack+1)) {
		this._ack = uint16(this._ack+1);

		if (packet.id === PACKET_DATA) {
			this.push(packet.data);
		}
		if (packet.id === PACKET_FIN) {
			this.push(null);
		}
	}

	this._sendAck();
};

Connection.prototype._sendOutgoing = function(packet) {
	this._outgoing.put(packet.seq, packet);
	this._seq = uint16(this._seq + 1);
	this._inflightPackets++;
	this._send(packet);
};

Connection.prototype._send = function(packet) {
	var message = packetToBuffer(packet);
	this.socket.send(message, 0, message.length, this.port, this.host);
};

Connection.prototype._checkTimeouts = function() {
	var first = this._outgoing.get(this._seq - this._inflightPackets);
	if (!first) return;
	if (!first.timeouts++) return;
	this._send(first);
};

Connection.prototype._packet = function(id, data) {
	var now = timestamp();
	return {
		id: id,
		connection: id === PACKET_SYN ? this._recvId : this._sendId,
		seq: this._seq,
		ack: this._ack,
		timestamp: now,
		timediff: 0,
		window: DEFAULT_WINDOW_SIZE,
		data: data,
		timeouts: 0
	};
};

var Server = function() {
	EventEmitter.call(this);
	this._socket = null;
	this._connections = {};
};

Server.prototype.__proto__ = EventEmitter.prototype;

Server.prototype.address = function() {
	return this.socket.address();
};

Server.prototype.listen = function(port, onlistening) {
	var socket = this._socket = dgram.createSocket('udp4');
	var connections = this._connections;
	var self = this;

	socket.on('message', function(message, rinfo) {
		if (message.length < MIN_PACKET_SIZE) return;
		var packet = bufferToPacket(message);
		var id = rinfo.address+':'+(packet.id === PACKET_SYN ? uint16(packet.connection+1) : packet.connection);

		if (connections[id]) return connections[id]._recvIncoming(packet);
		if (packet.id !== PACKET_SYN) return;

		connections[id] = new Connection(rinfo.port, rinfo.host, socket, packet);
		connections[id].on('close', function() {
			delete connections[id];
		});

		self.emit('connection', connections[id]);
	});

	socket.once('listening', function() {
		self.emit('listening');
	});

	if (onlistening) self.once('listening', onlistening);

	socket.bind(port);
};

exports.createServer = function(onconnection) {
	var server = new Server();
	if (onconnection) server.on('connection', onconnection);
	return server;
};

exports.connect = function(port, host) {
	var socket = dgram.createSocket('udp4');
	var connection = new Connection(port, host || '127.0.0.1', socket, null);

	socket.on('message', function(message) {
		if (message.length < MIN_PACKET_SIZE) return;
		var packet = bufferToPacket(message);

		if (packet.id === PACKET_SYN) return;
		if (packet.connection !== connection._recvId) return;

		connection._recvIncoming(packet);
	});

	return connection;
};