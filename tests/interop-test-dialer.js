/* globals describe, it */

var utp = require('../src')
var expect = require('chai').expect
var nexpect = require('nexpect')

var ucat = 'ucat-static'
console.log(ucat)

describe('dialer', function () {
  it('get help menu', function (done) {
    nexpect.spawn(ucat, ['-h'], { stream: 'stderr' })
     .run(function (err, output, exitcode) {
       // ucat-static exists with exit code 1 when prints help menu
       // and prints the output to stderr
       var help = [
         'Usage:',
         '    ucat-static [options] <destination-IP> <destination-port>',
         '    ucat-static [options] -l -p <listening-port>',
         'Options:',
         '    -h          Help',
         '    -d          Debug mode; use multiple times to increase verbosity.',
         '    -l          Listen mode',
         '    -p <port>   Local port',
         '    -s <IP>     Source IP',
         '    -B <size>   Buffer size',
         '    -n          Don\'t resolve hostnames']
       expect(help).to.deep.equal(output)
       expect(exitcode).to.equal(1)
       expect(err).to.not.exist
       done()
     })
  })
})
