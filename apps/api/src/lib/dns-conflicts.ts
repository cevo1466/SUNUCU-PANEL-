/**
 * BASKA SAGLAYICIDAN DEVRALINAN BOLGELERDEKI ESKI KAYITLAR.
 *
 * NEDEN VAR (2026-09-05, kullanici bildirdi): bir musterinin bolgesi
 * turkticaret.net'ten devralinmisti ve eski kayitlar duruyordu. Panel posta
 * kayitlarini yazmaya calisinca Cloudflare ham Ingilizce
 *   "A CNAME record with that host already exists"
 * dondu; panel bunu oldugu gibi gosterdi. Kullanici ne yapacagini bilemez.
 *
 * Ama gorunen hata en kucuk sorundu. Eski karsilastirma yalnizca ad+tip'e
 * bakiyordu ve UC durumu SESSIZCE yanlis yonetiyordu:
 *   1. Ayni adda YABANCI bir A/MX varsa kayit "zaten var" sayilip panelinki
 *      hic yazilmiyordu. Panel "eksik kayit yok" der, posta eski sunucuya
 *      gitmeye devam eder — bu projedeki klasik "kayit X diyor, gercek Y".
 *   2. Ikinci bir SPF yazmak RFC 7208 § 4.5 geregi "permerror" uretir:
 *      giden postanin TAMAMI dogrulamayi geceremez.
 *   3. Ayni oncelikte iki MX, gelen postanin yarisini eski sunucuya gonderir.
 *
 * BU MODUL TEK KARAR YERIDIR. Hem posta duzeltmesi (lib/mail-dns.ts) hem
 * domain eklerken calisan toplu gonderim (lib/dnsProvision.ts) burayi
 * kullanir; ayni sorunun iki yerde ayri ayri cozulmesi, birinin unutulmasi
 * demekti.
 *
 * DEVRALMA SINIRI — bilerek dar:
 *   - POSTA kayitlari (mail./webmail. A, apeks MX, SPF/DKIM/DMARC) devralinir.
 *     Postada "kismen calisan" bir durum yoktur: eski MX ya da CNAME durdugu
 *     surece posta sessizce yanlis sunucuya gider, kullanici bunu haftalar
 *     sonra fark eder.
 *   - WEB kayitlari (apeks A, www) ASLA kendiliginden silinmez. Orada calisan
 *     bir site vardir; panele tasinmadan once o kaydi silmek siteyi karartir.
 *     Bunlar yalnizca bildirilir.
 */

/** Cloudflare'den donen canli kayit (yalnizca gereken alanlar). */
export interface LiveDnsRecord {
  id?: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
}

/** Panelin yazmayi planladigi kayit. */
export interface PanelDnsRecord {
  record_type: string;
  name: string;
  content: string;
  priority?: number | null;
}

export interface DnsConflict {
  /** Cakisan canli kayit. */
  record: LiveDnsRecord;
  /** Bu kayit dururken planlanan kayit yazilamaz mi? */
  blocking: boolean;
  /** Posta akisinin parcasi mi — devralinmasi guvenli mi? */
  takeoverSafe: boolean;
  /** Kullaniciya gosterilecek aciklama: ne oldu, ne yapilmali. */
  message: string;
}

export interface ConflictReport {
  /** Ayni ad+tip+deger zaten yerinde — YENIDEN YAZILMAMALI. */
  exists: boolean;
  /**
   * Ayni addaki diger kayitlar.
   *
   * `exists` true olsa bile DOLU olabilir ve bu en sinsi durumdur: panelin MX
   * kaydi yerinde ama eski saglayicinin MX'i de duruyorsa panel "eksik yok"
   * der, gelen postanin yarisi eski sunucuya gider. Bu yuzden cakisma taramasi
   * "zaten var" kisa devresine BAGLI DEGILDIR.
   */
  conflicts: DnsConflict[];
}

/** Cloudflare TXT icerigini tirnakli dondurur; karsilastirmadan once soyulur. */
export function unquote(value: string): string {
  return value.replace(/^"([\s\S]*)"$/, "$1");
}

