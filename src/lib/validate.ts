import { z } from "zod";

/**
 * Turns a zod schema into a TanStack Start input validator.
 * Usage: createServerFn().validator(parse(z.object({ id: z.string() })))
 * The client call stays fully typed (z.input) and the server really validates.
 */
export function parse<S extends z.ZodType>(schema: S) {
  return (input: z.input<S>): z.output<S> => schema.parse(input);
}

/** Trimmed, length-limited text (rejects empty by default). */
export const text = (max: number, min = 1) => z.string().trim().min(min).max(max);

/** Lower-cased username (same rule used everywhere in the app). */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9._-]+$/, "invalid username");

/**
 * Runtime check that KEEPS the exact TypeScript type of the input.
 * Throws if the data is malformed or too large; unknown extra keys are left alone
 * (the handlers only ever read the fields they know).
 *   .validator((data: { id: string }) => checked(S.idOnly, data))
 */
export function checked<T>(schema: z.ZodType, input: T): T {
  schema.parse(input);
  return input;
}
