#!/bin/sh
# The backup box's side of ops/backup.sh: the forced command of the node box's backup key, so that key can only add files
# under DIR (rrsync -wo -no-del: no reads, no deletes, no shell), and after each upload the newest KEEP dumps stay.
# Install (as root on the backup box; the user owns nothing else):
#   useradd --system --create-home --home-dir /var/lib/rhbackup --shell /bin/sh rhbackup
#   install -d -o rhbackup -g <your user> -m 2750 /srv/rhnode-backups   # group-readable, so your user can pull a dump
#   install -m 755 ops/backup-recv.sh /usr/local/bin/rhnode-backup-recv
#   ~rhbackup/.ssh/authorized_keys:  command="/usr/local/bin/rhnode-backup-recv /srv/rhnode-backups 7",restrict <the node's key>
# The home (and its .ssh) must stay outside DIR: the key can write anything inside DIR.
set -eu
DIR=${1:?dir}; KEEP=${2:-7}
rrsync -wo -no-del "$DIR"
cd "$DIR" && ls -1d 20* 2>/dev/null | head -n -"$KEEP" | xargs -r rm -rf