/** Iki kaydin "ayni degeri" tasiyip tasimadigini karsilastirilabilir yapar. */
export function normalizeContent(type: string, content: string): string {
  const raw = type === "TXT" ? unquote(content) : content;
  // Hedef ADLARINDA sondaki nokta ve buyuk/kucuk harf anlamsizdir; IP'de degil.
  return type === "MX" || type === "CNAME"
    ? raw.trim().replace(/\.$/, "").toLowerCase()
    : raw.trim();
}

/** Posta dogrulama TXT'lerinin turu — ayni adda ikincisi cakismadir. */
export function txtKind(name: string, content: string): "spf" | "dkim" | "dmarc" | null {
  const value = unquote(content);
  if (/^v=spf1\b/i.test(value)) return "spf";
  if (/^v=DKIM1\b/i.test(value) || name.includes("._domainkey.")) return "dkim";
  if (/^v=DMARC1\b/i.test(value) || name.startsWith("_dmarc.")) return "dmarc";
  return null;
}

/**
 * Planlanan kayit POSTA akisinin parcasi mi?
 *
 * Devralma yetkisi tam olarak bu kumeyle sinirlidir. Apeks A ve www bilerek
 * disaridadir: orada calisan bir site olabilir.
 */
export function isMailScoped(row: PanelDnsRecord, domainName: string): boolean {
  const name = row.name.toLowerCase();
  const domain = domainName.toLowerCase();
  if (row.record_type === "MX" && name === domain) return true;
  if (row.record_type === "A" && (name === `mail.${domain}` || name === `webmail.${domain}`)) {
    return true;
  }
  if (row.record_type === "TXT") return txtKind(name, row.content) !== null;
  return false;
}

function describe(record: LiveDnsRecord): string {
  const priority = record.priority != null ? `${record.priority} ` : "";
  return `${record.type} ${record.name} → ${priority}${normalizeContent(record.type, record.content)}`;
}

/**
 * Planlanan kaydin karsisina cikan engelleri bulur.
 *
 * Cloudflare'e HIC GITMEDEN karar verilir: ham API hatasini kullaniciya
 * gostermek bir cozum degildir, ustelik onlenebilir hatalar (ikinci SPF)
 * API'den hata bile donmez — sessizce zarar verir.
 */
