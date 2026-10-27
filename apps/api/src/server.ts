import Fastify, { LogController } from "fastify";
import multipart from "@fastify/multipart";
import { env } from "./env.js";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES } from "./lib/files.js";
import dbPlugin from "./plugins/db.js";
import corsPlugin from "./plugins/cors.js";
import authPlugin from "./plugins/auth.js";
import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import metricsRoutes from "./routes/metrics.js";
import domainsRoutes from "./routes/domains.js";
import filesRoutes from "./routes/files.js";
import backupsRoutes from "./routes/backups.js";
import dnsRoutes from "./routes/dns.js";
import sslRoutes from "./routes/ssl.js";
import ftpRoutes from "./routes/ftp.js";
import mailRoutes from "./routes/mail.js";
import webmailRoutes from "./routes/webmail.js";
import databasesRoutes from "./routes/databases.js";
import runtimeRoutes from "./routes/runtime.js";
import adminerRoutes from "./routes/adminer.js";
import { startAlertMonitor } from "./lib/alerts.js";
import { startTelegramBot } from "./lib/telegram-bot.js";

/**
 * Log politikası — bilinçli olarak sessiz.
 *
 * Önceki ayar `logger: true` idi: her istek için iki satır ("incoming request"
 * + "request completed"). Panel kendi kendini sürekli yokluyor — kabuk 15
 * saniyede bir /api/health, kaynak sayfası açıkken /api/metrics/* — yani
 * kimse paneli kullanmasa bile log sonsuza kadar büyüyordu. Bu satırlar
 * dosyaya yazılırken bir yandan da supervisor'ın screen tamponunda BELLEKTE
 * birikiyor; 7 GB'lık bir konteynerde bedava değil.
 *
 * Artık: gürültü yok, olay var. Aşağıdaki onResponse kancası yalnızca sunucu
 * hatalarını yazar. Anlam taşıyan loglar (path-traversal reddi, DB kopması,
 * domain temizlik hatası) zaten warn/error seviyesinde ve olduğu gibi kalıyor.
 */
function loggerOptions() {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    level: process.env.LOG_LEVEL ?? (isProduction ? "warn" : "info"),
  };
}

