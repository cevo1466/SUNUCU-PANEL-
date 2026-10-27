/**
 * Uptime/servis-sağlığı bildirim POLİTİKASI — saf karar mantığı.
 *
 * NEDEN AYRI DOSYA VE SAF: Bu mantığın tek işi "şu an mesaj gitmeli mi?"
 * sorusunu yanıtlamak. Ağ, Telegram, saat okuma — hiçbiri burada yok; hepsi
 * parametre. Böylece gerçek bir kesintiyi beklemeden, sahte saatle, saniyeler
 * içinde test edilebiliyor (bkz. self-test.ts "uptime politikası" bloğu).
 *
 * NEDEN YALNIZCA HETRIXTOOLS DEĞİL: Aynı süre-bazlı state machine artık
 * kaynak eşikleri (CPU/RAM/disk) ve yerel servis sağlık kontrolleri
 * (web/nginx-docker/veritabanı) için de KULLANILIYOR (bkz. lib/alerts.ts
 * evaluateMonitor) — "down" burada "eşik aşıldı" veya "servis yanıt
 * vermiyor" anlamına da gelebilir. Tek bir kanıtlanmış karar mantığı, her
 * alarm türü için ayrı ayrı yeniden icat edilmiş kırılgan mantıktan iyidir.
 *
 * ÇÖZDÜĞÜ SORUN (kullanıcı: "zırt pırt bildirim geliyor, sinirim bozuldu" —
 * bu şikayet 2026-08-28'de İKİ KEZ geldi, ikinci sefer kapsam CPU/RAM/disk
 * ve yerel servislere genişletildi):
 * HetrixTools monitörü 203.0.113.10'in 22. portunu 5 sn timeout ile dakikada
 * bir yokluyor. Sağlıklıyken yanıt 39-50 ms, başarısızken tam 5004 ms — yani
 * ya anında cevap veriyor ya da timeout'a takılıyor. Sonuç: dakika başı
 * down/up çifti. Önceki sürüm bunu "3 ardışık okuma + soğuma + flap
 * susturma" ile azaltmaya çalışıyordu ama bitiremiyordu: monitör 90 saniye
 * boyunca down kalırsa üç ardışık okuma da down görülüp mesaj onaylanıyordu.
 *
 * ÇÖZÜM — ardışık okuma sayısı değil SÜRE:
 * Bir kesinti ancak KESİNTİSİZ `downAfterMinutes` dakika sürerse bildirilir.
 * Arada tek bir "up" görülmesi sayacı sıfırlar. 1 dakikalık titreme artık
 * yapısal olarak mesaj üretemez — eşik ne kadar okuma yapıldığına değil,
 * gerçek zamana bağlı.
 *
 * İKİNCİ TUR EKLENEN İKİ KURAL (kullanıcı talebi):
 *   1. STABİLİTE PENCERESİ: "down" bildirildikten sonra ilk "up" görüldüğü
 *      anda değil, KESİNTİSİZ `resolveAfterMinutes` dakika ayakta kaldıktan
 *      SONRA "RESOLVED" gönderilir. Böylece iyileşme sırasında bir-iki kez
 *      daha titrerse sahte bir "düzeldi" mesajı gitmez — kesinti hâlâ aynı
 *      kesinti sayılır (downSince/notifiedForOutage korunur).
 *   2. HÂLÂ-DOWN ÖZETİ: Kesinti uzun sürerse (örn. bakım/gerçek arıza), her
 *      `stillDownSummaryMinutes` dakikada bir TEK satırlık bir özet mesajı
 *      gider — sessizlik "unutuldu mu" endişesi yaratmasın, ama spam da
 *      olmasın diye 30 dakika gibi seyrek bir varsayılan.
 */

export interface UptimePolicyConfig {
  /** Kesintisiz bu kadar dakika down kalınmadan uyarı gönderilmez. */
  downAfterMinutes: number;
  /** Uptime yüzdesi bu değerin altına düşerse ayrı bir uyarı gönderilir. */
  uptimePercentMin: number;
  /** Down bildirildikten sonra RESOLVED için gereken KESİNTİSİZ ayakta kalma süresi (dk). */
  resolveAfterMinutes: number;
  /** Down sürerken kaç dakikada bir "hâlâ down" özeti gönderilir. 0 = özet kapalı. */
  stillDownSummaryMinutes: number;
}

/**
 * Yüzde uyarısının yeniden silahlanması için gereken pay. Eşiğin tam
 * üstünde/altında gezinen bir değerin tekrar tekrar uyarı üretmesini
 * engeller.
 */
export const UPTIME_PERCENT_REARM_MARGIN = 0.2;

export interface UptimeMonitorState {
  /** İlk "down" görüldüğü an (ms). Kesinti bildirilmiş ve stabilite bekleniyorsa RESOLVED'e kadar korunur. */
  downSince: number | null;
  /** Bu kesinti için "SERVİS DOWN" mesajı gönderildi mi? */
  notifiedForOutage: boolean;
  /** Yüzde eşiği uyarısı gönderildi mi? (yeniden silahlanana kadar tekrarlamaz) */
  percentAlerted: boolean;
  /** Bildirilmiş bir kesintiden sonra kesintisiz "up" görülmeye başlanan an — RESOLVED stabilite sayacı. */
  upSince: number | null;
  /** Down sürerken en son "hâlâ down" özetinin gönderildiği an. */
  lastStillDownNotifiedAt: number | null;
}