export function findDnsConflicts(
  row: PanelDnsRecord,
  live: LiveDnsRecord[],
  domainName: string,
): ConflictReport {
  const sameName = live.filter((record) => record.name.toLowerCase() === row.name.toLowerCase());
  const wanted = normalizeContent(row.record_type, row.content);
  const mailScoped = isMailScoped(row, domainName);

  const isSameValue = (record: LiveDnsRecord): boolean =>
    record.type === row.record_type && normalizeContent(record.type, record.content) === wanted;
  const exists = sameName.some(isSameValue);

  const conflicts: DnsConflict[] = [];

  // 1) CNAME ayni adda baska hicbir kaydi kabul etmez (RFC 1034 § 3.6.2).
  for (const cname of sameName.filter((record) => record.type === "CNAME")) {
    conflicts.push({
      record: cname,
      blocking: true,
      takeoverSafe: mailScoped,
      message:
        `${row.name} adında bir CNAME kaydı var (→ ${normalizeContent("CNAME", cname.content)}). ` +
        `DNS kuralı gereği CNAME varken aynı adda ${row.record_type} kaydı bulunamaz. Bu ` +
        `genellikle önceki sağlayıcıdan devralınan bölgede kalan eski kayıttır` +
        (mailScoped
          ? "; posta kaydı olduğu için panel bunu devralıp kendi kaydını yazar."
          : ". Web kaydı olduğu için panel buna kendiliğinden dokunmaz — siteyi karartmamak " +
            "için silme kararı sizde: DNS sayfasından silin, sonra tekrar deneyin."),
    });
  }

  // 2) Ayni turden ikinci bir posta TXT'si.
  if (row.record_type === "TXT") {
    const kind = txtKind(row.name, row.content);
    const rivals = kind
      ? sameName.filter(
          (record) =>
            record.type === "TXT" &&
            txtKind(record.name, record.content) === kind &&
            !isSameValue(record),
        )
      : [];
    for (const rival of rivals) {
      conflicts.push({
        record: rival,
        blocking: true,
        takeoverSafe: true,
        message:
          kind === "spf"
            ? `${row.name} için zaten farklı bir SPF kaydı var: ` +
              `${normalizeContent("TXT", rival.content)} — RFC 7208 gereği tek adda birden fazla ` +
              `SPF kaydı "permerror" üretir ve giden postanın TAMAMI doğrulamayı geçemez.`
            : `${row.name} için zaten farklı bir ${kind === "dkim" ? "DKIM" : "DMARC"} kaydı var: ` +
              `${normalizeContent("TXT", rival.content).slice(0, 60)}… — aynı adda ikinci kayıt ` +
              `doğrulamayı belirsiz hale getirir.`,
      });
    }
  }

  // 3) Ayni ad+tip, FARKLI deger. A ve MX'te bu DNS'te yasaldir (birden fazla
  //    kayit), ama posta adlarinda neredeyse her zaman eski saglayicinin
  //    kalintisidir ve trafigi ikiye boler.
  if (row.record_type === "A" || row.record_type === "MX") {
    for (const foreign of sameName.filter(
      (record) => record.type === row.record_type && !isSameValue(record),
    )) {
      conflicts.push({
        record: foreign,
        // Engellemez: panelin kaydi yine de yazilabilir, ama eskisi kalirsa
        // trafik bolunur.
        blocking: false,
        takeoverSafe: mailScoped,
        message:
          row.record_type === "MX"
            ? `${row.name} için başka bir MX kaydı daha var (${describe(foreign)}). Gelen postanın ` +
              `bir kısmı oraya gitmeye devam eder` +
              (mailScoped ? "; panel eski kaydı devralıp kaldırır." : ".")
            : `${row.name} için başka bir ${row.record_type} kaydı daha var (${describe(foreign)}). ` +
              `Trafik iki adrese bölünür` +
              (mailScoped
                ? "; posta kaydı olduğu için panel eski kaydı kaldırır."
                : ". Bu bir web kaydı: site henüz panele taşınmadıysa eski kaydı SİLMEYİN, " +
                  "taşındıktan sonra DNS sayfasından kaldırın."),
      });
    }
  }

  return { exists, conflicts };
}

/**
 * Posta istemcisi otomatik ayar kayitlari.
 *
 * NEDEN AYRI: panel bu adlari PLANLAMAZ, dolayisiyla yukaridaki cakisma
 * taramasina hic girmezler — ama devralinan bolgede kalirlarsa Outlook ve
 * Thunderbird kullaniciyi hala ESKI sunucuya baglar. Kayitlar dogru, posta
 * akiyor, buna ragmen musteri "posta calismiyor" der. Silmiyoruz, soyluyoruz.
 */
export function autoconfigLeftovers(live: LiveDnsRecord[], domainName: string): string[] {
  const domain = domainName.toLowerCase();
  const mailHost = `mail.${domain}`;
  const suspects = live.filter((record) => {
    const name = record.name.toLowerCase();
    const isAutoconfigName =
      name === `autoconfig.${domain}` ||
      name === `autodiscover.${domain}` ||
      name === `_autodiscover._tcp.${domain}`;
    if (!isAutoconfigName) return false;
    const target = normalizeContent(record.type, record.content);
    return target !== mailHost && !target.endsWith(`.${domain}`) && target !== domain;
  });
  return suspects.map(
    (record) =>
      `${record.name} hâlâ dışarıyı gösteriyor (${describe(record)}). Outlook/Thunderbird ` +
      `otomatik kurulumda müşteriyi ESKİ sunucuya bağlar. Posta bu panele taşındıysa bu kaydı ` +
      `DNS sayfasından silin.`,
  );
}
