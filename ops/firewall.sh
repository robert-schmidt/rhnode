#!/bin/sh
# When the node box publishes ClickHouse, Redis and Nitro for an API box on the LAN (NODE_BIND=0.0.0.0), only API_HOST
# may reach them. Docker's published ports bypass ufw, so the rule lives in Docker's DOCKER-USER chain, limited to traffic
# arriving on the LAN interface (containers keep talking to each other on their bridge). Idempotent; run at boot after
# Docker by ops/rhnode-firewall.service, which Docker restarts pull along.
# ponytail: a few seconds between Docker publishing and this rule at boot; a LAN-only box, so accepted.
set -eu
cd "$(dirname "$0")/.."
ALLOW=$(grep -s '^API_HOST=' .env | cut -d= -f2)
# At boot the default route can come a few seconds after Docker: wait for it (an empty -i is refused, rule not set)
for _ in $(seq 60); do IF=$(ip route show default | awk '{print $5; exit}'); [ -n "$IF" ] && break; sleep 1; done
[ -n "$IF" ] || { echo "no default route after 60 s: rhnode ports NOT restricted" >&2; exit 1; }
PORTS=8123,6379,8547,8548
iptables -N RHNODE 2>/dev/null || iptables -F RHNODE
[ -n "$ALLOW" ] && iptables -A RHNODE -s "$ALLOW" -j RETURN
iptables -A RHNODE -j DROP
iptables -C DOCKER-USER -i "$IF" -p tcp -m multiport --dports $PORTS -j RHNODE 2>/dev/null \
  || iptables -I DOCKER-USER -i "$IF" -p tcp -m multiport --dports $PORTS -j RHNODE
echo "rhnode ports $PORTS on $IF: only ${ALLOW:-nobody}"
