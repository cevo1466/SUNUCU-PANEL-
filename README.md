# Temiz sunucu paneli kurulumu

Bu depo, mevcut sunucudaki Studio Panel kaynak kodunu ve servislerini **müşteri verisi olmadan** yeni bir Linux VDS'ye kurar. Kurulum canlı sunucunun dosyalarını, veritabanlarını, posta kutularını, sertifikalarını ve anahtarlarını taşımaz.

## Tek komut

Desteklenen temiz x86_64 Linux VDS'de sudo yetkili bir hesapla (`root` iseniz `sudo` önekini çıkarın):

```bash
sudo bash -c 'set -euo pipefail; if ! command -v curl >/dev/null; then if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq curl ca-certificates; elif command -v dnf >/dev/null; then dnf install -y curl ca-certificates; else echo "curl kurulamadı: apt-get veya dnf gerekli" >&2; exit 1; fi; fi; curl -fsSL https://raw.githubusercontent.com/cevo1466/SUNUCU-PANEL-/main/bootstrap.sh | bash'
```

Komut panelin görünen adını, Docker konteyner adını, `su -` ile kullanılacak hesabı, panel ve posta alan adlarını, yetkili DNS adını, yönetici e-postasını ve yönetici parolasını sorar. Henüz alan adın yoksa panel alan adı sorusuna `yok` yaz (varsayılan); posta ve DNS alan adı soruları atlanır. Panel `http://<sunucu-ip>` üzerinden açılır. Yönetici girişi için erişebildiğin gerçek bir e-posta adresi seç. Sonunda `docker exec -it <seçilen-konteyner> sh` ve içeride `su - <seçilen-kullanıcı>` çalışır.

Alan adı olmadan e-posta teslimatı ve güvenilir SSL sertifikası kullanılamaz. IP üzerinden HTTP girişinde parola ve oturum trafiği şifrelenmez; alan adı ve HTTPS hazır olana kadar güvenli erişim için kendi bilgisayarında `ssh -L 8080:127.0.0.1:80 <kullanıcı>@<sunucu-ip>` tüneli açıp `http://localhost:8080` kullan. Alan adı satın alıp panel ve `mail.` A kayıtlarını sunucu IP'sine yönlendirdikten sonra mevcut kurulumu ve verileri silmeden şu komutla ekle:

```bash
sudo bash /opt/studio-panel-installer/configure-domain.sh
```

Kurulum sorularından çıkıldıysa ve `.env` henüz oluşmadıysa aynı GitHub komutu mevcut klonu güncelleyip kurulum sorularını yeniden açar. `.env` oluştuysa mevcut kurulumun durumunu incele; dizini silme.

Depo özel tutulursa anonim `curl` komutu çalışmaz. Bu durumda önce yeni VDS'ye GitHub erişimi tanımlayıp depoyu klonlamak, ardından `sudo bash install.sh` çalıştırmak gerekir.

## Ön koşullar

- Desteklenen sistemler: Ubuntu 22.04/24.04/26.04 LTS, Debian 12/13, AlmaLinux 9/10, Rocky Linux 9/10 ve CentOS Stream 9/10 (x86_64, systemd, apt-get veya dnf). En az 2 vCPU, 4 GB RAM ve 25 GB boş disk gerekir; 40 GB SSD önerilir. LXC/OpenVZ gibi Docker-in-Docker veya ayrıcalıklı konteyner çalıştırmayan sanal sunucular uygun değildir.
- `Temporary failure resolving` görülürse sunucunun DNS/ağ ayarını düzeltin; dağıtım desteği bu bağlantı hatasını gidermez. `getent hosts raw.githubusercontent.com` IP döndürmelidir.
- 21, 25, 53 TCP/UDP, 80, 443, 465, 587, 993, 995 ve 30000–30100 TCP portları VDS sağlayıcısında açık olmalı. Genel IPv4 adresi VDS ağ arayüzüne atanmış olmalıdır; DNS 53 portu yalnız bu IP üzerinde açılır, böylece yerel DNS çözücüsüyle çakışmaz.
- Alan adıyla kurulumda panel ve `mail.<posta-alanı>` A kayıtlarının yeni VDS IP adresine dönmesi gerekir. Kurulum DNS hazırsa Let's Encrypt sertifikalarını otomatik ister; hazır değilse servisleri kurar ve sertifikaların beklediğini bildirir. Alan adı olmayan kurulumda SSL beklemede kalır; panel IP ile HTTP üzerinden erişilebilir.
- DNS kayıtları kurulumdan sonra hazır olursa zamanlayıcı eksik panel ve posta sertifikalarını altı saatte bir tekrar dener; ardından günlük yenileme çalışır.
- Sağlayıcının 25. portu kapatmadığından emin olun. PTR/rDNS, SPF, DKIM ve DMARC kayıtları e-posta teslimatı için ayrıca yapılandırılmalıdır.
- Yerel BIND DNS servisi ve yeni domainler için zone üretimi kurulur. Alan adı kayıt şirketinde NS delegasyonu ve gerekiyorsa glue kaydı ayrıca girilmelidir; ikinci NS kullanılacaksa ayrı bir DNS sunucusu gerekir.
- Bu kurulum ayrı Docker-in-Docker mimarisini kullanır ve konteyneri `privileged` açar; tıpkı incelenen canlı panel gibi. Yeni VDS yalnızca bu panele ayrılmalıdır.
- Konteynere CPU veya RAM için yapay üst sınır konmaz; VDS kaynaklarını kullanır. Host işletim sistemi ve Docker'ın kendi payı her zaman gerekir.

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

