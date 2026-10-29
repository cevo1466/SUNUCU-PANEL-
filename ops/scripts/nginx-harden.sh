#!/usr/bin/env bash
# ops/scripts/nginx-harden.sh
#
# `proxy-server` konteynerinin ANA nginx.conf'una guvenlik sikilastirmalari
# uygular. IDEMPOTENT'tir — zaten uygulanmissa hicbir sey yapmaz.
#
# NEDEN AYRI BIR SCRIPT VE NEDEN BU DOSYA GIT'TE DEGIL: /etc/nginx/nginx.conf
# proxy-server konteynerinin KENDI dosya sistemindedir — panel-ssl.sh'in
# yazdigi /etc/nginx/conf.d/*.conf'un aksine bu HOST ile PAYLASILMIYOR
# (bkz. `docker inspect proxy-server --format '{{json .Mounts}}'`: yalnizca
# /var/www/vhosts ve /etc/nginx/conf.d bind-mount). Yani buradaki `sed`
# konteynerin YAZILABILIR KATMANINA yaziyor; konteyner bir gun SIFIRDAN
# yeniden olusturulursa (yeniden `docker run` ile) bu degisiklik KAYBOLUR —
# guvenlik taramasi tekrar "server: nginx/x.y.z" bulursa bu script tekrar
# calistirilmali.
#
# 2026-09-04: kullanici bir guvenlik taramasinda "server: nginx/1.31.4"
# basliginin surum ifsa ettigini bildirdi. `server_tokens off` http{}
# blogunda YOKTU (varsayilan nginx:alpine imaji, hic ozellestirilmemis).
set -euo pipefail

fail() { echo "HATA: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker bulunamadi."
docker exec proxy-server true 2>/dev/null || fail "proxy-server konteynerine erisilemiyor."

if docker exec proxy-server sh -c "grep -q 'server_tokens off;' /etc/nginx/nginx.conf"; then
  echo "» server_tokens zaten kapali — degisiklik gerekmiyor."
  exit 0
fi

echo "» server_tokens off ekleniyor"
BACKUP="$(docker exec proxy-server mktemp /etc/nginx/nginx.conf.before-server-tokens.XXXXXX)"
docker exec proxy-server sh -c "cp /etc/nginx/nginx.conf '$BACKUP'"

docker exec proxy-server sh -c "sed -i '/http {/a\\    server_tokens off;' /etc/nginx/nginx.conf"

if ! docker exec proxy-server nginx -t; then
  echo "» nginx dogrulamasi basarisiz, geri aliniyor" >&2
  docker exec proxy-server sh -c "cp '$BACKUP' /etc/nginx/nginx.conf"
  docker exec proxy-server nginx -t
  fail "server_tokens eklenemedi; eski yapilandirmaya donuldu, reload YAPILMADI."
fi

docker exec proxy-server nginx -s reload
echo "» server_tokens off uygulandi ve nginx yeniden yuklendi."
