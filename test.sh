#!/usr/bin/env bash
mkdir mnt
httpfs http://example.com mnt &
sleep 1
ls -la mnt
kill $(jobs -p)
sleep 1
rm -r mnt