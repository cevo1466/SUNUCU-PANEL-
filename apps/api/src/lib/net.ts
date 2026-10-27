import net from "node:net";

/**
 * Portun gerçekten dinlenip dinlenmediğine bakar. Uydurma değil: TCP bağlantısı
 * kurulmaya çalışılır ve sonucu ne ise o raporlanır.
 *
 * ORTAK YERE ALINDI: aynı kontrol hem veritabanı motorlarının (databases.ts
 * engineStatuses) hem mail sunucusunun (mail.ts mailServerStatus) durumunu
 * belirliyor. İki kopya olsaydı zamanla farklı timeout/hata davranışına
 * ayrışır ve "port kapalı" raporu iki modülde farklı anlama gelirdi.
 */
export async function isPortOpen(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}
