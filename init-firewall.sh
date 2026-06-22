#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

# C/#38: derive the cage profile from a ROOT-OWNED file, not the (caller-influenceable) env. This script now
# runs ONLY as root at container boot — the container starts as root and drops to the unprivileged `coder`
# user for the agent, and coder has no sudo — so a sandboxed session can't re-run it to weaken its cage. The
# file is the immutable source of truth + belt-and-suspenders: written ONCE from the launcher env, then 0444
# root-owned. Absent/garbage → HARDEN (fail-closed: over-caging only loses npm/sentry, still reaches the
# model). Downstream gates read MRC_ADVERSARY_FW, so we point it at the file value here in ONE place.
CAGE_FILE=/etc/mrc-cage-profile
if [ ! -f "$CAGE_FILE" ]; then
    want="${MRC_ADVERSARY_FW:-0}"; [ "$want" = "1" ] || want="0"
    { printf '%s' "$want" > "$CAGE_FILE" && chmod 0444 "$CAGE_FILE"; } || echo "WARNING: could not pin cage profile file (will fail closed)"
fi
CAGE=$(cat "$CAGE_FILE" 2>/dev/null || echo 1)
[ "$CAGE" = "0" ] || CAGE=1   # anything but an explicit 0 → harden
MRC_ADVERSARY_FW="$CAGE"

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
# A/#40: a summoned adversary gets an EMPTY direct allowlist — ZERO direct external egress. Every TLS call is
# forced through the host SNI-pinning egress proxy (HTTPS_PROXY, set by mrc.js → host.docker.internal:proxy),
# which peeks the in-tunnel ClientHello SNI and forwards ONLY api.anthropic.com / platform.claude.com.
# Pinning the model's IP HERE would NOT seal egress: api.anthropic.com is a shared Cloudflare edge, so a
# foreign SNI rides the pinned IP to another tenant (proven live) and an L3/L4 firewall is SNI-blind. So we
# don't pin it at all — the proxy is the only way out and it seals by NAME. The cage reaches only
# host.docker.internal:{room,proxy} (HOST_PORTS below) + the daemon relay; it needs no npm/openai/sentry/statsig.
# ⚠ DANGER (Pierre's trap): do NOT add domains to THIS branch or re-enable a non-empty ipset for the cage. Any
# IP allowed here is reachable by an ARBITRARY SNI (the firewall is L3/L4) and reopens the A/#40 SNI-ride. A new
# cage destination goes in the PROXY allowlist (sni-proxy.js DEFAULT_ALLOW), which seals by name — never here.
if [ "${MRC_ADVERSARY_FW:-}" = "1" ]; then
    ALLOWED_DOMAINS=()
else
    ALLOWED_DOMAINS=("registry.npmjs.org" "api.anthropic.com" "platform.claude.com" "api.openai.com" "sentry.io" "statsig.com")
fi
for domain in ${ALLOWED_DOMAINS[@]+"${ALLOWED_DOMAINS[@]}"}; do
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
SNI_PROXY_PORT="${MRC_SNI_PROXY_PORT:-}"
# F/#41 + A/#40: a caged adversary reaches ONLY the room relay port + the SNI-pinning egress proxy port —
# NOT the clipboard proxy (serves the human's clipboard) or the notify proxy (a desktop-toast phishing
# surface). It volleys via the room daemon and reaches the model ONLY through the egress proxy, so those two
# stay open and clipboard/notify are dropped. A normal session keeps clipboard + notify (+ room) and uses no
# proxy (direct egress). NB: this script sets IFS=$'\n\t' (no space), so a space-joined string would NOT
# word-split in `for` — use a bash ARRAY so the ports iterate regardless of IFS (collapsing them into one
# string broke that and killed a normal session's firewall once already).
if [ "$CAGE" = "1" ]; then
    HOST_PORTS=(${ROOM_PORT:+$ROOM_PORT} ${SNI_PROXY_PORT:+$SNI_PROXY_PORT})
else
    HOST_PORTS=("$CLIP_PORT" "$NOTIFY_PORT" ${ROOM_PORT:+$ROOM_PORT})
fi
for port in "${HOST_PORTS[@]}"; do
    iptables -A OUTPUT -d "$HOST_NETWORK" -p tcp --dport "$port" -j ACCEPT
    iptables -A INPUT -s "$HOST_NETWORK" -p tcp --sport "$port" -j ACCEPT
done

