#!/bin/sh
# Node box hardening (Ubuntu): SSH keys only for one user, root locked, ufw letting in only SSH from the LAN, fail2ban,
# kernel network sysctls, and the rhnode port firewall at boot. Idempotent. Run as root from the repo:
#   LAN=192.168.0.0/16 SSH_USER=<you> sh ops/harden.sh   (SSH_USER defaults to the repo's owner)
set -eux
cd "$(dirname "$0")/.."
LAN=${LAN:-192.168.0.0/16}; SSH_USER=${SSH_USER:-$(stat -c %U .)}

# SSH: keys only, one user, no root, no forwarding, short grace, few tries.
cat > /etc/ssh/sshd_config.d/10-rhnode.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PermitEmptyPasswords no
AllowUsers $SSH_USER
MaxAuthTries 3
MaxSessions 10
LoginGraceTime 20
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
PermitTunnel no
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
sshd -t
systemctl reload ssh || systemctl restart ssh

# Root: no password (already '*'), keep it locked.
passwd -l root

# Host firewall: nothing in except SSH from the private LAN ranges. Docker-published ports bypass ufw; ops/firewall.sh
# (DOCKER-USER) restricts those to API_HOST.
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow from "$LAN" to any port 22 proto tcp comment 'SSH from the LAN'
ufw --force enable

# Repeated SSH failures get banned (belt and braces on a key-only box).
DEBIAN_FRONTEND=noninteractive apt-get install -y -q fail2ban
cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
bantime = 1h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

# Kernel: no redirects/source routing, rp_filter, hidden kernel pointers and dmesg.
cat > /etc/sysctl.d/90-rhnode.conf <<'EOF'
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv4.conf.all.rp_filter = 1
net.ipv4.tcp_syncookies = 1
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
EOF
sysctl -q --system

# The rhnode port firewall, now and at every boot.
install -m 644 ops/rhnode-firewall.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now rhnode-firewall.service

# Optional CPU package power cap (POWER_W watts, both RAPL limits) at every boot, for a small box whose cooler can't
# hold the firmware's limit: it then sits at Tjmax and throttles, which costs more than the cap does.
if [ -n "${POWER_W:-}" ]; then
  cat > /etc/systemd/system/rhnode-power.service <<EOF
[Unit]
Description=rhnode CPU package power cap (${POWER_W} W)
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo ${POWER_W}000000 > /sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw'
ExecStart=/bin/sh -c 'echo ${POWER_W}000000 > /sys/class/powercap/intel-rapl:0/constraint_1_power_limit_uw'
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable rhnode-power.service
  systemctl restart rhnode-power.service
fi
ufw status verbose
iptables -L RHNODE -n
