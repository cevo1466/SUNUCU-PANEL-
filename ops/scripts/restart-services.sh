#!/bin/sh
# Studio Panel — servisleri derleyip yeniden baslatir.
#
# NEDEN AYRI BIR SCRIPT: `next build`, calisan `next start` ile AYNI `.next`
# dizinini kullaniyor. Sunucu ayaktayken derleme yapilirsa derleme sonunda
# "Collecting build traces" adiminda `.next/server/pages/_app.js.nft.json`
# ENOENT ile dusuyor — iki surec ayni dizini ayni anda yazip siliyor.
# Dogru sira: once web'i durdur, sonra derle, sonra baslat.
#
# SCREEN KULLANILMAZ. Servisler ops/scripts/service.sh uzerinden `setsid` ile
# kendi oturumlarinda calisir; boylece bu scripti calistiran kabuk (veya bir
# ajan oturumu) kapandiginda servisler olmez. Ayrintili gerekce: service.sh
# basligi.
#
# Kullanim: ops/scripts/restart-services.sh

set -eu

# Panelin DIS KAPISINI olcer: nginx konteyneri gercekten upstream'e ulasiyor mu?
#
# NEDEN DUZ HTTP YETMIYOR (2026-09-03): IP ve bilinmeyen adlar artik kanonik
# panel adresine 301 ile yonlendiriliyor (bkz. studio-panel.conf). Yani
# `http://127.0.0.1/login` upstream'e HIC dokunmadan 301 donuyor — bu kontrol
# 502'yi yakalamak icin vardi ve 301'i "saglikli" saymak onu anlamsiz
# kilardi. Bu degisiklik saglik kontrolunu gercekten bozdu ve deploy
# "servisler saglikli yanit vermedi" dedi.
#
# Hostname config'ten OKUNUYOR, koda gomulmuyor: panel-ssl.sh baska bir adla
# calistirilirsa kontrol de onu takip etsin. -k bilincli: burada sertifika
# gecerliligi degil, nginx'in upstream'e ULASABILDIGI olculuyor.
panel_edge_code() {
  _pe_host="$(sed -n '/listen 443/,/server_name/p' /etc/nginx/conf.d/studio-panel-ssl.conf 2>/dev/null \
    | awk '/server_name/{print $2}' | tr -d ';' | head -1)"
  if [ -n "$_pe_host" ]; then
    curl -s -o /dev/null -m 5 -k --resolve "$_pe_host:443:127.0.0.1" \
      -w '%{http_code}' "https://$_pe_host/login" 2>/dev/null
  else
    # Panel SSL'i henuz kurulmamis: eski duz HTTP yolu hala gecerli.
    curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1/login 2>/dev/null
  fi
}

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
SERVICE="$PROJECT_ROOT/ops/scripts/service.sh"
cd "$PROJECT_ROOT"

# Watchdog'u sustur: derleme 1 dakikadan uzun suruyor ve dakikalik `ensure`
# turu web'i derlemenin ortasinda yeniden baslatirsa `next build` ayni .next
# dizinini paylasan iki surec yuzunden ENOENT ile duser.
"$SERVICE" maintenance-on
# Script nasil biterse bitsin (hata, Ctrl-C) kilit kalkar; aksi halde watchdog
# kalici olarak devre disi kalirdi.
trap '"$SERVICE" maintenance-off >/dev/null 2>&1 || true' EXIT INT TERM

echo "== Servisler durduruluyor"
"$SERVICE" stop api
"$SERVICE" stop web

echo "== Derleniyor"
npm run build

echo "== Servisler baslatiliyor"
"$SERVICE" start api
"$SERVICE" start web

# Bakim kilidini BURADA kaldiriyoruz — asagidaki `ensure`'dan ONCE.
#
# NEDEN (gercek kusur, 2026-08-31'de bulundu): bu satirlarin altindaki
# `ensure` cagrisi "adminer dusmusse kaldirilsin" diye konmustu ama bakim
# kilidi hala aciktı ve `ensure` bakim modunda HICBIR SEY YAPMAZ. Yani bu
# adim hic calismadi; sessizce 0 donup gecti ve kimse fark etmedi. Derleme
# bittigi, api ve web ayaga kalktigi icin kilide burada zaten gerek yok.
# (Cikista calisan trap idempotenttir: `rm -f` olmayan dosyaya zarar vermez.)
"$SERVICE" maintenance-off

# Adminer derlemeden etkilenmez; sadece dusmusse kaldirilir.
"$SERVICE" ensure

echo "== Saglik kontrolu"
# Ilk istek Next.js'in soguk baslamasini bekler; 60 saniye tavan.
i=0
while [ "$i" -lt 60 ]; do
  api=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/health 2>/dev/null) || api=000
  web=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login 2>/dev/null) || web=000
  # Panelin dis kapisi: nginx konteyneri gercekten upstream'e ulasiyor mu?
  # 502'yi ancak bu adim yakalar — 3000/3001 ayakta ama nginx yanlis
  # upstream'e bakiyorsa panel yine bozuktur.
  edge="$(panel_edge_code)"
  [ -n "$edge" ] || edge=000
  if [ "$api" = "200" ] && [ "$web" = "200" ] && [ "$edge" = "200" ]; then
    echo "✓ API 200 · web 200 · nginx 200"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "✗ Servisler 60 saniyede saglikli yanit vermedi (API=$api web=$web nginx=$edge)"
echo "  Loglar: ops/api.log · ops/web.log · ops/run/*.boot.log"
exit 1
