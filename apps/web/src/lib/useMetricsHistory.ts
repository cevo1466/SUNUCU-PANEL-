"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type MetricsHistory, type MetricsRange, type ResourceMetrics } from "@/lib/api";

const POLL_MS = 5000;

/**
 * Kaynak geçmişi + canlı kuyruk.
 *
 * Açılışta sunucudaki halka tamponu bir kez çeker (grafik hemen dolu gelir),
 * sonra 5 saniyede bir son ölçümü alıp diziye ekler. Sekme arka plandayken
 * yoklama durur: görünmeyen bir grafik için istek atmak boşuna trafik ve
 * panelin kendi CPU ölçümünü de kirletir.
 */
export function useMetricsHistory(range: MetricsRange) {
  const [history, setHistory] = useState<MetricsHistory | null>(null);
  const [latest, setLatest] = useState<ResourceMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const handleError = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) {
      setUnauthorized(true);
      return;
    }
    setError(err instanceof ApiError ? err.message : "Kaynak ölçümleri alınamadı.");
  }, []);

  // Aralık değiştiğinde tamponu baştan çek.
  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    api
      .metricsHistory(range)
      .then((result) => {
        if (!cancelled) {
          setHistory(result);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) handleError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [range, handleError]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (document.hidden) {
        schedule();
        return;
      }
      try {
        const metrics = await api.resourceMetrics();
        if (cancelled) return;
        setLatest(metrics);
        setError(null);
        setHistory((current) => {
          if (!current) return current;
          const sample = {
            t: new Date(metrics.sampledAt).getTime(),
            cpuPercent: metrics.cpu.usagePercent,
            memPercent:
              metrics.memory.limitBytes && metrics.memory.limitBytes > 0
                ? (metrics.memory.usedBytes / metrics.memory.limitBytes) * 100
                : null,
            memUsedBytes: metrics.memory.usedBytes,
            // Son okuma penceresinin throttle farkı. Sunucudaki örnekleyici
            // ile aynı alanlar; grafik seçili aralıkta bunları topluyor.
            throttledPeriods: metrics.cpu.throttledPeriodsDelta,
            periods: metrics.cpu.periodsDelta,
          };
          // Sunucu örnekleyicisi de 5 sn'de bir yazıyor; aynı ölçümü iki kez
          // eklememek için son örnekle aynı zaman damgasını atlıyoruz.
          const last = current.samples[current.samples.length - 1];
          if (last && last.t >= sample.t) return current;
          return { ...current, samples: [...current.samples, sample].slice(-current.capacity) };
        });
      } catch (err) {
        if (!cancelled) handleError(err);
      }
      schedule();
    }

    // Her zaman önce bekleyen zamanlayıcıyı iptal eder: sekmeye geri dönüş
    // beklemeden bir tur tetiklediği için aksi halde iki zamanlayıcı birden
    // çalışır ve yoklama hızı ikiye katlanırdı.
    function schedule() {
      if (timer) clearTimeout(timer);
      if (cancelled) return;
      timer = setTimeout(tick, POLL_MS);
    }

    void tick();

    // Sekmeye geri dönüldüğünde beklemeden tazele.
    function onVisible() {
      if (!document.hidden) void tick();
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [handleError]);

  return { history, latest, error, unauthorized };
}
