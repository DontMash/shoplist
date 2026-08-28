import { z } from 'zod';
import { extractListId } from './list';

/**
 * Zod 4 implements Standard Schema, which TanStack Form v1 consumes directly.
 * Keeping these schemas in one module also mirrors the server's length limits.
 */
export const listNameSchema = z.object({
  value: z.string().trim().min(1, 'Give the list a name').max(60, 'List names are limited to 60 characters'),
});

export const promptSchema = (max = 60) => z.object({
  value: z.string().trim().min(1, 'This field is required').max(max, `Use at most ${max} characters`),
});

export const displayNameSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(40, 'Names are limited to 40 characters'),
});

export const inviteSchema = z.object({
  invite: z.string().trim()
    .min(1, 'Paste an invite link or code')
    .refine((value) => extractListId(value) !== null, 'Enter a valid invite link or code'),
});

export const itemSchema = z.object({
  name: z.string().trim().min(1, 'An item needs a name').max(80, 'Item names are limited to 80 characters'),
  amount: z.string().trim().max(40, 'Amounts are limited to 40 characters'),
});

export const itemEditSchema = itemSchema;

export const preferencesSchema = z.object({
  sort: z.enum(['created-asc', 'created-desc', 'name-asc', 'name-desc']),
  groupCollected: z.boolean(),
});

export type ItemFormValues = z.infer<typeof itemSchema>;
export type PreferencesFormValues = z.infer<typeof preferencesSchema>;
