import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { startEmbeddedDb, runMigrations } from "@studio-panel/db";
import { buildServer } from "./server.js";
import { env, PROJECT_ROOT } from "./env.js";
import { GENERATED_DIR } from "./lib/domain.js";
import { CloudflareClient, resetCloudflareClient } from "./lib/cloudflare.js";
import { buildDefaultDnsRecords, toCloudflarePayload } from "./lib/dnsProvision.js";
import { dkimPrivateKeyPath } from "./lib/dkim.js";
import { renderZoneFile, isZoneGenerated, isZoneDeployed, zoneFilePath, deployedZonePath } from "./lib/localDns.js";
import { activateHttps, serverNamesFor } from "./lib/nginxTemplate.js";
import { parseInfo, parseResult } from "./lib/ssl-custom.js";
import { buildLocationBlock } from "./lib/runtime.js";
import type { Response as InjectResponse } from "light-my-request";
import { checkResources, checkUptime, checkLocalServices, isBadWithDeadband } from "./lib/alerts.js";
import { decideUptime, initialUptimeState } from "./lib/uptime-policy.js";
import { autoconfigLeftovers, findDnsConflicts } from "./lib/dns-conflicts.js";
import { runWebmailSelfTest } from "./lib/webmail-self-test.js";
import { runBackupSelfTest } from "./lib/backup-self-test.js";

// Gerçek gömülü PostgreSQL + gerçek Fastify server (fastify.inject) ile
// uçtan uca doğrulama. Mock yok.

const execFileAsync = promisify(execFile);

/**
 * Kök dizinin dışına yazmaya çalışan tar.gz üretir.
 *
 * Bu arşivler ELLE kuruluyor çünkü konteynerdeki busybox `tar`/`unzip`,
 * arşiv oluştururken üye adının başındaki "../" önekini siliyor: araçla
 * "kötü arşiv" üretmek imkânsız, üretilse bile listede zararsız görünür.
 * Saldırıyı gerçekten kurmak için baytları kendimiz yazıyoruz.
 */
function makeMaliciousTarGz(memberName: string): Buffer {
  const payload = Buffer.from("KACTI\n");
  const header = Buffer.alloc(512);
  header.write(memberName, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(payload.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136);
  header.write("        ", 148); // checksum alanı önce boşlukla doldurulur
  header.write("0", 156); // typeflag: normal dosya
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);

  return zlib.gzipSync(
    Buffer.concat([
      header,
      payload,
      Buffer.alloc(512 - payload.length),
      Buffer.alloc(1024), // arşiv sonu: iki boş blok
    ]),
  );
}

