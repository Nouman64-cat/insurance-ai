import { z } from "zod";

export const roles = ["Executive", "Underwriting", "Claims", "Distribution / agency", "IT / engineering", "Other"] as const;
export const interests = ["Individual Life", "Family Takaful", "Group Life", "Platform overview", "Other"] as const;

export const contactSchema = z.object({
  name: z.string().trim().min(2, "Please enter your name"),
  email: z.string().trim().email("Enter a valid work email"),
  company: z.string().trim().min(2, "Please enter your company"),
  role: z.enum(roles),
  interest: z.enum(interests),
  message: z.string().trim().max(2000, "Please keep this under 2000 characters").optional(),
  // Honeypot: real users never see or fill this.
  website: z.string().max(0).optional(),
});

export type ContactInput = z.infer<typeof contactSchema>;
