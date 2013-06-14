var dgram = require('dgram');
var cyclist = require('cyclist');
var EventEmitter = require('events').EventEmitter;
var Duplex = require('stream').Duplex;

var noop = function() {};

var EXTENSION = 0;
var VERSION   = 1;
var UINT16    = 0xffff;

var ST_MASK  = 0xf << 4;
var ST_DATA  = 0 << 4;
var ST_FIN   = 1 << 4;
var ST_STATE = 2 << 4;
var ST_RESET = 3 << 4;
var ST_SYN   = 4 << 4;

var uint32 = function(n) {
	return n >>> 0;
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
	packet.id = buffer[0] & ST_MASK;
	packet.connection = buffer.readUInt16BE(2);
	packet.time = buffer.readUInt32BE(4);
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
	buffer.writeUInt32BE(timestamp(), 4);
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

	this._outgoing = cyclist(64);
	this._incoming = cyclist(64);
	this._inflight = 0;
	this._inflightTimeout = 500000;
	this._stack = [];

	if (syn) {
		this.seq = (Math.random() * UINT16) | 0;
		this.ack = syn.seq;
		this.recvId = syn.connection + 1;
		this.sendId = syn.connection;

		this._write = this._writeData;
		this._recvPacket = this._onconnected;
		this._sendAck();
	} else {
		this.seq = 1;
		this.ack = 1;
		this.recvId = 0; // tmp value for v8
		this.sendId = 0; // tmp value for v8

		this._write = this._writeBuffer;
		this._recvPacket = this._onsynsent;

		socket.bind(); // we are iniating this connection so we own the socket
		socket.on('listening', function() {
			self.recvId = socket.address().port; // using the port gives us system wide clash protection
			self.sendId = self.recvId + 1;
			self._sendPacket(ST_SYN, self.recvId, null);
		});
	}

	setInterval(this._checkTimeout.bind(this), 500);
};

Connection.prototype.__proto__ = Duplex.prototype;

// stream interface

Connection.prototype._read = noop;

Connection.prototype._writeBuffer = function(data, enc, callback) {
	this._stack.push(arguments);
};

Connection.prototype._writeData = function(data, enc, callback) { // TODO: check size against MTU
	this._sendPacket(ST_DATA, this.sendId, data, callback);
};

// utp stuff

Connection.prototype._recvAck = function(seq) { // when we receive an ack
	var prevAcked = this.seq - this._inflight - 1; // last packet that was acked
	var acks = seq - prevAcked;

	for (var i = 0; i < acks; i++) {
		this._inflight--;
		var packet = this._outgoing.del(prevAcked+i+1);
		if (packet && packet.callback) packet.callback();
	}
};

Connection.prototype._sendAck = function() {
	this._send(this._packet(ST_STATE, this.sendId, null, null));
};

Connection.prototype._sendPacket = function(id, connection, data, callback) {
	var packet = this._packet(id, connection, data, callback);
	this._outgoing.put(packet.seq, packet);
	this._send(packet);
};

Connection.prototype._send = function(packet) {
	var message = packetToBuffer(packet);
	this._inflight++;
	this.socket.send(message, 0, message.length, this.port, this.host);
};

Connection.prototype._checkTimeout = function() {
	for (var i = 0; i < this._inflight; i++) {
		var packet = this._outgoing.get(this.seq - i - 1);
		if (!packet) continue;
		var now = timestamp();
		if (uint32(now - packet.timesent) < this._inflightTimeout) continue;
		packet.timesent = now;
		this._send(packet);

		console.error('[DEBUG] resend '+packet.seq+' '+packet.id);
	}
};

Connection.prototype._packet = function(id, connection, data, callback) {
	var now = timestamp();
	return {
		id: id,
		connection: connection,
		timediff: 0,
		timestamp: now,
		timesent: now,
		window: 242424,
		seq: this.seq++,
		ack: this.ack,
		data: data,
		callback: callback
	};
};

// connection state handlers

Connection.prototype._onsynsent = function(packet) { // when we receive a packet
	if (packet.id !== ST_STATE) return this._incoming.put(packet.seq, packet);
	this.ack = packet.seq;
	this._seqAcked = packet.ack-1;
	this._write = this._writeData;
	this._recvPacket = this._onconnected;
	this._recvAck(packet.ack);
	this.emit('connect');
	while (this._stack.length) this._writeData.apply(this, this._stack.shift());
	packet = this._incoming.del(this.ack+1);
	if (packet) this._recvPacket(packet);
};

Connection.prototype._onconnected = function(packet) {
	if (packet.seq <= this.ack) return this._sendAck();
	this._incoming.put(packet.seq, packet);
	var shouldAck = false;
	while (packet = this._incoming.del(this.ack+1)) {
		this.ack++;

		if (packet.id === ST_DATA) {
			shouldAck = true;
			this.push(packet.data);
		}

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
		socket.bind(port)
		return this.listen(socket);
	}

	var self = this;
	var connections = {};

	this.socket = socket;

	socket.on('listening', function() {
		self.emit('listening');
	});

	socket.on('message', function(message, rinfo) {
		var packet = bufferToPacket(message);
		var prefix = rinfo.address+':';
		var conn = connections[prefix+packet.connection];

		if (conn) {
			conn.port = rinfo.port; // do know if port can change when behind routers - investigate
			conn._recvPacket(packet);
			return;
		}

		if (packet.id !== ST_SYN) return;

		conn = new Connection(rinfo.port, rinfo.address, socket, packet);
		connections[prefix+conn.recvId] = conn;
		self.emit('connection', conn);
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
		conn._recvPacket(bufferToPacket(message));
	});

	return conn;
};