import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../env.js";
import { assertValidDomainName, domainConfPath, GENERATED_DIR } from "./domain.js";
import { buildLocationBlock, type DomainRuntime } from "./runtime.js";

const TEMPLATE_PATH = path.join(
  PROJECT_ROOT,
  "ops",
  "nginx",
  "templates",
  "vhost.conf.tmpl",
);

/** Canli nginx yapilandirmasi — proxy-server ile paylasilan bind mount. */
const LIVE_CONF_DIR = "/etc/nginx/conf.d";

const STATIC_RUNTIME: DomainRuntime = { runtime_type: "static", php_version: null, proxy_port: null };

/**
 * HTTPS bloğu, sertifika alınana kadar tamamen "# " ile yorumlu tutulur
 * (bkz. vhost.conf.tmpl üstündeki not) — bu yüzden içine gömülecek
 * location bloğunun HER SATIRI da "# " ile başlamalı. ssl-issue.sh
 * sertifika alındıktan sonra tüm bloktan "# "leri tek seferde kaldırıp
 * aktive eder (bkz. ops/scripts/ssl-issue.sh). Önceden bu placeholder
 * yerine sabit bir örnek + "elle kopyalayın" talimatı vardı; talimat
 * cümlesi de "# " ile başladığından ssl-issue.sh onu da yorumdan çıkarıp
 * geçersiz bir nginx direktifine çeviriyordu (bkz. MEMORY.md 2026-08-28,
 * test.diger.test PHP/proxy vhost'unda `nginx -t` "(PHP/proxy" hatası).
 */
function commentEachLine(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `# ${line}` : "#"))
    .join("\n");
}

/**
 * vhost'un `server_name` listesi: alan adının kendisi + `www.` alternatifi.
 *
 * NEDEN: kullanıcı `www.alanadi.com` yazdığında site açılmıyordu. DNS'te www
 * kaydı panelin kendisi tarafından zaten oluşturuluyor (bkz. dnsProvision.ts
 * buildDefaultDnsRecords), ama nginx o adı tanımadığı için istek catch-all'a
 * düşüyordu — 443'te catch-all `ssl_reject_handshake on` olduğu için tarayıcı
 * doğrudan bağlantı hatası görüyordu.
 *
 * Zaten `www.` ile başlayan bir alan adına ikinci bir `www.` eklenmez.
 */
export function serverNamesFor(domainName: string): string {
  return domainName.startsWith("www.") ? domainName : `${domainName} www.${domainName}`;
}

/**
 * `https://www.<domain>` → `https://<domain>` yönlendiren 443 bloğu.
 *
 * Ayrı bir server bloğu OLMAK ZORUNDA: www'yi içerik bloğunun ikinci adı
 * yapmak daha kısa olurdu ama o zaman www 200 dönerdi, 301 değil. Aynı içerik
 * iki adreste yayınlanır ve kanonik adres diye bir şey kalmazdı.
 *
 * Sertifika apex ile AYNI dosyadır — ssl-issue.sh www'yi SAN'a ekliyor
 * (çözümleniyorsa). Eklenmemişse tarayıcı bu bloğa geldiğinde ad uyuşmazlığı
 * uyarısı verir; bu, yönlendirmenin değil sertifikanın eksiği ve panelde
 * "Sertifikayı yenile" ile kapanır.
 *
 * Alan adı zaten `www.` ile başlıyorsa blok üretilmez.
 */
function buildWwwRedirectBlock(domainName: string): string {
  if (domainName.startsWith("www.")) return "";
  return `server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name www.${domainName};

    ssl_certificate     /etc/letsencrypt/live/${domainName}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domainName}/privkey.pem;

    # HSTS YONLENDIRMEDE DE GEREKLI. Ziyaretci once www adresine gelirse
    # politikayi burada ogrenmeli; yalnizca apex'e koymak, www uzerinden
    # gelen ilk istegi korumasiz birakirdi. "always" olmadan nginx basligi
    # 3xx yanitlara EKLEMEZ ve bu blok tamamen 301 donduruyor — yani basligi
    # hic gondermezdi.
    add_header Strict-Transport-Security "${HSTS_VALUE}" always;

    return 301 https://${domainName}$request_uri;
}`;
}

