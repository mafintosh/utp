var utp = require('..')

var server = utp.createServer(function (socket) {
  console.log('new connection!')
  socket.pipe(process.stdout)
})

server.listen(9090, function () {
  console.log('uTP server is listening on port 9090')
})