export async function buildServer() {
  const fastify = Fastify({
    logger: loggerOptions(),
    // Fastify'ın istek-başına iki satırlık otomatik günlüğü kapalı.
    // Üst düzey `disableRequestLogging` seçeneği fastify@6'da kaldırılacak;
    // önerilen yol LogController örneği vermek.
    logController: new LogController({ disableRequestLogging: true }),
  });

  // Beklenmedik istisnaların GERÇEK sebebi.
  //
  // NEDEN VAR: onResponse yalnızca durum kodunu yazıyordu. Bir yükleme
  // EACCES ile patladığında log "statusCode:500" diyor, kullanıcı ise çıplak
  // "Internal Server Error" görüyordu — ne mesaj ne yığın izi vardı, sebep
  // ancak elle deneme yanılmayla bulunabiliyordu. Artık hata sınıfı, kodu ve
  // yığını loga düşer.
  fastify.addHook("onError", async (request, reply, error) => {
    request.log.error(
      {
        method: request.method,
        url: request.url,
        requestId: request.id,
        errName: error.name,
        errCode: (error as NodeJS.ErrnoException).code,
        errMessage: error.message,
        stack: error.stack,
      },
      "istekte yakalanmamış hata",
    );
  });

  // Otomatik günlük kapalı olduğu için sunucu hatalarını burada yakalıyoruz.
  // 4xx yazılmaz: geçersiz girdi ve 401 normal işleyişin parçası, hata değil.
  fastify.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode >= 500) {
      request.log.error(
        {
          method: request.method,
          url: request.url,
          statusCode: reply.statusCode,
          requestId: request.id,
        },
        "istek sunucu hatasıyla sonuçlandı",
      );
    }
  });

  // Boş gövdeli bir "application/json" isteği hata değil, boş nesnedir.
  //
  // Fastify'ın varsayılanı bunu FST_ERR_CTP_EMPTY_JSON_BODY ile 400'e düşürür.
  // Tarayıcı istemcisi başlığı gövdesiz isteklere de koyduğu için silme, yedek
  // alma, config üretme ve çıkış dahil yedi uç kullanılamaz haldeydi. İstemci
  // düzeltildi; bu ayrıştırıcı ise hatanın SINIFINI ortadan kaldırıyor:
  // hangi istemci gelirse gelsin aynı tuzağa bir daha düşülmez.
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      const raw = typeof body === "string" ? body.trim() : "";
      if (!raw) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        const error = err as Error & { statusCode?: number };
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  // Dosya yükleme. Sınır, public Nginx'teki client_max_body_size 50m ile
  // hizalı — büyük dosya panele hiç ulaşmadan Nginx tarafından kesilirdi.
  // files: klasör yüklemesi tek istekte yüzlerce dosya gönderir; her dosya
  // ayrıca kendi göreli yolunu taşıyan bir "relpath" alanı ile geldiğinden
  // fields sınırı da dosya sayısıyla birlikte artar.
  await fastify.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: MAX_UPLOAD_FILES,
      fields: MAX_UPLOAD_FILES + 10,
    },
  });

  await fastify.register(dbPlugin);
  await fastify.register(corsPlugin);
  await fastify.register(authPlugin);

  await fastify.register(healthRoutes);
  await fastify.register(authRoutes);
  await fastify.register(metricsRoutes);
  await fastify.register(domainsRoutes);
  await fastify.register(filesRoutes);
  await fastify.register(backupsRoutes);
  await fastify.register(dnsRoutes);
  await fastify.register(sslRoutes);
  await fastify.register(ftpRoutes);
  await fastify.register(mailRoutes);
  // Webmail: panel kimliginden AYRI bir dunya (bkz. routes/webmail.ts basligi).
  await fastify.register(webmailRoutes);
  await fastify.register(databasesRoutes);
  await fastify.register(runtimeRoutes);
  await fastify.register(adminerRoutes);

  return fastify;
}

async function main() {
  const fastify = await buildServer();

  // SON SAVUNMA HATTI. Node, yakalanmamis bir promise reddinde sureci
  // varsayilan olarak OLDURUR. Panelin API'si tam olarak bunun yuzunden
  // duserek 502 veriyordu: arka plandaki izleme turu HetrixTools'a
  // ulasamadiginda (DNS EAI_AGAIN / ConnectTimeout) red yakalanmiyordu.
  // Kok neden ilgili yerlerde ayrica duzeltildi; burasi bir daha AYNI
  // sinifta bir hata sizarsa panelin ayakta kalmasini garantiler.
  // Hatalar sessizce yutulmaz, loglanir.
  process.on("unhandledRejection", (reason) => {
    fastify.log.error({ err: reason }, "yakalanmamis promise reddi — surec ayakta tutuluyor");
  });
  process.on("uncaughtException", (err) => {
    fastify.log.error({ err }, "yakalanmamis istisna — surec ayakta tutuluyor");
  });
  try {
    await fastify.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  // buildServer()'ın İÇİNDE değil BURADA başlatılır: self-test.ts
  // buildServer()'ı `.inject()` ile test etmek için import edip çağırıyor,
  // main() hiç çalışmıyor. Telegram bot'un long-poll döngüsü unref'siz bir
  // fetch tuttuğu için buildServer() içinde olsaydı self-test process'i asla
  // çıkış yapamazdı (gerçekten yaşandı — self-test "geçti" yazıp sonsuza
  // kadar asılı kaldı, bkz. Oturum notu).
  startAlertMonitor(fastify.pg);
  startTelegramBot();
}

// Bu dosya doğrudan çalıştırıldığında sunucuyu başlat (self-test'in server'ı
// import edip başlatmadan test edebilmesi için `main` otomatik tetiklenmez).
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  main();
} else if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  main();
}