/**
 * HSTS (Strict-Transport-Security) değeri.
 *
 * Varsayılan bir yıl. Tarayıcı bu süre boyunca alan adına YALNIZCA HTTPS ile
 * bağlanır; araya girip düz HTTP'ye düşürme saldırısı (SSL stripping) bu
 * pencerede işlemez. Tarama araçları "HSTS yok" derken tam olarak bunun
 * eksikliğini işaret ediyor.
 *
 * `includeSubDomains` ve `preload` varsayılanda YOK — ikisi de geri dönüşü
 * çok pahalı kararlar. Ölçülmüş somut örnek: `webmail.testsite.ornek.test`
 * origin'de geçerli sertifikaya sahip ama Cloudflare'in ücretsiz Universal
 * SSL'i iki seviyeli alt alan adını kapsamadığı için kenar TLS'i düşüyor;
 * includeSubDomains açık olsaydı o adres tarayıcıda bir yıl boyunca tamamen
 * erişilemez hale gelirdi. Aynı şekilde `mail.<domain>` yalnızca SMTP için
 * var, HTTPS vhost'u yok.
 *
 * Bütün alt alan adlarının sertifikası olduğundan eminseniz
 * `STUDIO_PANEL_HSTS` ile güçlendirebilirsiniz, örneğin:
 *   STUDIO_PANEL_HSTS="max-age=31536000; includeSubDomains"
 */
const HSTS_VALUE = process.env.STUDIO_PANEL_HSTS ?? "max-age=31536000";

/** Şablondaki HTTPS bölümünün başladığı işaret satırı. */
const HTTPS_MARKER = "--- HTTPS (443, HTTP/2)";

/**
 * Render edilmiş vhost'un yorumlu HTTPS bölümünü aktif hâle getirir: işaret
 * satırından SONRASINI alır ve her satırın başındaki "# " işaretini kaldırır.
 * Geriye kalan metin HTTPS server bloğu + HTTP→HTTPS yönlendirme bloğudur;
 * yani çıktı, dosyanın TAMAMININ yerini alır (şablonun ilk düz HTTP bloğu
 * yönlendirme bloğuyla değişir).
 *
 * AYNI KURAL ops/scripts/ssl-issue.sh içinde de var (sed ile). İkisi birlikte
 * değişmeli; self-test ikisinin aynı sonucu ürettiğini doğrular.
 */
