import { z } from 'zod';

const id = z.string().min(1).max(150);
const thread = { workspaceId: id, issueId: id };
const recipient = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner') }).strict(),
  z.object({ kind: z.literal('actor'), actorId: id }).strict(),
  z.object({ kind: z.literal('role'), role: z.enum(['lead', 'pm', 'worker', 'qa']) }).strict()
]);
const body = z.string().min(1).max(16384).refine(value => value.trim().length > 0 && new TextEncoder().encode(value).length <= 16384, 'Use between 1 and 16384 UTF-8 bytes of message text');

export const messageSchemas = {
  message_send: z.object({
    ...thread,
    idempotencyKey: z.string().min(1).max(200),
    recipient,
    kind: z.enum(['QUESTION', 'REPLY', 'NOTE']),
    body,
    replyTo: id.optional(),
    wake: z.boolean().default(false)
  }).strict().refine(value => value.kind !== 'REPLY' || !!value.replyTo, 'A reply requires a visible replyTo message')
    .refine(value => !value.wake || value.kind === 'QUESTION', 'Only questions can request a wake'),
  message_list: z.object({
    ...thread,
    cursor: id.optional(),
    limit: z.number().int().min(1).max(20).default(20),
    view: z.enum(['summary', 'full']).default('summary')
  }).strict(),
  message_wait: z.object({
    ...thread,
    questionId: id,
    timeoutMs: z.number().int().min(0).max(50000).default(30000)
  }).strict()
};

export type MessageSend = z.infer<typeof messageSchemas.message_send>;
export type MessageList = z.infer<typeof messageSchemas.message_list>;
export type MessageWait = z.infer<typeof messageSchemas.message_wait>;
