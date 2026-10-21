#!/usr/bin/env bash
set -euo pipefail
out="$RUNNER_TEMP/desktop-journeys"
mkdir -p "$out/evidence" "$out/private"
chmod 700 "$out/private"
export MSYS_NO_PATHCONV=1
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$out/ca.key" -out "$out/ca.crt" \
  -days 2 -subj '/CN=Ditero journey CA' -addext 'basicConstraints=critical,CA:TRUE' 2> "$out/private/ca.log"
openssl req -newkey rsa:2048 -nodes -keyout "$out/server.key" -out "$out/server.csr" \
  -subj '/CN=localhost' 2> "$out/private/server.log"
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' > "$out/server.ext"
openssl x509 -req -in "$out/server.csr" -CA "$out/ca.crt" -CAkey "$out/ca.key" \
  -CAcreateserial -out "$out/server.crt" -days 2 -extfile "$out/server.ext" 2> "$out/private/sign.log"
openssl verify -CAfile "$out/ca.crt" "$out/server.crt"
chmod 600 "$out"/*.key
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$out/untrusted.key" -out "$out/untrusted.crt" \
  -days 2 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' 2> "$out/private/untrusted.log"
chmod 600 "$out/untrusted.key"
if [[ "$RUNNER_OS" == Linux ]]; then
  sudo cp "$out/ca.crt" /usr/local/share/ca-certificates/ditero-journey.crt
  sudo update-ca-certificates
  pg_bin=$(pg_config --bindir)
  mkdir -p "$HOME/.pki/nssdb"
  certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password
  certutil -A -d "sql:$HOME/.pki/nssdb" -n 'Ditero journey CA' -t 'C,,' -i "$out/ca.crt"
elif [[ "$RUNNER_OS" == macOS ]]; then
  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$out/ca.crt"
  pg_bin="$(brew --prefix postgresql@18)/bin"
else
  certutil.exe -f -addstore Root "$(cygpath -w "$out/ca.crt")"
  pg_bin="$PGBIN"
fi
printf 'JOURNEY_PG_BIN=%s\n' "$pg_bin" >> "$GITHUB_ENV"
ca="$out/ca.crt"
if [[ "$RUNNER_OS" == Windows ]]; then ca=$(cygpath -w "$ca"); fi
printf 'NODE_EXTRA_CA_CERTS=%s\n' "$ca" >> "$GITHUB_ENV"
