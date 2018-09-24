#!/usr/bin/env node
const fs = require('fs')
const url = require('url')
const program = require('commander')
const fuse = require('fuse-bindings')
const Agent = require('agentkeepalive')
const filesizeParser = require('filesize-parser')
const BufferSerializer = require('buffer-serializer')

const operations = 'options getattr readdir readlink truncate chown chmod read write create utimens unlink rename link symlink mkdir rmdir'.split(' ')

var serializer = new BufferSerializer()
var serviceUrl
var mountPath
var quiet
var certificate
var http
var agent
var timeout
var calls = []
var running = true
var attrcache
var readcache
var writecache
var blocksize = 0
var nocache

program
    .version('0.0.1')
    .option('-q, --quiet')
    .option('-t, --timeout <seconds>')
    .option('--attrcache')
    .option('--readcache')
    .option('--writecache')
    .option('--blocksize <bytes>')
    .option('--nocache <regex>')
    .option('--certraw <certificate>')
    .option('--certfile <certificate-filename>')
    .arguments('<url> <mountpath>')
    .action((surl, mountpath, options) => {
        serviceUrl = url.parse(surl)
        mountPath = mountpath
        if (options.certraw) {
            certificate = options.certraw
        } else if (options.certfile) {
            certificate = fs.readFileSync(options.certfile)
        }
        if (options.nocache) {
            nocache = new RegExp(options.nocache)
        }
        if (options.attrcache) {
            attrcache = []
        }
        if (options.readcache) {
            readcache = []
        }
        if (options.writecache) {
            writecache = []
        }
        blocksize = options.blocksize ? filesizeParser(options.blocksize) : 1024 * 1024
        timeout = options.timeout || 60 * 60
        quiet = !!options.quiet
    })
    .parse(process.argv)

if (!serviceUrl) {
    program.help()
}

if (serviceUrl.protocol == 'https:') {
    http = require('https')
    agent = new Agent.HttpsAgent()
} else {
    http = require('http')
    agent = new Agent()
}

function log(message) {
    if (!quiet) {
        console.log(message)
    }
}

function removeCall(call) {
    let index = calls.indexOf(call)
    if (index >= 0) {
        calls.splice(index, 1)
    }
}

function sendRequest(call, retries) {
    let buffer = serializer.toBuffer({ operation: call.operation, args: call.args })
    let options = {
        method: 'POST',
        protocol: serviceUrl.protocol,
        hostname: serviceUrl.hostname,
        path: serviceUrl.path,
        port: serviceUrl.port || (serviceUrl.protocol == 'https:' ? 443 : 80),
        agent: agent,
        headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': buffer.length
        }
    }
    if (serviceUrl.protocol == 'https:') {
        options.ca = [certificate]
    }
    call.request = http.request(options, res => {
        let chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
            let result = serializer.fromBuffer(Buffer.concat(chunks))
            removeCall(call)
            call.callback.apply(null, result)
        })
    })
    call.request.on('error', err => {
        if (call.callback) {
            if (retries > 0) {
                delete call.request
                call.timer = setTimeout(() => sendRequest(call, retries - 1), 1000)
            } else {
                removeCall(call)
                call.callback(typeof err.errno === 'number' ? err.errno : -70)
            }
        }
    })
    call.request.end(buffer)
}

function performP(operation, callback, p, ...args) {
    if (running) {
        let call = { operation: operation, callback: callback, args: [p, ...args] }
        calls.push(call)
        sendRequest(call, timeout)
    } else {
        callback(-70)
    }
}

function performI(operation, callback, p, ...args) {
    setAttrCache(p)
    performP(operation, callback, p, ...args)
}

function getAttrCache(p) {
    return attrcache && attrcache[p]
}

function setAttrCache(p, stat) {
    if (attrcache) {
        if (stat) {
            attrcache[p] = stat
        } else if (attrcache[p]) {
            delete attrcache[p]
        }
    }
}

fuse.mount(mountPath, {
    getattr:  (p, cb)               => {
        let cached = getAttrCache(p)
        if (cached) {
            cb(0, cached)
        } else {
            performP('getattr',  (code, stat) => { 
                setAttrCache(p, stat)
                cb(code, stat)
            }, p)
        }
    },
    readdir:  (p, cb)                    => performP('readdir',  cb, p),
    truncate: (p, size, cb)              => performI('truncate', cb, p, size),
    readlink: (p, cb)                    => performP('readlink', cb, p),
    chown:    (p, uid, gid, cb)          => performI('chown',    cb, p, uid, gid),
    chmod:    (p, mode, cb)              => performI('chmod',    cb, p, mode),
    read:     (p, fd, buf, len, off, cb) => {
        performP('read', (code, resultBuffer) => {
            if (code >= 0 && resultBuffer) {
                resultBuffer.copy(buf)
                cb(resultBuffer.length)
            } else {
                cb(code < 0 ? code : -70)
            }
        }, p, off, len)
    },
    write:    (p, fd, buf, len, off, cb) => {
        performI('write', cb, p, buf.length == len ? buf : buf.slice(0, len), off)
    },
    create:   (p, mode, cb)              => performI('create',   cb, p, mode),
    utimens:  (p, atime, mtime, cb)      => performI('utimens',  cb, p, atime, mtime),
    unlink:   (p, cb)                    => performI('unlink',   cb, p),
    rename:   (p, dest, cb)              => performI('rename',   cb, p, dest),
    link:     (dest, p, cb)              => performP('link',     cb, p, dest),
    symlink:  (dest, p, cb)              => performP('symlink',  cb, p, dest),
    mkdir:    (p, mode, cb)              => performP('mkdir',    cb, p, mode),
    rmdir:    (p, cb)                    => performI('rmdir',    cb, p)
}, err => {
    if (err) throw err
    log('filesystem mounted on ' + mountPath)
})

var unmountCounter = 10
function unmount () {
    if (running) {
        running = false
        for (let call of calls) {
            call.callback(-70)
            delete call.callback
            if (call.request) {
                call.request.abort()
            }
            if (call.timer) {
                clearTimeout(call.timer)
            }
        }
    }
    fuse.unmount(mountPath, function (err) {
        if (err) {
            unmountCounter--
            if (unmountCounter > 0) {
                setTimeout(unmount, 100)
            } else {
                console.error('filesystem at ' + mountPath + ' not unmounted')
            }
        } else {
            log('filesystem at ' + mountPath + ' unmounted')
        }
    })
}

process.on('SIGINT', unmount)
process.on('SIGTERM', unmount)