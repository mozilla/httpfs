#!/usr/bin/env node
const fuse = require('fuse-bindings')
const stream = require('stream')
const unirest = require('unirest')
const program = require('commander')
const BufferSerializer = require('buffer-serializer')

const operations = 'init access statfs getattr fgetattr flush fsync readdir truncate ftruncate readlink chown chmod mknod setxattr getxattr listxattr removexattr open opendir read write release releasedir create utimens unlink rename link symlink mkdir rmdir destroy'.split(' ')

var serviceUrl
var mountPath
var serializer = new BufferSerializer()

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

function perform(operation, args) {
    let cb = args.pop()
    switch (operation) {
        case 'setxattr':    rargs = [args[0], args[1], args[2].slice(args[4], args[3] + args[4]), args[5]]; break
        case 'getxattr':    rargs = [args[0], args[1]]; break
        case 'listxattr':   rargs = [args[0]]; break
        case 'read':        rargs = [args[0], args[1], args[3], args[4]]; break
        case 'write':       rargs = [args[0], args[1], args[2].slice(0, args[3]), args[4]]; break
        default:            rargs = args
    }
    console.log('OP: ' + operation, rargs, cb)
    unirest
        .post(serviceUrl)
        .encoding(null)
        .send(serializer.toBuffer({ operation: operation, args: rargs }))
        .end(res => {
            result = serializer.fromBuffer(res.body)
            console.log(JSON.stringify(result))
            switch (operation) {
                case 'getxattr':
                    if (result[0] >= 0) {
                        args[2].copy(result[1], args[4], 0, Math.min(args[3], result[1].length))
                        result = [result[0]]
                    }
                    break
                case 'listxattr':
                    if (result[0] >= 0) {
                        let buf = Buffer.from(result[1].join('\0') = '\0')
                        if (args[3] === 0) {
                            result = [buf.length]
                        } else if (buf.length > args[3]) {
                            result = [fuse.ERANGE]
                        } else {
                            args[2].copy(buf)
                            result = [buf.length]
                        }
                    }
                    break
                case 'read':
                    if (result[0] >= 0) {
                        result[1].copy(args[2])
                        result = [result[1].length]
                    }
                    break
            }
            cb.apply(null, result)
        })
}

fuse.mount(mountPath, new Proxy({}, {
    ownKeys: (target, key) => operations,
    getOwnPropertyDescriptor: (target, key) => operations.includes(key) ? { value: (...args) => perform(key, args), enumerable: true, configurable: true } : undefined,
    get: (target, key) => (...args) => perform(key, args)
}), function (err) {
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