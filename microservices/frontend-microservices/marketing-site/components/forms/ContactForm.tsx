"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { buttonClass } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { contactSchema, interests, roles, type ContactInput } from "@/lib/contact-schema";

function FieldError({ message }: { message?: string }) {
  return message ? <p className="mt-1 text-xs text-rose-600">{message}</p> : null;
}

export function ContactForm() {
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ContactInput>({
    resolver: zodResolver(contactSchema),
    defaultValues: { role: roles[0], interest: interests[3] },
  });

  async function onSubmit(values: ContactInput) {
    setStatus("idle");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) throw new Error("Request failed");
      setStatus("sent");
      reset();
    } catch {
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <div className="card p-8 text-center">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
          <Icon name="check" />
        </span>
        <h2 className="mt-4 text-lg font-semibold text-ink">Thanks, we have your request</h2>
        <p className="mt-2 text-sm text-body">
          This is a prototype site, so nothing is sent onward yet. Your request was validated and logged.
        </p>
        <button type="button" onClick={() => setStatus("idle")} className={`${buttonClass("ghost")} mt-6`}>
          Send another
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="card space-y-4 p-6 sm:p-8">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="name" className="mb-1 block text-sm font-medium text-body">
            Name
          </label>
          <input id="name" autoComplete="name" className="field" {...register("name")} />
          <FieldError message={errors.name?.message} />
        </div>
        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-medium text-body">
            Work email
          </label>
          <input id="email" type="email" autoComplete="email" className="field" {...register("email")} />
          <FieldError message={errors.email?.message} />
        </div>
      </div>

      <div>
        <label htmlFor="company" className="mb-1 block text-sm font-medium text-body">
          Company
        </label>
        <input id="company" autoComplete="organization" className="field" {...register("company")} />
        <FieldError message={errors.company?.message} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="role" className="mb-1 block text-sm font-medium text-body">
            Your area
          </label>
          <select id="role" className="field" {...register("role")}>
            {roles.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="interest" className="mb-1 block text-sm font-medium text-body">
            Interested in
          </label>
          <select id="interest" className="field" {...register("interest")}>
            {interests.map((i) => (
              <option key={i}>{i}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="message" className="mb-1 block text-sm font-medium text-body">
          Anything we should prepare? <span className="font-normal text-faint">(optional)</span>
        </label>
        <textarea id="message" rows={4} className="field" {...register("message")} />
        <FieldError message={errors.message?.message} />
      </div>

      <div className="hidden" aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input id="website" tabIndex={-1} autoComplete="off" {...register("website")} />
      </div>

      {status === "error" && (
        <p className="text-sm text-rose-600" role="alert">
          Something went wrong. Please try again.
        </p>
      )}

      <button type="submit" disabled={isSubmitting} className={`${buttonClass("primary")} w-full disabled:opacity-60`}>
        {isSubmitting ? "Sending…" : "Request a demo"}
      </button>
    </form>
  );
}