# Allow traffic to host.docker.internal (may be outside the Docker bridge subnet,
# e.g. Colima's VM host IP). Needed for clipboard and notification proxies.
HDINT_IP=$(getent hosts host.docker.internal 2>/dev/null | awk '{print $1}')
if [ -n "$HDINT_IP" ] && [ "$HDINT_IP" != "$HOST_IP" ]; then
    echo "Allowing host.docker.internal ($HDINT_IP) on proxy ports only"
    for port in "${HOST_PORTS[@]}"; do
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
# belt 2: the host forces ALLOW_WEB off for a summoned/re-sandboxed adversary (belt 1, mrc.js), but gating on
# the cage profile HERE means the FIREWALL ITSELF refuses 443 for a caged adversary even if ALLOW_WEB leaked
# in by another path — e.g. an `ALLOW_WEB=1` env line in the TRUSTED global ~/.mrcrc that belt 0 doesn't
# filter. The cage value now comes from the root-owned /etc/mrc-cage-profile (resolved at the top), and this
# script runs only as root at boot (coder has no sudo, C/#38) — so it's genuinely ENFORCED now, not a
# caller-settable derivation. (--open-adversary-unsafe leaves the cage at 0 → intentionally NOT gated.)
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
    # --noproxy '*' so this stays a DIRECT-egress probe even for a caged adversary (HTTPS_PROXY is in its env;
    # without it curl would tunnel example.com through the proxy — which also drops it, but then this would be
    # testing the proxy, not the firewall's direct block). A no-op for a normal session (no proxy env).
    if curl --noproxy '*' --connect-timeout 5 https://example.com >/dev/null 2>&1; then
        echo "ERROR: Firewall verification failed - was able to reach https://example.com"
        exit 1
    else
        echo "Firewall verification passed - unable to reach https://example.com as expected"
    fi
    # A/#40 — the cage now has ZERO direct external egress; every TLS call routes through the host SNI-pinning
    # egress proxy. Three self-checks under the LIVE firewall (the example.com check above already confirmed DNS
    # is dead). These run ONLY for a caged adversary, so a failed seal aborts the adversary launch (fail-closed)
    # and never touches a normal session.
    if [ "${MRC_ADVERSARY_FW:-}" = "1" ]; then
        PROXY="http://host.docker.internal:${MRC_SNI_PROXY_PORT:-0}"
        # (a) NO direct 443: an arbitrary host on 443 by LITERAL IP (1.1.1.1 — bypasses the DNS drop, so this
        # tests the egress GATE itself, not name resolution) MUST be blocked. rc 7 (REJECT) / 28 (DROP-timeout) =
        # blocked; a real connection (rc 0 / a post-handshake TLS code) = the cage has direct egress → abort.
        # `--noproxy '*'` is ESSENTIAL: HTTPS_PROXY is in the container env, so without it curl would route THIS
        # probe through the proxy (testing the proxy's drop, not the firewall's direct-egress drop = a false pass).
        rc=0
        curl --noproxy '*' --connect-timeout 5 -o /dev/null -s https://1.1.1.1 2>/dev/null || rc=$?
        if [ "$rc" = "7" ] || [ "$rc" = "28" ]; then
            echo "Adversary profile: no direct 443 egress (1.1.1.1 blocked) — cage holds"
        else
            echo "ERROR: adversary profile — reached 1.1.1.1:443 directly (curl rc=$rc); the cage has direct egress. Aborting."
            exit 1
        fi
        # (b) the egress proxy SEALS by SNI (this is the A/#40 fix): a foreign host THROUGH the proxy MUST be
        # refused. The proxy answers CONNECT, peeks the in-tunnel ClientHello SNI, and drops a non-allowlisted
        # name → curl can't finish the handshake (rc≠0). A COMPLETED request (rc 0) = the SNI-ride is open →
        # abort closed. (The proxy is guaranteed up — mrc.js fails the launch closed if it can't start, so the
        # container wouldn't exist; a connect-refused here would also be rc≠0 and still fail safe.) `-k` so only
        # a transport failure, not a cert mismatch, can drive the verdict.
        rc=0
        curl -x "$PROXY" -k --connect-timeout 8 -o /dev/null -s https://example.com/ 2>/dev/null || rc=$?
        if [ "$rc" = "0" ]; then
            echo "ERROR: adversary profile — a foreign SNI (example.com) tunneled THROUGH the egress proxy (rc=0); the SNI pin is not holding. Aborting."
            exit 1
        else
            echo "Adversary profile: foreign SNI refused by the egress proxy (rc=$rc) — A/#40 SNI-ride sealed"
        fi
        # (c) liveness: the model API MUST be reachable THROUGH the proxy or the agent is bricked. A warning, not
        # an abort — a transient upstream hiccup isn't a safety failure and shouldn't wedge the launch closed.
        # NB (Pierre F3): this proves the proxy→upstream PATH works when explicitly told (-x) to use it; it does
        # NOT prove the agent binary routes its OWN calls through HTTPS_PROXY — that's the live model call. If the
        # agent ignored the proxy, its calls go direct → empty ipset → blocked = fail-CLOSED (bricked, not leaky).
        if curl -x "$PROXY" --connect-timeout 8 -o /dev/null -s https://api.anthropic.com; then
            echo "Adversary profile: api.anthropic.com reachable via the SNI proxy"
        else
            echo "WARNING: adversary profile — api.anthropic.com NOT reachable via the egress proxy; the agent may be unable to start"
        fi
    fi
fi
