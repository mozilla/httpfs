#!/usr/bin/env node
const fuse = require('fuse-bindings')
const request = require('request')
const program = require('commander')

var serviceUrl
var mountPath

program
    .version('0.0.1')
    .arguments('<url> <mountpath>')
    .action((url, mountpath) => {
        serviceUrl = url
        mountPath = mountpath
    })
    .parse(process.argv)

if (!serviceUrl) {
    program.help()
}

fuse.mount(mountPath, {
    readdir: function (path, cb) {
        console.log('readdir(%s)', path)
        if (path === '/') return cb(0, ['test'])
        cb(0)
    },
    getattr: function (path, cb) {
        console.log('getattr(%s)', path)
        if (path === '/') {
            cb(0, {
                mtime: new Date(),
                atime: new Date(),
                ctime: new Date(),
                nlink: 1,
                size: 100,
                mode: 16877,
                uid: process.getuid ? process.getuid() : 0,
                gid: process.getgid ? process.getgid() : 0
            })
            return
        }

        if (path === '/test') {
            cb(0, {
                mtime: new Date(),
                atime: new Date(),
                ctime: new Date(),
                nlink: 1,
                size: 12,
                mode: 33188,
                uid: process.getuid ? process.getuid() : 0,
                gid: process.getgid ? process.getgid() : 0
            })
            return
        }

        cb(fuse.ENOENT)
    },
    open: function (path, flags, cb) {
        console.log('open(%s, %d)', path, flags)
        cb(0, 42) // 42 is an fd
    },
    read: function (path, fd, buf, len, pos, cb) {
        console.log('read(%s, %d, %d, %d)', path, fd, len, pos)
        var str = 'hello world\n'.slice(pos)
        if (!str) return cb(0)
        buf.write(str)
        return cb(str.length)
    }
}, function (err) {
    if (err) throw err
    console.log('filesystem mounted on ' + mountPath)
})

function unmount () {
    fuse.unmount(mountPath, function (err) {
        if (err) {
            console.log('filesystem at ' + mountPath + ' not unmounted', err)
        } else {
            console.log('filesystem at ' + mountPath + ' unmounted')
        }
    })
}

process.on('SIGINT', unmount)
process.on('SIGTERM', unmount)