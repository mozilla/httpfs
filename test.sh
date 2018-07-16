#!/usr/bin/env bash
mkdir mnt
httpfs http://localhost:3000 mnt &
sleep 1
ls -la mnt
sleep 1
kill $(jobs -p)
sleep 1
rm -r mnt