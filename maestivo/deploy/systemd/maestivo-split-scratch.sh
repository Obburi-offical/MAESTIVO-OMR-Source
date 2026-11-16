#!/usr/bin/env bash
# Uninstalled candidate. Runs only as root in the host mount namespace.
set -Eeuo pipefail
MAPPER=maestivo-split-scratch
STATE=/run/maestivo-split-scratch
STORE=/var/lib/maestivo-split-scratch-store
MOUNT=/var/lib/maestivo-omr-scratch
BYTES=671088640 # 640 MiB, encrypted with a fresh per-start random key.

private_dir() {
  local p="$1"
  [[ -d "$p" && ! -L "$p" && "$(readlink -f -- "$p")" == "$p" && "$(stat -c '%u:%a' -- "$p")" == '0:700' ]]
}

safe_stop() {
  local mapper="$1" loop="$2" device source mapped
  [[ "$mapper" == "$MAPPER" && "$loop" =~ ^/dev/loop[0-9]+$ ]] || return 1
  device=$(cryptsetup status "$mapper" | awk '$1 == "device:" {print $2}') || return 1
  [[ "$device" == "$loop" ]] || { echo 'Scratch mapper mismatch; retained for review.' >&2; return 1; }
  source=$(findmnt -n -o SOURCE --mountpoint "$MOUNT") || return 1
  mapped=$(readlink -f -- "/dev/mapper/$mapper") || return 1
  [[ "$(readlink -f -- "$source")" == "$mapped" ]] || { echo 'Scratch mount mismatch; retained for review.' >&2; return 1; }
  # Never detach an active filesystem or use lazy/forced unmount.
  umount "$MOUNT" || { echo 'Scratch unmount failed; mapping retained.' >&2; return 1; }
  cryptsetup close "$mapper" || { echo 'Scratch mapper retained.' >&2; return 1; }
  losetup -d "$loop" || { echo 'Scratch loop retained.' >&2; return 1; }
}

start_scratch() {
  local backing='' loop='' opened=0 mounted=0 recorded=0 blocks bsize uid
  [[ $EUID == 0 ]] && private_dir "$STATE" && private_dir "$STORE" && private_dir "$MOUNT" || { echo 'Private root directories required.' >&2; return 1; }
  [[ ! -e "$STATE/loop" && ! -L "$STATE/loop" && ! -e "/dev/mapper/$MAPPER" ]] || { echo 'Existing scratch state requires review.' >&2; return 1; }
  ! mountpoint -q "$MOUNT" || { echo 'Existing scratch mount requires review.' >&2; return 1; }
  [[ -z "$(find "$STORE" -mindepth 1 -maxdepth 1 -print -quit)" && -z "$(find "$MOUNT" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo 'Scratch directories are not empty.' >&2; return 1; }
  uid=$(id -u maestivo-omr); [[ "$uid" =~ ^[0-9]+$ && "$uid" -gt 0 ]] || return 1
  read -r blocks bsize < <(stat -f -c '%a %S' -- "$STORE")
  [[ "$blocks" =~ ^[0-9]+$ && "$bsize" =~ ^[0-9]+$ ]] && (( blocks * bsize >= 5368709120 )) || { echo 'Insufficient free storage for scratch.' >&2; return 1; }
  rollback() {
    if (( mounted )); then
      if ! safe_stop "$MAPPER" "$loop"; then echo 'Scratch retained for review.' >&2; return; fi
      mounted=0; opened=0; loop=''
    elif (( opened )); then
      if ! cryptsetup close "$MAPPER"; then echo 'Scratch mapper retained for review.' >&2; return; fi
      opened=0
    fi
    if [[ -n "$loop" ]]; then losetup -d "$loop" || { echo 'Scratch loop retained for review.' >&2; return; }; fi
    [[ -z "$backing" ]] || rm -- "$backing"
    (( recorded == 0 )) || rm -- "$STATE/loop"
  }
  trap rollback ERR
  trap 'rollback; exit 143' HUP INT TERM
  backing=$(mktemp "$STORE/session.XXXXXXXX.img"); chmod 0600 -- "$backing"
  fallocate -l "$BYTES" -- "$backing"
  loop=$(losetup --find --show -- "$backing"); [[ "$loop" =~ ^/dev/loop[0-9]+$ ]]
  rm -- "$backing"; backing=''
  cryptsetup open --type plain --cipher aes-xts-plain64 --key-size 256 --key-file /dev/urandom "$loop" "$MAPPER"; opened=1
  printf '%s\n' "$loop" > "$STATE/loop"; chmod 0600 "$STATE/loop"; recorded=1
  mkfs.ext4 -q -m 0 "/dev/mapper/$MAPPER"
  mount -t ext4 -o nodev,nosuid,noexec "/dev/mapper/$MAPPER" "$MOUNT"; mounted=1
  chmod 0755 "$MOUNT"; mkdir -m 0700 "$MOUNT/jobs"; chown maestivo-omr:maestivo-omr "$MOUNT/jobs"
  trap - ERR HUP INT TERM
  echo 'Private ephemeral encrypted scratch mounted.'
}

stop_scratch() {
  local loop
  [[ $EUID == 0 ]] && private_dir "$STATE" && [[ -f "$STATE/loop" && ! -L "$STATE/loop" && "$(stat -c '%u:%a' "$STATE/loop")" == '0:600' ]] || { echo 'Scratch state unavailable; retained for review.' >&2; return 1; }
  loop=$(cat "$STATE/loop")
  safe_stop "$MAPPER" "$loop" || return 1
  rm -- "$STATE/loop"
  echo 'Encrypted scratch unmounted and detached.'
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  case "${1:-}" in start) start_scratch ;; stop) stop_scratch ;; *) echo 'Usage: maestivo-split-scratch.sh start|stop' >&2; exit 2 ;; esac
fi
