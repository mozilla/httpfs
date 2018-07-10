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

function backend (cb, operation, args) {
    request.post({
        url: serviceUrl,
        method: 'POST',
        json: args
    }, (err, res, body) => {
        cb.apply(null, body)
    })
}

fuse.mount(mountPath, {
    init:        (cb)                                               => backend('init',          cb, {}),
    access:      (path, mode, cb)                                   => backend('access',        cb, { path: path, mode: mode }),
    statfs:      (path, cb)                                         => backend('statfs',        cb, { path: path }),
    getattr:     (path, cb)                                         => backend('getattr',       cb, { path: path }),
    fgetattr:    (path, fd, cb)                                     => backend('fgetattr',      cb, { path: path, fd: fd }),
    flush:       (path, fd, cb)                                     => backend('flush',         cb, { path: path, fd: fd }),
    fsync:       (path, fd, datasync, cb)                           => backend('fsync',         cb, { path: path, fd: fd, datasync: datasync }),
    readdir:     (path, cb)                                         => backend('readdir',       cb, { path: path }),
    truncate:    (path, size, cb)                                   => backend('truncate',      cb, { path: path, size: size }),
    ftruncate:   (path, fd, size, cb)                               => backend('ftruncate',     cb, { path: path, fd: fd, size: size }),
    readlink:    (path, cb)                                         => backend('readlink',      cb, { path: path }),
    chown:       (path, uid, gid, cb)                               => backend('chown',         cb, { path: path, uid: uid, gid: gid }),
    chmod:       (path, mode, cb)                                   => backend('chmod',         cb, { path: path, mode: mode }),
    mknod:       (path, mode, dev, cb)                              => backend('mknod',         cb, { path: path, mode: mode, dev: dev }),
    setxattr:    (path, name, buffer, length, offset, flags, cb)    => backend('setxattr',      cb, { path: path, name: name, buffer: buffer, length: length, offset: offset, flags: flags }),
    getxattr:    (path, name, buffer, length, offset, cb)           => backend('getxattr',      cb, { path: path, name: name, buffer: buffer, length: length, offset: offset }),
    listxattr:   (path, buffer, length, cb)                         => backend('listxattr',     cb, { path: path, buffer: buffer, length: length }),
    removexattr: (path, name, cb)                                   => backend('removexattr',   cb, { path: path, name: name }),
    open:        (path, flags, cb)                                  => backend('opendir',       cb, { path: path, flags: flags }),
    opendir:     (path, flags, cb)                                  => backend('init',          cb, { path: path, flags: flags }),
    read:        (path, fd, buffer, length, offset, cb)             => backend('read',          cb, { path: path, fd: fd, buffer: buffer, length: length, offset: offset }),
    write:       (path, fd, buffer, length, offset, cb)             => backend('write',         cb, { path: path, fd: fd, buffer: buffer, length: length, offset: offset }),
    release:     (path, fd, cb)                                     => backend('release',       cb, { path: path, fd: fd }),
    releasedir:  (path, fd, cb)                                     => backend('releasedir',    cb, { path: path, fd: fd }),
    create:      (path, mode, cb)                                   => backend('create',        cb, { path: path, mode: mode }),
    utimens:     (path, atime, mtime, cb)                           => backend('utimens',       cb, { path: path, atime: atime, mtime: mtime }),
    unlink:      (path, cb)                                         => backend('unlink',        cb, { path: path }),
    rename:      (src, dest, cb)                                    => backend('rename',        cb, { src: src, dest: dest }),
    link:        (src, dest, cb)                                    => backend('link',          cb, { src: src, dest: dest }),
    symlink:     (src, dest, cb)                                    => backend('symlink',       cb, { src: src, dest: dest }),
    mkdir:       (path, mode, cb)                                   => backend('mkdir',         cb, { path: path, mode: mode }),
    rmdir:       (path, cb)                                         => backend('rmdir',         cb, { path: path }),
    destroy:     (cb)                                               => backend('destroy',       cb, {})
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