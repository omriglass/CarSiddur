import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Wraps `sonner` with the app's design tokens (no next-themes dependency here
 * — the reference app's dark-mode toggle is out of scope for v1, ARCHITECTURE
 * §1). RTL is handled globally via `<html dir="rtl">`.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      dir="rtl"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
