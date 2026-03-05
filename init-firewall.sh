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

# Create ipset with CIDR support
ipset create allowed-domains hash:net

# Resolve and add allowed domains
for domain in \
    "registry.npmjs.org" \
    "api.anthropic.com" \
    "sentry.io" \
    "statsig.anthropic.com" \
    "statsig.com"; do
    echo "Resolving $domain..."
    ips=$(dig +noall +answer A "$domain" | awk '$4 == "A" {print $5}')
    if [ -z "$ips" ]; then
        echo "ERROR: Failed to resolve $domain"
        exit 1
    fi

    while read -r ip; do
        if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
            echo "ERROR: Invalid IP from DNS for $domain: $ip"
            exit 1
        fi
        echo "Adding $ip for $domain"
        ipset add allowed-domains "$ip" -exist
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

# Allow host network communication (Docker bridge)
iptables -A INPUT -s "$HOST_NETWORK" -j ACCEPT
iptables -A OUTPUT -d "$HOST_NETWORK" -j ACCEPT

# Allow traffic to host.docker.internal (may be outside the Docker bridge subnet,
# e.g. Colima's VM host IP). Needed for clipboard proxy.
HDINT_IP=$(getent hosts host.docker.internal 2>/dev/null | awk '{print $1}')
if [ -n "$HDINT_IP" ] && [ "$HDINT_IP" != "$HOST_IP" ]; then
    echo "Allowing host.docker.internal ($HDINT_IP)"
    iptables -A OUTPUT -d "$HDINT_IP" -j ACCEPT
    iptables -A INPUT -s "$HDINT_IP" -j ACCEPT
fi

# Allow established connections for already-approved traffic
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow outbound traffic to whitelisted domains only
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# If ALLOW_WEB is set, open outbound HTTPS (port 443) to any destination
if [ "${ALLOW_WEB:-}" = "1" ]; then
    echo "Web access enabled — allowing outbound HTTPS (port 443)"
    iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT
fi

# Explicitly REJECT all other outbound traffic for immediate feedback
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

# Set default policies to DROP last — all ACCEPT rules are already in the chain
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

echo "Firewall configuration complete"
echo "Verifying firewall rules..."
if [ "${ALLOW_WEB:-}" = "1" ]; then
    # With web access enabled, verify whitelisted domains work
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
fi
