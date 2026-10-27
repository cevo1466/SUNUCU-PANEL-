# Temiz sunucu paneli kurulumu

Bu depo, mevcut sunucudaki Studio Panel kaynak kodunu ve servislerini **müşteri verisi olmadan** yeni bir Ubuntu VDS'ye kurar. Kurulum canlı sunucunun dosyalarını, veritabanlarını, posta kutularını, sertifikalarını ve anahtarlarını taşımaz.

## Tek komut

Depo herkese açık erişimdeyse temiz Ubuntu 24.04/26.04 LTS x86_64 sunucuda root olarak:

```bash
bash -c 'set -euo pipefail; apt-get update -qq; apt-get install -y -qq curl ca-certificates; curl -fsSL https://raw.githubusercontent.com/cevo1466/SUNUCU-PANEL-/main/bootstrap.sh | bash'
```

Komut panelin görünen adını, Docker konteyner adını, `su -` ile kullanılacak hesabı, panel ve posta alan adlarını, yetkili DNS adını, yönetici e-postasını ve yönetici parolasını sorar. Sonunda `docker exec -it <seçilen-konteyner> sh` ve içeride `su - <seçilen-kullanıcı>` çalışır.

Depo özel tutulursa anonim `curl` komutu çalışmaz. Bu durumda önce yeni VDS'ye GitHub erişimi tanımlayıp depoyu klonlamak, ardından `sudo bash install.sh` çalıştırmak gerekir.

## Ön koşullar

- 21, 25, 53 TCP/UDP, 80, 443, 465, 587, 993, 995 ve 30000–30100 TCP portları VDS sağlayıcısında açık olmalı. Genel IPv4 adresi VDS ağ arayüzüne atanmış olmalıdır; DNS 53 portu yalnız bu IP üzerinde açılır, böylece Ubuntu'nun yerel DNS çözücüsüyle çakışmaz.
- Panel alan adının ve `mail.<posta-alanı>` A kayıtlarının yeni VDS IP adresine dönmesi gerekir. Kurulum DNS hazırsa Let's Encrypt sertifikalarını otomatik ister; hazır değilse servisleri kurar ve sertifikaların beklediğini bildirir. Sertifika alınmadan yönetici girişi yapmayın.
- DNS kayıtları kurulumdan sonra hazır olursa zamanlayıcı eksik panel ve posta sertifikalarını altı saatte bir tekrar dener; ardından günlük yenileme çalışır.
- Sağlayıcının 25. portu kapatmadığından emin olun. PTR/rDNS, SPF, DKIM ve DMARC kayıtları e-posta teslimatı için ayrıca yapılandırılmalıdır.
- Yerel BIND DNS servisi ve yeni domainler için zone üretimi kurulur. Alan adı kayıt şirketinde NS delegasyonu ve gerekiyorsa glue kaydı ayrıca girilmelidir; ikinci NS kullanılacaksa ayrı bir DNS sunucusu gerekir.
- Bu kurulum ayrı Docker-in-Docker mimarisini kullanır ve konteyneri `privileged` açar; tıpkı incelenen canlı panel gibi. Yeni VDS yalnızca bu panele ayrılmalıdır.
- Konteynere CPU veya RAM için yapay üst sınır konmaz; VDS kaynaklarını kullanır. Ubuntu ve Docker'ın kendi payı her zaman gerekir.

## Kurulan bileşenler

Next.js web ve webmail, Fastify API, PostgreSQL 16, MariaDB, Redis, PHP-FPM 8.4, Adminer, Nginx iç proxy, BIND9 yetkili DNS, Postfix, Dovecot, OpenDKIM, Pure-FTPd, Certbot ve cron. Günlük yedekleme ile haftalık geri yükleme doğrulaması **Yedekler** ekranından isteğe bağlı açılır; temiz kurulumda kapalıdır. Cloudflare, HetrixTools ve Telegram bağlantıları kullanıcı tarafından daha sonra token eklenince çalışır.

Dosya yöneticisinde `.zip`, `.tar.gz` ve `.tgz` arşivleri yüklenip bulundukları klasöre çıkartılabilir. Yedekleme her domainin dosyalarını, paneldeki domain ayarlarını, posta/FTP hesap özetlerini ve tanımlı veritabanlarının dökümlerini kapsar. Yedekler aynı VDS üzerinde tutulur; başka VDS'ye kopyalama için ayrıca uzak yedek hedefi gerekir.

Cloudflare DNS aktarımı mevcut panel kaynak koduyla birlikte gelir. Yeni sunucuda `/opt/studio-panel-installer/.env` dosyasına `CLOUDFLARE_API_TOKEN` eklendikten sonra kurulum dizininde `docker compose --env-file .env up -d` çalıştırılır. Canlı sunucudaki token ve DNS kayıtları pakete alınmaz; Cloudflare hesabında ilgili zone ve uygun DNS yetkileri gereklidir.

HetrixTools izleme için aynı `.env` dosyasına `HETRIX_API_KEY`; Telegram bildirimleri için `TELEGRAM_BOT_TOKEN` ve `TELEGRAM_CHAT_ID` eklenir. Ardından `docker compose --env-file .env up -d` komutu konteyneri yeni ayarlarla açar. Anahtarlar Git deposuna yazılmaz.

## Yedek kontrolü

Yeni kurulumda otomatik yedekleme kapalıdır. Yönetici panelin **Yedekler** ekranından açtığında tüm domainler günlük 02:40 UTC'de yedeklenir, son yedekler pazar 04:20 UTC'de doğrulanır. Aynı düğmeden kapatılabilir. Ekranda her domain için **Yedek al** düğmesi de vardır; otomatik zamanlayıcıdan bağımsızdır. SSH üzerinden elle çalıştırmak için:

```bash
docker exec <konteyner-adı> su - <kullanıcı-adı> -c 'cd /var/www/vhosts/studio-panel && ops/scripts/backup-run.sh'
docker exec <konteyner-adı> su - <kullanıcı-adı> -c 'cd /var/www/vhosts/studio-panel && ops/scripts/backup-verify.sh'
```

Sonuçlar panelin Yedekler ekranında ve `data/vhosts/studio-panel/ops/backup.log` dosyasında görünür. Veritabanına ulaşılamazsa bu işler hata koduyla çıkar. Arşivleri aynı VDS dışında da saklayın; yalnızca yerel kopya VDS kaybına karşı koruma sağlamaz.

## Yönetim

```bash
docker exec -it <konteyner-adı> sh
su - <kullanıcı-adı>
cd /var/www/vhosts/studio-panel
ops/scripts/service.sh status
```

Host tarafında `cd /opt/studio-panel-installer && docker compose --env-file .env ps` servis durumunu, `docker logs --tail 100 <konteyner-adı>` ilk açılış hatalarını gösterir.

Kurulum dosyası ve veriler `/opt/studio-panel-installer` altındadır. `.env` dosyası yalnızca root tarafından okunur. Sertifikalar ve sistem servisleri `data/state`, iç Docker verisi `data/docker`, panel, site ve yerel yedekler `data/vhosts` altındadır. Bu dizinleri Git'e eklemeyin. Yedeklerin ayrı bir sunucuya kopyalanması ayrıca ayarlanmalıdır.

