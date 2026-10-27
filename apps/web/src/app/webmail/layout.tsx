import type { Metadata } from "next";

/**
 * Webmail'in kendi başlığı.
 *
 * Kök layout "Studio Panel" diyor; posta kutusu sahibi için o ad bir şey ifade
 * etmiyor ve sekmeler arasında maili bulmayı zorlaştırıyor. Buradaki metadata
 * yalnızca /webmail altındaki sayfaları etkiler, panelin başlığına dokunmaz.
 */
export const metadata: Metadata = {
  title: "Webmail",
  description: "E-posta hesabınıza web üzerinden erişin",
  // Posta kutusu adresleri arama motorlarında listelenmemeli.
  robots: { index: false, follow: false },
};

export default function WebmailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
