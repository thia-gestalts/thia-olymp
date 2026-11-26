#!/usr/bin/env bash
# Run as root on a dedicated Ubuntu VPS from the repository root.
set -euo pipefail

domain=${1:?Usage: bash deploy/ubuntu.sh DOMAIN}
[[ $domain =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]]

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y build-essential ca-certificates caddy curl

export CARGO_HOME=/opt/olymp-build/cargo
export RUSTUP_HOME=/opt/olymp-build/rustup
if [[ ! -x $CARGO_HOME/bin/rustup ]]; then
    curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs |
        sh -s -- -y --profile minimal --default-toolchain none --no-modify-path
fi
"$CARGO_HOME/bin/rustup" toolchain install 1.91.1 --profile minimal
"$CARGO_HOME/bin/cargo" +1.91.1 build --locked --release --bin olymp

install -d -m 0755 /opt/olymp
install -m 0755 target/release/olymp /opt/olymp/olymp.new
mv -f /opt/olymp/olymp.new /opt/olymp/olymp

cat >/etc/systemd/system/olymp.service <<'UNIT'
[Unit]
Description=Olymp account and sync service
After=network.target

[Service]
DynamicUser=yes
StateDirectory=olymp
StateDirectoryMode=0700
UMask=0077
Environment=OLYMP_DATA=/var/lib/olymp
Environment=OLYMP_LISTEN=127.0.0.1:8787
ExecStart=/opt/olymp/olymp
Restart=on-failure
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable olymp
systemctl restart olymp
curl --fail --silent --show-error --retry 5 --retry-connrefused http://127.0.0.1:8787/ >/dev/null

caddyfile=$(mktemp)
trap 'rm -f "$caddyfile"' EXIT
cat >"$caddyfile" <<CADDY
$domain {
    reverse_proxy 127.0.0.1:8787
}
CADDY
caddy validate --adapter caddyfile --config "$caddyfile"
install -m 0644 "$caddyfile" /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
