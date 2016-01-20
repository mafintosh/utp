exports.connect = connect
exports.createServer = createServer

var timestamp = createTimestamp()

function createTimestamp () {
  var offset = process.hrtime()
  var then = Date.now() * 1000
  var arr = new Uint32Array(1)

  return function() {
    var diff = process.hrtime(offset)
    var time = arr[0] = then + 1000000 * diff[0] + Math.floor((diff[1] / 1000))
    return time
  }
}

function connect () {
  throw new Error('not yet implemented')
}

function createServer () {
  throw new Error('not yet implemented')
}
