#!/bin/bash
for i in $(seq 1 30); do
    [ -d /mnt/c/Windows ] && exit 0
    sleep 2
done
echo "Timed out waiting for /mnt/c" >&2
exit 1
