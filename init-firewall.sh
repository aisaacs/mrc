#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

# 1. Extract Docker DNS info BEFORE any flushing
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

# Flush existing rules and delete existing ipsets
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true

# Block all IPv6 — without this, IPv6-capable services bypass our IPv4 firewall
if command -v ip6tables &>/dev/null; then
    ip6tables -F
    ip6tables -X
    ip6tables -P INPUT DROP
    ip6tables -P FORWARD DROP
    ip6tables -P OUTPUT DROP
    echo "IPv6 blocked"
fi

# 2. Selectively restore ONLY internal Docker DNS resolution
if [ -n "$DOCKER_DNS_RULES" ]; then
    echo "Restoring Docker DNS rules..."
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
else
    echo "No Docker DNS rules to restore"
fi

# Allow localhost
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Allow DNS to the resolver + system nameservers — EXCEPT for a summoned adversary (hardened profile),
# which gets its allowlist pinned to /etc/hosts below and runtime DNS dropped, closing the DNS-exfil
# channel. (Setup-time resolution still works: the default policy is ACCEPT until the DROP at the end.)
if [ "${MRC_ADVERSARY_FW:-}" = "1" ]; then
    echo "Adversary firewall profile: runtime DNS will be dropped (allowlist pinned to /etc/hosts)"
else
    # Allow DNS to Docker's embedded resolver (127.0.0.11)
    iptables -A OUTPUT -p udp -d 127.0.0.11 --dport 53 -j ACCEPT
    iptables -A INPUT -p udp -s 127.0.0.11 --sport 53 -j ACCEPT

    # Also allow DNS to system-configured nameservers (needed when Docker DNS NAT rules aren't present)
    for ns in $(awk '/^nameserver/ && $2 != "127.0.0.11" {print $2}' /etc/resolv.conf); do
        echo "Allowing DNS to nameserver $ns"
        iptables -A OUTPUT -p udp -d "$ns" --dport 53 -j ACCEPT
        iptables -A INPUT -p udp -s "$ns" --sport 53 -j ACCEPT
        iptables -A OUTPUT -p tcp -d "$ns" --dport 53 -j ACCEPT
        iptables -A INPUT -p tcp -s "$ns" --sport 53 -j ACCEPT
    done
fi

# Create ipset with CIDR support
ipset create allowed-domains hash:net

# Resolve and add allowed domains. A resolution failure is a warning, not fatal —
# a transient DNS hiccup on one domain shouldn't wedge container startup.
# A summoned adversary gets a MINIMAL allowlist: Anthropic's own model + auth endpoints only
# (api.anthropic.com + platform.claude.com — current Claude Code authenticates/validates the session via
# platform.claude.com, and because this profile DNS-pins + drops port 53, a missing host can't even be
# resolved → "Failed to connect to platform.claude.com: ECONNREFUSED"). It grounds in the repo and volleys
# via the daemon's host proxy ports (IP-based below), so it still needs no npm/openai, and dropping the
# multi-tenant SaaS sinks (sentry/statsig) keeps those exfil channels closed.
if [ "${MRC_ADVERSARY_FW:-}" = "1" ]; then
    ALLOWED_DOMAINS=("api.anthropic.com" "platform.claude.com")
else
    ALLOWED_DOMAINS=("registry.npmjs.org" "api.anthropic.com" "platform.claude.com" "api.openai.com" "sentry.io" "statsig.com")
fi
for domain in "${ALLOWED_DOMAINS[@]}"; do
    echo "Resolving $domain..."
    ips=$(dig +noall +answer A "$domain" | awk '$4 == "A" {print $5}')
    if [ -z "$ips" ]; then
        echo "WARNING: Failed to resolve $domain — skipping"
        continue
    fi

    while read -r ip; do
        if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
            echo "WARNING: Invalid IP from DNS for $domain: $ip — skipping"
            continue
        fi
        echo "Adding $ip for $domain"
        ipset add allowed-domains "$ip" -exist
        # Adversary profile: pin the IP into /etc/hosts so the agent resolves by NAME with no runtime DNS
        # (we drop 53 for adversaries — the resolution happens here, once, at setup).
        if [ "${MRC_ADVERSARY_FW:-}" = "1" ]; then echo "$ip $domain" >> /etc/hosts; fi
    done < <(echo "$ips")
done

# Get host IP from default route
HOST_IP=$(ip route | grep default | cut -d" " -f3)
if [ -z "$HOST_IP" ]; then
    echo "ERROR: Failed to detect host IP"
    exit 1
fi

HOST_NETWORK=$(echo "$HOST_IP" | sed "s/\.[0-9]*$/.0\/24/")
echo "Host network detected as: $HOST_NETWORK"

# Allow host network communication — only specific proxy ports, not full access.
# This prevents the container from reaching services like Postgres on the host.
CLIP_PORT="${MRC_CLIPBOARD_PORT:-7722}"
NOTIFY_PORT="${MRC_NOTIFY_PORT:-7723}"
ROOM_PORT="${MRC_ROOM_PORT:-}"
for port in $CLIP_PORT $NOTIFY_PORT ${ROOM_PORT:+$ROOM_PORT}; do
    iptables -A OUTPUT -d "$HOST_NETWORK" -p tcp --dport "$port" -j ACCEPT
    iptables -A INPUT -s "$HOST_NETWORK" -p tcp --sport "$port" -j ACCEPT
