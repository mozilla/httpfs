#!/usr/bin/env node
const fs = require('fs')
const program = require('commander')
const fuse = require('fuse-bindings')
const Agent = require('agentkeepalive')
const BufferSerializer = require('buffer-serializer')

const operations = 'getattr readdir truncate chown chmod read write create utimens unlink rename mkdir rmdir'.split(' ')

var serializer = new BufferSerializer()
var serviceUrl
var mountPath
var certificate
var request
var agent
var createOptions
var timeout = 60 * 60
var callcounter = 0
var calls = []
var running = true

program
    .version('0.0.1')
    .option('-t, --timeout <seconds>')
    .option('-cr, --certraw <certificate>')
    .option('-cf, --certfile <certificate-filename>')
    .arguments('<url> <mountpath>')
    .action((url, mountpath, options) => {
        serviceUrl = new URL(url)
        mountPath = mountpath
        if (options.certraw) {
            certificate = options.certraw
        } else if (options.certfile) {
            certificate = fs.readFileSync(options.certfile)
        }
        if (options.timeout) {
            timeout = options.timeout
        }
    })
    .parse(process.argv)

if (!serviceUrl) {
    program.help()
}

if (serviceUrl.protocol === 'https:') {
    request = require('https').request
    agent = new Agent.HttpsAgent()
    createOptions = () => ({
        agent: agent,
        ca: [certificate]
    })
} else {
    request = require('http').request
    agent = new Agent()
    createOptions = () => ({
        agent: agent
    })
}

function removeCall(call) {
    let index = calls.indexOf(call)
    if (index >= 0) {
        calls.splice(index, 1)
    }
}

function sendRequest(call, retries) {
    let args = call.args
    let rargs
    switch (call.operation) {
        case 'read':        rargs = [args[0], args[1], args[3], args[4]]; break
        case 'write':       rargs = [args[0], args[1], args[2].slice(0, args[3]), args[4]]; break
        default:            rargs = args
    }
    let buffer = serializer.toBuffer({ operation: call.operation, args: rargs })
    let options = createOptions()
    options.headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': buffer.length
    }
    options.method = 'POST'
    call.request = request(serviceUrl, options, res => {
        let chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
            result = serializer.fromBuffer(Buffer.concat(chunks))
            switch (call.operation) {
                case 'read':
                    if (result[0] >= 0) {
                        result[1].copy(args[2])
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

function perform(operation, args) {
    let callback = args.pop()
    if (running) {
        let call = { id: callcounter++, operation: operation, args: args, callback: callback }
        calls.push(call)
        sendRequest(call, timeout)
    } else {
        callback(-70)
    }
}

fuse.mount(mountPath, new Proxy({}, {
    ownKeys: (target, key) => operations,
    getOwnPropertyDescriptor: (target, key) => operations.includes(key) ? { value: (...args) => perform(key, args), enumerable: true, configurable: true } : undefined,
    get: (target, key) => (...args) => perform(key, args)
}), function (err) {
    if (err) throw err
    console.log('filesystem mounted on ' + mountPath)
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
                console.log('filesystem at ' + mountPath + ' not unmounted')
            }
        } else {
            console.log('filesystem at ' + mountPath + ' unmounted')
        }
    })
}

process.on('SIGINT', unmount)
process.on('SIGTERM', unmount)