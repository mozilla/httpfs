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
var attrcache = true
var blocksize = 0
var nocache
var cache = {}
var cacheTop = []

program
    .version('0.0.1')
    .option('-q, --quiet')
    .option('-t, --timeout <seconds>')
    .option('--attrcache')
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
        blocksize = options.blocksize ? filesizeParser(options.blocksize) : 0
        timeout = options.timeout || 60 * 60
        quiet = !!options.quiet
        attrcache = !!options.attrcache
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

function finishCall(call, ...args) {
    removeCall(call)
    call.callback(...args)
}

function flushFile(filepath, cb) {
    let cached = cache[filepath]
    if (cached && cached.block && cached.block.length > 0) {
        let b = Buffer.concat(cached.block)
        perform('write', filepath, 0, b, b.length, cached.position, cb)
        cached.block = []
        cached.position += b.length
    }
}

function sendRequest(call, retries) {
    let args = call.args
    let rargs = args
    switch (call.operation) {
        case 'getattr':     
            if (attrcache && cached && cached.stat) {
                return finishCall(0, cached.stat)
            }
            break
        case 'read':  
            [filepath, fd, buffer, length, position] = args   
            if (blocksize > 0 && !buffer.isBuffer && (!nocache || !nocache.test(filepath))) {
                let cached = cache[filepath]
                if (cached && 
                    !cached.out &&
                    cached.block && 
                    cached.position <= position && 
                    cached.position + cached.block.length >= position + length) {
                    let sourceStart = position - cached.position
                    cached.block.copy(buffer, 0, sourceStart, sourceStart + length)
                    finishCall(call, 0, length)
                } else if (cached && cached.out && cached.block) {
                    flushFile(filepath, () => sendRequest(call, retries))
                } else if (cached && !cached.out && !cached.block) {
                    call.timer = setTimeout(() => sendRequest(call, retries - 1), 1000)
                } else {
                    cached = cache[filepath] = cached || {}
                    cached.position = position
                    cached.out = false
                    cached.block = null
                    let index = cacheTop.indexOf(cached)
                    if (index >= 0) {
                        cacheTop.splice(index)
                    }
                    cacheTop.push(cached)
                    if (cacheTop.length > 10) {
                        let oldest = cacheTop.shift()
                        if (oldest.out && oldest.block) {
                            flushFile(filepath, () => {})
                        }
                    }
                    perform('read', filepath, 0, cached, Math.max(length, blocksize), position, l => {
                        if (l < 0) {
                            finishCall(call, l)
                        } else if (l < length) {
                            let actualLength = Math.min(l, length)
                            cached.block.copy(buffer, 0, 0, actualLength)
                            finishCall(call, actualLength)
                        } else {
                            sendRequest(call, retries)
                        }
                    })
                }
                return
            }
            rargs = [filepath, fd, length, position]
            break
        case 'write':
            [filepath, fd, buffer, length, position] = args  
            buffer = buffer.length == length ? buffer : buffer.slice(0, length) 
            if (blocksize > 0 && (!nocache || !nocache.test(filepath))) {
                cached = cache[filepath] = cached || {}
                if (cached.out) {
                    let blockLength = cached.block.reduce((l, b) => l + b, 0)
                    let cursor = cached.position + blockLength
                    if (position == cursor || cursor == 0) {
                        cached.block.push(buffer)
                        cached.position = position
                    } else {
                        flushFile(filepath, () => sendRequest(call, retries))
                    }
                } else {
                    cached.out = true
                    cached.block = [buffer]
                    cached.position = position
                }
                return
            }
            rargs = [filepath, fd, buffer, position]
            break
        case 'link':        rargs = [args[1], args[0]]; break
        case 'symlink':     rargs = [args[1], args[0]]; break  
    }
    let buffer = serializer.toBuffer({ operation: call.operation, args: rargs })
    options = {
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
            result = serializer.fromBuffer(Buffer.concat(chunks))
            switch (call.operation) {
                case 'read':
                    if (result[0] >= 0) {
                        if (args[2].isBuffer) {
                            result[1].copy(args[2])
                        } else {
                            args[2].block = result[1]
                        }
                        result = [result[1].length]
                    }
                    break
            }
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

function perform(operation, ...args) {
    if (operation == 'options') {
        return ['nonempty']
    } else if (running) {
        let call = { operation: operation, args: args, callback: args.pop() }
        calls.push(call)
        sendRequest(call, timeout)
    } else {
        callback(-70)
    }
}

fuse.mount(mountPath, new Proxy({}, {
    ownKeys: (target, key) => operations,
    getOwnPropertyDescriptor: (target, key) => operations.includes(key) ? { value: (...args) => perform(key, ...args), enumerable: true, configurable: true } : undefined,
    get: (target, key) => (...args) => perform(key, ...args)
}), function (err) {
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