done

# Allow traffic to host.docker.internal (may be outside the Docker bridge subnet,
# e.g. Colima's VM host IP). Needed for clipboard and notification proxies.
HDINT_IP=$(getent hosts host.docker.internal 2>/dev/null | awk '{print $1}')
if [ -n "$HDINT_IP" ] && [ "$HDINT_IP" != "$HOST_IP" ]; then
    echo "Allowing host.docker.internal ($HDINT_IP) on proxy ports only"
    for port in $CLIP_PORT $NOTIFY_PORT ${ROOM_PORT:+$ROOM_PORT}; do
        iptables -A OUTPUT -d "$HDINT_IP" -p tcp --dport "$port" -j ACCEPT
        iptables -A INPUT -s "$HDINT_IP" -p tcp --sport "$port" -j ACCEPT
    done
fi

# Allow established connections for already-approved traffic
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow outbound traffic to whitelisted domains only
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# If ALLOW_WEB is set, open outbound HTTPS (443) to any host — UNLESS this is a caged adversary.
# belt 2 (the hard guarantee): the host already forces ALLOW_WEB off for a summoned/re-sandboxed adversary
# (belt 1, mrc.js), but gating on MRC_ADVERSARY_FW here means the FIREWALL ITSELF refuses 443 for a caged
# adversary even if ALLOW_WEB leaked in by another path — e.g. an `ALLOW_WEB=1` env line in the TRUSTED
# global ~/.mrcrc, which belt 0 doesn't filter and belt 1's flag-check misses. Enforced, not derived.
# (--open-adversary-unsafe leaves MRC_ADVERSARY_FW UNSET, so it's intentionally NOT gated — uncaged by design.)
if [ "${ALLOW_WEB:-}" = "1" ] && [ "${MRC_ADVERSARY_FW:-}" != "1" ]; then
    echo "Web access enabled — allowing outbound HTTPS (port 443)"
    iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT
elif [ "${ALLOW_WEB:-}" = "1" ]; then
    echo "Adversary firewall profile: ALLOW_WEB ignored — 443 stays closed (belt 2)"
fi

# Explicitly REJECT all other outbound traffic for immediate feedback
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

# Set default policies to DROP last — all ACCEPT rules are already in the chain
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

echo "Firewall configuration complete"
echo "Verifying firewall rules..."
if [ "${ALLOW_WEB:-}" = "1" ] && [ "${MRC_ADVERSARY_FW:-}" != "1" ]; then
    # With web access enabled (and not a caged adversary), verify whitelisted domains work
    if curl --connect-timeout 5 https://api.anthropic.com >/dev/null 2>&1; then
        echo "Firewall verification passed — HTTPS outbound open, whitelisted domains reachable"
    else
        echo "WARNING: Could not reach api.anthropic.com — network may not be fully ready"
    fi
else
    if curl --connect-timeout 5 https://example.com >/dev/null 2>&1; then
        echo "ERROR: Firewall verification failed - was able to reach https://example.com"
        exit 1
    else
        echo "Firewall verification passed - unable to reach https://example.com as expected"
    fi
    # Adversary profile: confirm the DNS-pinned model API is actually reachable — a stale/broken pin would
    # silently break the agent, so surface it as a warning rather than a mysterious hang.
    if [ "${MRC_ADVERSARY_FW:-}" = "1" ]; then
        if curl --connect-timeout 5 https://api.anthropic.com >/dev/null 2>&1; then
            echo "Adversary profile: api.anthropic.com reachable via pinned IP"
        else
            echo "WARNING: adversary profile — api.anthropic.com unreachable; the /etc/hosts pin may be stale"
        fi
        # belt 2 self-check: an arbitrary host on 443 by LITERAL IP (1.1.1.1 — bypasses the DNS drop so this
        # tests the 443 GATE itself, not name resolution; not in the allowlist; it serves 443) MUST be blocked,
        # even if ALLOW_WEB leaked in. rc 7 (REJECT) / 28 (DROP-timeout) = blocked; a real connection returns 0
        # or a post-handshake TLS/cert code (≠7,28) → the cage is OPEN → abort the launch closed. The `|| rc=$?`
        # keeps `set -e` from aborting on the expected non-zero. (The example.com check above passes via the DNS
        # drop, NOT this gate — so this is the only probe that actually exercises belt 2.)
        rc=0
        curl --connect-timeout 5 -o /dev/null -s https://1.1.1.1 2>/dev/null || rc=$?
        if [ "$rc" = "7" ] || [ "$rc" = "28" ]; then
            echo "Adversary profile: arbitrary 443 (1.1.1.1) blocked as expected — belt 2 / cage holds"
        else
            echo "ERROR: adversary profile — reached 1.1.1.1:443 (curl rc=$rc); the 443 cage is OPEN. Aborting."
            exit 1
        fi
    fi
fi