/** Kök dizinin dışına yazmaya çalışan zip üretir. */
function makeMaliciousZip(memberName: string): Buffer {
  const name = Buffer.from(memberName, "utf8");
  const data = Buffer.from("KACTI\n");

  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(data.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(name.length, 26);
  const local = Buffer.concat([localHeader, name, data]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(data.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(name.length, 28);
  centralHeader.writeUInt32LE(0, 42);
  const central = Buffer.concat([centralHeader, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);

  return Buffer.concat([local, central, eocd]);
}

/**
 * Testi GERÇEK bir TCP soketi üzerinden çalıştırır.
 *
 * `fastify.inject()` isteği sunucuya bellek içinde verir ve payload yoksa
 * Content-Type başlığını hiç göndermez. Tarayıcı ise başlığı her zaman
 * gönderiyordu. Gövdesiz uçlardaki 400 hatası tam bu farkın içinde saklandı;
 * bu yüzden sözleşme testleri inject değil fetch kullanıyor.
 */
async function withHttpServer(run: (origin: string) => Promise<void>): Promise<void> {
  const server = await buildServer();
  // Port 0: işletim sistemi boş bir port versin, çalışan panele çarpmayalım.
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  if (!address || typeof address === "string") {
    await server.close();
    throw new Error("Test sunucusu için port alınamadı.");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await server.close();
  }
}

async function main() {
  const pg = await startEmbeddedDb();
  let server: Awaited<ReturnType<typeof buildServer>> | undefined;
  try {
    await runMigrations();

    server = await buildServer();
    await server.ready();

    // health
    const health = await server.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200, `health beklenmeyen kod: ${health.statusCode}`);
    assert.equal(health.json().status, "ok");

    // register
    const email = `selftest+${Date.now()}@example.invalid`;
    const register = await server.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: `selftest_${Date.now()}`, email, password: "correct-horse-battery" },
    });
    assert.equal(register.statusCode, 201, `register beklenmeyen kod: ${register.statusCode} ${register.body}`);
    const setCookie = register.cookies.find((c) => c.name === "studio_session");
    assert.ok(setCookie, "register sonrası session cookie set edilmedi");

    // me (cookie ile)
    const me = await server.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { studio_session: setCookie!.value },
    });
    assert.equal(me.statusCode, 200, `me beklenmeyen kod: ${me.statusCode}`);
    assert.equal(me.json().user.email, email);

    // me (cookie olmadan) -> 401
    const meUnauth = await server.inject({ method: "GET", url: "/api/auth/me" });
    assert.equal(meUnauth.statusCode, 401);

    // login yanlış parola -> 401
    const badLogin = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "wrong-password" },
    });
    assert.equal(badLogin.statusCode, 401);

    // metrics uçları da diğer veri rotaları gibi oturum ister
    const sessionCookies = { studio_session: setCookie!.value };
    const metricsUnauth = await server.inject({ method: "GET", url: "/api/metrics/resources" });
    assert.equal(metricsUnauth.statusCode, 401, "metrics oturumsuz erişime kapalı olmalı");

    // cgroup metrics — gerçek dosyalardan okunuyor
    const metrics = await server.inject({
      method: "GET",
      url: "/api/metrics/resources",
      cookies: sessionCookies,
    });
    assert.equal(metrics.statusCode, 200, `metrics beklenmeyen kod: ${metrics.statusCode} ${metrics.body}`);
    const metricsBody = metrics.json();
    assert.ok(typeof metricsBody.memory.usedBytes === "number");
    assert.ok(typeof metricsBody.disk.totalBytes === "number");
    assert.ok(typeof metricsBody.cpu.usageUsec === "number", "cpu.stat > usage_usec okunmalı");
    assert.ok(metricsBody.cpu.vcpus > 0, "cpu.max'tan vCPU sayısı hesaplanmalı");

    // geçmiş tamponu — örnekleyici en az bir örnek üretmiş olmalı
    const history = await server.inject({
      method: "GET",
      url: "/api/metrics/history?range=5m",
      cookies: sessionCookies,
    });
    assert.equal(history.statusCode, 200, `history beklenmeyen kod: ${history.statusCode} ${history.body}`);
    const historyBody = history.json();
    assert.ok(Array.isArray(historyBody.samples), "history.samples dizi olmalı");
    assert.ok(historyBody.samples.length >= 1, "örnekleyici en az bir örnek üretmeli");
    assert.equal(typeof historyBody.samples[0].t, "number");
    assert.equal(typeof historyBody.samples[0].memUsedBytes, "number");

    const badRange = await server.inject({
      method: "GET",
      url: "/api/metrics/history?range=99y",
      cookies: sessionCookies,
    });
    assert.equal(badRange.statusCode, 400, "geçersiz aralık 400 dönmeli");

    // hetrix uptime — gerçek HTTP isteği (Bearer header, doğru endpoint — bkz.
    // MEMORY.md Oturum 5: önceki path/trailing-slash hatası düzeltildi).
    const uptime = await server.inject({
      method: "GET",
      url: "/api/metrics/uptime",
      cookies: sessionCookies,
    });
    console.log("HetrixTools /api/metrics/uptime yanıtı:", uptime.body);
    assert.equal(uptime.statusCode, 200, `hetrix route beklenmeyen kod: ${uptime.statusCode} ${uptime.body}`);
    if (process.env.HETRIX_API_KEY) {
      assert.equal(uptime.json().status, "ok", "HetrixTools monitör listesi dönmeli");
      assert.ok(Array.isArray(uptime.json().monitors));
    } else {
      assert.equal(uptime.json().status, "not_configured", "HetrixTools tokenı olmayan temiz kurulum düzgün durum dönmeli");
    }

    // --- REGRESYON: ucuncu taraf ag hatasi API'yi COKERTMEMELI ---
    //
    // Gercekten yasandi (ops/api.log): HetrixTools'a giden istek
    // `getaddrinfo EAI_AGAIN` / `ConnectTimeoutError` ile reddedildi. Arka
    // plandaki izleme turu `void checkUptime()` seklinde cagriliyordu;
    // yakalanmayan promise reddini Node varsayilan olarak surec olumuyle
    // cezalandirir. Sonuc: panelin API'si oldu ve panel 502 verdi.
    {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (() =>
        Promise.reject(new TypeError("fetch failed"))) as typeof globalThis.fetch;
      try {
        await assert.doesNotReject(
          () => checkUptime(),
          "ag hatasinda checkUptime() REDDETMEMELI — reddederse surec coker",
        );
        await assert.doesNotReject(
          () => checkResources(),
          "ag hatasinda checkResources() REDDETMEMELI — reddederse surec coker",
        );
        await assert.doesNotReject(
          () => checkLocalServices(server!.pg),
          "fetch basarisizken checkLocalServices() REDDETMEMELI (web/edge kontrolleri fetch kullanir)",
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    }

    // --- REGRESYON: yerel servis saglik kontrolu gercek DB'yi dogru okur ---
    //
    // Kullanici talebi (2026-08-28 ikinci tur): "Nginx / Docker / DB veya ana
    // backend servisi durursa ... aninda bildir". checkLocalServices'in
    // veritabani bacagi (dbHealthy) gercek bir SELECT 1 calistirir — self-test
    // gercek gomulu PostgreSQL'e karsi calistigi icin bu GERCEK bir baglanti
    // dogrulamasidir, mock degil.
    {
      await assert.doesNotReject(
        () => checkLocalServices(server!.pg),
        "gercek DB baglantisiyla checkLocalServices() calismali (web/edge fetch başarısız olsa bile)",
      );
    }

    // --- REGRESYON: uptime bildirim politikasi (asil sikayetin testi) ---
    //
    // Kullanici: "surekli hetrix bildirimi geliyor hem mail hem telegram,
    // rahatsiz edici; gercek bir downda ya da belli bir yuzdeye ulastiginda
    // atilsin". Monitor 22. portu 5 sn timeout ile dakikada bir yokluyor ve
    // yuk altinda timeout'a takilip hemen geri geliyor. Asagidaki testler
    // bu titremenin ARTIK MESAJ URETEMEDIGINI kanitlar.
    //
    // Sahte saatle calisir: gercek bir kesinti beklenmez, saniyeler surer.
    {
      // resolveAfterMinutes=3, stillDownSummaryMinutes=30 — 2026-08-28 ikinci
      // tur talebi: "duzelme aninda degil en az 3 dk stabil kalinca RESOLVED",
      // "cokuk kaldigi surece 30 dk'da bir ozet".
      const cfg = { downAfterMinutes: 5, uptimePercentMin: 99.5, resolveAfterMinutes: 3, stillDownSummaryMinutes: 30 };
      const MIN = 60_000;
      const steady = { uptimePercent: 100 };

      // 1) 1 dakikalik down->up titremesi: HICBIR mesaj cikmamali.
      {
        let st = initialUptimeState();
        let t = 1_000_000;
        const produced: string[] = [];
        for (let i = 0; i < 20; i += 1) {
          const status = i % 2 === 0 ? "down" : "up";
          const r = decideUptime(st, { status, ...steady }, t, cfg);
          st = r.state;
          produced.push(...r.decisions.map((d) => d.kind));
          t += MIN;
        }
        assert.deepEqual(
          produced,
          [],
          "1 dakikalik down/up titremesi HIC mesaj uretmemeli — spam'in kok nedeni buydu",
        );
      }

      // 2) 5 dakika kesintisiz down: TAM BIR "down" mesaji.
      {
        let st = initialUptimeState();
        let t = 2_000_000;
        const kinds: string[] = [];
        for (let i = 0; i < 8; i += 1) {
          const r = decideUptime(st, { status: "down", ...steady }, t, cfg);
          st = r.state;
          kinds.push(...r.decisions.map((d) => d.kind));
          t += MIN;
        }
        assert.deepEqual(
          kinds,
          ["down"],
          "kesintisiz down 8 dakika surdu — tam BIR uyari cikmali, her turda degil",
        );

        // 3) Ilk "up": HENUZ resolved degil — stabilite bekleniyor, sessiz.
        const firstUp = decideUptime(st, { status: "up", ...steady }, t, cfg);
        assert.deepEqual(
          firstUp.decisions,
          [],
          "ilk up ANINDA resolved uretmemeli — once stabilite (resolveAfterMinutes) beklenmeli",
        );
        st = firstUp.state;
        t += MIN;

        // 3b) Stabilite penceresi icinde tekrar dusrse (flap): hala sessiz,
        //     kesinti AYNI kesinti sayilmaya devam eder (downSince korunur).
        const flapBack = decideUptime(st, { status: "down", ...steady }, t, cfg);
        assert.deepEqual(flapBack.decisions, [], "stabilite penceresinde flap sessiz kalmali");
        st = flapBack.state;
        t += MIN;

        // 3c) Simdi kesintisiz resolveAfterMinutes (3 dk) ayakta kalsin ->
        //     TAM BIR "up" (RESOLVED) mesaji, gercek kesinti suresiyle.
        //     upSince ILK "up" cagrisinda (stableMinutes=0) set edilir; 3.
        //     dakikaya ulasmak icin TOPLAM 4 cagri gerekir (0,1,2,3 dk).
        let rec: ReturnType<typeof decideUptime> | null = null;
        for (let i = 0; i < 4; i += 1) {
          rec = decideUptime(st, { status: "up", ...steady }, t, cfg);
          st = rec.state;
          t += MIN;
        }
        assert.ok(rec);
        assert.equal(rec!.decisions.length, 1, "3 dk kesintisiz stabiliteden sonra tam bir RESOLVED mesaji gitmeli");
        assert.equal(rec!.decisions[0].kind, "up");
        assert.ok(
          rec!.decisions[0].kind === "up" && rec!.decisions[0].outageMinutes >= 7,
          "kesinti suresi (ilk down'dan gercek duzelme anina kadar) raporlanmali",
        );

        // 4) Duzelmeden sonra tekrar up: sessiz.
        const after = decideUptime(st, { status: "up", ...steady }, t, cfg);
        assert.deepEqual(after.decisions, [], "duzeldikten sonra tekrar mesaj gitmemeli");
      }

      // 5) Bildirilmemis bir kesintiden sonra gelen "up" sessiz kalmali —
      //    kullaniciya hic duymadigi bir sorunun cozuldugu soylenmemeli.
      // Stabilite penceresi de gerekmez (hic "down" bildirilmediyse ilk up'ta aninda temizlenir).
      {
        let st = initialUptimeState();
        const t = 3_000_000;
        st = decideUptime(st, { status: "down", ...steady }, t, cfg).state;
        const r = decideUptime(st, { status: "up", ...steady }, t + 2 * MIN, cfg);
        assert.deepEqual(r.decisions, [], "esik asilmadan duzelen kesinti sessiz gecmeli");
      }

      // 6) HALA-DOWN OZETI: "down" ilk bildirimden SONRA 30 dk'da bir TEK
      //    "still-down" ozeti gider, arada sessiz.
      //    downSince m=1'de baslar (elapsed=0 o turda); elapsed = m-1 dk.
      //    down: elapsed>=5 -> m=6. sonraki still-down: son bildirimden
      //    30 dk sonra -> m=36, sonra m=66.
      {
        let st = initialUptimeState();
        let t = 5_000_000;
        const timeline: Array<{ minute: number; kinds: string[] }> = [];
        for (let minute = 1; minute <= 66; minute += 1) {
          const r = decideUptime(st, { status: "down", ...steady }, t, cfg);
          st = r.state;
          if (r.decisions.length > 0) timeline.push({ minute, kinds: r.decisions.map((d) => d.kind) });
          t += MIN;
        }
        assert.deepEqual(
          timeline,
          [
            { minute: 6, kinds: ["down"] },
            { minute: 36, kinds: ["still-down"] },
            { minute: 66, kinds: ["still-down"] },
          ],
          "ilk down bildirildikten sonra 30 dk'da bir TEK still-down ozeti gitmeli — arada sessiz",
        );
      }

      // 7) Yuzde esigi: bir kez uyarir, histerezisle yeniden silahlanir.
      {
        let st = initialUptimeState();
        const t = 4_000_000;
        const r1 = decideUptime(st, { status: "up", uptimePercent: 99.4 }, t, cfg);
        assert.deepEqual(
          r1.decisions.map((d) => d.kind),
          ["percent"],
          "yuzde esigin altina dusunce bir kez uyarmali",
        );
        st = r1.state;
        const r2 = decideUptime(st, { status: "up", uptimePercent: 99.3 }, t + MIN, cfg);
        assert.deepEqual(r2.decisions, [], "yuzde uyarisi tekrarlanmamali");
        st = r2.state;
        // Esigin hemen ustu yeniden silahlamaya YETMEZ (histerezis payi).
        const r3 = decideUptime(st, { status: "up", uptimePercent: 99.55 }, t + 2 * MIN, cfg);
        assert.deepEqual(r3.decisions, [], "histerezis payi icinde yeni mesaj olmamali");
        st = r3.state;
        // Pay asildi -> yeniden silahlanir; tekrar dusunce yeniden uyarir.
        st = decideUptime(st, { status: "up", uptimePercent: 99.9 }, t + 3 * MIN, cfg).state;
        const r5 = decideUptime(st, { status: "up", uptimePercent: 99.1 }, t + 4 * MIN, cfg);
        assert.deepEqual(
          r5.decisions.map((d) => d.kind),
          ["percent"],
          "toparlanip yeniden dusunce tekrar uyarmali",
        );
      }
      console.log("✓ uptime bildirim politikasi self-test geçti (titreme susuyor, stabil dogrulanmis kesinti bildiriliyor, uzun kesintide periyodik ozet var)");
    }

    // --- REGRESYON: alarm olu bandi (flap koruması) ---
    //
    // Tek esikli karsilastirma, kullanim esigin etrafinda gezinirken her
    // turda "UYARI"/"NORMALE DONDU" cifti uretiyordu. Olu bant bunu yapisal
    // olarak imkansiz kilar: alarm PASIFken uyari esigi, AKTIFken (daha
    // dusuk) kurtulma esigi kullanilir.
    {
      // Pasif durumda: esigin altindaki deger uyari uretmemeli.
      assert.equal(
        isBadWithDeadband("__test_deadband", 85, 90, 80),
        false,
        "alarm pasifken %85, %90 esiginin altinda — uyari olmamali",
      );
      assert.equal(
        isBadWithDeadband("__test_deadband", 91, 90, 80),
        true,
        "alarm pasifken %91, %90 esigini asti — uyari olmali",
      );
    }

    // --- Modül 1: domains (gerçek dizin + gerçek dosya, mock yok) ---
    const testDomain = `selftest-${Date.now()}.test.invalid`;
    const authCookie = { studio_session: setCookie!.value };
    let testDirectory = "";

    // Global automatic backup schedule: admin toggle persists to the file
    // consumed by cron. Restore the prior state even when a check fails.
    const scheduleBefore = await server.inject({ method: "GET", url: "/api/backups/schedule", cookies: authCookie });
    assert.equal(scheduleBefore.statusCode, 200, scheduleBefore.body);
    const originalSchedule = scheduleBefore.json().enabled as boolean;
    try {
      const enabled = await server.inject({ method: "PUT", url: "/api/backups/schedule", cookies: authCookie, payload: { enabled: true } });
      assert.equal(enabled.statusCode, 200, enabled.body);
      assert.equal(enabled.json().enabled, true);
      assert.ok(fsSync.existsSync(path.join(GENERATED_DIR, "automatic-backups.enabled")));
      const disabled = await server.inject({ method: "PUT", url: "/api/backups/schedule", cookies: authCookie, payload: { enabled: false } });
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.equal(disabled.json().enabled, false);
      const invalid = await server.inject({ method: "PUT", url: "/api/backups/schedule", cookies: authCookie, payload: { enabled: "yes" } });
      assert.equal(invalid.statusCode, 400);
      const anonymous = await server.inject({ method: "GET", url: "/api/backups/schedule" });
      assert.equal(anonymous.statusCode, 401);
    } finally {
      const restored = await server.inject({ method: "PUT", url: "/api/backups/schedule", cookies: authCookie, payload: { enabled: originalSchedule } });
      assert.equal(restored.statusCode, 200, restored.body);
    }
    console.log("✓ otomatik yedekleme anahtarı geçti (aç/kapat, dosya, yetki, geçersiz giriş)");

    try {
      const createDomain = await server.inject({
        method: "POST",
        url: "/api/domains",
        cookies: authCookie,
        payload: { domain_name: testDomain },
      });
      assert.equal(createDomain.statusCode, 201, `domain create beklenmeyen kod: ${createDomain.statusCode} ${createDomain.body}`);
      const createdDomain = createDomain.json().domain;
      testDirectory = createdDomain.directory_path;

      // Gerçek dizin gerçekten oluştu mu?
      assert.equal(testDirectory, path.join(env.VHOSTS_ROOT, testDomain, "public"));
      assert.ok(fsSync.existsSync(testDirectory), `dizin oluşmadı: ${testDirectory}`);
      assert.equal(createdDomain.directory_exists, true);
      assert.equal(createdDomain.nginx_deployed, false, "bu sandbox'ta /etc/nginx/conf.d yazılmadı, false olmalı");

      // path-traversal reddediliyor mu?
      const traversal = await server.inject({
        method: "POST",
        url: "/api/domains",
        cookies: authCookie,
        payload: { domain_name: "../../etc/passwd" },
      });
      assert.equal(traversal.statusCode, 400, "path-traversal domain adı 400 ile reddedilmeli");

      // nginx config gerçekten üretiliyor mu?
      const genConfig = await server.inject({
        method: "POST",
        url: `/api/domains/${createdDomain.id}/nginx-config`,
        cookies: authCookie,
      });
      assert.equal(genConfig.statusCode, 200, `nginx-config beklenmeyen kod: ${genConfig.statusCode} ${genConfig.body}`);
      const configBody = genConfig.json();
      assert.ok(fsSync.existsSync(configBody.generated_path), "üretilen conf dosyası diskte yok");
      const writtenContent = await fs.readFile(configBody.generated_path, "utf8");
      assert.ok(writtenContent.includes(testDomain), "üretilen conf domain adını içermiyor");
      assert.ok(writtenContent.includes(testDirectory), "üretilen conf document root'u içermiyor");
      assert.ok(!writtenContent.includes(`${testDirectory}/public`), "document root public/public oldu");
      // Sudoers + gerçek nginx yapılandırılmış bir ortamda deploy-vhost.sh
      // gerçekten çalışıp dosyayı /etc/nginx/conf.d'ye kopyalayabilir —
      // nginx_deployed bunu yansıtır. Sandbox'ta (sudo yok) ikisi de false
      // kalır. Asıl kontrol: ikisi birbiriyle tutarlı olmalı.
      assert.equal(
        configBody.nginx_deployed,
        configBody.applied,
        "nginx_deployed, deploy script'in gerçekten uygulanıp uygulanmadığını yansıtmalı",
      );

      // Silme yalnızca belge kökünü değil domain kökünün tamamını kaldırmalı.
      const testDomainRoot = path.dirname(testDirectory);
      await fs.writeFile(path.join(testDomainRoot, "ftp-root-file.txt"), "domain kok verisi", "utf8");

      // silme: açık domain adı onayıyla DB + dosya + config tamamen gider
      const del = await server.inject({
        method: "DELETE",
        url: `/api/domains/${createdDomain.id}`,
        cookies: authCookie,
        payload: { confirm: testDomain },
      });
      assert.equal(del.statusCode, 200, `domain delete beklenmeyen kod: ${del.statusCode} ${del.body}`);
      assert.equal(del.json().cleanup_status, "completed");
      assert.equal(del.json().directory_removal, "completed");
      assert.equal(del.json().data_removal, "completed");
      assert.ok(!fsSync.existsSync(testDomainRoot), "silme sonrası domain kökünün tamamı kalkmalı");

      const listAfterDelete = await server.inject({ method: "GET", url: "/api/domains", cookies: authCookie });
      const stillListed = listAfterDelete.json().domains.some((d: { domain_name: string }) => d.domain_name === testDomain);
      assert.equal(stillListed, false, "silinen domain hâlâ listede görünüyor");

      console.log("✓ Modül 1 (domains) self-test geçti (gerçek dizin + gerçek nginx conf + kalıcı temizleme)");
    } finally {
      // Test verisi temizliği — kendi oluşturduğumuz sandbox verisi, gerçek kullanıcı verisi değil.
      if (testDirectory) {
        await fs.rm(path.dirname(testDirectory), { recursive: true, force: true });
      }
      const generatedConf = path.join(GENERATED_DIR, `${testDomain}.conf`);
      await fs.rm(generatedConf, { force: true });
    }

    // --- Modül 1b: domain oluşturma anında dns_provider seçimi (gerçek BIND9
    // + gerçek Cloudflare hesabı — bkz. lib/dnsProvision.ts pushDomainDnsToCloudflare
    // / applyDomainLocalDns). "cloudflare" seçimi gerçek token'la çalışıyorsa
    // GERÇEK Cloudflare'e istek atar ama .test.invalid hiçbir zone'a eşleşmeyeceği
    // için "zone_not_found" döner — production DNS'e asla yazılmaz. ---
    const localDnsDomain = `selftest-localdns-${Date.now()}.test.invalid`;
    let localDnsDomainRoot = "";
    let localDnsDomainId: number | null = null;
    try {
      const createLocal = await server.inject({
        method: "POST",
        url: "/api/domains",
        cookies: authCookie,
        payload: { domain_name: localDnsDomain, dns_provider: "local" },
      });
      assert.equal(createLocal.statusCode, 201, `local dns_provider create başarısız: ${createLocal.body}`);
      const createdLocal = createLocal.json();
      localDnsDomainId = createdLocal.domain.id;
      localDnsDomainRoot = path.dirname(createdLocal.domain.directory_path);
      assert.equal(createdLocal.domain.dns_provider, "local");
      assert.ok(isZoneGenerated(localDnsDomain), "dns_provider=local seçiminde zone dosyası üretilmedi");
      // Bu ortamda BIND9 gerçekten kurulu ve çalışıyor (bkz. ops/scripts/dns-ctl.sh)
      // — applied gerçekten true olmalı, sadece "denendi" değil.
      assert.equal(
        createdLocal.dns_deployment?.applied,
        isZoneDeployed(localDnsDomain),
        "dns_deployment.applied, zone'un gerçekten BIND'e uygulanıp uygulanmadığını yansıtmalı",
      );

      const createCf = await server.inject({
        method: "POST",
        url: "/api/domains",
        cookies: authCookie,
        payload: { domain_name: `selftest-cfdns-${Date.now()}.test.invalid`, dns_provider: "cloudflare" },
      });
      assert.equal(createCf.statusCode, 201, `cloudflare dns_provider create başarısız: ${createCf.body}`);
      const createdCf = createCf.json();
      assert.equal(createdCf.domain.dns_provider, "cloudflare");
      // .test.invalid gerçek hiçbir Cloudflare zone'una eşleşmez — production'a
      // asla yazılmadığının kanıtı tam olarak bu: sonuç "ok" DEĞİL.
      assert.notEqual(createdCf.dns_deployment?.status, "ok", "test domaini gerçekten bir Cloudflare zone'una yazıldı!");
      await server.inject({
        method: "DELETE",
        url: `/api/domains/${createdCf.domain.id}`,
        cookies: authCookie,
        payload: { confirm: createdCf.domain.domain_name },
      });

      console.log("✓ Modül 1b (domain oluştururken dns_provider seçimi) self-test geçti (gerçek BIND9 + gerçek Cloudflare zone-not-found)");
    } finally {
      if (localDnsDomainId !== null) {
        await server.inject({
          method: "DELETE",
          url: `/api/domains/${localDnsDomainId}`,
          cookies: authCookie,
          payload: { confirm: localDnsDomain },
        });
      }
      // BIND'e gerçekten uygulanmış olabilir (named.conf.local + rndc) — sadece
      // dns_records/domain silmek yetmez, zone'u BIND'den de kaldırmazsak
      // sonraki self-test çalıştırmalarında "zaten var" durumu birikir.
      try {
        await execFileAsync("sudo", [
          "sh",
          "-c",
          `sed -i '/zone "${localDnsDomain}"/,/^};/d' /etc/bind/named.conf.local && rm -f "${deployedZonePath(localDnsDomain)}" && rndc reconfig`,
        ]);
      } catch {
        // BIND kurulu değilse (ör. farklı bir ortamda) sessizce geç — zaten
        // dns_deployment.applied=false olurdu, temizlenecek bir şey yok.
      }
      await fs.rm(zoneFilePath(localDnsDomain), { force: true });
      if (localDnsDomainRoot) {
        await fs.rm(localDnsDomainRoot, { recursive: true, force: true });
      }
    }

    // --- Modül 8: domain başına müşteri girişi (gerçek DB + gerçek login, mock yok) ---
    const customerDomain = `selftest-customer-${Date.now()}.test.invalid`;
    let customerDomainRoot = "";
    try {
      const createCustomerDomain = await server.inject({
        method: "POST",
        url: "/api/domains",
        cookies: authCookie,
        payload: { domain_name: customerDomain },
      });
      assert.equal(createCustomerDomain.statusCode, 201, `domain create beklenmeyen kod: ${createCustomerDomain.statusCode}`);
      const customerDomainRow = createCustomerDomain.json().domain;
      customerDomainRoot = path.dirname(customerDomainRow.directory_path);

      const customerEmail = `selftest-customer+${Date.now()}@example.invalid`;
      const setAccount = await server.inject({
        method: "POST",
        url: `/api/domains/${customerDomainRow.id}/customer-account`,
        cookies: authCookie,
        payload: { username: `cust_${Date.now()}`, email: customerEmail },
      });
      assert.equal(setAccount.statusCode, 201, `customer-account beklenmeyen kod: ${setAccount.statusCode} ${setAccount.body}`);
      const customerPassword = setAccount.json().password;
      assert.ok(customerPassword && customerPassword.length >= 20, "müşteri parolası dönmedi");

      // Müşteri gerçekten giriş yapabiliyor mu?
      const customerLogin = await server.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: customerEmail, password: customerPassword },
      });
      assert.equal(customerLogin.statusCode, 200, `müşteri girişi başarısız: ${customerLogin.body}`);
      assert.equal(customerLogin.json().user.role, "customer");
      const customerCookie = { studio_session: customerLogin.cookies.find((c) => c.name === "studio_session")!.value };

      // Müşteri SADECE kendi domainini görüyor mu?
      const customerList = await server.inject({ method: "GET", url: "/api/domains", cookies: customerCookie });
      assert.equal(customerList.statusCode, 200);
      const customerDomains = customerList.json().domains as Array<{ domain_name: string }>;
      assert.equal(customerDomains.length, 1, "müşteri birden fazla domain görüyor");
      assert.equal(customerDomains[0].domain_name, customerDomain);

      // Müşteri yeni domain açamaz, domain silemez.
      const customerCreateAttempt = await server.inject({
        method: "POST",
        url: "/api/domains",
        cookies: customerCookie,
        payload: { domain_name: `should-not-exist-${Date.now()}.test.invalid` },
      });
      assert.equal(customerCreateAttempt.statusCode, 403, "müşteri domain oluşturabiliyor — yetki açığı");

      const customerDeleteAttempt = await server.inject({
        method: "DELETE",
        url: `/api/domains/${customerDomainRow.id}`,
        cookies: customerCookie,
        payload: { confirm: customerDomain },
      });
      assert.equal(customerDeleteAttempt.statusCode, 403, "müşteri kendi domainini silebiliyor — yetki açığı");

      // Admin, devredilmiş domaini hâlâ listesinde ve alt kaynaklarında görebilmeli.
      const adminList = await server.inject({ method: "GET", url: "/api/domains", cookies: authCookie });
      assert.ok(
        (adminList.json().domains as Array<{ domain_name: string }>).some((d) => d.domain_name === customerDomain),
        "admin devredilmiş domaini listesinde görmüyor",
      );
      const adminFilesOnCustomerDomain = await server.inject({
        method: "GET",
        url: `/api/domains/${customerDomainRow.id}/files?path=`,
        cookies: authCookie,
      });
      assert.equal(adminFilesOnCustomerDomain.statusCode, 200, "admin devredilmiş domainin dosyalarına erişemiyor");

      // Hesap kaldırılınca eski parolayla giriş artık başarısız olmalı.
      const removeAccount = await server.inject({
        method: "DELETE",
        url: `/api/domains/${customerDomainRow.id}/customer-account`,
        cookies: authCookie,
      });
      assert.equal(removeAccount.statusCode, 200, `customer-account silme beklenmeyen kod: ${removeAccount.statusCode}`);
      const loginAfterRemoval = await server.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: customerEmail, password: customerPassword },
      });
      assert.equal(loginAfterRemoval.statusCode, 401, "müşteri hesabı kaldırıldıktan sonra hâlâ giriş yapabiliyor");

      console.log("✓ Modül 8 (domain başına müşteri girişi) self-test geçti (gerçek DB + gerçek login + yetki izolasyonu)");
    } finally {
      // Müşteri hesabı zaten kaldırıldı; domain hâlâ admin'e bağlı olduğu için
      // normal silme akışı (Modül 1'dekiyle aynı) yeterli.
      const cleanupId = await server.pg
        .query("SELECT id FROM domains WHERE domain_name = $1", [customerDomain])
        .then((r) => r.rows[0]?.id as number | undefined)
        .catch(() => undefined);
      if (cleanupId) {
        await server.inject({
          method: "DELETE",
          url: `/api/domains/${cleanupId}`,
          cookies: authCookie,
          payload: { confirm: customerDomain },
        }).catch(() => {});
      }
      if (customerDomainRoot) {
        await fs.rm(customerDomainRoot, { recursive: true, force: true });
      }
      const generatedConf = path.join(GENERATED_DIR, `${customerDomain}.conf`);
      await fs.rm(generatedConf, { force: true });
    }

    // --- Modül 4: Dosya Yöneticisi & Yedekleme (gerçek fs, gerçek tar, mock yok) ---
    const filesDomain = `selftest-files-${Date.now()}.test.invalid`;
    let filesDomainRoot = "";

    try {
      const createDomain2 = await server.inject({
        method: "POST",
        url: "/api/domains",
        cookies: authCookie,
        payload: { domain_name: filesDomain },
      });
      assert.equal(createDomain2.statusCode, 201, `domain create beklenmeyen kod: ${createDomain2.statusCode}`);
      const domain2 = createDomain2.json().domain;
      filesDomainRoot = path.dirname(domain2.directory_path); // <vhosts>/<domain>/ (public'in ebeveyni)

      // 1) listeleme: "public" alt klasörü var mı?
      const list1 = await server.inject({
        method: "GET",
        url: `/api/domains/${domain2.id}/files?path=`,
        cookies: authCookie,
      });
      assert.equal(list1.statusCode, 200, `files list beklenmeyen kod: ${list1.statusCode} ${list1.body}`);
      assert.ok(
        list1.json().entries.some((e: { name: string; type: string }) => e.name === "public" && e.type === "directory"),
        "kök listelemede 'public' dizini görünmüyor",
      );

      // 2) dosya oluştur — GERÇEKTEN diske yazılıyor mu?
      const createFile = await server.inject({
        method: "POST",
        url: `/api/domains/${domain2.id}/files`,
        cookies: authCookie,
        payload: { path: "public/index.html", content: "<h1>selftest</h1>" },
      });
      assert.equal(createFile.statusCode, 201, `file create beklenmeyen kod: ${createFile.statusCode} ${createFile.body}`);
      assert.ok(fsSync.existsSync(path.join(domain2.directory_path, "index.html")), "dosya diskte oluşmadı");

      // 3) oku
      const readFile = await server.inject({
        method: "GET",
        url: `/api/domains/${domain2.id}/files/read?path=${encodeURIComponent("public/index.html")}`,
        cookies: authCookie,
      });
      assert.equal(readFile.statusCode, 200);
      assert.equal(readFile.json().content, "<h1>selftest</h1>");

      // 4) güncelle
      const updateFile = await server.inject({
        method: "PUT",
        url: `/api/domains/${domain2.id}/files`,
        cookies: authCookie,
        payload: { path: "public/index.html", content: "<h1>updated</h1>" },
      });
      assert.equal(updateFile.statusCode, 200);
      assert.equal(await fs.readFile(path.join(domain2.directory_path, "index.html"), "utf8"), "<h1>updated</h1>");

      // 5) yeniden adlandır
      const renameRes = await server.inject({
        method: "POST",
        url: `/api/domains/${domain2.id}/files/rename`,
        cookies: authCookie,
        payload: { from: "public/index.html", to: "public/home.html" },
      });
      assert.equal(renameRes.statusCode, 200, `rename beklenmeyen kod: ${renameRes.statusCode} ${renameRes.body}`);
      assert.ok(fsSync.existsSync(path.join(domain2.directory_path, "home.html")), "yeniden adlandırılan dosya yok");
      assert.ok(!fsSync.existsSync(path.join(domain2.directory_path, "index.html")), "eski ad hâlâ diskte");

      // --- Path-traversal saldırı testleri — HEPSİ 403 dönmeli ---
      // (a) düz "../" — çeyrek kodlanmamış, doğrudan sorgu değeri
      const attackPlain = await server.inject({
        method: "GET",
        url: `/api/domains/${domain2.id}/files/read?path=../../../../../../etc/passwd`,
        cookies: authCookie,
      });
      assert.equal(attackPlain.statusCode, 403, `düz '../' 403 dönmeli, döndü: ${attackPlain.statusCode}`);

      // (b) çift URL-encode edilmiş "%2e%2e%2f..." — tek çözümden sonra bile
      // hâlâ encode kalır, lib/safe-path.ts'in KENDİ decodeURIComponent
      // katmanı bunu açığa çıkarıp reddetmeli (framework'ün tek-seferlik
      // query decode'una güvenmiyoruz).
      const doubleEncoded = encodeURIComponent("%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd");
      const attackDoubleEncoded = await server.inject({
        method: "GET",
        url: `/api/domains/${domain2.id}/files/read?path=${doubleEncoded}`,
        cookies: authCookie,
      });
      assert.equal(
        attackDoubleEncoded.statusCode,
        403,
        `çift encode '%2e%2e%2f' 403 dönmeli, döndü: ${attackDoubleEncoded.statusCode}`,
      );

      // (c) karışık "..%2f" (nokta düz, slash encode) — aynı çift-encode mantığı
      const mixedEncoded = encodeURIComponent("..%2f..%2f..%2fetc%2fpasswd");
      const attackMixed = await server.inject({
        method: "GET",
        url: `/api/domains/${domain2.id}/files/read?path=${mixedEncoded}`,
        cookies: authCookie,
      });
      assert.equal(attackMixed.statusCode, 403, `'..%2f' 403 dönmeli, döndü: ${attackMixed.statusCode}`);

      // (d) null byte — JSON body üzerinden (gerçek \0 karakteri)
      const attackNullByte = await server.inject({
        method: "POST",
        url: `/api/domains/${domain2.id}/files`,
        cookies: authCookie,
        payload: { path: "public/evil" + String.fromCharCode(0) + ".txt", content: "x" },
      });
      assert.equal(attackNullByte.statusCode, 403, `null byte 403 dönmeli, döndü: ${attackNullByte.statusCode}`);

      // (e) sembolik link kaçışı — domain dizini İÇİNDE, vhosts kökünün
      // DIŞINA (/tmp) çıkan gerçek bir symlink oluşturup üzerinden okuma dene.
      const outsideDir = await fs.mkdtemp("/tmp/studio-symlink-target-");
      const secretFile = path.join(outsideDir, "secret.txt");
      await fs.writeFile(secretFile, "dışarıdan gizli veri");
      const symlinkPath = path.join(domain2.directory_path, "escape-link");
      await fs.symlink(outsideDir, symlinkPath, "dir");
      try {
        const attackSymlink = await server.inject({
          method: "GET",
          url: `/api/domains/${domain2.id}/files/read?path=${encodeURIComponent("public/escape-link/secret.txt")}`,
          cookies: authCookie,
        });
        assert.equal(
          attackSymlink.statusCode,
          403,
          `symlink kaçışı 403 dönmeli, döndü: ${attackSymlink.statusCode} ${attackSymlink.body}`,
        );
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }

      console.log("✓ path-traversal testleri geçti (../, çift-encode %2e%2e%2f, ..%2f, null byte, symlink kaçışı — hepsi 403)");

      // --- Silme testi: domain kökü file manager ile silinemez ---
      const deleteRoot = await server.inject({
        method: "DELETE",
        url: `/api/domains/${domain2.id}/files?path=`,
        cookies: authCookie,
      });
      assert.equal(deleteRoot.statusCode, 400, "domain kökü file manager ile silinebilmemeli");

      // gerçek dosya silme
      const deleteFile = await server.inject({
        method: "DELETE",
        url: `/api/domains/${domain2.id}/files?path=${encodeURIComponent("public/home.html")}`,
        cookies: authCookie,
      });
      assert.equal(deleteFile.statusCode, 200, `file delete beklenmeyen kod: ${deleteFile.statusCode}`);
      assert.ok(!fsSync.existsSync(path.join(domain2.directory_path, "home.html")), "dosya silinmedi");

      // --- Yedekleme: GERCEK anlik goruntu + GERCEK dogrulama ---
      //
      // Eski test yalnizca "bir .tar.gz olustu mu" diye bakiyordu. Yetmez:
      // bir dosyanin var olmasi, GERI YUKLENEBILIR oldugunu kanitlamaz.
      // Bu yuzden test artik arsivi ACIP dogruluyor ve manifest'in
      // beklenen parcalari tasidigini denetliyor.
      const backupsEmpty = await server.inject({
        method: "GET",
        url: `/api/domains/${domain2.id}/backups`,
        cookies: authCookie,
      });
      assert.equal(backupsEmpty.statusCode, 200);
      assert.deepEqual(backupsEmpty.json().backups, [], "yeni domainde yedek olmamali");

      const createBackupRes = await server.inject({
        method: "POST",
        url: `/api/domains/${domain2.id}/backups`,
        cookies: authCookie,
      });
      assert.equal(
        createBackupRes.statusCode,
        201,
        `backup create beklenmeyen kod: ${createBackupRes.statusCode} ${createBackupRes.body}`,
      );
      const backupBody = createBackupRes.json();
      assert.ok(backupBody.name?.endsWith(".tar.gz"), "yedek adi zaman damgali olmali");
      assert.ok(backupBody.size_bytes > 0, "yedek dosyasi bos");
      // nginx conf ve DKIM bu test domaini icin uretilmis olmali; eksik parca
      // SESSIZ GECMEMELI (manifest.complete bunu soyler).
      assert.equal(typeof backupBody.complete, "boolean", "complete alani bulunmali");

      // Listede gorunmeli ve HENUZ DOGRULANMAMIS olmali — yeni bir yedek
      // otomatik olarak "iyi" sayilmaz.
      const listAfter = await server.inject({
        method: "GET",
        url: `/api/domains/${domain2.id}/backups`,
        cookies: authCookie,
      });
      const listed = listAfter.json().backups;
      assert.equal(listed.length, 1, "bir yedek listelenmeli");
      assert.equal(listed[0].verify_status, null, "yeni yedek dogrulanmamis olmali");

      // GERCEK DOGRULAMA: arsiv acilir, sha256'lar karsilastirilir.
      const verifyRes = await server.inject({
        method: "POST",
        url: `/api/domains/${domain2.id}/backups/verify`,
        cookies: authCookie,
        payload: {},
      });
      assert.equal(verifyRes.statusCode, 200, `verify beklenmeyen kod: ${verifyRes.statusCode}`);
      const verifyBody = verifyRes.json();
      assert.equal(verifyBody.ok, true, `dogrulama basarisiz: ${verifyBody.error}`);
      assert.equal(verifyBody.detail.archive_readable, true, "arsiv acilabilmeli");
      assert.equal(verifyBody.detail.manifest_found, true, "manifest bulunmali");
      assert.equal(verifyBody.detail.parts_failed.length, 0, "hicbir parca bozuk olmamali");

      // Dogrulamadan SONRA liste artik "ok" gostermeli.
      const listVerified = await server.inject({
        method: "GET",
        url: `/api/domains/${domain2.id}/backups`,
        cookies: authCookie,
      });
      assert.equal(listVerified.json().backups[0].verify_status, "ok", "dogrulama listeye yansimali");

      // GERI YUKLEME PLANI kuru calistirma: hicbir seye dokunmamali.
      const planRes = await server.inject({
        method: "POST",
        url: `/api/domains/${domain2.id}/backups/restore-plan`,
        cookies: authCookie,
        payload: { name: backupBody.name },
      });
      assert.equal(planRes.statusCode, 200, `restore-plan beklenmeyen kod: ${planRes.statusCode}`);
      assert.equal(planRes.json().domain_name, filesDomain);

      // Geri yukleme ONAY ISTER: yanlis domain adiyla REDDEDILMELI.
      const badConfirm = await server.inject({
        method: "POST",
        url: `/api/domains/${domain2.id}/backups/restore`,
        cookies: authCookie,
        payload: { name: backupBody.name, confirm_domain: "yanlis-ad.example" },
      });
      assert.equal(badConfirm.statusCode, 400, "yanlis onay adiyla geri yukleme reddedilmeli");

      const downloadRes = await server.inject({
        method: "GET",
        url: `/api/domains/${domain2.id}/backups/download`,
        cookies: authCookie,
      });
      assert.equal(downloadRes.statusCode, 200, `backup download beklenmeyen kod: ${downloadRes.statusCode}`);
      assert.equal(downloadRes.headers["content-type"], "application/gzip");
      // Gercek gzip magic number (0x1f 0x8b) — indirilen icerik gercekten tar.gz mi?
      const downloadedBytes = downloadRes.rawPayload;
      assert.equal(downloadedBytes[0], 0x1f, "indirilen icerik gzip magic number ile baslamiyor");
      assert.equal(downloadedBytes[1], 0x8b, "indirilen icerik gzip magic number ile baslamiyor");
      assert.equal(downloadedBytes.length, backupBody.size_bytes, "indirilen bayt sayisi diskteki boyutla uyusmuyor");

      // --- "Sil" GERCEKTEN kalici mi: klasorden CALISAN surec de durmali ---
      //
      // Regresyon testi. 2026-09-07'de bir vhost'un uygulama klasoru panelden
      // silindi, dizin gercekten bosaldi ama site tarayicida acilmaya devam
      // etti: klasorden calisan `next-server` sureci ayaktaydi ve silinmis
      // inode'u canli tutuyordu. Silme akisi surecleri durdurmadigi surece
      // "sildim" demek kullaniciya YANLIS bilgi vermek olur.
      //
      // Asagidaki `sleep`, o next-server'in en yalin hali: tek isi silinecek
      // dizinde CALISIYOR olmak.
      {
        const liveDir = path.join(filesDomainRoot, "public", "calisan-uygulama");
        await fs.mkdir(liveDir, { recursive: true });
        await fs.writeFile(path.join(liveDir, "index.html"), "<h1>hayalet</h1>");

        const ghost = spawn("sleep", ["300"], { cwd: liveDir, stdio: "ignore" });
        ghost.unref();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const ghostPid = ghost.pid;
        assert.ok(ghostPid, "test icin hayalet surec baslatilamadi");
        // Once gercekten AYAKTA oldugunu dogrula, yoksa test hicbir sey kanitlamaz.
        assert.doesNotThrow(
          () => process.kill(ghostPid!, 0),
          "hayalet surec testin basinda zaten olu — test anlamsiz olurdu",
        );

        const bulkDel = await server.inject({
          method: "POST",
          url: `/api/domains/${domain2.id}/files/bulk-delete`,
          cookies: authCookie,
          payload: { paths: ["public/calisan-uygulama"] },
        });
        assert.equal(bulkDel.statusCode, 200, `bulk-delete beklenmeyen kod: ${bulkDel.statusCode} ${bulkDel.body}`);
        const delBody = bulkDel.json();
        assert.equal(delBody.ok, true, `silme basarisiz: ${bulkDel.body}`);

        // 1) Surec durduruldu mu? (asil regresyon)
        let stillAlive = true;
        try {
          process.kill(ghostPid!, 0);
        } catch {
          stillAlive = false;
        }
        assert.equal(stillAlive, false, "silinen klasorden calisan surec HALA ayakta — 'sil' kalici degil");

        // 2) Panel bunu raporladi mi? Sessiz kill, operatorun izini kaybettirir.
        assert.ok(
          delBody.reaped.some((r: { pid: number }) => r.pid === ghostPid),
          "durdurulan surec yanitta raporlanmadi",
        );

        // 3) Klasor gercekten gitti mi?
        await assert.rejects(fs.lstat(liveDir), "klasor diskte duruyor");

        console.log("  ✓ silme, klasorden calisan sureci de durduruyor (hayalet surec regresyonu)");
      }

      console.log("✓ Modül 4 (dosya yöneticisi + yedekleme) self-test geçti (gerçek fs + gerçek tar + GERÇEK doğrulama: arşiv açıldı, sha256 karşılaştırıldı, geri yükleme onayı zorunlu)");
    } finally {
      // Test verisi temizliği — kendi sandbox verimiz, gerçek kullanıcı verisi değil.
      // domain2 dosya-yöneticisi testleri sırasında hiç DELETE /api/domains/:id
      // ile silinmedi (kasıtlı — kök silme reddi test edildi) — burada temizlenir.
      const del2 = await server.inject({
        method: "GET",
        url: "/api/domains",
        cookies: authCookie,
      });
      const leftover = del2.json().domains?.find((d: { domain_name: string; id: number }) => d.domain_name === filesDomain);
      if (leftover) {
        await server.inject({ method: "DELETE", url: `/api/domains/${leftover.id}`, cookies: authCookie, payload: { confirm: filesDomain } });
      }
      if (filesDomainRoot) {
        await fs.rm(filesDomainRoot, { recursive: true, force: true });
      }
      // Yedekler artik VHOSTS_ROOT altinda degil, ops/backups/<domain>/ altinda.
      await fs.rm(path.join(PROJECT_ROOT, "ops", "backups", filesDomain), {
        recursive: true,
        force: true,
      });
      const generatedConf2 = path.join(GENERATED_DIR, `${filesDomain}.conf`);
      await fs.rm(generatedConf2, { force: true });
      const pendingLog2 = path.join(GENERATED_DIR, "pending-directory-deletions.jsonl");
      if (fsSync.existsSync(pendingLog2)) {
        const lines = (await fs.readFile(pendingLog2, "utf8"))
          .split("\n")
          .filter((line) => line && !line.includes(filesDomain));
        await fs.writeFile(pendingLog2, lines.length ? lines.join("\n") + "\n" : "", "utf8");
      }
    }

    // --- Modül 2a: DNS route'ları — GERÇEK Cloudflare hesabına karşı,
    // AMA sadece salt-okunur uçlar + ".test.invalid" ile zone-bulunamadı
    // (dolayısıyla hiçbir gerçek yazma isteği ASLA tetiklenmeyen) yol.
    // Gerçek create/update/delete'in Cloudflare'e karşı DOĞRU İSTEK ürettiği
    // ayrı bir yerel mock sunucu bloğunda (aşağıda) kanıtlanıyor — canlı
    // hesaba karşı bilinçli olarak hiç yazma denenmedi (bkz. MEMORY.md).
    const dnsDomain = `selftest-dns-${Date.now()}.test.invalid`;
    let dnsDomainId: number | null = null;

    try {
      const createDomain3 = await server.inject({
        method: "POST",
        url: "/api/domains",
        cookies: authCookie,
        payload: { domain_name: dnsDomain },
      });
      assert.equal(createDomain3.statusCode, 201);
      dnsDomainId = createDomain3.json().domain.id;

      // Domain oluşturulunca öneri DNS kayıtları OTOMATİK eklenir (bkz.
      // routes/domains.ts provisionDefaultDns) — artık boş DEĞİL.
      //
      // SAYI, SERVER_PUBLIC_IP'YE BAĞLI: tanımlıysa @/www/mail/webmail için
      // 4 adet A kaydı da üretilir. Sabit "9" beklemek, testi bir ortam
      // değişkenine bağımlı kılıyordu ve 2026-09-01'de gerçekten kırıldı:
      // sunucunun genel IP'si yapılandırılınca (o güne kadar boştu, bu yüzden
      // mail/webmail A kayıtları hiç oluşmuyordu) test "13" görüp düştü.
      // Beklenen sayı artık aynı kaynaktan türetiliyor.
      const dnsList0 = await server.inject({ method: "GET", url: `/api/domains/${dnsDomainId}/dns`, cookies: authCookie });
      assert.equal(dnsList0.statusCode, 200);
      const provisioned = dnsList0.json().records as Array<{
        record_type: string;
        name: string;
        content: string;
        priority: number | null;
        weight: number | null;
        port: number | null;
        cloudflare_id: string | null;
      }>;
      // MX + 3x TXT (SPF/DKIM/DMARC) + 5x SRV = 9; IP varsa +4 A kaydı.
      const expectedProvisioned = env.SERVER_PUBLIC_IP ? 13 : 9;
      assert.equal(
        provisioned.length,
        expectedProvisioned,
        `otomatik DNS öneri kaydı sayısı beklenmedik: ${provisioned.length} (SERVER_PUBLIC_IP=${env.SERVER_PUBLIC_IP ?? "yok"})`,
      );
      assert.ok(
        provisioned.every((r) => r.cloudflare_id === null),
        "otomatik kayıtlar henüz Cloudflare'e gönderilmemiş olmalı (cloudflare_id null)",
      );
      const mxRecord = provisioned.find((r) => r.record_type === "MX");
      assert.ok(mxRecord, "MX kaydı otomatik oluşmalı");
      assert.equal(mxRecord!.priority, 10);
      assert.equal(mxRecord!.content, `mail.${dnsDomain}`);
      const dkimRecord = provisioned.find((r) => r.name === `default._domainkey.${dnsDomain}`);
      assert.ok(dkimRecord, "DKIM TXT kaydı otomatik oluşmalı");
      assert.ok(dkimRecord!.content.startsWith("v=DKIM1;"), "DKIM TXT değeri v=DKIM1 ile başlamalı");
      const srvRecords = provisioned.filter((r) => r.record_type === "SRV");
      assert.equal(srvRecords.length, 5, "5 SRV kaydı (imap/imaps/pop3/pop3s/submission) olmalı");
      const imapsSrv = srvRecords.find((r) => r.name === `_imaps._tcp.${dnsDomain}`);
      assert.ok(imapsSrv, "_imaps._tcp SRV kaydı olmalı");
      assert.equal(imapsSrv!.port, 993);
      assert.equal(imapsSrv!.weight, 1);
      assert.equal(imapsSrv!.priority, 0);

      // DKIM private key gerçekten diske yazıldı mı, izinleri doğru mu?
      const dkimKeyPath = dkimPrivateKeyPath(dnsDomain);
      assert.ok(fsSync.existsSync(dkimKeyPath), `DKIM private key dosyası oluşmadı: ${dkimKeyPath}`);
      const dkimStat = fsSync.statSync(dkimKeyPath);
      assert.equal(dkimStat.mode & 0o777, 0o600, "DKIM private key dosya izinleri 0600 olmalı");

      // GERÇEK Cloudflare çağrısı — token yapılandırılı, ama ".test.invalid"
      // hiçbir zaman gerçek bir zone'a eşleşmez (RFC 2606 rezerve TLD).
      const cfStatus = await server.inject({
        method: "GET",
        url: `/api/domains/${dnsDomainId}/dns/cloudflare-status`,
        cookies: authCookie,
      });
      assert.equal(cfStatus.statusCode, 200, `cloudflare-status beklenmeyen kod: ${cfStatus.statusCode} ${cfStatus.body}`);
      const cfStatusBody = cfStatus.json();
      console.log("Cloudflare status (.test.invalid):", JSON.stringify(cfStatusBody));
      assert.ok(
        cfStatusBody.status === "zone_not_found" || cfStatusBody.status === "not_configured",
        `beklenmeyen cloudflare-status: ${cfStatusBody.status}`,
      );

      // GERÇEK pull — zone bulunamayacağı için Cloudflare'e YAZMA isteği
      // hiç atılmaz, sadece bir GET /zones denemesi yapılır.
      const pull = await server.inject({ method: "POST", url: `/api/domains/${dnsDomainId}/dns/pull`, cookies: authCookie });
      assert.equal(pull.statusCode, 200, `pull beklenmeyen kod: ${pull.statusCode} ${pull.body}`);
      assert.equal(pull.json().zoneFound, false);

      // Yerel-only DNS kaydı oluşturma (zone yok → Cloudflare'e hiç gidilmez,
      // sadece dns_records tablosuna yazılır) — gerçek DB CRUD doğrulanıyor.
      const createRecord = await server.inject({
        method: "POST",
        url: `/api/domains/${dnsDomainId}/dns`,
        cookies: authCookie,
        payload: { record_type: "A", name: dnsDomain, content: "203.0.113.10", ttl: 3600, proxied: true },
      });
      assert.equal(createRecord.statusCode, 201, `dns create beklenmeyen kod: ${createRecord.statusCode} ${createRecord.body}`);
      const createdRecord = createRecord.json();
      assert.equal(createdRecord.record.cloudflare_id, null, "zone yokken cloudflare_id null olmalı");
      assert.equal(createdRecord.record.proxied, true, "proxied gönderildiği gibi PERSIST edilmeli (önceden hiç saklanmıyordu)");

      const reread = await server.inject({ method: "GET", url: `/api/domains/${dnsDomainId}/dns`, cookies: authCookie });
      const rereadRecord = (reread.json().records as Array<{ id: number; proxied: boolean }>).find(
        (r) => r.id === createdRecord.record.id,
      );
      assert.equal(rereadRecord?.proxied, true, "proxied yeniden okunduğunda da true kalmalı (DB'de kalıcı)");

      const updateRecord = await server.inject({
        method: "PUT",
        url: `/api/domains/${dnsDomainId}/dns/${createdRecord.record.id}`,
        cookies: authCookie,
        payload: { content: "203.0.113.20", proxied: false },
      });
      assert.equal(updateRecord.statusCode, 200);
      assert.equal(updateRecord.json().record.content, "203.0.113.20");
      assert.equal(updateRecord.json().record.proxied, false, "proxied güncellemesi PERSIST edilmeli");

      const deleteRecord = await server.inject({
        method: "DELETE",
        url: `/api/domains/${dnsDomainId}/dns/${createdRecord.record.id}`,
        cookies: authCookie,
      });
      assert.equal(deleteRecord.statusCode, 200);

      console.log("✓ Modül 2a (DNS route'ları) self-test geçti (gerçek DB CRUD + gerçek salt-okunur Cloudflare çağrıları)");
    } finally {
      if (dnsDomainId) {
        // dns_records zaten domain silinince CASCADE ile gider.
        await server.inject({ method: "DELETE", url: `/api/domains/${dnsDomainId}`, cookies: authCookie, payload: { confirm: dnsDomain } });
      }
      const dnsDirRoot = path.join(env.VHOSTS_ROOT, dnsDomain);
      await fs.rm(dnsDirRoot, { recursive: true, force: true });
      const generatedConf3 = path.join(GENERATED_DIR, `${dnsDomain}.conf`);
      await fs.rm(generatedConf3, { force: true });
      await fs.rm(path.join(GENERATED_DIR, "dkim", dnsDomain), { recursive: true, force: true });
      const pendingLog3 = path.join(GENERATED_DIR, "pending-directory-deletions.jsonl");
      if (fsSync.existsSync(pendingLog3)) {
        const lines = (await fs.readFile(pendingLog3, "utf8"))
          .split("\n")
          .filter((line) => line && !line.includes(dnsDomain));
        await fs.writeFile(pendingLog3, lines.length ? lines.join("\n") + "\n" : "", "utf8");
      }
    }

    // --- Modül 2b: CloudflareClient yazma yolu — YEREL MOCK sunucu.
    // Gerçek Cloudflare'e HİÇ istek gitmiyor; global `fetch` gerçek bir
    // localhost HTTP sunucusuna gidiyor (nock undici/native fetch'i
    // yakalamadığı için bilinçli olarak yerel http.Server tercih edildi —
    // bu, isteğin GERÇEKTEN doğru şekillendiğini kanıtlıyor: doğru method,
    // path, Authorization header, JSON body).
    {
      const received: Array<{ method?: string; url?: string; body: unknown; authHeader?: string }> = [];
      const mockServer = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          const body = raw ? JSON.parse(raw) : undefined;
          received.push({ method: req.method, url: req.url, body, authHeader: req.headers.authorization });

          if (req.url === "/zones/zoneABC/dns_records/unauthorized") {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, result: null, errors: [{ code: 9109, message: "Invalid API token" }] }));
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          if (req.method === "POST" && req.url === "/zones/zoneABC/dns_records") {
            res.end(JSON.stringify({ success: true, result: { id: "rec123", zone_id: "zoneABC", ...body } }));
          } else if (req.method === "PUT") {
            res.end(JSON.stringify({ success: true, result: { id: "rec123", zone_id: "zoneABC", ...body } }));
          } else if (req.method === "DELETE") {
            res.end(JSON.stringify({ success: true, result: { id: "rec123" } }));
          } else {
            res.end(JSON.stringify({ success: true, result: [] }));
          }
        });
      });
      await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
      const mockPort = (mockServer.address() as { port: number }).port;

      try {
        const mockClient = new CloudflareClient({
          apiToken: "fake-test-token",
          baseUrl: `http://127.0.0.1:${mockPort}`,
        });

        const created = await mockClient.createDnsRecord("zoneABC", {
          type: "A",
          name: "mock.example.invalid",
          content: "203.0.113.5",
          ttl: 300,
        });
        assert.equal(created.id, "rec123");
        const createReq = received.find((r) => r.method === "POST");
        assert.ok(createReq, "mock sunucuya POST isteği gelmedi");
        assert.equal(createReq!.url, "/zones/zoneABC/dns_records");
        assert.equal(createReq!.authHeader, "Bearer fake-test-token");
        assert.deepEqual(createReq!.body, { type: "A", name: "mock.example.invalid", content: "203.0.113.5", ttl: 300 });

        const updated = await mockClient.updateDnsRecord("zoneABC", "rec123", { content: "203.0.113.9" });
        assert.equal(updated.content, "203.0.113.9");
        const updateReq = received.find((r) => r.method === "PUT");
        assert.equal(updateReq!.url, "/zones/zoneABC/dns_records/rec123");
        assert.deepEqual(updateReq!.body, { content: "203.0.113.9" });

        const deleted = await mockClient.deleteDnsRecord("zoneABC", "rec123");
        assert.equal(deleted.id, "rec123");
        const deleteReq = received.find((r) => r.method === "DELETE");
        assert.equal(deleteReq!.url, "/zones/zoneABC/dns_records/rec123");

        // hata zarfı doğru şekilde CloudflareError'a çevriliyor mu?
        let threw = false;
        try {
          await mockClient.deleteDnsRecord("zoneABC", "unauthorized");
        } catch (err) {
          threw = true;
          assert.ok(String((err as Error).message).includes("Invalid API token"));
        }
        assert.ok(threw, "geçersiz token yanıtı hata fırlatmalıydı");

        console.log("✓ Modül 2b (CloudflareClient yazma yolu) self-test geçti (yerel mock HTTP sunucu — gerçek Cloudflare'e HİÇ istek gitmedi)");
      } finally {
        await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      }
    }

    // --- Modül 2b-bis: push-to-cloudflare route'u UÇTAN UCA — yerel mock
    // Cloudflare sunucusuna karşı gerçek server.inject() çağrıları. Buradaki
    // domain BİLEREK bir ALT alan adı ("sub.push-test.invalid"), zone ise
    // kök domain ("push-test.invalid") — resolveZoneForDomain'in artık tam
    // eşleşme yerine EN UZUN SUFFIX eşleşmesiyle zone bulduğunu (2026-08-28
    // düzeltmesi) ve MX/SRV kayıtlarının doğru Cloudflare payload şekliyle
    // (üst düzey priority / data objesi) gittiğini kanıtlar.
    {
      const pushDomain = `sub.push-test-${Date.now()}.invalid`;
      const zoneDomain = pushDomain.split(".").slice(1).join(".");
      const received: Array<{ method?: string; url?: string; body: unknown }> = [];
      const mockServer = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          const body = raw ? JSON.parse(raw) : undefined;
          received.push({ method: req.method, url: req.url, body });
          res.writeHead(200, { "Content-Type": "application/json" });
          if (req.url?.startsWith("/zones?")) {
            res.end(JSON.stringify({ success: true, result: [{ id: "zonePush", name: zoneDomain, status: "active" }] }));
          } else if (req.method === "POST" && req.url === "/zones/zonePush/dns_records") {
            res.end(
              JSON.stringify({
                success: true,
                result: { id: `rec-${Math.random().toString(36).slice(2, 8)}`, zone_id: "zonePush", ...(body as object) },
              }),
            );
          } else {
            res.end(JSON.stringify({ success: true, result: [] }));
          }
        });
      });
      await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
      const mockPort = (mockServer.address() as { port: number }).port;

      const realBase2 = env.CLOUDFLARE_API_BASE;
      const realToken2 = env.CLOUDFLARE_API_TOKEN;
      let pushDomainId: number | null = null;
      try {
        env.CLOUDFLARE_API_BASE = `http://127.0.0.1:${mockPort}`;
        env.CLOUDFLARE_API_TOKEN = "fake-push-token";
        resetCloudflareClient();

        const createPushDomain = await server.inject({
          method: "POST",
          url: "/api/domains",
          cookies: authCookie,
          payload: { domain_name: pushDomain },
        });
        assert.equal(createPushDomain.statusCode, 201);
        pushDomainId = createPushDomain.json().domain.id;

        const push = await server.inject({
          method: "POST",
          url: `/api/domains/${pushDomainId}/dns/push-to-cloudflare`,
          cookies: authCookie,
        });
        assert.equal(push.statusCode, 200, `push-to-cloudflare beklenmeyen kod: ${push.statusCode} ${push.body}`);
        const pushBody = push.json();
        assert.equal(pushBody.status, "ok", `zone bulunamadı — alt alan adı eşleşmesi bozuk olabilir: ${JSON.stringify(pushBody)}`);
        assert.equal(pushBody.zone.name, zoneDomain, "alt alan adı KÖK zone'a eşleşmeli");
        // Sayi SERVER_PUBLIC_IP'ye bagli (yukaridaki expectedProvisioned ile
        // ayni gerekce); sabit yazmak testi ortama bagimli kilardi.
        assert.equal(
          pushBody.results.length,
          env.SERVER_PUBLIC_IP ? 13 : 9,
          "oneri kayitlarinin HEPSI gonderilmeye calisilmali",
        );
        assert.ok(pushBody.results.every((r: { ok: boolean }) => r.ok), `bazı kayıtlar başarısız: ${JSON.stringify(pushBody.results)}`);

        // Gerçekten DB'de cloudflare_id set edildi mi?
        const afterPush = await server.inject({
          method: "GET",
          url: `/api/domains/${pushDomainId}/dns`,
          cookies: authCookie,
        });
        assert.ok(
          afterPush.json().records.every((r: { cloudflare_id: string | null }) => r.cloudflare_id !== null),
          "push sonrası tüm kayıtların cloudflare_id'si dolmalı",
        );

        // Mock sunucuya giden MX isteği üst düzey "priority" taşıyor mu?
        const mxReq = received.find((r) => r.method === "POST" && (r.body as { type?: string })?.type === "MX");
        assert.ok(mxReq, "MX kaydı için Cloudflare'e POST isteği gitmedi");
        assert.equal((mxReq!.body as { priority?: number }).priority, 10);

        // SRV isteği "data" objesi taşıyor, "content" TAŞIMIYOR mu?
        const srvReq = received.find((r) => r.method === "POST" && (r.body as { type?: string })?.type === "SRV");
        assert.ok(srvReq, "SRV kaydı için Cloudflare'e POST isteği gitmedi");
        const srvBody = srvReq!.body as { content?: string; data?: { port: number; target: string } };
        assert.equal(srvBody.content, undefined);
        assert.ok(srvBody.data && [143, 993, 110, 995, 587].includes(srvBody.data.port));
        assert.equal(srvBody.data!.target, `mail.${pushDomain}`);

        console.log(
          "✓ Modül 2b-bis (push-to-cloudflare uçtan uca + alt alan adı zone eşleşmesi) self-test geçti",
        );
      } finally {
        env.CLOUDFLARE_API_BASE = realBase2;
        env.CLOUDFLARE_API_TOKEN = realToken2;
        resetCloudflareClient();
        await new Promise<void>((resolve) => mockServer.close(() => resolve()));
        if (pushDomainId) {
          await server.inject({
            method: "DELETE",
            url: `/api/domains/${pushDomainId}`,
            cookies: authCookie,
            payload: { confirm: pushDomain },
          });
        }
        const pushDirRoot = path.join(env.VHOSTS_ROOT, pushDomain);
        await fs.rm(pushDirRoot, { recursive: true, force: true });
        await fs.rm(path.join(GENERATED_DIR, `${pushDomain}.conf`), { force: true });
        await fs.rm(path.join(GENERATED_DIR, "dkim", pushDomain), { recursive: true, force: true });
        const pendingLogPush = path.join(GENERATED_DIR, "pending-directory-deletions.jsonl");
        if (fsSync.existsSync(pendingLogPush)) {
          const lines = (await fs.readFile(pendingLogPush, "utf8"))
            .split("\n")
            .filter((line) => line && !line.includes(pushDomain));
          await fs.writeFile(pendingLogPush, lines.length ? lines.join("\n") + "\n" : "", "utf8");
        }
      }
    }

    // --- Modül 3: SSL durumu ve güvenli talep kuyruğu. Certbot/root bu
    // sandbox'ta yok; test gerçek sistem dosyalarına dokunmadan API + DB +
    // pending kayıt akışını doğrular.
    const sslDomain = `selftest-ssl-${Date.now()}.test.invalid`;
    let sslDomainId: number | null = null;
    const pendingSslLog = path.join(GENERATED_DIR, "pending-ssl-requests.jsonl");
    try {
      const created = await server.inject({
        method: "POST",
        url: "/api/domains",
        cookies: authCookie,
        payload: { domain_name: sslDomain },
      });
      assert.equal(created.statusCode, 201);
      sslDomainId = created.json().domain.id;

      const initial = await server.inject({
        method: "GET",
        url: `/api/domains/${sslDomainId}/ssl`,
        cookies: authCookie,
      });
      assert.equal(initial.statusCode, 200);
      assert.equal(initial.json().ssl.ssl_status, false);

      // Sertifika istegi ARTIK GERCEKTEN certbot calistiriyor. Bu test domaini
      // (.test.invalid) hicbir zaman dogrulanamaz, bu yuzden beklenen sonuc
      // BASARISIZLIK — ama SESSIZ degil: 409 + gercek sebep donmeli.
      //
      // NEDEN 409, 500 DEGIL: apps/web/src/lib/api.ts 5xx govdelerini
      // "Panel API servisi gecici olarak kullanilamiyor" ile DEGISTIRIYOR.
      // 500 dondurursek kullanici "A kaydiniz bu sunucuyu gostermiyor" gibi
      // eyleme donuk sebebi hicbir zaman goremez.
      const requested = await server.inject({
        method: "POST",
        url: `/api/domains/${sslDomainId}/ssl/request`,
        cookies: authCookie,
      });
      assert.equal(
        requested.statusCode,
        409,
        "dogrulanamayan domain icin SSL istegi 409 + gercek sebep donmeli",
      );
      assert.ok(
        typeof requested.json().error === "string" && requested.json().error.length > 0,
        "hata govdesi kullaniciya gosterilecek sebebi tasimali",
      );
      assert.equal(
        requested.json().status,
        undefined,
        "basarisiz istek 'issued' gibi bir durum bildirmemeli",
      );
      // Sonuc (istek DEGIL) gecmise yazilmali.
      const sslLogText = await fs.readFile(pendingSslLog, "utf8");
      const sslLogLine = sslLogText
        .trim()
        .split("\n")
        .reverse()
        .find((line) => line.includes(sslDomain));
      assert.ok(sslLogLine, "SSL islemi gecmise yazilmali");
      assert.equal(JSON.parse(sslLogLine!).status, "failed", "gecmis GERCEK sonucu tutmali");

      // Domain HALA sertifikasiz olmali — basarisiz bir istek ssl_status'u
      // TRUE yapmamali (panelin "yesil ama aslinda yok" hatasi).
      const afterFailure = await server.inject({
        method: "GET",
        url: `/api/domains/${sslDomainId}/ssl`,
        cookies: authCookie,
      });
      assert.equal(
        afterFailure.json().ssl.ssl_status,
        false,
        "basarisiz sertifika istegi domaini SSL'li gostermemeli",
      );

      const pastDate = await server.inject({
        method: "POST",
        url: `/api/domains/${sslDomainId}/ssl/mark-issued`,
        cookies: authCookie,
        payload: { expiresAt: "2020-01-01T00:00:00.000Z" },
      });
      assert.equal(pastDate.statusCode, 400);

      const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
      const marked = await server.inject({
        method: "POST",
        url: `/api/domains/${sslDomainId}/ssl/mark-issued`,
        cookies: authCookie,
        payload: { expiresAt },
      });
      assert.equal(marked.statusCode, 200);
      assert.equal(marked.json().ssl.ssl_status, true);

      // Statik regresyon kontrolü: certbot bu sandbox'ta hiç çalıştırılamadığı
      // için ssl-issue.sh/ssl-renew.sh'ın nginx aktivasyon adımını uçtan uca
      // test edecek bir "seam" yok. 2026-08-28'de bulunan gerçek bug — script
      // gerçek nginx'in çalıştığı proxy-server container'ı yerine bu
      // container'ın kendi izole nginx binary'sini çağırıyordu, yani
      // sertifika alınsa bile HTTPS asla devreye girmezdi — bir daha
      // sessizce geri gelmesin diye script içeriği doğrudan denetleniyor.
      const sslIssueScript = await fs.readFile(
        path.join(PROJECT_ROOT, "ops", "scripts", "ssl-issue.sh"),
        "utf8",
      );
      assert.ok(
        sslIssueScript.includes("docker exec proxy-server nginx -t") &&
          sslIssueScript.includes("docker exec proxy-server nginx -s reload"),
        "ssl-issue.sh gerçek nginx'i (proxy-server container'ı) docker exec ile hedeflemeli, yerel nginx'i DEĞİL",
      );
      // Panel bitis tarihini sertifikadan okuyor; script bunu bildirmezse
      // route 409 doner ve sertifika alinmis olsa bile "kurulamadi" gorunur.
      assert.ok(
        sslIssueScript.includes("SSL_RESULT domain="),
        "ssl-issue.sh sonucu SSL_RESULT satiriyla bildirmeli (panel bitis tarihini oradan okur)",
      );
      // Ust uste tiklama Let's Encrypt limitini yakmamali.
      assert.ok(
        sslIssueScript.includes("--keep-until-expiring"),
        "ssl-issue.sh gecerli sertifikayi korumali (--keep-until-expiring), yoksa tekrar tiklamak LE limitine takar",
      );
      // 2026-09-01: script her calismada kalici .bak dosyasi birakiyordu.
      assert.ok(
        !/\.bak\.\$\(date/.test(sslIssueScript),
        "ssl-issue.sh kalici .bak dosyasi birakmamali (bkz. MEMORY.md 'Yedek birakma')",
      );
      // Uretim kodundaki buildWwwRedirectBlock ozel (export edilmemis); testte
      // ayni sekli yorumlu olarak kuruyoruz — sablon yer tutucusu HTTPS
      // bolumunun icinde ve o bolumun tamami yorumlu duruyor.
      const buildWwwRedirectHttpsForTest = (domain: string) =>
        domain.startsWith("www.")
          ? ""
          : [
              "server {",
              "    listen 443 ssl;",
              "    listen [::]:443 ssl;",
              "    http2 on;",
              `    server_name www.${domain};`,
              "",
              `    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;`,
              `    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;`,
              "",
              `    return 301 https://${domain}$request_uri;`,
              "}",
            ]
              .map((line) => (line.length > 0 ? `# ${line}` : "#"))
              .join("\n");

      // --- Dogrulama hatasi HANGI ALAN oldugunu soylemeli ---
      //
      // 2026-09-02 kullanici sikayeti: musteri hesabi olustururken ekranda
      // yalnizca "Geçersiz girdi" yaziyordu. Sebep (parola 10 karakterden
      // kisa) API cevabinin `issues` alaninda DURUYORDU ama arayuz sadece
      // `error` alanini gosteriyor. Ayni genel mesaj 8 dosyada 15 yerde
      // kullaniliyordu; mesaj artik sunucuda uretiliyor.
      {
        // SSL test domaini kullaniliyor. Bu blok YALNIZCA GECERSIZ govdeler
        // gonderiyor (hepsi 400 ile reddediliyor), yani gercek bir musteri
        // hesabi olusmuyor ve domainin sahipligi degismiyor.
        const musteriDomain = sslDomainId;
        if (musteriDomain) {
          const kisaParola = await server.inject({
            method: "POST",
            url: `/api/domains/${musteriDomain}/customer-account`,
            cookies: authCookie,
            // "kisa1234": 8 karakter ama YALNIZCA kucuk harf + rakam (2 sinif).
            // Yeni politika 12'den kisa parolalarda 3 sinif istiyor.
            // NOT: "Kisa1234!" ARTIK GECERLIDIR (4 sinif) — kullanici
            // "Melih135. yapacak kadar efektif olsun" dedi ve kural buna gore
            // gevsetildi; bu testin ilk hali onu reddediyordu.
            payload: { username: "denememusteri", email: "deneme@ornek.test", password: "kisa1234" },
          });
          assert.equal(kisaParola.statusCode, 400);
          const mesaj = kisaParola.json().error as string;
          assert.notEqual(mesaj, "Geçersiz girdi", "genel mesaj kullanilmamali");
          assert.ok(
            /parola|büyük harf/i.test(mesaj),
            `hata mesaji HANGI alan ve HANGI kural oldugunu soylemeli, gelen: ${mesaj}`,
          );

          // Kullanicinin ornegi SUNUCUDA da gecmeli — arayuzle sunucunun
          // ayni kurali uyguladiginin ucta ucta kaniti.
          const makulParola = await server.inject({
            method: "POST",
            url: `/api/domains/${musteriDomain}/customer-account`,
            cookies: authCookie,
            payload: { username: "ab", email: "deneme@ornek.test", password: "Melih135." },
          });
          assert.equal(
            makulParola.statusCode,
            400,
            "yalnizca kullanici adi kisa oldugu icin reddedilmeli",
          );
          assert.ok(
            !/parola/i.test(makulParola.json().error as string),
            `"Melih135." gecerli bir parola olmali; hata parolayi suclamamali: ${makulParola.json().error}`,
          );

          const kisaAd = await server.inject({
            method: "POST",
            url: `/api/domains/${musteriDomain}/customer-account`,
            cookies: authCookie,
            payload: { username: "ab", email: "deneme@ornek.test" },
          });
          assert.equal(kisaAd.statusCode, 400);
          assert.ok(
            (kisaAd.json().error as string).includes("Kullanıcı adı"),
            "kullanici adi hatasi alan adiyla bildirilmeli",
          );

          const bozukMail = await server.inject({
            method: "POST",
            url: `/api/domains/${musteriDomain}/customer-account`,
            cookies: authCookie,
            payload: { username: "denememusteri", email: "bozuk" },
          });
          assert.equal(bozukMail.statusCode, 400);
          assert.ok(
            (bozukMail.json().error as string).toLowerCase().includes("e-posta"),
            "e-posta hatasi alan adiyla bildirilmeli",
          );

          // `issues` KORUNMALI: arayuz alan bazli hata gostermek isteyebilir.
          assert.ok(
            Array.isArray(bozukMail.json().issues),
            "issues alani korunmali",
          );
        }
      }
      // Elle yazilmis kural metinleri de kalmamali.
      //
      // 2026-09-02: parola kurali gevsetildikten sonra mail.ts ve ftp.ts hala
      // "en az 12 karakterli parola" diyordu — mesaj semadan degil elden
      // geliyordu. Sayiyi metne gomen her mesaj, kural degisiminde sessizce
      // yalan soyler.
      {
        const routesDir = path.join(PROJECT_ROOT, "apps", "api", "src", "routes");
        const suclular: string[] = [];
        for (const file of await fs.readdir(routesDir)) {
          if (!file.endsWith(".ts")) continue;
          const body = await fs.readFile(path.join(routesDir, file), "utf8");
          if (/\d+ karakterli parola/.test(body)) suclular.push(file);
        }
        assert.deepEqual(
          suclular,
          [],
          `parola uzunlugu metne gomulmus: ${suclular.join(", ")} — mesaj semadan uretilmeli`,
        );
      }

      // Genel mesaj hicbir route'ta kalmamali.
      {
        const routesDir = path.join(PROJECT_ROOT, "apps", "api", "src", "routes");
        const kalanlar: string[] = [];
        for (const file of await fs.readdir(routesDir)) {
          if (!file.endsWith(".ts")) continue;
          const body = await fs.readFile(path.join(routesDir, file), "utf8");
          if (body.includes('error: "Geçersiz girdi"')) kalanlar.push(file);
        }
        assert.deepEqual(
          kalanlar,
          [],
          `su dosyalarda hala genel "Geçersiz girdi" mesaji var: ${kalanlar.join(", ")}`,
        );
      }

      // --- Disaridan SQL yukleme SESSIZCE BASARILI GORUNMEMELI ---
      //
      // 2026-09-01, kendi testimde bulundu: `mysql -e "SOURCE dosya"` hatali
      // bir ifadede DURMAZ, hatayi stderr'e yazip devam eder ve 0 ILE CIKAR.
      // Tamamen gecersiz bir dosya "basariyla yuklendi" donuyordu. Yarim
      // yuklenmis bir veritabanini "tamam" diye raporlamak, hic yuklememekten
      // daha kotudur — kullanici veriye guvenir.
      {
        const importSource = await fs.readFile(
          path.join(PROJECT_ROOT, "apps", "api", "src", "lib", "db-import.ts"),
          "utf8",
        );
        assert.ok(
          importSource.includes("--abort-source-on-error"),
          "mysql yuklemesi --abort-source-on-error kullanmali (yoksa hatali dokum 'basarili' doner)",
        );
        assert.ok(
          importSource.includes("assertNoSqlError"),
          "cikis kodu 0 olsa bile stderr'deki SQL hatasi basarisizlik sayilmali",
        );
        assert.ok(
          importSource.includes("ON_ERROR_STOP=1"),
          "psql yuklemesi ON_ERROR_STOP=1 kullanmali",
        );
        // Bicim UZANTIDAN degil ICERIKTEN anlasilmali: `.sql` adiyla gelen bir
        // gzip dosyasi psql'e ham verilse "syntax error" ile duserdi.
        assert.ok(
          importSource.includes("0x1f") && importSource.includes("0x8b"),
          "gzip tespiti dosya icerigindeki sihirli sayiya bakmali, uzantiya degil",
        );
        // Istemcinin kendi TLS gurultusu kullaniciya uyari diye gosterilmemeli.
        assert.ok(
          importSource.includes("ssl-verify-server-cert"),
          "istemcinin kendi TLS uyarilari kullaniciya gosterilen uyarilardan ayiklanmali",
        );
      }

      // --- Runtime blogu NGINX'IN KONTEYNERINDEN cozulebilir olmali ---
      //
      // 2026-09-01 gercek arizasi: gercek nginx ayri bir konteynerde
      // (proxy-server) ve yalnizca /var/www/vhosts + /etc/nginx/conf.d
      // bind-mount. Runtime blogu bunu gormezden geliyordu:
      //   php   -> `unix:/run/php/...`  (/run PAYLASILMIYOR)
      //   proxy -> `http://127.0.0.1:P` (nginx icin KENDI konteyneri)
      // Ikisi de her istekte 502 veriyordu; panel PHP ve proxy hosting
      // sunuyor gorunuyor ama ikisi de calismiyordu.
      {
        const phpBlock = buildLocationBlock({
          runtime_type: "php",
          php_version: "8.4",
          proxy_port: null,
        });
        assert.ok(
          !phpBlock.includes("unix:"),
          "PHP blogu unix soket KULLANMAMALI — /run nginx konteyneriyle paylasilmiyor",
        );
        assert.ok(
          /fastcgi_pass \d+\.\d+\.\d+\.\d+:\d+;/.test(phpBlock),
          "PHP blogu fastcgi_pass icin TCP adresi kullanmali",
        );
        const proxyBlock = buildLocationBlock({
          runtime_type: "proxy",
          php_version: null,
          proxy_port: 4321,
        });
        assert.ok(
          !proxyBlock.includes("127.0.0.1"),
          "Proxy blogu 127.0.0.1 KULLANMAMALI — nginx icin orasi kendi konteyneri",
        );
        assert.ok(
          proxyBlock.includes(":4321"),
          "Proxy blogu secilen portu korumali",
        );
        // Hijyen kurali (2026-09-27): her runtime blogu yedek/log/kilit dosyalarini reddeder, .md'yi reddetmez.
        for (const block of [phpBlock, proxyBlock, buildLocationBlock({ runtime_type: "static", php_version: null, proxy_port: null })]) {
          assert.ok(
            block.includes('location ~* "(\\.(bak|orig|swp|log)|-lock\\.json|\\.bak-[a-z0-9]+)$" { deny all; }'),
            "Her location blogu hijyen deny kuralini icermeli",
          );
          assert.ok(!/\(bak\|[^"]*md/.test(block), "Hijyen kurali .md dosyalarini reddetmemeli");
        }
        // Panelin kendi vhost'u zaten dogru adresi kullaniyor; runtime blogu
        // onunla AYNI hedefi gostermeli, yoksa biri calisip digeri calismaz.
        const upstreamHost = /fastcgi_pass (\d+\.\d+\.\d+\.\d+):/.exec(phpBlock)?.[1];
        assert.ok(
          upstreamHost && proxyBlock.includes(`http://${upstreamHost}:`),
          "php ve proxy ayni upstream adresini kullanmali",
        );
      }

      // --- www her domainde calismali ---
      //
      // Kullanici sikayeti (2026-09-01): alan adi aciliyor ama `www.` yazinca
      // DNS_PROBE_FINISHED_NXDOMAIN / baglanti hatasi. Uc katman gerekiyor ve
      // ikisi eksikti: (1) DNS'te www kaydi — zaten uretiliyordu, (2) nginx
      // server_name'de www — YOKTU, istek catch-all'a dusuyordu, (3) sertifika
      // SAN'inda www — YOKTU, ad uyusmazligi olurdu.
      assert.equal(
        serverNamesFor("ornek.com"),
        "ornek.com www.ornek.com",
        "vhost hem alan adini hem www alternatifini karsilamali",
      );
      assert.equal(
        serverNamesFor("www.ornek.com"),
        "www.ornek.com",
        "zaten www ile baslayan adda ikinci bir www eklenmemeli",
      );
      {
        const tmpl = await fs.readFile(
          path.join(PROJECT_ROOT, "ops", "nginx", "templates", "vhost.conf.tmpl"),
          "utf8",
        );
        // Sablonu GERCEKTEN render edip HTTPS'i aktiflestirerek dogruluyoruz;
        // token saymak yaniltici (bir onceki yazimda tam olarak oyle oldu).
        const renderTemplate = (domain: string) =>
          tmpl
            .replaceAll("{{SERVER_NAMES}}", serverNamesFor(domain))
            .replaceAll("{{WWW_REDIRECT_HTTPS}}", buildWwwRedirectHttpsForTest(domain))
            .replaceAll("{{DOMAIN}}", domain)
            .replaceAll("{{DOCUMENT_ROOT}}", `/var/www/vhosts/${domain}/public`)
            .replaceAll("{{LOCATION_BLOCK}}", "    location / { try_files $uri $uri/ =404; }")
            .replaceAll("{{LOCATION_BLOCK_HTTPS}}", "#     location / { try_files $uri $uri/ =404; }");

        const live = activateHttps(renderTemplate("ornek.com"));
        assert.ok(live, "aktiflestirilmis config uretilmeli");
        // KANONIK ADRES TEK: icerigi yalnizca apex sunar.
        assert.ok(
          /server_name ornek\.com;/.test(live!),
          "443 icerik blogu YALNIZCA apex adini sunmali (www ayri blokta 301 ile yonlendirilir)",
        );
        // http://ornek.com ve http://www.ornek.com -> https://ornek.com
        assert.ok(
          live!.includes("server_name ornek.com www.ornek.com;") &&
            live!.includes("return 301 https://ornek.com$request_uri;"),
          "80 portu her iki adi da karsilayip TEK sicramada https://apex'e gitmeli",
        );
        // Cloudflare "Flexible" modda kenar sunucu origin'e HTTP ile baglanir;
        // kosulsuz 301 sonsuz donguye girerdi.
        assert.ok(
          live!.includes('if ($http_x_forwarded_proto = "https")'),
          "80 portundaki yonlendirme X-Forwarded-Proto ile korunmali (Cloudflare Flexible dongusu)",
        );
        // ACME 301 yerse sertifika yenilemesi 90 gun sonra sessizce durur.
        assert.ok(
          /if \(\$request_uri ~ "\^\/\\\.well-known\/acme-challenge\/"\)/.test(live!),
          "ACME istegi yonlendirmeden muaf tutulmali",
        );
        assert.ok(
          !live!.includes("https://$host$request_uri"),
          "$host ile yonlendirme www'yi www'de birakir; hedef kanonik alan adi olmali",
        );
        // https://www.ornek.com -> https://ornek.com
        assert.ok(
          /server_name www\.ornek\.com;[\s\S]*?return 301 https:\/\/ornek\.com\$request_uri;/.test(live!),
          "443'te www icin ayri bir 301 blogu olmali (ikinci ad yapmak 200 dondururdu)",
        );
        // ACME 301 YEMEMELI: yerse yenileme 90 gun sonra sessizce durur.
        assert.ok(
          live!.includes("location ^~ /.well-known/acme-challenge/"),
          "ACME konumu `^~` ile tanimlanmali ki yonlendirmenin onune gecsin",
        );
        // Zaten www ile baslayan alan adinda ikinci bir www blogu uretilmez.
        const wwwDomain = activateHttps(renderTemplate("www.ornek.com"));
        assert.ok(
          !wwwDomain!.includes("www.www.ornek.com"),
          "zaten www ile baslayan alan adinda ikinci bir www blogu uretilmemeli",
        );
        // Sertifika tarafi: www cozumleniyorsa SAN'a eklenmeli, cozumlenmiyorsa
        // EKLENMEMELI — cozumlenmeyen bir ad tum siparisi (apex dahil) batirir.
        assert.ok(
          sslIssueScript.includes('resolves_host "www.$DOMAIN"') &&
            sslIssueScript.includes('CERT_ARGS+=(-d "www.$DOMAIN")'),
          "ssl-issue.sh www'yi YALNIZCA cozumleniyorsa sertifikaya eklemeli (otoriter kontrol ile)",
        );
        // Ad listesi degisince certbot yeni bir dizin (<domain>-0001) acar ve
        // nginx eski yolu okumaya devam ederdi: sertifika yenilenir, site
        // eskisini sunar. Sabit cert-name bunu imkansiz kilar.
        assert.ok(
          sslIssueScript.includes('--cert-name "$DOMAIN"'),
          "ssl-issue.sh sabit --cert-name kullanmali (yoksa www eklenince <domain>-0001 dizini acilir ve nginx eski sertifikayi sunar)",
        );
      }

      // --- ACME dogrulamasi musterinin klasorune yazmamali ---
      //
      // Kullanici sikayeti (2026-09-01): "neden surekli .well-known dosyasi
      // geliyor panele". Sebep: certbot -w olarak site kokunu aliyordu ve
      // orada bos bir .well-known/acme-challenge/ birakiyordu; her yenilemede
      // geri geliyordu. Artik ortak /var/www/vhosts/_acme kullaniliyor.
      {
        const tmpl = await fs.readFile(
          path.join(PROJECT_ROOT, "ops", "nginx", "templates", "vhost.conf.tmpl"),
          "utf8",
        );
        assert.ok(
          tmpl.includes("root /var/www/vhosts/_acme;"),
          "vhost sablonu ACME dogrulamasini ortak _acme dizininden servis etmeli",
        );
        assert.ok(
          sslIssueScript.includes('ACME_WEBROOT="/var/www/vhosts/_acme"') &&
            sslIssueScript.includes('-w "$ACME_WEBROOT"'),
          "ssl-issue.sh certbot'a ortak _acme dizinini vermeli, musterinin site kokunu DEGIL",
        );
        // Bu degisiklikten ONCE alinmis sertifikalarin yenileme kaydi hala
        // site kokunu gosteriyor olabilir; sablon oraya da bakmazsa o
        // sertifikalar 90 gun sonra SESSIZCE yenilenemezdi.
        assert.ok(
          tmpl.includes("@acme-eski-konum"),
          "sablon, eski yenileme kayitlari icin site koküne geri dusmeli (yoksa eski sertifikalar sessizce yenilenemez)",
        );
      }

      // --- Sunucu sagligi: OLCUM, kayit degil ---
      //
      // Kullanici (2026-09-03): "sunucu basligi altinda kaynak ve uptime
      // yaziyor, orada gosterilenler panel ozetiyle ayni". Dogruydu: /server
      // Panel ozeti'ndeki ResourceCharts bilesenini birebir tekrar ediyordu.
      // Sayfa artik panelde hicbir yerde gorunmeyen uc seyi gosteriyor.
      {
        const health = await server.inject({
          method: "GET",
          url: "/api/server/health",
          cookies: authCookie,
        });
        assert.equal(health.statusCode, 200);
        const body = health.json() as {
          services: Array<{ name: string; running: boolean; host: string; port: number }>;
          certificates: Array<{ name: string; daysLeft: number }>;
          jobs: Array<{ label: string; lastOutputAt: string | null; quiet: boolean }>;
          certificateError?: string;
        };
        // Panelin kendi servisleri BU TESTTE calisiyor; olcum onlari gormeli.
        // Gormezse olcum bozuk demektir (port yerine pidfile'a bakmak gibi).
        const api3001 = body.services.find((s) => s.name === "api");
        assert.ok(api3001?.running, "calisan API servisi 'calisiyor' gorunmeli");

        // php-fpm loopback'te DEGIL koprude dinliyor. Ilk yazimda hepsi
        // 127.0.0.1 ile soruldu ve php-fpm calisirken "DURMUS" gorundu —
        // kullaniciyi olmayan bir arizanin pesine dusururdu.
        const php = body.services.find((s) => s.name === "php-fpm");
        assert.ok(php, "php-fpm listede olmali");
        assert.notEqual(php!.host, "127.0.0.1", "php-fpm koprude dinliyor, loopback'te degil");

        // Sertifika listesi okunamazsa "sertifika yok" DEGIL, hata olarak
        // bildirilmeli: kaydin yoklugunu gercegin yoklugu saymak bu panelde
        // tekrar eden hata.
        const healthLib = await fs.readFile(
          path.join(PROJECT_ROOT, "apps", "api", "src", "lib", "server-health.ts"),
          "utf8",
        );
        assert.ok(
          healthLib.includes("certificateError"),
          "sertifika listesi okunamadiginda ayrica bildirilmeli",
        );
        // "Son calisma" DEGIL "son cikti": gozetmen isleri her dakika calisir
        // ama yalnizca mudahale ettiklerinde yazar. lastRunAt demek
        // "gozetmen olmus" yanilgisi yaratirdi.
        assert.ok(
          healthLib.includes("lastOutputAt") && !healthLib.includes("lastRunAt:"),
          "log zaman damgasi 'son cikti' olarak adlandirilmali",
        );
      }
      // /server artik Panel ozeti'ndeki kaynak grafigini TEKRAR ETMEMELI.
      {
        const serverPage = await fs.readFile(
          path.join(PROJECT_ROOT, "apps", "web", "src", "app", "server", "page.tsx"),
          "utf8",
        );
        // KOD aranir, yorum degil: aciklama metninde de "ResourceCharts"
        // geciyor ve duz arama ona kaniyor (ayni tuzaga bu oturumda
        // CSP ve "12 karakterli parola" testlerinde de dusuldu).
        assert.ok(
          !/<ResourceCharts|import \{[^}]*ResourceCharts/.test(serverPage),
          "/server kaynak grafigini tekrar etmemeli — o Panel ozeti'nde",
        );
        const dashboard = await fs.readFile(
          path.join(PROJECT_ROOT, "apps", "web", "src", "app", "dashboard", "page.tsx"),
          "utf8",
        );
        assert.ok(
          /<ResourceCharts/.test(dashboard),
          "kaynak grafigi Panel ozeti'nde kalmali",
        );
      }

      // --- Yenileme SUNUCUDAKI TUM sertifikalari kapsamali ---
      //
      // 2026-09-03: ssl-renew.sh yenilenecekleri `domains` tablosundan
      // turetiyordu. Sunucuda 6 sertifika vardi, 2'si yenileniyordu; uc
      // webmail sertifikasi ve test.diger.test hicbir zaman
      // yenilenmeyecekti ve bunu ancak adres HTTPS vermeyi birakinca
      // ogrenirdik. Panelin kendi sertifikasi da ayni gruba katilacakti.
      {
        const renew = await fs.readFile(
          path.join(PROJECT_ROOT, "ops", "scripts", "ssl-renew.sh"),
          "utf8",
        );
        assert.ok(
          renew.includes("certbot certificates"),
          "yenilenecek liste certbot'tan alinmali — veritabani bir ALT KUME",
        );
        assert.ok(
          !/SELECT domain_name FROM domains WHERE ssl_status/.test(renew),
          "liste artik domains tablosundan turetilmemeli",
        );
        // Kayda degil SONUCA bakan son kontrol: tur bittikten sonra hicbir
        // sertifika bitise yakin kalmamali.
        assert.ok(
          renew.includes("yenileme sonrasi hala") && renew.includes("-lt 20"),
          "yenileme turundan sonra omru kisa kalan sertifika alarm uretmeli",
        );
      }

      // --- Panel kendi sertifikasi + cerez guvenligi ---
      {
        const panelSsl = await fs.readFile(
          path.join(PROJECT_ROOT, "ops", "scripts", "panel-ssl.sh"),
          "utf8",
        );
        // Yumurta-tavuk: sertifika yokken $HOST icin blok da yok, istek
        // default_server'a (panelin kendisine) duser ve ACME yolu /login'e
        // yonlendirilir. Ilk denemede tam olarak bu oldu.
        const acmeAt = panelSsl.indexOf("ACME dogrulama yolu aciliyor");
        const certbotAt = panelSsl.indexOf("certbot certonly");
        assert.ok(acmeAt > 0 && certbotAt > acmeAt, "ACME blogu certbot'tan ONCE yazilmali");
        assert.ok(
          panelSsl.includes("Strict-Transport-Security"),
          "panelin kendi 443 blogu HSTS gondermeli",
        );
        // IP uzerinden erisim bozulmamali: yonetici kendini disarida
        // birakmamali.
        assert.ok(
          panelSsl.includes("studio-panel-ssl.conf") && !panelSsl.includes("studio-panel.conf\""),
          "panel-ssl.sh AYRI bir dosyaya yazmali, mevcut default_server blogunu bozmamali",
        );

        const auth = await fs.readFile(
          path.join(PROJECT_ROOT, "apps", "api", "src", "routes", "auth.ts"),
          "utf8",
        );
        // Cerez KOSULLU secure: kosulsuz yapmak IP uzerinden HTTP girisini
        // sessizce imkansiz kilardi (tarayici cerezi hic saklamaz).
        assert.ok(
          auth.includes("cookieOptsFor") && auth.includes("x-forwarded-proto"),
          "oturum cerezi istegin semasina gore secure olmali",
        );
        assert.ok(
          !/secure: process\.env\.NODE_ENV/.test(auth),
          "NODE_ENV'e bagli sabit secure bayragi kalmamali",
        );
      }

      // --- HSTS: HER alan adinda, YALNIZCA HTTPS'te ---
      //
      // 2026-09-03 kullanici sikayeti: "butun alan adlarinda sorgularda HSTS
      // yok yok yaziyor". Sablondan uretilen vhost'larda HICBIR guvenlik
      // basligi yoktu.
      {
        const tmpl = await fs.readFile(
          path.join(PROJECT_ROOT, "ops", "nginx", "templates", "vhost.conf.tmpl"),
          "utf8",
        );
        const render = (domain: string) =>
          tmpl
            .replaceAll("{{HSTS_VALUE}}", "max-age=31536000")
            .replaceAll("{{SERVER_NAMES}}", serverNamesFor(domain))
            .replaceAll("{{WWW_REDIRECT_HTTPS}}", "")
            .replaceAll("{{DOMAIN}}", domain)
            .replaceAll("{{DOCUMENT_ROOT}}", `/var/www/vhosts/${domain}/public`)
            .replaceAll("{{LOCATION_BLOCK}}", "    location / { try_files $uri $uri/ =404; }")
            .replaceAll("{{LOCATION_BLOCK_HTTPS}}", "#     location / { try_files $uri $uri/ =404; }");

        // Sertifika alinmadan ONCE: 80 blogu var, HSTS OLMAMALI. Sifresiz
        // baglantida tarayici basligi zaten yok sayar; koymak sahte guvence.
        const httpOnly = render("ornek.com").split("--- HTTPS (443, HTTP/2)")[0];
        assert.ok(
          !/^\s*add_header Strict-Transport-Security/m.test(httpOnly),
          "HSTS 80 blogunda BULUNMAMALI",
        );

        // Sertifika alindiktan sonra: 443 blogunda olmali.
        const live = activateHttps(render("ornek.com"));
        assert.ok(live, "aktiflestirilmis config uretilmeli");
        assert.ok(
          /add_header Strict-Transport-Security "max-age=31536000" always;/.test(live!),
          "443 blogu HSTS gondermeli",
        );
        // `always` sart: onsuz nginx basligi yalnizca 2xx/3xx'e ekler, 404 ve
        // 500 yanitlari korumasiz kalirdi.
        assert.ok(
          !/add_header Strict-Transport-Security [^\n]*[^;\s]\s*;\s*$/m.test(
            live!.split("\n").filter((l) => l.includes("Strict-Transport-Security")).join("\n"),
          ) ||
            live!
              .split("\n")
              .filter((l) => l.includes("Strict-Transport-Security"))
              .every((l) => l.includes("always")),
          "HSTS basligi `always` ile eklenmeli",
        );
        // Aktif config'te 80 blogu (yonlendirme) hala HSTS gondermemeli.
        const redirectBlock = live!.slice(live!.lastIndexOf("listen 80;"));
        assert.ok(
          !redirectBlock.includes("Strict-Transport-Security"),
          "HTTP->HTTPS yonlendirme blogu HSTS gondermemeli",
        );
        // Bozucu olmayan digerleri de olmali; CSP ise OLMAMALI (genel bir
        // kural musteri sitelerini sessizce bozar).
        for (const header of ["X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options"]) {
          assert.ok(live!.includes(header), `${header} 443 blogunda olmali`);
        }
        // DIREKTIF aranir, kelime degil: sablonun aciklama yorumunda da
        // "Content-Security-Policy" geciyor ve duz arama ona kaniyor.
        assert.ok(
          !/^\s*add_header Content-Security-Policy/m.test(live!),
          "sablon genel bir CSP dayatmamali — icerige gore yazilmali",
        );

        // www yonlendirme blogu da HSTS gondermeli: ziyaretci once www'ye
        // gelirse politikayi orada ogrenmeli.
        const withWww = activateHttps(
          tmpl
            .replaceAll("{{HSTS_VALUE}}", "max-age=31536000")
            .replaceAll("{{SERVER_NAMES}}", serverNamesFor("ornek.com"))
            .replaceAll(
              "{{WWW_REDIRECT_HTTPS}}",
              ["# server {", '#     add_header Strict-Transport-Security "max-age=31536000" always;', "# }"].join("\n"),
            )
            .replaceAll("{{DOMAIN}}", "ornek.com")
            .replaceAll("{{DOCUMENT_ROOT}}", "/var/www/vhosts/ornek.com/public")
            .replaceAll("{{LOCATION_BLOCK}}", "    location / { }")
            .replaceAll("{{LOCATION_BLOCK_HTTPS}}", "#     location / { }"),
        );
        assert.equal(
          (withWww!.match(/add_header Strict-Transport-Security/g) ?? []).length,
          2,
          "hem icerik hem www yonlendirme blogu HSTS gondermeli",
        );

        // webmail sertifikasi da HSTS gondermeli.
        const webmailScript = await fs.readFile(
          path.join(PROJECT_ROOT, "ops", "scripts", "webmail-ssl.sh"),
          "utf8",
        );
        assert.ok(
          webmailScript.includes("Strict-Transport-Security") && webmailScript.includes("always"),
          "webmail-ssl.sh urettigi 443 blogunda HSTS gondermeli",
        );
      }

      // --- Posta DNS'i her domainde TAM olmali ---
      //
      // 2026-09-02 kullanici sikayeti: hotmail "gonderenin geldigini
      // dogrulayamadik" dedi ve iki yon de calismadi. Sebep: panel MX/SPF/
      // DKIM/DMARC kayitlarini PLANLIYOR ve kendi veritabanina yaziyordu ama
      // domainin saglayicisi "local" isaretliyse gercek DNS'e (Cloudflare)
      // hic gitmiyordu. Sunucu tarafi hazirdi; yalnizca DNS eksikti.
      {
        const mailDns = await fs.readFile(
          path.join(PROJECT_ROOT, "apps", "api", "src", "lib", "mail-dns.ts"),
          "utf8",
        );
        // Bes kaydin BESI de kontrol edilmeli; biri atlanirsa panel eksigi
        // "tamam" gosterir.
        for (const kind of ["mail-a", "mx", "spf", "dkim", "dmarc"]) {
          assert.ok(mailDns.includes(`"${kind}"`), `posta DNS kontrolu ${kind} kaydini icermeli`);
        }
        // Karar DNS'ten olculmeli, panelin kaydindan degil.
        assert.ok(
          mailDns.includes("resolveSoa") && mailDns.includes("setServers"),
          "posta DNS durumu otoriter sunucudan olculmeli (yerel negatif onbellek yaniltir)",
        );
        // ENOTFOUND "eksik", diger hatalar "bakilamadi" olmali: gercek bir
        // ariza "kayit yok" diye gosterilirse kullanici olmayan bir sorunu
        // duzeltmeye calisir.
        assert.ok(
          mailDns.includes('"bakilamadi"'),
          "olculemeyen durum 'eksik'ten AYRI bildirilmeli",
        );
        const mailRoute = await fs.readFile(
          path.join(PROJECT_ROOT, "apps", "api", "src", "routes", "mail.ts"),
          "utf8",
        );
        assert.ok(
          mailRoute.includes("ensureMailDns"),
          "hesap acilirken posta DNS kayitlari kendiliginden tamamlanmali",
        );
        assert.ok(
          mailRoute.includes("checkMailDns"),
          "listeleme cevabi GERCEK DNS durumunu tasimali",
        );
      }

      // --- Devralinan bolgedeki eski kayitlar ---
      //
      // 2026-09-05 kullanici sikayeti: baska saglayicidan (turkticaret.net)
      // devralinan bolgede "eksik kayitlari olustur" dugmesi ham Ingilizce
      // "A CNAME record with that host already exists" dondu. Gorunen hata en
      // kucuk sorundu; karsilastirma yalnizca ad+tip'e baktigi icin YABANCI
      // bir A/MX "zaten var" sayilip panelin kaydi hic yazilmiyordu — posta
      // sessizce eski sunucuya gider.
      {
        const domain = "ornek.test";
        const mailA = { record_type: "A", name: "mail.ornek.test", content: "10.0.0.1" };

        // Ayni kayit yerindeyse dokunulmaz.
        assert.ok(
          findDnsConflicts(mailA, [{ id: "1", type: "A", name: "mail.ornek.test", content: "10.0.0.1" }], domain)
            .exists,
          "ayni ad+tip+deger zaten varsa tekrar yazilmamali",
        );

        // CNAME isgali: Cloudflare'i hic aramadan, ne yapilacagi soylenmeli.
        const cnameOnMail = findDnsConflicts(
          mailA,
          [{ id: "1", type: "CNAME", name: "mail.ornek.test", content: "webmail.eski.test" }],
          domain,
        );
        assert.equal(cnameOnMail.exists, false, "CNAME varken kayit 'zaten var' sayilmamali");
        assert.equal(cnameOnMail.conflicts.length, 1, "CNAME cakismasi bulunmali");
        assert.ok(cnameOnMail.conflicts[0].blocking, "CNAME varken A yazilamaz");
        assert.ok(
          cnameOnMail.conflicts[0].takeoverSafe,
          "mail. altindaki eski CNAME devralinabilir olmali (posta yarim calismaz)",
        );
        assert.ok(
          cnameOnMail.conflicts[0].message.includes("webmail.eski.test"),
          "cakisma mesaji hangi kaydin engelledigini SOYLEMELI",
        );

        // Yabanci A: "zaten var" DEGIL — panelinki yazilmali, eskisi kaldirilmali.
        const foreignA = findDnsConflicts(
          mailA,
          [{ id: "1", type: "A", name: "mail.ornek.test", content: "203.0.113.9" }],
          domain,
        );
        assert.equal(foreignA.exists, false, "farkli degerli A kaydi 'zaten var' sayilmamali");
        assert.ok(
          foreignA.conflicts[0].takeoverSafe && foreignA.conflicts[0].message.includes("203.0.113.9"),
          "mail. altindaki eski A kaydi devralinmali ve bildirilmeli",
        );

        // Yabanci MX de ayni: gelen postanin bir kismi eski sunucuya gider.
        const foreignMx = findDnsConflicts(
          { record_type: "MX", name: "ornek.test", content: "mail.ornek.test" },
          [{ id: "1", type: "MX", name: "ornek.test", content: "mx.eski.test", priority: 10 }],
          domain,
        );
        assert.equal(foreignMx.exists, false, "yabanci MX panelin MX'ini 'var' gostermemeli");
        assert.ok(
          foreignMx.conflicts[0].takeoverSafe && foreignMx.conflicts[0].message.includes("mx.eski.test"),
          "eski MX devralinmali ve bildirilmeli",
        );

        // Ikinci SPF ASLA yazilmaz: RFC 7208 geregi permerror uretir ve giden
        // postanin tamami dogrulamayi geceremez.
        const secondSpf = findDnsConflicts(
          { record_type: "TXT", name: "ornek.test", content: "v=spf1 a mx ip4:10.0.0.1 ~all" },
          [{ id: "1", type: "TXT", name: "ornek.test", content: '"v=spf1 include:_spf.eski.test ~all"' }],
          domain,
        );
        assert.ok(
          secondSpf.conflicts[0].blocking && secondSpf.conflicts[0].takeoverSafe,
          "ikinci SPF yazilmamali; eski SPF devralinmali",
        );
        assert.ok(secondSpf.conflicts[0].message.includes("SPF"), "SPF cakismasi sebebiyle bildirilmeli");

        // Cloudflare TXT'yi tirnakli dondurur; ayni deger tekrar yazilmamali.
        assert.ok(
          findDnsConflicts(
            { record_type: "TXT", name: "_dmarc.ornek.test", content: "v=DMARC1; p=none;" },
            [{ id: "1", type: "TXT", name: "_dmarc.ornek.test", content: '"v=DMARC1; p=none;"' }],
            domain,
          ).exists,
          "tirnakli donen ayni TXT kaydi kopyalanmamali",
        );

        // EN SINSI DURUM: panelin kaydi YERINDE ama eski saglayicininki de
        // duruyor. Eski kod burada "zaten var" deyip cikiyordu; gelen postanin
        // yarisi eski sunucuya gitmeye devam ediyordu ve panel "eksik kayit
        // yok" diyordu. Cakisma taramasi bu kisa devreye BAGLI OLMAMALI.
        const bothMx = findDnsConflicts(
          { record_type: "MX", name: "ornek.test", content: "mail.ornek.test" },
          [
            { id: "1", type: "MX", name: "ornek.test", content: "mail.ornek.test", priority: 10 },
            { id: "2", type: "MX", name: "ornek.test", content: "mx.eski.test", priority: 10 },
          ],
          domain,
        );
        assert.ok(bothMx.exists, "panelin MX'i yerindeyse yeniden yazilmamali");
        assert.equal(bothMx.conflicts.length, 1, "eski MX 'zaten var' kisa devresinde KAYBOLMAMALI");
        assert.ok(
          bothMx.conflicts[0].takeoverSafe && bothMx.conflicts[0].record.id === "2",
          "kaldirilacak kayit ESKI olan olmali, panelinki degil",
        );

        // WEB KAYITLARI DEVRALINMAZ. Apeks A ve www'de calisan bir site
        // olabilir; panele tasinmadan once silmek siteyi karartir.
        const apexA = findDnsConflicts(
          { record_type: "A", name: "ornek.test", content: "10.0.0.1" },
          [
            { id: "1", type: "A", name: "ornek.test", content: "203.0.113.9" },
            { id: "2", type: "A", name: "ornek.test", content: "10.0.0.1" },
          ],
          domain,
        );
        assert.equal(apexA.conflicts.length, 1, "apeks A'da eski kayit bildirilmeli (trafik bolunur)");
        assert.equal(
          apexA.conflicts[0].takeoverSafe,
          false,
          "apeks A (web) kendiliginden SILINMEMELI",
        );
        const wwwCname = findDnsConflicts(
          { record_type: "A", name: "www.ornek.test", content: "10.0.0.1" },
          [{ id: "1", type: "CNAME", name: "www.ornek.test", content: "ornek.test" }],
          domain,
        );
        assert.equal(wwwCname.conflicts[0].takeoverSafe, false, "www CNAME kendiliginden SILINMEMELI");

        // Panelin PLANLAMADIGI ama postayi bozan kalintilar da bildirilmeli:
        // autoconfig/autodiscover dururken Outlook musteriyi eski sunucuya baglar.
        const leftovers = autoconfigLeftovers(
          [
            { id: "1", type: "CNAME", name: "autodiscover.ornek.test", content: "autodiscover.eski.test" },
            { id: "2", type: "CNAME", name: "autoconfig.ornek.test", content: "mail.ornek.test" },
          ],
          domain,
        );
        assert.equal(leftovers.length, 1, "yalnizca DISARIYI gosteren otomatik kurulum kaydi bildirilmeli");
        assert.ok(
          leftovers[0].includes("autodiscover.ornek.test"),
          "eski otomatik kurulum kaydi adiyla bildirilmeli",
        );
      }

      // OpenDKIM tablolari yeniden okutulmali.
      //
      // `reload` KeyTable/SigningTable'i yeniden yaziyordu ama opendkim'e
      // haber vermiyordu; OpenDKIM bu tablolari yalnizca baslangicta okur.
      // Sonuc: panelden acilan yeni posta domaini HIC imzalanmiyordu.
      {
        const mailCtl = await fs.readFile(
          path.join(PROJECT_ROOT, "ops", "scripts", "mail-ctl.sh"),
          "utf8",
        );
        assert.ok(
          mailCtl.includes("reload_opendkim") && mailCtl.includes("kill -USR1"),
          "mail-ctl.sh reload opendkim'e tablolari yeniden okutmali (SIGUSR1)",
        );
        assert.ok(
          /reload\)[\s\S]{0,400}reload_opendkim/.test(mailCtl),
          "reload dalinda opendkim yeniden yuklenmeli",
        );
      }

      // --- DNS kontrolu YEREL ONBELLEGE GUVENMEMELI ---
      //
      // 2026-09-02: panel webmail A kaydini Cloudflare'de basariyla acti,
      // otoriter sunucu dogru cevabi veriyordu, ama Docker'in gomulu DNS'i
      // NXDOMAIN'i onbellege almisti ve SOA minimum'u kadar (30 dk) oyle
      // demeye devam etti. `getent` ile bakan script webmail sertifikasini
      // hic kurmadi; kullanici "bu problemi zaten cozmedik mi" dedi cunku
      // kayit gercekten vardi. Karar, onbellegin degil otoritenin cevabina
      // dayanmali.
      assert.ok(
        sslIssueScript.includes("resolves_host") &&
          sslIssueScript.includes('dig +short "@$_rh_ns"'),
        "ssl-issue.sh otoriter sunucuya sorarak DNS kontrolu yapmali (yerel negatif onbellek yaniltir)",
      );
      assert.ok(
        !/if getent ahostsv4 "(www|\$WEBMAIL_HOST)/.test(sslIssueScript),
        "DNS kararlari duz getent ile verilmemeli",
      );
      {
        const sslDns = await fs.readFile(
          path.join(PROJECT_ROOT, "apps", "api", "src", "lib", "ssl-dns.ts"),
          "utf8",
        );
        assert.ok(
          sslDns.includes("resolveSoa") && sslDns.includes("setServers"),
          "API tarafi da otoriter sunucuya sormali; aksi halde script ile ayrisir",
        );
        // Kayit acilamadiginda SESSIZ gecilmemeli.
        assert.ok(
          sslDns.includes('"cloudflare-yok"') && sslDns.includes('"ip-yok"'),
          "kayit acilamama sebepleri ayirt edilip bildirilmeli",
        );
      }

      // --- Webmail sertifikasi ayni tikla kurulmali ---
      //
      // Kullanici sikayeti (2026-09-01): her yeni domainde webmail satirinda
      // "HTTPS yok" yaziyordu, cunku webmail-ssl.sh elle calistirilan ayri bir
      // adimdi ve kimse atmiyordu.
      assert.ok(
        sslIssueScript.includes('"$SCRIPT_DIR/webmail-ssl.sh" "$DOMAIN"'),
        "ssl-issue.sh webmail sertifikasini da kurmali (ayri elle adim birakmamali)",
      );
      assert.ok(
        sslIssueScript.includes("webmail=$WEBMAIL_STATUS"),
        "webmail sonucu SSL_RESULT ile bildirilmeli — panel 'kuruldu' ile 'dns yok'u ayirt edebilmeli",
      );
      // Webmail'in kurulamamasi ASIL sertifikayi basarisiz saymamali.
      assert.ok(
        /if WEBMAIL_OUT="\$\("\$SCRIPT_DIR\/webmail-ssl\.sh"/.test(sslIssueScript),
        "webmail adimi kosullu calismali (basarisizligi olumcul olmamali)",
      );

      // --- Sablon HTTPS aktivasyonu: shell ile TypeScript AYNI sonucu vermeli.
      //
      // Ayni kural iki yerde yasiyor: ops/scripts/ssl-issue.sh icindeki sed
      // hatti ve lib/nginxTemplate.ts icindeki activateHttps(). Ikisi ayrisirsa
      // "sertifika alindi ama config yanlis" ya da "runtime degisince HTTPS
      // kayboldu" seklinde sessiz bir bozulma olur; bu test ayrismayi yakalar.
      {
        const tmplPath = path.join(PROJECT_ROOT, "ops", "nginx", "templates", "vhost.conf.tmpl");
        const rendered = (await fs.readFile(tmplPath, "utf8"))
          .replaceAll("{{DOMAIN}}", "https-activate.test.invalid")
          .replaceAll("{{DOCUMENT_ROOT}}", "/var/www/vhosts/https-activate.test.invalid/public")
          .replaceAll("{{LOCATION_BLOCK}}", "    location / {\n        try_files $uri $uri/ =404;\n    }")
          .replaceAll(
            "{{LOCATION_BLOCK_HTTPS}}",
            "#     location / {\n#         try_files $uri $uri/ =404;\n#     }",
          );
        const scratch = path.join(GENERATED_DIR, `https-activate-${Date.now()}.conf`);
        await fs.mkdir(GENERATED_DIR, { recursive: true });
        await fs.writeFile(scratch, rendered, "utf8");
        try {
          const { stdout: viaSed } = await execFileAsync("sh", [
            "-c",
            `sed -n '/--- HTTPS (443, HTTP\\/2)/,$p' ${JSON.stringify(scratch)} | tail -n +2 | sed -E 's/^# ?//'`,
          ]);
          const viaTs = activateHttps(rendered);
          assert.ok(viaTs, "activateHttps sablondaki HTTPS blogunu bulmali");
          assert.equal(
            viaTs!.trimEnd(),
            viaSed.trimEnd(),
            "nginxTemplate.activateHttps() ile ssl-issue.sh'in sed hatti AYNI ciktiyi uretmeli",
          );
          assert.ok(viaTs!.includes("listen 443 ssl"), "aktiflestirilmis config 443 dinlemeli");
          assert.ok(
            !viaTs!.includes("# server {"),
            "aktiflestirilmis config'te yorumlu server blogu kalmamali",
          );
        } finally {
          await fs.rm(scratch, { force: true });
        }
      }

      // --- "Zaten HTTPS mi?" tespiti yorumlu satira KANMAMALI ---
      //
      // 2026-09-01 gercek arizasi: ssl-issue.sh `grep "listen 443 ssl"` ile
      // bakiyordu; sablonun kendi HTTPS blogu dosyada "#     listen 443 ssl;"
      // olarak yorumlu durdugu icin script "zaten HTTPS" deyip aktivasyonu
      // ATLADI. Sertifika alindi, HTTPS acilmadi, Cloudflare 525 vermeye
      // devam etti — yani sessiz basarisizlik. Ayni kural iki yerde:
      // nginxTemplate.httpsIsLive() ve ssl-issue.sh'in grep'i.
      {
        const commentedOnly = [
          "# HTTPS blogu asagida `listen 443 ssl` olarak yorumlu duruyor",
          "server {",
          "    listen 80;",
          "}",
          "# server {",
          "#     listen 443 ssl;",
          "# }",
        ].join("\n");
        const reallyHttps = "server {\n    listen 443 ssl;\n    http2 on;\n}\n";
        const uncommented = /^[ \t]*listen[ \t]+443[ \t]+ssl/m;
        assert.equal(uncommented.test(commentedOnly), false, "yorumlu blok HTTPS sayilmamali");
        assert.equal(uncommented.test(reallyHttps), true, "gercek 443 blogu HTTPS sayilmali");

        // Kabuk tarafi da AYNI kararı vermeli.
        const scratchConf = path.join(GENERATED_DIR, `https-detect-${Date.now()}.conf`);
        await fs.writeFile(scratchConf, commentedOnly, "utf8");
        try {
          const { stdout: hits } = await execFileAsync("sh", [
            "-c",
            `grep -cE '^[[:space:]]*listen[[:space:]]+443[[:space:]]+ssl' ${JSON.stringify(scratchConf)} || true`,
          ]);
          assert.equal(hits.trim(), "0", "ssl-issue.sh'in grep deseni yorumlu satiri HTTPS saymamali");
        } finally {
          await fs.rm(scratchConf, { force: true });
        }
        assert.ok(
          sslIssueScript.includes('grep -qE "^[[:space:]]*listen[[:space:]]+443[[:space:]]+ssl"'),
          "ssl-issue.sh yorumsuz direktif arayan grep desenini kullanmali (duz 'listen 443 ssl' araması yorumlu satıra kanar)",
        );
      }

      // --- Ucretli (ozel) sertifika: ssl-custom.sh <-> panel sozlesmesi ---
      //
      // Uc yer ayni kuralda anlasmali: ssl-issue.sh'in sed hatti, nginxTemplate
      // .activateHttps() ve ssl-custom.sh'in sed hatti (HTTPS henuz yokken
      // ozel sertifika kurulursa vhost'u o acar). Ayrisirlarsa "sertifika
      // yuklendi ama 443 acilmadi" gibi sessiz bir bozulma olur.
      {
        const customScriptPath = path.join(PROJECT_ROOT, "ops", "scripts", "ssl-custom.sh");
        const customScript = await fs.readFile(customScriptPath, "utf8");
        const sedRule = "sed -n '/--- HTTPS (443, HTTP\\/2)/,$p'";
        assert.ok(
          customScript.includes(sedRule) && sslIssueScript.includes(sedRule),
          "ssl-custom.sh ve ssl-issue.sh HTTPS aktivasyon sed hattini AYNI kullanmali",
        );
        assert.ok(
          customScript.includes('grep -qE "^[[:space:]]*listen[[:space:]]+443[[:space:]]+ssl"'),
          "ssl-custom.sh de yorumsuz 443 direktifi aramali",
        );
        await execFileAsync("bash", ["-n", customScriptPath]);

        const info = parseInfo(
          [
            "present=1",
            "type=custom",
            "subject=C = TR, CN = ornek.com",
            "issuer=O = Test CA",
            "not_after=2027-01-02T03:04:05Z",
            "sans=DNS:ornek.com,DNS:www.ornek.com",
            "key_bits=2048",
            "chain_length=3",
            "pending_csr=1",
          ].join("\n"),
        );
        assert.equal(info.present, true);
        assert.equal(info.type, "custom");
        assert.deepEqual(info.sans, ["ornek.com", "www.ornek.com"]);
        assert.equal(info.keyBits, 2048);
        assert.equal(info.chainLength, 3);
        assert.equal(info.pendingCsr, true);
        assert.equal(info.notAfter, "2027-01-02T03:04:05.000Z");
        assert.equal(parseInfo("present=0\npending_csr=0").present, false);

        const res = parseResult(
          "x\nSSL_RESULT domain=ornek.com expiry=2027-01-02T03:04:05Z type=custom www=1 chain=ok key=csr issuer=Sectigo Limited\n",
        );
        assert.equal(res?.expiry, "2027-01-02T03:04:05Z");
        assert.equal(res?.www, "1");
        assert.equal(res?.key, "csr");
        assert.equal(res?.issuer, "Sectigo Limited", "bosluklu issuer son alan olarak okunmali");
      }

      // --- root'un dokundugu dosyalar panele geri verilmeli ---
      //
      // 2026-09-01: ssl-issue.sh root olarak calisip ops/generated/<domain>.conf
      // ve webroot'taki .well-known agacini root:root yapti; panel kendi
      // config'ini bir daha yazamadi ve "Nginx config uret" EACCES ile 500
      // dondu. Ayni tuzak DKIM anahtarinda da yasanmisti (bkz. MEMORY.md).
      assert.ok(
        sslIssueScript.includes("restore_owner") &&
          sslIssueScript.includes('restore_owner "$GEN_OWNER" "$GENERATED_CONF"') &&
          sslIssueScript.includes('restore_owner "$ACME_OWNER" "$ACME_WEBROOT"'),
        "ssl-issue.sh root olarak yazdigi dosyalarin sahipligini geri vermeli (yoksa panel kendi dosyasini yazamaz)",
      );

      const sslRenewScript = await fs.readFile(
        path.join(PROJECT_ROOT, "ops", "scripts", "ssl-renew.sh"),
        "utf8",
      );
      assert.ok(
        sslRenewScript.includes("docker exec proxy-server nginx -t") &&
          sslRenewScript.includes("docker exec proxy-server nginx -s reload"),
        "ssl-renew.sh'ın deploy-hook'u gerçek nginx'i (proxy-server container'ı) docker exec ile hedeflemeli, yerel nginx'i DEĞİL",
      );

      console.log("✓ Modül 3 (SSL) self-test geçti (gerçek certbot çağrısı; doğrulanamayan domain için 409 + gerçek sebep)");
    } finally {
      if (sslDomainId) {
        await server.inject({ method: "DELETE", url: `/api/domains/${sslDomainId}`, cookies: authCookie, payload: { confirm: sslDomain } });
      }
      await fs.rm(path.join(env.VHOSTS_ROOT, sslDomain), { recursive: true, force: true });
      if (fsSync.existsSync(pendingSslLog)) {
        const lines = (await fs.readFile(pendingSslLog, "utf8"))
          .split("\n")
          .filter((line) => line && !line.includes(sslDomain));
        await fs.writeFile(pendingSslLog, lines.length ? lines.join("\n") + "\n" : "", "utf8");
      }
      const pendingLog = path.join(GENERATED_DIR, "pending-directory-deletions.jsonl");
      if (fsSync.existsSync(pendingLog)) {
        const lines = (await fs.readFile(pendingLog, "utf8"))
          .split("\n")
          .filter((line) => line && !line.includes(sslDomain));
        await fs.writeFile(pendingLog, lines.length ? lines.join("\n") + "\n" : "", "utf8");
      }
    }

    // --- Veritabanı yönetimi: GERÇEK PostgreSQL veritabanı ve rolü ---
    //
    // Burada mock yok: panel gerçekten CREATE DATABASE / CREATE ROLE çalıştırır,
    // test pg_database'e bakarak veritabanının GERÇEKTEN var olduğunu doğrular,
    // üretilen parolayla GERÇEKTEN bağlanır, sonra silinip gittiğini yine
    // sunucudan okur. MySQL yolu bu konteynerde sunucusuz olduğu için yalnızca
    // "kurulu değil" bildiriminin dürüstlüğü test edilir.
    const dbDomain = `selftest-db-${Date.now()}.test.invalid`;
    let dbDomainId: number | undefined;
    const dbIdent = `sp_test_${Date.now()}`.slice(0, 40);
    try {
      const createdDomain = await server.inject({
        method: "POST",
        url: "/api/domains",
        cookies: authCookie,
        payload: { domain_name: dbDomain },
      });
      assert.equal(createdDomain.statusCode, 201, `db test domaini oluşturulamadı: ${createdDomain.body}`);
      dbDomainId = createdDomain.json().domain.id;

      // Motor durumu gerçek: PostgreSQL ayakta olmalı.
      const engines = await server.inject({
        method: "GET",
        url: "/api/databases/engines",
        cookies: authCookie,
      });
      assert.equal(engines.statusCode, 200);
      const pgEngine = engines.json().engines.find((e: { engine: string }) => e.engine === "postgres");
      assert.equal(pgEngine.available, true, "PostgreSQL motoru kullanılabilir görünmeli");

      // GÜVENLİK: tanımlayıcı adları SQL'e metin olarak giriyor. Enjeksiyon
      // denemeleri regex kapısında 400 ile durmalı — sunucuya HİÇ ulaşmamalı.
      for (const evil of [
        'foo"; DROP TABLE users; --',
        "foo; DROP DATABASE studio_panel",
        "foo bar",
        "Foo",
        "1foo",
        "postgres",
        "studio_panel",
      ]) {
        // Dönüş tipi açıkça yazılı: aksi halde tsc bu çağrıda inject'in
        // tipini çözerken döngüye giriyor (TS7022).
        const identRejected: InjectResponse = await server.inject({
          method: "POST",
          url: `/api/domains/${dbDomainId}/databases`,
          cookies: authCookie,
          payload: { engine: "postgres", dbName: evil, dbUser: "safeuser" },
        });
        assert.equal(
          identRejected.statusCode,
          400,
          `tehlikeli tanımlayıcı reddedilmedi (${evil}): ${identRejected.statusCode} ${identRejected.body}`,
        );
      }
      // users tablosu hâlâ yerinde mi — enjeksiyon gerçekten çalışmamış mı?
      const usersAlive = await server.pg.query("SELECT COUNT(*)::int AS n FROM users");
      assert.ok(usersAlive.rows[0].n >= 0, "users tablosu enjeksiyon denemelerinden sonra kayıp");

      // Gerçek oluşturma.
      const createdDb = await server.inject({
        method: "POST",
        url: `/api/domains/${dbDomainId}/databases`,
        cookies: authCookie,
        payload: { engine: "postgres", dbName: dbIdent, dbUser: dbIdent },
      });
      assert.equal(createdDb.statusCode, 201, `veritabanı oluşturulamadı: ${createdDb.body}`);
      const createdBody = createdDb.json();
      const dbRowId = createdBody.database.id;
      assert.ok(createdBody.password && createdBody.password.length >= 20, "parola dönmedi");

      // GERÇEKTEN var mı — panel kaydına değil, sunucunun kendisine soruyoruz.
      const exists = await server.pg.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [dbIdent],
      );
      assert.equal(exists.rows.length, 1, "veritabanı sunucuda gerçekten oluşmadı");
      const roleExists = await server.pg.query(
        "SELECT 1 FROM pg_roles WHERE rolname = $1",
        [dbIdent],
      );
      assert.equal(roleExists.rows.length, 1, "rol sunucuda gerçekten oluşmadı");

      // Üretilen parola GERÇEKTEN çalışıyor mu: yeni bir bağlantı kuruyoruz.
      {
        const { Client } = await import("pg");
        const url = new URL(env.DATABASE_URL);
        const client = new Client({
          host: url.hostname,
          port: Number(url.port || 5432),
          user: dbIdent,
          password: createdBody.password,
          database: dbIdent,
        });
        // pg.Client bir EventEmitter: bağlantı koparsa 'error' yayar ve
        // dinleyici yoksa Node süreci "Unhandled 'error' event" ile çöker.
        // Bu test bağlantısının kopması beklenen bir durum (aşağıda parola
        // sıfırlanıyor, sonra veritabanı düşürülüyor), o yüzden yutuluyor.
        client.on("error", () => {});
        await client.connect();
        try {
          const who = await client.query("SELECT current_database() AS db, current_user AS usr");
          assert.equal(who.rows[0].db, dbIdent);
          assert.equal(who.rows[0].usr, dbIdent);
        } finally {
          await client.end();
        }
      }

      // Parola sıfırlama gerçek: eski parola artık çalışmamalı.
      const oldPassword = createdBody.password;
      const reset = await server.inject({
        method: "POST",
        url: `/api/domains/${dbDomainId}/databases/${dbRowId}/password`,
        cookies: authCookie,
      });
      assert.equal(reset.statusCode, 200, `parola sıfırlanamadı: ${reset.body}`);
      const newPassword = reset.json().password;
      assert.notEqual(newPassword, oldPassword, "yeni parola eskisiyle aynı");
      {
        const { Client } = await import("pg");
        const url = new URL(env.DATABASE_URL);
        const stale = new Client({
          host: url.hostname,
          port: Number(url.port || 5432),
          user: dbIdent,
          password: oldPassword,
          database: dbIdent,
        });
        // Başarısız connect() hem promise'i reddeder HEM de 'error' yayar.
        stale.on("error", () => {});
        await assert.rejects(
          () => stale.connect(),
          "eski parola sıfırlamadan sonra hâlâ kabul ediliyor",
        );
        await stale.end().catch(() => {});
      }

      // Aynı ad ikinci kez kabul edilmemeli.
      const duplicate = await server.inject({
        method: "POST",
        url: `/api/domains/${dbDomainId}/databases`,
        cookies: authCookie,
        payload: { engine: "postgres", dbName: dbIdent, dbUser: dbIdent },
      });
      assert.equal(duplicate.statusCode, 409, "aynı ad ikinci kez kabul edildi");

      // Silme gerçek: hem panel kaydı hem sunucudaki nesneler gitmeli.
      const removed = await server.inject({
        method: "DELETE",
        url: `/api/domains/${dbDomainId}/databases/${dbRowId}`,
        cookies: authCookie,
      });
      assert.equal(removed.statusCode, 200, `veritabanı silinemedi: ${removed.body}`);
      const goneDb = await server.pg.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbIdent]);
      assert.equal(goneDb.rows.length, 0, "veritabanı sunucudan silinmedi");
      const goneRole = await server.pg.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [dbIdent]);
      assert.equal(goneRole.rows.length, 0, "rol sunucudan silinmedi");

      console.log("✓ veritabanı yönetimi self-test geçti (gerçek CREATE/DROP DATABASE + gerçek parola bağlantısı + enjeksiyon reddi)");
    } finally {
      // Test yarıda kalsa bile sunucuda öksüz nesne bırakmıyoruz.
      await server.pg.query(`DROP DATABASE IF EXISTS "${dbIdent}"`).catch(() => {});
      await server.pg.query(`DROP ROLE IF EXISTS "${dbIdent}"`).catch(() => {});
      if (dbDomainId) {
        await server.inject({
          method: "DELETE",
          url: `/api/domains/${dbDomainId}`,
          cookies: authCookie,
          payload: { confirm: dbDomain },
        });
      }
      await fs.rm(path.join(env.VHOSTS_ROOT, dbDomain), { recursive: true, force: true });
    }

    // --- FTP hesapları: gerçek DB + gerçek SHA-512 crypt + atomik pure-ftpd kaynağı ---
    // pure-ftpd servisi/root gerektiren kurulum çalıştırılmaz. API'nin yönettiği
    // hesap yaşam döngüsü ve üretilecek passwd dosyası gerçek bileşenlerle test edilir.
    const ftpDomain = `selftest-ftp-${Date.now()}.test.invalid`;
    const purePasswdPath = path.join(GENERATED_DIR, "pureftpd.passwd");
    const previousPurePasswd = fsSync.existsSync(purePasswdPath)
      ? await fs.readFile(purePasswdPath)
      : null;
    let ftpDomainId: number | null = null;
    try {
      const created = await server.inject({
        method: "POST",
        url: "/api/domains",
        cookies: authCookie,
        payload: { domain_name: ftpDomain },
      });
      assert.equal(created.statusCode, 201);
      ftpDomainId = created.json().domain.id;

      const shortPassword = await server.inject({
        method: "POST",
        url: `/api/domains/${ftpDomainId}/ftp`,
        cookies: authCookie,
        payload: { username: "ftptest", password: "kisa" },
      });
      assert.equal(shortPassword.statusCode, 400);

      const accountCreated = await server.inject({
        method: "POST",
        url: `/api/domains/${ftpDomainId}/ftp`,
        cookies: authCookie,
        payload: { username: "ftptest", password: "benzersiz-test-parolasi", quotaMb: 256 },
      });
      assert.equal(accountCreated.statusCode, 201, accountCreated.body);
      const accountId = accountCreated.json().account.id;
      assert.equal(accountCreated.json().password, "benzersiz-test-parolasi");

      const listed = await server.inject({
        method: "GET",
        url: `/api/domains/${ftpDomainId}/ftp`,
        cookies: authCookie,
      });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.json().accounts.length, 1);
      assert.equal(listed.json().accounts[0].quota_mb, 256);
      assert.equal("password_hash" in listed.json().accounts[0], false, "parola hash'i liste API'sine sızdı");

      const passwd = await fs.readFile(purePasswdPath, "utf8");
      assert.ok(passwd.includes("ftptest:$6$"), "pure-ftpd kaynağında SHA-512 crypt hash yok");
      assert.ok(!passwd.includes("benzersiz-test-parolasi"), "düz metin parola diske yazıldı");
      assert.equal((await fs.stat(purePasswdPath)).mode & 0o777, 0o600);

      const disabled = await server.inject({
        method: "PATCH",
        url: `/api/domains/${ftpDomainId}/ftp/${accountId}`,
        cookies: authCookie,
        payload: { enabled: false },
      });
      assert.equal(disabled.statusCode, 200);
      assert.equal(disabled.json().account.enabled, false);
      assert.ok(!(await fs.readFile(purePasswdPath, "utf8")).includes("ftptest:"));

      const removed = await server.inject({
        method: "DELETE",
        url: `/api/domains/${ftpDomainId}/ftp/${accountId}`,
        cookies: authCookie,
      });
      assert.equal(removed.statusCode, 200);

      console.log("✓ FTP hesapları self-test geçti (gerçek DB + SHA-512 crypt + 0600 atomik passwd)");
    } finally {
      if (ftpDomainId) {
        await server.inject({ method: "DELETE", url: `/api/domains/${ftpDomainId}`, cookies: authCookie, payload: { confirm: ftpDomain } });
      }
      if (previousPurePasswd) await fs.writeFile(purePasswdPath, previousPurePasswd, { mode: 0o600 });
      else await fs.rm(purePasswdPath, { force: true });
    }

    // --- Modül 9: domain başına e-posta hesapları + admin kotası ---
    //
    // Mail sunucusu (Postfix/Dovecot) bu ortamda KURULU DEĞİL ve kurulmuyor.
    // Test edilen şey, panelin yönettiği hesap yaşam döngüsü, admin-only kota
    // yetkisi ve üretilen dovecot-users dosyası — hepsi gerçek bileşenlerle.
    const mailUsersPath = path.join(GENERATED_DIR, "dovecot-users");
    const previousMailUsers = fsSync.existsSync(mailUsersPath)
      ? await fs.readFile(mailUsersPath)
      : null;
    const mailDomainA = `selftest-mail-a-${Date.now()}.test.invalid`;
    const mailDomainB = `selftest-mail-b-${Date.now()}.test.invalid`;
    let mailIdA: number | null = null;
    let mailIdB: number | null = null;
    let mailCustomerCookie: { studio_session: string } | null = null;

    try {
      // Kapanis (closure) icinde TypeScript'in `server` daraltmasi gecerli
      // degil; yerel takma ad daralmayi koruyor (ayni desen bu dosyada
      // "Tarayici sozlesmesi" blogunda da kullaniliyor).
      const srv = server;
      const makeMailDomain = async (name: string): Promise<number> => {
        const made = await srv.inject({
          method: "POST",
          url: "/api/domains",
          cookies: authCookie,
          payload: { domain_name: name },
        });
        assert.equal(made.statusCode, 201, `mail test domaini olusmadi: ${made.body}`);
        return made.json().domain.id as number;
      };
      mailIdA = await makeMailDomain(mailDomainA);
      mailIdB = await makeMailDomain(mailDomainB);

      // 1) Gecersiz local_part reddedilmeli.
      // Buyuk harf REDDEDILMEZ, normalize edilir (e-posta yerel adlari
      // pratikte harf duyarsizdir) — bu davranis 3. adimda dogrulaniyor.
      // Burada normalize edildikten SONRA da gecersiz kalanlar test edilir.
      for (const bad of ["a..b", "-onde", "arkada-", "bos luk", "türkçe", ".nokta"]) {
        // Ara degisken YOK: `const x = await srv.inject(...)` bu dongude
        // TypeScript'in donus tipini dairesel cikarmasina yol aciyordu.
        assert.equal(
          (
            await srv.inject({
              method: "POST",
              url: `/api/domains/${mailIdA}/mail`,
              cookies: authCookie,
              payload: { localPart: bad, password: "correct-horse-battery" },
            })
          ).statusCode,
          400,
          `gecersiz local_part kabul edildi: ${bad}`,
        );
      }

      // 2) Kisa parola reddedilmeli.
      const shortPass = await srv.inject({
        method: "POST",
        url: `/api/domains/${mailIdA}/mail`,
        cookies: authCookie,
        payload: { localPart: "info", password: "kisa" },
      });
      assert.equal(shortPass.statusCode, 400, "kisa parola kabul edildi");

      // 3) Admin gecerli hesap acar, kota belirler.
      const madeMail = await srv.inject({
        method: "POST",
        url: `/api/domains/${mailIdA}/mail`,
        cookies: authCookie,
        // Bilerek BUYUK harfle gonderiliyor: normalize edilip "info" olmali.
        payload: { localPart: "INFO", password: "correct-horse-battery", quotaMb: 256 },
      });
      assert.equal(madeMail.statusCode, 201, `mail hesabi olusmadi: ${madeMail.body}`);
      const createdMail = madeMail.json();
      assert.equal(
        createdMail.account.address,
        `info@${mailDomainA}`,
        "buyuk harfli girdi kucuk harfe normalize edilmeli",
      );
      assert.equal(createdMail.account.quota_mb, 256);
      assert.equal(createdMail.password, "correct-horse-battery", "duz parola bir kez donmeli");

      // 4) Listede hash SIZMAMALI.
      const listed = await srv.inject({
        method: "GET",
        url: `/api/domains/${mailIdA}/mail`,
        cookies: authCookie,
      });
      assert.equal(listed.statusCode, 200);
      const listedAccounts = listed.json().accounts as Array<Record<string, unknown>>;
      assert.equal(listedAccounts.length, 1);
      assert.equal(
        "password_hash" in listedAccounts[0],
        false,
        "parola hash'i liste API'sine sizdi",
      );

      // 5) Uretilen dosya: bicim dogru, DUZ PAROLA YOK.
      const usersContent = await fs.readFile(mailUsersPath, "utf8");
      assert.ok(
        usersContent.includes(`info@${mailDomainA}:{SHA512-CRYPT}$6$`),
        "dovecot-users satiri beklenen bicimde degil",
      );
      // Dovecot 2.4, 2.3'un `userdb_quota_rule=*:storage=NM` sozdiziminden
      // `userdb_quota_storage_size=NM`'e gecti (bkz. apps/api/src/lib/mail.ts,
      // gercek doveadm/LMTP testiyle dogrulandi: 1MB kotayla 2MB mail "552
      // Quota exceeded" ile reddedildi).
      assert.ok(
        usersContent.includes("userdb_quota_storage_size=256M"),
        "kota extra_fields'e yazilmadi",
      );
      assert.ok(
        !usersContent.includes("correct-horse-battery"),
        "DUZ PAROLA diske yazildi",
      );

      // 6) Dosya modu 0600.
      assert.equal(
        (await fs.stat(mailUsersPath)).mode & 0o777,
        0o600,
        "dovecot-users 0600 degil",
      );

      // 7) Ayni domainde ayni adres -> 409.
      const dup = await srv.inject({
        method: "POST",
        url: `/api/domains/${mailIdA}/mail`,
        cookies: authCookie,
        payload: { localPart: "info", password: "correct-horse-battery" },
      });
      assert.equal(dup.statusCode, 409, "ayni domainde mukerrer adres kabul edildi");

      // 8) FARKLI domainde ayni local_part -> 201. (Istegin dogrudan kaniti:
      //    "info" her domainde bulunabilmeli.)
      const other = await srv.inject({
        method: "POST",
        url: `/api/domains/${mailIdB}/mail`,
        cookies: authCookie,
        payload: { localPart: "info", password: "correct-horse-battery" },
      });
      assert.equal(
        other.statusCode,
        201,
        `ayni local_part farkli domainde reddedildi: ${other.body}`,
      );

      // --- Kota yetkisi: musteri hesabiyla gercek testler ---
      const mailCustomerEmail = `selftest-mailcust+${Date.now()}@example.invalid`;
      const mailAccountRes = await srv.inject({
        method: "POST",
        url: `/api/domains/${mailIdA}/customer-account`,
        cookies: authCookie,
        payload: { username: `mailcust_${Date.now()}`, email: mailCustomerEmail },
      });
      assert.equal(mailAccountRes.statusCode, 201, `musteri hesabi acilmadi: ${mailAccountRes.body}`);
      const mailCustomerLogin = await srv.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: mailCustomerEmail, password: mailAccountRes.json().password },
      });
      assert.equal(mailCustomerLogin.statusCode, 200);
      mailCustomerCookie = {
        studio_session: mailCustomerLogin.cookies.find((c) => c.name === "studio_session")!.value,
      };

      // 9) ISTEGIN CEKIRDEGI: musteri kota gonderirse 403.
      const custWithQuota = await srv.inject({
        method: "POST",
        url: `/api/domains/${mailIdA}/mail`,
        cookies: mailCustomerCookie,
        payload: { localPart: "destek", password: "correct-horse-battery", quotaMb: 99999 },
      });
      assert.equal(
        custWithQuota.statusCode,
        403,
        `musteri kota belirleyebildi (403 bekleniyordu): ${custWithQuota.body}`,
      );

      // 10) Musteri kotasiz acarsa varsayilani devralir (sessizce sinirsiz DEGIL).
      const custNoQuota = await srv.inject({
        method: "POST",
        url: `/api/domains/${mailIdA}/mail`,
        cookies: mailCustomerCookie,
        payload: { localPart: "destek", password: "correct-horse-battery" },
      });
      assert.equal(custNoQuota.statusCode, 201, `musteri hesap acamadi: ${custNoQuota.body}`);
      assert.equal(
        custNoQuota.json().account.quota_mb,
        256,
        "kota gonderilmeyince varsayilan devralinmali, sinirsiz kalmamali",
      );
      const custAccountId = custNoQuota.json().account.id as number;

      // 11) Kota ucu: musteri 403, admin 200 ve dosya guncellenir.
      const custQuota = await srv.inject({
        method: "PATCH",
        url: `/api/domains/${mailIdA}/mail/${custAccountId}/quota`,
        cookies: mailCustomerCookie,
        payload: { quotaMb: 5000 },
      });
      assert.equal(custQuota.statusCode, 403, "musteri kota ucunu kullanabildi");

      const adminQuota = await srv.inject({
        method: "PATCH",
        url: `/api/domains/${mailIdA}/mail/${custAccountId}/quota`,
        cookies: authCookie,
        payload: { quotaMb: 512 },
      });
      assert.equal(adminQuota.statusCode, 200, `admin kota degistiremedi: ${adminQuota.body}`);
      assert.ok(
        (await fs.readFile(mailUsersPath, "utf8")).includes("userdb_quota_storage_size=512M"),
        "kota degisimi uretilen dosyaya yansimadi",
      );

      // 12) Genel PATCH'e kota konursa 400 (sessiz strip DEGIL).
      const sneaky = await srv.inject({
        method: "PATCH",
        url: `/api/domains/${mailIdA}/mail/${custAccountId}`,
        cookies: mailCustomerCookie,
        payload: { enabled: true, quotaMb: 9999 },
      });
      assert.equal(sneaky.statusCode, 400, "genel PATCH kotayi sessizce yok saydi");

      // 13) enabled:false -> adres dosyadan DUSER (giris kesilir).
      const disabled = await srv.inject({
        method: "PATCH",
        url: `/api/domains/${mailIdA}/mail/${custAccountId}`,
        cookies: authCookie,
        payload: { enabled: false },
      });
      assert.equal(disabled.statusCode, 200);
      assert.ok(
        !(await fs.readFile(mailUsersPath, "utf8")).includes(`destek@${mailDomainA}`),
        "kapatilan hesap dosyada kaldi — giris yapmaya devam ederdi",
      );

      // 14) Silme.
      const removed = await srv.inject({
        method: "DELETE",
        url: `/api/domains/${mailIdA}/mail/${custAccountId}`,
        cookies: authCookie,
      });
      assert.equal(removed.statusCode, 200);

      // 16) Servis durumu DURUST: kurulu degilken "calisiyor" demiyor.
      const service = listed.json().service as {
        installed: boolean;
        running: boolean;
        note: string;
        ports: Array<{ port: number; open: boolean }>;
      };
      assert.equal(typeof service.note, "string");
      assert.ok(service.note.length > 0, "servis notu bos");
      if (!service.installed) {
        assert.equal(service.running, false, "kurulu degilken running=true denemez");
        assert.ok(
          service.ports.every((p) => !p.open),
          "kurulu degilken acik port raporlanamaz",
        );
      }

      // 17) Maildir OLUSTURULMADI — var olmayan servis icin sahte iskelet yok.
      assert.equal(
        fsSync.existsSync(createdMail.account.maildir),
        false,
        "mail sunucusu yokken maildir olusturulmamali",
      );

      // 15) Domain silinince adresleri dosyadan DUSER.
      // REGRESYON: admin, MUSTERIYE ATANMIS bir domaini silebilmeli.
      // Onceden DELETE sorgusu `AND user_id = <admin id>` filtreliyordu ve
      // musteri hesabi acilmis her domainde bu adim sessizce 0 satir siliyor,
      // ardindan yaniltici bir 404 donuyordu — üstelik gercek veritabanlari
      // bu noktadan once ve geri alinamaz sekilde dusurulmus oluyordu.
      const mailDomainDeleted = await srv.inject({
        method: "DELETE",
        url: `/api/domains/${mailIdA}`,
        cookies: authCookie,
        payload: { confirm: mailDomainA },
      });
      assert.equal(
        mailDomainDeleted.statusCode,
        200,
        `mail test domaini silinemedi: ${mailDomainDeleted.body}`,
      );
      mailIdA = null;
      assert.ok(
        !(await fs.readFile(mailUsersPath, "utf8")).includes(`@${mailDomainA}`),
        "domain silindi ama posta kutusu dosyada kaldi — IMAP'e giris devam ederdi",
      );

      console.log(
        "✓ e-posta hesapları self-test geçti (gerçek DB + SHA-512 crypt + 0600 dovecot-users + admin-only kota + dürüst servis durumu)",
      );
    } finally {
      for (const [id, name] of [
        [mailIdA, mailDomainA],
        [mailIdB, mailDomainB],
      ] as const) {
        if (id) {
          await server.inject({
            method: "DELETE",
            url: `/api/domains/${id}`,
            cookies: authCookie,
            payload: { confirm: name },
          });
        }
      }
      if (previousMailUsers) await fs.writeFile(mailUsersPath, previousMailUsers, { mode: 0o600 });
      else await fs.rm(mailUsersPath, { force: true });
    }

    // --- Tarayıcı sözleşmesi: gövdesiz istekler ---
    //
    // Bu blok server.inject() KULLANMAZ, gerçek bir soket üzerinden fetch atar.
    // Sebebi: inject, payload verilmediğinde Content-Type başlığını hiç
    // göndermiyor; tarayıcıdaki apps/web/src/lib/api.ts ise her isteğe
    // "application/json" koyuyordu. Bu fark yüzünden gövdesiz YEDİ uç canlıda
    // 400 (FST_ERR_CTP_EMPTY_JSON_BODY) dönerken testler yeşil kalıyordu —
    // kullanıcı klasör silemedi. Test artık tarayıcının istek şeklini birebir
    // taklit ediyor.
    await withHttpServer(async (origin) => {
      const browserHeaders = { "Content-Type": "application/json" };
      // `server` bu noktada kesinlikle kurulu, ama kapanış (closure) içinde
      // TypeScript'in daraltması geçerli değil. Yerel bir takma ad daralmayı
      // koruyor — `!` ile bastırmaktansa böylesi dürüst.
      const app = server;
      assert.ok(app, "sözleşme testi: sunucu kurulmamış");

      // Login yalnızca PANEL_OWNER_EMAIL hesabını kabul ediyor ve testin o
      // parolayı bilmesi gerekmiyor; register ucu da oturum çerezi veriyor.
      const stamp = Date.now();
      const contractEmail = `contract+${stamp}@example.invalid`;
      const registered = await fetch(`${origin}/api/auth/register`, {
        method: "POST",
        headers: browserHeaders,
        body: JSON.stringify({
          username: `contract_${stamp}`,
          email: contractEmail,
          password: "correct-horse-battery",
        }),
      });
      assert.equal(registered.status, 201, `sözleşme testi kayıt başarısız: ${registered.status}`);
      const sessionCookie = (registered.headers.get("set-cookie") ?? "").split(";")[0];
      assert.ok(sessionCookie.startsWith("studio_session="), "sözleşme testi: oturum çerezi alınamadı");

      const contractDomain = `contract-${Date.now()}.test.invalid`;
      const created = await fetch(`${origin}/api/domains`, {
        method: "POST",
        headers: { ...browserHeaders, cookie: sessionCookie },
        body: JSON.stringify({ domain_name: contractDomain }),
      });
      assert.equal(created.status, 201, `sözleşme testi domain oluşturulamadı: ${created.status}`);
      const contractId = (await created.json()).domain.id;

      try {
        // Kullanıcının bildirdiği senaryonun birebir kendisi:
        // klasör oluştur -> listede gör -> SİL -> listeden kalktığını doğrula.
        const mk = await fetch(`${origin}/api/domains/${contractId}/files`, {
          method: "POST",
          headers: { ...browserHeaders, cookie: sessionCookie },
          body: JSON.stringify({ path: "public/test", isDirectory: true }),
        });
        assert.equal(mk.status, 201, `klasör oluşturulamadı: ${mk.status}`);

        const listed = await fetch(`${origin}/api/domains/${contractId}/files?path=public`, {
          headers: { ...browserHeaders, cookie: sessionCookie },
        });
        assert.ok(
          (await listed.json()).entries.some((e: { name: string }) => e.name === "test"),
          "oluşturulan klasör listede yok",
        );

        const removed = await fetch(
          `${origin}/api/domains/${contractId}/files?path=${encodeURIComponent("public/test")}`,
          { method: "DELETE", headers: { ...browserHeaders, cookie: sessionCookie } },
        );
        assert.equal(
          removed.status,
          200,
          `KLASÖR SİLİNEMEDİ (${removed.status}): ${await removed.text()}`,
        );

        const afterDelete = await fetch(`${origin}/api/domains/${contractId}/files?path=public`, {
          headers: { ...browserHeaders, cookie: sessionCookie },
        });
        assert.ok(
          !(await afterDelete.json()).entries.some((e: { name: string }) => e.name === "test"),
          "silinen klasör hâlâ listede",
        );

        // Gövdesiz gönderilen diğer uçlar. Hiçbiri 400 dönmemeli; iş
        // kuralı gereği 404/502 dönebilirler, denetlenen tek şey isteğin
        // gövde/başlık yüzünden reddedilmemesi.
        const bodylessEndpoints: Array<{ label: string; path: string; method: string }> = [
          { label: "yedek al", path: `/api/domains/${contractId}/backups`, method: "POST" },
          { label: "nginx config üret", path: `/api/domains/${contractId}/nginx-config`, method: "POST" },
          { label: "sertifika iste", path: `/api/domains/${contractId}/ssl/request`, method: "POST" },
          { label: "cloudflare'den çek", path: `/api/domains/${contractId}/dns/pull`, method: "POST" },
        ];

        for (const endpoint of bodylessEndpoints) {
          const res = await fetch(`${origin}${endpoint.path}`, {
            method: endpoint.method,
            headers: { ...browserHeaders, cookie: sessionCookie },
          });
          assert.notEqual(
            res.status,
            400,
            `"${endpoint.label}" gövdesiz istekte 400 döndü — tarayıcı bu ucu kullanamaz: ${await res.text()}`,
          );
        }
      } finally {
        const cleanup = await fetch(`${origin}/api/domains/${contractId}`, {
          method: "DELETE",
          headers: { ...browserHeaders, cookie: sessionCookie },
          body: JSON.stringify({ confirm: contractDomain }),
        });
        assert.equal(cleanup.status, 200, `sözleşme testi domain temizliği başarısız: ${cleanup.status}`);

        // Logout da gövdesiz POST sözleşmesine dahildir; fakat domain temizliği
        // oturum kapatılmadan önce yapılır, aksi halde 401 ile artık bırakır.
        const logout = await fetch(`${origin}/api/auth/logout`, {
          method: "POST",
          headers: { ...browserHeaders, cookie: sessionCookie },
        });
        assert.notEqual(logout.status, 400, "çıkış gövdesiz istekte 400 dönmemeli");
        await app.pg.query("DELETE FROM users WHERE email = $1", [contractEmail]);

        // Testin ürettiği nginx config'i de topluyoruz. Domain silme ucu
        // ops/generated'a DOKUNMUYOR (bilinçli: canlı config'i test silmesin),
        // bu yüzden temizlik testin kendi sorumluluğu. Yapılmadığı için
        // ops/generated altında contract-*.test.invalid.conf artıkları
        // birikmişti.
        await fs.rm(path.join(GENERATED_DIR, `${contractDomain}.conf`), { force: true });
      }
    });
    console.log("✓ tarayıcı sözleşmesi self-test geçti (gövdesiz istekler + klasör oluştur/sil akışı)");

    // --- Yükleme / indirme / arşiv açma (zip-slip dahil) ---
    {
      const upDomain = `upload-${Date.now()}.test.invalid`;
      const createdUp = await server.inject({
        method: "POST",
        url: "/api/domains",
        cookies: authCookie,
        payload: { domain_name: upDomain },
      });
      assert.equal(createdUp.statusCode, 201);
      const upId = createdUp.json().domain.id;
      const upRoot = path.join(env.VHOSTS_ROOT, upDomain);

      try {
        // Yükleme — gerçek multipart gövdesi.
        const boundary = "----selftestboundary";
        const fileBody = "merhaba dunya\n";
        const multipartBody = Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="path"\r\n\r\npublic\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="not.txt"\r\n` +
            `Content-Type: text/plain\r\n\r\n${fileBody}\r\n` +
            `--${boundary}--\r\n`,
          "utf8",
        );
        const uploaded = await server.inject({
          method: "POST",
          url: `/api/domains/${upId}/files/upload`,
          cookies: authCookie,
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          payload: multipartBody,
        });
        assert.equal(uploaded.statusCode, 201, `yükleme başarısız: ${uploaded.body}`);
        assert.equal(uploaded.json().files[0].name, "not.txt");
        assert.equal(
          await fs.readFile(path.join(upRoot, "public", "not.txt"), "utf8"),
          fileBody,
          "yüklenen dosyanın içeriği diskte eşleşmiyor",
        );

        // İndirme — içerik birebir dönmeli.
        const downloaded = await server.inject({
          method: "GET",
          url: `/api/domains/${upId}/files/download?path=${encodeURIComponent("public/not.txt")}`,
          cookies: authCookie,
        });
        assert.equal(downloaded.statusCode, 200);
        assert.equal(downloaded.body, fileBody, "indirilen içerik yüklenenle aynı değil");
        assert.ok(
          downloaded.headers["content-disposition"]?.toString().includes("attachment"),
          "indirme attachment olarak sunulmalı",
        );

        // İndirmede path traversal.
        const badDownload = await server.inject({
          method: "GET",
          url: `/api/domains/${upId}/files/download?path=${encodeURIComponent("../../../../etc/passwd")}`,
          cookies: authCookie,
        });
        assert.equal(badDownload.statusCode, 403, "indirme traversal'ı 403 dönmeli");

        // Yüklemede hedef klasör traversal'ı.
        const badUploadBody = Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="path"\r\n\r\n../../../../etc\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="x.txt"\r\n\r\nzararli\r\n` +
            `--${boundary}--\r\n`,
          "utf8",
        );
        const badUpload = await server.inject({
          method: "POST",
          url: `/api/domains/${upId}/files/upload`,
          cookies: authCookie,
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          payload: badUploadBody,
        });
        assert.equal(badUpload.statusCode, 403, "yükleme traversal'ı 403 dönmeli");

        // --- Klasör yüklemesi: ağaç KORUNMALI ---
        //
        // Eski davranış: sunucu her dosya adına path.basename uyguluyordu, bu
        // yüzden "site/assets/app.js" düz "app.js" olarak tek klasöre
        // düşüyordu — kullanıcı klasörü olduğu gibi yükleyemiyordu. Artık
        // dosyadan hemen önce gelen "relpath" alanı ağacı taşıyor.
        const treeBody = Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="path"\r\n\r\npublic\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="count"\r\n\r\n3\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="relpath"\r\n\r\nsite/index.html\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="index.html"\r\n\r\n<h1>kok</h1>\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="relpath"\r\n\r\nsite/assets/app.js\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="app.js"\r\n\r\nconsole.log(1)\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="relpath"\r\n\r\nsite/.htaccess\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename=".htaccess"\r\n\r\nDeny from all\r\n` +
            `--${boundary}--\r\n`,
          "utf8",
        );
        const tree = await server.inject({
          method: "POST",
          url: `/api/domains/${upId}/files/upload`,
          cookies: authCookie,
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          payload: treeBody,
        });
        assert.equal(tree.statusCode, 201, `klasör yüklemesi başarısız: ${tree.body}`);
        assert.deepEqual(
          tree.json().files.map((f: { name: string }) => f.name).sort(),
          ["site/.htaccess", "site/assets/app.js", "site/index.html"],
          "göreli yollar korunmadı",
        );
        assert.equal(
          await fs.readFile(path.join(upRoot, "public", "site", "assets", "app.js"), "utf8"),
          "console.log(1)",
          "alt klasör diskte oluşmadı — klasör ağacı düzleştirilmiş",
        );
        assert.ok(
          fsSync.existsSync(path.join(upRoot, "public", "site", ".htaccess")),
          "nokta ile başlayan dosya adı bozulmuş (.htaccess kaybı)",
        );

        // relpath üzerinden traversal — sessizce düzeltilmez, reddedilir.
        const evilRelBody = Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="path"\r\n\r\npublic\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="relpath"\r\n\r\n../../../../kacti-upload.txt\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="x.txt"\r\n\r\nzararli\r\n` +
            `--${boundary}--\r\n`,
          "utf8",
        );
        const evilRel = await server.inject({
          method: "POST",
          url: `/api/domains/${upId}/files/upload`,
          cookies: authCookie,
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          payload: evilRelBody,
        });
        assert.equal(evilRel.statusCode, 403, "relpath traversal'ı 403 dönmeli");
        assert.ok(
          !fsSync.existsSync(path.join(env.VHOSTS_ROOT, "kacti-upload.txt")),
          "relpath traversal'ı domain kökünün dışına dosya yazmış",
        );

        // --- Toplu silme: gerçekten diskten gitmeli ---
        const bulkNames = ["urun-1.txt", "urun-2.txt", "urun-3.txt"];
        for (const name of bulkNames) {
          await fs.writeFile(path.join(upRoot, "public", name), name, "utf8");
        }
        const bulk = await server.inject({
          method: "POST",
          url: `/api/domains/${upId}/files/bulk-delete`,
          cookies: authCookie,
          payload: { paths: bulkNames.map((name) => `public/${name}`) },
        });
        assert.equal(bulk.statusCode, 200, `toplu silme başarısız: ${bulk.body}`);
        assert.equal(bulk.json().deleted.length, 3);
        assert.equal(bulk.json().failed.length, 0);
        for (const name of bulkNames) {
          assert.ok(
            !fsSync.existsSync(path.join(upRoot, "public", name)),
            `${name} toplu silmeden sonra diskte duruyor`,
          );
        }

        // Toplu silmede traversal — hiçbiri silinmediği için 400.
        const bulkEvil = await server.inject({
          method: "POST",
          url: `/api/domains/${upId}/files/bulk-delete`,
          cookies: authCookie,
          payload: { paths: ["../../../../etc/passwd"] },
        });
        assert.equal(bulkEvil.statusCode, 400, "toplu silmede traversal reddedilmeli");
        assert.equal(bulkEvil.json().failed.length, 1);
        assert.ok(fsSync.existsSync("/etc/passwd"), "toplu silme kök dışına ulaşmış");

        // Klasör silme: içi dolu klasör tek istekte kalıcı gitmeli.
        await fs.mkdir(path.join(upRoot, "public", "silinecek", "ic"), { recursive: true });
        await fs.writeFile(path.join(upRoot, "public", "silinecek", "ic", "a.txt"), "x", "utf8");
        const rmDir = await server.inject({
          method: "DELETE",
          url: `/api/domains/${upId}/files?path=${encodeURIComponent("public/silinecek")}`,
          cookies: authCookie,
        });
        assert.equal(rmDir.statusCode, 200, `klasör silinemedi: ${rmDir.body}`);
        assert.ok(
          !fsSync.existsSync(path.join(upRoot, "public", "silinecek")),
          "klasör silindi denildi ama diskte duruyor",
        );

        // Olmayan yolu silmek 404 olmalı (500 değil) — hata sebebi doğru raporlanmalı.
        const rmMissing = await server.inject({
          method: "DELETE",
          url: `/api/domains/${upId}/files?path=${encodeURIComponent("public/yok-boyle-bir-sey")}`,
          cookies: authCookie,
        });
        assert.equal(rmMissing.statusCode, 404, "olmayan dosya için 404 beklenir");

        // --- YAZILAMAYAN HEDEF: ciplak 500 DEGIL, anlasilir hata ---
        //
        // Gercekten yasandi (2026-08-29): bir domain dizini root olarak
        // olusturulmustu, panel devuser ile calisiyordu; her yukleme ham
        // EACCES'i Fastify'a kadar tasiyip "Internal Server Error" (500)
        // donuyordu. Ne kullanici ne log sebebi soyluyordu. Artik izin
        // hatasi 403 + ne yapilacagini soyleyen bir mesaj olmali.
        {
          const lockedDir = path.join(upRoot, "public", "kilitli");
          await fs.mkdir(lockedDir, { recursive: true });
          await fs.chmod(lockedDir, 0o555); // yazma yok
          try {
            const lockedBody = Buffer.from(
              `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="path"\r\n\r\npublic/kilitli\r\n` +
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nveri\r\n` +
                `--${boundary}--\r\n`,
              "utf8",
            );
            const locked = await server.inject({
              method: "POST",
              url: `/api/domains/${upId}/files/upload`,
              cookies: authCookie,
              headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
              payload: lockedBody,
            });
            // root olarak calisan bir test ortaminda izinler uygulanmaz;
            // o durumda yukleme basarili olur ve test edecek bir sey yoktur.
            if (locked.statusCode !== 201) {
              assert.equal(
                locked.statusCode,
                403,
                `yazma izni yokken 403 beklenir, alinan: ${locked.statusCode} ${locked.body}`,
              );
              const message = String(locked.json().error ?? "");
              assert.ok(
                message.includes("izin yok"),
                `hata mesaji sebebi soylemeli, alinan: ${message}`,
              );
              assert.ok(
                !message.includes("Internal Server Error"),
                "izin hatasi ciplak 500 olarak donuyor",
              );
            }
          } finally {
            await fs.chmod(lockedDir, 0o755);
            await fs.rm(lockedDir, { recursive: true, force: true });
          }
        }

        // --- ZIP-SLIP ---
        //
        // Arşivler ELLE üretiliyor. Sebebi: bu konteynerdeki busybox tar/unzip,
        // arşiv OLUŞTURURKEN de LİSTELERKEN de "../" önekini siliyor. Araçla
        // üretilmiş bir "kötü arşiv" aslında zararsız çıkar ve test hiçbir şey
        // kanıtlamaz. Baytları kendimiz yazıp gerçek saldırıyı kuruyoruz.
        const slipDir = path.join(upRoot, "public");
        await fs.writeFile(path.join(slipDir, "slip.tar.gz"), makeMaliciousTarGz("../../../../kacti.txt"));
        await fs.writeFile(path.join(slipDir, "slip.zip"), makeMaliciousZip("../../../../kacti.txt"));

        for (const archive of ["slip.tar.gz", "slip.zip"]) {
          const slip: Awaited<ReturnType<typeof server.inject>> = await server.inject({
            method: "POST",
            url: `/api/domains/${upId}/files/extract`,
            cookies: authCookie,
            payload: { path: `public/${archive}` },
          });
          assert.equal(
            slip.statusCode,
            403,
            `${archive} kök dışına yazmaya çalışıyor, reddedilmeliydi: ${slip.statusCode} ${slip.body}`,
          );
        }
        assert.ok(
          !fsSync.existsSync(path.join(env.VHOSTS_ROOT, "kacti.txt")),
          "zip-slip arşivi kısmen açılmış — domain kökünün dışına dosya yazılmış",
        );

        // Temiz bir arşiv gerçekten açılmalı.
        await fs.mkdir(path.join(slipDir, "arsiv"), { recursive: true });
        await fs.writeFile(path.join(slipDir, "arsiv", "icerik.txt"), "acildi\n", "utf8");
        await execFileAsync("tar", [
          "-czf",
          path.join(slipDir, "temiz.tar.gz"),
          "-C",
          path.join(slipDir, "arsiv"),
          "icerik.txt",
        ]);
        await fs.rm(path.join(slipDir, "arsiv"), { recursive: true, force: true });

        const extracted = await server.inject({
          method: "POST",
          url: `/api/domains/${upId}/files/extract`,
          cookies: authCookie,
          payload: { path: "public/temiz.tar.gz" },
        });
        assert.equal(extracted.statusCode, 200, `arşiv açılamadı: ${extracted.body}`);
        assert.equal(
          await fs.readFile(path.join(slipDir, "icerik.txt"), "utf8"),
          "acildi\n",
          "arşivden çıkan dosya diskte yok",
        );

        // Yüklenen ZIP de aynı gerçek API yolundan çıkarılabilmeli.
        await fs.writeFile(path.join(slipDir, "temiz.zip"), makeMaliciousZip("zip-icerik.txt"));
        const extractedZip = await server.inject({
          method: "POST",
          url: `/api/domains/${upId}/files/extract`,
          cookies: authCookie,
          payload: { path: "public/temiz.zip" },
        });
        assert.equal(extractedZip.statusCode, 200, `ZIP açılamadı: ${extractedZip.body}`);
        assert.equal(
          await fs.readFile(path.join(slipDir, "zip-icerik.txt"), "utf8"),
          "KACTI\n",
          "ZIP içeriği hedef klasöre çıkmadı",
        );
      } finally {
        await server.inject({
          method: "DELETE",
          url: `/api/domains/${upId}`,
          cookies: authCookie,
          payload: { confirm: upDomain },
        });
      }
      console.log(
        "✓ yükleme/indirme/arşiv/silme self-test geçti (klasör ağacı korundu, toplu silme kalıcı, traversal ve zip-slip reddedildi)",
      );
    }

    // --- Cloudflare bozukken yerel DNS okunabiliyor mu ---
    //
    // Canlıda token'ın DNS okuma izni yoktu; Cloudflare 403 dönüyordu ve panel
    // "DNS kayıtları alınamadı (502)" diyerek KENDİ veritabanındaki kayıtları da
    // gizliyordu. İki davranış korunuyor: (1) cloudflare-status bunu 200 ile bir
    // DURUM olarak bildirir, (2) yerel /dns ucu bundan hiç etkilenmez.
    {
      const cfDomain = `cfdown-${Date.now()}.test.invalid`;
      const createdCf = await server.inject({
        method: "POST",
        url: "/api/domains",
        cookies: authCookie,
        payload: { domain_name: cfDomain },
      });
      assert.equal(createdCf.statusCode, 201);
      const cfDomainId = createdCf.json().domain.id;

      // Her isteğe Cloudflare'in gerçek izin hatasını döndüren sahte sunucu.
      const denyServer = http.createServer((_req, res) => {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            result: null,
            errors: [{ code: 10000, message: "Authentication error" }],
          }),
        );
      });
      await new Promise<void>((resolve) => denyServer.listen(0, "127.0.0.1", resolve));
      const denyPort = (denyServer.address() as { port: number }).port;

      const realBase = env.CLOUDFLARE_API_BASE;
      const realToken = env.CLOUDFLARE_API_TOKEN;
      env.CLOUDFLARE_API_BASE = `http://127.0.0.1:${denyPort}`;
      env.CLOUDFLARE_API_TOKEN = "test-token-degil-gercek";
      resetCloudflareClient();

      try {
        await server.inject({
          method: "POST",
          url: `/api/domains/${cfDomainId}/dns`,
          cookies: authCookie,
          payload: { record_type: "A", name: "cfdown", content: "203.0.113.77", ttl: 3600 },
        });

        const status = await server.inject({
          method: "GET",
          url: `/api/domains/${cfDomainId}/dns/cloudflare-status`,
          cookies: authCookie,
        });
        assert.equal(
          status.statusCode,
          200,
          `Cloudflare izin hatası 200 ile bildirilmeli, alınan: ${status.statusCode}`,
        );
        assert.equal(status.json().status, "error");
        assert.equal(
          status.json().reason,
          "permission",
          "izin hatası 'permission' olarak sınıflandırılmalı",
        );

        const localRecords = await server.inject({
          method: "GET",
          url: `/api/domains/${cfDomainId}/dns`,
          cookies: authCookie,
        });
        assert.equal(
          localRecords.statusCode,
          200,
          "Cloudflare bozukken yerel DNS kayıtları yine okunabilmeli",
        );
        assert.ok(
          Array.isArray(localRecords.json().records),
          "yerel DNS kayıtları dizi olarak dönmeli",
        );
      } finally {
        env.CLOUDFLARE_API_BASE = realBase;
        env.CLOUDFLARE_API_TOKEN = realToken;
        resetCloudflareClient();
        await new Promise<void>((resolve) => denyServer.close(() => resolve()));
        await server.inject({
          method: "DELETE",
          url: `/api/domains/${cfDomainId}`,
          cookies: authCookie,
          payload: { confirm: cfDomain },
        });
      }
      console.log("✓ Cloudflare bozukken yerel DNS okunabiliyor (izin hatası 200 ile bildiriliyor)");
    }

    // --- Modül 2c: Otomatik DNS öneri kayıtları — SAF fonksiyonlar (I/O yok) ---
    {
      const dkimStub = "v=DKIM1; k=rsa; p=" + "A".repeat(50);

      const withoutIp = buildDefaultDnsRecords("pure-test.invalid", { serverIp: null, dkimTxtValue: dkimStub });
      assert.equal(withoutIp.records.length, 9, "serverIp yokken 9 kayıt (A'lar hariç) üretilmeli");
      assert.ok(withoutIp.warnings.length > 0, "serverIp yokken uyarı dönmeli");
      assert.ok(!withoutIp.records.some((r) => r.record_type === "A"), "serverIp yokken A kaydı olmamalı");

      const withIp = buildDefaultDnsRecords("pure-test.invalid", {
        serverIp: "203.0.113.50",
        dkimTxtValue: dkimStub,
      });
      assert.equal(withIp.records.length, 13, "serverIp varken 13 kayıt üretilmeli (webmail A dahil)");
      assert.equal(withIp.warnings.length, 0);
      const aRecords = withIp.records.filter((r) => r.record_type === "A");
      assert.equal(aRecords.length, 4, "@ / www / mail / webmail için 4 A kaydı olmalı");
      assert.ok(aRecords.every((r) => r.content === "203.0.113.50"));
      assert.ok(
        aRecords.every((r) => r.proxied === false),
        "hiçbir öneri A kaydı proxied:true ÜRETİLMEMELİ (mail trafiği Cloudflare proxy'sinden geçemez)",
      );
      assert.ok(
        aRecords.some((r) => r.name === "webmail.pure-test.invalid"),
        "webmail A kaydı olmalı",
      );

      const mx = withIp.records.find((r) => r.record_type === "MX")!;
      assert.equal(mx.priority, 10);
      assert.equal(mx.content, "mail.pure-test.invalid");

      const spf = withIp.records.find((r) => r.record_type === "TXT" && r.name === "pure-test.invalid")!;
      assert.equal(spf.content, "v=spf1 a mx ip4:203.0.113.50 ~all", "SERVER_PUBLIC_IP varken SPF ip4: içermeli");
      const spfNoIp = withoutIp.records.find((r) => r.record_type === "TXT" && r.name === "pure-test.invalid")!;
      assert.equal(spfNoIp.content, "v=spf1 a mx ~all", "SERVER_PUBLIC_IP yokken SPF ip4: İÇERMEMELİ");

      const dmarc = withIp.records.find((r) => r.name === "_dmarc.pure-test.invalid")!;
      assert.equal(dmarc.content, "v=DMARC1; p=none; sp=none; aspf=r;");

      const srv = withIp.records.find((r) => r.name === "_imaps._tcp.pure-test.invalid")!;
      assert.equal(srv.port, 993);
      assert.equal(srv.weight, 1);
      assert.equal(srv.priority, 0);
      assert.equal(srv.content, "mail.pure-test.invalid");

      // Cloudflare payload şekli: MX üst düzey priority, SRV'de content YOK data VAR.
      const mxPayload = toCloudflarePayload({
        record_type: "MX",
        name: "pure-test.invalid",
        content: "mail.pure-test.invalid",
        ttl: 3600,
        priority: 10,
      });
      assert.equal(mxPayload.priority, 10);
      assert.equal(mxPayload.content, "mail.pure-test.invalid");

      const srvPayload = toCloudflarePayload({
        record_type: "SRV",
        name: "_imaps._tcp.pure-test.invalid",
        content: "mail.pure-test.invalid",
        ttl: 3600,
        priority: 0,
        weight: 1,
        port: 993,
      });
      assert.equal(srvPayload.content, undefined, "SRV payload'ında content OLMAMALI");
      assert.deepEqual(srvPayload.data, {
        service: "_imaps",
        proto: "_tcp",
        name: "pure-test.invalid",
        priority: 0,
        weight: 1,
        port: 993,
        target: "mail.pure-test.invalid",
      });

      // BIND zone render: MX priority + SRV satırı + çok parçalı TXT (DKIM).
      const longDkim = "v=DKIM1; k=rsa; p=" + "B".repeat(400);
      const { content: zoneContent, warnings: zoneWarnings } = renderZoneFile("pure-test.invalid", [
        { record_type: "MX", name: "pure-test.invalid", content: "mail.pure-test.invalid", ttl: 3600, priority: 10 },
        {
          record_type: "SRV",
          name: "_imaps._tcp.pure-test.invalid",
          content: "mail.pure-test.invalid",
          ttl: 3600,
          priority: 0,
          weight: 1,
          port: 993,
        },
        { record_type: "TXT", name: "default._domainkey.pure-test.invalid", content: longDkim, ttl: 3600 },
      ]);
      assert.ok(zoneContent.includes("IN\tMX\t10 mail.pure-test.invalid."), "MX satırında priority + fqdn olmalı");
      assert.ok(
        zoneContent.includes("IN\tSRV\t0 1 993 mail.pure-test.invalid."),
        "SRV satırı BIND formatında (priority weight port target.) olmalı",
      );
      assert.ok(
        zoneContent.split('" "').length > 1,
        "400+ karakterlik DKIM TXT değeri birden fazla quoted-string'e bölünmeli",
      );
      assert.ok(Array.isArray(zoneWarnings));

      console.log("✓ Modül 2c (otomatik DNS öneri kayıtları — saf fonksiyonlar) self-test geçti");
    }

    // --- Webmail: saf mantik (HTML temizligi + oturum sirri sifrelemesi) ---
    await runWebmailSelfTest();

    // --- Yedekleme: rotasyon kurallari ---
    await runBackupSelfTest();

    console.log("✓ apps/api self-test geçti (gerçek DB + gerçek HTTP + gerçek cgroup/HetrixTools)");
  } finally {
    // Test kullanicilarini topla.
    //
    // Her kosu `selftest+<ts>@example.invalid` ve `contract+<ts>@...` hesaplari
    // aciyordu ama yalnizca bir kismi siliniyordu; canli veritabaninda 47
    // artik hesap birikmisti. Silme CASCADE ile domain/oturum/FTP/veritabani
    // satirlarini da goturur.
    //
    // Desen `@example.invalid` ile bitiyor: RFC 2606'ya gore bu TLD asla
    // gercek olamaz, dolayisiyla gercek bir kullaniciyi silme riski yok.
    if (server) {
      try {
        const { rowCount } = await server.pg.query(
          "DELETE FROM users WHERE email LIKE '%@example.invalid'",
        );
        if (rowCount) console.log(`  (temizlik: ${rowCount} test hesabi silindi)`);
      } catch (err) {
        console.error("  (temizlik yapilamadi:", err, ")");
      }
      await server.close();
    }
    await pg.stop();
  }
}

main().catch((err) => {
  console.error("✗ apps/api self-test BAŞARISIZ:", err);
  process.exit(1);
});
