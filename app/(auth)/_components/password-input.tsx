"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { authFieldClass } from "./auth-ui";

/**
 * A password field with a show/hide control. Purely presentational: the
 * input keeps its id, name, autocomplete and constraints, so the form
 * submits exactly what it did before; the toggle only switches the
 * input's type and is never part of the submitted data.
 */
export function PasswordInput({
  id,
  name,
  autoComplete,
  placeholder,
  minLength,
  describedBy,
}: {
  id: string;
  name: string;
  autoComplete: "current-password" | "new-password";
  placeholder?: string;
  minLength?: number;
  describedBy?: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        id={id}
        name={name}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        minLength={minLength}
        aria-describedby={describedBy}
        className={`${authFieldClass} pr-12`}
        placeholder={placeholder}
      />
      <button
        type="button"
        onClick={() => setVisible((value) => !value)}
        aria-controls={id}
        aria-pressed={visible}
        aria-label={visible ? "Hide password" : "Show password"}
        className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-xl text-cinder-ink-3 transition-colors hover:text-cinder-ink focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-cinder-accent"
      >
        {visible ? <EyeOff className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden /> : <Eye className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />}
      </button>
    </div>
  );
}
