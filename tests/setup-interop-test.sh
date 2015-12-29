#!/bin/sh

# TODO clean first

mkdir -p tests/utp
cd tests/utp

wget https://github.com/bittorrent/libutp/archive/master.zip 
unzip master.zip
cd libutp-master
make
cp ucat-static /usr/local/bin/ucat-static
