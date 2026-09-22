import { receiveWebhook } from "@/lib/webhooks";
export const POST = (request: Request) => receiveWebhook("sonarr", request);
