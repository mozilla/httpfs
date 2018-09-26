#!/usr/bin/env node
const fs = require('fs')
const url = require('url')
const program = require('commander')
const fuse = require('fuse-bindings')
const Agent = require('agentkeepalive')
const filesizeParser = require('filesize-parser')
const BufferSerializer = require('buffer-serializer')

var serializer = new BufferSerializer()
var serviceUrl = url.parse('http://localhost:3000')
var mountPath
var quiet
var certificate
var http
var agent
var timeout
var calls = []
var running = true
var attrcache
var cache
var blocksize = 0
var nocache

program
    .version('0.0.1')
    .option('-q, --quiet')
    .option('-t, --timeout <seconds>')
    .option('--cache')
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
            attrcache = {}
        }
        if (options.cache) {
            cache = []
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

function shouldCache(p) {
    return cache && !(nocache && nocache.test(p))
}

function createDescriptor(p) {
    return shouldCache(p) ? createCache(p) : 0
}

function isCached(fd) {
    return fd > 0
}

function createCache(p) {
    for(let i = 1; i <= cache.length + 1; i++) {
        if (!cache[i]) {
            cache[i] = {
                p: p,
                write: {
                    off: 0,
                    pos: 0,
                    blocks: []
                },
                read: {
                    off: 0,
                    block: null
                }
            }
            return i
        }
    }
}

function readFromCache(fd, off, len, buf, cb) {
    let file = cache[fd]
    let rc = file.read
    if (rc.block && off >= rc.off && off + len <= rc.off + rc.block.length) {
        let boff = off - rc.off
        rc.block.copy(buf, 0, boff, boff + len)
        cb(len)
    } else {
        performP('read', (code, resultBuffer) => {
            if (code >= 0 && resultBuffer) {
                rc.off = off
                rc.block = Buffer.from(resultBuffer)
                let elen = Math.min(len, rc.block.length)
                rc.block.copy(buf, 0, 0, elen)
                cb(elen)
            } else {
                cb(code < 0 ? code : -70)
            }
        }, file.p, off, Math.max(len, blocksize))
    }
}

function flushCacheFile(file, cb) {
    let wc = file.write
    if (wc.blocks.length > 0) {
        let off = wc.off
        wc.off = 0
        wc.pos = 0
        let buf = Buffer.concat(wc.blocks)
        wc.blocks = []
        performI('write', len => len < 0 ? cb(len) : cb(0), file.p, buf, off)
    } else {
        cb(0)
    }
}

function flushCacheDescriptor(fd, cb) {
    let file = cache[fd]
    flushCacheFile(file, cb)
}

function writeToCache(fd, off, buf, cb) {
    buf = Buffer.from(buf)
    let file = cache[fd]
    let wc = file.write
    if (off == wc.pos && (wc.pos - wc.off + buf.length) <= blocksize) {
        wc.blocks.push(buf)
        wc.pos += buf.length
        cb(buf.length)
    } else {
        flushCacheFile(file, code => {
            if (buf.length > blocksize) {
                performI('write', cb, file.p, buf, off)
            } else {
                wc.blocks.push(buf)
                wc.off = off
                wc.pos = off + buf.length
                cb(buf.length)
            }
        })
    }
}

function releaseCache(fd, cb) {
    let file = cache[fd]
    delete cache[fd]
    flushCacheFile(file, cb)
}

fuse.mount(mountPath, {
    getattr: (p, cb) => {
        let cached = getAttrCache(p)
        if (cached) {
            cb(cached.code, cached.stat)
        } else {
            performP('getattr',  (code, stat) => { 
                setAttrCache(p, { code: code, stat: stat })
                cb(code, stat)
            }, p)
        }
    },
    open: (p, flags, cb) => {
        let fd = createDescriptor(p)
        cb(0, fd)
    },
    create: (p, mode, cb) => {
        performI('create', code => code < 0 ? cb(code) : cb(0, createDescriptor(p)), p, mode)
    },
    read: (p, fd, buf, len, off, cb) => {
        if (isCached(fd)) {
            readFromCache(fd, off, len, buf, cb)
        } else {
            performP('read', (code, resultBuffer) => {
                if (code >= 0 && resultBuffer) {
                    resultBuffer.copy(buf)
                    cb(resultBuffer.length)
                } else {
                    cb(code < 0 ? code : -70)
                }
            }, p, off, len)
        }
    },
    write: (p, fd, buf, len, off, cb) => {
        let abuf = buf.length == len ? buf : buf.slice(0, len)
        if (isCached(fd)) {
            writeToCache(fd, off, abuf, cb)
        } else {
            performI('write', cb, p, abuf, off)
        }
    },
    flush: (p, fd, cb) => {
        isCached(fd) ? flushCacheDescriptor(fd, cb) : cb(0)
    },
    release: (p, fd, cb) => {
        isCached(fd) ? releaseCache(fd, cb) : cb(0)
    },
    readdir:  (p, cb)                    => performP('readdir',  cb, p),
    truncate: (p, size, cb)              => performI('truncate', cb, p, size),
    readlink: (p, cb)                    => performP('readlink', cb, p),
    chown:    (p, uid, gid, cb)          => performI('chown',    cb, p, uid, gid),
    chmod:    (p, mode, cb)              => performI('chmod',    cb, p, mode),
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