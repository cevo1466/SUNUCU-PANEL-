import type { $ZodIssue } from "zod/v4/core";

/**
 * Zod dogrulama hatalarini KULLANICININ OKUYABILECEGI Turkce cumleye cevirir.
 *
 * NEDEN VAR: 15 ayri uc `{ error: "Geçersiz girdi", issues: [...] }` donuyordu.
 * Hangi alanin neden reddedildigi `issues` icinde duruyor ama arayuz yalnizca
 * `error` alanini gosteriyor — kullanici "Geçersiz girdi" gorup neyi
 * duzeltecegini bilemiyordu. 2026-09-02'de musteri hesabi olusturmada tam
 * olarak bu yasandi: parola 10 karakterden kisaydi, ekranda bunu soyleyen
 * hicbir sey yoktu.
 *
 * Mesaj SUNUCUDA uretiliyor cunku kural sunucuda: istemci tarafinda ikinci bir
 * kural listesi tutmak, ikisinin ayrisip birbirini yalanlamasi demekti.
 */

/** Alan adi -> kullanicinin gordugu etiket. Eksik alanlar adiyla gecer. */
const FIELD_LABELS: Record<string, string> = {
  username: "Kullanıcı adı",
  email: "E-posta",
  password: "Parola",
  domain_name: "Alan adı",
  domainName: "Alan adı",
  localPart: "Adresin @ öncesi kısmı",
  dbName: "Veritabanı adı",
  dbUser: "Veritabanı kullanıcısı",
  quotaMb: "Kota (MB)",
  name: "Ad",
  content: "İçerik",
  ttl: "TTL",
  priority: "Öncelik",
  record_type: "Kayıt tipi",
  path: "Yol",
  target: "Hedef",
  expiresAt: "Bitiş tarihi",
  proxy_port: "Port",
  php_version: "PHP sürümü",
  runtime_type: "Çalışma tipi",
  url: "Adres",
};

function labelFor(issue: $ZodIssue): string {
  const key = issue.path.filter((part) => typeof part === "string").join(".");
  if (!key) return "Girdi";
  return FIELD_LABELS[key] ?? FIELD_LABELS[key.split(".").pop() ?? ""] ?? key;
}

/** Sayi/uzunluk siniri: metinde "karakter", sayida sadece deger. */
function boundText(issue: $ZodIssue, kind: "min" | "max"): string {
  const holder = issue as unknown as { minimum?: number; maximum?: number; origin?: string };
  const value = kind === "min" ? holder.minimum : holder.maximum;
  const unit = holder.origin === "string" ? " karakter" : "";
  const direction = kind === "min" ? "en az" : "en fazla";
  return `${direction} ${value}${unit} olmalı`;
}

/** Tek bir sorunu cumleye cevirir. */
function describeIssue(issue: $ZodIssue): string {
  const label = labelFor(issue);
  switch (issue.code) {
    case "too_small":
      // Zorunlu bos alan "en az 1 karakter" yerine daha dogal bir cumle alsin.
      return (issue as unknown as { minimum?: number }).minimum === 1
        ? `${label} boş bırakılamaz`
        : `${label} ${boundText(issue, "min")}`;
    case "too_big":
      return `${label} ${boundText(issue, "max")}`;
    case "invalid_format": {
      const format = (issue as unknown as { format?: string }).format;
      if (format === "email") return `${label} geçerli bir e-posta adresi olmalı`;
      if (format === "url") return `${label} geçerli bir adres olmalı`;
      if (format === "datetime") return `${label} geçerli bir tarih olmalı`;
      return `${label} beklenen biçimde değil`;
    }
    case "invalid_type": {
      const received = (issue as unknown as { input?: unknown }).input;
      return received === undefined || received === null
        ? `${label} zorunlu`
        : `${label} beklenen tipte değil`;
    }
    case "invalid_value": {
      const values = (issue as unknown as { values?: unknown[] }).values;
      return values && values.length > 0
        ? `${label} şunlardan biri olmalı: ${values.join(", ")}`
        : `${label} geçersiz`;
    }
    case "unrecognized_keys": {
      const keys = (issue as unknown as { keys?: string[] }).keys ?? [];
      return `Tanınmayan alan: ${keys.join(", ")}`;
    }
    default:
      // Ozel `.refine()` mesajlari zaten Turkce yazilmis oluyor; oldugu gibi.
      return issue.message;
  }
}

/**
 * Tum sorunlari tek bir cumleye toplar. Uctan fazlasi gosterilmez —
 * kullanicinin ilk duzeltecegi seyler zaten ilk siradakiler ve uzun bir
 * liste okunmaz hale gelir.
 */
export function describeIssues(issues: readonly $ZodIssue[]): string {
  // Ozel mesajlar (ornegin parola politikasi) kendi noktasiyla geliyor;
  // sondaki noktalama kirpilmazsa "su an 6.." gibi cift nokta olusuyordu.
  const parts = issues.slice(0, 3).map((issue) => describeIssue(issue).replace(/[.\s]+$/, ""));
  const rest = issues.length - parts.length;
  const suffix = rest > 0 ? ` (+${rest} sorun daha)` : "";
  return parts.join(" · ") + suffix + ".";
}

/**
 * 400 govdesi. `issues` KORUNUYOR: arayuz alan bazli hata gostermek isterse
 * kullanabilsin, mevcut cagiranlar da bozulmasin.
 */
export function invalidInput(issues: readonly $ZodIssue[]): {
  error: string;
  issues: readonly $ZodIssue[];
} {
  return { error: describeIssues(issues), issues };
}
