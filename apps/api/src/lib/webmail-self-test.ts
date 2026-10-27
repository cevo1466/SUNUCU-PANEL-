import assert from "node:assert/strict";
import { sanitizeHtml } from "./webmail-mail.js";
import { encryptSecret, decryptSecret } from "./webmail-crypt.js";

/**
 * Webmail'in SAF mantık testleri.
 *
 * KAPSAM BİLİNÇLİ OLARAK DAR: gerçek IMAP/SMTP akışı (giriş, listeleme,
 * gönderme, ek indirme, kota) canlı Dovecot ve Postfix'e ihtiyaç duyuyor ve
 * gerçek bir posta kutusu gerektiriyor. O akış elle uçtan uca doğrulandı
 * (bkz. MEMORY.md oturum notu). Burada test edilenler, sessizce yanlış
 * cevap verebilecek ve bir daha kimsenin bakmayacağı iki şey:
 *
 *   1. HTML temizliği — mail gövdesi TAMAMEN güvenilmez girdidir. Bir
 *      gerileme burada doğrudan XSS demektir ve gözle fark edilmez.
 *   2. Oturum sırrının şifrelenmesi — bozulursa ya parola düz metin kalır ya
 *      da çözülemeyip herkesin oturumu kopar.
 */
export async function runWebmailSelfTest(): Promise<void> {
  // --- HTML temizliği ---

  assert.ok(
    !/<script/i.test(sanitizeHtml('<p>merhaba</p><script>alert(1)</script>')),
    "script etiketi sokulmeli",
  );
  assert.ok(
    !/<script/i.test(sanitizeHtml('<script src="https://kotu.example/x.js"></script>')),
    "kapanissiz/src li script de sokulmeli",
  );
  assert.ok(
    !/onerror/i.test(sanitizeHtml('<img src=x onerror="alert(1)">')),
    "on* olay ozniteligi sokulmeli (tirnakli)",
  );
  assert.ok(
    !/onload/i.test(sanitizeHtml("<body onload=alert(1)>")),
    "on* olay ozniteligi sokulmeli (tirnaksiz)",
  );
  assert.ok(
    !/javascript:/i.test(sanitizeHtml('<a href="javascript:alert(1)">tikla</a>')),
    "javascript: URL notrlenmeli",
  );
  assert.ok(
    !/<iframe/i.test(sanitizeHtml('<iframe src="https://kotu.example"></iframe>')),
    "iframe sokulmeli",
  );
  // Uzak gorseller engellenir ama SILINMEZ: kullanici isterse gosterebilmeli.
  const withImage = sanitizeHtml('<img src="https://izleme.example/pixel.gif">');
  assert.ok(!/\ssrc=/i.test(withImage), "uzak gorsel src'si etkisizlestirilmeli");
  assert.ok(
    /data-blocked-src="https:\/\/izleme\.example\/pixel\.gif"/.test(withImage),
    "engellenen gorselin adresi korunmali (kullanici gostermeyi secebilsin)",
  );
  // Zararsız biçimlendirme KORUNUR — aşırı temizlik maili okunmaz yapardı.
  const safe = sanitizeHtml("<p><b>kalin</b> ve <i>italik</i> ve <a href=\"https://ornek.com\">baglanti</a></p>");
  assert.ok(/<b>kalin<\/b>/.test(safe), "kalin metin korunmali");
  assert.ok(/href="https:\/\/ornek\.com"/.test(safe), "normal https baglanti korunmali");

  // --- Oturum sırrı şifrelemesi ---

  const secret = "Çok!Gizli-Parola_2026";
  const enc = encryptSecret(secret);
  assert.notEqual(enc, secret, "sifreli metin duz metinle ayni olamaz");
  assert.ok(!enc.includes(secret), "sifreli metin parolayi icermemeli");
  assert.equal(enc.split(":").length, 3, "bicim iv:tag:ciphertext olmali");
  assert.equal(decryptSecret(enc), secret, "cozulen deger orijinaliyle ayni olmali");

  // Aynı parola iki kez şifrelendiğinde FARKLI çıktı vermeli (rastgele IV).
  // Aynı çıkması, iki oturumun aynı parolayı kullandığını sızdırırdı.
  assert.notEqual(encryptSecret(secret), encryptSecret(secret), "her sifreleme farkli IV kullanmali");

  // Oynanmış kayıt SESSİZCE yanlış parola vermemeli, hata fırlatmalı —
  // yanlış parolayla IMAP'e gitmek hesabı kilitleyebilir.
  const [iv, tag, data] = enc.split(":");
  const tampered = `${iv}:${tag}:${Buffer.from("baskaveri").toString("base64")}`;
  assert.throws(() => decryptSecret(tampered), "oynanmis kayit hata firlatmali");
  assert.throws(() => decryptSecret("bozuk-bicim"), "gecersiz bicim hata firlatmali");

  console.log(
    "✓ webmail self-test geçti (HTML temizliği: script/on*/javascript:/iframe reddedildi, uzak görsel engellendi; oturum sırrı AES-256-GCM ile şifreli ve oynanmaya kapalı)",
  );
}
