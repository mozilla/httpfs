#!/usr/bin/env node
const fs = require('fs')
const program = require('commander')
const fuse = require('fuse-bindings')
const Agent = require('agentkeepalive')
const childProc = require('child_process')
const BufferSerializer = require('buffer-serializer')

const operations = 'getattr readdir truncate chown chmod read write create utimens unlink rename mkdir rmdir'.split(' ')

var serializer = new BufferSerializer()
var serviceUrl
var mountPath
var certificate
var request
var agent
var createOptions

program
    .version('0.0.1')
    .option('-c, --cert <certificate>')
    .option('-cf, --certfile <certificate-filename>')
    .arguments('<url> <mountpath>')
    .action((url, mountpath, options) => {
        serviceUrl = new URL(url)
        mountPath = mountpath
        if (options.cert) {
            certificate = options.cert
        } else if (options.certfile) {
            certificate = fs.readFileSync(options.certfile)
        }
    })
    .parse(process.argv)

if (!serviceUrl) {
    program.help()
}

if (serviceUrl.protocol === 'https:') {
    request = require('https').request
    agent = new Agent.AgentHttps()
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

function _perform(operation, args, retries) {
    let cb = args[args.length - 1]
    switch (operation) {
        case 'read':        rargs = [args[0], args[1], args[3], args[4]]; break
        case 'write':       rargs = [args[0], args[1], args[2].slice(0, args[3]), args[4]]; break
        default:            rargs = args.slice(0, -1)
    }
    let buffer = serializer.toBuffer({ operation: operation, args: rargs })
    let options = createOptions()
    options.headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': buffer.length
    }
    let req = request(serviceUrl, options, res => {
        let chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
            result = serializer.fromBuffer(Buffer.concat(chunks))
            switch (operation) {
                case 'read':
                    if (result[0] >= 0) {
                        result[1].copy(args[2])
                        result = [result[1].length]
                    }
                    break
            }
            cb.apply(null, result)
        })
    })
    req.on('error', err => {
        cb(-70)
        /*
        if (retries > 0) {
            retries--
            setTimeout(() => _perform(operation, args, retries), 100)
        } else {
            console.error(err)
            process.exit(1)
        }
        */
    })
    req.write(buffer)
    req.end()
}

function perform(operation, args) {
    _perform(operation, args, 50)
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