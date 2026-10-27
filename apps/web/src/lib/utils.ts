import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn/ui'nin standart `cn` yardımcısı (clsx + tailwind-merge).
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
