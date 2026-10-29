/** The public Merve Nur Uluç mail layout, adapted from eposta_ornek_YENI.html.
 * Only messages sent by this business use it; installed panels remain neutral.
 */
const BRAND_DOMAIN = "mervenuruluc.com.tr";
const HERO_URL = "https://panel.mervenuruluc.com.tr/assets/m-hero.jpg";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character] ?? character);

export function usesMerveBrand(address: string): boolean {
  return address.toLowerCase().split("@").at(-1) === BRAND_DOMAIN;
}

export function renderWebmailBrand({ subject, html, text, address }: {
  subject: string;
  html?: string;
  text?: string;
  address: string;
}): string {
  const title = escapeHtml(subject.trim() || "Merve Nur Uluç'tan bir ileti");
  const safeAddress = escapeHtml(address);
  const preview = escapeHtml((text ?? "").replace(/\s+/g, " ").trim().slice(0, 140));
  const content = html?.trim() || `<div style="white-space:pre-wrap">${escapeHtml(text ?? "")}</div>`;
  return `<!doctype html><html lang="tr" xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${title}</title><style>@media screen and (max-width:620px){.email-shell{width:100%!important}.mobile-pad{padding-left:24px!important;padding-right:24px!important}.mobile-title{font-size:28px!important;line-height:36px!important}}</style><!--[if mso]><style>body,table,td,a,p{font-family:Arial,Helvetica,sans-serif!important}</style><![endif]--></head><body style="margin:0;padding:0;background:#f2f0f6;color:#18112d;-webkit-text-size-adjust:100%"><div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${preview}</div><center style="width:100%;background:#f2f0f6"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td align="center" style="padding:24px 12px 32px"><!--[if mso]><table role="presentation" width="600" align="center"><tr><td><![endif]--><table role="presentation" class="email-shell" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border-collapse:collapse;background:#fff"><tr><td bgcolor="#120821" style="padding:28px 34px 23px;background:#120821;color:#fff"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font:bold 19px/24px Arial,Helvetica,sans-serif;color:#fff">MERVE NUR ULUÇ</td><td align="right" style="font:10px/18px Arial,Helvetica,sans-serif;letter-spacing:1.5px;color:#d1c5df">WEB &amp; YAZILIM</td></tr></table></td></tr><tr><td bgcolor="#120821"><img src="${HERO_URL}" alt="Merve Nur Uluç — web tasarım ve yazılım" width="600" height="300" style="display:block;width:100%;max-width:600px;height:auto;border:0;background:#120821;color:#fff;font:15px/24px Arial,Helvetica,sans-serif"></td></tr><tr><td bgcolor="#120821" align="center" style="padding:9px 20px 27px;background:#120821;color:#ede7fa;font:11px/18px Arial,Helvetica,sans-serif;letter-spacing:2px">TASARIMDAN YAYINA TEK EKİPLE.</td></tr><tr><td class="mobile-pad" style="padding:34px 42px 4px"><p style="margin:0 0 12px;color:#7c3aed;font:bold 11px/17px Arial,Helvetica,sans-serif;letter-spacing:1.6px">MERVE NUR ULUÇ / İLETİŞİM</p><h1 class="mobile-title" style="margin:0 0 22px;color:#18112d;font:normal 35px/42px Georgia,'Times New Roman',serif">${title}</h1></td></tr><tr><td class="mobile-pad" style="padding:0 42px 34px"><div style="color:#403a50;font:15px/25px Arial,Helvetica,sans-serif;overflow-wrap:break-word">${content}</div></td></tr><tr><td bgcolor="#120821" class="mobile-pad" style="background:#120821;padding:27px 42px 29px;color:#fff"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="48" valign="middle" style="font:bold 38px/42px Georgia,serif;color:#ceb5ff">M</td><td valign="middle" style="font:bold 14px/20px Arial,Helvetica,sans-serif;color:#fff">Merve Nur Uluç<br><span style="font:11px/18px Arial,Helvetica,sans-serif;color:#baaece">Web Tasarım &amp; Yazılım Geliştirme</span></td></tr></table><div style="border-top:1px solid #39294c;margin:18px 0 14px"></div><p style="margin:0;font:12px/21px Arial,Helvetica,sans-serif"><a href="https://mervenuruluc.com.tr/" style="color:#ded0fa;text-decoration:none">mervenuruluc.com.tr</a><br><a href="mailto:${safeAddress}" style="color:#ded0fa;text-decoration:none">${safeAddress}</a></p></td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></center></body></html>`;
}
