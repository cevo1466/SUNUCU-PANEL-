/**
 * apps/web — saf mantık self-test'i.
 *
 * NEDEN VAR: bu paketin doğrulaması uzun süre yalnızca `build + lint` idi.
 * İkisi de TİPLERİ denetler, MANTIĞI denetlemez. Yükleme ilerlemesi bunun
 * bedelini ödedi: `overallUploadedBytes`'ın yaptığı iş tip olarak kusursuz
 * (number girer, number çıkar) ama HESABI yanlıştı ve çubuk gerçek transferin
 * %8'inde %100 gösteriyordu. Derleme de lint de bunu göremezdi.
 *
 * Kapsam bilinçli olarak dar: DOM ve React gerektirmeyen, sessizce yanlış
 * cevap verebilen saf fonksiyonlar. Bileşen testi için ayrı bir koşucu
 * (jsdom/vitest) gerekir; o bağımlılık bu konteynerde bilerek eklenmedi.
 *
 * Çalıştırma: npm test --workspace=apps/web
 */

import assert from "node:assert/strict";
import { overallUploadedBytes } from "./upload.js";
import { formatBytes, formatBytesPerSecond, formatDuration } from "./format.js";
import { readFileSync } from "node:fs";
import { passwordProblem } from "@studio-panel/shared";

let failures = 0;
function test(name: string, run: () => void): void {
  try {
    run();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
  }
}

console.log("— yükleme ilerlemesi (overallUploadedBytes)");

test("tek dosya, yarısı gitmiş → yarısı raporlanır", () => {
  const loaded = overallUploadedBytes({
    completedFileBytes: 0,
    batchFileBytes: 1000,
    batchLoaded: 600,
    batchTotal: 1200, // gövde, dosyadan büyük (multipart zarfı)
    totalFileBytes: 1000,
  });
  assert.equal(loaded, 500);
});

test("multipart ek yükü yüzdeyi ŞİŞİRMEZ (gerçek ölçüm: 300 küçük dosya)", () => {
  // Ölçülen değerler: dosyaların toplamı 7090 bayt, gerçek gövde 83930 bayt.
  // Eski mantık `loaded`'ı doğrudan dosya baytıyla karşılaştırdığı için
  // gövdenin %10'unda çubuk çoktan %100'e ulaşmıştı.
  const totalFileBytes = 7090;
  const batchTotal = 83930;
  const loadedAtTenPercent = overallUploadedBytes({
    completedFileBytes: 0,
    batchFileBytes: totalFileBytes,
    batchLoaded: Math.round(batchTotal * 0.1),
    batchTotal,
    totalFileBytes,
  });
  const percent = (loadedAtTenPercent / totalFileBytes) * 100;
  assert.ok(
    percent > 8 && percent < 12,
    `gövdenin %10'unda çubuk ~%10 olmalı, %${percent.toFixed(1)} çıktı`,
  );
});

test("paket sınırında birim karışmaz (biten paket + süren paket)", () => {
  // 3 paket, her biri 1000 dosya baytı. İlk ikisi bitmiş, üçüncü yarıda.
  const loaded = overallUploadedBytes({
    completedFileBytes: 2000,
    batchFileBytes: 1000,
    batchLoaded: 5000,
    batchTotal: 10000,
    totalFileBytes: 3000,
  });
  assert.equal(loaded, 2500);
});

test("toplamı ASLA aşmaz (zarf payı büyük olsa bile)", () => {
  const loaded = overallUploadedBytes({
    completedFileBytes: 0,
    batchFileBytes: 100,
    batchLoaded: 99999,
    batchTotal: 1000,
    totalFileBytes: 100,
  });
  assert.equal(loaded, 100);
});

test("batchTotal bilinmiyorsa uydurma ilerleme gösterilmez", () => {
  // lengthComputable=false durumunda tarayıcı toplamı bildirmez.
  const loaded = overallUploadedBytes({
    completedFileBytes: 700,
    batchFileBytes: 300,
    batchLoaded: 0,
    batchTotal: 0,
    totalFileBytes: 1000,
  });
  assert.equal(loaded, 700, "biten iş korunmalı, süren pakete 0 pay verilmeli");
});

console.log("— biçimlendirme");