export function initialUptimeState(): UptimeMonitorState {
  return {
    downSince: null,
    notifiedForOutage: false,
    percentAlerted: false,
    upSince: null,
    lastStillDownNotifiedAt: null,
  };
}

export interface UptimeObservation {
  /** "up" dışındaki her şey down sayılır (HetrixTools `uptime_status` veya yerel sağlık kontrolü sonucu). */
  status: string;
  /** HetrixTools `uptime` alanı, yüzde. Okunamadıysa/uygulanmıyorsa null. */
  uptimePercent: number | null;
}

export type UptimeDecision =
  | { kind: "down"; outageMinutes: number }
  | { kind: "still-down"; outageMinutes: number }
  | { kind: "up"; outageMinutes: number }
  | { kind: "percent"; uptimePercent: number };

export interface UptimePolicyResult {
  state: UptimeMonitorState;
  decisions: UptimeDecision[];
}

/**
 * Tek bir monitörün tek bir gözlemini değerlendirir.
 *
 * Saf fonksiyon: aynı (state, observation, now, config) girdisi her zaman aynı
 * çıktıyı verir. Girdi state'i DEĞİŞTİRMEZ, yenisini döndürür.
 */
export function decideUptime(
  previous: UptimeMonitorState,
  observation: UptimeObservation,
  now: number,
  config: UptimePolicyConfig,
): UptimePolicyResult {
  const state: UptimeMonitorState = { ...previous };
  const decisions: UptimeDecision[] = [];
  const isDown = observation.status !== "up";

  if (isDown) {
    if (state.downSince === null) {
      // Kesinti YENİ başladı. Henüz hiçbir şey söylenmez — gerçek bir kesinti
      // mi yoksa tek seferlik bir timeout mu, bunu ancak süre gösterir.
      state.downSince = now;
    }
    // Iyilesme sirasinda tekrar dustuyse stabilite sayaci gecersiz —
    // kesinti hala AYNI kesinti.
    state.upSince = null;

    const elapsedMinutes = (now - state.downSince) / 60_000;
    if (!state.notifiedForOutage && elapsedMinutes >= config.downAfterMinutes) {
      state.notifiedForOutage = true;
      state.lastStillDownNotifiedAt = now;
      decisions.push({ kind: "down", outageMinutes: elapsedMinutes });
    } else if (
      state.notifiedForOutage &&
      config.stillDownSummaryMinutes > 0 &&
      state.lastStillDownNotifiedAt !== null &&
      (now - state.lastStillDownNotifiedAt) / 60_000 >= config.stillDownSummaryMinutes
    ) {
      state.lastStillDownNotifiedAt = now;
      decisions.push({ kind: "still-down", outageMinutes: elapsedMinutes });
    }
  } else if (!state.notifiedForOutage) {
    // Hic bildirilmemis bir kesinti (esigin altinda kalan kisa bir titreme)
    // sessizce temizlenir — kullaniciya hic duymadigi bir sorunun cozuldugu
    // soylenmez.
    state.downSince = null;
    state.upSince = null;
  } else {
    // Bildirilmis bir kesintiden cikiliyor: RESOLVED icin KESINTISIZ
    // `resolveAfterMinutes` dakika ayakta kalinmasi sartir. Tek bir "up"
    // yetmez — bu sartin ta kendisi onceki surumdeki erken/sahte "duzeldi"
    // mesajlarini onler.
    if (state.upSince === null) state.upSince = now;
    const stableMinutes = (now - state.upSince) / 60_000;
    if (stableMinutes >= config.resolveAfterMinutes) {
      const outageMinutes = state.downSince !== null ? (state.upSince - state.downSince) / 60_000 : 0;
      decisions.push({ kind: "up", outageMinutes });
      state.downSince = null;
      state.notifiedForOutage = false;
      state.upSince = null;
      state.lastStillDownNotifiedAt = null;
    }
    // else: hala stabillesmeyi bekliyor — downSince/notifiedForOutage KORUNUR.
  }

  // Yüzde eşiği kesintiden bağımsız değerlendirilir: monitör "up" olsa bile
  // biriken kısa kesintiler yüzdeyi aşağı çeker ve bu tek başına bildirmeye
  // değer bir sinyaldir.
  const percent = observation.uptimePercent;
  if (percent !== null) {
    if (!state.percentAlerted && percent < config.uptimePercentMin) {
      state.percentAlerted = true;
      decisions.push({ kind: "percent", uptimePercent: percent });
    } else if (
      state.percentAlerted &&
      percent >= config.uptimePercentMin + UPTIME_PERCENT_REARM_MARGIN
    ) {
      state.percentAlerted = false;
    }
  }

  return { state, decisions };
}

/** Kesinti süresini insan diline çevirir ("7 dk", "1 sa 12 dk"). */
export function formatOutage(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} dk`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} sa` : `${hours} sa ${rest} dk`;
}
