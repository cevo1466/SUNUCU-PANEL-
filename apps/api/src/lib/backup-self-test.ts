import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { BACKUP_ROOT, backupNameForNow, localTarget, rotateBackups } from "./backup-storage.js";

/**
 * Yedekleme saf mantik testleri.
 *
 * KAPSAM: gercek anlik goruntu alma, dogrulama ve geri yukleme canli
 * dosya sistemine, PostgreSQL'e ve MariaDB'ye ihtiyac duyuyor ve dakikalar
 * suruyor; onlar elle uctan uca dogrulandi (bkz. MEMORY.md oturum notu).
 * Burada test edilen, SESSIZCE yanlis davranabilecek ve bir daha kimsenin
 * bakmayacagi kural: ROTASYON. Yanlis calisirsa fark edilmez — ta ki geri
 * donmek gerektiginde elde bir sey kalmadigi anlasilana kadar.
 */
export async function runBackupSelfTest(): Promise<void> {
  const domain = "backup-selftest.test.invalid";
  const dir = path.join(BACKUP_ROOT, domain);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  // Sahte yedekler: en eskiden en yeniye. Ad zaman damgasi tasiyor.
  const names: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const name = backupNameForNow(new Date(Date.UTC(2026, 0, 1 + i, 3, 0, 0)));
    names.push(name);
    await fs.writeFile(path.join(dir, name), `arsiv ${i}`);
    await fs.writeFile(path.join(dir, name.replace(/\.tar\.gz$/, ".manifest.json")), "{}");
  }

  try {
    const listed = await localTarget.list(domain);
    assert.equal(listed.length, 5, "5 yedek listelenmeli");
    // list() EN YENIYI ONCE dondurur; arayuz ve rotasyon buna guveniyor.
    assert.equal(listed[0].name, names[4], "en yeni yedek ilk sirada olmali");

    // --- Rotasyon: sinir icindekiler korunur ---
    const removedNone = await rotateBackups(domain, 5, new Set());
    assert.equal(removedNone.length, 0, "sinir asilmadiysa hicbir sey silinmemeli");

    // --- Rotasyon: EN ESKIDEN siler ---
    const removed = await rotateBackups(domain, 3, new Set());
    assert.equal(removed.length, 2, "5 yedekten 3 kalmali");
    assert.ok(removed.includes(names[0]) && removed.includes(names[1]), "en eski ikisi silinmeli");
    const after = await localTarget.list(domain);
    assert.equal(after.length, 3);
    // Manifest de silinmis olmali; yetim manifest birakmak kafa karistirir.
    const files = await fs.readdir(dir);
    assert.ok(
      !files.includes(names[0].replace(/\.tar\.gz$/, ".manifest.json")),
      "silinen yedegin manifest'i de gitmeli",
    );

    // --- EN ONEMLI KURAL: dogrulanmis yedek sinir disinda kalsa bile SILINMEZ ---
    //
    // Dogrulanmis yedek, geri yuklenebildigi KANITLANMIS tek kopyadir. Onu
    // "sirasi geldi" diye silmek, elde kanitlanmis hicbir sey birakmamak
    // demektir — yedekleme sisteminin varlik sebebini ortadan kaldirir.
    const survivors = await localTarget.list(domain);
    const oldestSurvivor = survivors[survivors.length - 1].name;
    const removedProtected = await rotateBackups(domain, 1, new Set([oldestSurvivor]));
    assert.ok(
      !removedProtected.includes(oldestSurvivor),
      "dogrulanmis yedek sinir disinda kalsa bile silinmemeli",
    );
    const finalList = await localTarget.list(domain);
    assert.ok(
      finalList.some((b) => b.name === oldestSurvivor),
      "dogrulanmis yedek diskte durmali",
    );

    // --- Yol ayiraci iceren ad ASLA cozulmez (dizin disina cikma) ---
    assert.equal(await localTarget.resolve(domain, "../../../etc/passwd"), null);
    assert.equal(await localTarget.resolve(domain, "alt/dizin.tar.gz"), null);

    // --- Ad uretimi: dosya sisteminde sorunlu karakter birakmaz ---
    const generated = backupNameForNow(new Date("2026-09-01T07:16:03.455Z"));
    assert.ok(!generated.includes(":"), "ad iki nokta icermemeli");
    assert.ok(generated.endsWith(".tar.gz"), "ad .tar.gz ile bitmeli");
    assert.ok(/^2026-09-01T07-16-03Z\.tar\.gz$/.test(generated), `beklenmeyen ad: ${generated}`);

    console.log(
      "✓ yedekleme self-test geçti (rotasyon en eskiden siler, DOĞRULANMIŞ yedeği asla silmez, yol ayıracı reddedilir)",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