test("formatDuration saniyeyi okunur birime çevirir", () => {
  assert.equal(formatDuration(45), "45 sn");
  assert.equal(formatDuration(150), "2 dk 30 sn");
  assert.equal(formatDuration(120), "2 dk");
  assert.equal(formatDuration(3600), "1 sa");
  assert.equal(formatDuration(5400), "1 sa 30 dk");
});

test("belirsiz süre/hız uydurulmaz", () => {
  assert.equal(formatDuration(Number.NaN), "—");
  assert.equal(formatDuration(-1), "—");
  assert.equal(formatBytesPerSecond(0), "—");
  assert.equal(formatBytesPerSecond(Number.NaN), "—");
});

test("formatBytes birim atlar", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1,0 KB");
  assert.equal(formatBytes(314572800), "300,0 MB");
});

// --- Diyalog odagi: efekt YALNIZCA `open`'a bagli olmali ---
//
// GERCEK ARIZA (2026-09-02, kullanici bildirdi): "e-posta hesabi olustururken
// istedigim sifreyi belirleyemiyorum, beni surekli sekme degistirtiyor".
// Modal'in efekt bagimliligi `[open, handleKeyDown]`di; `handleKeyDown`
// useCallback ve bagimliligi `onClose`, cagiran taraf ise her yerde satir ici
// ok fonksiyonu veriyor. Satir ici fonksiyon her render'da yeni kimliktir, yani
// efekt her render'da yeniden calisiyordu — diyalogdaki bir alana her harf
// yazildiginda odak once diyalog disina, sonra ILK alana ziplıyordu. Parola
// yazmak imkansizdi ve panelin BUTUN diyaloglarini etkiliyordu.
//
// Burada DOM yok; kaynak metni denetleniyor (kabuk script'lerinde de ayni
// yaklasim kullaniliyor). Zayif bir test degil: hatanin kendisi tam olarak
// bir bagimlilik listesiydi.
test("Modal odak efekti yalnizca `open` degistiginde calisir", () => {
  const source = readFileSync(
    new URL("../components/ui/Modal.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    /\}, \[open\]\);/.test(source),
    "Modal'in odak efekti `[open]` bagimliligiyla bitmeli",
  );
  assert.ok(
    !/\}, \[open, handleKeyDown\]\);/.test(source),
    "efekt handleKeyDown'a baglanirsa her render'da odak calinir",
  );
  assert.ok(
    source.includes("keyHandlerRef"),
    "klavye isleyicisi ref uzerinden okunmali ki efekt yeniden calismasin",
  );
});

// --- Parola politikasi: kullanilabilir AMA zayif degil ---
//
// Kullanici (2026-09-02): "bu kadar kati olma, mesela Melih135. yapacak kadar
// efektif olsun". 12 karakter dayatmasi makul parolalari reddediyor ve
// pratikte insanlari parolayi bos birakip uretilen rastgele diziyi bir yere
// yapistirmaya itiyordu. Kural artik UZUNLUK YA DA CESITLILIK istiyor.
test("parola kurali makul parolayi kabul, zayifi reddeder", () => {
  // Kullanicinin ornegi ve yakin varyantlari gecmeli.
  for (const kabul of ["Melih135.", "Melih135", "Parolam2026", "kirmizi at mavi deniz"]) {
    assert.equal(passwordProblem(kabul), null, `${kabul} kabul edilmeliydi`);
  }
  // Cesitlilik yoksa ve kisaysa gecmemeli.
  for (const red of ["melih135", "12345678", "MELIH135"]) {
    assert.ok(passwordProblem(red), `${red} reddedilmeliydi`);
  }
  // 8 karakterin altinda hicbir sey gecmez: bu kutular internete acik.
  assert.ok(passwordProblem("Ab1."));
  assert.ok(passwordProblem("Melih1"));
  // Sebep ayirt edilmeli — kullanici neyi duzeltecegini bilmeli.
  assert.match(passwordProblem("Melih1") ?? "", /en az 8 karakter/);
  assert.match(passwordProblem("melih135") ?? "", /en az 3/);
});

if (failures > 0) {
  console.error(`\n✗ apps/web self-test: ${failures} test kaldı.`);
  process.exit(1);
}
console.log("\n✓ apps/web self-test geçti (saf mantık: ilerleme hesabı + biçimlendirme)");
