import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import compression from "compression";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(compression());

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(cookieParser(process.env.SESSION_SECRET));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Global error handler — must have 4 params so Express recognises it as an
// error middleware. Logs the full error and returns a structured 500 so
// callers (and the server log) can see what actually went wrong instead of
// receiving a silent "Internal Server Error".
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack   = err instanceof Error ? err.stack    : undefined;
  logger.error({ err, stack }, "Unhandled route error");
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal Server Error", message });
  }
});

export default app;
