import { z } from "zod";

const nullableText = z.string().trim().min(1).nullable();

export const OrderItemSchema = z.object({
  name: z.string().trim().min(1),
  brand: nullableText,
  colour: nullableText,
  size: nullableText,
  quantity: z.number().int().min(1),
  price: z.number().nonnegative().nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "ISO 4217 code")
    .nullable(),
  imageUrl: z.url({ protocol: /^https?$/ }).nullable(),
});

export const ParsedOrderSchema = z.object({
  isOrderConfirmation: z.boolean(),
  retailer: nullableText,
  orderNumber: nullableText,
  orderDate: z.iso.date().nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "ISO 4217 code")
    .nullable(),
  total: z.number().nonnegative().nullable(),
  items: z.array(OrderItemSchema),
});

export type OrderItem = z.infer<typeof OrderItemSchema>;
export type ParsedOrder = z.infer<typeof ParsedOrderSchema>;

export const MAX_EMAIL_BYTES = 1_500_000;

export const EmailPayloadSchema = z
  .object({
    messageId: z.string().min(1).max(256),
    from: z.string().max(1024),
    subject: z.string().max(2048),
    date: z.string().max(256).nullable(),
    html: z.string().nullable(),
    text: z.string().nullable(),
  })
  .refine((e) => Boolean(e.html?.trim() || e.text?.trim()), {
    message: "email must contain an html or text body",
  });

export type EmailPayload = z.infer<typeof EmailPayloadSchema>;

/** The signed-in Gmail address. History is stored and listed per account. */
export const AccountSchema = z
  .email()
  .max(320)
  .transform((a) => a.toLowerCase());

export const ParseSourceSchema = z.enum(["manual", "auto"]);
export type ParseSource = z.infer<typeof ParseSourceSchema>;

export const ParseRequestSchema = z.object({
  account: AccountSchema,
  source: ParseSourceSchema,
  /** Re-run Gemini even if this message is already in the history. */
  force: z.boolean().default(false),
  email: EmailPayloadSchema,
});
export type ParseRequest = z.input<typeof ParseRequestSchema>;

/** One parsed email as stored in the history database. */
export const OrderRecordSchema = z.object({
  account: z.string(),
  messageId: z.string(),
  from: z.string(),
  subject: z.string(),
  emailDate: z.string().nullable(),
  source: ParseSourceSchema,
  model: z.string(),
  parsedAt: z.iso.datetime(),
  order: ParsedOrderSchema,
});
export type OrderRecord = z.infer<typeof OrderRecordSchema>;

export const ParseResponseSchema = z.object({
  record: OrderRecordSchema,
  /** True when the record came from the history database without calling Gemini. */
  cached: z.boolean(),
});
export type ParseResponse = z.infer<typeof ParseResponseSchema>;

export const ListOrdersRequestSchema = z.object({
  account: AccountSchema,
  limit: z.number().int().min(1).max(5000).default(500),
});
export type ListOrdersRequest = z.input<typeof ListOrdersRequestSchema>;

export const ListOrdersResponseSchema = z.object({
  records: z.array(OrderRecordSchema),
});
export type ListOrdersResponse = z.infer<typeof ListOrdersResponseSchema>;

export const ErrorCodeSchema = z.enum([
  "bad_request",
  "forbidden_origin",
  "payload_too_large",
  "email_not_allowed",
  "upstream_error",
  "upstream_rate_limited",
  "upstream_timeout",
  "invalid_model_output",
  "internal_error",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({ code: ErrorCodeSchema, message: z.string() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