export function activateHttps(content: string): string | null {
  const index = content.indexOf(HTTPS_MARKER);
  if (index < 0) return null;
  const afterMarkerLine = content.indexOf("\n", index);
  if (afterMarkerLine < 0) return null;
  const activated = content
    .slice(afterMarkerLine + 1)
    .split("\n")
    .map((line) => line.replace(/^# ?/, ""))
    .join("\n")
    .replace(/\n+$/, "");
  return activated.length > 0 ? activated + "\n" : null;
}

/**
 * Bu domain ŞU AN gerçekten HTTPS yayınında mı?
 *
 * Panelin `domains.ssl_status` kaydına DEĞİL, nginx'in okuduğu dosyaya bakar —
 * bu projede tekrar eden hata sınıfı tam olarak "kayıt X diyor, gerçek Y"
 * (bkz. port_healthy, ftp-ctl, webmailHasHttps). /etc/nginx/conf.d dünyaya
 * okunabilir, /etc/letsencrypt/live ise 0700 root: ikincisine bakmak izin
 * hatasını "sertifika yok" diye okurdu.
 */
export function httpsIsLive(domainName: string): boolean {
  try {
    const conf = fsSync.readFileSync(path.join(LIVE_CONF_DIR, `${domainName}.conf`), "utf8");
    // YORUMSUZ bir direktif aranir. Şablonun kendi HTTPS bloğu dosyada
    // "#     listen 443 ssl;" olarak duruyor ve üstteki açıklama metninde de
    // aynı ifade geçiyor; düz `includes` sertifikasız her vhost'u "HTTPS"
    // sayardı (aynı hata 2026-09-01'de ssl-issue.sh'ın grep'inde yaşandı ve
    // testsite.ornek.test'da HTTPS'in hiç açılmamasına yol açtı).
    return /^[ \t]*listen[ \t]+443[ \t]+ssl/m.test(conf);
  } catch {
    return false;
  }
}

/** Panelden yüklenen (ücretli CA) sertifikaların dizini — bkz. ops/scripts/ssl-custom.sh. */
export function customCertDir(domainName: string): string {
  return `/etc/letsencrypt/custom/${domainName}`;
}

/**
 * Canlı vhost ŞU AN özel (ücretli CA) sertifikayı mı gösteriyor?
 *
 * Şablon sertifika yolunu her zaman `live/<domain>/` (Let's Encrypt) olarak
 * üretir. Özel sertifikalı bir domainde "Nginx config üret" bunu körlemesine
 * yazsaydı, satın alınmış sertifika sessizce Let's Encrypt yoluna düşerdi —
 * httpsIsLive() ile aynı tuzak sınıfı. Canlı dosyaya bakılır, DB'ye değil.
 */
export function customCertIsLive(domainName: string): boolean {
  try {
    const conf = fsSync.readFileSync(path.join(LIVE_CONF_DIR, `${domainName}.conf`), "utf8");
    return conf.includes(`${customCertDir(domainName)}/`);
  } catch {
    return false;
  }
}

export async function renderVhostConfig(
  domainName: string,
  documentRoot: string,
  runtime: DomainRuntime = STATIC_RUNTIME,
  options: { forceHttp?: boolean } = {},
): Promise<{ path: string; content: string; https: boolean }> {
  assertValidDomainName(domainName);

  const template = await fs.readFile(TEMPLATE_PATH, "utf8");
  const locationBlock = buildLocationBlock(runtime);
  const rendered = template
    .replaceAll("{{HSTS_VALUE}}", HSTS_VALUE)
    .replaceAll("{{SERVER_NAMES}}", serverNamesFor(domainName))
    .replaceAll("{{DOMAIN}}", domainName)
    .replaceAll("{{DOCUMENT_ROOT}}", documentRoot)
    .replaceAll("{{LOCATION_BLOCK}}", locationBlock)
    .replaceAll("{{LOCATION_BLOCK_HTTPS}}", commentEachLine(locationBlock))
    // HTTPS bolumunun tamami yorumlu duruyor; bu blok da oyle uretilmeli,
    // yoksa sertifika alinmadan once `listen 443 ssl` gecerli bir sertifika
    // olmadan devreye girer ve `nginx -t` duser.
    .replaceAll("{{WWW_REDIRECT_HTTPS}}", commentEachLine(buildWwwRedirectBlock(domainName)));

  // SERTİFİKA VARSA HTTPS'İ KORU.
  //
  // Şablon HTTPS bloğunu her zaman yorumlu üretir. Bu, sertifikası olan bir
  // domainde runtime değiştirmenin (ya da "Nginx config üret" demenin) siteyi
  // sessizce düz HTTP'ye düşürmesi demekti: config yeniden üretiliyor,
  // deploy-vhost.sh onu canlıya kopyalıyor ve 443 bloğu kayboluyordu.
  // Sertifika alma tek tıka indiği için bu tuzağa düşmek de kolaylaştı.
  // forceHttp: özel sertifika kaldırılırken geri dönülecek Let's Encrypt
  // sertifikası yoksa vhost bilinçli olarak düz HTTP'ye çevrilir.
  const https = !options.forceHttp && httpsIsLive(domainName);
  let content = https ? (activateHttps(rendered) ?? rendered) : rendered;
  if (https && customCertIsLive(domainName)) {
    content = content.replaceAll(
      `/etc/letsencrypt/live/${domainName}/`,
      `${customCertDir(domainName)}/`,
    );
  }

  const outPath = domainConfPath(domainName);
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  await fs.writeFile(outPath, content, "utf8");

  return { path: outPath, content, https };
}
