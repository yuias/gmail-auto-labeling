import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

// Stub until the Gmail history sync and labeling logic are implemented.
export class Mailbox extends DurableObject<Env> {}
