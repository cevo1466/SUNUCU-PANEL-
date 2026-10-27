// HetrixTools REST API v3 — https://api.hetrixtools.com/v3/uptime-monitors
// Kimlik doğrulama: `Authorization: Bearer <token>` HEADER'ında (token
// URL path'inde DEĞİL). Doğru path SONUNDA trailing slash OLMAMALI —
// `/v3/uptime-monitors/` (trailing slash'lı) "invalid endpoint" (400)
// döndürüyordu; `/v3/uptime-monitors` (slash'sız) + Bearer header ile
// GERÇEK hesapla test edilip doğrulandı (bkz. MEMORY.md — önceki oturumda
// token path'e gömülüp trailing slash'lı denenmişti, ikisi de yanlıştı).
import { env } from "../env.js";

const ENDPOINT = "https://api.hetrixtools.com/v3/uptime-monitors";

export interface HetrixMonitorSummary {
  id: string;
  name: string;
  type: string;
  target: string;
  category: string;
  uptime_status: string;
  monitor_status: string;
  /** Yuzde olarak calisma orani, API string dondurur (ornek: "100.0000"). */
  uptime?: string;
  /** "service" tipi monitorlerde yoklanan TCP portu (ornek: 22). */
  port?: number | null;
  /**
   * Kontrol noktasi -> son olcum. Panelin "kaynak/uptime" raporunda ortalama
   * yanit suresi bu alandan hesaplaniyor; API bunlari zaten donduruyordu,
   * yalnizca tip tarafinda tanimli degildi.
   */
  locations?: Record<
    string,
    { uptime_status?: string; response_time?: number; last_check?: number }
  >;
}

export type HetrixResult =
  | { configured: true; ok: true; monitors: HetrixMonitorSummary[] }
  | { configured: true; ok: false; status: number; message: string }
  | { configured: false };

export async function fetchHetrixUptimeMonitors(): Promise<HetrixResult> {
  if (!env.HETRIX_API_KEY) {
    return { configured: false };
  }

  const res = await fetch(ENDPOINT, {
    headers: {
      Authorization: `Bearer ${env.HETRIX_API_KEY}`,
      Accept: "application/json",
    },
    // Node fetch'inde varsayilan zaman asimi yoktur; ucuncu taraf servis
    // yanit vermezse bu cagri sonsuza kadar asili kalir ve onu bekleyen
    // alarm turu bir daha hic donmez.
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    monitors?: HetrixMonitorSummary[];
  };

  if (!res.ok) {
    return {
      configured: true,
      ok: false,
      status: res.status,
      message: body.message ?? body.error ?? `HTTP ${res.status}`,
    };
  }

  return { configured: true, ok: true, monitors: body.monitors ?? [] };
}
