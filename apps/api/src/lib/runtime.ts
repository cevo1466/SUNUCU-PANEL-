import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RuntimeType = "static" | "php" | "proxy";

export interface DomainRuntime {
  runtime_type: RuntimeType;
  php_version: string | null;
  proxy_port: number | null;
}

/**
 * Sunucuda kurulu PHP-FPM sürümlerini keşfeder. Alpine (`/etc/phpN.M` veya
 * `/etc/php/N.M`) ve Debian/Ubuntu (`/etc/php/N.M`) düzenlerinin ikisini de
 * dener. Hiçbiri yoksa BOŞ liste döner — "kurulu gibi davranmaz" (bkz.
 * databases.ts'teki dürüstlük kuralı). Kullanıcı yine de elle bir sürüm
 * numarası girip kaydedebilir; nginx config üretimi bunu doğrulamaz, PHP-FPM
 * soketi gerçekten yoksa 502 alır — bu, panelin sahte bir "kurulu" izlenimi
 * vermesinden daha dürüst bir başarısızlık modudur.
 */
export async function discoverPhpVersions(): Promise<string[]> {
  const found = new Set<string>();
  try {
    const { stdout } = await execFileAsync("sh", [
      "-c",
      "ls -d /etc/php/[0-9].[0-9] /etc/php[0-9].[0-9] 2>/dev/null || true",
    ]);
    for (const line of stdout.split("\n")) {
      const match = line.trim().match(/(\d\.\d)$/);
      if (match) found.add(match[1]);
    }
  } catch {
    // execFile'ın kendisi başarısız olursa (sh yoksa) sessizce boş liste döner.
  }
  return Array.from(found).sort();
}

const PHP_VERSION_PATTERN = /^\d\.\d{1,2}$/;

export class RuntimeError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function validateRuntimeInput(input: {
  runtime_type: string;
  php_version?: string | null;
  proxy_port?: number | null;
}): DomainRuntime {
  if (input.runtime_type === "php") {
    if (!input.php_version || !PHP_VERSION_PATTERN.test(input.php_version)) {
      throw new RuntimeError('PHP seçildiğinde "8.2" biçiminde bir sürüm gerekli.', 400);
    }
    return { runtime_type: "php", php_version: input.php_version, proxy_port: null };
  }
  if (input.runtime_type === "proxy") {
    const port = input.proxy_port;
    if (!port || !Number.isInteger(port) || port <= 0 || port >= 65536) {
      throw new RuntimeError("Proxy seçildiğinde 1-65535 arası bir port gerekli.", 400);
    }
    return { runtime_type: "proxy", php_version: null, proxy_port: port };
  }
  if (input.runtime_type === "static") {
    return { runtime_type: "static", php_version: null, proxy_port: null };
  }
  throw new RuntimeError('runtime_type "static", "php" veya "proxy" olmalı.', 400);
}

/** ops/nginx/templates/vhost.conf.tmpl içindeki {{LOCATION_BLOCK}} yer
 * tutucusunu doldurur. Girinti şablonla hizalı (8 boşluk). */
/**
 * Nginx'in bu konteynere ulaştığı adres.
 *
 * GERÇEK NGINX BU KONTEYNERDE DEĞİL: ayrı bir Docker konteynerinde
 * (`proxy-server`) çalışıyor ve yalnızca /var/www/vhosts ile /etc/nginx/conf.d
 * bind-mount edilmiş. Bunun iki sonucu var ve ikisi de 2026-09-01'e kadar
 * gözden kaçmıştı:
 *
 *   1. `unix:/run/php/...` — /run PAYLAŞILMIYOR, nginx o soketi hiçbir zaman
 *      açamaz. PHP runtime'ı her istekte 502 veriyordu.
 *   2. `http://127.0.0.1:<port>` — nginx için 127.0.0.1 KENDİ konteyneri.
 *      Proxy runtime'ı da aynı şekilde 502 veriyordu.
 *
 * Doğru adres Docker köprüsünün bu taraftaki ucu. Panelin kendi vhost'u
 * (/etc/nginx/conf.d/studio-panel.conf) ve webmail bloğu zaten bunu
 * kullanıyordu; runtime bloğu geride kalmıştı.
 */
const NGINX_UPSTREAM_HOST = process.env.NGINX_UPSTREAM_HOST ?? "172.19.0.1";
/** php-fpm havuzunun dinlediği port — /etc/php84/php-fpm.d/studio-panel.conf. */
const PHP_FPM_PORT = Number(process.env.PHP_FPM_PORT ?? 9000);

/**
 * Hijyen kuralı (2026-09-27, kullanıcı onayı): yedek, geçici editör, log ve
 * kilit dosyaları web kökünde unutulsa bile asla sunulmaz. `.md` BİLEREK
 * YOK — bazı siteler Markdown dosyasını içerik olarak sunabilir. Regex
 * location'ı `location /` önekinden önce eşleşir, proxy ve PHP sitelerinde de
 * geçerlidir. Regex tırnaklı: tırnaksız `{`/`}` nginx'te blok sınırı sayılır.
 */
export const HYGIENE_DENY_BLOCK = [
  "    # Yedek, gecici, log ve kilit dosyalari asla sunulmaz (hijyen kurali).",
  '    location ~* "(\\.(bak|orig|swp|log)|-lock\\.json|\\.bak-[a-z0-9]+)$" { deny all; }',
  "",
].join("\n");

export function buildLocationBlock(runtime: DomainRuntime): string {
  return HYGIENE_DENY_BLOCK + buildRuntimeLocationBlock(runtime);
}

function buildRuntimeLocationBlock(runtime: DomainRuntime): string {
  if (runtime.runtime_type === "php") {
    return [
      "    location / {",
      "        try_files $uri $uri/ /index.php?$query_string;",
      "    }",
      "",
      "    location ~ \\.php$ {",
      "        include fastcgi_params;",
      `        fastcgi_pass ${NGINX_UPSTREAM_HOST}:${PHP_FPM_PORT};`,
      "        fastcgi_index index.php;",
      "        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;",
      "    }",
    ].join("\n");
  }
  if (runtime.runtime_type === "proxy") {
    return [
      "    location / {",
      `        proxy_pass http://${NGINX_UPSTREAM_HOST}:${runtime.proxy_port};`,
      "        proxy_http_version 1.1;",
      "        proxy_set_header Host $host;",
      "        proxy_set_header X-Real-IP $remote_addr;",
      "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
      "        proxy_set_header X-Forwarded-Proto $scheme;",
      "        proxy_set_header Upgrade $http_upgrade;",
      '        proxy_set_header Connection "upgrade";',
      "    }",
    ].join("\n");
  }
  return ["    location / {", "        try_files $uri $uri/ =404;", "    }"].join("\n");
}
