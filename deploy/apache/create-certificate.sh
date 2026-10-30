#!/bin/sh
# Run once as root. Keep the CA and server private keys on the server.
set -eu
directory=/etc/apache2/ifshare/tls
if [ -e "$directory/server.key" ] || [ -e "$directory/ca.key" ]; then
    printf '%s\n' 'Certificate keys already exist; refusing to replace them.' >&2
    exit 1
fi
install -d -m 0700 "$directory"
umask 077
openssl genrsa -out "$directory/ca.key" 3072
openssl req -x509 -new -sha256 -days 3650 -key "$directory/ca.key" -out "$directory/ca.crt" \
    -subj '/CN=IFShare Private CA/O=IFShare' \
    -config /etc/ssl/openssl.cnf -extensions v3_ca
openssl genrsa -out "$directory/server.key" 2048
openssl req -new -sha256 -key "$directory/server.key" -out "$directory/server.csr" \
    -subj '/CN=111.10.164.175/O=IFShare'
cat > "$directory/server.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:111.10.164.175
authorityKeyIdentifier=keyid,issuer
subjectKeyIdentifier=hash
EOF
openssl x509 -req -sha256 -days 365 -in "$directory/server.csr" \
    -CA "$directory/ca.crt" -CAkey "$directory/ca.key" -CAcreateserial \
    -extfile "$directory/server.ext" -out "$directory/server.crt"
openssl verify -CAfile "$directory/ca.crt" "$directory/server.crt"
openssl x509 -in "$directory/ca.crt" -noout -fingerprint -sha256
