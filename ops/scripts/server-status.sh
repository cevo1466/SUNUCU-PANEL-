#!/usr/bin/env bash
# ops/scripts/server-status.sh
#
# Panelin "Sunucu sagligi" sayfasi icin root gerektiren iki bilgiyi okur ve
# TSV olarak basar: sertifika envanteri ve zamanlanmis isler.
#
# NEDEN ROOT: /etc/letsencrypt/live 0700 root ve /etc/crontabs/devuser 0600
# root. Panel devuser olarak calisiyor, ikisini de dogrudan okuyamaz.
# (Bu tuzak daha once yasandi: `existsSync` izin hatasinda da false donuyor ve
# panel var olan bir sertifikayi "yok" saniyordu.)
#
# NEDEN TSV, JSON DEGIL: kabukta JSON uretmek tirnak kacirma hatalarina acik;
# alan adlari ve komut satirlari tirnak icerebiliyor. TSV'yi TypeScript
# tarafinda ayristirmak hem daha kisa hem daha guvenli.
#
# CIKTI:
#   CERT<TAB>ad<TAB>alan_adlari_virgullu<TAB>bitis_ISO
#   CRON<TAB>zamanlama<TAB>komut
set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "HATA: root gerekir." >&2; exit 1; }

# --- Sertifikalar ---
# Kaynak certbot'un kendisi: hangi sertifikalar GERCEKTEN var, o biliyor.
# (ssl-renew.sh de ayni kaynagi kullaniyor; veritabani bir alt kume.)
if command -v certbot >/dev/null 2>&1; then
  certbot certificates 2>/dev/null | awk '
    /Certificate Name:/ { name = $3 }
    # Bu certbot surumu "Identifiers:" yaziyor; eski surumler "Domains:".
    # Ikisi de kabul ediliyor, yoksa alan sessizce bos kalir (ilk yazimda
    # tam olarak bu oldu).
    /^[[:space:]]*(Identifiers|Domains):/ {
      $1 = ""; sub(/^ +/, ""); gsub(/ +/, ",", $0); domains = $0
    }
    /Expiry Date:/      { print "CERT\t" name "\t" domains "\t" $3 "T" $4 }
  '
fi

# --- Zamanlanmis isler ---
# Yorumlar ve bos satirlar atlanir; ilk bes alan zamanlama, gerisi komut.
if [ -f /etc/crontabs/devuser ]; then
  awk 'NF && $1 !~ /^#/ {
    sched = $1 " " $2 " " $3 " " $4 " " $5
    cmd = ""
    for (i = 6; i <= NF; i++) cmd = cmd (i > 6 ? " " : "") $i
    print "CRON\t" sched "\t" cmd
  }' /etc/crontabs/devuser
fi
