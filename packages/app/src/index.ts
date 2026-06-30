import { loadDefaults, loadEnv, loadRepos, logger, recordDelivery } from "@kotx/shared";
import Fastify from "fastify";
import { registerApi } from "./api.js";
import { normalize } from "./extract.js";
import { ingest } from "./pipeline.js";
import { startPoller } from "./poller.js";
import { verifySignature } from "./verify.js";

const env = loadEnv();
// fail fast if config is invalid
loadDefaults();
loadRepos();

const app = Fastify({ logger: false });

// capture the raw body (needed for HMAC) while still parsing JSON ourselves
app.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (_req, body, done) => {
    done(null, body);
  },
);

app.get("/healthz", async () => ({ ok: true }));

// JSON API for the external frontend (GET/POST/PUT /api/*) — Bearer-gated.
registerApi(app);

app.post("/github/webhook", async (req, reply) => {
  const raw = req.body as Buffer;
  const event = req.headers["x-github-event"] as string | undefined;
  const delivery = req.headers["x-github-delivery"] as string | undefined;
  const signature = req.headers["x-hub-signature-256"] as string | undefined;

  if (!verifySignature(raw, signature, env.github.webhookSecret)) {
    return reply.code(400).send({ error: "bad signature" });
  }
  if (!event || !delivery) {
    return reply.code(400).send({ error: "missing headers" });
  }

  // idempotency: drop duplicate deliveries
  const isNew = await recordDelivery(delivery, event);
  if (!isNew) return reply.code(200).send({ status: "duplicate" });

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return reply.code(400).send({ error: "invalid json" });
  }

  const normalized = normalize(event, payload);
  if (!normalized) return reply.code(200).send({ status: "ignored" });

  try {
    const result = await ingest(normalized);
    const code = result.status === "enqueued" ? 202 : 200;
    return reply.code(code).send(result);
  } catch (err) {
    logger.error({ err, event, delivery }, "ingest failed");
    return reply.code(500).send({ error: "internal" });
  }
});

app
  .listen({ port: env.port, host: env.host })
  .then(() => {
    logger.info({ port: env.port }, "app listening");
    const poller = startPoller(); // null if no repos use poll mode
    const shutdown = async () => {
      if (poller) clearInterval(poller);
      await app.close();
      process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());
  })
  .catch((err) => {
    logger.error({ err }, "failed to start app");
    process.exit(1);
  });
