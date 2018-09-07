#!/usr/bin/env bash
mkdir mnt
httpfs http://localhost:3000 mnt &
while [ ! -d mnt/a ]; do sleep 0.1; done;
ls -la mnt
cat mnt/a/b.txt
cat mnt/c.txt
kill $(jobs -p)
while [ -d mnt/a ]; do sleep 0.1; done;
rm -r mnt