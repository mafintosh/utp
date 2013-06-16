var dgram = require('dgram');
var cyclist = require('cyclist');
var EventEmitter = require('events').EventEmitter;
var Duplex = require('stream').Duplex;

var noop = function() {};

var EXTENSION = 0;
var VERSION   = 1;
var UINT16    = 0xffff;
var ID_MASK   = 0xf << 4;

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

var BUFFER_MAX = 512;

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

	this._outgoing = cyclist(BUFFER_MAX); // TODO: set to 2 and and grow if needed until BUFFER_MAX
	this._incoming = cyclist(BUFFER_MAX);
	this._inflightPackets = 0;
	this._inflightTimeout = 500000;
	this._stack = [];

	if (syn) {
		this.seq = (Math.random() * UINT16) | 0;
		this.ack = syn.seq;
		this.recvId = uint16(syn.connection + 1);
		this.sendId = syn.connection;
		this.readyState = CONNECTED;

		this._sendAck();
	} else {
		this.seq = 1;
		this.ack = 1;
		this.recvId = 0; // tmp value for v8
		this.sendId = 0; // tmp value for v8
		this.readyState = CONNECTING;

		socket.bind(); // we are iniating this connection since we own the socket
		socket.on('listening', function() {
			self.recvId = socket.address().port; // using the port gives us system wide clash protection
			self.sendId = uint16(self.recvId + 1);
			self._sendPacket(PACKET_SYN, self.recvId, null);
		});
		socket.on('error', function(err) {
			self.emit('error', err);
		});
	}

	var resend = setInterval(this._checkTimeout.bind(this), 500);

	var tick = 0;
	var closed = function() {
		if (++tick !== 2) return;
		if (!syn) setTimeout(socket.close.bind(socket), CLOSE_GRACE);
		clearInterval(resend);
		self.readyState = CLOSED;
		self.emit('close');
	};

	this.on('finish', function() {
		self._sendFin(function() {
			process.nextTick(closed);
		});
	});
	this.on('end', function() {
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

Connection.prototype._write = function(data, enc, callback) { // TODO: check size against MTU
	if (this.readyState === CONNECTING) return this._stack.push(this._write, arguments);
	this._sendPacket(PACKET_DATA, this.sendId, data, callback);
};

Connection.prototype._sendFin = function(callback) {
	if (this.readyState === CONNECTING) return this._stack.push(this._sendFin, arguments);
	this._sendPacket(PACKET_FIN, this.sendId, null, callback);
};

Connection.prototype._sendAck = function() {
	this._send(this._packet(PACKET_STATE, this.sendId, null, null));
};

Connection.prototype._sendPacket = function(id, connection, data, callback) {
	var packet = this._packet(id, connection, data, callback);
	this._outgoing.put(packet.seq, packet);
	this._send(packet);
};

Connection.prototype._send = function(packet) {
	var message = packetToBuffer(packet);
	this._inflightPackets++;
	this.socket.send(message, 0, message.length, this.port, this.host);
};

Connection.prototype._checkTimeout = function() {
	for (var i = 0; i < this._inflightPackets; i++) {
		var packet = this._outgoing.get(this.seq - i - 1);
		if (!packet) continue;
		var now = timestamp();
		if (uint32(now - packet.sent) < this._inflightTimeout) continue;
		packet.sent = now;
		this._send(packet);
		this.emit('packetresend', packet);
	}
};

Connection.prototype._duplicate = function(packet) {
	if (uint16(packet.seq - this.ack) >= BUFFER_MAX) {
		this._sendAck(); // this is an duplicate packet - lets just ack it
		return true;
	}
	return false;
};

Connection.prototype._packet = function(id, connection, data, callback) {
	var now = timestamp();
	var seq = this.seq;
	this.seq = uint16(this.seq+1);
	return {
		id: id,
		connection: connection,
		timestamp: now,
		timediff: 0,
		window: DEFAULT_WINDOW_SIZE,
		seq: seq,
		ack: this.ack,
		data: data,
		sent: now,
		callback: callback
	};
};

Connection.prototype._recvAck = function(seq) { // when we receive an ack
	var prevAcked = uint16(this.seq - this._inflightPackets - 1); // last packet that was acked
	var acks = uint16(seq - prevAcked); // amount of acks we just recv
	if (acks >= BUFFER_MAX) return; // sanity check

	for (var i = 0; i < acks; i++) {
		this._inflightPackets--;
		var packet = this._outgoing.del(prevAcked+i+1);
		if (packet && packet.callback) packet.callback();
	}
};

Connection.prototype._recvPacket = function(packet) { // when we receive a packet
	if (this.readyState === CLOSED) return;

	if (this.readyState === CONNECTING && packet.id === PACKET_STATE) { // first ack -> we are connected
		this.emit('connect');
		this.ack = packet.seq;
		this.readyState = CONNECTED;
		this._recvAck(packet.ack);

		while (this._stack.length) this._stack.shift().apply(this, this._stack.shift());
		packet = this._incoming.del(this.ack+1);
		if (!packet) return;
	}

	// reorder this packet. TODO: move all this into a ._reorder handler to avoid state check spamming
	if (this.readyState !== CONNECTING && this._duplicate(packet)) return;
	this._incoming.put(packet.seq, packet);
	if (this.readyState === CONNECTING) return; // still waiting for the ack

	var shouldAck = false;
	while (packet = this._incoming.del(this.ack+1)) {
		this.ack = uint16(this.ack+1);

		if (this.readyState !== CONNECTED) { // not connected -> handle everything as PACKET_STATE packets
			this._recvAck(packet.ack);
			continue;
		}

		switch (packet.id) {
			case PACKET_DATA:
			this.push(packet.data);
			break;

			case PACKET_FIN:
			this.readyState = HALF_OPEN;
			this.push(null);
			break;

			case PACKET_RESET:
			this.readyState = CLOSED;
			this.push(null);
			this.end();
			break;
		}

		shouldAck = shouldAck || packet.id !== PACKET_STATE;
		this._recvAck(packet.ack);
	}

	if (shouldAck) this._sendAck();
};

var Server = function() {
	EventEmitter.call(this);
	this.socket = null;
};

Server.prototype.__proto__ = EventEmitter.prototype;

Server.prototype.address = function() {
	return this.socket && this.socket.address();
};

Server.prototype.listen = function(socket, onlistening) {
	if (typeof socket !== 'object') {
		var port = socket;
		socket = dgram.createSocket('udp4');
		socket.bind(port);
		return this.listen(socket, onlistening);
	}

	var self = this;
	var connections = {};

	this.socket = socket;

	socket.on('listening', function() {
		self.emit('listening');
	});
	socket.on('error', function(err) {
		self.emit('error', err);
	});

	socket.on('message', function(message, rinfo) {
		if (message.length < MIN_PACKET_SIZE) return;
		var packet = bufferToPacket(message);
		var connection = connections[rinfo.address+':'+packet.connection];

		if (connection) {
			connection.port = rinfo.port; // do know if port can change when behind routers - investigate
			connection._recvPacket(packet);
			return;
		}

		if (packet.id !== PACKET_SYN) return;

		connection = new Connection(rinfo.port, rinfo.address, socket, packet);
		connections[rinfo.address+':'+connection.recvId] = connection;
		connection.on('close', function() {
			delete connections[rinfo.address+':'+connection.recvId];
		});
		self.emit('connection', connection);
	});

	if (onlistening) this.on('listening', onlistening);
};

exports.createServer = function(onconnection) {
	var server = new Server();
	if (onconnection) server.on('connection', onconnection);
	return server;
};

exports.connect = function(port, host) {
	var socket = dgram.createSocket('udp4');
	var conn = new Connection(port, host || 'localhost', socket, null);

	socket.on('message', function(message) {
		if (message.length < MIN_PACKET_SIZE) return;
		conn._recvPacket(bufferToPacket(message));
	});

	return conn;
};