import { useEffect, useRef, useState } from "react";

/**
 * `active` true olduğu sürece 1 saniyede bir artan sayaç.
 *
 * NEDEN VAR: yedek alma gibi işlemler büyük domainlerde dakikalar sürüyor
 * ve buton sadece dönen bir çark gösteriyordu — donmuş mu diye kullanıcı
 * şüpheye düşüyordu. Gerçek ilerleme yüzdesi backend'e büyük dokunuş ister;
 * bu, geçen süreyi göstererek "çalışıyor, bekle" güvencesini ucuza verir.
 */
export function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    startRef.current = Date.now();
    setSeconds(0);
    const id = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [active]);

  return seconds;
}
