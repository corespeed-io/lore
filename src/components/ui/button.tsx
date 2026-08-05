import { type ButtonHTMLAttributes, forwardRef } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className = "", variant = "secondary", type = "button", ...props },
  ref,
) {
  const classes = ["ui-button", `ui-button-${variant}`, className].filter(Boolean).join(" ");
  return <button ref={ref} className={classes} type={type} {...props} />;
});
