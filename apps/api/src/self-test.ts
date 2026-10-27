Warning: truncated output (original token count: 44082)
Total output lines: 3802

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
    assert.ok(metricsBody.disk.totalBytes >= metricsBody.disk.usedBytes, "disk kullanımı toplam kapasiteyi aşamaz");
    assert.ok(metricsBody.disk.availableBytes <= metricsBody.disk.totalBytes, "boş alan toplam kapasiteyi aşamaz");
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
      assert.equal(typeof backupBody.complete, "boolean…22082 tokens truncated…finally {
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
