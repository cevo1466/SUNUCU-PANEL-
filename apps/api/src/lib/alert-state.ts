import fs from "node:fs/promises";
import path from "node:path";
import { GENERATED_DIR } from "./domain.js";
import type { UptimeMonitorState } from "./uptime-policy.js";

/**
 * Alarm durumunun DİSKTE tutulması.
 *
 * NEDEN VAR (ölçülmüş bir arıza): Alarm durumu (hangi uyarı aktif, hangisi
 * bildirildi, hangi kesinti ne zaman başladı) modül seviyesinde `Map`'lerde
 * duruyordu. API her yeniden başladığında hepsi sıfırlanıyordu — ve API
 * 2026-08-27 gecesi bir dakika içinde beş kez çöküp yeniden başladı
 * (ops/api.log, `kod=1`). Her yeniden başlatmada bastırılmış alarmlar
 * yeniden "yeni" sayılıp tekrar ateşleniyordu. Kullanıcının gördüğü
 * bildirim yağmurunun bir kısmı doğrudan buydu.
 *
 * Çökme ayrıca düzeltildi, ama deploy ve watchdog yeniden başlatmaları
 * normal hayatın parçası; durumun kalıcı olması gerekiyor.
 *
 * BOYUT: dosya birkaç yüz bayt. Her tick'te değil, yalnızca durum GERÇEKTEN
 * değiştiğinde yazılır.
 */

const STATE_PATH = path.join(GENERATED_DIR, "alert-state.json");

/**
 * TEK durum şeması — hetrix uptime monitörleri, kaynak eşikleri (CPU/RAM/
 * disk) ve yerel servis sağlık kontrolleri artık AYNI karar motorundan
 * (uptime-policy.ts decideUptime) geçtiği için hepsi aynı state şeklini
 * (UptimeMonitorState) paylaşır — bkz. lib/alerts.ts mimari notu.
 *
 * version 2: önceki şema `{resources, uptime}` iki ayrı sözlüktü (streak
 * bazlı kaynak takibi ile süre bazlı uptime takibi FARKLI state şekilleri
 * taşıyordu). Sürüm numarası bilerek artırıldı — eski dosya otomatik olarak
 * BOŞ durumla başlar (aşağıdaki `parsed.version !== 2` kontrolü), bozuk/eski
 * şemalı bir dosyayı yanlış yorumlamaktansa temiz başlamak tercih edilir
 * (bkz. dosya başı gerekçe).
 */
export interface PersistedAlertState {
  version: 2;
  monitors: Record<string, UptimeMonitorState>;
}

export function emptyAlertState(): PersistedAlertState {
  return { version: 2, monitors: {} };
}

/**
 * Diskten okur. Dosya yoksa, bozuksa veya beklenmedik bir şema taşıyorsa
 * BOŞ durumla döner — alarm sistemi bozuk bir dosya yüzünden hiç
 * çalışmamaktansa baştan başlamalı.
 */
export async function loadAlertState(): Promise<PersistedAlertState> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedAlertState>;
    if (parsed.version !== 2) return emptyAlertState();
    return {
      version: 2,
      monitors: parsed.monitors ?? {},
    };
  } catch {
    return emptyAlertState();
  }
}

/**
 * Atomik yazım (tmp → rename). Yarıda kesilen bir yazımın bozuk JSON
 * bırakmasını engeller; ftp.ts'teki üretilmiş dosya deseninin aynısı.
 * Bu dosya sır taşımaz, o yüzden 0600 gerekmez.
 */
export async function saveAlertState(state: PersistedAlertState): Promise<void> {
  try {
    await fs.mkdir(GENERATED_DIR, { recursive: true });
    const tmp = `${STATE_PATH}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tmp, STATE_PATH);
  } catch {
    // Durum yazılamazsa alarm sistemi çalışmaya DEVAM etmeli; en kötü
    // ihtimalle yeniden başlatmada durum kaybolur. Diske yazamadığı için
    // uyarı göndermeyi bırakmak çok daha kötü olurdu.
  }
}

export { STATE_PATH as ALERT_STATE_PATH };
