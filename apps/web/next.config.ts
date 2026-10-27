import type { NextConfig } from "next";

/**
 * Yükleme boyutu sınırı — zincirin Next.js halkası.
 *
 * NEDEN VAR: `src/middleware.ts` `/api` dışındaki tüm yolları kapsıyor ve
 * middleware tanımlıysa Next.js istek gövdesine 10 MB'lık bir tavan koyuyor.
 * Bu tavan SESSİZ değil ama şifreli patlıyordu: 2026-08-29'da 500 MB'lık bir
 * dosya yüklenmeye çalışıldığında ops/web.log'a
 *   "Request body exceeded 10MB for /api/domains/822/files/upload"
 *   "Failed to proxy http://127.0.0.1:3001/... [Error: socket hang up]"
 * düştü; kullanıcının gördüğü ise yalnızca başarısız bir yüklemeydi.
 *
 * API'deki sınırla (lib/files.ts MAX_UPLOAD_BYTES, varsayılan 2 GB) ve
 * nginx'teki `client_max_body_size` ile AYNI değerde tutulmalı. Üçünden en
 * dar olan kazanır; biri geride kalırsa sebebi görünmeyen bir hata olur.
 */
const MAX_UPLOAD_MB = Number.parseInt(process.env.MAX_UPLOAD_MB ?? "", 10) || 2048;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * Derleme çıktısının gideceği dizin.
   *
   * NEDEN AYARLANABİLİR: `next build` ile `next start` AYNI `.next` dizinini
   * kullanır. Doğrulama (`./verify.sh`) çalışan servisleri durdurmadan
   * derleme yapıyordu ve canlı panel derlemenin ortasında 502 veriyordu
   * (web.log'da "failed-to-find-server-action" izi). Doğrulama artık
   * NEXT_DIST_DIR ile ayrı bir dizine derliyor; gerçek dağıtım
   * (restart-services.sh) servisleri durdurup varsayılan `.next`'e derlemeye
   * devam ediyor.
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    middlewareClientMaxBodySize: `${MAX_UPLOAD_MB}mb`,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.INTERNAL_API_URL ?? "http://127.0.0.1:3001"}/api/:path*`,
      },
      {
        // Adminer (tek dosyalık DB yönetim arayüzü) panelin ALTINDAN yayınlanır.
        //
        // NEDEN BÖYLE: Adminer `php -S 127.0.0.1:8098` ile yalnızca loopback'te
        // dinliyor ve dış nginx'te 8098'e giden hiçbir yönlendirme yoktu —
        // yani panelden "Adminer'ı aç" denince gidilecek bir adres YOKTU.
        // Alternatif (nginx'e location + basic auth eklemek) Adminer'ı Docker
        // gateway'e açmayı gerektiriyordu; bu yol Adminer'ı 127.0.0.1'de
        // BIRAKIR ve hiçbir yeni port dışarı açmaz.
        //
        // ERİŞİM KAPISI: src/middleware.ts matcher'ı `/api` dışındaki tüm
        // yolları kapsadığı için `/adminer/*` otomatik olarak panel oturumunun
        // arkasına düşer — oturumsuz istek 307 ile /login'e gider.
        source: "/adminer/:path*",
        destination: `${process.env.ADMINER_INTERNAL_URL ?? "http://127.0.0.1:8098"}/:path*`,
      },
      {
        // Adminer'ın kendi varlıkları (CSS/JS) kök yola göre istenir; sondaki
        // slash olmadan gelen isteğin de karşılığı olsun.
        source: "/adminer",
        destination: `${process.env.ADMINER_INTERNAL_URL ?? "http://127.0.0.1:8098"}/`,
      },
    ];
  },
};

export default nextConfig;
