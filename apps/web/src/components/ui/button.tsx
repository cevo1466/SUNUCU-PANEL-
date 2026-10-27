import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Varyantlar globals.css'teki .sp-btn ailesine bağlanır. Tailwind utility ile
// buton görünümü kurmuyoruz: panelin tüm kontrolleri tek yerden yönetilsin.
export const buttonVariants = cva("sp-btn", {
  variants: {
    variant: {
      primary: "sp-btn--primary",
      secondary: "sp-btn--secondary",
      ghost: "sp-btn--ghost",
      danger: "sp-btn--danger",
    },
    size: {
      md: "",
      sm: "sp-btn--sm",
      icon: "sp-btn--sm sp-btn--icon",
    },
    block: { true: "sp-btn--block", false: "" },
  },
  defaultVariants: { variant: "secondary", size: "md", block: false },
});

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "color">,
    VariantProps<typeof buttonVariants> {
  /** Çalışırken buton kilitlenir ve yerinde bir çark gösterir. */
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  block,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size, block }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <span className="sp-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

/**
 * Butonla aynı görünen bağlantı. İndirme gibi gerçekten <a> olması gereken
 * yerlerde kullanılır — <a><button/></a> geçersiz HTML'dir ve tıklama
 * davranışı tarayıcıya göre değişir.
 */
export function ButtonLink({
  className,
  variant,
  size,
  block,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & VariantProps<typeof buttonVariants>) {
  return <a className={cn(buttonVariants({ variant, size, block }), className)} {...props} />;
}
