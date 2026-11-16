#!/usr/bin/env bash
# Uninstalled candidate: private system-wide encrypted swap. Never source from
# an untrusted directory. The unit starts this script as root with fixed paths.
set -Eeuo pipefail

MAPPER=maestivo-ephemeral-swap
STATE=/run/maestivo-ephemeral-swap
STORE=/var/lib/maestivo-ephemeral-swap
SWAP_BYTES=805306368 # 768 MiB; no key or data is written to a named file.

safe_stop() {
  local mapper="$1" loop="$2" device
  [[ "$mapper" == maestivo-ephemeral-swap && "$loop" =~ ^/dev/loop[0-9]+$ ]] || return 1
  # Confirm this mapper really uses the loop device recorded when we started.
  device=$(cryptsetup status "$mapper" | awk '$1 == "device:" {print $2}') || return 1
  [[ "$device" == "$loop" ]] || { echo 'Refusing to close a mismatched encrypted device.' >&2; return 1; }
  # Critical ordering: failure must leave the mapping and its loop intact.
  swapoff "/dev/mapper/$mapper" || { echo 'Swapoff failed; encrypted mapping retained for review.' >&2; return 1; }
  cryptsetup close "$mapper" || { echo 'Mapper close failed; loop retained for review.' >&2; return 1; }
  losetup -d "$loop" || { echo 'Loop detach failed; state retained for review.' >&2; return 1; }
}

private_dir() {
  local p="$1"
  [[ -d "$p" && ! -L "$p" && "$(readlink -f -- "$p")" == "$p" && "$(stat -c '%u:%a' -- "$p")" == '0:700' ]]
}

start_swap() {
  local backing='' loop='' opened=0 active=0 recorded=0 free_blocks block_size
  [[ $EUID == 0 ]] && private_dir "$STATE" && private_dir "$STORE" || { echo 'Private root-owned directories required.' >&2; return 1; }
  [[ ! -e "$STATE/loop" && ! -L "$STATE/loop" && ! -e "/dev/mapper/$MAPPER" ]] || { echo 'Existing swap state requires operator review.' >&2; return 1; }
  [[ "$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)" == 0 ]] || { echo 'Existing system swap requires operator review.' >&2; return 1; }
  [[ -z "$(find "$STORE" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo 'Swap store is not empty; no files were removed.' >&2; return 1; }
  read -r free_blocks block_size < <(stat -f -c '%a %S' -- "$STORE")
  [[ "$free_blocks" =~ ^[0-9]+$ && "$block_size" =~ ^[0-9]+$ ]] &&
    (( free_blocks * block_size >= 5368709120 )) || { echo 'Insufficient free storage for a safe probe.' >&2; return 1; }

  rollback() {
    # On any failed swapoff, preserve the mapping, backing loop and state.
    if (( active )); then
      if ! safe_stop "$MAPPER" "$loop"; then echo 'Swap cleanup incomplete; resources retained for review.' >&2; return; fi
      active=0; opened=0; loop=''
    elif (( opened )); then
      if ! cryptsetup close "$MAPPER"; then echo 'Mapper retained for review.' >&2; return; fi
      opened=0
    fi
    if [[ -n "$loop" ]]; then losetup -d "$loop" || { echo 'Loop retained for review.' >&2; return; }; fi
    [[ -z "$backing" ]] || rm -f -- "$backing"
    (( recorded == 0 )) || rm -f -- "$STATE/loop"
  }
  trap rollback ERR
  trap 'rollback; exit 143' HUP INT TERM
  backing=$(mktemp "$STORE/session.XXXXXXXX.img")
  chmod 0600 -- "$backing"
  fallocate -l "$SWAP_BYTES" -- "$backing"
  loop=$(losetup --find --show -- "$backing")
  [[ "$loop" =~ ^/dev/loop[0-9]+$ ]]
  # Once unlinked, the open loop retains the inode until detach/reboot. A
  # power loss therefore cannot leave an identifiable stale backing file.
  rm -- "$backing"; backing=''
  cryptsetup open --type plain --cipher aes-xts-plain64 --key-size 256 --key-file /dev/urandom "$loop" "$MAPPER"
  opened=1
  printf '%s\n' "$loop" > "$STATE/loop"; chmod 0600 "$STATE/loop"; recorded=1
  mkswap "/dev/mapper/$MAPPER" > /dev/null
  swapon -p 5 "/dev/mapper/$MAPPER"; active=1
  trap - ERR HUP INT TERM
  echo 'Ephemeral encrypted swap active; no persistent key or named backing file.'
}

stop_swap() {
  local loop
  [[ $EUID == 0 ]] && private_dir "$STATE" && [[ -f "$STATE/loop" && ! -L "$STATE/loop" && "$(stat -c '%u:%a' "$STATE/loop")" == '0:600' ]] || { echo 'Swap state unavailable; mapping retained for review.' >&2; return 1; }
  loop=$(cat "$STATE/loop")
  safe_stop "$MAPPER" "$loop" || return 1
  rm -- "$STATE/loop"
  echo 'Ephemeral encrypted swap stopped and loop detached.'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  case "${1:-}" in start) start_swap ;; stop) stop_swap ;; *) echo 'Usage: maestivo-ephemeral-swap.sh start|stop' >&2; exit 2 ;; esac
fi
