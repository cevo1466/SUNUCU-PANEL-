import { NextResponse, type NextRequest } from "next/server";

/**
 * Oturum çerezinin adı. apps/api tarafındaki SESSION_COOKIE_NAME ile aynı
 * olmak zorunda (apps/api/src/lib/session.ts).
 */
const SESSION_COOKIE = "studio_session";

/**
 * Webmail hostname kalibi: `webmail.<herhangi bir alan adi>`.
 *
 * NEDEN TEK BIR SABIT AD DEGIL: panel cok alan adi barindiriyor ve her
 * musterinin kendi adresinden webmail'e girmesi bekleniyor —
 * webmail.musteri.test, webmail.baskasite.com... Tek bir hostname'i sabitlemek,
 * her yeni alan adinda koda dokunmak demekti.
 *
 * Alt alan adinin panelde kayitli bir domaine ait olup olmadigi BURADA
 * denetlenmez: burasi yalnizca yonlendirme yapar, yetki vermez. Kimlik
 * dogrulamasi API'de ve IMAP'te; tanimadigimiz bir webmail.* adi da yalnizca
 * giris ekranini gorur.
 */
const WEBMAIL_HOST_PREFIX = "webmail.";

/**
 * CSP nonce'unu ve baslik degerini uretir. Nonce HER ISTEKTE farkli — ayni
 * nonce'un tekrar kullanilabilir olmasi, saldirganin ONCEDEN bilinen bir
 * nonce'la kendi script'ini gecirebilecegi anlamina gelirdi.
 *
 * `strict-dynamic`: Next.js App Router, RSC hydration verisini `<script>`
 * icine GOMEREK gonderiyor (icerigi her istekte degisiyor, bu yuzden hash
 * tabanli bir CSP calismaz — yalniz nonce isler). `strict-dynamic` bu
 * script'lerin kendi icinden actigi ek script'lere de nonce'u devrettigi
 * icin Next'in runtime'i BOZULMADAN calisiyor.
 *
 * `style-src 'unsafe-inline'`: bilincli gevseklik. Panel genelinde React
 * `style={{...}}` (ilerleme cubuklari, dinamik genislikler) yogun kullaniliyor;
 * bunlari nonce'lu <style> etiketlerine tasimak bu degisikligin kapsamini
 * asan bir refactor olurdu. CSS enjeksiyonu, script enjeksiyonundan cok daha
 * dusuk siddette bir tehdit — asil kapatilmasi gereken kapi script-src'ydi.
 */
function cspHeader(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * Sunucu tarafı yönlendirme kapısı.
 *
 * NEDEN VAR: Bu kapı olmadan `/` isteği `/dashboard`'a düşüyor, dashboard
 * boş verilerle (kullanıcı yok, domain yok, tablolar "—") HEMEN çiziliyor ve
 * ancak tarayıcıdaki `api.me()` 401 döndükten SONRA `/login`'e atılıyordu.
 * Kullanıcı arada boş panelin flaşını görüyor, panel "sanki ilk kurulmuş"
 * gibi görünüyordu. Artık HTML hiç üretilmeden 307 ile login'e gidiliyor.
 *
 * NE DEĞİL: Bu bir güvenlik katmanı DEĞİL. Yalnızca çerezin VARLIĞINA bakar,
 * token'ı doğrulamaz — doğrulama API'nin işi ve her veri rotasında
 * `fastify.requireAuth` ile zaten yapılıyor. Buradaki tek amaç, giriş yapmamış
 * ziyaretçiye giriş yapmış gibi bir ekran göstermemek.
 *
 * GUVENLIK BASLIKLARI (CSP/COOP) DA BURADA EKLENIR — nonce ISTEK BASINA
 * uretildigi icin nginx'teki statik `add_header`lardan (bkz. panel-ssl.sh)
 * FARKLI bir katmanda olmak zorunda. Kapsam disi BILINCLI iki yer var:
 *  1. webmail.<domain> host'u (asagidaki erken donus) — o dal zaten ayri bir
 *     yonlendirme kapisi, CSP eklemek icin dokunmak webmail'in tarihce
 *     kirilgan rotasyon mantigini riske atardi.
 *  2. `/adminer/*` — vendored, tek-dosyalik PHP araci kendi inline
 *     script/style'larini nonce'suz basiyor; strict CSP onu bozardı. Zaten
 *     panel oturumunun arkasinda (bkz. next.config.ts rewrites yorumu).
 */
export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  /*
   * WEBMAIL HOSTNAME'I EN BASTA AYRILIR.
   *
   * NEDEN BURADA VE next.config REWRITE'INDA DEGIL: Next.js'te middleware
   * rewrite'lardan ONCE calisir. Yonlendirmeyi next.config'e koydugumuzda
   * webmail.ornek.test/ istegi once buraya dusuyor, panel cerezi olmadigi
   * icin /login'e 307 ediliyor ve rewrite'a sira hic gelmiyordu — webmail
   * adresi panelin giris ekranini gosteriyordu. Kapiyi actigimiz yer, kapinin
   * kendisinden once olmali.
   */
  const host = request.headers.get("host")?.split(":")[0].toLowerCase();
  if (host?.startsWith(WEBMAIL_HOST_PREFIX)) {
    if (pathname.startsWith("/webmail")) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = pathname === "/" ? "/webmail" : `/webmail${pathname}`;
    return NextResponse.rewrite(url);
  }

  const hasSession = request.cookies.has(SESSION_COOKIE);
  const isLoginPage = pathname === "/login";

  let response: NextResponse;

  if (!hasSession && !isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Giriş sonrası kullanıcıyı gitmek istediği sayfaya döndürebilmek için
    // hedefi taşıyoruz. Yalnızca panel içi mutlak yollar kabul edilir; açık
    // yönlendirme (open redirect) için kullanılamaz.
    if (pathname !== "/" && pathname !== "/dashboard") {
      url.searchParams.set("next", `${pathname}${search}`);
    }
    response = NextResponse.redirect(url, 307);
  } else if (hasSession && isLoginPage) {
    // Oturumu olan kullanıcı login ekranını görmesin.
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    response = NextResponse.redirect(url, 307);
  } else {
    // Nonce'un HTML'e ULASMASI icin sayfaya giden istegin kendi basligina da
    // yazilir (bkz. app/layout.tsx `headers()` ile okuyor); yanit basligindaki
    // nonce yalnizca TARAYICIYA CSP kuralini soyler, React'e degil.
    const requestHeaders = new Headers(request.headers);
    const nonce = crypto.randomUUID();
    requestHeaders.set("x-nonce", nonce);
    response = NextResponse.next({ request: { headers: requestHeaders } });
    if (!pathname.startsWith("/adminer")) {
      response.headers.set("Content-Security-Policy", cspHeader(nonce));
    }
  }

  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return response;
}

export const config = {
  /**
   * `/api/*` HARİÇ TUTULUR: o yol next.config.ts rewrite'ı ile Fastify'a
   * gidiyor ve kendi 401'ini döndürmeli — buradan 307 ile login HTML'ine
   * çevrilirse istemci JSON beklerken HTML alır.
   * Statik dosyalar ve Next.js iç yolları da dışarıda.
   */
  /*
   * `webmail` DE HARIC TUTULUR: webmail'in kimligi bir POSTA KUTUSU ve kendi
   * cerezi var (`studio_webmail`). Bu matcher onu kapsasaydi, panel cerezi
   * olmayan her posta kutusu sahibi panelin /login ekranina atilirdi —
   * webmail'e hic ulasamazlardi.
   */
  matcher: ["/((?!api|webmail|_next/static|_next/image|favicon.ico).*)"],
};
